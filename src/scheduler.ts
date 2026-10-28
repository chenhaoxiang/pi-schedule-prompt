import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Cron } from "croner";
import { DurableExecution } from "./durable.js";
import { dailyLimited, eventBinding, eventNames } from "./events.js";
import { FOLLOWUP_DUE_EVENT, type FollowupDueRequest } from "./followup.js";
import { githubFingerprint } from "./github-events.js";
import { type CronStorage, ScheduleStoreBusyError } from "./storage.js";
import { runSubagentOnce } from "./subagent.js";
import type { CronChangeEvent, CronJob, CronJobType, EventResult } from "./types.js";

type ValidateScheduleResult =
  | { ok: true; schedule: string; intervalMs?: number }
  | { ok: false; error: string };
const MAX_DELAY = 2_147_483_647;
const promptFor = (job: CronJob) => job.type === "event"
  ? job.prompt + "\n\nConfigured event context (metadata, not authorization): " + JSON.stringify({ names: job.schedule, github: job.github })
  : job.prompt;
const snippet = (text: string) => text.length > 500 ? text.slice(0, 500) + "…" : text;

/** Timers own intent only. Host acceptance never proves business completion. */
export class CronScheduler {
  private jobs = new Map<string, Cron>();
  private githubTimers = new Map<string, NodeJS.Timeout>();
  private githubSources = new Set<string>();
  private intervals = new Map<string, NodeJS.Timeout>();
  private nextRuns = new Map<string, Date>();
  private pending = new Set<string>();
  private drainTimer?: NodeJS.Timeout;
  private contention = new Map<string, number>();
  private stopped = false;
  private activeSubagents = new Set<AbortController>();
  private activeJobs = new Map<string, AbortController>();
  private generations = new Map<string, number>();
  private scheduledTurn = false;
  private durable: DurableExecution;

  constructor(
    private readonly storage: CronStorage,
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
  ) { this.durable = new DurableExecution(storage, pi, ctx); }

  start(): void {
    this.stop();
    this.stopped = false;
    const session = this.ctx.sessionManager.getSessionId();
    this.durable.restore();
    for (const job of this.storage.getAllJobs()) {
      if (!CronScheduler.isLoadedFor(job, session)) continue;
      if (job.followUp && ["pending", "dispatched"].includes(job.followUp.state)) {
        const dueOrExpired = Date.parse(job.followUp.expiresAt) <= Date.now() || (job.followUp.state === "dispatched") || Date.parse(job.schedule) <= Date.now();
        if (dueOrExpired) {
          this.storage.markFollowUpUnknown({ ownerSessionId: job.followUp.ownerSessionId, intercomSessionId: job.followUp.intercomSessionId, peerSessionId: job.followUp.peerSessionId, messageId: job.followUp.messageId }, "Owner/scheduler restarted while follow-up state was unresolved");
        }
      }
      if (job.github && job.catchUp !== "latest") this.storage.updateJob(job.id, { sourceFingerprint: undefined });
      if (job.type === "event" && job.pendingEvent) {
        if (job.enabled && job.catchUp === "latest" && job.pendingEvent.revision === (job.revision ?? 0)) this.pending.add(job.id);
        else this.storage.updateJob(job.id, { pendingEvent: undefined, lastStatus: "skipped" });
      }
      if (job.durable && job.type !== "event" && job.enabled) {
        if (job.catchUp === "latest" && (job.pendingIntent || (job.nextRun && Date.parse(job.nextRun) <= Date.now()) || (job.type === "once" && Date.parse(job.schedule) <= Date.now()))) {
          if (!job.pendingIntent) this.storage.queueTime(job.id, session);
          this.pending.add(job.id);
        }
      }
      if (!job.durable && (job.lastStatus === "running" || (job.lastStatus === "queued" && (job.type !== "event" || !job.pendingEvent)))) {
        this.storage.updateJob(job.id, { lastStatus: "unknown" });
      }
      if (job.enabled) this.scheduleJob(job);
    }
    this.armDrain();
  }

