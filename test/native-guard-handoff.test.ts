import { describe, expect, it } from "vitest";
import schedule from "../src/index.js";

type Handler = (...args: unknown[]) => unknown;
async function fixture(options: { guard?: number; missing?: boolean; exact?: boolean; unsubscribe?: boolean; throwing?: boolean } = {}) {
  const handlers = new Map<string, Handler[]>();
  const pi = { on: (name: string, handler: Handler) => { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); return options.unsubscribe === false ? undefined : () => { const index = list.indexOf(handler); if (index >= 0) list.splice(index, 1); }; }, registerTool: () => {}, registerCommand: () => {}, registerMessageRenderer: () => {}, events: { on: () => () => {} } };
  await schedule(pi as never);
  const binding = { jobId: "job", attemptId: "attempt", ownerSessionId: "owner", ownerEpoch: 1, revision: 1 };
  const event = { messageType: "custom", message: { customType: "scheduled_prompt", details: { ...binding, nativeRunId: options.exact === false ? "foreign" : "run" } } };
  const ctx = { scheduledExecution: { version: 1, unattendedInputGuardVersion: options.missing ? undefined : options.guard ?? 1, start: () => {}, active: { runId: "run", snapshot: () => { if (options.throwing) throw new Error("unknown snapshot"); return { binding }; } } } };
  return { handlers, event, ctx, emit: (name: string, ...args: unknown[]) => { for (const handler of [...(handlers.get(name) ?? [])]) handler(...args); } };
}

describe("native legacy-guard handoff", () => {
  it("detaches only its own guard for an exact protected run and restores it after native settlement", async () => {
    const h = await fixture(); const thirdParty = () => {}; h.handlers.get("tool_call")!.push(thirdParty);
    h.emit("before_agent_start", h.event, h.ctx); expect(h.handlers.get("tool_call")).toEqual([thirdParty]);
    h.emit("agent_settled", { aborted: false }); expect(h.handlers.get("tool_call")).toHaveLength(2);
    h.emit("agent_settled", { aborted: false }); expect(h.handlers.get("tool_call")).toHaveLength(2);
  });
  it.each([{ guard: 0 }, { missing: true }, { exact: false }, { unsubscribe: false }, { throwing: true }])("keeps safety for unsupported/unconfirmed %j", async options => {
    const h = await fixture(options); h.emit("before_agent_start", h.event, h.ctx); expect(h.handlers.get("tool_call")).toHaveLength(1);
  });
  it("restores the legacy guard on ordinary work without changing other handlers", async () => {
    const h = await fixture(); h.emit("before_agent_start", h.event, h.ctx); expect(h.handlers.get("tool_call")).toHaveLength(0);
    h.emit("before_agent_start", { messageType: "user", message: {} }, {}); expect(h.handlers.get("tool_call")).toHaveLength(1);
  });
});
