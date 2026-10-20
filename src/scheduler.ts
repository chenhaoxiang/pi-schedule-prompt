import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Cron } from "croner";
import { type CronStorage, ScheduleStoreBusyError } from "./storage.js";
import { runSubagentOnce } from "./subagent.js";
import type { CronChangeEvent, CronJob, CronJobType } from "./types.js";

type ValidateScheduleResult =
  | { ok: true; schedule: string; intervalMs?: number }
  | { ok: false; error: string };
const MAX_DELAY = 2_147_483_647;
const snippet = (text: string) => text.length > 500 ? text.slice(0, 500) + "…" : text;

/** Timers own intent only. Host acceptance never proves business completion. */
export class CronScheduler {
  private jobs = new Map<string, Cron>();
  private intervals = new Map<string, NodeJS.Timeout>();
  private nextRuns = new Map<string, Date>();
  private pending = new Set<string>();
  private drainTimer?: NodeJS.Timeout;
  private stopped = false;
  private activeSubagents = new Set<AbortController>();
  private activeJobs = new Map<string, AbortController>();
  private generations = new Map<string, number>();
  private scheduledTurn = false;

  constructor(
    private readonly storage: CronStorage,
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
  ) {}

  start(): void {
    this.stop();
    this.stopped = false;
    const session = this.ctx.sessionManager.getSessionId();
    for (const job of this.storage.getAllJobs()) {
      if (!CronScheduler.isLoadedFor(job, session)) continue;
      if (job.lastStatus === "running" || job.lastStatus === "queued") {
        this.storage.updateJob(job.id, { lastStatus: "unknown" });
      }
      if (job.enabled) this.scheduleJob(job);
    }
  }

  static isLoadedFor(job: CronJob, sessionId: string | undefined): boolean {
    return !job.session || job.session === sessionId;
  }

  setScheduledTurn(value: boolean): void { this.scheduledTurn = value; }
  isScheduledTurn(): boolean { return this.scheduledTurn; }
  onAgentSettled(): void { this.drain(); }

  stop(): void {
    this.stopped = true;
    for (const cron of this.jobs.values()) cron.stop();
    for (const timer of this.intervals.values()) clearTimeout(timer);
    this.jobs.clear();
    this.intervals.clear();
    this.nextRuns.clear();
    this.pending.clear();
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = undefined;
    for (const controller of this.activeSubagents) controller.abort();
    this.activeSubagents.clear();
    this.activeJobs.clear();
    this.scheduledTurn = false;
  }

  addJob(job: CronJob): void {
    if (!this.stopped && job.enabled && CronScheduler.isLoadedFor(job, this.ctx.sessionManager.getSessionId())) this.scheduleJob(job);
    this.emitChange({ type: "add", job });
  }

  removeJob(id: string): void {
    this.unscheduleJob(id);
    this.emitChange({ type: "remove", jobId: id });
  }

  updateJob(id: string, updated: CronJob): void {
    this.unscheduleJob(id);
    if (this.activeJobs.has(id)) this.storage.updateJob(id, { lastStatus: "unknown" });
    if (!this.stopped && updated.enabled && CronScheduler.isLoadedFor(updated, this.ctx.sessionManager.getSessionId())) this.scheduleJob(updated);
    this.emitChange({ type: "update", job: updated });
  }

  getNextRun(id: string): Date | null {
    return this.jobs.get(id)?.nextRun() || this.nextRuns.get(id) || null;
  }

  private scheduleJob(job: CronJob): void {
    try {
      if (job.type === "interval") {
        if (!job.intervalMs || !Number.isSafeInteger(job.intervalMs) || job.intervalMs > MAX_DELAY) {
          throw new Error("Interval must be positive and at most 2147483647 milliseconds");
        }
        this.nextRuns.set(job.id, new Date(Date.now() + job.intervalMs));
        const timer = setInterval(() => {
          this.nextRuns.set(job.id, new Date(Date.now() + job.intervalMs!));
          void this.executeJob(job);
        }, job.intervalMs);
        timer.unref?.();
        this.intervals.set(job.id, timer);
      } else if (job.type === "once") {
        const target = Date.parse(job.schedule);
        if (!Number.isFinite(target) || target <= Date.now()) throw new Error("One-shot time is invalid or in the past");
        this.nextRuns.set(job.id, new Date(target));
        const arm = () => {
          const timer = setTimeout(() => {
            if (this.stopped) return;
            if (target > Date.now()) return arm();
            this.intervals.delete(job.id);
            this.nextRuns.delete(job.id);
            void this.executeJob(job);
          }, Math.min(target - Date.now(), MAX_DELAY));
          timer.unref?.();
          this.intervals.set(job.id, timer);
        };
        arm();
      } else {
        this.jobs.set(job.id, new Cron(job.schedule, () => { void this.executeJob(job); }));
      }
    } catch (error) {
      this.fail(job.id, error);
      this.storage.updateJob(job.id, { enabled: false, lastStatus: "error" });
    }
  }

