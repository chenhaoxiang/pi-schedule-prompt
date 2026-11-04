import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { dailyLimited, EVENT_KEY_LIMIT, eventBinding, eventKey, eventNames, validateGithub, validEventId, validEventName, validEvidenceFingerprint } from "./events.js";
import { inheritLegacyBudget } from "./legacy-lineage.js";
import { instant, isResilient, requiresReconciliation, resilientDefinition, sameCheckpointReference, spentOnUtcDay, validateModelSdkClose, validateNativeProof, validateOccurrence, validateResilientJob } from "./resilient-policy.js";
import { nextDue, timingView } from "./timing.js";
import { type AttemptOwner, type AttemptRecord, type CronJob, type CronStore, type EventResult, EXECUTION_REASONS, type ExecutionOutcome, type ExecutionReceipt, type LegacyOwnerHandover, type ModelSdkCloseProof, type NativeCheckpointReference, type NativeExecutionProof, type OwnedAttempt, type ProgressOutcome, type ResilientIdlePhase, type ResilientJob, type ResilientPolicy, type TimedOccurrence } from "./types.js";

const STATUSES = new Set(["success", "error", "running", "queued", "dispatched", "unknown", "skipped", "quiet"]);

/** Generic cleanup removes unused definitions, never immutable spending/UNKNOWN/resource evidence. */
export function canCleanupJob(job: CronJob): boolean {
  if (job.enabled || job.recovery || job.lastStatus === "unknown" || (job.claim && job.claim.phase !== "settled") || ["unknown", "aborted"].includes(job.claim?.outcome ?? "") || job.followUp?.state === "unknown") return false;
  return !isResilient(job) || !(job.runtime.slot.kind === "owned" || job.attemptHistory.length || job.attemptResolutions.length || job.runtime.baselineAttempts || job.runtime.legacyUncertainty || job.claim || job.legacyLineage?.length);
}

function validate(store: unknown): asserts store is CronStore {
  if (!store || typeof store !== "object") throw new Error("Invalid schedule store");
  const data = store as CronStore;
  if (![1, 2, 3, 4].includes(data.version) || !Array.isArray(data.jobs)) throw new Error("Unsupported schedule store");
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
    if (claim && (!job.durable || !validEventId(claim.id) || !validEventId(claim.ownerId) || (claim.sessionId !== job.session && !(isResilient(job) && claim.phase === "settled")) || !Number.isSafeInteger(claim.ownerPid) || claim.ownerPid < 1 ||
      !/^[a-f0-9]{64}$/.test(claim.binding) || !["claimed", "dispatched", "started", "settled"].includes(claim.phase) ||
      ![claim.claimedAt, claim.deadlineAt].every(date => Number.isFinite(Date.parse(date))) ||
      (claim.outcome !== undefined && !["success", "error", "aborted", "unknown"].includes(claim.outcome)) ||
      (claim.outcomeReason !== undefined && !EXECUTION_REASONS.includes(claim.outcomeReason)))) throw new Error("Invalid durable claim");
    if (job.notice && (!validEventId(job.notice.claimId) || !["success", "error", "aborted", "unknown"].includes(job.notice.outcome) || (job.notice.reason !== undefined && !EXECUTION_REASONS.includes(job.notice.reason)) || !["pending", "accepted", "failed"].includes(job.notice.state) || !Number.isSafeInteger(job.notice.attempts) || job.notice.attempts < 0 || job.notice.attempts > 3)) throw new Error("Invalid notification state");
    if (job.recovery && (!validEventId(job.recovery.claimId) || !validEventId(job.recovery.successorJobId) || !validEvidenceFingerprint(job.recovery.evidenceFingerprint) || !Number.isFinite(Date.parse(job.recovery.resumedAt)))) throw new Error("Invalid exact-claim recovery");
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
    validateResilientJob(job, data.version);
    if (ids.has(job.id) || names.has(job.name)) throw new Error("Duplicate scheduled job id or name");
    ids.add(job.id);
    names.add(job.name);
  }
  for (const job of data.jobs) {
    if (isResilient(job) && job.legacyLineage?.some(id => !ids.has(id))) throw new Error("Proven legacy lineage must retain its original job rows");
    for (const proof of job.legacyHandovers ?? []) {
      const parent = data.jobs.find(item => item.id === proof.predecessorJobId);
      const child = data.jobs.find(item => item.id === proof.successorJobId);
      if (parent?.claim?.id !== proof.claimId || parent.claim.binding !== proof.claimBinding || parent.claim.sessionId !== proof.fromSessionId || parent.recovery?.successorJobId !== proof.successorJobId || parent.recovery.evidenceFingerprint !== proof.recoveryEvidenceFingerprint || !child || (child.claim ? child.claim.sessionId !== proof.toSessionId : !isResilient(child) && child.session !== proof.toSessionId)) throw new Error("Retained handover no longer matches its original legacy claim/recovery");
    }
  }
  if (data.migration !== undefined && (!data.migration || typeof data.migration !== "object" || data.version !== 4 || ![1, 2, 3].includes(data.migration.fromVersion) || !instant(data.migration.at) || !validEvidenceFingerprint(data.migration.originalSha256) || typeof data.migration.backupRef !== "string" || !/^[A-Za-z0-9._-]{1,200}$/.test(data.migration.backupRef) || [".", ".."].includes(data.migration.backupRef))) throw new Error("Invalid schema4 migration reference");
}

export interface Schema4MigrationPreview {
  sourceVersion: 1 | 2 | 3 | 4;
  targetVersion: 4;
  originalSha256: string;
  storePath: string;
  jobs: Array<{ id: string; name: string; eligible: boolean; reason?: string; enabled: boolean; unknown: boolean; attempts: number }>;
}
export type MigrationRuntimeReadback = { status: "verified"; activeRunIds: string[]; incompatibleWriterIds: string[] } | { status: "unknown"; reason: string };
export interface Schema4MigrationRequest {
  expectedSha256: string;
  policy?: Partial<ResilientPolicy>;
  /** Exact, externally evidenced owner takeovers; omission never infers cross-session lineage. */
  legacyHandovers?: LegacyOwnerHandover[];
  /** Read the affected native handles/loaded writers, never infer quiescence from age, PID absence or a settled JSON field. */
  inspectRuntime: (jobId?: string) => MigrationRuntimeReadback;
}
export interface Schema4MigrationResult { job: ResilientJob; changed: boolean; backupPath?: string; preview: Schema4MigrationPreview; }
export interface SchemaRollbackAssessment {
  currentVersion: number;
  acceptedVersions: number[];
  currentSha256: string;
  formatCompatible: boolean;
  action: "retain-current-bytes" | "hold-incompatible-software-rollback";
  backupRestorationAllowed: false;
  runtimeQuiescence: "not-verified";
  ownedResources: number;
  retainedNativeAttempts: number;
  retainedUnknown: number;
  reason: string;
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

