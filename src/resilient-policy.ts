import { Cron } from "croner";
import { validEventId, validEvidenceFingerprint } from "./events.js";
import { validateLegacyHandover } from "./legacy-lineage.js";
import type { AttemptOwner, AttemptRecord, AttemptResolution, CronJob, ModelSdkCloseProof, NativeCheckpointReference, NativeExecutionProof, OwnedAttempt, ResilientJob, ResilientPolicy, TimedOccurrence } from "./types.js";

const idlePhases = new Set(["waiting", "backoff", "reconciling", "waiting-input", "attention-required", "finished"]);
const ownedPhases = new Set(["running", "draining", "cancelling", "attention-required"]);
const nativeOutcomes = new Set(["completed", "failed", "deferred", "cancelled", "interrupted"]);
const safeInteger = (value: unknown, minimum = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
export const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const reason = (value: unknown): boolean => value === undefined || (typeof value === "string" && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value));

/** The discriminant, not enabled/lastStatus, selects the execution contract. Storage validates the full state. */
export function isResilient(job: CronJob): job is ResilientJob { return job.policy?.mode === "resilient"; }

export function effectiveTimezone(value = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
}

/** Pure definition normalization. Existing spending, user intent, histories and legacy UNKNOWN bytes are retained. */
export function resilientDefinition(job: CronJob, options: Partial<ResilientPolicy> = {}): ResilientJob {
  if ((options.mode !== undefined && options.mode !== "resilient") || (options.version !== undefined && options.version !== 1) || (job.type === "interval" && options.timezone !== undefined) || (job.type === "cron" && options.intervalMode !== undefined)) throw new Error("Conflicting resilient mode/timezone parameters");
  if (!job.session || !["cron", "interval"].includes(job.type) || job.followUp || (job.claim && job.claim.phase !== "settled")) throw new Error("Resilient timing requires a session-bound recurring timed job with quiescent legacy execution");
  const previous = isResilient(job) ? job.policy : undefined;
  const deadlineMs = job.deadlineMs ?? 600_000;
  const policy: ResilientPolicy = {
    mode: "resilient", version: 1,
    anchorAt: new Date(options.anchorAt ?? previous?.anchorAt ?? job.createdAt).toISOString(),
    ...(job.type === "interval" ? { intervalMode: options.intervalMode ?? previous?.intervalMode ?? "fixed-delay" } : { timezone: effectiveTimezone(options.timezone ?? previous?.timezone) }),
    overlapPolicy: options.overlapPolicy ?? previous?.overlapPolicy ?? "skip",
    misfirePolicy: options.misfirePolicy ?? previous?.misfirePolicy ?? (job.catchUp === "latest" ? "latest" : "skip"),
    latenessMs: options.latenessMs ?? previous?.latenessMs ?? 300_000,
    workBudgetMs: options.workBudgetMs ?? previous?.workBudgetMs ?? Math.min(25 * 60_000, Math.floor(deadlineMs * 2 / 3)),
  };
  const uncertain = ["unknown", "running", "dispatched"].includes(job.lastStatus ?? "") || (job.claim && ["unknown", "aborted"].includes(job.claim.outcome ?? "unknown"));
  const result: ResilientJob = {
    ...structuredClone(job), durable: true, deadlineMs, revision: job.revision ?? 1,
    attemptCount: job.attemptCount ?? job.runCount,
    policy,
    runtime: isResilient(job) ? structuredClone(job.runtime) : {
      baselineAttempts: job.attemptCount ?? job.runCount,
      baselineDailyUsage: job.dailyUsage ? { ...job.dailyUsage } : undefined,
      ...(uncertain ? { legacyUncertainty: { status: job.claim?.outcome === "aborted" ? "aborted" as const : "unknown" as const, ...(job.claim ? { claimId: job.claim.id } : {}) } } : {}),
      slot: { kind: "idle", phase: uncertain ? "reconciling" : "waiting", ...(uncertain ? { reason: "historical_unknown" } : {}) },
      ownerEpoch: 1, missedCount: 0, cooldownStep: 0,
    },
    attemptHistory: isResilient(job) ? structuredClone(job.attemptHistory) : [],
    attemptResolutions: isResilient(job) ? structuredClone(job.attemptResolutions) : [],
  };
  validateResilientJob(result, 4);
  return result;
}

