import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeCapability, NativeRunHandle, NativeRunSnapshot } from "../src/native.js";
import { resilientDefinition } from "../src/resilient-policy.js";
import { MODEL_SDK_CLOSE_ENTRY, planScheduledModel, prepareScheduledModel, readStoredModelSession } from "../src/scheduled-model.js";
import { CronScheduler } from "../src/scheduler.js";
import { CronStorage } from "../src/storage.js";
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
  fs.mkdirSync(path.dirname(storage.getStorePath()), { mode: 0o700 });
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
afterEach(() => { for (const scheduler of schedulers.splice(0)) scheduler.stop(); vi.useRealTimers(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe("resilient native timer composition", () => {
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

  it("prepares explicit-model capability before charging and binds its persistent child session without inline fallback", async () => {
    const h = fixture({ model: "fixture/model" }); const prepared = modelPreparation(h); h.newScheduler().start();
    await advance(60 * minute + 1000); await flush();
    expect(prepareScheduledModel).toHaveBeenCalledOnce(); expect(h.runs).toHaveLength(1);
    expect(h.row().runtime.slot).toMatchObject({ kind: "owned", attempt: { model: "fixture/model", nativeSessionId: expect.stringMatching(/^schedule-/), nativeSessionFile: expect.stringContaining(".pi/schedule-native/") } });
    expect(h.runs[0].request.binding.ownerSessionId).not.toBe("owner"); expect(h.ctx.scheduledExecution!.start).not.toHaveBeenCalled(); expect(h.pi.sendMessage).not.toHaveBeenCalled();
    expect(prepared.dispose).not.toHaveBeenCalled(); h.runs[0].close(); await flush();
    expect(prepared.dispose).toHaveBeenCalledOnce(); expect(h.row().attemptHistory[0].checkpoint?.sessionId).toBe(h.runs[0].request.binding.ownerSessionId);
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