  /** Pure migration preview: no lock, bytes or job state are changed. */
  previewSchema4Migration(): Schema4MigrationPreview {
    const raw = fs.existsSync(this.storePath) ? fs.readFileSync(this.storePath) : Buffer.from(JSON.stringify({ version: 1, jobs: [] }));
    const store = JSON.parse(raw.toString("utf8")) as CronStore;
    validate(store);
    return {
      sourceVersion: store.version as 1 | 2 | 3 | 4, targetVersion: 4,
      originalSha256: createHash("sha256").update(raw).digest("hex"), storePath: this.storePath,
      jobs: store.jobs.map(job => ({ id: job.id, name: job.name, eligible: ["cron", "interval"].includes(job.type), ...(job.type === "cron" || job.type === "interval" ? {} : { reason: "only recurring timed jobs migrate" }), enabled: job.enabled, unknown: ["unknown", "running", "dispatched"].includes(job.lastStatus ?? "") || ["unknown", "aborted"].includes(job.claim?.outcome ?? ""), attempts: job.attemptCount ?? job.runCount })),
    };
  }

  /** Pure rollback/reader-format assessment. It never treats an old backup as the current state. */
  assessSchemaRollback(acceptedVersions: readonly number[] = [1, 2, 3]): SchemaRollbackAssessment {
    if (!acceptedVersions.length || acceptedVersions.some(version => ![1, 2, 3, 4].includes(version)) || new Set(acceptedVersions).size !== acceptedVersions.length) throw new Error("Rollback requires an explicit supported reader schema set");
    const bytes = fs.existsSync(this.storePath) ? fs.readFileSync(this.storePath) : Buffer.from(JSON.stringify({ version: 1, jobs: [] }));
    const store: unknown = JSON.parse(bytes.toString("utf8")); validate(store);
    const formatCompatible = acceptedVersions.includes(store.version);
    return {
      currentVersion: store.version, acceptedVersions: [...acceptedVersions], currentSha256: createHash("sha256").update(bytes).digest("hex"), formatCompatible,
      action: formatCompatible ? "retain-current-bytes" : "hold-incompatible-software-rollback", backupRestorationAllowed: false, runtimeQuiescence: "not-verified",
      ownedResources: store.jobs.filter(job => (job.claim && job.claim.phase !== "settled") || (isResilient(job) && job.runtime.slot.kind === "owned")).length,
      retainedNativeAttempts: store.jobs.reduce((count, job) => count + (isResilient(job) ? job.attemptHistory.length : 0), 0),
      retainedUnknown: store.jobs.filter(job => job.lastStatus === "unknown" || ["unknown", "aborted"].includes(job.claim?.outcome ?? "") || (isResilient(job) && requiresReconciliation(job))).length,
      reason: formatCompatible ? "Reader format is supported; retain current bytes and verify actual loaded capability/writer quiescence separately. This is not software/runtime or business acceptance." : "Target reader rejects the current schema. Keep the schema4-capable runtime (or a separately verified conversion preserving every new attempt/ACK/intent); do not restore an older backup over current activity. Format age, PID absence and backup existence are not closure evidence.",
    };
  }

  /** Explicit format/policy migration after real runtime readback; this API never starts business execution. */
  migrateJobToSchema4(id: string, sessionId: string, request: Schema4MigrationRequest): Schema4MigrationResult {
    if (!validEvidenceFingerprint(request.expectedSha256) || typeof request.inspectRuntime !== "function") throw new Error("Migration requires exact input fingerprint and native-writer readback");
    const preview = this.previewSchema4Migration();
    const existing = this.getJob(id);
    if (!existing || existing.session !== sessionId) throw new Error("Migration requires the owning session");
    if (isResilient(existing)) {
      if (request.legacyHandovers && JSON.stringify(request.legacyHandovers) !== JSON.stringify(existing.legacyHandovers ?? [])) throw new Error("Already resilient with different retained handover evidence");
      const desired = resilientDefinition(existing, request.policy).policy;
      if (Object.keys(desired).some(key => desired[key as keyof ResilientPolicy] !== existing.policy[key as keyof ResilientPolicy])) throw new Error("Already resilient with a different policy; use an explicit definition update");
      return { job: structuredClone(existing), changed: false, preview };
    }
    const backupPath = `${this.storePath}.schema4-${randomUUID()}.bak`;
    const migrated = this.mutate(store => {
      const originalVersion = store.version;
      const job = store.jobs.find(item => item.id === id);
      if (!job || job.session !== sessionId || isResilient(job)) throw new Error("Migration target changed; re-preview");
      // A format change affects every cooperating writer of this store. Later per-job promotion is local.
      const facts = request.inspectRuntime(originalVersion < 4 ? undefined : id);
      if (facts.status !== "verified" || !Array.isArray(facts.activeRunIds) || !Array.isArray(facts.incompatibleWriterIds) || facts.activeRunIds.length || facts.incompatibleWriterIds.length) throw new Error("Migration held: affected native handles/writers are not verified quiescent and compatible");
      const affected = originalVersion < 4 ? store.jobs : [job];
      if (affected.some(item => (item.claim && item.claim.phase !== "settled") || (isResilient(item) && item.runtime.slot.kind === "owned"))) throw new Error("Migration held: store still owns an unsettled execution");
      if (!job.maxRuns || !job.expiresAt) throw new Error("Migration requires finite maxRuns and expiresAt; expiry is preserved, not extended");
      if (job.type === "interval" && request.policy?.intervalMode === undefined) throw new Error("Existing intervals require an explicit fixed-delay/fixed-rate selection");
      if (job.type === "cron" && request.policy?.timezone === undefined) throw new Error("Legacy cron migration requires its observed effective timezone");
      const rebased = inheritLegacyBudget(store.jobs, id, request.legacyHandovers);
      const promoted = resilientDefinition({ ...rebased, revision: (rebased.revision ?? 0) + 1 }, request.policy);
      // Legacy pending ticks are not replay evidence. Their original bytes remain in the private backup.
      promoted.pendingIntent = undefined; promoted.pendingEvent = undefined;
      store.jobs = store.jobs.map(item => item.id === id ? promoted : item);
      if (originalVersion < 4) store.migration = { fromVersion: originalVersion as 1 | 2 | 3, at: new Date().toISOString(), originalSha256: request.expectedSha256, backupRef: path.basename(backupPath) };
      return structuredClone(promoted);
    }, { targetVersion: 4, backupPath, expectedSha256: request.expectedSha256 });
    return { job: migrated, changed: true, backupPath, preview };
  }