/** UTC admission accounting comes from immutable charged attempts plus the preserved legacy baseline. */
export function spentOnUtcDay(job: ResilientJob, day: string): number {
  const active = job.runtime.slot.kind === "owned" ? job.runtime.slot.attempt : undefined;
  return (job.runtime.baselineDailyUsage?.day === day ? job.runtime.baselineDailyUsage.attempts : 0) + job.attemptHistory.filter(record => record.charged && record.admittedAt.slice(0, 10) === day).length + (active?.admittedAt.slice(0, 10) === day ? 1 : 0);
}

export function sameCheckpointReference(a: NativeCheckpointReference | undefined, b: NativeCheckpointReference | undefined): boolean {
  return !!a && !!b && a.sessionId === b.sessionId && a.entryId === b.entryId && a.runId === b.runId && a.sessionFile === b.sessionFile;
}

function latestEffectResolution(job: ResilientJob, attemptId: string | undefined): AttemptResolution | undefined {
  for (let index = job.attemptResolutions.length - 1; index >= 0; index--) {
    const item = job.attemptResolutions[index];
    if (item.attemptId === attemptId && item.disposition !== "native-closure") return item;
  }
  return undefined;
}

/** Execution closure is not effect reconciliation; immutable UNKNOWN, not a caller's waiting projection, owns the barrier. */
export function requiresReconciliation(job: ResilientJob): boolean {
  const old = job.runtime.legacyUncertainty;
  if (old) {
    const latest = latestEffectResolution(job, old.claimId);
    if (!old.claimId || latest?.disposition !== "continue" || latest.legacyClaimBinding !== job.claim?.binding || latest.safeScopes?.length) return true;
  }
  for (const record of job.attemptHistory) {
    if (record.effectStatus !== "unknown") continue;
    const latest = latestEffectResolution(job, record.id);
    if (latest?.disposition !== "continue" || latest.safeScopes?.length || !sameCheckpointReference(latest.checkpoint, record.checkpoint)) return true;
  }
  const continuation = job.runtime.continuation;
  if (!continuation) return false;
  const record = job.attemptHistory.find(item => item.id === continuation.attemptId);
  const latest = latestEffectResolution(job, continuation.attemptId);
  if (!latest && record?.outcome === "deferred" && record.effectStatus === "none-observed") return false;
  return latest?.disposition !== "continue" || !!latest.safeScopes?.length || latest.evidenceFingerprint !== continuation.evidenceFingerprint || !sameCheckpointReference(latest.checkpoint, continuation.checkpoint);
}

function validateOwner(owner: AttemptOwner): void {
  if (!owner || !validEventId(owner.sessionId) || !validEventId(owner.instanceId) || !safeInteger(owner.epoch, 1)) throw new Error("Invalid exact resilient owner");
}

export function validateOccurrence(value: TimedOccurrence): void {
  if (!value || !validEventId(value.id) || !instant(value.dueAt) || !safeInteger(value.revision, 1) || !["timer", "overlap", "misfire", "continuation"].includes(value.source)) throw new Error("Invalid resilient occurrence");
}

function validateCheckpoint(value: NativeCheckpointReference, sessionId: string, runId?: string): void {
  if (!value || value.sessionId !== sessionId || !validEventId(value.entryId) || !validEventId(value.runId) || (runId !== undefined && value.runId !== runId) || (value.sessionFile !== undefined && (typeof value.sessionFile !== "string" || value.sessionFile.length > 2048 || /[\u0000-\u001f\u007f]/.test(value.sessionFile)))) throw new Error("Invalid native checkpoint reference");
}

