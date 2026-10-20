import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { dailyLimited, EVENT_KEY_LIMIT, eventBinding, eventKey, eventNames, validateGithub, validEventId, validEventName } from "./events.js";
import type { CronJob, CronStore, EventResult, ExecutionOutcome, ExecutionReceipt } from "./types.js";

const STATUSES = new Set(["success", "error", "running", "queued", "dispatched", "unknown", "skipped"]);

function validate(store: unknown): asserts store is CronStore {
  if (!store || typeof store !== "object") throw new Error("Invalid schedule store");
  const data = store as CronStore;
  if (![1, 2, 3].includes(data.version) || !Array.isArray(data.jobs)) throw new Error("Unsupported schedule store");
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const job of data.jobs) {
    if (!job || typeof job !== "object" ||
      ![job.id, job.name, job.schedule, job.prompt, job.createdAt].every(v => typeof v === "string" && v.trim()) ||
      !["cron", "interval", "once", "event"].includes(job.type) || typeof job.enabled !== "boolean" ||
      !Number.isSafeInteger(job.runCount) || job.runCount < 0 ||
      (job.intervalMs !== undefined && (!Number.isSafeInteger(job.intervalMs) || job.intervalMs <= 0)) ||
      (job.session !== undefined && (typeof job.session !== "string" || !job.session.trim())) ||
      (job.model !== undefined && (typeof job.model !== "string" || !job.model.trim())) ||
      (job.lastStatus !== undefined && !STATUSES.has(job.lastStatus)) ||
      (job.attemptCount !== undefined && (!Number.isSafeInteger(job.attemptCount) || job.attemptCount < 0)) ||
      (job.maxRuns !== undefined && (!Number.isSafeInteger(job.maxRuns) || job.maxRuns < 1)) ||
      (job.maxRunsPerDay !== undefined && (!Number.isSafeInteger(job.maxRunsPerDay) || job.maxRunsPerDay < 1)) ||
      (job.revision !== undefined && (!Number.isSafeInteger(job.revision) || job.revision < 0)) ||
      (job.catchUp !== undefined && !["none", "latest"].includes(job.catchUp)) ||
      (job.dailyUsage !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(job.dailyUsage.day) || !Number.isSafeInteger(job.dailyUsage.attempts) || job.dailyUsage.attempts < 0)) ||
      (job.expiresAt !== undefined && (typeof job.expiresAt !== "string" || !Number.isFinite(Date.parse(job.expiresAt))))) {
      throw new Error("Invalid scheduled job; refusing to overwrite the store");
    }
    if (job.type === "event") {
      eventNames(job.schedule);
      if (!job.session) throw new Error("Event jobs must bind to a session; shared broadcast remains time-only");
    }
    if (job.github !== undefined) {
      validateGithub(job.github);
      if (job.type !== "event" || !eventNames(job.schedule).includes("github:" + job.github.kind)) throw new Error("GitHub producer must match an event job name");
    }
    for (const keys of [job.recentEventKeys, job.pendingEvent?.keys]) {
      if (keys !== undefined && (!Array.isArray(keys) || keys.length > EVENT_KEY_LIMIT || !keys.every(key => typeof key === "string" && /^[a-f0-9]{64}$/.test(key)))) throw new Error("Invalid bounded event keys");
    }
    if (job.pendingEvent && (!Number.isSafeInteger(job.pendingEvent.revision) || !/^[a-f0-9]{64}$/.test(job.pendingEvent.binding) || !Number.isFinite(Date.parse(job.pendingEvent.acceptedAt)))) throw new Error("Invalid pending event");
    if (job.sourceFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(job.sourceFingerprint)) throw new Error("Invalid source fingerprint");
    if ((job.durable !== undefined && typeof job.durable !== "boolean") || (job.durable && (!job.session || job.notify === true)) ||
      (job.deadlineMs !== undefined && (!Number.isSafeInteger(job.deadlineMs) || job.deadlineMs < 1000 || job.deadlineMs > 86400000)) ||
      (job.consecutiveErrors !== undefined && (!Number.isSafeInteger(job.consecutiveErrors) || job.consecutiveErrors < 0))) throw new Error("Invalid durable job bounds/session");
    if (job.pendingIntent && (!Number.isSafeInteger(job.pendingIntent.revision) || !/^[a-f0-9]{64}$/.test(job.pendingIntent.binding) || !Number.isFinite(Date.parse(job.pendingIntent.acceptedAt)))) throw new Error("Invalid durable intent");
    const claim = job.claim;
    if (claim && (!job.durable || !validEventId(claim.id) || !validEventId(claim.ownerId) || claim.sessionId !== job.session || !Number.isSafeInteger(claim.ownerPid) || claim.ownerPid < 1 ||
      !/^[a-f0-9]{64}$/.test(claim.binding) || !["claimed", "dispatched", "started", "settled"].includes(claim.phase) ||
      ![claim.claimedAt, claim.deadlineAt].every(date => Number.isFinite(Date.parse(date))) ||
      (claim.outcome !== undefined && !["success", "error", "aborted", "unknown"].includes(claim.outcome)))) throw new Error("Invalid durable claim");
    if (job.notice && (!validEventId(job.notice.claimId) || !["success", "error", "aborted", "unknown"].includes(job.notice.outcome) || !["pending", "accepted", "failed"].includes(job.notice.state) || !Number.isSafeInteger(job.notice.attempts) || job.notice.attempts < 0 || job.notice.attempts > 3)) throw new Error("Invalid notification state");
    if (ids.has(job.id) || names.has(job.name)) throw new Error("Duplicate scheduled job id or name");
    ids.add(job.id);
    names.add(job.name);
  }
}