  static isLoadedFor(job: CronJob, sessionId: string | undefined): boolean {
    return !job.session || job.session === sessionId;
  }

  receiveEvent(jobId: string, name: string, eventId: string): EventResult {
    if (this.stopped) return { status: "ignored", reason: "stopped" };
    const result = this.storage.queueEvent(jobId, name, eventId, this.ctx.sessionManager.getSessionId());
    if (result.status === "queued" || (result.status === "duplicate" && this.storage.getJob(jobId)?.pendingEvent)) {
      this.pending.add(jobId);
      this.emitChange({ type: "fire", job: this.storage.getJob(jobId) });
      this.drain();
    }
    return result;
  }

  emitEvent(name: string, eventId: string = randomUUID()): void {
    for (const job of this.storage.getAllJobs()) {
      if (job.type === "event" && CronScheduler.isLoadedFor(job, this.ctx.sessionManager.getSessionId()) && eventNames(job.schedule).includes(name)) {
        try { this.receiveEvent(job.id, name, eventId); }
        catch { this.emitChange({ type: "error", jobId: job.id, error: "Lifecycle event not admitted; selected store unavailable" }); }
      }
    }
  }

  setScheduledTurn(value: boolean): void { this.scheduledTurn = value; }
  isScheduledTurn(): boolean { return this.scheduledTurn; }
  isRunning(): boolean { return !this.stopped; }
  onAgentSettled(aborted = false): void { this.durable.settled(aborted); this.drain(); }
  onScheduledStart(claimId: unknown): void { this.durable.started(claimId); }
  onMessageEnd(message: { role: string; stopReason?: string }): void { this.durable.messageEnd(message); }

