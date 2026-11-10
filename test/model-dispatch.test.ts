import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronScheduler } from "../src/scheduler.js";
import { CronStorage } from "../src/storage.js";
import { runSubagentOnce } from "../src/subagent.js";
import type { CronJob } from "../src/types.js";

vi.mock("../src/subagent.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/subagent.js")>(),
  runSubagentOnce: vi.fn(),
}));

const owned: string[] = [];
const schedulers: CronScheduler[] = [];
function fixture(extra: Partial<CronJob> = {}, idle = false, pending = false) {
  const root = path.resolve("tmp/model-dispatch-fixtures"); fs.mkdirSync(root, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(root, "case-")); owned.push(cwd);
  const storage = new CronStorage(cwd);
  const seed: CronJob = { id: "model", name: "model", type: "interval", schedule: "1s", intervalMs: 1000,
    prompt: "synthetic authorized model work", enabled: true, createdAt: new Date().toISOString(), runCount: 0,
    session: "owner", model: "fixture/model", durable: true, deadlineMs: 60_000, maxRuns: 3,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), catchUp: "latest", ...extra };
  storage.addJob(seed);
  const pi = { sendMessage: vi.fn(), appendEntry: vi.fn(), events: { emit: vi.fn() } };
  const model = { provider: "fixture", id: "model", name: "Fixture" };
  const ctx = { cwd, abort: vi.fn(), isIdle: () => idle, hasPendingMessages: () => pending,
    modelRegistry: { getAvailable: () => [model], find: () => model },
    sessionManager: { getSessionId: () => "owner", getEntries: () => [] } };
  const scheduler = new CronScheduler(storage, pi as any, ctx as any); schedulers.push(scheduler);
  return { storage, scheduler, pi, ctx, seed, idle: () => { idle = true; pending = false; scheduler.onAgentSettled(); } };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(runSubagentOnce).mockReset().mockResolvedValue({ ok: true, text: "synthetic result" });
});
afterEach(() => {
  for (const scheduler of schedulers.splice(0)) scheduler.stop();
  vi.useRealTimers();
  for (const cwd of owned.splice(0)) fs.rmSync(cwd, { recursive: true, force: true });
});

describe("explicit model dispatch is independent of parent activity", () => {
  it.each([[false, false], [true, true], [false, true]])("runs a durable timer with parent idle=%s, pending=%s", async (idle, pending) => {
    const h = fixture({}, idle, pending);
    h.scheduler.start(); await vi.advanceTimersByTimeAsync(1200);
    expect(runSubagentOnce).toHaveBeenCalledOnce();
    expect(h.storage.getJob("model")).toMatchObject({ attemptCount: 1, runCount: 1, claim: { outcome: "success" } });
    expect(h.ctx.abort).not.toHaveBeenCalled();
    expect(h.pi.sendMessage.mock.calls.every(([, options]) => options?.triggerTurn === false)).toBe(true);
  });

  it.each([false, true])("does not let an older pending inline event starve a model event, durable=%s", async durable => {
    let finish!: (result: { ok: true; text: string }) => void;
    vi.mocked(runSubagentOnce).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const h = fixture({ type: "event", schedule: "local:build", intervalMs: undefined, durable }, false, true);
    h.storage.addJob({ ...h.seed, id: "inline", name: "inline", model: undefined, durable: false });
    h.scheduler.start();
    h.scheduler.receiveEvent("inline", "local:build", "inline-first");
    h.scheduler.receiveEvent("model", "local:build", "model-first");
    h.scheduler.receiveEvent("model", "local:build", "model-next");
    await vi.advanceTimersByTimeAsync(2200);
    expect(runSubagentOnce).toHaveBeenCalledOnce();
    expect(h.storage.getJob("inline")?.attemptCount ?? 0).toBe(0);
    expect(h.storage.getJob("model")?.pendingEvent).toBeDefined();
    finish({ ok: true, text: "synthetic result" }); await vi.advanceTimersByTimeAsync(1200);
    expect(runSubagentOnce).toHaveBeenCalledTimes(2);
    expect(h.storage.getJob("model")).toMatchObject({ attemptCount: 2, runCount: 2 });
    expect(h.ctx.abort).not.toHaveBeenCalled();
    expect(h.pi.sendMessage.mock.calls.every(([, options]) => options?.triggerTurn === false)).toBe(true);
    h.idle(); await vi.advanceTimersByTimeAsync(1200);
    expect(h.storage.getJob("inline")?.attemptCount).toBe(1);
  });

  it.each([{ maxRuns: 1, attemptCount: 1 }, { expiresAt: new Date(0).toISOString() }])("does not bypass original admission bounds %j", async bounds => {
    const h = fixture(bounds); h.scheduler.start(); await vi.advanceTimersByTimeAsync(2200);
    expect(runSubagentOnce).not.toHaveBeenCalled();
    expect(h.storage.getJob("model")?.enabled).toBe(false);
  });

  it("preserves a post-dispatch UNKNOWN instead of replaying through the busy-parent path", async () => {
    const h = fixture(); h.storage.queueTime("model", "owner");
    const claimed = h.storage.claimJob("model", "owner", "previous-owner")!;
    h.storage.markClaim("model", claimed.claim!.id, "dispatched");
    h.storage.updateJob("model", { claim: { ...h.storage.getJob("model")!.claim!, ownerPid: 2147483646 } });
    h.scheduler.start(); await vi.advanceTimersByTimeAsync(2200);
    expect(runSubagentOnce).not.toHaveBeenCalled();
    expect(h.storage.getJob("model")).toMatchObject({ enabled: false, attemptCount: 1, claim: { outcome: "unknown" } });
  });

  it("keeps inline work queued while the parent only has pending messages", async () => {
    const h = fixture({ model: undefined }, true, true);
    h.scheduler.start(); await vi.advanceTimersByTimeAsync(2200);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    expect(h.storage.getJob("model")?.attemptCount ?? 0).toBe(0);
    h.idle(); await vi.advanceTimersByTimeAsync(250);
    expect(h.pi.sendMessage).toHaveBeenCalledOnce();
    expect(h.pi.sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(runSubagentOnce).not.toHaveBeenCalled();
  });
});
