import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeCapability, NativeRunHandle, NativeRunSnapshot } from "../src/native.js";
import { resilientDefinition } from "../src/resilient-policy.js";
import { MODEL_SDK_CLOSE_ENTRY, planScheduledModel, prepareScheduledModel, readStoredModelSession } from "../src/scheduled-model.js";
import { CronScheduler } from "../src/scheduler.js";
import { CronStorage, ScheduleStoreBusyError } from "../src/storage.js";
import type { CronJob, ModelSdkCloseProof, NativeExecutionProof, ResilientJob, ResilientPolicy } from "../src/types.js";

vi.mock("../src/scheduled-model.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/scheduled-model.js")>(), planScheduledModel: vi.fn(), prepareScheduledModel: vi.fn(), readStoredModelSession: vi.fn() }));

const directories: string[] = [];
const schedulers: CronScheduler[] = [];
const minute = 60_000;
const beginning = Date.parse("2026-11-03T00:00:00.000Z");
function seed(extra: Partial<CronJob> = {}, policy: Partial<ResilientPolicy> = {}) {
  return resilientDefinition({ id: "job", name: "job", type: "interval", schedule: "1h", intervalMs: 60 * minute, prompt: "authorized synthetic goal", enabled: true, createdAt: new Date().toISOString(), runCount: 0, session: "owner", maxRuns: 20, expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), deadlineMs: 180 * minute, ...extra }, { intervalMode: "fixed-delay", workBudgetMs: 150 * minute, latenessMs: 40 * minute, ...policy });
}
function fixture(extra: Partial<CronJob> = {}, policy: Partial<ResilientPolicy> = {}, supported = true) {
  const root = path.resolve("tmp/resilient-scheduler-fixtures"); fs.mkdirSync(root, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(root, "case-")); directories.push(cwd);
  const storage = new CronStorage(cwd); const job = seed(extra, policy);
  fs.mkdirSync(path.dirname(storage.getStorePath()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(storage.getStorePath(), JSON.stringify({ version: 4, jobs: [job] }), { mode: 0o600 });
  const entries = new Map<string, any>();
  const runs: Array<{ request: Parameters<NativeCapability["start"]>[0]; handle: NativeRunHandle; state: NativeRunSnapshot; close: (execution?: NativeExecutionProof["execution"], effectStatus?: NativeExecutionProof["effectStatus"], reason?: string, retryNotBefore?: string) => void }> = [];
  let active: NativeRunHandle | undefined;
  let userBusy = false;
  let refusal: "busy" | "disposed" | "throw" | undefined;
  const capability: NativeCapability = {
    version: 1, get active() { return active; },
    start: vi.fn(request => {
      if (refusal === "throw") throw new Error("synthetic ambiguous start");
      if (refusal) return { accepted: false, reason: refusal };
      if (active) return { accepted: false, reason: "busy" };
      const runId = "run-" + runs.length;
      let resolve!: (proof: NativeExecutionProof & { reason?: string }) => void;
      const settled = new Promise<NativeExecutionProof & { reason?: string }>(done => { resolve = done; });
      const state: NativeRunSnapshot = { runId, binding: { ...request.binding }, phase: "running", startedAt: new Date().toISOString(), softDeadlineAt: new Date(Date.now() + request.policy.softDeadlineMs).toISOString(), hardDeadlineAt: new Date(Date.now() + request.policy.hardDeadlineMs).toISOString(), nativeClosed: false, ownedHandles: [], requestCount: 1, retryCount: 0, failedRecoveryMs: 0, providerPhase: "unknown" };
      const handle: NativeRunHandle = {
        runId, settled, snapshot: () => structuredClone(state),
        checkpoint: vi.fn(declaration => {
          const id = "checkpoint-" + runId;
          const previous = entries.get(id)?.data;
          entries.set(id, { id, type: "custom", customType: "pi.scheduled-checkpoint.v1", data: { version: 1, runId, binding: { ...request.binding }, createdAt: new Date().toISOString(), completedResults: previous?.completedResults ?? [], completedResultCount: previous?.completedResultCount ?? 0, declarations: { ...previous?.declarations, ...declaration }, effectStatus: "none-observed", businessOutcome: "unverified" } });
          state.checkpointEntryId = id; return id;
        }),
        requestDrain: vi.fn(reason => { state.phase = "draining"; state.reason = reason; return true; }),
        requestCancel: vi.fn(reason => { state.phase = "cancelling"; state.reason = reason; return true; }),
        own: vi.fn(),
      };
      active = handle;
      const close = (execution: NativeExecutionProof["execution"] = "completed", effectStatus: NativeExecutionProof["effectStatus"] = "none-observed", reason?: string, retryNotBefore?: string) => {
        const checkpointEntryId = handle.checkpoint();
        entries.get(checkpointEntryId).data.effectStatus = effectStatus;
        const receipt: NativeExecutionProof & { reason?: string } = { version: 1, runId, binding: { ...request.binding }, finishedAt: new Date().toISOString(), execution, effectStatus, checkpointEntryId, businessOutcome: "unverified", failedRecoveryMs: 0, ...(reason ? { reason } : {}), ...(retryNotBefore ? { retryNotBefore } : {}) };
        entries.set("receipt-" + runId, { type: "custom", customType: "pi.scheduled-receipt.v1", data: receipt });
        state.nativeClosed = true; state.phase = "settled"; active = undefined; resolve(receipt);
      };
      runs.push({ request, handle, state, close });
      return { accepted: true, handle };
    }),
  };
  const ctx = { cwd, isIdle: () => !active && !userBusy, hasPendingMessages: () => false, abort: vi.fn(), hasUI: false, modelRegistry: { getAvailable: () => [] }, sessionManager: { getSessionId: () => "owner", getEntries: () => [...entries.values()], getEntry: (id: string) => entries.get(id), getSessionFile: () => path.join(cwd, "native-session.jsonl") }, ...(supported ? { scheduledExecution: capability } : {}) };
  const pi = { sendMessage: vi.fn(), events: { emit: vi.fn() }, appendEntry: vi.fn() };
  function newScheduler() { const scheduler = new CronScheduler(storage, pi as any, ctx as any); schedulers.push(scheduler); return scheduler; }
  return { storage, ctx, pi, runs, entries, capability, newScheduler, row: () => storage.getJob("job") as ResilientJob, busy: (value: boolean) => { userBusy = value; }, refuse: (value?: typeof refusal) => { refusal = value; } };
}
function modelPreparation(h: ReturnType<typeof fixture>) {
  const dispose = vi.fn(async (receipt?: NativeExecutionProof): Promise<ModelSdkCloseProof | undefined> => {
    if (!receipt) return undefined;
    const proof: ModelSdkCloseProof = { version: 1, runId: receipt.runId, binding: { ...receipt.binding }, checkpointEntryId: receipt.checkpointEntryId, closedAt: new Date().toISOString() };
    h.entries.set("sdk-close-" + receipt.runId, { id: "sdk-close-" + receipt.runId, type: "custom", customType: MODEL_SDK_CLOSE_ENTRY, data: proof });
    return proof;
  });
  const child = h.capability;
  h.ctx.scheduledExecution = { version: 1, active: undefined, start: vi.fn(() => { throw new Error("must not dispatch explicit model inline"); }) };
  const readers = new Map<string, any>();
  vi.mocked(planScheduledModel).mockImplementation((_ctx, job) => ({ route: job.model!, ...(job.runtime.continuation ? { checkpoint: structuredClone(job.runtime.continuation.checkpoint) } : {}) }));
  vi.mocked(prepareScheduledModel).mockImplementation(async (_ctx, _job, attempt, _route, bindFile) => {
    expect(h.row().attemptCount).toBeGreaterThan(0);
    const sessionId = attempt.nativeSessionId!;
    const sessionFile = attempt.nativeSessionFile ?? path.join(h.ctx.cwd, ".pi/schedule-native/", sessionId + ".jsonl");
    bindFile(sessionFile);
    const manager = readers.get(sessionId) ?? { ...h.ctx.sessionManager, getSessionId: () => sessionId, getSessionFile: () => sessionFile };
    readers.set(sessionId, manager);
    return { capability: child, sessionManager: manager, dispose };
  });
  vi.mocked(readStoredModelSession).mockImplementation((_cwd, sessionId) => readers.get(sessionId));
  return { dispose, child, readers };
}
const advance = (duration: number) => vi.advanceTimersByTimeAsync(duration);
async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
beforeEach(() => { vi.mocked(planScheduledModel).mockReset(); vi.mocked(prepareScheduledModel).mockReset(); vi.mocked(readStoredModelSession).mockReset(); vi.useFakeTimers(); vi.setSystemTime(beginning); });
afterEach(() => { for (const scheduler of schedulers.splice(0)) scheduler.stop(); vi.unstubAllEnvs(); vi.useRealTimers(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe("resilient native timer composition", () => {
  it("checks actual required tool provenance before restoring a legally reconciled continuation or reserving a new attempt", async () => {
    const h = fixture(); const first = h.newScheduler(); first.start(); await advance(60 * minute + 1000); h.runs[0].close("completed", "unknown"); await flush(); first.stop();
    const original = h.row(); expect(h.storage.reconcileResilientAttempt("job", "owner", original.attemptHistory[0].id, "a".repeat(64), "continue")).toBe(true);
    const before = fs.readFileSync(h.storage.getStorePath());
    vi.stubEnv("PI_SCHEDULE_SERVICE_SESSION", "owner"); vi.stubEnv("PI_SCHEDULE_SERVICE_TOOL_PROFILE", "read-only");
    const pi = h.pi as any; pi.getActiveTools = () => ["find", "grep", "ls", "read"];
    pi.getAllTools = () => ["find", "grep", "ls", "read"].map(name => ({ name, exposure: "direct", sourceInfo: { source: name === "read" ? "sdk" : "builtin", path: "builtin:" + name } }));
    const resumed = h.newScheduler(); resumed.start(); await advance(1000);
    expect(resumed.isRunning()).toBe(false); expect(h.runs).toHaveLength(1); expect(h.capability.start).toHaveBeenCalledTimes(1); expect(h.row().attemptCount).toBe(1);
    expect(fs.readFileSync(h.storage.getStorePath())).toEqual(before); expect(h.row().attemptHistory).toEqual(original.attemptHistory);
  });

  it("rechecks the required registry at final admission so startup success cannot authorize a later override", async () => {
    const h = fixture(); const pi = h.pi as any; let overridden = false;
    pi.getActiveTools = () => ["find", "grep", "ls", "read"];
    pi.getAllTools = () => ["find", "grep", "ls", "read"].map(name => ({ name, exposure: "direct", sourceInfo: { source: overridden && name === "read" ? "sdk" : "builtin", path: "builtin:" + name } }));
    vi.stubEnv("PI_SCHEDULE_SERVICE_SESSION", "owner"); vi.stubEnv("PI_SCHEDULE_SERVICE_TOOL_PROFILE", "read-only");
    const scheduler = h.newScheduler(); scheduler.start(); expect(scheduler.isRunning()).toBe(true); overridden = true;
    await advance(60 * minute + 1000); expect(scheduler.isRunning()).toBe(false); expect(h.capability.start).not.toHaveBeenCalled(); expect(h.runs).toHaveLength(0); expect(h.row().attemptCount).toBe(0);
  });

  it("holds missing/throwing profile metadata before admission and does not apply a service profile to ordinary hosts", async () => {
    const h = fixture(); vi.stubEnv("PI_SCHEDULE_SERVICE_SESSION", "owner"); vi.stubEnv("PI_SCHEDULE_SERVICE_TOOL_PROFILE", "read-only");
    for (const getAllTools of [undefined, () => { throw new Error("synthetic unavailable metadata"); }]) {
      (h.pi as any).getAllTools = getAllTools; const blocked = h.newScheduler(); blocked.start(); await advance(1000); expect(blocked.isRunning()).toBe(false);
    }
    expect(h.row().attemptCount).toBe(0); expect(h.capability.start).not.toHaveBeenCalled();
    vi.unstubAllEnvs(); const ordinary = h.newScheduler(); ordinary.start(); await advance(60 * minute); expect(h.runs).toHaveLength(1);
  });

  it("refuses a missing capability before admission without disabling user intent", async () => {
    const h = fixture({}, {}, false); h.newScheduler().start(); await advance(2 * 60 * minute);
    expect(h.row()).toMatchObject({ enabled: true, attemptCount: 0, runtime: { slot: { kind: "idle", phase: "attention-required", reason: "runtime_unavailable" } } });
    expect(h.pi.sendMessage).not.toHaveBeenCalled(); expect(h.runs).toHaveLength(0);
  });

  it("arms completion+interval after an eighty-minute run on a sixty-minute cadence", async () => {
    const h = fixture(); const scheduler = h.newScheduler(); scheduler.start();
    await advance(60 * minute + 1000); expect(h.runs).toHaveLength(1);
    await advance(80 * minute); expect(h.runs).toHaveLength(1); expect(scheduler.getNextRun("job")).toBeNull();
    h.runs[0].close(); await flush();
    expect(scheduler.getNextRun("job")?.getTime()).toBe(Date.now() + 60 * minute);
    await advance(60 * minute + 1000); expect(h.runs).toHaveLength(2);
    expect(h.ctx.abort).not.toHaveBeenCalled(); expect(h.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("fixed-rate skips busy ticks but retains its original anchored future tick", async () => {
    const h = fixture({}, { intervalMode: "fixed-rate" }); const scheduler = h.newScheduler(); scheduler.start();
    await advance(60 * minute + 1000); await advance(80 * minute);
    expect(h.runs).toHaveLength(1); expect(h.row().runtime.missedCount).toBe(1);
    h.runs[0].close(); await flush();
    expect(scheduler.getNextRun("job")?.getTime()).toBe(beginning + 180 * minute);
    await advance(40 * minute); expect(h.runs).toHaveLength(2);
  });

  it("re-reads a changed cadence instead of firing an old timer target", async () => {
    const h = fixture({}, { intervalMode: "fixed-rate" }); const scheduler = h.newScheduler(); scheduler.start();
    const replacement = new Date(beginning + 3 * 60 * minute).toISOString();
    expect(h.storage.setResilientEligibility("job", "owner", 1, replacement)).toBe(true);
    await advance(60 * minute + 1000);
    expect(h.runs).toHaveLength(0);
    expect(scheduler.getNextRun("job")?.getTime()).toBe(beginning + 3 * 60 * minute);
    await advance(2 * 60 * minute + 1000);
    expect(h.runs).toHaveLength(1);
  });

  it("rearms instead of firing when the captured timer loses its eligibility target", async () => {
    const h = fixture(); const scheduler = h.newScheduler(); scheduler.start();
    expect(h.storage.clearResilientProjection("job", "owner", 1)).toBe(true);
    await advance(60 * minute + 1000);
    expect(h.runs).toHaveLength(0);
    expect(scheduler.getNextRun("job")?.getTime()).toBe(beginning + 120 * minute);
  });

  it("does not let a stale timer re-enter after an exact resilient owner transfer", async () => {
    const h = fixture({}, { intervalMode: "fixed-rate" }); const scheduler = h.newScheduler(); scheduler.start();
    await advance(30 * minute);
    expect(h.storage.transferResilientOwner("job", "owner", 1, "next-owner")).toBe(true);
    const afterTransfer = fs.readFileSync(h.storage.getStorePath());
    const replace = vi.spyOn(h.storage as any, "replaceStore");
    await advance(31 * minute);
    expect(h.runs).toHaveLength(0);
    expect(h.row()).toMatchObject({ session: "next-owner", revision: 2, runtime: { ownerEpoch: 2 } });
    expect(h.row().runtime.nextEligibleAt).toBeUndefined();
    expect(h.row().runtime.pending).toBeUndefined();
    expect(fs.readFileSync(h.storage.getStorePath())).toEqual(afterTransfer);
    expect(replace).not.toHaveBeenCalled();
  });

  it("re-enters against a same-revision replacement target instead of overwriting it", async () => {
    const h = fixture(); const replacement = new Date(beginning + 2 * 60 * minute).toISOString();
    const setEligibility = h.storage.setResilientEligibility.bind(h.storage);
    let raced = false;
    vi.spyOn(h.storage, "setResilientEligibility").mockImplementation((id, sessionId, revision, target, discardPending, expectedRuntime) => {
      if (!raced) {
        raced = true;
        expect(setEligibility(id, sessionId, revision, replacement)).toBe(true);
      }
      return setEligibility(id, sessionId, revision, target, discardPending, expectedRuntime);
    });
    const scheduler = h.newScheduler(); scheduler.start(); await flush();
    expect(raced).toBe(true);
    expect(h.row().runtime.nextEligibleAt).toBe(replacement);
    expect(scheduler.getNextRun("job")?.getTime()).toBe(Date.parse(replacement));
  });

  it("re-enters the current cadence when queue loses a revision race", async () => {
    const h = fixture({}, { intervalMode: "fixed-rate" }); const scheduler = h.newScheduler(); scheduler.start();
    const queueResilient = h.storage.queueResilient.bind(h.storage);
    const queue = vi.spyOn(h.storage, "queueResilient");
    queue.mockImplementation((id, sessionId, occurrence, nextEligibleAt) => {
      const policy = h.row().policy;
      h.storage.updateJob(id, { policy: { ...policy, anchorAt: new Date(beginning + 30 * minute).toISOString() } }, sessionId);
      return queueResilient(id, sessionId, occurrence, nextEligibleAt);
    });
    await advance(60 * minute + 1000);
    expect(queue).toHaveBeenCalledOnce();
    expect(h.row().revision).toBe(2);
    expect(h.row().runtime.nextEligibleAt).toBe(new Date(beginning + 90 * minute).toISOString());
    expect(h.runs).toHaveLength(0);
    await advance(30 * minute + 1000);
    expect(h.runs).toHaveLength(1);
  });

  it("does not let a stale native monitor overwrite a newer owned reason", async () => {
    const h = fixture(); const scheduler = h.newScheduler(); scheduler.start();
    await advance(60 * minute + 1000);
    const attempt = h.row().runtime.slot;
    if (attempt.kind !== "owned") throw new Error("Expected an owned run");
    h.runs[0].state.phase = "draining"; h.runs[0].state.reason = "first_reason";
    await advance(1000);
    expect(h.row().runtime.slot).toMatchObject({ kind: "owned", phase: "draining", reason: "first_reason" });
    h.runs[0].state.reason = "stale_monitor_reason";
    expect(h.storage.markResilientPhase("job", attempt.attempt.id, attempt.attempt.owner, "attention-required", "authoritative_reason", undefined, { phase: "draining", reason: "first_reason", ownerEpoch: attempt.attempt.owner.epoch, attemptId: attempt.attempt.id })).toBe(true);
    await advance(1000);
    expect(h.row().runtime.slot).toMatchObject({ kind: "owned", phase: "attention-required", reason: "authoritative_reason" });
    scheduler.stop();
  });

  it("buffer-one retains the first waiting occurrence and admits only after exact closure", async () => {
    const h = fixture({}, { intervalMode: "fixed-rate", overlapPolicy: "buffer-one" }); h.newScheduler().start();
    await advance(60 * minute + 1000); await advance(80 * minute);
    expect(h.row().runtime.pending?.dueAt).toBe(new Date(beginning + 120 * minute).toISOString());
    expect(h.row().attemptCount).toBe(1); h.runs[0].close(); await flush();
    expect(h.runs).toHaveLength(2); expect(h.row().attemptCount).toBe(2);
  });

  it("expires the first buffered intent rather than replacing it with a later busy tick", async () => {
    const h = fixture({}, { intervalMode: "fixed-rate", overlapPolicy: "buffer-one", latenessMs: 30 * minute }); h.newScheduler().start();
    await advance(60 * minute + 1000); await advance(140 * minute);
    expect(h.row().runtime.pending?.dueAt).toBe(new Date(beginning + 120 * minute).toISOString());
    h.runs[0].close(); await flush();
    expect(h.runs).toHaveLength(1); expect(h.row().attemptCount).toBe(1); expect(h.row().runtime.pending).toBeUndefined();
  });

  it("keeps a completed unknown effect reconciling and never uses normal rearming as replay evidence", async () => {
    const h = fixture(); h.newScheduler().start(); await advance(60 * minute + 1000);
    h.runs[0].close("completed", "unknown"); await flush(); await advance(6 * 60 * minute);
    expect(h.runs).toHaveLength(1); expect(h.row()).toMatchObject({ enabled: true, lastStatus: "unknown", attemptCount: 1, runtime: { slot: { kind: "idle", phase: "reconciling" } } });
  });

  it("retries a same-attempt settlement CAS through receipt-only recovery without a new native action", async () => {
    const h = fixture(); const scheduler = h.newScheduler(); scheduler.start(); await advance(60 * minute + 1000);
    const settle = vi.spyOn(h.storage, "settleResilient"); settle.mockImplementationOnce(() => false).mockImplementationOnce(() => false);
    h.runs[0].close(); await flush();
    expect(settle).toHaveBeenCalledTimes(2);
    expect(h.row()).toMatchObject({ attemptCount: 1, runtime: { slot: { kind: "owned" } }, attemptHistory: [] });
    expect(h.capability.start).toHaveBeenCalledTimes(1);
    h.entries.clear();
    await advance(1000); await flush();
    expect(settle).toHaveBeenCalledTimes(3);
    expect(h.capability.start).toHaveBeenCalledTimes(1);
    expect(h.row()).toMatchObject({ attemptCount: 1, runtime: { slot: { kind: "idle" } }, attemptHistory: [{ outcome: "completed" }] });
  });

  it("retries settlement twice after consecutive CAS losses before recording the exact closure", async () => {
    const h = fixture(); const scheduler = h.newScheduler(); scheduler.start(); await advance(60 * minute + 1000);
    const settle = vi.spyOn(h.storage, "settleResilient"); settle.mockImplementationOnce(() => false).mockImplementationOnce(() => false);
    h.runs[0].close(); await flush();
    expect(settle).toHaveBeenCalledTimes(2);
    expect(h.row()).toMatchObject({ attemptCount: 1, runtime: { slot: { kind: "owned", phase: "running" } } });
    await advance(1000); await flush();
    expect(settle).toHaveBeenCalledTimes(3);
    expect(h.row()).toMatchObject({ attemptCount: 1, runtime: { slot: { kind: "idle" } }, attemptHistory: [{ outcome: "completed" }] });
  });

  it("retains the exact receipt and owner when receipt-only recovery reads a busy store", async () => {
    const h = fixture(); const scheduler = h.newScheduler(); scheduler.start(); await advance(60 * minute + 1000);
    vi.spyOn(h.storage, "settleResilient").mockReturnValue(false);
    const readJob = h.storage.getJob.bind(h.storage);
    let contend = false;
    let injected = false;
    vi.spyOn(h.storage, "getJob").mockImplementation(id => {
      const current = readJob(id);
      if (contend && !injected && current?.runtime && "slot" in current.runtime && current.runtime.slot.kind === "owned") {
        injected = true;
        throw new ScheduleStoreBusyError();
      }
      return current;
    });
    h.runs[0].close(); await flush(); contend = true;
    await advance(1000); await flush();
    expect(h.row()).toMatchObject({ attemptCount: 1, attemptHistory: [], runtime: { slot: { kind: "owned", phase: "running" } } });
    await advance(1000); await flush();
    expect(h.row()).toMatchObject({
      attemptCount: 1,
      attemptHistory: [],
      runtime: { slot: { kind: "owned", phase: "attention-required", reason: "native_settlement_failed", attempt: { id: h.runs[0].request.binding.attemptId, checkpoint: { runId: "run-0" } } } },
    });
    expect(h.capability.start).toHaveBeenCalledOnce(); expect(scheduler.isRunning()).toBe(true);
  });

  it("holds the exact settled owner after bounded settlement CAS failure without replaying work", async () => {
    const h = fixture(); const scheduler = h.newScheduler(); scheduler.start(); await advance(60 * minute + 1000);
    const settle = vi.spyOn(h.storage, "settleResilient"); settle.mockReturnValue(false);
    h.runs[0].close(); await flush();
    expect(settle).toHaveBeenCalledTimes(2);
    expect(h.runs).toHaveLength(1);
    expect(h.row()).toMatchObject({ attemptCount: 1, attemptHistory: [], runtime: { slot: { kind: "owned", phase: "running" } } });
    await advance(1000); await flush();
    expect(settle).toHaveBeenCalledTimes(4);
    expect(h.row()).toMatchObject({
      attemptCount: 1,
      attemptHistory: [],
      runtime: { slot: { kind: "owned", phase: "attention-required", reason: "native_settlement_failed" } },
    });
    expect(h.row().runtime.slot.kind === "owned" && h.row().runtime.slot.attempt.id).toBe(h.runs[0].request.binding.attemptId);
    expect(scheduler.isRunning()).toBe(true);
  });

  it("uses persisted cooldown and Retry-After only after a proven pre-effect native deferral", async () => {
    const h = fixture({ intervalMs: minute, schedule: "1m", deadlineMs: 10 * minute }, { intervalMode: "fixed-rate", workBudgetMs: 5 * minute }); const scheduler = h.newScheduler(); scheduler.start();
    await advance(minute + 1000); const allowed = new Date(Date.now() + 3 * minute).toISOString();
    h.runs[0].close("deferred", "none-observed", "recovery_budget_exhausted", allowed); await flush();
    expect(h.row()).toMatchObject({ enabled: true, runtime: { slot: { phase: "backoff" }, notBefore: allowed, cooldownStep: 1 } });
    expect(scheduler.getNextRun("job")?.getTime()).toBe(beginning + 5 * minute);
    await advance(4 * minute); expect(h.runs).toHaveLength(2); expect(h.runs[1].request.content).toContain("Consume retained checkpoint");
  });

  it("does not postpone a persisted fixed-delay target on repeated restarts", async () => {
    const h = fixture(); const first = h.newScheduler(); first.start(); await advance(10 * minute); const due = first.getNextRun("job")?.getTime(); first.stop();
    const second = h.newScheduler(); second.start(); expect(second.getNextRun("job")?.getTime()).toBe(due); await advance(10 * minute); second.stop();
    const third = h.newScheduler(); third.start(); expect(third.getNextRun("job")?.getTime()).toBe(due); await advance(40 * minute + 1000); expect(h.runs).toHaveLength(1);
  });

  it("retains cancelling ownership until native settlement, never using ctx.abort", async () => {
    const h = fixture({}, { intervalMode: "fixed-rate" }); const scheduler = h.newScheduler(); scheduler.start(); await advance(60 * minute + 1000);
    h.runs[0].handle.requestCancel("hard_deadline"); await advance(2 * 60 * minute);
    expect(h.runs).toHaveLength(1); expect(h.row().runtime.slot).toMatchObject({ kind: "owned", phase: "cancelling" });
    expect(h.ctx.abort).not.toHaveBeenCalled(); scheduler.stop(); expect(h.runs[0].handle.requestCancel).toHaveBeenCalledWith("scheduler_stopped");
    h.runs[0].close("cancelled", "unknown", "hard_deadline"); await flush(); expect(h.row().runtime.slot).toMatchObject({ kind: "idle", phase: "reconciling" });
  });

  it("native accepted:false refunds once while an ambiguous start remains charged and owned", async () => {
    const h = fixture(); h.refuse("busy"); h.newScheduler().start(); await advance(60 * minute + 1000);
    expect(h.row()).toMatchObject({ attemptCount: 0, attemptHistory: [{ outcome: "not-started", charged: false }] });
    h.refuse("throw"); await advance(1000);
    expect(h.row()).toMatchObject({ attemptCount: 1, runtime: { slot: { kind: "owned", phase: "attention-required", reason: "native_start_failed" } } });
    expect(h.runs).toHaveLength(0); expect(h.ctx.abort).not.toHaveBeenCalled();
  });

  it("recovers keepOwned after a store-busy owner snapshot without replaying native work", async () => {
    const h = fixture(); h.refuse("throw");
    const readJob = h.storage.getJob.bind(h.storage);
    let contend = false;
    let injected = false;
    vi.spyOn(h.storage, "getJob").mockImplementation(id => {
      const current = readJob(id);
      if (contend && !injected && current?.runtime && "slot" in current.runtime && current.runtime.slot.kind === "owned") {
        injected = true;
        throw new ScheduleStoreBusyError();
      }
      return current;
    });
    const markPhase = vi.spyOn(h.storage, "markResilientPhase").mockImplementationOnce(() => { throw new ScheduleStoreBusyError(); });
    const scheduler = h.newScheduler(); scheduler.start(); contend = true;
    await advance(60 * minute + 1000); await flush();
    expect(h.row()).toMatchObject({ attemptCount: 1, attemptHistory: [], runtime: { slot: { kind: "owned", phase: "running" } } });
    await advance(1000); await flush();
    expect(h.row()).toMatchObject({ attemptCount: 1, attemptHistory: [], runtime: { slot: { kind: "owned", phase: "running" } } });
    await advance(2000); await flush();
    expect(markPhase).toHaveBeenCalledTimes(2);
    expect(h.row()).toMatchObject({ attemptCount: 1, attemptHistory: [], runtime: { slot: { kind: "owned", phase: "attention-required", reason: "native_start_failed" } } });
    expect(h.runs).toHaveLength(0); expect(h.capability.start).toHaveBeenCalledOnce(); expect(scheduler.isRunning()).toBe(true);
  });

  it("recovers only an exact persisted native receipt when the final store mutation was lost", async () => {
    const h = fixture(); const scheduler = h.newScheduler(); scheduler.start(); await advance(60 * minute + 1000);
    vi.spyOn(h.storage, "settleResilient").mockImplementationOnce(() => { throw new Error("synthetic final write loss"); });
    h.runs[0].close(); await flush(); expect(h.row().runtime.slot).toMatchObject({ kind: "owned", phase: "attention-required" });
    scheduler.stop(); h.newScheduler().start(); await flush();
    expect(h.row()).toMatchObject({ attemptCount: 1, attemptHistory: [{ outcome: "completed" }], runtime: { slot: { kind: "idle", phase: "waiting" } } });
    expect(h.runs).toHaveLength(1);
  });

  it("does not infer execution closure from a missing native owner after reload", async () => {
    const h = fixture(); const scheduler = h.newScheduler(); scheduler.start(); await advance(60 * minute + 1000); scheduler.stop();
    const ctx = { ...h.ctx, scheduledExecution: { ...h.capability, active: undefined } };
    const other = new CronScheduler(h.storage, h.pi as any, ctx as any); schedulers.push(other); other.start();
    expect(h.row().runtime.slot).toMatchObject({ kind: "owned", phase: "attention-required", reason: "native_owner_unconfirmed" });
    expect(h.row().attemptCount).toBe(1); expect(h.runs).toHaveLength(1);
  });

  it("records an input wait through native checkpoint/drain without another model request", async () => {
    const h = fixture(); const scheduler = h.newScheduler(); scheduler.start(); await advance(60 * minute + 1000);
    expect(scheduler.recordScheduledInputRequired("challenge")).toBe(true);
    expect(h.runs[0].handle.requestDrain).toHaveBeenCalledWith("user_input_required");
    h.runs[0].close("deferred", "none-observed", "user_input_required"); await flush();
    expect(h.row().runtime.slot).toMatchObject({ kind: "idle", phase: "waiting-input", reason: "user_input_required" }); expect(h.runs).toHaveLength(1);
  });

  it("updates future cadence and prompt without changing the currently accepted native policy", async () => {
    const h = fixture(); const scheduler = h.newScheduler(); scheduler.start(); await advance(60 * minute + 1000);
    const accepted = structuredClone(h.runs[0].request);
    h.storage.updateJob("job", { schedule: "30m", intervalMs: 30 * minute, prompt: "future synthetic goal" }, "owner");
    scheduler.updateJob("job", h.row());
    expect(h.runs[0].request).toEqual(accepted); expect(h.runs[0].handle.requestCancel).not.toHaveBeenCalled();
    h.runs[0].close(); await flush();
    expect(scheduler.getNextRun("job")?.getTime()).toBe(Date.now() + 30 * minute);
    await advance(30 * minute + 1000); expect(h.runs).toHaveLength(2); expect(h.runs[1].request.content).toBe("future synthetic goal");
  });

  it("runs persisted timezone cron through the native capability rather than a process-local croner", async () => {
    const h = fixture({ type: "cron", schedule: "0 0 9 * * *", intervalMs: undefined }, { intervalMode: undefined, timezone: "Asia/Shanghai" });
    const scheduler = h.newScheduler(); scheduler.start();
    expect(scheduler.getNextRun("job")?.toISOString()).toBe("2026-11-03T01:00:00.000Z");
    await advance(60 * minute + 1000); expect(h.runs).toHaveLength(1); h.runs[0].close(); await flush();
    expect(scheduler.getNextRun("job")?.toISOString()).toBe("2026-11-04T01:00:00.000Z");
  });

  it("restores at most one latest occurrence and never charges an unbounded missed backlog", async () => {
    const h = fixture({}, { intervalMode: "fixed-rate", misfirePolicy: "latest", latenessMs: 10 * minute });
    h.storage.setResilientEligibility("job", "owner", 1, new Date(beginning + 60 * minute).toISOString());
    vi.setSystemTime(beginning + 5 * 60 * minute + 5 * minute); const scheduler = h.newScheduler(); scheduler.start(); await advance(1000);
    expect(h.runs).toHaveLength(1); expect(h.row().attemptCount).toBe(1);
    expect(h.row().runtime.slot).toMatchObject({ kind: "owned", attempt: { occurrence: { source: "misfire", dueAt: new Date(beginning + 5 * 60 * minute).toISOString() } } });
    expect(scheduler.getNextRun("job")?.getTime()).toBe(beginning + 6 * 60 * minute);
  });

  it("preserves latest misfire semantics through startup queue contention", async () => {
    const h = fixture({}, { intervalMode: "fixed-rate", misfirePolicy: "latest", latenessMs: 10 * minute });
    h.storage.setResilientEligibility("job", "owner", 1, new Date(beginning + 60 * minute).toISOString());
    const queue = h.storage.queueResilient.bind(h.storage);
    vi.spyOn(h.storage, "queueResilient").mockImplementationOnce(() => { throw new ScheduleStoreBusyError(); }).mockImplementation(queue);
    vi.setSystemTime(beginning + 65 * minute);
    const scheduler = h.newScheduler(); scheduler.start(); await advance(2000); await flush();
    expect(h.runs).toHaveLength(1);
    expect(h.row().runtime.slot).toMatchObject({ kind: "owned", attempt: { occurrence: { source: "misfire", dueAt: new Date(beginning + 60 * minute).toISOString() } } });
    expect(scheduler.getNextRun("job")?.getTime()).toBe(beginning + 120 * minute);
  });

  it("preserves latest misfire after a startup model hold write contends and the route recovers", async () => {
    const h = fixture({ model: "fixture/model" }, { intervalMode: "fixed-rate", misfirePolicy: "latest", latenessMs: 10 * minute });
    modelPreparation(h);
    let modelAvailable = false;
    vi.mocked(planScheduledModel).mockImplementation((_ctx, job) => {
      if (!modelAvailable) throw new Error("Unknown model 'fixture/model'");
      return { route: job.model! };
    });
    const target = new Date(beginning + 60 * minute).toISOString();
    h.storage.setResilientEligibility("job", "owner", 1, target);
    const writeDisposition = h.storage.setResilientDisposition.bind(h.storage);
    vi.spyOn(h.storage, "setResilientDisposition").mockImplementationOnce(() => { throw new ScheduleStoreBusyError(); }).mockImplementation(writeDisposition);
    vi.setSystemTime(beginning + 65 * minute);
    const scheduler = h.newScheduler(); scheduler.start(); await flush();
    expect(planScheduledModel).toHaveBeenCalledOnce();
    expect(h.row()).toMatchObject({ runtime: { slot: { kind: "idle", phase: "waiting" }, nextEligibleAt: target }, attemptHistory: [] });
    expect(h.row().runtime.pending).toBeUndefined();
    expect(scheduler.getNextRun("job")?.getTime()).toBe(beginning + 65 * minute + 1000);
    modelAvailable = true;
    await advance(1000); await flush(); await advance(1000); await flush();
    expect(planScheduledModel).toHaveBeenCalledTimes(3);
    expect(h.runs).toHaveLength(1);
    expect(h.row().runtime.slot).toMatchObject({ kind: "owned", attempt: { occurrence: { source: "misfire", dueAt: new Date(beginning + 60 * minute).toISOString() } } });
    expect(h.row().attemptHistory).toEqual([]);
    expect(scheduler.getNextRun("job")?.getTime()).toBe(beginning + 120 * minute);
  });

  it("keeps ordinary preflight contention on the current cadence instead of restoring a misfire", async () => {
    const h = fixture({ model: "fixture/model" }, { intervalMode: "fixed-rate", misfirePolicy: "latest", latenessMs: 10 * minute });
    modelPreparation(h);
    let modelAvailable = true;
    vi.mocked(planScheduledModel).mockImplementation((_ctx, job) => {
      if (!modelAvailable) throw new Error("Unknown model 'fixture/model'");
      return { route: job.model! };
    });
    const scheduler = h.newScheduler(); scheduler.start(); await flush();
    expect(scheduler.getNextRun("job")?.getTime()).toBe(beginning + 60 * minute);
    vi.setSystemTime(beginning + 65 * minute); modelAvailable = false;
    const writeDisposition = h.storage.setResilientDisposition.bind(h.storage);
    vi.spyOn(h.storage, "setResilientDisposition").mockImplementationOnce(() => { throw new ScheduleStoreBusyError(); }).mockImplementation(writeDisposition);
    scheduler.updateJob("job", h.row()); await flush();
    expect(scheduler.getNextRun("job")?.getTime()).toBe(beginning + 65 * minute + 1000);
    modelAvailable = true;
    await advance(1000); await flush();
    expect(h.runs).toHaveLength(0);
    expect(scheduler.getNextRun("job")?.getTime()).toBe(beginning + 120 * minute);
    expect(h.row().runtime.pending).toBeUndefined();
  });

  it("requeues a resilient intent when execute's current read contends", async () => {
    const h = fixture(); const scheduler = h.newScheduler(); scheduler.start();
    const resilient = (scheduler as any).resilient as { execute: (id: string) => void };
    const execute = resilient.execute.bind(resilient);
    let injected = false;
    const readJob = h.storage.getJob.bind(h.storage);
    vi.spyOn(resilient, "execute").mockImplementation(id => {
      if (!injected) {
        injected = true;
        vi.spyOn(h.storage, "getJob").mockImplementationOnce(() => { throw new ScheduleStoreBusyError(); });
      }
      execute(id);
    });
    await advance(60 * minute + 1000); await flush();
    expect(injected).toBe(true);
    expect(h.row().runtime.pending).toBeDefined();
    expect(h.runs).toHaveLength(0);
    vi.spyOn(h.storage, "getJob").mockImplementation(readJob);
    await advance(2 * 1000); await flush();
    expect(h.runs).toHaveLength(1);
  });

  it("retries post-settlement cadence after exact history confirmation contention", async () => {
    const h = fixture(); const scheduler = h.newScheduler(); scheduler.start(); await advance(60 * minute + 1000);
    let contend = false;
    const readJob = h.storage.getJob.bind(h.storage);
    vi.spyOn(h.storage, "getJob").mockImplementation(id => {
      if (contend) { contend = false; throw new ScheduleStoreBusyError(); }
      return readJob(id);
    });
    const settle = h.storage.settleResilient.bind(h.storage);
    vi.spyOn(h.storage, "settleResilient").mockImplementation((...args) => {
      const committed = settle(...args);
      if (committed) contend = true;
      return committed;
    });
    h.runs[0].close(); await flush(); await advance(1000); await flush();
    expect(h.row().attemptHistory).toHaveLength(1);
    expect(scheduler.getNextRun("job")?.getTime()).toBe(beginning + 120 * minute + 1000);
    await advance(60 * minute + 1000); expect(h.runs).toHaveLength(2);
  });

  it("stops contention timers at the bounded retry budget while retaining eligibility", async () => {
    const h = fixture(); const scheduler = h.newScheduler(); scheduler.start();
    const resilient = (scheduler as any).resilient as { arm: (id: string, target: number) => void };
    const target = h.row().runtime.nextEligibleAt;
    const readJob = h.storage.getJob.bind(h.storage);
    vi.spyOn(h.storage, "getJob").mockImplementation(() => { throw new ScheduleStoreBusyError(); });
    resilient.arm("job", Date.now() + 1000);
    await advance(10 * 1000); await flush();
    vi.spyOn(h.storage, "getJob").mockImplementation(readJob);
    expect(scheduler.getNextRun("job")).toBeNull();
    expect(h.row().runtime.nextEligibleAt).toBe(target);
    expect(h.pi.events.emit).toHaveBeenCalledWith("cron:change", expect.objectContaining({ type: "error", jobId: "job" }));
  });

  it("does not clear a pending projection when the preflight hold is busy", async () => {
    const h = fixture({ model: "fixture/model" });
    const target = new Date(beginning + 60 * minute).toISOString();
    h.storage.queueResilient("job", "owner", { id: "1:pending", dueAt: new Date(beginning).toISOString(), revision: 1, source: "timer" }, target);
    vi.mocked(planScheduledModel).mockImplementation(() => { throw new Error("Unknown model 'fixture/model'"); });
    vi.spyOn(h.storage, "setResilientDisposition").mockImplementationOnce(() => { throw new ScheduleStoreBusyError(); });
    const scheduler = h.newScheduler(); scheduler.start(); await flush();
    expect(h.row()).toMatchObject({ runtime: { slot: { kind: "idle", phase: "waiting" }, nextEligibleAt: target, pending: { id: "1:pending" } } });
    expect(scheduler.getNextRun("job")?.getTime()).toBe(beginning + 1000);
    expect(h.runs).toHaveLength(0);
  });

  it("clears queued projection when the model route disappears before drain admission", async () => {
    const h = fixture({ model: "fixture/model" });
    let modelAvailable = true;
    vi.mocked(planScheduledModel).mockImplementation((_ctx, job) => {
      if (!modelAvailable) throw new Error("Unknown model 'fixture/model'");
      return { route: job.model! };
    });
    const scheduler = h.newScheduler(); scheduler.start();
    await advance(60 * minute);
    expect(planScheduledModel).toHaveBeenCalledTimes(2);
    expect(h.row().runtime.pending).toBeDefined();
    modelAvailable = false;
    await advance(1000); await flush();
    expect(h.row()).toMatchObject({ attemptCount: 0, runtime: { slot: { kind: "idle", phase: "attention-required", reason: "native_model_unavailable" } } });
    expect(h.row().runtime.pending).toBeUndefined();
    expect(h.row().runtime.nextEligibleAt).toBeUndefined();
    expect(scheduler.getNextRun("job")).toBeNull();
    expect(h.runs).toHaveLength(0);
  });

  it("does not let a stale preflight hold a newer resilient revision", async () => {
    const h = fixture({ model: "fixture/model" });
    let raced = false;
    vi.mocked(planScheduledModel).mockImplementation((_ctx, job) => {
      if (!raced) {
        raced = true;
        h.storage.updateJob("job", { prompt: "newer revision" }, "owner");
        throw new Error("Unknown model 'fixture/model'");
      }
      return { route: job.model! };
    });
    const scheduler = h.newScheduler(); scheduler.start(); await flush();
    expect(planScheduledModel).toHaveBeenCalledTimes(2);
    expect(h.row()).toMatchObject({ revision: 2, prompt: "newer revision", runtime: { slot: { kind: "idle", phase: "waiting" } } });
    expect(scheduler.getNextRun("job")?.getTime()).toBe(beginning + 60 * minute);
  });

  it("does not recover an old attention hold over a newer barrier", async () => {
    const h = fixture({ model: "fixture/model" });
    h.storage.setResilientDisposition("job", "owner", { phase: "attention-required", reason: "native_model_unavailable" });
    const writeDisposition = h.storage.setResilientDisposition.bind(h.storage);
    let raced = false;
    const disposition = vi.spyOn(h.storage, "setResilientDisposition").mockImplementation((id, sessionId, next, expectedRevision) => {
      if (!raced && next.phase === "waiting") {
        raced = true;
        h.storage.updateJob(id, { prompt: "newer revision" }, sessionId);
        expect(writeDisposition(id, sessionId, { phase: "waiting-input", reason: "user_input_required" }, 2)).toBe(true);
      }
      return writeDisposition(id, sessionId, next, expectedRevision);
    });
    vi.mocked(planScheduledModel).mockReturnValue({ route: "fixture/model" });
    const scheduler = h.newScheduler(); scheduler.start(); await flush();
    expect(disposition).toHaveBeenCalledWith("job", "owner", { phase: "waiting" }, 1, { phase: "attention-required", reason: "native_model_unavailable", ownerEpoch: 1 });
    expect(h.row()).toMatchObject({ revision: 2, prompt: "newer revision", runtime: { slot: { kind: "idle", phase: "waiting-input", reason: "user_input_required" } } });
    expect(scheduler.getNextRun("job")).toBeNull();
    expect(h.runs).toHaveLength(0);
  });

  it.each(["waiting-input", "reconciling"] as const)("does not overwrite a same-revision %s barrier during model preflight recovery", async phase => {
    const h = fixture({ model: "fixture/model" });
    h.storage.setResilientDisposition("job", "owner", { phase: "attention-required", reason: "native_model_unavailable" });
    const writeDisposition = h.storage.setResilientDisposition.bind(h.storage);
    let raced = false;
    vi.spyOn(h.storage, "setResilientDisposition").mockImplementation((id, sessionId, next, expectedRevision, expectedRuntime) => {
      if (!raced && next.phase === "waiting") {
        raced = true;
        expect(writeDisposition(id, sessionId, { phase, reason: "newer_same_revision_barrier" })).toBe(true);
      }
      return writeDisposition(id, sessionId, next, expectedRevision, expectedRuntime);
    });
    vi.mocked(planScheduledModel).mockReturnValue({ route: "fixture/model" });
    const scheduler = h.newScheduler(); scheduler.start(); await flush();
    expect(h.row()).toMatchObject({ revision: 1, runtime: { slot: { kind: "idle", phase, reason: "newer_same_revision_barrier" } } });
    expect(scheduler.getNextRun("job")).toBeNull();
    expect(h.runs).toHaveLength(0);
  });

  it("arms startup recovery when schedule and two consecutive current reads contend", async () => {
    const h = fixture();
    vi.spyOn(h.storage, "setResilientEligibility").mockImplementationOnce(() => { throw new ScheduleStoreBusyError(); });
    const readJob = h.storage.getJob.bind(h.storage);
    let reads = 0;
    vi.spyOn(h.storage, "getJob").mockImplementation(id => {
      if (reads < 2) { reads++; throw new ScheduleStoreBusyError(); }
      return readJob(id);
    });
    const scheduler = h.newScheduler();
    expect(() => scheduler.start()).not.toThrow();
    expect(reads).toBe(1);
    expect(scheduler.getNextRun("job")).toBeDefined();
    await advance(1000); await flush();
    expect(reads).toBe(2);
    expect(scheduler.getNextRun("job")).toBeDefined();
  });

  it("rearms a timer after two consecutive current reads contend without replaying native work", async () => {
    const h = fixture(); const scheduler = h.newScheduler(); scheduler.start();
    const initialTarget = scheduler.getNextRun("job")?.getTime();
    expect(initialTarget).toBe(beginning + 60 * minute);
    const readJob = h.storage.getJob.bind(h.storage);
    let reads = 0;
    vi.spyOn(h.storage, "getJob").mockImplementation(id => {
      if (reads < 2) { reads++; throw new ScheduleStoreBusyError(); }
      return readJob(id);
    });
    await advance(60 * minute + 1000); await flush();
    expect(reads).toBe(2);
    expect(h.runs).toHaveLength(0);
    expect(scheduler.getNextRun("job")).toBeDefined();
    await advance(1001); await flush(); await advance(1000); await flush();
    expect(h.runs).toHaveLength(1);
    expect(h.capability.start).toHaveBeenCalledOnce();
  });

  it("rearms when arm's initial current read contends twice and still surfaces ordinary errors", async () => {
    const h = fixture(); const scheduler = h.newScheduler(); scheduler.start();
    const resilient = (scheduler as any).resilient as { arm: (id: string, target: number) => void };
    const readJob = h.storage.getJob.bind(h.storage);
    let reads = 0;
    vi.spyOn(h.storage, "getJob").mockImplementation(id => {
      if (reads < 2) { reads++; throw new ScheduleStoreBusyError(); }
      return readJob(id);
    });
    expect(() => resilient.arm("job", Date.now() + 1000)).not.toThrow();
    expect(reads).toBe(1);
    expect(scheduler.getNextRun("job")).toBeDefined();
    await advance(1000); await flush();
    expect(reads).toBe(2);
    expect(scheduler.getNextRun("job")).toBeDefined();

    vi.spyOn(h.storage, "getJob").mockImplementationOnce(() => { throw new Error("ordinary current read failure"); });
    expect(() => resilient.arm("job", Date.now() + 1000)).toThrow("ordinary current read failure");
  });

  it("re-enters schedule on a contention retry and recovers a model hold", async () => {
    const h = fixture({ model: "fixture/model" });
    let modelAvailable = false;
    vi.mocked(planScheduledModel).mockImplementation((_ctx, job) => {
      if (!modelAvailable) throw new Error("Unknown model 'fixture/model'");
      return { route: job.model! };
    });
    h.storage.setResilientDisposition("job", "owner", { phase: "attention-required", reason: "native_model_unavailable" });
    vi.spyOn(h.storage, "setResilientDisposition").mockImplementationOnce(() => { throw new ScheduleStoreBusyError(); });
    const scheduler = h.newScheduler(); scheduler.start();
    modelAvailable = true;
    await advance(1000); await flush();
    expect(planScheduledModel).toHaveBeenCalledOnce();
    expect(h.row()).toMatchObject({ attemptCount: 0, runtime: { slot: { kind: "idle", phase: "waiting" } } });
    expect(scheduler.getNextRun("job")?.getTime()).toBe(beginning + 60 * minute);
    expect(h.row().runtime.pending).toBeUndefined();
    expect(h.runs).toHaveLength(0);
  });

  it("re-preflights a contention retry after an attention hold cannot be cleared", async () => {
    const h = fixture({ model: "fixture/model" });
    let modelAvailable = true;
    vi.mocked(planScheduledModel).mockImplementation((_ctx, job) => {
      if (!modelAvailable) throw new Error("Unknown model 'fixture/model'");
      return { route: job.model! };
    });
    h.storage.setResilientDisposition("job", "owner", { phase: "attention-required", reason: "native_model_unavailable" });
    vi.spyOn(h.storage, "setResilientDisposition").mockImplementationOnce(() => { throw new ScheduleStoreBusyError(); });
    const scheduler = h.newScheduler(); scheduler.start();
    modelAvailable = false;
    await advance(1000); await flush();
    expect(planScheduledModel).toHaveBeenCalledOnce();
    expect(scheduler.getNextRun("job")).toBeNull();
    expect(h.row()).toMatchObject({ attemptCount: 0, runtime: { slot: { kind: "idle", phase: "attention-required", reason: "native_model_unavailable" } } });
    expect(h.row().runtime.nextEligibleAt).toBeUndefined();
    expect(h.row().runtime.pending).toBeUndefined();
    expect(h.runs).toHaveLength(0);
  });

  it("re-preflights a misfire after queue loses a revision race before persistence", async () => {
    const h = fixture({ model: "fixture/model" }, { intervalMode: "fixed-rate", misfirePolicy: "latest", latenessMs: 10 * minute });
    let modelAvailable = true;
    const model = { provider: "fixture", id: "model", name: "Fixture Model" };
    h.ctx.modelRegistry.getAvailable = () => modelAvailable ? [model] : [];
    vi.mocked(planScheduledModel).mockImplementation((ctx, job) => {
      if (!ctx.modelRegistry.getAvailable().some(candidate => `${candidate.provider}/${candidate.id}` === job.model)) throw new Error("Unknown model 'fixture/model'");
      return { route: job.model! };
    });
    h.storage.setResilientEligibility("job", "owner", 1, new Date(beginning + 60 * minute).toISOString());
    vi.setSystemTime(beginning + 5 * 60 * minute + 5 * minute);
    const queueResilient = h.storage.queueResilient.bind(h.storage);
    const queue = vi.spyOn(h.storage, "queueResilient");
    queue.mockImplementation((id, sessionId, occurrence, nextEligibleAt) => {
      h.storage.updateJob(id, { prompt: "revision-race" }, sessionId);
      modelAvailable = false;
      return queueResilient(id, sessionId, occurrence, nextEligibleAt);
    });
    const scheduler = h.newScheduler(); scheduler.start();
    await flush();
    expect(queue).toHaveBeenCalledOnce();
    expect(planScheduledModel).toHaveBeenCalledTimes(2);
    expect(scheduler.getNextRun("job")).toBeNull();
    expect(h.row()).toMatchObject({ attemptCount: 0, runtime: { slot: { kind: "idle", phase: "attention-required", reason: "native_model_unavailable" } } });
    expect(h.runs).toHaveLength(0);
  });

  it("prepares explicit-model capability before charging and binds its persistent child session without inline fallback", async () => {
    const h = fixture({ model: "fixture/model" }); const prepared = modelPreparation(h); h.newScheduler().start();
    await advance(60 * minute + 1000); await flush();
    expect(prepareScheduledModel).toHaveBeenCalledOnce(); expect(h.runs).toHaveLength(1);
    expect(h.row().runtime.slot).toMatchObject({ kind: "owned", attempt: { model: "fixture/model", nativeSessionId: expect.stringMatching(/^schedule-/), nativeSessionFile: expect.stringContaining(".pi/schedule-native/") } });
    expect(h.runs[0].request.binding.ownerSessionId).not.toBe("owner"); expect(h.ctx.scheduledExecution!.start).not.toHaveBeenCalled(); expect(h.pi.sendMessage).not.toHaveBeenCalled();
    expect(prepared.dispose).not.toHaveBeenCalled(); h.runs[0].close(); await flush();
    expect(prepared.dispose).toHaveBeenCalledOnce(); expect(h.row().attemptHistory[0].checkpoint?.sessionId).toBe(h.runs[0].request.binding.ownerSessionId);
  });

  it("retains the admitted model owner when pre-start disposal rejects, without refund or native replay", async () => {
    const h = fixture({ model: "fixture/model" }); const prepared = modelPreparation(h);
    prepared.dispose.mockRejectedValue(new Error("synthetic pre-start dispose failure"));
    h.refuse("busy"); const scheduler = h.newScheduler(); scheduler.start(); await advance(60 * minute + 1000); await flush();
    const row = h.row();
    expect(prepared.dispose).toHaveBeenCalledOnce();
    expect(h.runs).toHaveLength(0);
    expect(h.ctx.scheduledExecution!.start).not.toHaveBeenCalled();
    expect(row).toMatchObject({
      attemptCount: 1,
      attemptHistory: [],
      runtime: { slot: { kind: "owned", phase: "attention-required", reason: "model_sdk_close_failed" } },
    });
    expect(scheduler.isRunning()).toBe(true);
  });

  it("retains the admitted model owner when stopped before native start and disposal rejects", async () => {
    const h = fixture({ model: "fixture/model" }); const prepared = modelPreparation(h);
    prepared.dispose.mockRejectedValue(new Error("synthetic stopped pre-start dispose failure"));
    const original = vi.mocked(prepareScheduledModel).getMockImplementation();
    if (!original) throw new Error("Expected model preparation fixture");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(prepareScheduledModel).mockImplementation(async (ctx, job, attempt, route, bindFile) => {
      const result = await original(ctx, job, attempt, route, bindFile);
      await gate;
      return result;
    });
    const scheduler = h.newScheduler(); scheduler.start(); await advance(60 * minute + 1000); await flush();
    scheduler.stop(); release(); await flush();
    expect(prepared.dispose).toHaveBeenCalledOnce();
    expect(h.runs).toHaveLength(0);
    expect(h.row()).toMatchObject({
      attemptCount: 1,
      attemptHistory: [],
      runtime: { slot: { kind: "owned", phase: "attention-required", reason: "model_sdk_close_failed" } },
    });
  });

  it("retains exact ownership when delayed model preparation fails after projection and definition updates", async () => {
    const h = fixture({ model: "fixture/model" }, { intervalMode: "fixed-rate", overlapPolicy: "buffer-one" });
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(planScheduledModel).mockReturnValue({ route: "fixture/model" });
    vi.mocked(prepareScheduledModel).mockImplementation(async (_ctx, _job, attempt, _route, bindFile) => {
      const sessionId = attempt.nativeSessionId!;
      bindFile(attempt.nativeSessionFile ?? path.join(h.ctx.cwd, ".pi/schedule-native/", sessionId + ".jsonl"));
      await delayed;
      throw new Error("synthetic delayed model preparation failure");
    });
    const scheduler = h.newScheduler(); scheduler.start(); await advance(60 * minute + 1000); await flush();
    const admitted = h.row();
    if (admitted.runtime.slot.kind !== "owned") throw new Error("Expected delayed preparation to own an attempt");
    const attemptId = admitted.runtime.slot.attempt.id;
    const replacement = new Date(Date.now() + 2 * minute).toISOString();
    expect(admitted.runtime.nextEligibleAt).toBeDefined();
    expect(h.storage.updateJob("job", { prompt: "newer definition" }, "owner")).toBe(true);
    expect(h.row().revision).toBe(2);
    expect(h.storage.queueResilient("job", "owner", { id: "2:pending", dueAt: new Date().toISOString(), revision: 2, source: "overlap" }, replacement).status).toBe("queued");
    release(); await flush();
    expect(h.row()).toMatchObject({
      revision: 2, prompt: "newer definition", attemptCount: 1,
      runtime: { slot: { kind: "owned", phase: "attention-required", reason: "native_model_preparation_failed", attempt: { id: attemptId } }, nextEligibleAt: replacement, pending: { id: "2:pending", revision: 2 } },
    });
    expect(scheduler.getNextRun("job")).toBeNull(); expect(h.runs).toHaveLength(0);
  });

  it.each(["busy", "pending"])("starts an explicit-model child while the unrelated parent is %s, retaining exact closure and limits", async parent => {
    const h = fixture({ model: "fixture/model", maxRuns: 1, intervalMs: minute, schedule: "1m", deadlineMs: 10 * minute }, { workBudgetMs: 5 * minute });
    const prepared = modelPreparation(h);
    if (parent === "busy") h.busy(true);
    else h.ctx.hasPendingMessages = () => true;
    h.newScheduler().start(); await advance(minute + 1000); await flush();
    expect(prepareScheduledModel).toHaveBeenCalledOnce(); expect(h.runs).toHaveLength(1);
    expect(h.row()).toMatchObject({ attemptCount: 1, runtime: { slot: { kind: "owned" } } });
    expect(h.ctx.scheduledExecution!.start).not.toHaveBeenCalled(); expect(h.pi.sendMessage).not.toHaveBeenCalled();
    await advance(2 * minute); expect(prepareScheduledModel).toHaveBeenCalledOnce();
    h.runs[0].close(); await flush(); await flush();
    expect(prepared.dispose).toHaveBeenCalledOnce();
    expect(h.row()).toMatchObject({ enabled: true, attemptCount: 1, runtime: { slot: { kind: "idle", phase: "finished" } }, attemptHistory: [{ outcome: "completed", modelSdkClose: { runId: "run-0" } }] });
    await advance(2 * minute); expect(prepareScheduledModel).toHaveBeenCalledOnce(); expect(h.ctx.abort).not.toHaveBeenCalled();
  });

  it.each(["busy", "pending"])("keeps inline resilient work uncharged while the parent is %s", async parent => {
    const h = fixture({ intervalMs: minute, schedule: "1m" });
    if (parent === "busy") h.busy(true);
    else h.ctx.hasPendingMessages = () => true;
    h.newScheduler().start(); await advance(minute + 1000); await flush();
    expect(h.runs).toHaveLength(0); expect(h.row().attemptCount).toBe(0);
    expect(h.row().runtime.pending).toBeDefined(); expect(h.ctx.abort).not.toHaveBeenCalled();
    h.busy(false); h.ctx.hasPendingMessages = () => false;
    await advance(1000); expect(h.runs).toHaveLength(1);
  });

  it("rechecks an explicit model route after arming and clears stale timer projection without charging", async () => {
    const h = fixture({ model: "fixture/model" }); modelPreparation(h);
    let modelAvailable = true;
    const model = { provider: "fixture", id: "model", name: "Fixture Model" };
    h.ctx.modelRegistry.getAvailable = () => modelAvailable ? [model] : [];
    vi.mocked(planScheduledModel).mockImplementation((ctx, job) => {
      if (!ctx.modelRegistry.getAvailable().some(candidate => `${candidate.provider}/${candidate.id}` === job.model)) throw new Error("Unknown model 'fixture/model'");
      return { route: job.model! };
    });
    const scheduler = h.newScheduler(); scheduler.start(); await flush();
    expect(planScheduledModel).toHaveBeenCalledOnce();
    expect(scheduler.getNextRun("job")?.getTime()).toBe(beginning + 60 * minute);
    expect(h.row().runtime.nextEligibleAt).toBe(new Date(beginning + 60 * minute).toISOString());
    modelAvailable = false;
    await advance(60 * minute + 1000); await flush();
    expect(planScheduledModel).toHaveBeenCalledTimes(2);
    expect(scheduler.getNextRun("job")).toBeNull();
    expect(h.row()).toMatchObject({
      enabled: true, attemptCount: 0,
      runtime: { slot: { kind: "idle", phase: "attention-required", reason: "native_model_unavailable" } },
      attemptHistory: [],
    });
    expect(h.row().runtime.nextEligibleAt).toBeUndefined();
    expect(h.row().runtime.pending).toBeUndefined();
    expect(h.runs).toHaveLength(0);
  });

  it("preflights explicit-model work before arming and recovers a transient unavailable route without charging", async () => {
    const h = fixture({ model: "fixture/model" }); modelPreparation(h);
    vi.mocked(planScheduledModel).mockImplementationOnce(() => { throw new Error("synthetic model route unavailable"); });
    const scheduler = h.newScheduler(); scheduler.start(); await flush();
    expect(planScheduledModel).toHaveBeenCalledOnce();
    expect(h.row()).toMatchObject({ enabled: true, attemptCount: 0, runtime: { slot: { kind: "idle", phase: "attention-required", reason: "native_model_unavailable" } } });
    expect(scheduler.getNextRun("job")).toBeNull(); expect(h.runs).toHaveLength(0);
    scheduler.updateJob("job", h.row()); await flush();
    expect(planScheduledModel).toHaveBeenCalledTimes(2);
    expect(h.row().runtime.slot).toMatchObject({ kind: "idle", phase: "waiting" }); expect(scheduler.getNextRun("job")?.getTime()).toBe(beginning + 60 * minute);
    expect(h.row().attemptCount).toBe(0); expect(h.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("does not replace an UNKNOWN-effect barrier when model preflight later becomes unavailable", async () => {
    const h = fixture({ model: "fixture/model" }); modelPreparation(h); const scheduler = h.newScheduler(); scheduler.start();
    await advance(60 * minute + 1000); h.runs[0].close("completed", "unknown"); await flush(); scheduler.stop();
    vi.mocked(planScheduledModel).mockImplementationOnce(() => { throw new Error("synthetic model route unavailable"); });
    h.newScheduler().start(); await flush();
    expect(h.row()).toMatchObject({ attemptCount: 1, runtime: { slot: { kind: "idle", phase: "reconciling" } }, attemptHistory: [{ effectStatus: "unknown" }] });
    expect(h.runs).toHaveLength(1);
  });

  it("holds after model settlement when the explicit registry route disappears", async () => {
    const h = fixture({ model: "fixture/model" }); modelPreparation(h);
    let modelAvailable = true;
    const model = { provider: "fixture", id: "model", name: "Fixture Model" };
    h.ctx.modelRegistry.getAvailable = () => modelAvailable ? [model] : [];
    vi.mocked(planScheduledModel).mockImplementation((ctx, job) => {
      if (!ctx.modelRegistry.getAvailable().some(candidate => `${candidate.provider}/${candidate.id}` === job.model)) throw new Error("Unknown model 'fixture/model'");
      return { route: job.model! };
    });
    const scheduler = h.newScheduler(); scheduler.start();
    await advance(60 * minute + 1000); await flush();
    expect(h.runs).toHaveLength(1); expect(h.row().attemptCount).toBe(1);
    modelAvailable = false;
    h.runs[0].close(); await flush(); await flush();
    expect(h.row()).toMatchObject({
      enabled: true, attemptCount: 1,
      runtime: { slot: { kind: "idle", phase: "attention-required", reason: "native_model_unavailable" } },
      attemptHistory: [{ outcome: "completed", model: "fixture/model" }],
    });
    expect(scheduler.getNextRun("job")).toBeNull(); expect(h.runs).toHaveLength(1);
  });

  it("holds after exact reconciliation when the explicit registry route disappears", async () => {
    const h = fixture({ model: "fixture/model" }); modelPreparation(h);
    let modelAvailable = true;
    const model = { provider: "fixture", id: "model", name: "Fixture Model" };
    h.ctx.modelRegistry.getAvailable = () => modelAvailable ? [model] : [];
    vi.mocked(planScheduledModel).mockImplementation((ctx, job) => {
      if (!ctx.modelRegistry.getAvailable().some(candidate => `${candidate.provider}/${candidate.id}` === job.model)) throw new Error("Unknown model 'fixture/model'");
      return { route: job.model! };
    });
    const scheduler = h.newScheduler(); scheduler.start();
    await advance(60 * minute + 1000); await flush();
    const attemptId = h.runs[0].request.binding.attemptId;
    h.runs[0].close("completed", "unknown"); await flush(); await flush();
    const before = h.row(); expect(before.runtime.slot).toMatchObject({ kind: "idle", phase: "reconciling" });
    modelAvailable = false;
    const result = scheduler.reconcileResilientJob("job", attemptId, "a".repeat(64), "continue");
    await flush();
    expect(result.changed).toBe(true);
    expect(h.row()).toMatchObject({
      enabled: true, attemptCount: 1,
      runtime: { slot: { kind: "idle", phase: "attention-required", reason: "native_model_unavailable" } },
      attemptHistory: [{ outcome: "completed", effectStatus: "unknown", model: "fixture/model" }],
    });
    expect(h.row().attemptResolutions).toHaveLength(1); expect(h.row().runtime.continuation?.attemptId).toBe(attemptId);
    expect(scheduler.getNextRun("job")).toBeNull(); expect(h.runs).toHaveLength(1);
  });

  it("does not charge or use the old model runner when a prepared child lacks the native capability", async () => {
    const h = fixture({ model: "fixture/model" }); modelPreparation(h);
    vi.mocked(planScheduledModel).mockImplementationOnce(() => { throw new Error("Scheduled model SDK lacks native capability v1"); });
    h.newScheduler().start(); await advance(60 * minute + 1000); await flush();
    expect(h.row()).toMatchObject({ enabled: true, attemptCount: 0, runtime: { slot: { kind: "idle", phase: "attention-required", reason: "native_model_unavailable" } } }); expect(h.runs).toHaveLength(0); expect(h.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("continues a model deferral in its exact persistent checkpoint session, and sends actual declarations not only a pointer", async () => {
    const h = fixture({ model: "fixture/model", intervalMs: minute, schedule: "1m", deadlineMs: 10 * minute }, { workBudgetMs: 5 * minute }); const prepared = modelPreparation(h); h.newScheduler().start(); await advance(minute + 1000); await flush();
    const first = h.runs[0]; first.handle.checkpoint({ nextAction: "use-the-saved-synthetic-result", artifacts: [{ ref: "tmp/result.txt", sha256: "a".repeat(64) }] }); first.close("deferred", "none-observed", "response_retry_exhausted"); await flush();
    expect(h.row().runtime.slot.phase).toBe("backoff"); await advance(minute + 1000); await flush();
    expect(h.runs).toHaveLength(2); expect(h.runs[1].request.binding.ownerSessionId).toBe(first.request.binding.ownerSessionId);
    expect(h.runs[1].request.content).toContain("use-the-saved-synthetic-result"); expect(h.runs[1].request.content).toContain('"completedResultCount":0'); expect(h.runs[1].request.content).toContain('"artifacts"'); expect(prepared.readers.size).toBe(1);
  });

  it.each(["ownerEpoch", "revision"] as const)("fails closed in the continuation prompt when checkpoint %s metadata is stale", async field => {
    const h = fixture({ model: "fixture/model", intervalMs: minute, schedule: "1m", deadlineMs: 10 * minute }, { workBudgetMs: 5 * minute }); modelPreparation(h); h.newScheduler().start();
    await advance(minute + 1000); await flush();
    h.runs[0].close("deferred", "none-observed", "response_retry_exhausted"); await flush();
    const continuation = h.row().runtime.continuation!;
    const checkpoint = h.entries.get(continuation.checkpoint.entryId) as any;
    checkpoint.data.binding[field]++;
    await advance(minute + 1000); await flush();
    expect(h.runs).toHaveLength(1);
    expect(h.row().runtime.slot).toMatchObject({ kind: "owned", phase: "attention-required", reason: "native_model_preparation_failed" });
  });

  it("does not construct a second child SDK writer when another scheduler already owns the logical job", async () => {
    const h = fixture({ model: "fixture/model" }); modelPreparation(h); const first = h.newScheduler(); first.start(); await advance(60 * minute + 1000); await flush();
    const before = h.row().attemptCount; const second = h.newScheduler(); second.start(); await flush();
    expect(prepareScheduledModel).toHaveBeenCalledOnce(); expect(h.row().attemptCount).toBe(before); expect(h.runs).toHaveLength(1);
    expect(h.row().runtime.slot).toMatchObject({ kind: "owned", phase: "attention-required", reason: "native_owner_unconfirmed" });
  });

  it("keeps a model's live native child until acknowledged settlement, including during scheduler stop", async () => {
    const h = fixture({ model: "fixture/model" }); const prepared = modelPreparation(h); const scheduler = h.newScheduler(); scheduler.start(); await advance(60 * minute + 1000); await flush();
    scheduler.stop(); expect(prepared.dispose).not.toHaveBeenCalled(); expect(h.runs[0].handle.requestCancel).toHaveBeenCalledWith("scheduler_stopped"); expect(h.row().runtime.slot.kind).toBe("owned");
    h.runs[0].close("cancelled", "unknown"); await flush(); expect(prepared.dispose).toHaveBeenCalledOnce(); expect(h.row().runtime.slot.phase).toBe("reconciling");
  });

  it("review: retains model ownership until asynchronous SDK shutdown acknowledges closure", async () => {
    const h = fixture({ model: "fixture/model", intervalMs: minute, schedule: "1m", deadlineMs: 10 * minute }, { workBudgetMs: 5 * minute });
    const prepared = modelPreparation(h);
    let release!: () => void;
    let disposed = false;
    const shutdown = new Promise<void>(resolve => { release = resolve; });
    prepared.dispose.mockImplementationOnce(async () => { await shutdown; disposed = true; });
    h.newScheduler().start(); await advance(minute + 1000); await flush();
    const firstSession = h.runs[0].request.binding.ownerSessionId;
    h.runs[0].close("deferred", "none-observed", "response_retry_exhausted"); await flush();
    expect(prepared.dispose).toHaveBeenCalledOnce();
    await advance(minute + 1000); await flush();
    const observed = { disposed, preparations: vi.mocked(prepareScheduledModel).mock.calls.length, nativeRuns: h.runs.length, samePersistentSession: h.runs[1]?.request.binding.ownerSessionId === firstSession, slot: h.row().runtime.slot.kind, attemptCount: h.row().attemptCount };
    console.log("REVIEW_MODEL_SHUTDOWN", JSON.stringify(observed));
    release(); await flush();
    expect(observed.preparations, "second persistent SDK writer must not be constructed before old SDK shutdown closes").toBe(1);
    expect(observed.nativeRuns).toBe(1);
  });

  it("starts completion-delay and cooldown from actual SDK close ACK, not the earlier native receipt", async () => {
    const h = fixture({ model: "fixture/model", intervalMs: minute, schedule: "1m", deadlineMs: 10 * minute }, { workBudgetMs: 5 * minute });
    const prepared = modelPreparation(h); const acknowledge = prepared.dispose.getMockImplementation()!;
    let release!: () => void; const shutdown = new Promise<void>(resolve => { release = resolve; });
    prepared.dispose.mockImplementationOnce(async receipt => { await shutdown; return acknowledge(receipt); });
    const scheduler = h.newScheduler(); scheduler.start(); await advance(minute + 1000); await flush();
    const sessionId = h.runs[0].request.binding.ownerSessionId; const nativeFinishedAt = new Date().toISOString();
    h.runs[0].close("deferred", "none-observed", "response_retry_exhausted"); await flush();
    expect(h.row()).toMatchObject({ attemptCount: 1, attemptHistory: [], runtime: { slot: { kind: "owned", phase: "draining", reason: "awaiting_sdk_shutdown" } } });
    await advance(3 * minute); expect(h.runs).toHaveLength(1); expect(prepareScheduledModel).toHaveBeenCalledOnce(); expect(scheduler.getNextRun("job")).toBeNull();
    const closedAt = new Date().toISOString(); release(); await flush(); await flush();
    expect(h.row()).toMatchObject({ attemptCount: 1, runtime: { lastFinishedAt: closedAt, slot: { kind: "idle", phase: "backoff" } }, attemptHistory: [{ closedAt: nativeFinishedAt, modelSdkClose: { closedAt, binding: { ownerSessionId: sessionId } } }] });
    expect(scheduler.getNextRun("job")?.getTime()).toBe(Date.parse(closedAt) + minute);
    await advance(minute - 1); expect(h.runs).toHaveLength(1); await advance(1001); await flush();
    expect(h.runs).toHaveLength(2); expect(h.runs[1].request.binding.ownerSessionId).toBe(sessionId);
  });

  it.each(["shutdown failure", "SDK close ACK write failure"])("retains charged ownership after %s and refuses raw-receipt restart", async failure => {
    const h = fixture({ model: "fixture/model", intervalMs: minute, schedule: "1m", deadlineMs: 10 * minute }, { workBudgetMs: 5 * minute }); const prepared = modelPreparation(h);
    prepared.dispose.mockRejectedValueOnce(new Error("synthetic " + failure));
    h.newScheduler().start(); await advance(minute + 1000); await flush(); h.runs[0].close("deferred", "none-observed", "response_retry_exhausted"); await flush(); await flush();
    expect(h.row()).toMatchObject({ enabled: true, attemptCount: 1, attemptHistory: [], runtime: { slot: { kind: "owned", phase: "attention-required", reason: "model_sdk_close_failed" } } });
    const entries = h.entries.size; h.newScheduler().start(); await advance(2 * minute); await flush();
    expect(h.row().runtime.slot).toMatchObject({ kind: "owned", phase: "attention-required", reason: "model_sdk_closure_unconfirmed" });
    expect(h.entries.size).toBe(entries); expect(h.runs).toHaveLength(1); expect(prepareScheduledModel).toHaveBeenCalledOnce();
  });

  it("does not let a second scheduler use a raw native receipt or a foreign SDK-close ACK as file-writer exit evidence", async () => {
    const h = fixture({ model: "fixture/model", intervalMs: minute, schedule: "1m", deadlineMs: 10 * minute }, { workBudgetMs: 5 * minute }); const prepared = modelPreparation(h); const acknowledge = prepared.dispose.getMockImplementation()!;
    let release!: () => void; const shutdown = new Promise<void>(resolve => { release = resolve; }); prepared.dispose.mockImplementationOnce(async receipt => { await shutdown; return acknowledge(receipt); });
    h.newScheduler().start(); await advance(minute + 1000); await flush(); h.runs[0].close("deferred", "none-observed", "response_retry_exhausted"); await flush();
    const native = h.entries.get("receipt-run-0").data as NativeExecutionProof;
    h.entries.set("foreign-sdk-close", { type: "custom", customType: MODEL_SDK_CLOSE_ENTRY, data: { version: 1, runId: native.runId, binding: { ...native.binding, attemptId: "foreign-attempt" }, checkpointEntryId: native.checkpointEntryId, closedAt: new Date().toISOString() } });
    h.newScheduler().start(); await advance(2 * minute); await flush();
    expect(h.row().runtime.slot).toMatchObject({ kind: "owned", phase: "attention-required", reason: "model_sdk_closure_unconfirmed" }); expect(prepareScheduledModel).toHaveBeenCalledOnce(); expect(h.runs).toHaveLength(1);
    vi.spyOn(h.storage, "settleResilient").mockImplementationOnce(() => { throw new Error("synthetic final store write loss after SDK ACK"); });
    const closedAt = new Date().toISOString(); release(); await flush(); await flush(); expect(h.row().runtime.slot.kind).toBe("owned");
    const recovered = h.newScheduler(); recovered.start(); await flush();
    expect(h.row()).toMatchObject({ attemptCount: 1, runtime: { lastFinishedAt: closedAt, slot: { kind: "idle", phase: "backoff" } }, attemptHistory: [{ modelSdkClose: { closedAt, runId: native.runId } }] });
    expect(recovered.getNextRun("job")?.getTime()).toBe(Date.parse(closedAt) + minute); expect(prepareScheduledModel).toHaveBeenCalledOnce();
  });

  it("does not refund a model native refusal until that prepared SDK writer has actually closed", async () => {
    const h = fixture({ model: "fixture/model", intervalMs: minute, schedule: "1m", deadlineMs: 10 * minute }, { workBudgetMs: 5 * minute }); const prepared = modelPreparation(h);
    let release!: () => void; const shutdown = new Promise<void>(resolve => { release = resolve; }); prepared.dispose.mockImplementationOnce(async () => { await shutdown; return undefined; });
    h.refuse("busy"); h.newScheduler().start(); await advance(minute + 1000); await flush();
    expect(h.row()).toMatchObject({ attemptCount: 1, attemptHistory: [], runtime: { slot: { kind: "owned" } } });
    await advance(2 * minute); expect(prepareScheduledModel).toHaveBeenCalledOnce(); expect(h.runs).toHaveLength(0);
    release(); await flush(); await flush(); expect(h.row()).toMatchObject({ attemptCount: 0, attemptHistory: [{ charged: false, outcome: "not-started" }] });
  });

  it("preserves a user stop and original bounds through exact native completion", async () => {
    const h = fixture({ maxRuns: 1 }); const scheduler = h.newScheduler(); scheduler.start(); await advance(60 * minute + 1000);
    h.storage.updateJob("job", { enabled: false }, "owner"); h.runs[0].close(); await flush(); await advance(3 * 60 * minute);
    expect(h.row()).toMatchObject({ enabled: false, maxRuns: 1, attemptCount: 1, runtime: { slot: { kind: "idle", phase: "finished" } } }); expect(h.runs).toHaveLength(1);
  });
});
