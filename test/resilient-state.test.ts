import { fork } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inheritLegacyBudget } from "../src/legacy-lineage.js";
import { requiresReconciliation, resilientDefinition, validateResilientJob } from "../src/resilient-policy.js";
import { CronStorage } from "../src/storage.js";
import type { CronJob, NativeCheckpointReference, NativeExecutionProof, OwnedAttempt, ResilientJob, ResilientPolicy, TimedOccurrence } from "../src/types.js";

const ownedDirs: string[] = [];
const root = path.resolve("tmp/resilient-state-fixtures");
const seed = (extra: Partial<CronJob> = {}, policy: Partial<ResilientPolicy> = {}): ResilientJob => resilientDefinition({ id: "job", name: "job", type: "interval", schedule: "1s", intervalMs: 1000, prompt: "authorized synthetic work", enabled: true, createdAt: new Date().toISOString(), runCount: 0, attemptCount: 0, session: "owner", maxRuns: 20, maxRunsPerDay: 10, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), deadlineMs: 10_000, ...extra }, { intervalMode: "fixed-rate", workBudgetMs: 5000, latenessMs: 10_000, ...policy });
function fixture(jobs: CronJob[] = [seed()], version = 4) {
  fs.mkdirSync(root, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(root, "case-")); ownedDirs.push(cwd);
  const storage = new CronStorage(cwd);
  fs.mkdirSync(path.dirname(storage.getStorePath()), { mode: 0o700 });
  // Deliberate synthetic schema4 input. No production migration or live store is touched.
  fs.writeFileSync(storage.getStorePath(), JSON.stringify({ version, jobs }, null, 2), { mode: 0o600 });
  return { cwd, storage };
}
function occurrence(job: ResilientJob, id = "tick-1", dueAt = new Date().toISOString()): TimedOccurrence { return { id, dueAt, revision: job.revision!, source: "timer" }; }
function reserve(storage: CronStorage, id = "job", instance = "instance-a"): { job: ResilientJob; attempt: OwnedAttempt } {
  const job = storage.getJob(id) as ResilientJob;
  const tick = occurrence(job, "tick-" + job.runtime.ownerEpoch);
  storage.queueResilient(id, job.session!, tick);
  const claimed = storage.reserveResilient(id, job.session!, instance, job.revision!, tick.id);
  if (claimed?.runtime.slot.kind !== "owned") throw new Error("No synthetic reservation");
  return { job: claimed, attempt: claimed.runtime.slot.attempt };
}
function evidence(storage: CronStorage, attempt: OwnedAttempt, outcome: NativeExecutionProof["execution"] = "completed", effectStatus: NativeExecutionProof["effectStatus"] = "none-observed", id = "job") {
  const runId = "run-" + attempt.id;
  const sessionId = attempt.nativeSessionId ?? attempt.owner.sessionId;
  const startedAt = new Date().toISOString();
  expect(storage.bindResilientNative(id, attempt.id, attempt.owner, { runId, sessionId, startedAt, deadlineAt: new Date(Date.now() + attempt.deadlineMs).toISOString() })).toBe(true);
  const checkpoint: NativeCheckpointReference = { runId, sessionId, entryId: "entry-" + attempt.id, sessionFile: "/synthetic/" + sessionId + ".jsonl" };
  const proof: NativeExecutionProof = { version: 1, runId, binding: { jobId: id, attemptId: attempt.id, ownerSessionId: sessionId, ownerEpoch: attempt.owner.epoch, revision: attempt.revision }, execution: outcome, finishedAt: new Date().toISOString(), checkpointEntryId: checkpoint.entryId, effectStatus, businessOutcome: "unverified", failedRecoveryMs: 0 };
  return { proof, checkpoint };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-03T10:00:00.000Z")); });
afterEach(() => { vi.useRealTimers(); for (const cwd of ownedDirs.splice(0)) fs.rmSync(cwd, { recursive: true, force: true }); });

describe("versioned resilient store and exact ownership", () => {
  it("keeps schema4 through ordinary mutations and refuses incompatible schema3 bytes", () => {
    const h = fixture(); h.storage.updateJob("job", { description: "metadata" });
    expect(h.storage.load().version).toBe(4);
    const old = fixture([seed()], 3); const bytes = fs.readFileSync(old.storage.getStorePath(), "utf8");
    expect(() => old.storage.getAllJobs()).toThrow(/schema4/);
    expect(fs.readFileSync(old.storage.getStorePath(), "utf8")).toBe(bytes);
  });

  it("refuses invalid policies, finite bounds and inconsistent accounting before overwrite", () => {
    expect(() => seed({ maxRuns: undefined })).toThrow(/finite/);
    expect(() => seed({ session: undefined })).toThrow(/session-bound/);
    expect(() => seed({}, { workBudgetMs: 10_000 })).toThrow(/finite/);
    expect(() => seed({}, { timezone: "UTC" })).toThrow(/Conflicting/);
    const h = fixture(); const data = h.storage.load(); (data.jobs[0] as ResilientJob).attemptCount = 0;
    (data.jobs[0] as ResilientJob).runtime.baselineAttempts = 2;
    fs.writeFileSync(h.storage.getStorePath(), JSON.stringify(data, null, 2));
    const bytes = fs.readFileSync(h.storage.getStorePath(), "utf8");
    expect(() => h.storage.updateJob("job", { description: "must not write" })).toThrow(/spending/);
    expect(fs.readFileSync(h.storage.getStorePath(), "utf8")).toBe(bytes);
  });

  it("reserves at most one owner across storage instances and does not globally lock other jobs", () => {
    const h = fixture([seed(), seed({ id: "other", name: "other" })]);
    const first = reserve(h.storage);
    const second = new CronStorage(h.cwd);
    expect(second.reserveResilient("job", "owner", "instance-b", 1, first.attempt.occurrence.id)).toBeUndefined();
    expect(reserve(second, "other", "instance-b").attempt.owner.instanceId).toBe("instance-b");
    expect(h.storage.getJob("job")?.attemptCount).toBe(1);
  });

  it.each(["draining", "cancelling", "attention-required"] as const)("retains the %s slot regardless of elapsed time or a new process", phase => {
    const h = fixture(); const { attempt } = reserve(h.storage);
    expect(h.storage.markResilientPhase("job", attempt.id, attempt.owner, phase, "synthetic_hold")).toBe(true);
    vi.advanceTimersByTime(86_400_000);
    expect(new CronStorage(h.cwd).reserveResilient("job", "owner", "replacement", 1, attempt.occurrence.id)).toBeUndefined();
    expect((h.storage.getJob("job") as ResilientJob).runtime.slot).toMatchObject({ kind: "owned", phase, attempt: { id: attempt.id } });
  });

  it("rejects foreign owner/revision mutation and never treats configuration updates as a new attempt policy", () => {
    const h = fixture(); const { attempt } = reserve(h.storage);
    expect(() => h.storage.updateJob("job", { enabled: false }, "foreign")).toThrow(/owning session/);
    expect(() => h.storage.updateJob("job", { attemptCount: 0 }, "owner")).toThrow(/exact-owner/);
    expect(h.storage.markResilientPhase("job", attempt.id, { ...attempt.owner, epoch: attempt.owner.epoch - 1 }, "cancelling")).toBe(false);
    h.storage.updateJob("job", { prompt: "future definition", deadlineMs: 20_000 }, "owner");
    const active = (h.storage.getJob("job") as ResilientJob).runtime.slot;
    expect(active).toMatchObject({ kind: "owned", attempt: { revision: 1, deadlineMs: 10_000, workBudgetMs: 5000 } });
    const { proof, checkpoint } = evidence(h.storage, attempt);
    expect(h.storage.settleResilient("job", attempt.id, attempt.owner, proof, checkpoint, { phase: "waiting" })).toBe(true);
    expect(h.storage.getJob("job")).toMatchObject({ revision: 2, attemptCount: 1, deadlineMs: 20_000 });
  });

  it("keeps user enablement and UNKNOWN history separate from native closure", () => {
    const h = fixture(); const { attempt } = reserve(h.storage);
    const { proof, checkpoint } = evidence(h.storage, attempt, "cancelled", "unknown");
    h.storage.settleResilient("job", attempt.id, attempt.owner, proof, checkpoint, { phase: "reconciling", reason: "unknown_effect" });
    const original = h.storage.getJob("job") as ResilientJob;
    expect(original).toMatchObject({ enabled: true, attemptCount: 1, runtime: { slot: { kind: "idle", phase: "reconciling" } }, attemptHistory: [{ outcome: "cancelled", effectStatus: "unknown", businessOutcome: "unverified" }] });
    expect(() => h.storage.setResilientDisposition("job", "owner", { phase: "waiting" })).toThrow(/Reconciliation/);
    expect(h.storage.queueResilient("job", "owner", occurrence(original, "next")).status).toBe("ignored");
    expect(h.storage.getJob("job")?.attemptHistory).toEqual(original.attemptHistory);
  });

  it("does not serially replay an already charged occurrence after its native owner closes", () => {
    const h = fixture(); const first = reserve(h.storage); const completed = evidence(h.storage, first.attempt);
    h.storage.settleResilient("job", first.attempt.id, first.attempt.owner, completed.proof, completed.checkpoint, { phase: "waiting" });
    expect(h.storage.queueResilient("job", "owner", first.attempt.occurrence).status).toBe("duplicate");
    expect(h.storage.reserveResilient("job", "owner", "stale-timer", 1, first.attempt.occurrence.id)).toBeUndefined();
    expect(h.storage.getJob("job")?.attemptCount).toBe(1);
  });

  it("keeps a completed native proof with unknown effects in reconciling until exact evidence resolves it", () => {
    const h = fixture(); const { attempt } = reserve(h.storage); const unknown = evidence(h.storage, attempt, "completed", "unknown");
    expect(h.storage.settleResilient("job", attempt.id, attempt.owner, unknown.proof, unknown.checkpoint, { phase: "waiting" })).toBe(true);
    let row = h.storage.getJob("job") as ResilientJob;
    expect(row).toMatchObject({ lastStatus: "unknown", runtime: { slot: { kind: "idle", phase: "reconciling", reason: "effect_unknown" }, continuation: { attemptId: attempt.id } }, attemptHistory: [{ outcome: "completed", effectStatus: "unknown" }] });
    const next = { ...occurrence(row, "next"), dueAt: new Date().toISOString() };
    expect(h.storage.queueResilient("job", "owner", next).status).toBe("ignored");
    const erasedPointer = structuredClone(row); erasedPointer.runtime.continuation = undefined;
    expect(requiresReconciliation(erasedPointer)).toBe(true);
    expect(h.storage.reconcileResilientAttempt("job", "owner", attempt.id, "a".repeat(64), "continue", ["read-only-scope"])).toBe(true);
    row = h.storage.getJob("job") as ResilientJob;
    expect(row.runtime.slot.phase).toBe("reconciling"); expect(requiresReconciliation(row)).toBe(true);
    expect(h.storage.queueResilient("job", "owner", next).status).toBe("ignored");
    expect(h.storage.reconcileResilientAttempt("job", "owner", attempt.id, "b".repeat(64), "continue")).toBe(true);
    row = h.storage.getJob("job") as ResilientJob;
    expect(row.runtime.continuation).toMatchObject({ attemptId: attempt.id, checkpoint: unknown.checkpoint, evidenceFingerprint: "b".repeat(64) });
    expect(row.runtime.slot).toMatchObject({ kind: "idle", phase: "waiting" }); expect(requiresReconciliation(row)).toBe(false);
    expect(h.storage.queueResilient("job", "owner", next).status).toBe("queued");
  });

  it("does not use evidence for an older attempt to release a currently owned attempt or restore older good evidence", () => {
    const h = fixture(); const first = reserve(h.storage); const unknown = evidence(h.storage, first.attempt, "completed", "unknown");
    h.storage.settleResilient("job", first.attempt.id, first.attempt.owner, unknown.proof, unknown.checkpoint, { phase: "waiting" });
    h.storage.reconcileResilientAttempt("job", "owner", first.attempt.id, "a".repeat(64), "continue");
    h.storage.reconcileResilientAttempt("job", "owner", first.attempt.id, "b".repeat(64), "unknown");
    let row = h.storage.getJob("job") as ResilientJob;
    expect(requiresReconciliation(row)).toBe(true); expect(row.runtime.slot.phase).toBe("reconciling");
    h.storage.settleResilient("job", first.attempt.id, first.attempt.owner, unknown.proof, unknown.checkpoint, { phase: "waiting" });
    row = h.storage.getJob("job") as ResilientJob; expect(requiresReconciliation(row)).toBe(true);
    h.storage.reconcileResilientAttempt("job", "owner", first.attempt.id, "c".repeat(64), "continue");
    const second = reserve(h.storage, "job", "new-instance");
    expect(h.storage.reconcileResilientAttempt("job", "owner", first.attempt.id, "d".repeat(64), "unknown")).toBe(false);
    expect((h.storage.getJob("job") as ResilientJob).runtime.slot).toMatchObject({ kind: "owned", attempt: { id: second.attempt.id } });
  });

  it("effect resolution preserves a user stop and the immutable unknown record", () => {
    const h = fixture(); const first = reserve(h.storage); const unknown = evidence(h.storage, first.attempt, "completed", "unknown");
    h.storage.settleResilient("job", first.attempt.id, first.attempt.owner, unknown.proof, unknown.checkpoint, { phase: "waiting" });
    const history = h.storage.getJob("job")!.attemptHistory;
    h.storage.updateJob("job", { enabled: false }, "owner");
    h.storage.reconcileResilientAttempt("job", "owner", first.attempt.id, "a".repeat(64), "continue");
    const row = h.storage.getJob("job") as ResilientJob;
    expect(row.enabled).toBe(false); expect(row.runtime.slot.phase).toBe("finished"); expect(row.attemptHistory).toEqual(history);
    expect(h.storage.queueResilient("job", "owner", occurrence(row, "next")).status).toBe("ignored");
  });

  it("allows a completed native proof with no observed effects to rearm normally", () => {
    const h = fixture(); const { attempt } = reserve(h.storage); const clean = evidence(h.storage, attempt, "completed", "none-observed");
    expect(h.storage.settleResilient("job", attempt.id, attempt.owner, clean.proof, clean.checkpoint, { phase: "waiting" })).toBe(true);
    const row = h.storage.getJob("job") as ResilientJob;
    expect(row.runtime.continuation).toBeUndefined(); expect(row.runtime.slot).toMatchObject({ kind: "idle", phase: "waiting" });
    expect(h.storage.queueResilient("job", "owner", { ...occurrence(row, "next"), dueAt: new Date().toISOString() }).status).toBe("queued");
  });

  it("accepts exact closure once, retains late evidence and cannot settle a newer epoch", () => {
    const h = fixture(); const first = reserve(h.storage); const old = evidence(h.storage, first.attempt);
    expect(h.storage.settleResilient("job", first.attempt.id, first.attempt.owner, old.proof, old.checkpoint, { phase: "waiting" })).toBe(true);
    const second = reserve(h.storage, "job", "instance-b");
    expect(h.storage.settleResilient("job", first.attempt.id, first.attempt.owner, old.proof, old.checkpoint, { phase: "waiting" })).toBe(false);
    const state = h.storage.getJob("job") as ResilientJob;
    expect(state.runtime.slot).toMatchObject({ kind: "owned", attempt: { id: second.attempt.id } });
    expect(state.attemptHistory).toHaveLength(1); expect(state.attemptResolutions).toHaveLength(1); expect(state.attemptCount).toBe(2);
  });

  it("records real native interrupted execution without treating it as a completed fresh occurrence", () => {
    const h = fixture(); const { attempt } = reserve(h.storage); const { proof, checkpoint } = evidence(h.storage, attempt, "interrupted");
    expect(() => h.storage.settleResilient("job", attempt.id, attempt.owner, proof, checkpoint, { phase: "waiting" })).toThrow(/silently rearmed/);
    expect((h.storage.getJob("job") as ResilientJob).runtime.slot.kind).toBe("owned");
    expect(h.storage.settleResilient("job", attempt.id, attempt.owner, proof, checkpoint, { phase: "attention-required", reason: "native_execution_failed" })).toBe(true);
  });

  it("refunds only a proven native refusal, not a bound or ambiguous execution", () => {
    const h = fixture(); const first = reserve(h.storage);
    expect(h.storage.refuseResilientNative("job", first.attempt.id, first.attempt.owner, "busy")).toBe(true);
    expect(h.storage.getJob("job")).toMatchObject({ enabled: true, attemptCount: 0, dailyUsage: { attempts: 0 }, attemptHistory: [{ outcome: "not-started", charged: false }] });
    const again = h.storage.reserveResilient("job", "owner", "instance-a", 1, first.attempt.occurrence.id)!;
    if (again.runtime.slot.kind !== "owned") throw new Error("Missing reservation");
    evidence(h.storage, again.runtime.slot.attempt);
    expect(h.storage.refuseResilientNative("job", again.runtime.slot.attempt.id, again.runtime.slot.attempt.owner, "busy")).toBe(false);
    expect(h.storage.getJob("job")?.attemptCount).toBe(1);
  });

  it("preserves original limits, UTC spending and immutable history through idle owner transfer", () => {
    const h = fixture([seed({ attemptCount: 4, runCount: 3, maxRuns: 8, dailyUsage: { day: "2026-11-03", attempts: 4 } })]);
    const initial = h.storage.getJob("job") as ResilientJob;
    expect(h.storage.transferResilientOwner("job", "owner", initial.runtime.ownerEpoch, "next-owner")).toBe(true);
    const next = h.storage.getJob("job") as ResilientJob;
    expect(next).toMatchObject({ session: "next-owner", maxRuns: 8, attemptCount: 4, dailyUsage: { attempts: 4 }, expiresAt: initial.expiresAt });
    const active = reserve(h.storage);
    expect(h.storage.transferResilientOwner("job", "next-owner", active.attempt.owner.epoch, "third-owner")).toBe(false);
  });

  it("removal cannot delete live ownership or retained execution evidence", () => {
    const h = fixture(); const { attempt } = reserve(h.storage);
    expect(() => h.storage.removeJob("job", "foreign")).toThrow(/owning session/);
    expect(h.storage.removeJob("job", "owner")).toBe(true);
    expect(h.storage.getJob("job")).toMatchObject({ enabled: false, runtime: { slot: { kind: "owned", attempt: { id: attempt.id } } } });
  });

  it("binds explicit-model native child identity without replacing the logical scheduler owner", () => {
    const h = fixture([seed({ model: "fixture/model" })]); const { attempt } = reserve(h.storage);
    expect(attempt.nativeSessionId).toBe("schedule-" + attempt.id);
    const { proof, checkpoint } = evidence(h.storage, attempt);
    expect(proof.binding.ownerSessionId).not.toBe(attempt.owner.sessionId);
    expect(h.storage.settleResilient("job", attempt.id, attempt.owner, proof, checkpoint, { phase: "waiting" })).toBe(true);
  });

  it("retains the lifetime bound and user intent through skipped ticks and final closure", () => {
    const h = fixture([seed({ maxRuns: 1, maxRunsPerDay: 1 })]); const { attempt } = reserve(h.storage);
    const row = h.storage.getJob("job") as ResilientJob;
    h.storage.queueResilient("job", "owner", occurrence(row, "overlap"));
    expect(h.storage.getJob("job")?.attemptCount).toBe(1);
    const { proof, checkpoint } = evidence(h.storage, attempt);
    h.storage.settleResilient("job", attempt.id, attempt.owner, proof, checkpoint, { phase: "finished", reason: "authorization_bound" });
    expect(h.storage.getJob("job")).toMatchObject({ enabled: true, maxRuns: 1, attemptCount: 1, runtime: { slot: { phase: "finished" } } });
    vi.setSystemTime(new Date("2026-11-02T10:00:00.000Z"));
    expect(h.storage.reserveResilient("job", "owner", "new", 1, "overlap")).toBeUndefined();
    expect(h.storage.getJob("job")?.attemptCount).toBe(1);
  });

  it("UTC clock regression cannot replenish a previous day's immutable admission spending", () => {
    const h = fixture([seed({ maxRunsPerDay: 1, expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString() })]);
    const first = reserve(h.storage); const p1 = evidence(h.storage, first.attempt);
    h.storage.settleResilient("job", first.attempt.id, first.attempt.owner, p1.proof, p1.checkpoint, { phase: "waiting" });
    vi.setSystemTime(new Date("2026-11-04T10:00:00.000Z"));
    const second = reserve(h.storage); const p2 = evidence(h.storage, second.attempt);
    h.storage.settleResilient("job", second.attempt.id, second.attempt.owner, p2.proof, p2.checkpoint, { phase: "waiting" });
    vi.setSystemTime(new Date("2026-11-03T10:05:00.000Z"));
    const row = h.storage.getJob("job") as ResilientJob; const tick = occurrence(row, "clock-regressed");
    h.storage.queueResilient("job", "owner", tick);
    expect(h.storage.reserveResilient("job", "owner", "instance-a", row.revision!, tick.id)).toBeUndefined();
    expect(h.storage.getJob("job")).toMatchObject({ attemptCount: 2, dailyUsage: { day: "2026-11-04", attempts: 1 } });
  });

  it("maps only a proven legacy successor chain without replenishing lifetime/daily budget or rewriting UNKNOWN", () => {
    const old: CronJob = { id: "old", name: "old", type: "interval", schedule: "1s", intervalMs: 1000, prompt: "authorized", enabled: false, createdAt: new Date().toISOString(), runCount: 3, attemptCount: 3, maxRuns: 8, maxRunsPerDay: 10, dailyUsage: { day: "2026-11-03", attempts: 3 }, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), deadlineMs: 10_000, session: "owner", durable: true, lastStatus: "unknown", claim: { id: "old-claim", ownerId: "old-instance", ownerPid: 1, sessionId: "owner", binding: "a".repeat(64), phase: "settled", outcome: "unknown", claimedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 10_000).toISOString() }, recovery: { claimId: "old-claim", successorJobId: "job", evidenceFingerprint: "b".repeat(64), resumedAt: new Date().toISOString() } };
    const child: CronJob = { ...structuredClone(old), id: "job", name: "successor", enabled: true, claim: undefined, recovery: undefined, lastStatus: "success", runCount: 2, attemptCount: 2, maxRuns: 5, dailyUsage: { day: "2026-11-03", attempts: 5 } };
    const original = JSON.stringify([old, child]);
    const inherited = inheritLegacyBudget([old, child], "job");
    expect(inherited).toMatchObject({ id: "job", maxRuns: 8, attemptCount: 5, dailyUsage: { attempts: 5 }, legacyLineage: ["old"], expiresAt: old.expiresAt });
    const converted = resilientDefinition(inherited, { intervalMode: "fixed-rate", workBudgetMs: 5000 });
    validateResilientJob(converted, 4);
    const h = fixture([old, converted]);
    const active = reserve(h.storage);
    expect(active.job).toMatchObject({ attemptCount: 6, maxRuns: 8, dailyUsage: { attempts: 6 } });
    expect(h.storage.getJob("old")?.claim).toEqual(old.claim);
    expect(JSON.stringify([old, child])).toBe(original);
    expect(() => inheritLegacyBudget([old, { ...child, maxRuns: 6 }], "job")).toThrow(/bounds changed/);
    expect(() => inheritLegacyBudget([old, { ...child, dailyUsage: { day: "2026-11-03", attempts: 1 } }], "job")).toThrow(/spending was reset/);
    expect(() => inheritLegacyBudget([old, converted], "job")).toThrow(/second time/);
  });

  it("does not clear imported UNKNOWN through unsupported-status, enable or removal updates", () => {
    const job = seed({ enabled: false, lastStatus: "unknown" });
    const h = fixture([job]);
    expect(job.runtime.legacyUncertainty).toMatchObject({ status: "unknown" });
    h.storage.setResilientDisposition("job", "owner", { phase: "attention-required", reason: "runtime_unavailable" });
    expect(() => h.storage.setResilientDisposition("job", "owner", { phase: "waiting" })).toThrow(/Reconciliation/);
    h.storage.updateJob("job", { enabled: true }, "owner");
    const current = h.storage.getJob("job") as ResilientJob;
    expect(h.storage.queueResilient("job", "owner", occurrence(current)).status).toBe("ignored");
    expect(current.attemptCount).toBe(0);
    h.storage.removeJob("job", "owner");
    expect(h.storage.getJob("job")).toMatchObject({ enabled: false, attemptCount: 0, runtime: { legacyUncertainty: { status: "unknown" } } });
  });

  it("two real processes race the existing store lock, and process exit never releases the winner", async () => {
    vi.useRealTimers();
    const h = fixture(); const row = h.storage.getJob("job") as ResilientJob;
    const tick = occurrence(row); const now = Date.now(); h.storage.queueResilient("job", "owner", tick);
    const script = path.join(h.cwd, "race.mjs");
    fs.writeFileSync(script, `import { CronStorage } from ${JSON.stringify(fileURLToPath(new URL("../src/storage.ts", import.meta.url)))};\nconst store = new CronStorage(process.argv[2]);\nprocess.send({ready:true});\nprocess.once('message', () => { let status; try { status = store.reserveResilient('job','owner',process.argv[3],1,'tick-1',Number(process.argv[4])) ? 'owned' : 'held'; } catch (e) { status = e.constructor.name === 'ScheduleStoreBusyError' ? 'busy' : 'error:' + e.message; } process.send({status}, () => process.exit(0)); });\n`);
    fs.mkdirSync(path.join(h.cwd, "home")); fs.mkdirSync(path.join(h.cwd, "os-tmp"));
    const loader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
    const workers = ["worker-a", "worker-b"].map(instance => fork(script, [h.cwd, instance, String(now)], { execArgv: ["--import", loader], stdio: ["ignore", "ignore", "pipe", "ipc"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: path.join(h.cwd, "home"), TMPDIR: path.join(h.cwd, "os-tmp"), TZ: "UTC" } }));
    try {
      const readiness = workers.map(worker => new Promise<void>((resolve, reject) => { worker.once("error", reject); worker.once("message", () => resolve()); worker.once("exit", code => { if (code !== 0) reject(new Error("fixture worker startup failed")); }); }));
      await Promise.all(readiness);
      const results = workers.map(worker => new Promise<string>((resolve, reject) => { worker.once("error", reject); worker.once("message", message => resolve((message as { status: string }).status)); }));
      for (const worker of workers) worker.send("go");
      const statuses = await Promise.all(results);
      expect(statuses.filter(value => value === "owned")).toHaveLength(1);
      expect(statuses.every(value => ["owned", "held", "busy"].includes(value))).toBe(true);
      await Promise.all(workers.map(worker => new Promise<void>(resolve => { if (worker.exitCode !== null) resolve(); else worker.once("exit", () => resolve()); })));
      expect(h.storage.getJob("job")).toMatchObject({ attemptCount: 1, runtime: { slot: { kind: "owned" } } });
    } finally { for (const worker of workers) if (worker.exitCode === null) worker.kill(); }
  }, 15_000);
});
