import type { NativeRunSnapshot } from "./native.js";
import { requiresReconciliation, spentOnUtcDay } from "./resilient-policy.js";
import type { JobStatusOptions, ScheduleJobStatus } from "./status.js";
import type { ResilientJob } from "./types.js";

/** Bounded read-only projection. Native activity is not business progress or permission to admit. */
export function summarizeResilient(job: ResilientJob, options: JobStatusOptions): ScheduleJobStatus {
  const slot = job.runtime.slot;
  const attempt = slot.kind === "owned" ? slot.attempt : undefined;
  const last = job.attemptHistory.at(-1);
  const unresolved = requiresReconciliation(job);
  const expired = Date.parse(job.expiresAt!) <= Date.now() || job.attemptCount! >= job.maxRuns!;
  const day = new Date().toISOString().slice(0, 10);
  const dayLimited = job.maxRunsPerDay !== undefined && spentOnUtcDay(job, day) >= job.maxRunsPerDay;
  const raw = options.nativeSnapshot?.(job.id);
  const snapshot: NativeRunSnapshot | undefined = attempt && raw && raw.binding.jobId === job.id && raw.binding.attemptId === attempt.id && raw.binding.ownerEpoch === attempt.owner.epoch && raw.binding.revision === attempt.revision && raw.binding.ownerSessionId === (attempt.nativeSessionId ?? attempt.owner.sessionId) && (!attempt.nativeRunId || raw.runId === attempt.nativeRunId) ? raw : undefined;
  const waitingCondition = attempt ? (slot.reason ?? (attempt.nativeRunId ? "exact_resource_close_ack_required" : "native_acceptance_unconfirmed")) : !job.enabled ? "user_disabled" : unresolved ? "exact_checkpoint_effect_evidence_required" : expired ? "authorization_bound" : slot.phase === "waiting-input" ? "user_input_required" : slot.phase === "attention-required" ? slot.reason ?? "runtime_attention_required" : dayLimited ? "utc_daily_attempt_limit" : job.runtime.notBefore && Date.parse(job.runtime.notBefore) > Date.now() ? "persisted_cooldown" : slot.reason ?? slot.phase;
  const next = options.nextRun?.(job.id);
  const eligiblePhase = slot.kind === "idle" && ["waiting", "backoff"].includes(slot.phase);
  return {
    id: job.id.slice(0, 128), name: job.name.slice(0, 128), type: job.type, enabled: job.enabled,
    operationalState: job.enabled ? unresolved ? "blocked-unknown" : "enabled" : unresolved ? "disabled-unknown" : "disabled",
    ...(job.lastStatus ? { lastStatus: job.lastStatus } : {}), ...(job.lastRun ? { lastRun: job.lastRun } : {}),
    ...(job.enabled && !unresolved && !expired && eligiblePhase && next ? { nextRun: next.toISOString() } : {}),
    expiresAt: job.expiresAt, runCount: job.runCount, attemptCount: job.attemptCount,
    waitingReason: waitingCondition.slice(0, 128),
    resilient: {
      mode: job.type === "cron" ? "cron" : job.policy.intervalMode!, phase: slot.phase,
      ...(slot.reason ? { reason: slot.reason.slice(0, 128) } : {}),
      overlapPolicy: job.policy.overlapPolicy, misfirePolicy: job.policy.misfirePolicy, latenessMs: job.policy.latenessMs,
      ...(job.policy.timezone ? { timezone: job.policy.timezone } : {}),
      ...(job.runtime.nextEligibleAt ? { nextEligibleAt: job.runtime.nextEligibleAt } : {}), ...(job.runtime.notBefore ? { notBefore: job.runtime.notBefore } : {}),
      ...(job.runtime.continuation ? { continuationAttemptId: job.runtime.continuation.attemptId } : {}),
      ownerEpoch: job.runtime.ownerEpoch, revision: job.revision!, missedCount: job.runtime.missedCount, cooldownStep: job.runtime.cooldownStep,
      ...(attempt ? { attemptId: attempt.id, acceptedRevision: attempt.revision, ownerSessionId: attempt.owner.sessionId, workBudgetMs: attempt.workBudgetMs, deadlineMs: attempt.deadlineMs, ...(attempt.nativeSessionId ? { nativeSessionId: attempt.nativeSessionId } : {}), ...(attempt.nativeRunId ? { nativeRunId: attempt.nativeRunId } : {}), ...(attempt.nativeDeadlineAt ? { nativeDeadlineAt: attempt.nativeDeadlineAt } : {}) } : {}),
      ...(last ? { lastAttempt: { id: last.id, execution: last.outcome, effectStatus: last.effectStatus, businessOutcome: "unverified" as const }, ...(last.modelSdkClose ? { sdkCloseAt: last.modelSdkClose.closedAt } : {}) } : {}),
      ...(job.runtime.legacyUncertainty?.claimId && job.claim ? { legacyClaim: { id: job.runtime.legacyUncertainty.claimId, binding: job.claim.binding, outcome: job.runtime.legacyUncertainty.status, ...(job.runtime.legacyFutureAfter ? { futureAfter: job.runtime.legacyFutureAfter } : {}) } } : {}),
      ...(snapshot ? { native: { phase: snapshot.phase, nativeClosed: snapshot.nativeClosed, ownedHandles: snapshot.ownedHandles.slice(0, 16).map(id => id.slice(0, 128)), requestCount: snapshot.requestCount, retryCount: snapshot.retryCount, failedRecoveryMs: snapshot.failedRecoveryMs, providerPhase: snapshot.providerPhase } } : {}),
      businessOutcome: "unverified",
    },
    reconciliation: attempt ? "native-closure-required" : unresolved ? "unknown-needs-external-reconciliation" : "not-required",
    ...(attempt ? { reconciliationReason: "Owned native/SDK resources have not acknowledged exact closure; age, PID absence and an earlier receipt never release this slot." } : unresolved ? { reconciliationReason: "Retained checkpoint/effect uncertainty requires exact owner evidence; status is not permission to replay." } : {}),
  };
}
