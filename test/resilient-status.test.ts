import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeRunSnapshot } from "../src/native.js";
import { resilientDefinition } from "../src/resilient-policy.js";
import { summarizeJob } from "../src/status.js";
import type { CronJob, NativeExecutionProof, ResilientJob } from "../src/types.js";

function job(extra: Partial<CronJob> = {}): ResilientJob {
  return resilientDefinition({ id: "job", name: "status", type: "interval", schedule: "1h", intervalMs: 3600000, prompt: "DO_NOT_EXPORT_PRIVATE_PROMPT", enabled: true, createdAt: new Date().toISOString(), runCount: 0, session: "owner", maxRuns: 4, expiresAt: new Date(Date.now() + 86400000).toISOString(), ...extra });
}
function owned() {
  const current = job({ model: "fixture/model" }); current.runtime.ownerEpoch = 2; current.attemptCount = 1;
  current.runtime.slot = { kind: "owned", phase: "draining", reason: "awaiting_sdk_shutdown", attempt: { id: "attempt", revision: 1, owner: { sessionId: "owner", instanceId: "fixture-instance", epoch: 2 }, occurrence: { id: "tick", dueAt: new Date().toISOString(), revision: 1, source: "timer" }, admittedAt: new Date().toISOString(), model: "fixture/model", nativeSessionId: "schedule-child", nativeSessionFile: "/DO_NOT_EXPORT/private.jsonl", nativeRunId: "run", deadlineMs: current.deadlineMs!, workBudgetMs: current.policy.workBudgetMs } };
  const snapshot: NativeRunSnapshot = { runId: "run", binding: { jobId: "job", attemptId: "attempt", ownerSessionId: "schedule-child", ownerEpoch: 2, revision: 1 }, phase: "settled", nativeClosed: true, ownedHandles: [], startedAt: new Date().toISOString(), softDeadlineAt: new Date().toISOString(), hardDeadlineAt: new Date().toISOString(), requestCount: 4, retryCount: 2, failedRecoveryMs: 1234, providerPhase: "unknown" };
  return { current, snapshot };
}
function unknown() {
  const current = job(); current.runtime.ownerEpoch = 2; current.attemptCount = 1; current.lastStatus = "unknown";
  const checkpoint = { runId: "run", sessionId: "owner", entryId: "checkpoint", sessionFile: "/DO_NOT_EXPORT/private.jsonl" };
  const nativeProof: NativeExecutionProof = { version: 1, runId: "run", binding: { jobId: "job", attemptId: "attempt", ownerSessionId: "owner", ownerEpoch: 2, revision: 1 }, finishedAt: new Date().toISOString(), checkpointEntryId: "checkpoint", execution: "completed", effectStatus: "unknown", businessOutcome: "unverified", failedRecoveryMs: 0 };
  current.attemptHistory.push({ charged: true, id: "attempt", revision: 1, owner: { sessionId: "owner", instanceId: "fixture", epoch: 2 }, occurrence: { id: "tick", dueAt: new Date().toISOString(), revision: 1, source: "timer" }, admittedAt: new Date().toISOString(), closedAt: nativeProof.finishedAt, outcome: "completed", nativeProof, checkpoint, effectStatus: "unknown", businessOutcome: "unverified" });
  current.runtime.slot = { kind: "idle", phase: "reconciling", reason: "effect_unknown" }; current.runtime.continuation = { attemptId: "attempt", checkpoint };
  return current;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-04T00:00:00.000Z")); });
afterEach(() => { vi.useRealTimers(); });

describe("bounded resilient status is observation, not closure or business success", () => {
  it("separates a native settled loop from an unacknowledged SDK/file writer and never probes a PID", () => {
    const h = owned(); const ownerAlive = vi.fn(() => false); const before = JSON.stringify(h.current);
    const status = summarizeJob(h.current, { nativeSnapshot: () => h.snapshot, ownerAlive, nextRun: () => new Date(Date.now() + 3600000) });
    expect(status).toMatchObject({ enabled: true, operationalState: "enabled", reconciliation: "native-closure-required", waitingReason: "awaiting_sdk_shutdown", resilient: { mode: "fixed-delay", phase: "draining", attemptId: "attempt", ownerEpoch: 2, acceptedRevision: 1, native: { phase: "settled", nativeClosed: true, requestCount: 4, retryCount: 2, providerPhase: "unknown" }, businessOutcome: "unverified" } });
    expect(status.nextRun).toBeUndefined(); expect(status.resilient?.sdkCloseAt).toBeUndefined(); expect(ownerAlive).not.toHaveBeenCalled(); expect(JSON.stringify(status)).not.toContain("DO_NOT_EXPORT"); expect(JSON.stringify(h.current)).toBe(before);
  });

  it("keeps enabled UNKNOWN blocked and exposes the exact waiting condition instead of a false green next run", () => {
    const current = unknown(); const status = summarizeJob(current, { nextRun: () => new Date(Date.now() + 3600000) });
    expect(status).toMatchObject({ enabled: true, operationalState: "blocked-unknown", reconciliation: "unknown-needs-external-reconciliation", waitingReason: "exact_checkpoint_effect_evidence_required", resilient: { phase: "reconciling", continuationAttemptId: "attempt", lastAttempt: { id: "attempt", execution: "completed", effectStatus: "unknown", businessOutcome: "unverified" } } });
    expect(status.nextRun).toBeUndefined(); expect(JSON.stringify(status)).not.toContain("DO_NOT_EXPORT");
  });

  it("discards unrelated native telemetry and bounds owned-handle metadata without copying payloads", () => {
    const h = owned(); const foreign = summarizeJob(h.current, { nativeSnapshot: () => ({ ...h.snapshot, binding: { ...h.snapshot.binding, attemptId: "foreign" } }) }); expect(foreign.resilient?.native).toBeUndefined();
    h.snapshot.ownedHandles = Array.from({ length: 100 }, (_, index) => index + "x".repeat(500)); const status = summarizeJob(h.current, { nativeSnapshot: () => h.snapshot });
    expect(status.resilient!.native!.ownedHandles).toHaveLength(16); expect(status.resilient!.native!.ownedHandles.every(id => id.length <= 128)).toBe(true);
  });

  it("reports user stop, lifetime/expiry and UTC-day limits independently of host readiness", () => {
    expect(summarizeJob(job({ enabled: false })).waitingReason).toBe("user_disabled");
    expect(summarizeJob(job({ attemptCount: 4 })).waitingReason).toBe("authorization_bound");
    expect(summarizeJob(job({ attemptCount: 1, maxRunsPerDay: 1, dailyUsage: { day: "2026-11-04", attempts: 1 } })).waitingReason).toBe("utc_daily_attempt_limit");
    const current = job(); current.runtime.slot = { kind: "idle", phase: "attention-required", reason: "runtime_unavailable" };
    expect(summarizeJob(current)).toMatchObject({ enabled: true, waitingReason: "runtime_unavailable", reconciliation: "not-required", resilient: { phase: "attention-required", reason: "runtime_unavailable" } });
  });
});