export class ScheduleStoreBusyError extends Error {
  constructor() { super("Schedule store is busy (lock exists); retry after the owning writer finishes"); }
}

/** Cooperating same-user local writers; not a distributed execution lock. */
export class CronStorage {
  private readonly storePath: string;
  private readonly piDir: string;

  constructor(cwd: string) {
    this.piDir = path.join(cwd, ".pi");
    this.storePath = path.join(this.piDir, "schedule-prompts.json");
  }

  load(): CronStore {
    let text: string;
    try {
      text = fs.readFileSync(this.storePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, jobs: [] };
      throw error;
    }
    const store: unknown = JSON.parse(text);
    validate(store);
    return store;
  }

  private mutate<T>(change: (store: CronStore) => T): T {
    fs.mkdirSync(this.piDir, { recursive: true, mode: 0o700 });
    const lockPath = `${this.storePath}.lock`;
    let fd: number;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ScheduleStoreBusyError();
      }
      throw error;
    }
    const temporary = `${this.storePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      const store = this.load();
      const result = change(store);
      store.version = 3;
      validate(store);
      const output = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(output, JSON.stringify(store, null, 2), "utf8");
        fs.fsyncSync(output);
      } finally {
        fs.closeSync(output);
      }
      fs.renameSync(temporary, this.storePath);
      const directory = fs.openSync(this.piDir, "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      return result;
    } finally {
      fs.rmSync(temporary, { force: true });
      fs.closeSync(fd);
      fs.rmSync(lockPath);
    }
  }

  /** Claim one attempt under the same mutation lock; this is not completion proof. */
  admitJob(id: string, sessionId: string | undefined): CronJob | undefined {
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      if (!job?.enabled || job.durable || (job.session && job.session !== sessionId)) return;
      if ((job.expiresAt && Date.parse(job.expiresAt) <= Date.now()) ||
        (job.maxRuns !== undefined && (job.attemptCount ?? job.runCount) >= job.maxRuns)) {
        job.enabled = false;
        return;
      }
      if (dailyLimited(job)) { job.lastStatus = "skipped"; return; }
      if (job.type === "event" && (!job.pendingEvent || job.pendingEvent.revision !== (job.revision ?? 0) || job.pendingEvent.binding !== eventBinding(job))) { job.pendingEvent = undefined; job.lastStatus = "skipped"; return; }
      job.pendingEvent = undefined;
      const day = new Date().toISOString().slice(0, 10);
      job.dailyUsage = { day, attempts: (job.dailyUsage?.day === day ? job.dailyUsage.attempts : 0) + 1 };
      job.attemptCount = (job.attemptCount ?? job.runCount) + 1;
      job.lastStatus = "unknown";
      return { ...job };
    });
  }

  queueTime(id: string, sessionId: string | undefined, nextRun?: string): boolean {
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      if (!job?.durable || !job.enabled || job.session !== sessionId) return false;
      job.pendingIntent = { revision: job.revision ?? 0, binding: eventBinding(job), acceptedAt: new Date().toISOString() };
      if (!job.claim || job.claim.phase === "settled") job.lastStatus = "queued";
      job.nextRun = nextRun;
      return true;
    });
  }

  claimJob(id: string, sessionId: string, ownerId: string): CronJob | undefined {
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      if (!job?.durable || !job.enabled || job.session !== sessionId ||
        (job.claim && (job.claim.phase !== "settled" || ["unknown", "aborted"].includes(job.claim.outcome ?? "unknown")))) return;
      if (store.jobs.some(other => other.id !== id && other.durable && other.claim?.sessionId === sessionId && other.claim.phase !== "settled")) return;
      const pending = job.type === "event" ? job.pendingEvent : job.pendingIntent;
      if (!pending || pending.revision !== (job.revision ?? 0) || pending.binding !== eventBinding(job)) { job.pendingIntent = undefined; job.pendingEvent = undefined; return; }
      if ((job.expiresAt && Date.parse(job.expiresAt) <= Date.now()) || (job.maxRuns !== undefined && (job.attemptCount ?? job.runCount) >= job.maxRuns)) { job.enabled = false; return; }
      if (dailyLimited(job)) { job.lastStatus = "skipped"; return; }
      const day = new Date().toISOString().slice(0, 10);
      job.dailyUsage = { day, attempts: (job.dailyUsage?.day === day ? job.dailyUsage.attempts : 0) + 1 };
      job.attemptCount = (job.attemptCount ?? job.runCount) + 1;
      job.pendingIntent = undefined;
      job.pendingEvent = undefined;
      job.claim = { id: randomUUID(), ownerId, ownerPid: process.pid, sessionId, binding: eventBinding(job), phase: "claimed", claimedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + (job.deadlineMs ?? 600000)).toISOString() };
      job.lastStatus = "unknown";
      return structuredClone(job);
    });
  }

  markClaim(id: string, claimId: string, phase: "dispatched" | "started"): boolean {
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      if (!job?.claim || job.claim.id !== claimId || job.claim.phase === "settled") return false;
      if (job.claim.phase === phase) return true;
      if (phase === "dispatched" && (!job.enabled || job.claim.binding !== eventBinding(job))) return false;
      if ((phase === "dispatched" && job.claim.phase !== "claimed") || (phase === "started" && job.claim.phase !== "dispatched")) return false;
      job.claim.phase = phase;
      job.lastStatus = phase === "started" ? "running" : "dispatched";
      job.lastRun = new Date().toISOString();
      if (phase === "dispatched") {
        if (!job.model) job.runCount += 1;
        if (job.type === "once" || (job.maxRuns !== undefined && (job.attemptCount ?? 0) >= job.maxRuns)) job.enabled = false;
      }
      return true;
    });
  }

  private settleInto(job: CronJob, outcome: ExecutionOutcome): void {
    if (!job.claim || job.claim.phase === "settled") return;
    job.claim.phase = "settled";
    job.claim.outcome = outcome;
    job.lastStatus = outcome === "aborted" ? "unknown" : outcome;
    if (job.model && outcome === "success") job.runCount += 1;
    job.consecutiveErrors = outcome === "error" ? (job.consecutiveErrors ?? 0) + 1 : outcome === "success" ? 0 : job.consecutiveErrors;
    if (["unknown", "aborted"].includes(outcome) || (job.consecutiveErrors ?? 0) >= 3) job.enabled = false;
    job.notice = { claimId: job.claim.id, outcome, state: "pending", attempts: 0 };
  }

  settleClaim(receipt: ExecutionReceipt): boolean {
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === receipt.jobId);
      if (!job?.claim || job.claim.id !== receipt.claimId || job.claim.sessionId !== receipt.sessionId) return false;
      this.settleInto(job, receipt.outcome);
      return true;
    });
  }

  recordNotice(id: string, claimId: string, accepted: boolean): void {
    this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      if (!job?.notice || job.notice.claimId !== claimId || job.notice.state === "accepted") return;
      job.notice.attempts = Math.min(3, job.notice.attempts + 1);
      job.notice.state = accepted ? "accepted" : "failed";
      // Notice failure is not execution failure and does not disable future admissions.
    });
  }

  /** Reconcile only exact session receipts; never infer completion from a dead process. */
  reconcileJob(id: string, sessionId: string, ownerId: string, receipts: ExecutionReceipt[], ownerAlive: (pid: number) => boolean): void {
    this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      if (!job?.durable || job.session !== sessionId || !job.claim || job.claim.phase === "settled") return;
      const claim = job.claim;
      const receipt = receipts.find(item => item.jobId === id && item.claimId === claim.id && item.sessionId === sessionId);
      if (receipt) { this.settleInto(job, receipt.outcome); return; }
      if (claim.ownerId === ownerId || ownerAlive(claim.ownerPid)) return;
      if (claim.phase === "claimed") {
        // No effectful dispatch was entered. Release exactly this unspent attempt.
        job.attemptCount = Math.max(0, (job.attemptCount ?? 1) - 1);
        if (job.dailyUsage?.day === claim.claimedAt.slice(0, 10)) job.dailyUsage.attempts = Math.max(0, job.dailyUsage.attempts - 1);
        job.claim = undefined;
        if (job.catchUp === "latest" && claim.binding === eventBinding(job)) {
          const intent = { revision: job.revision ?? 0, binding: claim.binding, acceptedAt: claim.claimedAt };
          if (job.type === "event") job.pendingEvent = { ...intent, keys: [] };
          else job.pendingIntent = intent;
          job.lastStatus = "queued";
        } else job.lastStatus = "skipped";
      } else this.settleInto(job, "unknown");
    });
  }

  private queueInto(job: CronJob | undefined, name: string, eventId: string, sessionId: string | undefined): EventResult {
    if (job?.type !== "event") return { status: "ignored", reason: "not-event" };
    if (job.session && job.session !== sessionId) return { status: "ignored", reason: "foreign-session" };
    if (!eventNames(job.schedule).includes(name)) return { status: "ignored", reason: "event-mismatch" };
    const key = eventKey(job, name, eventId);
    if (job.recentEventKeys?.includes(key)) return { status: "duplicate" };
    if (!job.enabled) return { status: "ignored", reason: "paused" };
    if ((job.expiresAt && Date.parse(job.expiresAt) <= Date.now()) || (job.maxRuns !== undefined && (job.attemptCount ?? job.runCount) >= job.maxRuns)) return { status: "ignored", reason: "expired-or-limited" };
    if (dailyLimited(job)) return { status: "ignored", reason: "daily-limit" };
    job.recentEventKeys = [...(job.recentEventKeys ?? []), key].slice(-EVENT_KEY_LIMIT);
    job.pendingEvent = { revision: job.revision ?? 0, binding: eventBinding(job), keys: [...(job.pendingEvent?.keys ?? []), key].slice(-EVENT_KEY_LIMIT), acceptedAt: new Date().toISOString() };
    job.lastStatus = "queued";
    return { status: "queued" };
  }

  queueEvent(id: string, name: string, eventId: string, sessionId: string | undefined): EventResult {
    if (!validEventName(name) || !validEventId(eventId)) throw new Error("Invalid event name/id; no free-form payload is accepted");
    return this.mutate(store => this.queueInto(store.jobs.find(job => job.id === id), name, eventId, sessionId));
  }

  observeGithub(id: string, revision: number, fingerprint: string, sessionId: string | undefined, binding: string): EventResult {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Invalid GitHub fingerprint");
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      if (!job?.github || !job.enabled || ((job.revision ?? 0) !== revision || eventBinding(job) !== binding) || (job.session && job.session !== sessionId)) return { status: "ignored", reason: "source-changed" };
      if (job.sourceFingerprint === fingerprint) return { status: "duplicate" };
      const seeded = !!job.sourceFingerprint;
      if (!seeded) { job.sourceFingerprint = fingerprint; return { status: "ignored", reason: "seeded" }; }
      const result = this.queueInto(job, "github:" + job.github.kind, fingerprint, sessionId);
      if (result.status !== "ignored" || job.catchUp !== "latest") job.sourceFingerprint = fingerprint;
      return result;
    });
  }

  hasJobWithName(name: string): boolean {
    return this.load().jobs.some(job => job.name === name);
  }

  addJob(job: CronJob): void {
    this.mutate(store => {
      if (store.jobs.some(item => item.id === job.id || item.name === job.name)) {
        throw new Error("A scheduled job with this id or name already exists");
      }
      store.jobs.push({ ...job, revision: job.revision ?? 1 });
    });
  }

  removeJob(id: string): boolean {
    return this.mutate(store => {
      const count = store.jobs.length;
      store.jobs = store.jobs.filter(job => job.id !== id);
      return store.jobs.length !== count;
    });
  }

  updateJob(id: string, partial: Partial<CronJob>): boolean {
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      if (!job) return false;
      const configKeys = ["name", "schedule", "prompt", "enabled", "model", "notify", "extensions", "skills", "session", "maxRuns", "expiresAt", "maxRunsPerDay", "catchUp", "github", "durable", "deadlineMs"];
      const changed = configKeys.some(key => key in partial && JSON.stringify(job[key as keyof CronJob]) !== JSON.stringify(partial[key as keyof CronJob]));
      Object.assign(job, partial);
      if (changed) { job.revision = (job.revision ?? 0) + 1; job.pendingEvent = undefined; job.pendingIntent = undefined; job.sourceFingerprint = undefined; job.nextRun = undefined; }
      return true;
    });
  }

  getJob(id: string): CronJob | undefined {
    return this.load().jobs.find(job => job.id === id);
  }

  getAllJobs(): CronJob[] {
    return this.load().jobs;
  }

  getStorePath(): string {
    return this.storePath;
  }
}
