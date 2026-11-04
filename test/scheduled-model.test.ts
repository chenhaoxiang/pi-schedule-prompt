import * as fs from "node:fs";
import * as path from "node:path";
import { AgentSession, CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resilientDefinition } from "../src/resilient-policy.js";
import { MODEL_SDK_CLOSE_ENTRY, planScheduledModel, prepareScheduledModel, readModelSdkClose, readStoredModelSession } from "../src/scheduled-model.js";
import { prepareModelSession } from "../src/subagent.js";
import type { NativeExecutionProof, OwnedAttempt, ResilientJob } from "../src/types.js";

vi.mock("../src/subagent.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/subagent.js")>(), prepareModelSession: vi.fn() }));

const directories: string[] = [];
const original = Object.getOwnPropertyDescriptor(AgentSession, "scheduledExecutionVersion");
function fixture() {
  const root = path.resolve("tmp/scheduled-model-fixtures"); fs.mkdirSync(root, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(root, "case-")); directories.push(cwd);
  const directory = path.join(cwd, ".pi/schedule-native"); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "selected.jsonl");
  const checkpoint = { version: 1, runId: "run", binding: { jobId: "job", attemptId: "before", ownerSessionId: "schedule-synthetic", ownerEpoch: 2, revision: 1 }, completedResults: [], completedResultCount: 0, declarations: { nextAction: "use-existing-result" }, effectStatus: "none-observed", businessOutcome: "unverified" };
  const values = [{ type: "session", version: CURRENT_SESSION_VERSION, id: "schedule-synthetic", timestamp: new Date().toISOString(), cwd }, { id: "checkpoint", parentId: null, timestamp: new Date().toISOString(), type: "custom", customType: "pi.scheduled-checkpoint.v1", data: checkpoint }];
  fs.writeFileSync(file, values.map(value => JSON.stringify(value)).join("\n") + "\n", { mode: 0o600 });
  const job: ResilientJob = resilientDefinition({ id: "job", name: "job", type: "interval", schedule: "1s", intervalMs: 1000, prompt: "synthetic", enabled: true, createdAt: new Date().toISOString(), runCount: 0, session: "logical-owner", model: "fixture/model", maxRuns: 3, expiresAt: new Date(Date.now() + 60_000).toISOString(), deadlineMs: 10_000 });
  // This pure planner fixture supplies only the historical fields it reads; schema validation is tested separately.
  job.runtime.continuation = { attemptId: "before", checkpoint: { sessionId: "schedule-synthetic", entryId: "checkpoint", runId: "run", sessionFile: file } };
  job.attemptHistory = [{ id: "before", model: "fixture/model" } as any];
  const getAvailable = vi.fn(() => [{ provider: "fixture", id: "model", name: "model" }]);
  const ctx = { cwd, modelRegistry: { getAvailable } } as any;
  return { cwd, file, values, job, ctx, getAvailable };
}
beforeEach(() => { vi.mocked(prepareModelSession).mockReset(); });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (original) Object.defineProperty(AgentSession, "scheduledExecutionVersion", original);
  else Reflect.deleteProperty(AgentSession, "scheduledExecutionVersion");
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function sdkFixture() {
  const h = fixture(); Object.defineProperty(AgentSession, "scheduledExecutionVersion", { configurable: true, value: 1 });
  h.job.runtime.continuation = undefined; h.job.attemptHistory = [];
  const order: string[] = [];
  const entries = new Map<string, any>();
  const manager = { getSessionId: () => "schedule-synthetic", getSessionFile: () => h.file, getEntry: (id: string) => entries.get(id), getEntries: () => [...entries.values()], appendCustomEntry: vi.fn((customType, data) => { order.push("ack"); entries.set("sdk-close", { id: "sdk-close", type: "custom", customType, data }); return "sdk-close"; }) };
  vi.spyOn(SessionManager, "create").mockReturnValue(manager as any);
  let listener: ((error: any) => void) | undefined;
  const session = { model: { provider: "fixture", id: "model" }, scheduledExecution: { version: 1, active: undefined, start: vi.fn() }, waitForIdle: vi.fn(async () => { order.push("idle"); }), extensionRunner: { onError: vi.fn(callback => { listener = callback; return () => { listener = undefined; }; }), emit: vi.fn(async () => { order.push("shutdown"); }) }, dispose: vi.fn(() => { order.push("disposed"); }) };
  vi.mocked(prepareModelSession).mockResolvedValue(session as any);
  const attempt: OwnedAttempt = { id: "before", revision: 1, owner: { sessionId: "logical-owner", instanceId: "instance", epoch: 2 }, occurrence: { id: "tick", revision: 1, source: "timer", dueAt: new Date().toISOString() }, admittedAt: new Date().toISOString(), deadlineMs: 10_000, workBudgetMs: 5000, model: "fixture/model", nativeSessionId: "schedule-synthetic" };
  const receipt: NativeExecutionProof = { version: 1, runId: "run", binding: { jobId: h.job.id, attemptId: attempt.id, ownerSessionId: "schedule-synthetic", ownerEpoch: attempt.owner.epoch, revision: attempt.revision }, finishedAt: new Date().toISOString(), execution: "deferred", checkpointEntryId: "checkpoint", effectStatus: "none-observed", businessOutcome: "unverified", failedRecoveryMs: 0 };
  return { ...h, order, session, manager, attempt, receipt, emitShutdownError: () => listener?.({ event: "session_shutdown", error: "synthetic shutdown rejection", extensionPath: "fixture" }), open: () => prepareScheduledModel(h.ctx, h.job, attempt, "fixture/model", () => order.push("bound")) };
}

 describe("read-only model planning and native transcript readback", () => {
  it("checks an old SDK declaration before any model/session preparation", () => {
    const h = fixture(); Object.defineProperty(AgentSession, "scheduledExecutionVersion", { configurable: true, value: undefined });
    const create = vi.spyOn(SessionManager, "create"); const open = vi.spyOn(SessionManager, "open");
    expect(() => planScheduledModel(h.ctx, h.job)).toThrow(/SDK lacks native/);
    expect(h.getAvailable).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });

  it("plans a continuation without constructing SDK session writers or changing one transcript byte", () => {
    const h = fixture(); Object.defineProperty(AgentSession, "scheduledExecutionVersion", { configurable: true, value: 1 });
    const create = vi.spyOn(SessionManager, "create"); const open = vi.spyOn(SessionManager, "open"); const bytes = fs.readFileSync(h.file);
    expect(planScheduledModel(h.ctx, h.job)).toEqual({ route: "fixture/model", checkpoint: h.job.runtime.continuation!.checkpoint });
    expect(create).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(fs.readFileSync(h.file)).toEqual(bytes);
    const reader = readStoredModelSession(h.cwd, "schedule-synthetic", h.file); const entry = reader.getEntry("checkpoint") as any; entry.data.declarations.nextAction = "caller mutation";
    expect((reader.getEntry("checkpoint") as any).data.declarations.nextAction).toBe("use-existing-result");
  });

  it("never repairs a malformed/partly written transcript while another exact native owner may still be alive", () => {
    const h = fixture(); fs.appendFileSync(h.file, '{"type":"custom","id":'); const bytes = fs.readFileSync(h.file);
    expect(() => readStoredModelSession(h.cwd, "schedule-synthetic", h.file)).toThrow();
    expect(fs.readFileSync(h.file)).toEqual(bytes);
  });

  it("rejects changed session identities, duplicate entries and incompatible future formats without rewriting history", () => {
    const h = fixture(); const bytes = fs.readFileSync(h.file);
    expect(() => readStoredModelSession(h.cwd, "different-session", h.file)).toThrow(/identity/); expect(fs.readFileSync(h.file)).toEqual(bytes);
    fs.appendFileSync(h.file, JSON.stringify(h.values[1]) + "\n"); const duplicated = fs.readFileSync(h.file);
    expect(() => readStoredModelSession(h.cwd, "schedule-synthetic", h.file)).toThrow(/duplicated/); expect(fs.readFileSync(h.file)).toEqual(duplicated);
    h.values[0].version = CURRENT_SESSION_VERSION + 1; fs.writeFileSync(h.file, h.values.map(value => JSON.stringify(value)).join("\n") + "\n"); const future = fs.readFileSync(h.file);
    expect(() => readStoredModelSession(h.cwd, "schedule-synthetic", h.file)).toThrow(/format/); expect(fs.readFileSync(h.file)).toEqual(future);
  });
});

