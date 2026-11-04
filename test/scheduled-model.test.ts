import * as fs from "node:fs";
import * as path from "node:path";
import { AgentSession, CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resilientDefinition } from "../src/resilient-policy.js";
import { planScheduledModel, readStoredModelSession } from "../src/scheduled-model.js";
import type { ResilientJob } from "../src/types.js";

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
afterEach(() => {
  vi.restoreAllMocks();
  if (original) Object.defineProperty(AgentSession, "scheduledExecutionVersion", original);
  else Reflect.deleteProperty(AgentSession, "scheduledExecutionVersion");
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

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