  private unscheduleJob(id: string): void {
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
    const timer = this.intervals.get(id);
    if (timer) clearTimeout(timer);
    this.intervals.delete(id);
    this.nextRuns.delete(id);
    this.pending.delete(id);
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    if (!this.pending.size && this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
  }

  private eligible(id: string): CronJob | undefined {
    if (this.stopped) return;
    const job = this.storage.getJob(id);
    if (!job?.enabled || !CronScheduler.isLoadedFor(job, this.ctx.sessionManager.getSessionId())) return;
    if ((job.expiresAt && Date.parse(job.expiresAt) <= Date.now()) ||
      (job.maxRuns !== undefined && (job.attemptCount ?? job.runCount) >= job.maxRuns)) {
      this.storage.updateJob(id, { enabled: false });
      this.unscheduleJob(id);
      this.emitChange({ type: "update", job: { ...job, enabled: false } });
      return;
    }
    return job;
  }

  private async executeJob(snapshot: CronJob): Promise<void> {
    try {
      const job = this.eligible(snapshot.id);
      if (!job) return;
      if (job.schedule !== snapshot.schedule || job.type !== snapshot.type) {
        this.updateJob(job.id, job);
        return;
      }
      if (job.model) {
        if (!this.activeJobs.has(job.id)) this.executeJobInSubagent(job);
        return;
      }
      this.pending.add(job.id);
      if (job.lastStatus !== "queued") {
        this.storage.updateJob(job.id, { lastStatus: "queued" });
        this.emitChange({ type: "fire", job: { ...job, lastStatus: "queued" } });
      }
      this.drain();
    } catch (error) {
      if (error instanceof ScheduleStoreBusyError) {
        this.pending.add(snapshot.id);
        this.armDrain();
      } else this.fail(snapshot.id, error);
    }
  }

  /** A timer exists only while pending; nothing is queued inside a busy Pi host. */
  private armDrain(): void {
    if (!this.pending.size || this.drainTimer || this.stopped) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      this.drain();
    }, 1000);
    this.drainTimer.unref?.();
  }

  private drain(): void {
    if (this.stopped || !this.pending.size) return;
    if ((this.ctx.isIdle && !this.ctx.isIdle()) || this.ctx.hasPendingMessages?.()) {
      this.armDrain();
      return;
    }
    const id = this.pending.values().next().value as string;
    this.pending.delete(id);
    let admitted = false;
    try {
      const eligible = this.eligible(id);
      if (eligible?.model) {
        this.executeJobInSubagent(eligible);
        this.armDrain();
        return;
      }
      const job = eligible && this.storage.admitJob(id, this.ctx.sessionManager.getSessionId());
      if (job) {
        admitted = true;
        const attempts = job.attemptCount!;
        // Admission is persisted before a potentially effectful send.
        this.pi.sendMessage({
          customType: "scheduled_prompt", content: job.prompt, display: true,
          details: { jobId: id, jobName: job.name, prompt: job.prompt, mode: "inline" },
        }, { triggerTurn: true, deliverAs: "followUp" });
        this.storage.updateJob(id, {
          lastRun: new Date().toISOString(), lastStatus: "dispatched", runCount: job.runCount + 1,
          ...(job.type === "once" || (job.maxRuns !== undefined && attempts >= job.maxRuns) ? { enabled: false } : {}),
          nextRun: this.getNextRun(id)?.toISOString(),
        });
        if (this.storage.getJob(id)?.enabled === false) this.unscheduleJob(id);
        this.emitChange({ type: "fire", job: this.storage.getJob(id) });
      }
    } catch (error) {
      if (!admitted && error instanceof ScheduleStoreBusyError) this.pending.add(id);
      else this.fail(id, error);
    }
    this.armDrain();
  }

  private executeJobInSubagent(snapshot: CronJob): void {
    if (this.activeJobs.has(snapshot.id) || this.stopped) return;
    const job = this.storage.admitJob(snapshot.id, this.ctx.sessionManager.getSessionId());
    if (!job) return;
    const model = job.model!;
    const attempts = job.attemptCount!;
    this.storage.updateJob(job.id, { lastStatus: "running", attemptCount: attempts,
      ...(job.type === "once" || (job.maxRuns !== undefined && attempts >= job.maxRuns) ? { enabled: false } : {}) });
    if (this.storage.getJob(job.id)?.enabled === false) this.unscheduleJob(job.id);
    const generation = this.generations.get(job.id) ?? 0;
    this.emitChange({ type: "fire", job });
    this.pi.sendMessage({ customType: "scheduled_prompt", display: true,
      content: [{ type: "text", text: "Scheduled model run: " + job.name }],
      details: { jobId: job.id, jobName: job.name, prompt: job.prompt, mode: "subagent_start", model } });
    const controller = new AbortController();
    this.activeSubagents.add(controller);
    this.activeJobs.set(job.id, controller);
    void (async () => {
      try {
        const result = await runSubagentOnce(this.ctx, job.prompt, model, controller.signal,
          { extensions: job.extensions, skills: job.skills });
        const latest = this.storage.getJob(job.id);
        if (controller.signal.aborted || this.stopped || !latest ||
          generation !== (this.generations.get(job.id) ?? 0)) return;
        const text = result.ok
          ? snippet(result.text.trim()) || "(subagent produced no text output)"
          : snippet(result.error.trim()) || "(subagent failed with empty error)";
        this.storage.updateJob(job.id, {
          lastRun: new Date().toISOString(), lastStatus: result.ok ? "success" : "error",
          runCount: latest.runCount + (result.ok ? 1 : 0), nextRun: this.getNextRun(job.id)?.toISOString(),
        });
        this.emitChange({ type: result.ok ? "fire" : "error", jobId: job.id, ...(result.ok ? {} : { error: text }) });
        try {
          this.pi.sendMessage({ customType: "scheduled_prompt", display: true,
            content: [{ type: "text", text }], details: {
              jobId: job.id, jobName: job.name, prompt: job.prompt, model,
              mode: result.ok ? "subagent_done" : "subagent_error",
              ...(result.ok ? { output: text } : { error: text }),
            } }, job.notify ? { deliverAs: "followUp", triggerTurn: true } : undefined);
        } catch (error) {
          console.error("Failed to post " + (result.ok ? "subagent_done" : "subagent_error") + " marker for job " + job.id + ":", error);
        }
      } catch (error) { this.fail(job.id, error); }
      finally {
        this.activeSubagents.delete(controller);
        if (this.activeJobs.get(job.id) === controller) this.activeJobs.delete(job.id);
      }
    })();
  }

  private fail(id: string, error: unknown): void {
    this.unscheduleJob(id);
    // A failed send can already have been accepted. Pause instead of blind replay.
    try { this.storage.updateJob(id, { enabled: false, lastStatus: "unknown" }); } catch { /* Preserve corrupt bytes or the other writer. */ }
    const text = error instanceof Error ? error.message : String(error);
    console.error("Scheduled job " + id + " failed:", text);
    this.emitChange({ type: "error", jobId: id, error: text });
  }

  private emitChange(event: CronChangeEvent): void {
    try { this.pi.events.emit("cron:change", event); }
    catch (error) { console.error("Schedule observer failed:", error); }
  }

  /**
   * Validate a cron expression (must be 6-field format with seconds)
   */
  static validateCronExpression(expression: string): { valid: boolean; error?: string } {
    // Count fields - must be 6 (second minute hour dom month dow)
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 6) {
      return {
        valid: false,
        error: `Cron expression must have 6 fields (second minute hour dom month dow), got ${fields.length}. Example: "0 * * * * *" for every minute`,
      };
    }

    try {
      // Try parsing as cron expression
      const cron = new Cron(expression, { paused: true }, () => {});
      cron.stop();
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "Invalid cron expression",
      };
    }
  }

  /**
   * Parse relative time delta (e.g., "+10s", "+5m", "+1h")
   * Returns ISO timestamp if valid, null otherwise
   */
  static parseRelativeTime(delta: string): string | null {
    const match = delta.match(/^\+(\d+)(s|m|h|d)$/);
    if (!match) return null;

    const value = parseInt(match[1], 10);
    const unit = match[2];
    
    const msMap: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };

    const ms = value * msMap[unit];
    const futureTime = new Date(Date.now() + ms);
    return Number.isSafeInteger(ms) && ms > 0 && Number.isFinite(futureTime.getTime()) ? futureTime.toISOString() : null;
  }

  /**
   * Parse interval string to milliseconds
   */
  static parseInterval(interval: string): number | null {
    const match = interval.match(/^(\d+)(s|m|h|d)$/);
    if (!match) return null;

    const value = parseInt(match[1], 10);
    const unit = match[2];

    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };

    const ms = value * multipliers[unit];
    return Number.isSafeInteger(ms) && ms > 0 && ms <= MAX_DELAY ? ms : null;
  }

  /**
   * Validate and resolve a schedule string for the given type.
   * Single source of truth shared by tool `add`/`update` and the UI command.
   *
   * - `cron`: validates the 6-field expression
   * - `once`: accepts ISO timestamps and relative time (`+10s`); rejects past
   *   timestamps and ones <5s away (the agent should use relative time instead)
   * - `interval`: accepts duration strings (`5m`, `1h`, `30s`)
   */
  static validateSchedule(type: CronJobType, schedule: string): ValidateScheduleResult {
    if (type === "interval") {
      const intervalMs = CronScheduler.parseInterval(schedule);
      if (!intervalMs) {
        return {
          ok: false,
          error: `Invalid interval format: ${schedule}. Use format like '5m', '1h', '30s'`,
        };
      }
      return { ok: true, schedule, intervalMs };
    }

    if (type === "once") {
      const relative = CronScheduler.parseRelativeTime(schedule);
      if (relative) return { ok: true, schedule: relative };

      const date = new Date(schedule);
      if (Number.isNaN(date.getTime())) {
        return {
          ok: false,
          error: `Invalid timestamp: ${schedule}. Use ISO format or relative time like '+10s', '+5m'`,
        };
      }
      const delay = date.getTime() - Date.now();
      if (delay < 0) {
        return {
          ok: false,
          error: `Timestamp is in the past: ${date.toISOString()}. Current time: ${new Date().toISOString()}`,
        };
      }
      if (delay < 5000) {
        return {
          ok: false,
          error: `Timestamp is too soon (${Math.round(delay / 1000)}s). For delays under 5s, use relative time like '+${Math.ceil(delay / 1000)}s' instead, or schedule at least 5s in the future.`,
        };
      }
      return { ok: true, schedule: date.toISOString() };
    }

    // cron
    const validation = CronScheduler.validateCronExpression(schedule);
    if (!validation.valid) {
      return { ok: false, error: `Invalid cron expression: ${validation.error}` };
    }
    return { ok: true, schedule };
  }

  /**
   * Render a resolved schedule as a short human-readable phrase.
   * Used for confirm dialogs and the widget. `schedule` is the resolved form
   * returned by `validateSchedule` (ISO for `once`).
   */
  static describeSchedule(type: CronJobType, schedule: string): string {
    if (type === "interval") return `every ${schedule}`;
    if (type === "once") {
      const date = new Date(schedule);
      return Number.isNaN(date.getTime()) ? schedule : formatISOShort(date);
    }
    return humanizeCron(schedule);
  }
}