  private mutate<T>(change: (store: CronStore) => T, options: { targetVersion?: 4; backupPath?: string; expectedSha256?: string } = {}): T {
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
      const original = fs.existsSync(this.storePath) ? fs.readFileSync(this.storePath) : Buffer.from(JSON.stringify({ version: 1, jobs: [] }));
      if (options.expectedSha256 !== undefined && createHash("sha256").update(original).digest("hex") !== options.expectedSha256) throw new Error("Migration input changed; re-preview without overwriting newer activity");
      const parsed: unknown = JSON.parse(original.toString("utf8"));
      validate(parsed);
      const store = parsed;
      const result = change(store);
      // Never downgrade schema4 into a format an older writer can overwrite.
      store.version = Math.max(3, store.version, options.targetVersion ?? 3);
      validate(store);
      if (options.backupPath) {
        const backup = fs.openSync(options.backupPath, "wx", 0o600);
        try { fs.writeFileSync(backup, original); fs.fsyncSync(backup); } finally { fs.closeSync(backup); }
      }
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

  private owned(job: CronJob | undefined, attemptId: string, owner: AttemptOwner): OwnedAttempt | undefined {
    if (!job || !isResilient(job) || job.runtime.slot.kind !== "owned") return;
    const attempt = job.runtime.slot.attempt;
    return attempt.id === attemptId && attempt.owner.sessionId === owner.sessionId && attempt.owner.instanceId === owner.instanceId && attempt.owner.epoch === owner.epoch ? attempt : undefined;
  }

  /** One bounded occurrence, never a prompt payload. Overlapping ticks do not charge attempts. */
  queueResilient(id: string, sessionId: string, occurrence: TimedOccurrence, nextEligibleAt?: string, now = Date.now()): EventResult {
    validateOccurrence(occurrence);
    if (nextEligibleAt !== undefined && !instant(nextEligibleAt)) throw new Error("Invalid future eligibility");
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      if (!job || !isResilient(job) || job.session !== sessionId || !job.enabled || occurrence.revision !== job.revision) return { status: "ignored", reason: "disabled-or-changed" };
      const runtime = job.runtime;
      if ((runtime.pending?.id === occurrence.id && runtime.pending.revision === occurrence.revision) || (runtime.slot.kind === "owned" && runtime.slot.attempt.occurrence.id === occurrence.id && runtime.slot.attempt.occurrence.revision === occurrence.revision) || job.attemptHistory.some(record => record.charged && record.occurrence.id === occurrence.id && record.occurrence.revision === occurrence.revision)) return { status: "duplicate" };
      if (runtime.slot.kind === "idle" && !["waiting", "backoff"].includes(runtime.slot.phase)) return { status: "ignored", reason: runtime.slot.phase };
      if ((job.expiresAt && Date.parse(job.expiresAt) <= now) || job.attemptCount! >= job.maxRuns!) {
        runtime.pending = undefined; runtime.nextEligibleAt = undefined;
        if (runtime.slot.kind === "idle") runtime.slot = { kind: "idle", phase: "finished", reason: "authorization_bound" };
        return { status: "ignored", reason: "authorization-bound" };
      }
      runtime.nextEligibleAt = nextEligibleAt;
      if (runtime.slot.kind === "owned") {
        if (job.policy.overlapPolicy === "skip" || job.policy.intervalMode === "fixed-delay" || runtime.pending) {
          runtime.missedCount++; return { status: "ignored", reason: "overlap-skipped" };
        }
        runtime.pending = { ...occurrence, source: "overlap" };
        return { status: "queued", reason: "buffered-first" };
      }
      if (runtime.notBefore && Date.parse(runtime.notBefore) > now) { runtime.missedCount++; return { status: "ignored", reason: "not-before" }; }
      if (runtime.pending) return { status: "duplicate" };
      if (occurrence.source === "continuation" && !runtime.continuation) return { status: "ignored", reason: "missing-checkpoint" };
      runtime.pending = { ...occurrence }; job.lastStatus = "queued";
      return { status: "queued" };
    });
  }

  /** Persist timing only; no phase, admission, owner or authorization is inferred from a clock. */
  setResilientEligibility(id: string, sessionId: string, revision: number, nextEligibleAt: string | undefined, discardPending = false): boolean {
    if (nextEligibleAt !== undefined && !instant(nextEligibleAt)) throw new Error("Invalid resilient timing target");
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      if (!job || !isResilient(job) || job.session !== sessionId || job.revision !== revision) return false;
      job.runtime.nextEligibleAt = nextEligibleAt;
      if (discardPending && job.runtime.pending) { job.runtime.pending = undefined; job.runtime.missedCount++; }
      return true;
    });
  }

  /** Atomic provisional admission. Only an explicit native refusal can uncharge this reservation. */
  reserveResilient(id: string, sessionId: string, instanceId: string, revision: number, occurrenceId: string, now = Date.now(), preparedNative?: { model: string; route: string; checkpoint?: NativeCheckpointReference }): ResilientJob | undefined {
    if (!validEventId(instanceId)) throw new Error("Invalid native owner instance");
    if (preparedNative && (!preparedNative.model?.trim() || !preparedNative.route?.trim())) throw new Error("Invalid prepared native model route");
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      if (!job || !isResilient(job) || !job.enabled || job.session !== sessionId || job.revision !== revision || job.runtime.slot.kind !== "idle" || !["waiting", "backoff"].includes(job.runtime.slot.phase)) return;
      if (requiresReconciliation(job)) return;
      if (preparedNative && (job.model !== preparedNative.model || (job.runtime.continuation || preparedNative.checkpoint) && !sameCheckpointReference(job.runtime.continuation?.checkpoint, preparedNative.checkpoint))) return;
      const runtime = job.runtime; const pending = runtime.pending;
      if (!pending || pending.id !== occurrenceId || pending.revision !== revision || Date.parse(pending.dueAt) > now) return;
      if (runtime.legacyFutureAfter && Date.parse(pending.dueAt) <= Date.parse(runtime.legacyFutureAfter)) { runtime.pending = undefined; runtime.missedCount++; return; }
      if (job.attemptHistory.some(record => record.charged && record.occurrence.id === pending.id && record.occurrence.revision === pending.revision)) { runtime.pending = undefined; return; }
      if (now - Date.parse(pending.dueAt) > job.policy.latenessMs) { runtime.pending = undefined; runtime.missedCount++; return; }
      const day = new Date(now).toISOString().slice(0, 10);
      if ((runtime.notBefore && Date.parse(runtime.notBefore) > now) || (job.dailyUsage && day < job.dailyUsage.day) || (job.maxRunsPerDay !== undefined && spentOnUtcDay(job, day) >= job.maxRunsPerDay)) return;
      if (Date.parse(job.expiresAt!) <= now || job.attemptCount! >= job.maxRuns!) {
        runtime.pending = undefined; runtime.nextEligibleAt = undefined; runtime.slot = { kind: "idle", phase: "finished", reason: "authorization_bound" }; return;
      }
      job.dailyUsage = { day, attempts: spentOnUtcDay(job, day) + 1 };
      job.attemptCount!++;
      runtime.ownerEpoch++;
      const attemptId = randomUUID();
      runtime.slot = { kind: "owned", phase: "running", attempt: {
        id: attemptId, revision, owner: { sessionId, instanceId, epoch: runtime.ownerEpoch },
        occurrence: { ...pending }, admittedAt: new Date(now).toISOString(), deadlineMs: job.deadlineMs!, workBudgetMs: job.policy.workBudgetMs,
        ...(job.model ? { model: preparedNative?.route ?? job.model, nativeSessionId: runtime.continuation?.checkpoint.sessionId ?? ("schedule-" + attemptId), ...(runtime.continuation?.checkpoint.sessionFile ? { nativeSessionFile: runtime.continuation.checkpoint.sessionFile } : {}) } : {}),
      } };
      runtime.pending = undefined; runtime.notBefore = undefined;
      if (job.policy.intervalMode === "fixed-delay") runtime.nextEligibleAt = undefined;
      job.lastStatus = "running"; job.lastRun = new Date(now).toISOString();
      return structuredClone(job);
    });
  }

  /** Bind the reserved model transcript before SDK construction can append any entries. No execution is claimed. */
  bindResilientModelFile(id: string, attemptId: string, owner: AttemptOwner, sessionFile: string): boolean {
    if (typeof sessionFile !== "string" || !sessionFile || sessionFile.length > 2048 || /[\u0000-\u001f\u007f]/.test(sessionFile)) throw new Error("Invalid reserved native transcript file");
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id); const attempt = this.owned(job, attemptId, owner);
      if (!attempt?.model || attempt.nativeRunId || (attempt.nativeSessionFile && attempt.nativeSessionFile !== sessionFile)) return false;
      if (store.jobs.some(item => item.id !== id && isResilient(item) && item.runtime.slot.kind === "owned" && item.runtime.slot.attempt.nativeSessionFile === sessionFile)) return false;
      attempt.nativeSessionFile = sessionFile;
      return true;
    });
  }

  bindResilientNative(id: string, attemptId: string, owner: AttemptOwner, native: { runId: string; sessionId: string; sessionFile?: string; startedAt: string; deadlineAt: string }): boolean {
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id); const attempt = this.owned(job, attemptId, owner);
      if (!attempt) return false;
      if (attempt.nativeRunId !== undefined) return attempt.nativeRunId === native.runId && attempt.nativeSessionId === native.sessionId;
      if (attempt.nativeSessionId !== undefined && attempt.nativeSessionId !== native.sessionId) return false;
      if (attempt.nativeSessionFile !== undefined && native.sessionFile !== undefined && attempt.nativeSessionFile !== native.sessionFile) return false;
      attempt.nativeRunId = native.runId; attempt.nativeSessionId = native.sessionId;
      if (native.sessionFile !== undefined) attempt.nativeSessionFile = native.sessionFile;
      attempt.nativeStartedAt = native.startedAt; attempt.nativeDeadlineAt = native.deadlineAt;
      return true;
    });
  }

  /** Draining/cancelling still owns the exact slot. Neither time nor a PID can release it. */
  markResilientPhase(id: string, attemptId: string, owner: AttemptOwner, phase: "draining" | "cancelling" | "attention-required", reason?: string, checkpoint?: NativeCheckpointReference): boolean {
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      const attempt = this.owned(job, attemptId, owner);
      if (!job || !isResilient(job) || !attempt || job.runtime.slot.kind !== "owned") return false;
      if (job.runtime.slot.phase === "cancelling" && phase === "draining") return false;
      job.runtime.slot.phase = phase; job.runtime.slot.reason = reason;
      if (checkpoint) attempt.checkpoint = structuredClone(checkpoint);
      return true;
    });
  }

  /** Only the typed native accepted:false path, never timeout/throw/UNKNOWN, permits a refund. */
  refuseResilientNative(id: string, attemptId: string, owner: AttemptOwner, refusal: "busy" | "disposed" | "user-disabled", now = Date.now()): boolean {
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id); const attempt = this.owned(job, attemptId, owner);
      if (!job || !isResilient(job) || !attempt || attempt.nativeRunId) return false;
      job.attemptHistory.push({ ...structuredClone(attempt), charged: false, closedAt: new Date(now).toISOString(), outcome: "not-started", reason: refusal, effectStatus: "none-observed", businessOutcome: "unverified" });
      job.attemptCount!--;
      if (job.dailyUsage?.day === attempt.admittedAt.slice(0, 10)) job.dailyUsage.attempts--;
      job.runtime.slot = { kind: "idle", phase: refusal === "disposed" ? "attention-required" : "waiting", reason: "native_" + refusal };
      if (refusal === "busy" && job.enabled && job.revision === attempt.revision && now - Date.parse(attempt.occurrence.dueAt) <= job.policy.latenessMs) job.runtime.pending = { ...attempt.occurrence };
      job.lastStatus = "skipped";
      return true;
    });
  }

  /** Exact native closure first; final attempt records are append-only and never become business success. */
  settleResilient(id: string, attemptId: string, owner: AttemptOwner, received: NativeExecutionProof, checkpoint: NativeCheckpointReference, disposition: { phase: ResilientIdlePhase; reason?: string; notBefore?: string; nextEligibleAt?: string }, modelSdkClose?: ModelSdkCloseProof): boolean {
    validateNativeProof(received);
    const proof: NativeExecutionProof = {
      version: 1, runId: received.runId,
      binding: { jobId: received.binding.jobId, attemptId: received.binding.attemptId, ownerSessionId: received.binding.ownerSessionId, ownerEpoch: received.binding.ownerEpoch, revision: received.binding.revision },
      finishedAt: received.finishedAt, execution: received.execution, checkpointEntryId: received.checkpointEntryId,
      effectStatus: received.effectStatus, businessOutcome: "unverified", failedRecoveryMs: received.failedRecoveryMs,
      ...(received.retryNotBefore === undefined ? {} : { retryNotBefore: received.retryNotBefore }),
    };
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      if (!job || !isResilient(job)) return false;
      const attempt = this.owned(job, attemptId, owner);
      if (!attempt) {
        const previous = job.attemptHistory.find(item => item.id === attemptId);
        if (previous?.nativeProof && previous.owner.sessionId === owner.sessionId && previous.owner.instanceId === owner.instanceId && previous.owner.epoch === owner.epoch && previous.nativeProof.runId === proof.runId && previous.nativeProof.binding.ownerSessionId === proof.binding.ownerSessionId && proof.binding.attemptId === attemptId && proof.binding.jobId === id && proof.binding.ownerEpoch === owner.epoch && proof.binding.revision === previous.revision) {
          const fingerprint = createHash("sha256").update(JSON.stringify(proof)).digest("hex");
          if (!job.attemptResolutions.some(item => item.attemptId === attemptId && item.evidenceFingerprint === fingerprint)) job.attemptResolutions.push({ attemptId, evidenceFingerprint: fingerprint, at: proof.finishedAt, disposition: "native-closure" });
        }
        return false;
      }
      if (proof.binding.jobId !== id || proof.binding.attemptId !== attemptId || proof.binding.ownerEpoch !== owner.epoch || proof.binding.revision !== attempt.revision || (attempt.nativeRunId && proof.runId !== attempt.nativeRunId) || proof.binding.ownerSessionId !== (attempt.nativeSessionId ?? owner.sessionId)) return false;
      if (attempt.model) {
        if (!modelSdkClose) throw new Error("A native model receipt cannot release its persistent SDK/file writer without a close acknowledgement");
        validateModelSdkClose(modelSdkClose, proof);
      } else if (modelSdkClose) throw new Error("Inline work cannot claim model SDK close acknowledgement");
      if (disposition.phase === "waiting" && proof.execution !== "completed") throw new Error("Interrupted work cannot be silently rearmed as a fresh occurrence");
      if (disposition.phase === "backoff" && (proof.execution !== "deferred" || proof.effectStatus !== "none-observed" || !disposition.notBefore)) throw new Error("Only known pre-effect deferral can automatically back off");
      const effectUnknown = proof.effectStatus === "unknown";
      const effectivePhase: ResilientIdlePhase = effectUnknown && ["waiting", "backoff", "finished"].includes(disposition.phase) ? "reconciling" : disposition.phase;
      const effectiveReason = effectUnknown && effectivePhase === "reconciling" ? "effect_unknown" : disposition.reason;
      if (effectUnknown && disposition.phase === "backoff") throw new Error("Unknown effect cannot use automatic cooldown before reconciliation");
      const record: AttemptRecord = {
        charged: true, id: attempt.id, revision: attempt.revision, owner: { ...attempt.owner }, occurrence: { ...attempt.occurrence },
        admittedAt: attempt.admittedAt, closedAt: proof.finishedAt, outcome: proof.execution,
        ...(attempt.model ? { model: attempt.model } : {}), ...(disposition.reason ? { reason: disposition.reason } : {}),
        nativeProof: proof, ...(modelSdkClose ? { modelSdkClose: structuredClone(modelSdkClose) } : {}), checkpoint: structuredClone(checkpoint), effectStatus: proof.effectStatus, businessOutcome: "unverified",
      };
      job.attemptHistory.push(record);
      job.runtime.lastFinishedAt = modelSdkClose?.closedAt ?? proof.finishedAt;
      job.runtime.slot = { kind: "idle", phase: effectivePhase, ...(effectiveReason ? { reason: effectiveReason } : {}) };
      job.runtime.notBefore = effectivePhase === "reconciling" ? undefined : disposition.notBefore; job.runtime.nextEligibleAt = effectivePhase === "reconciling" ? undefined : disposition.nextEligibleAt;
      if (proof.execution !== "completed" || effectUnknown || ["reconciling", "waiting-input", "attention-required"].includes(effectivePhase)) {
        job.runtime.pending = undefined;
        job.runtime.continuation = { attemptId, checkpoint: structuredClone(checkpoint) };
      } else { job.runtime.continuation = undefined; job.runtime.cooldownStep = 0; }
      if (effectivePhase === "backoff") job.runtime.cooldownStep = Math.min(5, job.runtime.cooldownStep + 1);
      job.runCount += proof.execution === "completed" ? 1 : 0;
      job.lastStatus = effectUnknown ? "unknown" : proof.execution === "completed" ? "success" : proof.execution === "failed" ? "error" : "unknown";
      return true;
    });
  }

  /** Exact owner evidence is the only transition out of an unknown-effect barrier. */
  reconcileResilientAttempt(id: string, sessionId: string, attemptId: string, evidenceFingerprint: string, disposition: "continue" | "waiting-input" | "unknown", safeScopes: string[] = []): boolean {
    if (!validEvidenceFingerprint(evidenceFingerprint) || !Array.isArray(safeScopes) || safeScopes.length > 32 || !safeScopes.every(scope => validEventId(scope))) throw new Error("Reconciliation requires bounded SHA-256 evidence and safe scopes");
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      if (!job || !isResilient(job) || job.session !== sessionId || job.runtime.slot.kind === "owned") return false;
      const record = job.attemptHistory.find(item => item.id === attemptId);
      if (!record?.checkpoint || !record.nativeProof || !record.charged) return false;
      if (job.runtime.continuation && job.runtime.continuation.attemptId !== attemptId) return false;
      if (record.effectStatus !== "unknown" && job.runtime.continuation?.attemptId !== attemptId) return false;
      const prior = job.attemptResolutions.find(item => item.attemptId === attemptId && item.evidenceFingerprint === evidenceFingerprint);
      if (prior) {
        if (prior.disposition !== disposition || JSON.stringify(prior.safeScopes ?? []) !== JSON.stringify(safeScopes)) throw new Error("Evidence is already bound to a different resolution");
        return false;
      }
      const resolution = { attemptId, evidenceFingerprint, at: new Date().toISOString(), disposition, checkpoint: structuredClone(record.checkpoint), ...(safeScopes.length ? { safeScopes: [...safeScopes] } : {}) };
      job.attemptResolutions.push(resolution);
      if (disposition === "continue") {
        job.runtime.continuation = { attemptId, checkpoint: structuredClone(record.checkpoint), evidenceFingerprint };
        const blocked = requiresReconciliation(job);
        const exhausted = !job.enabled || Date.parse(job.expiresAt!) <= Date.now() || job.attemptCount! >= job.maxRuns!;
        job.runtime.slot = { kind: "idle", phase: blocked ? "reconciling" : exhausted ? "finished" : "waiting", reason: blocked ? "scope_or_effect_unresolved" : exhausted ? "authorization_bound" : "reconciled" };
        job.runtime.nextEligibleAt = undefined;
        const providerNotBefore = record.nativeProof.retryNotBefore;
        if (providerNotBefore && (!job.runtime.notBefore || Date.parse(providerNotBefore) > Date.parse(job.runtime.notBefore))) job.runtime.notBefore = providerNotBefore;
      } else if (disposition === "waiting-input") {
        job.runtime.slot = { kind: "idle", phase: "waiting-input", reason: "reconciled_waiting_input" };
      } else {
        job.runtime.slot = { kind: "idle", phase: "reconciling", reason: "effect_unknown" };
      }
      return true;
    });
  }

  /** Exact migrated-legacy claim evidence permits only future occurrences, without inventing native history. */
  reconcileLegacyClaim(id: string, sessionId: string, claimId: string, claimBinding: string, evidenceFingerprint: string, disposition: "continue" | "waiting-input" | "unknown", safeScopes: string[] = []): boolean {
    if (!validEventId(claimId) || !validEvidenceFingerprint(claimBinding) || !validEvidenceFingerprint(evidenceFingerprint) || !["continue", "waiting-input", "unknown"].includes(disposition) || !Array.isArray(safeScopes) || safeScopes.length > 32 || !safeScopes.every(validEventId)) throw new Error("Legacy reconciliation requires exact claim/binding, SHA-256 effect evidence and bounded scopes");
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      if (!job || !isResilient(job) || job.session !== sessionId || job.runtime.slot.kind === "owned" || job.runtime.continuation) return false;
      const claim = job.claim;
      if (!claim || claim.id !== claimId || claim.binding !== claimBinding || claim.phase !== "settled" || !["unknown", "aborted"].includes(claim.outcome ?? "") || job.runtime.legacyUncertainty?.claimId !== claimId) return false;
      const prior = job.attemptResolutions.find(item => item.attemptId === claimId && item.evidenceFingerprint === evidenceFingerprint);
      if (prior) {
        if (prior.disposition !== disposition || prior.legacyClaimBinding !== claimBinding || JSON.stringify(prior.safeScopes ?? []) !== JSON.stringify(safeScopes)) throw new Error("Evidence is already bound to a different resolution");
        return false;
      }
      // Once a new native attempt exists, legacy evidence cannot retime it or replace native reconciliation.
      if (job.attemptHistory.length) return false;
      const at = new Date().toISOString();
      job.attemptResolutions.push({ attemptId: claimId, legacyClaimBinding: claimBinding, evidenceFingerprint, at, disposition, ...(safeScopes.length ? { safeScopes: [...safeScopes] } : {}) });
      const blocked = requiresReconciliation(job);
      if (disposition === "continue" && !blocked) {
        job.runtime.legacyFutureAfter ??= at;
        job.runtime.pending = undefined;
        const next = nextDue(timingView(job), Date.now()).toISOString();
        job.runtime.nextEligibleAt = next;
        if (!job.runtime.notBefore || Date.parse(job.runtime.notBefore) < Date.parse(next)) job.runtime.notBefore = next;
        job.runtime.slot = { kind: "idle", phase: Date.parse(job.expiresAt!) <= Date.now() || job.attemptCount! >= job.maxRuns! ? "finished" : "backoff", reason: "legacy_future_only" };
      } else job.runtime.slot = { kind: "idle", phase: disposition === "waiting-input" ? "waiting-input" : "reconciling", reason: disposition === "waiting-input" ? "legacy_waiting_input" : "legacy_effect_unresolved" };
      return true;
    });
  }

  /** Explicit owner transfer is idle-only and carries every admission counter/history unchanged. */
  transferResilientOwner(id: string, sessionId: string, expectedEpoch: number, nextSessionId: string): boolean {
    if (!validEventId(nextSessionId)) throw new Error("Invalid next owner session");
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      if (!job || !isResilient(job) || job.session !== sessionId || job.runtime.ownerEpoch !== expectedEpoch || job.runtime.slot.kind === "owned" || job.runtime.continuation || requiresReconciliation(job)) return false;
      job.session = nextSessionId; job.revision!++; job.runtime.ownerEpoch++; job.runtime.pending = undefined; job.runtime.nextEligibleAt = undefined;
      return true;
    });
  }

  /** Metadata-only compatibility/wait state. UNKNOWN cannot be cleared by an unrelated status update. */
  setResilientDisposition(id: string, sessionId: string, disposition: { phase: ResilientIdlePhase; reason?: string; notBefore?: string; nextEligibleAt?: string }): boolean {
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      if (!job || !isResilient(job) || job.session !== sessionId || job.runtime.slot.kind !== "idle") return false;
      const before = job.runtime.slot;
      if (["waiting", "backoff"].includes(disposition.phase) && requiresReconciliation(job)) throw new Error("Reconciliation evidence is required before continuation");
      if (["reconciling", "waiting-input", "attention-required"].includes(before.phase) && ["waiting", "backoff"].includes(disposition.phase) && !["runtime_unavailable", "native_disposed", "native_model_route_unsupported"].includes(before.reason ?? "")) throw new Error("Reconciliation evidence is required before continuation");
      job.runtime.slot = { kind: "idle", phase: disposition.phase, ...(disposition.reason ? { reason: disposition.reason } : {}) };
      job.runtime.notBefore = disposition.notBefore; job.runtime.nextEligibleAt = disposition.nextEligibleAt;
      return true;
    });
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
      if (!job?.durable || isResilient(job) || !job.enabled || job.session !== sessionId) return false;
      job.pendingIntent = { revision: job.revision ?? 0, binding: eventBinding(job), acceptedAt: new Date().toISOString() };
      if (!job.claim || job.claim.phase === "settled") job.lastStatus = "queued";
      job.nextRun = nextRun;
      return true;
    });
  }

  claimJob(id: string, sessionId: string, ownerId: string): CronJob | undefined {
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      if (!job?.durable || isResilient(job) || !job.enabled || job.session !== sessionId ||
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
      if (job.waitingReason === "user_input_required") job.waitingReason = undefined;
      const claimedAt = new Date();
      const deadlineAt = new Date(claimedAt.getTime() + (job.deadlineMs ?? 600000));
      job.claim = { id: randomUUID(), ownerId, ownerPid: process.pid, sessionId, binding: eventBinding(job), phase: "claimed", claimedAt: claimedAt.toISOString(), deadlineAt: deadlineAt.toISOString() };
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
      if (!job?.claim || isResilient(job) || job.claim.id !== claimId || job.claim.phase === "settled") return false;
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
    if (waitingReason !== undefined) job.waitingReason = waitingReason;
    if (progress === undefined) return;
    if (evidenceFingerprint === undefined || !validEvidenceFingerprint(evidenceFingerprint)) return;
    if (progress === "advanced") job.noChangeCount = 0;
    if (progress === "unchanged") job.noChangeCount = (job.noChangeCount ?? 0) + 1;
    job.lastEvidenceFingerprint = evidenceFingerprint;
    if (job.quietOnNoChange && progress === "unchanged" && (job.noChangeCount ?? 0) >= (job.noChangeThreshold ?? 2)) {
      job.quietUntil = new Date(Date.now() + (job.quietForMs ?? 3600000)).toISOString();
      job.lastStatus = "quiet";
    }
  }

  private settleInto(job: CronJob, outcome: ExecutionOutcome, receipt?: ExecutionReceipt): void {
    if (!job.claim || job.claim.phase === "settled") return;
    job.claim.phase = "settled";
    job.claim.outcome = outcome;
    if (receipt?.reason !== undefined) job.claim.outcomeReason = receipt.reason;
    job.lastStatus = outcome === "aborted" ? "unknown" : outcome;
    this.applyProgress(job, receipt?.progress, receipt?.evidenceFingerprint, receipt?.waitingReason);
    if (job.model && outcome === "success") job.runCount += 1;
    job.consecutiveErrors = outcome === "error" ? (job.consecutiveErrors ?? 0) + 1 : outcome === "success" ? 0 : job.consecutiveErrors;
    if (["unknown", "aborted"].includes(outcome) || (job.consecutiveErrors ?? 0) >= 3) job.enabled = false;
    job.notice = { claimId: job.claim.id, outcome, ...(receipt?.reason ? { reason: receipt.reason } : {}), state: "pending", attempts: 0 };
  }

  settleClaim(receipt: ExecutionReceipt): boolean {
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === receipt.jobId);
      if (!job?.claim || isResilient(job) || job.claim.id !== receipt.claimId || job.claim.sessionId !== receipt.sessionId) return false;
      if (receipt.evidenceFingerprint !== undefined && !validEvidenceFingerprint(receipt.evidenceFingerprint)) return false;
      if (receipt.reason !== undefined && !EXECUTION_REASONS.includes(receipt.reason)) return false;
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
      if (!job?.durable || isResilient(job) || job.session !== sessionId || !job.claim || job.claim.phase === "settled") return;
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
      } else this.settleInto(job, "unknown", { jobId: job.id, claimId: claim.id, sessionId, outcome: "unknown", reason: "owner_lost" });
    });
  }

  /** Explicit operator reconciliation permits FUTURE fires, never replays the old claim. */
  resumeFuture(id: string, sessionId: string, claimId: string, evidenceFingerprint: string): { job: CronJob; created: boolean } {
    if (!validEventId(claimId) || !validEvidenceFingerprint(evidenceFingerprint)) throw new Error("resume requires exact claimId and SHA-256 evidenceFingerprint");
    return this.mutate(store => {
      const previous = store.jobs.find(job => job.id === id);
      if (!previous?.durable || isResilient(previous) || previous.session !== sessionId || previous.followUp || !["cron", "interval"].includes(previous.type)) throw new Error("Only the owning session may resume a recurring timed durable job; event/follow-up/one-shot work is not replayable");
      if (previous.claim?.id !== claimId || previous.claim.phase !== "settled" || !["unknown", "aborted"].includes(previous.claim.outcome ?? "")) throw new Error("Expected the exact settled UNKNOWN/aborted claim");
      if (previous.recovery) {
        if (previous.recovery.claimId !== claimId || previous.recovery.evidenceFingerprint !== evidenceFingerprint) throw new Error("This claim was already reconciled with different evidence");
        const existing = store.jobs.find(job => job.id === previous.recovery!.successorJobId);
        if (!existing) throw new Error("Recorded successor is missing; do not recreate or reset its budget");
        return { job: structuredClone(existing), created: false };
      }
      if (previous.enabled) throw new Error("Disable the UNKNOWN job before exact-claim recovery");
      if (store.jobs.some(job => job.claim?.sessionId === sessionId && job.claim.phase !== "settled")) throw new Error("Owning session still has an unsettled claim");
      const spent = previous.attemptCount ?? previous.runCount;
      if (!previous.maxRuns || !previous.expiresAt || Date.parse(previous.expiresAt) <= Date.now() || spent >= previous.maxRuns) throw new Error("Future recovery requires unexpired, finite remaining attempts");
      const successorId = randomUUID();
      const now = new Date().toISOString();
      const successor: CronJob = {
        id: successorId, name: `${previous.name}-resume-${successorId.slice(0, 8)}`,
        type: previous.type, schedule: previous.schedule, intervalMs: previous.intervalMs,
        prompt: previous.prompt + `\n\n[Exact-claim recovery]\nPrevious job ${id}, claim ${claimId} remains UNKNOWN and is retained. Reconciled checkpoint fingerprint: ${evidenceFingerprint}. This is a FUTURE occurrence only: consume saved work, do not replay any previous or UNKNOWN effect. Preserve original authorization and expiry; do not reset the total attempt budget.`,
        enabled: true, createdAt: now, runCount: 0, attemptCount: 0,
        session: sessionId, durable: true, catchUp: "none", deadlineMs: previous.deadlineMs,
        maxRuns: previous.maxRuns - spent, maxRunsPerDay: previous.maxRunsPerDay,
        dailyUsage: previous.dailyUsage ? { ...previous.dailyUsage } : undefined,
        expiresAt: previous.expiresAt, model: previous.model, notify: previous.notify,
        extensions: previous.extensions, skills: previous.skills,
        github: previous.github, recentEventKeys: previous.recentEventKeys,
        quietOnNoChange: previous.quietOnNoChange, noChangeThreshold: previous.noChangeThreshold, quietForMs: previous.quietForMs,
        description: `Future-only continuation of ${id}; old claim ${claimId} retained; no replay.`, revision: 1,
      };
      previous.recovery = { claimId, successorJobId: successorId, evidenceFingerprint, resumedAt: now };
      previous.pendingIntent = undefined;
      previous.pendingEvent = undefined;
      store.jobs.push(successor);
      return { job: structuredClone(successor), created: true };
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
    const resilient = isResilient(job);
    this.mutate(store => {
      if (resilient && store.version !== 4 && fs.existsSync(this.storePath)) throw new Error("Existing stores require explicit schema4 migration after verified native/writer quiescence; use read-only preview first");
      if (store.jobs.some(item => item.id === job.id || item.name === job.name)) {
        throw new Error("A scheduled job with this id or name already exists");
      }
      store.jobs.push({ ...job, revision: job.revision ?? 1 });
    }, resilient ? { targetVersion: 4 } : {});
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

  removeJob(id: string, sessionId?: string): boolean {
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      if (job && !isResilient(job) && (job.recovery || (job.claim && (job.claim.phase !== "settled" || ["unknown", "aborted"].includes(job.claim.outcome ?? ""))) || job.followUp?.state === "unknown")) {
        job.enabled = false; job.pendingIntent = undefined; job.pendingEvent = undefined;
        return true;
      }
      if (job && isResilient(job)) {
        if (job.session !== sessionId) throw new Error("Only the owning session may remove a resilient definition");
        if (job.runtime.slot.kind === "owned" || job.attemptHistory.length || job.attemptResolutions.length || job.runtime.baselineAttempts || job.runtime.legacyUncertainty || job.claim || job.recovery || job.legacyLineage?.length) {
          // Removing future work never deletes immutable evidence or an executor that may still write.
          job.enabled = false; job.runtime.pending = undefined; job.runtime.nextEligibleAt = undefined;
          if (job.runtime.slot.kind === "idle" && ["waiting", "backoff", "finished"].includes(job.runtime.slot.phase)) job.runtime.slot = { kind: "idle", phase: "finished", reason: "user_removed" };
          return true;
        }
      }
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

  updateJob(id: string, partial: Partial<CronJob>, sessionId?: string): boolean {
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      if (!job) return false;
      const configKeys = ["policy", "name", "schedule", "prompt", "enabled", "model", "notify", "extensions", "skills", "session", "maxRuns", "expiresAt", "maxRunsPerDay", "catchUp", "github", "durable", "deadlineMs", "quietOnNoChange", "noChangeThreshold", "quietForMs"];
      const changed = configKeys.some(key => key in partial && JSON.stringify(job[key as keyof CronJob]) !== JSON.stringify(partial[key as keyof CronJob]));
      if (!isResilient(job) && partial.policy?.mode === "resilient") throw new Error("Use explicit state migration to convert a legacy job; spending cannot be reset");
      if (isResilient(job)) {
        const protectedKeys = ["id", "runtime", "attemptHistory", "attemptResolutions", "attemptCount", "dailyUsage", "runCount", "claim", "recovery", "legacyLineage", "legacyHandovers", "session"];
        if (protectedKeys.some(key => key in partial)) throw new Error("Use exact-owner resilient transitions; history, spending and owner cannot be overwritten");
        if (changed && sessionId !== job.session) throw new Error("Only the owning session may change a resilient definition");
        if (partial.policy && partial.policy.mode !== "resilient") throw new Error("Resilient state cannot be downgraded by a configuration update");
        if (job.runtime.continuation && "model" in partial && partial.model !== job.model) throw new Error("Reconcile the existing native checkpoint before changing execution routes");
      }
      Object.assign(job, partial);
      if (changed) { job.revision = (job.revision ?? 0) + 1; job.pendingEvent = undefined; job.pendingIntent = undefined; job.sourceFingerprint = undefined; job.nextRun = undefined; if (isResilient(job)) { job.runtime.pending = undefined; job.runtime.nextEligibleAt = undefined; } }
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