export function validateModelSdkClose(proof: ModelSdkCloseProof, native: NativeExecutionProof): void {
  if (proof?.version !== 1 || proof.runId !== native.runId || proof.checkpointEntryId !== native.checkpointEntryId || !proof.binding || ["jobId", "attemptId", "ownerSessionId", "ownerEpoch", "revision"].some(key => proof.binding[key as keyof typeof proof.binding] !== native.binding[key as keyof typeof native.binding]) || !instant(proof.closedAt)) throw new Error("Model SDK close acknowledgement must bind the exact native attempt/run/checkpoint");
}

export function validateNativeProof(proof: NativeExecutionProof): void {
  if (proof?.version !== 1 || !validEventId(proof.runId) || !proof.binding || !validEventId(proof.binding.jobId) || !validEventId(proof.binding.attemptId) || !validEventId(proof.binding.ownerSessionId) || !safeInteger(proof.binding.ownerEpoch, 1) || !safeInteger(proof.binding.revision, 1) || !instant(proof.finishedAt) || !nativeOutcomes.has(proof.execution) || !validEventId(proof.checkpointEntryId) || !["none-observed", "unknown"].includes(proof.effectStatus) || proof.businessOutcome !== "unverified" || !Number.isFinite(proof.failedRecoveryMs) || proof.failedRecoveryMs < 0 || (proof.retryNotBefore !== undefined && !instant(proof.retryNotBefore))) throw new Error("Invalid native execution proof");
}

function validateOwned(value: OwnedAttempt, job: ResilientJob): void {
  if (!value || !validEventId(value.id) || !safeInteger(value.revision, 1) || value.revision > (job.revision ?? 1) || !instant(value.admittedAt) || !safeInteger(value.deadlineMs, 1000) || value.deadlineMs > 86_400_000 || !safeInteger(value.workBudgetMs, 1) || value.workBudgetMs >= value.deadlineMs) throw new Error("Invalid admitted resilient attempt");
  validateOwner(value.owner);
  validateOccurrence(value.occurrence);
  if (value.owner.sessionId !== job.session || value.owner.epoch !== job.runtime.ownerEpoch || value.occurrence.revision !== value.revision) throw new Error("Inconsistent resilient ownership/revision");
  if (value.model !== undefined && (typeof value.model !== "string" || !value.model.trim())) throw new Error("Invalid accepted model route");
  if (value.nativeSessionFile !== undefined && (!value.model || typeof value.nativeSessionFile !== "string" || !value.nativeSessionFile || value.nativeSessionFile.length > 2048 || /[\u0000-\u001f\u007f]/.test(value.nativeSessionFile))) throw new Error("Invalid accepted native session file");
  if (value.nativeRunId !== undefined && (!validEventId(value.nativeSessionId) || (!value.model && value.nativeSessionId !== value.owner.sessionId) || !validEventId(value.nativeRunId) || !instant(value.nativeStartedAt) || !instant(value.nativeDeadlineAt) || Date.parse(value.nativeDeadlineAt) - Date.parse(value.nativeStartedAt) !== value.deadlineMs)) throw new Error("Invalid accepted native run budget/binding");
  if (value.nativeRunId === undefined && ((value.nativeSessionId !== undefined && (!value.model || (!value.nativeSessionFile && value.nativeSessionId !== (job.runtime.continuation?.checkpoint.sessionId ?? ("schedule-" + value.id))) || !validEventId(value.nativeSessionId) || !value.nativeSessionId.startsWith("schedule-"))) || value.nativeStartedAt !== undefined || value.nativeDeadlineAt !== undefined || value.checkpoint !== undefined)) throw new Error("Unbound attempt cannot claim native progress; model session identity/file is a reservation, not execution proof");
  if (value.checkpoint) validateCheckpoint(value.checkpoint, value.nativeSessionId!, value.nativeRunId);
}