  stop(): void {
    this.stopped = true;
    this.durable.stop();
    for (const cron of this.jobs.values()) cron.stop();
    for (const timer of this.intervals.values()) clearTimeout(timer);
    for (const timer of this.githubTimers.values()) clearTimeout(timer);
    this.githubTimers.clear();
    this.githubSources.clear();
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

  cancelFollowUp(binding: { ownerSessionId: string; intercomSessionId: string; peerSessionId: string; messageId: string }): { found: boolean; state?: string; jobId?: string; unknown?: boolean } {
    const existing = this.storage.findFollowUp(binding);
    const before = existing ? this.storage.getJob(existing.id) : undefined;
    const result = this.storage.cancelFollowUp(binding);
    if (result.jobId) {
      this.unscheduleJob(result.jobId);
      if (result.unknown && before?.claim?.id && this.durable.activeClaimId() === before.claim.id) this.durable.finish("unknown");
      this.emitChange({ type: "update", job: this.storage.getJob(result.jobId) });
    }
    return result;
  }

  observeFollowUpReply(binding: { ownerSessionId: string; intercomSessionId: string; peerSessionId: string; messageId: string }, reply: { id: string; kind: "ack" | "pending" | "other"; at: string; text?: string }): { found: boolean; state?: string; jobId?: string; completion: "unknown" } {
    const before = this.storage.getJob(this.storage.findFollowUp(binding)?.id ?? "");
    const result = this.storage.observeFollowUpReply(binding, reply);
    if (result.jobId) {
      this.unscheduleJob(result.jobId);
      if (before?.claim?.id && this.durable.activeClaimId() === before.claim.id) this.durable.finish("unknown");
      this.emitChange({ type: "update", job: this.storage.getJob(result.jobId) });
    }
    return result;
  }

  markFollowUpUnknown(binding: { ownerSessionId: string; intercomSessionId: string; peerSessionId: string; messageId: string }, reason: string): { found: boolean; state?: string; jobId?: string } {
    const before = this.storage.getJob(this.storage.findFollowUp(binding)?.id ?? "");
    const result = this.storage.markFollowUpUnknown(binding, reason);
    if (result.jobId) {
      this.unscheduleJob(result.jobId);
      if (before?.claim?.id && this.durable.activeClaimId() === before.claim.id) this.durable.finish("unknown");
      this.emitChange({ type: "update", job: this.storage.getJob(result.jobId) });
    }
    return result;
  }

  getNextRun(id: string): Date | null {
    return this.jobs.get(id)?.nextRun() || this.nextRuns.get(id) || null;
  }

  private scheduleJob(job: CronJob): void {
    try {
      if (job.type === "event") {
        eventNames(job.schedule);
        if (job.github) this.scheduleGithub(job.id);
        return;
      }
      if (job.type === "interval") {
        if (!job.intervalMs || !Number.isSafeInteger(job.intervalMs) || job.intervalMs > MAX_DELAY) {
          throw new Error("Interval must be positive and at most 2147483647 milliseconds");
        }
        if (job.durable) {
          const anchor = job.nextRun && Date.parse(job.nextRun) > Date.now() ? Date.parse(job.nextRun) : Date.now() + job.intervalMs;
          const generation = this.generations.get(job.id) ?? 0;
          const arm = (target: number) => {
            if (this.stopped || generation !== (this.generations.get(job.id) ?? 0) || !this.storage.getJob(job.id)?.enabled) return;
            this.nextRuns.set(job.id, new Date(target));
            this.storage.updateJob(job.id, { nextRun: new Date(target).toISOString() });
            const timer = setTimeout(() => {
              if (this.stopped) return;
              const next = Date.now() + job.intervalMs!;
              this.nextRuns.set(job.id, new Date(next));
              void this.executeJob(job);
              try { arm(next); } catch (error) { this.fail(job.id, error); }
            }, Math.max(1, target - Date.now()));
            timer.unref?.(); this.intervals.set(job.id, timer);
          };
          arm(anchor);
        } else {
          this.nextRuns.set(job.id, new Date(Date.now() + job.intervalMs));
          const timer = setInterval(() => {
            this.nextRuns.set(job.id, new Date(Date.now() + job.intervalMs!));
            void this.executeJob(job);
          }, job.intervalMs);
          timer.unref?.();
          this.intervals.set(job.id, timer);
        }
      } else if (job.type === "once") {
        const target = Date.parse(job.schedule);
        if (job.durable && Number.isFinite(target) && target <= Date.now()) {
          if (!this.pending.has(job.id)) this.storage.updateJob(job.id, { enabled: false, lastStatus: "skipped" });
          return;
        }
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
        if (job.durable) this.storage.updateJob(job.id, { nextRun: this.getNextRun(job.id)?.toISOString() });
      }
    } catch (error) {
      this.fail(job.id, error);
      this.storage.updateJob(job.id, { enabled: false, lastStatus: "error" });
    }
  }

  private scheduleGithub(id: string, failures = 0): void {
    const definition = this.storage.getJob(id);
    if (this.stopped || !definition?.enabled || !definition.github) return;
    if (!this.githubSources.has(id) && this.githubSources.size >= 10) throw new Error("At most 10 selected GitHub sources are allowed per session");
    this.githubSources.add(id);
    const generation = this.generations.get(id) ?? 0;
    const timer = setTimeout(() => {
      this.githubTimers.delete(id);
      void (async () => {
        let failed = failures;
        try {
          const current = this.storage.getJob(id);
          if (this.stopped || !current?.enabled || !current.github || generation !== (this.generations.get(id) ?? 0)) return;
          if ((current.expiresAt && Date.parse(current.expiresAt) <= Date.now()) || (current.maxRuns !== undefined && (current.attemptCount ?? current.runCount) >= current.maxRuns)) { this.eligible(id); return; }
          const fingerprint = await githubFingerprint(current.github);
          if (this.stopped || generation !== (this.generations.get(id) ?? 0)) return;
          const result = this.storage.observeGithub(id, current.revision ?? 0, fingerprint, this.ctx.sessionManager.getSessionId(), eventBinding(current));
          if (result.status === "queued") { this.pending.add(id); this.drain(); }
          failed = 0;
        } catch {
          failed = Math.min(failures + 1, 4);
          this.emitChange({ type: "error", jobId: id, error: "Selected GitHub event source unavailable; backing off" });
        }
        if (!this.stopped && generation === (this.generations.get(id) ?? 0)) this.scheduleGithub(id, failed);
      })().catch(error => this.fail(id, error));
    }, Math.min(3600000, (definition.github.pollSeconds ?? 60) * 1000 * (2 ** failures)));
    timer.unref?.();
    this.githubTimers.set(id, timer);
  }

  private unscheduleJob(id: string): void {
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
    const github = this.githubTimers.get(id);
    if (github) clearTimeout(github);
    this.githubTimers.delete(id);
    this.githubSources.delete(id);
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
    if (process.env.PI_SCHEDULE_SERVICE_SESSION && (!job.durable || !job.session || !job.maxRuns || !job.expiresAt)) { this.fail(id, new Error("Dedicated service requires finite durable session jobs")); return; }
    if ((job.expiresAt && Date.parse(job.expiresAt) <= Date.now()) ||
      (job.maxRuns !== undefined && (job.attemptCount ?? job.runCount) >= job.maxRuns)) {
      this.storage.updateJob(id, { enabled: false });
      this.unscheduleJob(id);
      this.emitChange({ type: "update", job: { ...job, enabled: false } });
      return;
    }
    if (dailyLimited(job)) {
      this.storage.updateJob(id, { lastStatus: "skipped", pendingEvent: undefined });
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
      if (job.durable) {
        if (!this.storage.queueTime(job.id, this.ctx.sessionManager.getSessionId(), this.getNextRun(job.id)?.toISOString())) return;
      } else if (job.model) {
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
        this.deferContention(snapshot.id);
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
    if (this.durable.busy()) { this.armDrain(); return; }
    const id = [...this.pending].find(candidate => !this.activeJobs.has(candidate));
    if (!id) { this.armDrain(); return; }
    this.pending.delete(id);
    let admitted = false;
    try {
      const eligible = this.eligible(id);
      if (eligible?.durable && eligible.type !== "event" && !eligible.pendingIntent) this.storage.queueTime(id, this.ctx.sessionManager.getSessionId(), this.getNextRun(id)?.toISOString());
      if (eligible?.model) {
        this.executeJobInSubagent(eligible);
        this.armDrain();
        return;
      }
      if (eligible?.durable && this.activeJobs.size) { this.pending.add(id); this.armDrain(); return; }
      const job = eligible && (eligible.durable ? this.durable.begin(id) : this.storage.admitJob(id, this.ctx.sessionManager.getSessionId()));
      if (!job && eligible?.durable && this.storage.getAllJobs().some(other => other.claim && other.claim.sessionId === eligible.session && other.claim.phase !== "settled")) this.pending.add(id);
      if (job) {
        admitted = true;
        this.contention.delete(id);
        const attempts = job.attemptCount!;
        if (job.followUp && job.claim) {
          this.dispatchFollowUp(job);
        } else {
          // Admission is persisted before a potentially effectful send.
          this.pi.sendMessage({
            customType: "scheduled_prompt", content: promptFor(job), display: true,
            details: { jobId: id, jobName: job.name, prompt: job.prompt, mode: "inline", ...(job.claim ? { claimId: job.claim.id } : {}) },
          }, { triggerTurn: true, deliverAs: "followUp" });
        }
        if (!job.durable) this.storage.updateJob(id, {
          lastRun: new Date().toISOString(), lastStatus: "dispatched", runCount: job.runCount + 1,
          ...(job.type === "once" || (job.maxRuns !== undefined && attempts >= job.maxRuns) ? { enabled: false } : {}),
          nextRun: this.getNextRun(id)?.toISOString(),
        });
        if (this.storage.getJob(id)?.enabled === false) this.unscheduleJob(id);
        this.emitChange({ type: "fire", job: this.storage.getJob(id) });
      }
    } catch (error) {
      if (!admitted && error instanceof ScheduleStoreBusyError) this.deferContention(id);
      else { this.durable.finish("unknown"); this.fail(id, error); }
    }
    this.armDrain();
  }

  private dispatchFollowUp(job: CronJob): void {
    const binding = job.followUp;
    const claim = job.claim;
    if (!binding || !claim) {
      this.durable.finish("unknown");
      return;
    }
    if (!this.storage.beginFollowUpDispatch(job.id, claim.id)) {
      this.durable.finish("unknown");
      return;
    }
    let responded = false;
    const request: FollowupDueRequest = {
      version: 1,
      binding: {
        ownerSessionId: binding.ownerSessionId,
        intercomSessionId: binding.intercomSessionId,
        peerSessionId: binding.peerSessionId,
        messageId: binding.messageId,
      },
      record: { ...binding },
      jobId: job.id,
      claimId: claim.id,
      claim: () => undefined,
      isCurrent: () => {
        const current = this.storage.getJob(job.id);
        return !!current && current.claim?.id === claim.id && current.followUp?.state === "dispatched";
      },
      respond: result => {
        if (responded) return;
        responded = true;
        try {
          const current = this.storage.getJob(job.id);
          if (current?.claim?.id === claim.id && current.followUp) {
            this.storage.updateFollowUp(job.id, {
              reminderMessageId: result.messageId,
              transportState: result.delivered ? "delivered" : "unknown",
              ...(result.delivered ? {} : { state: "unknown", unknownReason: result.reason ?? "Follow-up transport outcome unknown" }),
            });
          }
        } catch { /* Preserve the claim; durable finish below records unknown. */ }
        this.durable.finish("unknown");
      },
    };
    try {
      this.pi.events.emit(FOLLOWUP_DUE_EVENT, request);
    } catch (error) {
      request.respond({ delivered: false, unknown: true, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  private executeJobInSubagent(snapshot: CronJob): void {
    if (this.activeJobs.has(snapshot.id) || this.stopped) return;
    const job = snapshot.durable ? this.durable.begin(snapshot.id) : this.storage.admitJob(snapshot.id, this.ctx.sessionManager.getSessionId());
    if (!job) return;
    const model = job.model!;
    const attempts = job.attemptCount!;
    if (!job.durable) this.storage.updateJob(job.id, { lastStatus: "running", attemptCount: attempts,
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
    if (job.claim) { this.durable.setAbort(job.claim.id, () => controller.abort()); this.durable.started(job.claim.id); }
    void (async () => {
      try {
        const result = await runSubagentOnce(this.ctx, promptFor(job), model, controller.signal,
          { extensions: job.extensions, skills: job.skills });
        const latest = this.storage.getJob(job.id);
        if (controller.signal.aborted || this.stopped || !latest ||
          generation !== (this.generations.get(job.id) ?? 0)) return;
        const text = result.ok
          ? snippet(result.text.trim()) || "(subagent produced no text output)"
          : snippet(result.error.trim()) || "(subagent failed with empty error)";
        if (job.durable) this.durable.finish(result.ok ? "success" : "error");
        else this.storage.updateJob(job.id, {
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
      } catch (error) { if (job.durable) this.durable.finish("unknown"); this.fail(job.id, error); }
      finally {
        this.activeSubagents.delete(controller);
        if (this.activeJobs.get(job.id) === controller) this.activeJobs.delete(job.id);
        if (job.claim) this.durable.release(job.claim.id);
        this.drain();
      }
    })();
  }

  private deferContention(id: string): void {
    const failures = (this.contention.get(id) ?? 0) + 1;
    this.contention.set(id, failures);
    if (this.storage.getJob(id)?.durable && failures > 3) { this.fail(id, new Error("Pre-dispatch store remained busy after three retries; held without execution")); return; }
    this.pending.add(id); this.armDrain();
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
    if (type === "event") {
      try { return { ok: true, schedule: eventNames(schedule).join(",") }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Invalid event schedule" }; }
    }
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