describe("actual SDK close acknowledgement producer", () => {
  it("awaits SDK shutdown, disposes once and persists an exact ACK at the actual safe finish", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-03T00:00:00.000Z")); const h = sdkFixture();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); h.session.extensionRunner.emit.mockImplementationOnce(async () => { h.order.push("shutdown"); await gate; });
    const prepared = await h.open(); const closing = prepared.dispose(h.receipt); await Promise.resolve(); await Promise.resolve();
    expect(h.session.dispose).not.toHaveBeenCalled(); expect(h.manager.appendCustomEntry).not.toHaveBeenCalled();
    vi.setSystemTime(new Date("2026-11-03T00:03:00.000Z")); release(); const proof = await closing;
    expect(proof).toMatchObject({ runId: h.receipt.runId, binding: h.receipt.binding, checkpointEntryId: h.receipt.checkpointEntryId, closedAt: "2026-11-03T00:03:00.000Z" });
    expect(h.order).toEqual(["bound", "idle", "shutdown", "disposed", "idle", "ack"]); expect(h.manager.appendCustomEntry).toHaveBeenCalledWith(MODEL_SDK_CLOSE_ENTRY, proof);
    expect(readModelSdkClose(prepared.sessionManager, h.receipt)).toEqual(proof);
    expect(await prepared.dispose(h.receipt)).toEqual(proof); expect(h.session.dispose).toHaveBeenCalledOnce(); expect(h.manager.appendCustomEntry).toHaveBeenCalledOnce();
  });

  it("does not treat void dispose as an exit acknowledgement while the SDK loop is still alive", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-03T00:00:00.000Z")); const h = sdkFixture();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    h.session.waitForIdle.mockImplementationOnce(async () => undefined).mockImplementationOnce(async () => { await gate; });
    const prepared = await h.open(); const closing = prepared.dispose(h.receipt); for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(h.session.dispose).toHaveBeenCalledOnce(); expect(h.session.waitForIdle).toHaveBeenCalledTimes(2); expect(h.manager.appendCustomEntry).not.toHaveBeenCalled();
    vi.setSystemTime(new Date("2026-11-03T00:05:00.000Z")); release(); expect(await closing).toMatchObject({ closedAt: "2026-11-03T00:05:00.000Z" });
  });

  it("does not write ACK when the awaited shutdown rejects or reports its swallowed handler error", async () => {
    const h = sdkFixture(); h.session.extensionRunner.emit.mockImplementationOnce(async () => { h.emitShutdownError(); });
    const prepared = await h.open(); await expect(prepared.dispose(h.receipt)).rejects.toThrow(/shutdown handler failed/);
    expect(h.session.dispose).toHaveBeenCalledOnce(); expect(h.manager.appendCustomEntry).not.toHaveBeenCalled(); expect(readModelSdkClose(prepared.sessionManager, h.receipt)).toBeUndefined();
  });

  it("does not acknowledge a failed close-ACK write even after SDK disposal has returned", async () => {
    const h = sdkFixture(); h.manager.appendCustomEntry.mockImplementationOnce(() => { throw new Error("synthetic ACK write loss"); });
    const prepared = await h.open(); await expect(prepared.dispose(h.receipt)).rejects.toThrow(/ACK write loss/);
    expect(h.session.dispose).toHaveBeenCalledOnce(); expect(readModelSdkClose(prepared.sessionManager, h.receipt)).toBeUndefined();
  });

  it("rejects a foreign attempt/checkpoint instead of treating its native receipt as closure authority", async () => {
    const h = sdkFixture(); const prepared = await h.open();
    await expect(prepared.dispose({ ...h.receipt, binding: { ...h.receipt.binding, attemptId: "foreign" } })).rejects.toThrow(/different native attempt/);
    expect(h.session.waitForIdle).not.toHaveBeenCalled(); expect(h.session.dispose).not.toHaveBeenCalled(); expect(h.manager.appendCustomEntry).not.toHaveBeenCalled();
  });
});