function validateRecord(record: AttemptRecord, job: ResilientJob): void {
  if (!record || typeof record.charged !== "boolean" || !validEventId(record.id) || !safeInteger(record.revision, 1) || !instant(record.admittedAt) || !instant(record.closedAt) || ![...nativeOutcomes, "unknown", "not-started"].includes(record.outcome) || !reason(record.reason) || !["none-observed", "unknown"].includes(record.effectStatus) || record.businessOutcome !== "unverified") throw new Error("Invalid immutable resilient history");
  validateOwner(record.owner);
  if (record.model !== undefined && (typeof record.model !== "string" || !record.model.trim())) throw new Error("Invalid historical model route");
  validateOccurrence(record.occurrence);
  if (record.owner.epoch > job.runtime.ownerEpoch || record.revision > (job.revision ?? 1) || record.occurrence.revision !== record.revision) throw new Error("Inconsistent historical resilient identity");
  if (record.nativeProof) {
    validateNativeProof(record.nativeProof);
    if (record.modelSdkClose) validateModelSdkClose(record.modelSdkClose, record.nativeProof);
    const binding = record.nativeProof.binding;
    if (binding.jobId !== job.id || binding.attemptId !== record.id || (!record.model && binding.ownerSessionId !== record.owner.sessionId) || binding.ownerEpoch !== record.owner.epoch || binding.revision !== record.revision || record.nativeProof.finishedAt !== record.closedAt || record.nativeProof.execution !== record.outcome || record.nativeProof.effectStatus !== record.effectStatus) throw new Error("Receipt cannot settle a different resilient attempt");
  }
  if (record.checkpoint) validateCheckpoint(record.checkpoint, record.nativeProof?.binding.ownerSessionId ?? record.owner.sessionId, record.nativeProof?.runId);
  if (record.nativeProof && record.checkpoint?.entryId !== record.nativeProof.checkpointEntryId) throw new Error("Native history must retain its exact checkpoint");
  if (record.modelSdkClose && (!record.model || !record.nativeProof)) throw new Error("Model SDK close cannot belong to an inline/unproved attempt");
  if (record.model && record.charged && !record.modelSdkClose) throw new Error("Finalized model attempts require exact persistent SDK close acknowledgement");
  if (record.outcome === "not-started" && (record.charged || record.nativeProof || record.checkpoint || record.effectStatus !== "none-observed")) throw new Error("A native refusal cannot be charged or claim execution");
  if (record.charged && !record.nativeProof) throw new Error("Finalized admitted attempts require an exact native closure proof");
}

