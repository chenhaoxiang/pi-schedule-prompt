import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { dailyLimited, EVENT_KEY_LIMIT, eventBinding, eventKey, eventNames, validateGithub, validEventId, validEventName, validEvidenceFingerprint } from "./events.js";
import type { CronJob, CronStore, EventResult, ExecutionOutcome, ExecutionReceipt, ProgressOutcome } from "./types.js";

const STATUSES = new Set(["success", "error", "running", "queued", "dispatched", "unknown", "skipped", "quiet"]);

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
      (job.quietOnNoChange !== undefined && typeof job.quietOnNoChange !== "boolean") ||
      (job.noChangeThreshold !== undefined && (!Number.isSafeInteger(job.noChangeThreshold) || job.noChangeThreshold < 1 || job.noChangeThreshold > 10)) ||
      (job.quietForMs !== undefined && (!Number.isSafeInteger(job.quietForMs) || job.quietForMs < 1000 || job.quietForMs > 86400000)) ||
      (job.lastEvidenceFingerprint !== undefined && !validEvidenceFingerprint(job.lastEvidenceFingerprint)) ||
      (job.noChangeCount !== undefined && (!Number.isSafeInteger(job.noChangeCount) || job.noChangeCount < 0)) ||
      (job.waitingReason !== undefined && (typeof job.waitingReason !== "string" || job.waitingReason.length > 128 || /[\u0000-\u001f\u007f]/.test(job.waitingReason))) ||
      (job.quietUntil !== undefined && (typeof job.quietUntil !== "string" || !Number.isFinite(Date.parse(job.quietUntil)))) ||
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
    if (job.pendingEvent && (!Number.isSafeInteger(job.pendingEvent.revision) || !/^[a-f0-9]{64}$/.test(job.pendingEvent.binding) || !Number.isFinite(Date.parse(job.pendingEvent.acceptedAt)) || (job.pendingEvent.evidenceFingerprint !== undefined && !validEvidenceFingerprint(job.pendingEvent.evidenceFingerprint)))) throw new Error("Invalid pending event");
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
    const followUp = job.followUp;
    if (followUp && (followUp.version !== 1 || !job.durable || !job.session || followUp.ownerSessionId !== job.session || ![followUp.ownerSessionId, followUp.intercomSessionId, followUp.peerSessionId, followUp.messageId, followUp.requestId, followUp.goal, followUp.phase, followUp.createdAt, followUp.updatedAt].every(value => typeof value === "string" && value.trim()) ||
      !Number.isSafeInteger(followUp.intervalMs) || followUp.intervalMs < 1000 || followUp.intervalMs > 86400000 ||
      followUp.maxRuns !== 1 || !["pending", "dispatched", "answered", "cancelled", "unknown"].includes(followUp.state) ||
      !Number.isFinite(Date.parse(followUp.deadlineAt)) || !Number.isFinite(Date.parse(followUp.expiresAt)) ||
      (followUp.coveredBy !== undefined && (typeof followUp.coveredBy !== "string" || !followUp.coveredBy.trim())) ||
      (followUp.reminderMessageId !== undefined && !validEventId(followUp.reminderMessageId)) ||
      (followUp.transportState !== undefined && !["delivered", "unknown"].includes(followUp.transportState)) ||
      (followUp.lastReply !== undefined && (!validEventId(followUp.lastReply.id) || !["ack", "pending", "other"].includes(followUp.lastReply.kind) || !Number.isFinite(Date.parse(followUp.lastReply.at)) || (followUp.lastReply.text !== undefined && typeof followUp.lastReply.text !== "string"))))) {
      throw new Error("Invalid reply follow-up binding");
    }
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

  beginFollowUpDispatch(id: string, claimId: string, now = Date.now()): boolean {
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      const followUp = job?.followUp;
      if (!job?.enabled || !followUp || followUp.state !== "pending" || job.claim?.id !== claimId || job.claim.phase !== "dispatched") return false;
      if (Date.parse(followUp.expiresAt) <= now || Date.parse(followUp.deadlineAt) <= now) {
        job.enabled = false;
        followUp.state = "unknown";
        followUp.unknownReason = "Follow-up deadline/expiry reached before dispatch";
        followUp.updatedAt = new Date().toISOString();
        job.lastStatus = "unknown";
        return false;
      }
      followUp.state = "dispatched";
      job.enabled = false;
      followUp.updatedAt = new Date().toISOString();
      return true;
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
        if (!job.followUp && (job.type === "once" || (job.maxRuns !== undefined && (job.attemptCount ?? 0) >= job.maxRuns))) job.enabled = false;
      }
      return true;
    });
  }

  private applyProgress(job: CronJob, progress: ProgressOutcome | undefined, evidenceFingerprint: string | undefined, waitingReason: string | undefined): void {
    if (progress === undefined) return;
    if (evidenceFingerprint === undefined || !validEvidenceFingerprint(evidenceFingerprint)) return;
    if (progress === "advanced") job.noChangeCount = 0;
    if (progress === "unchanged") job.noChangeCount = (job.noChangeCount ?? 0) + 1;
    job.lastEvidenceFingerprint = evidenceFingerprint;
    if (waitingReason !== undefined) job.waitingReason = waitingReason;
    if (job.quietOnNoChange && progress === "unchanged" && (job.noChangeCount ?? 0) >= (job.noChangeThreshold ?? 2)) {
      job.quietUntil = new Date(Date.now() + (job.quietForMs ?? 3600000)).toISOString();
      job.lastStatus = "quiet";
    }
  }

  private settleInto(job: CronJob, outcome: ExecutionOutcome, receipt?: ExecutionReceipt): void {
    if (!job.claim || job.claim.phase === "settled") return;
    job.claim.phase = "settled";
    job.claim.outcome = outcome;
    job.lastStatus = outcome === "aborted" ? "unknown" : outcome;
    this.applyProgress(job, receipt?.progress, receipt?.evidenceFingerprint, receipt?.waitingReason);
    if (job.model && outcome === "success") job.runCount += 1;
    job.consecutiveErrors = outcome === "error" ? (job.consecutiveErrors ?? 0) + 1 : outcome === "success" ? 0 : job.consecutiveErrors;
    if (["unknown", "aborted"].includes(outcome) || (job.consecutiveErrors ?? 0) >= 3) job.enabled = false;
    job.notice = { claimId: job.claim.id, outcome, state: "pending", attempts: 0 };
  }

  settleClaim(receipt: ExecutionReceipt): boolean {
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === receipt.jobId);
      if (!job?.claim || job.claim.id !== receipt.claimId || job.claim.sessionId !== receipt.sessionId) return false;
      if (receipt.evidenceFingerprint !== undefined && !validEvidenceFingerprint(receipt.evidenceFingerprint)) return false;
      if (receipt.progress !== undefined && !["advanced", "unchanged", "unknown"].includes(receipt.progress)) return false;
      if (receipt.waitingReason !== undefined && (receipt.waitingReason.length > 128 || /[\u0000-\u001f\u007f]/.test(receipt.waitingReason))) return false;
      this.settleInto(job, receipt.outcome, receipt);
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
      if (receipt) { this.settleInto(job, receipt.outcome, receipt); return; }
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

  private queueInto(job: CronJob | undefined, name: string, eventId: string, sessionId: string | undefined, evidenceFingerprint?: string): EventResult {
    if (job?.type !== "event") return { status: "ignored", reason: "not-event" };
    if (evidenceFingerprint !== undefined && !validEvidenceFingerprint(evidenceFingerprint)) return { status: "ignored", reason: "invalid-evidence" };
    if (job.session && job.session !== sessionId) return { status: "ignored", reason: "foreign-session" };
    if (!eventNames(job.schedule).includes(name)) return { status: "ignored", reason: "event-mismatch" };
    const key = eventKey(job, name, eventId);
    if (job.recentEventKeys?.includes(key)) return { status: "duplicate" };
    if (!job.enabled) return { status: "ignored", reason: "paused" };
    if ((job.expiresAt && Date.parse(job.expiresAt) <= Date.now()) || (job.maxRuns !== undefined && (job.attemptCount ?? job.runCount) >= job.maxRuns)) return { status: "ignored", reason: "expired-or-limited" };
    if (dailyLimited(job)) return { status: "ignored", reason: "daily-limit" };
    if (evidenceFingerprint !== undefined && job.quietOnNoChange && job.lastEvidenceFingerprint === evidenceFingerprint) {
      job.noChangeCount = (job.noChangeCount ?? 0) + 1;
      job.waitingReason = "no_change";
      if ((job.noChangeCount ?? 0) >= (job.noChangeThreshold ?? 2)) {
        job.quietUntil = new Date(Date.now() + (job.quietForMs ?? 3600000)).toISOString();
        job.lastStatus = "quiet";
      }
      return { status: "duplicate", reason: "no-change" };
    }
    job.recentEventKeys = [...(job.recentEventKeys ?? []), key].slice(-EVENT_KEY_LIMIT);
    if (evidenceFingerprint !== undefined && job.lastEvidenceFingerprint !== evidenceFingerprint) {
      job.noChangeCount = 0;
      job.waitingReason = undefined;
      job.quietUntil = undefined;
    }
    job.lastEvidenceFingerprint = evidenceFingerprint ?? job.lastEvidenceFingerprint;
    job.pendingEvent = {
      revision: job.revision ?? 0,
      binding: eventBinding(job),
      keys: [...(job.pendingEvent?.keys ?? []), key].slice(-EVENT_KEY_LIMIT),
      acceptedAt: new Date().toISOString(),
      ...(evidenceFingerprint === undefined ? {} : { evidenceFingerprint }),
    };
    job.lastStatus = "queued";
    return { status: "queued" };
  }

  queueEvent(id: string, name: string, eventId: string, sessionId: string | undefined, evidenceFingerprint?: string): EventResult {
    if (!validEventName(name) || !validEventId(eventId)) throw new Error("Invalid event name/id; no free-form payload is accepted");
    return this.mutate(store => this.queueInto(store.jobs.find(job => job.id === id), name, eventId, sessionId, evidenceFingerprint));
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

  createFollowUp(job: CronJob): { job: CronJob; created: boolean } {
    const followUp = job.followUp;
    if (!followUp) throw new Error("Follow-up metadata is required");
    return this.mutate(store => {
      const existing = store.jobs.find(item => {
        const a = item.followUp;
        const b = followUp;
        return a?.version === 1 && a.ownerSessionId === b.ownerSessionId && a.intercomSessionId === b.intercomSessionId
          && a.peerSessionId === b.peerSessionId && a.messageId === b.messageId;
      });
      if (existing) return { job: structuredClone(existing), created: false };
      const coveredBy = followUp.coveredBy;
      if (coveredBy && store.jobs.some(item => (item.id === coveredBy && item.enabled) || (item.followUp?.version === 1 && item.followUp.ownerSessionId === followUp.ownerSessionId && item.followUp.coveredBy === coveredBy && item.enabled && ["pending", "dispatched"].includes(item.followUp.state)))) {
        throw new Error(`An active schedule already covers ${coveredBy}; no second loop was created`);
      }
      if (store.jobs.some(item => item.id === job.id || item.name === job.name)) throw new Error("A scheduled follow-up id or name already exists");
      store.jobs.push({ ...structuredClone(job), revision: job.revision ?? 1 });
      return { job: structuredClone(job), created: true };
    });
  }

  cancelFollowUp(binding: { ownerSessionId: string; intercomSessionId: string; peerSessionId: string; messageId: string }, reason = "cancelled by exact reply"): { found: boolean; state?: NonNullable<CronJob["followUp"]>["state"]; jobId?: string; unknown?: boolean } {
    return this.mutate(store => {
      const job = store.jobs.find(item => {
        const followUp = item.followUp;
        return followUp?.version === 1 && followUp.ownerSessionId === binding.ownerSessionId
          && followUp.intercomSessionId === binding.intercomSessionId && followUp.peerSessionId === binding.peerSessionId
          && followUp.messageId === binding.messageId;
      });
      if (!job?.followUp) return { found: false };
      if (job.followUp.state === "pending") {
        job.enabled = false;
        job.followUp.state = "cancelled";
        job.followUp.unknownReason = reason;
        job.lastStatus = "skipped";
        job.followUp.updatedAt = new Date().toISOString();
        return { found: true, state: "cancelled", jobId: job.id };
      }
      if (job.followUp.state === "dispatched") {
        job.enabled = false;
        job.followUp.state = "unknown";
        job.followUp.unknownReason = "Cancellation raced with dispatch; transport/effect outcome is unknown";
        job.lastStatus = "unknown";
        job.followUp.updatedAt = new Date().toISOString();
        return { found: true, state: "unknown", jobId: job.id, unknown: true };
      }
      return { found: true, state: job.followUp.state, jobId: job.id, unknown: job.followUp.state === "unknown" };
    });
  }

  markFollowUpUnknown(binding: { ownerSessionId: string; intercomSessionId: string; peerSessionId: string; messageId: string }, reason: string): { found: boolean; state?: NonNullable<CronJob["followUp"]>["state"]; jobId?: string } {
    return this.mutate(store => {
      const job = store.jobs.find(item => {
        const followUp = item.followUp;
        return followUp?.version === 1 && followUp.ownerSessionId === binding.ownerSessionId
          && followUp.intercomSessionId === binding.intercomSessionId && followUp.peerSessionId === binding.peerSessionId
          && followUp.messageId === binding.messageId;
      });
      if (!job?.followUp) return { found: false };
      job.enabled = false;
      if (job.followUp.state === "pending" || job.followUp.state === "dispatched") job.followUp.state = "unknown";
      job.followUp.unknownReason = reason;
      job.followUp.updatedAt = new Date().toISOString();
      job.lastStatus = "unknown";
      return { found: true, state: job.followUp.state, jobId: job.id };
    });
  }

  observeFollowUpReply(binding: { ownerSessionId: string; intercomSessionId: string; peerSessionId: string; messageId: string }, reply: { id: string; kind: "ack" | "pending" | "other"; at: string; text?: string }): { found: boolean; state?: NonNullable<CronJob["followUp"]>["state"]; jobId?: string; completion: "unknown" } {
    return this.mutate(store => {
      const job = store.jobs.find(item => {
        const followUp = item.followUp;
        return followUp?.version === 1 && followUp.ownerSessionId === binding.ownerSessionId
          && followUp.intercomSessionId === binding.intercomSessionId && followUp.peerSessionId === binding.peerSessionId
          && followUp.messageId === binding.messageId;
      });
      if (!job?.followUp) return { found: false, completion: "unknown" as const };
      const previous = job.followUp.state;
      job.enabled = false;
      job.followUp.lastReply = reply;
      if (["pending", "dispatched"].includes(previous)) {
        job.followUp.state = "answered";
        job.lastStatus = "dispatched";
      }
      job.followUp.updatedAt = new Date().toISOString();
      return { found: true, state: job.followUp.state, jobId: job.id, completion: "unknown" as const };
    });
  }

  expireFollowUp(id: string, now = Date.now()): boolean {
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      if (!job?.followUp || !["pending", "dispatched"].includes(job.followUp.state)) return false;
      if (Date.parse(job.followUp.expiresAt) > now) return false;
      job.enabled = false;
      job.followUp.state = "unknown";
      job.followUp.unknownReason = "Follow-up expired before a conclusive reply/receipt";
      job.followUp.updatedAt = new Date().toISOString();
      job.lastStatus = "unknown";
      return true;
    });
  }

  removeJob(id: string): boolean {
    return this.mutate(store => {
      const count = store.jobs.length;
      store.jobs = store.jobs.filter(job => job.id !== id);
      return store.jobs.length !== count;
    });
  }

  findFollowUp(binding: { ownerSessionId: string; intercomSessionId: string; peerSessionId: string; messageId: string }): CronJob | undefined {
    return this.load().jobs.find(job => {
      const followUp = job.followUp;
      return followUp?.version === 1
        && followUp.ownerSessionId === binding.ownerSessionId
        && followUp.intercomSessionId === binding.intercomSessionId
        && followUp.peerSessionId === binding.peerSessionId
        && followUp.messageId === binding.messageId;
    });
  }

  findActiveFollowUpByCoverage(ownerSessionId: string, coveredBy: string): CronJob | undefined {
    return this.load().jobs.find(job => job.followUp?.version === 1 && job.followUp.ownerSessionId === ownerSessionId && job.followUp.coveredBy === coveredBy && job.enabled && ["pending", "dispatched"].includes(job.followUp.state));
  }

  updateFollowUp(id: string, update: Partial<NonNullable<CronJob["followUp"]>>): boolean {
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      const followUp = job?.followUp;
      if (followUp?.version !== 1) return false;
      Object.assign(followUp, update, { updatedAt: new Date().toISOString() });
      return true;
    });
  }

  updateJob(id: string, partial: Partial<CronJob>): boolean {
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      if (!job) return false;
      const configKeys = ["name", "schedule", "prompt", "enabled", "model", "notify", "extensions", "skills", "session", "maxRuns", "expiresAt", "maxRunsPerDay", "catchUp", "github", "durable", "deadlineMs", "quietOnNoChange", "noChangeThreshold", "quietForMs"];
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