const HUMANIZED_CRON: Record<string, string> = {
  "* * * * * *": "every second",
  "0 * * * * *": "every minute",
  "0 */5 * * * *": "every 5 min",
  "0 */10 * * * *": "every 10 min",
  "0 */15 * * * *": "every 15 min",
  "0 */30 * * * *": "every 30 min",
  "0 0 * * * *": "every hour",
  "0 0 */2 * * *": "every 2 hours",
  "0 0 */3 * * *": "every 3 hours",
  "0 0 */6 * * *": "every 6 hours",
  "0 0 0 * * *": "daily",
  "0 0 0 * * 0": "weekly",
  "0 0 0 1 * *": "monthly",
  "0 0 9 * * 1-5": "9am weekdays",
  "0 0 0 * * 1-5": "weekdays",
  "0 0 0 * * 0,6": "weekends",
};

/** Human-readable form of a 6-field cron expression for common patterns.
 *  Falls back to the raw expression for anything not recognized — never
 *  guesses a wrong description. Callers truncate for column-width displays. */
export function humanizeCron(expression: string): string {
  const normalized = expression.trim();
  if (HUMANIZED_CRON[normalized]) return HUMANIZED_CRON[normalized];

  const minMatch = normalized.match(/^0 \*\/(\d+) \* \* \* \*$/);
  if (minMatch) return `every ${minMatch[1]} min`;

  const hourMatch = normalized.match(/^0 0 \*\/(\d+) \* \* \*$/);
  if (hourMatch) return `every ${hourMatch[1]}h`;

  const timeMatch = normalized.match(/^0 0 (\d+) \* \* \*$/);
  if (timeMatch) return `daily at ${parseInt(timeMatch[1], 10)}:00`;

  return normalized;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Compact ISO timestamp render: "Feb 13 15:30". Returns the input unchanged
 *  if it doesn't parse as a date. */
export function formatISOShort(input: Date | string): string {
  const date = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return String(input);
  const month = MONTHS[date.getMonth()];
  const day = date.getDate();
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${month} ${day} ${hours}:${minutes}`;
}