/** Validate the store trust boundary before mutation; no cadence defaults are applied while reading legacy bytes. */
export function validateResilientJob(job: CronJob, storeVersion: number): void {
  if (!job.policy || job.policy.mode === "legacy") {
    if (job.policy && Object.keys(job.policy).some(key => key !== "mode")) throw new Error("Legacy policy cannot opt into resilient timing fields");
    if (job.runtime !== undefined || job.attemptHistory !== undefined || job.attemptResolutions !== undefined || job.legacyLineage !== undefined || job.legacyHandovers !== undefined) throw new Error("Resilient state requires an explicit schema4 policy");
    return;
  }
  if (job.policy.mode !== "resilient" || storeVersion !== 4) throw new Error("Resilient jobs require an explicit schema4 migration");
  const value = job as ResilientJob;
  const policy = value.policy;
  if (Object.keys(policy).some(key => !["mode", "version", "intervalMode", "timezone", "anchorAt", "overlapPolicy", "misfirePolicy", "latenessMs", "workBudgetMs"].includes(key))) throw new Error("Unknown resilient policy field");
  const runtime = value.runtime;
  if (policy.version !== 1 || !validEventId(value.id) || !validEventId(value.session) || !value.durable || value.followUp || !["cron", "interval"].includes(value.type) || value.notify === true || !safeInteger(value.maxRuns, 1) || !value.expiresAt || !Number.isFinite(Date.parse(value.expiresAt)) || !instant(policy.anchorAt) || !safeInteger(value.deadlineMs, 1000) || value.deadlineMs > 86_400_000 || !safeInteger(policy.workBudgetMs, 1) || policy.workBudgetMs >= value.deadlineMs || !safeInteger(policy.latenessMs, 1) || policy.latenessMs > 86_400_000 || !["skip", "buffer-one"].includes(policy.overlapPolicy) || !["skip", "latest"].includes(policy.misfirePolicy) || !safeInteger(value.revision, 1)) throw new Error("Invalid finite resilient execution policy");
  if (value.catchUp !== undefined && value.catchUp !== (policy.misfirePolicy === "latest" ? "latest" : "none")) throw new Error("Conflicting catchUp/misfire policy");
  if (value.type === "interval") {
    if (!["fixed-delay", "fixed-rate"].includes(policy.intervalMode ?? "") || policy.timezone !== undefined || !safeInteger(value.intervalMs, 1) || value.intervalMs > 2_147_483_647) throw new Error("Invalid explicit interval mode");
  } else {
    if (policy.intervalMode !== undefined || typeof policy.timezone !== "string" || effectiveTimezone(policy.timezone) !== policy.timezone || value.schedule.trim().split(/\s+/).length !== 6) throw new Error("Cron requires a persisted effective timezone and six fields");
    const cron = new Cron(value.schedule, { paused: true, timezone: policy.timezone }); cron.stop();
  }
  if (!runtime || !safeInteger(runtime.baselineAttempts) || !safeInteger(runtime.ownerEpoch, 1) || !safeInteger(runtime.missedCount) || !safeInteger(runtime.cooldownStep) || runtime.cooldownStep > 5 || !runtime.slot || !Array.isArray(value.attemptHistory) || !Array.isArray(value.attemptResolutions)) throw new Error("Invalid resilient runtime");
  for (const date of [runtime.lastFinishedAt, runtime.nextEligibleAt, runtime.notBefore, runtime.legacyFutureAfter]) if (date !== undefined && !instant(date)) throw new Error("Invalid persisted resilient eligibility");
  if (runtime.pending) { validateOccurrence(runtime.pending); if (runtime.pending.revision !== value.revision) throw new Error("Stale pending occurrence revision"); }
  if (runtime.slot.kind === "owned") {
    if (!ownedPhases.has(runtime.slot.phase) || !reason(runtime.slot.reason)) throw new Error("Invalid owned execution phase");
    validateOwned(runtime.slot.attempt, value);
  } else if (runtime.slot.kind !== "idle" || !idlePhases.has(runtime.slot.phase) || !reason(runtime.slot.reason)) throw new Error("Invalid idle execution disposition");
  if (runtime.slot.kind === "idle" && runtime.slot.phase === "backoff" && !runtime.notBefore) throw new Error("Backoff requires a persisted not-before time");
  const ids = new Set<string>();
  for (const record of value.attemptHistory) { validateRecord(record, value); if (ids.has(record.id)) throw new Error("Duplicate immutable attempt"); ids.add(record.id); }
  const active = runtime.slot.kind === "owned" ? runtime.slot.attempt : undefined;
  if (active && ids.has(active.id)) throw new Error("A finalized attempt cannot own a new execution");
  const charged = value.attemptHistory.filter(record => record.charged);
  if (value.attemptCount !== runtime.baselineAttempts + charged.length + (active ? 1 : 0)) throw new Error("Resilient lifetime spending cannot be reset or double-counted");
  if (runtime.legacyUncertainty && (!["unknown", "aborted"].includes(runtime.legacyUncertainty.status) || (runtime.legacyUncertainty.claimId !== undefined && (!validEventId(runtime.legacyUncertainty.claimId) || runtime.legacyUncertainty.claimId !== value.claim?.id)))) throw new Error("Invalid preserved legacy uncertainty");
  if (value.claim && ["unknown", "aborted"].includes(value.claim.outcome ?? "") && !runtime.legacyUncertainty) throw new Error("Legacy UNKNOWN evidence cannot be discarded");
  if (runtime.baselineDailyUsage && (!/^\d{4}-\d{2}-\d{2}$/.test(runtime.baselineDailyUsage.day) || !safeInteger(runtime.baselineDailyUsage.attempts))) throw new Error("Invalid preserved daily baseline");
  if (value.dailyUsage) {
    const day = value.dailyUsage.day;
    const spent = spentOnUtcDay(value, day);
    if (value.dailyUsage.attempts !== spent) throw new Error("Resilient UTC daily spending cannot be reset or double-counted");
  }
  const resolutionKeys = new Set<string>();
  for (const resolution of value.attemptResolutions) {
    const legacy = value.claim?.phase === "settled" && value.claim.id === resolution.attemptId;
    if ((!ids.has(resolution.attemptId) && !legacy) || !validEvidenceFingerprint(resolution.evidenceFingerprint) || !instant(resolution.at) || !["continue", "waiting-input", "unknown", "native-closure"].includes(resolution.disposition) || (resolution.safeScopes !== undefined && (!Array.isArray(resolution.safeScopes) || resolution.safeScopes.length > 32 || !resolution.safeScopes.every(scope => validEventId(scope))))) throw new Error("Invalid exact-attempt reconciliation");
    if (resolution.resumeAfterMs !== undefined && (legacy || resolution.disposition !== "continue" || !safeInteger(resolution.resumeAfterMs, 1000) || resolution.resumeAfterMs > 86400000)) throw new Error("Invalid retained continuation timing");
    if (legacy && (resolution.legacyClaimBinding !== value.claim?.binding || resolution.checkpoint !== undefined || resolution.disposition === "native-closure")) throw new Error("Legacy resolution must bind its exact retained claim, not a fabricated native checkpoint");
    if (!legacy && resolution.legacyClaimBinding !== undefined) throw new Error("Native resolution cannot claim legacy identity");
    const resolvedRecord = value.attemptHistory.find(item => item.id === resolution.attemptId);
    if (resolvedRecord && resolution.disposition === "continue" && !sameCheckpointReference(resolution.checkpoint, resolvedRecord.checkpoint)) throw new Error("Resolution must bind the exact retained native checkpoint");
    if (resolution.checkpoint !== undefined && (!resolvedRecord?.checkpoint || !sameCheckpointReference(resolution.checkpoint, resolvedRecord.checkpoint))) throw new Error("Reconciliation evidence references a different checkpoint");
    const key = resolution.attemptId + ":" + resolution.evidenceFingerprint;
    if (resolutionKeys.has(key)) throw new Error("Duplicate reconciliation evidence"); resolutionKeys.add(key);
  }
  if (runtime.legacyFutureAfter && (!runtime.legacyUncertainty?.claimId || !value.attemptResolutions.some(item => item.attemptId === runtime.legacyUncertainty!.claimId && item.legacyClaimBinding === value.claim?.binding && item.disposition === "continue" && !item.safeScopes?.length && item.at === runtime.legacyFutureAfter))) throw new Error("Legacy future boundary requires its exact retained whole-claim resolution");
  if (runtime.continuation) {
    const record = value.attemptHistory.find(item => item.id === runtime.continuation!.attemptId);
    if (!record?.checkpoint || JSON.stringify(record.checkpoint) !== JSON.stringify(runtime.continuation.checkpoint) || (runtime.continuation.evidenceFingerprint !== undefined && !validEvidenceFingerprint(runtime.continuation.evidenceFingerprint))) throw new Error("Continuation must consume its exact retained checkpoint");
  }
  if (runtime.slot.kind === "idle" && ["waiting", "backoff"].includes(runtime.slot.phase) && requiresReconciliation(value)) throw new Error("Unresolved effects cannot become eligible through a status change");
  if (value.legacyHandovers !== undefined) {
    if (!Array.isArray(value.legacyHandovers) || value.legacyHandovers.length > 32) throw new Error("Invalid bounded retained handovers");
    const seen = new Set<string>();
    for (const proof of value.legacyHandovers) {
      validateLegacyHandover(proof);
      if (!value.legacyLineage?.includes(proof.predecessorJobId) || (proof.successorJobId !== value.id && !value.legacyLineage.includes(proof.successorJobId)) || seen.has(proof.predecessorJobId)) throw new Error("Retained handover does not belong to the proven lineage");
      seen.add(proof.predecessorJobId);
    }
  }
  if (value.legacyLineage && (!Array.isArray(value.legacyLineage) || new Set(value.legacyLineage).size !== value.legacyLineage.length || value.legacyLineage.includes(value.id) || !value.legacyLineage.every(validEventId))) throw new Error("Invalid proven legacy lineage");
}
