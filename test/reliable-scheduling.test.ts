import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronScheduler } from "../src/scheduler.js";
import { CronStorage } from "../src/storage.js";
import { createCronTool } from "../src/tool.js";
import type { CronJob } from "../src/types.js";

vi.mock("../src/subagent.js", () => ({ runSubagentOnce: vi.fn() }));

const root = path.resolve("tmp/reliable-scheduling-fixtures");
const owned: string[] = [];
function fixture() {
  fs.mkdirSync(root, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(root, "case-"));
  owned.push(cwd);
  return cwd;
}
function job(overrides: Partial<CronJob> = {}): CronJob {
  return { id: "one", name: "check", type: "interval", schedule: "1s", intervalMs: 1000,
    prompt: "check the authorized task", enabled: true, createdAt: new Date().toISOString(),
    runCount: 0, session: "owner", ...overrides };
}
function harness(seed = job()) {
  const storage = new CronStorage(fixture());
  storage.addJob(seed);
  let idle = false;
  const pi = { sendMessage: vi.fn(), sendUserMessage: vi.fn(), events: { emit: vi.fn() } };
  const ctx = { cwd: path.dirname(path.dirname(storage.getStorePath())),
    isIdle: () => idle, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => "owner" } };
  const scheduler = new CronScheduler(storage, pi as any, ctx as any);
  return { storage, pi, ctx, scheduler, setIdle: (v: boolean) => { idle = v; if (v) scheduler.onAgentSettled(); } };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  for (const dir of owned.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("native inline delivery", () => {
  it("coalesces repeated busy ticks into one native custom turn, never a synthetic user prompt", async () => {
    const h = harness();
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(3500);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    expect(h.storage.getJob("one")?.lastStatus).toBe("queued");
    h.setIdle(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
    const [message, options] = h.pi.sendMessage.mock.calls[0];
    expect(message.customType).toBe("scheduled_prompt");
    expect(message.content).toContain("check the authorized task");
    expect(options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(h.storage.getJob("one")?.lastStatus).toBe("dispatched");
    expect(h.storage.getJob("one")?.runCount).toBe(1);
    h.scheduler.stop();
  });

  it.each(["disable", "remove", "stop"])("drops a pending fire on %s", async (action) => {
    const h = harness();
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(1200);
    if (action === "disable") {
      h.storage.updateJob("one", { enabled: false });
      h.scheduler.updateJob("one", h.storage.getJob("one")!);
    } else if (action === "remove") {
      h.storage.removeJob("one");
      h.scheduler.removeJob("one");
    } else h.scheduler.stop();
    h.setIdle(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    h.scheduler.stop();
  });

  it("uses the latest persisted prompt instead of a stale timer closure", async () => {
    const h = harness();
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(1100);
    h.storage.updateJob("one", { prompt: "latest authorized check" });
    h.setIdle(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(h.pi.sendMessage.mock.calls[0][0].content).toContain("latest authorized check");
    h.scheduler.stop();
  });

  it("does not lose a one-shot that becomes due while busy", async () => {
    const h = harness(job({ type: "once", schedule: new Date(Date.now() + 1000).toISOString() }));
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(1300);
    expect(h.storage.getJob("one")?.enabled).toBe(true);
    h.setIdle(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.storage.getJob("one")?.enabled).toBe(false);
    h.scheduler.stop();
  });

  it("re-checks the expiry while waiting", async () => {
    const h = harness(job({ expiresAt: new Date(Date.now() + 1500).toISOString() }));
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(2000);
    h.setIdle(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    expect(h.storage.getJob("one")?.enabled).toBe(false);
    h.scheduler.stop();
  });

  it("does not fire after the lifetime attempt limit", async () => {
    const h = harness(job({ maxRuns: 1, attemptCount: 1 }));
    h.setIdle(true);
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    expect(h.storage.getJob("one")?.enabled).toBe(false);
    h.scheduler.stop();
  });
});

describe("storage and session management", () => {
  it("retries pre-dispatch writer contention without pausing or spending an attempt", async () => {
    const h = harness();
    h.setIdle(true);
    h.scheduler.start();
    fs.writeFileSync(`${h.storage.getStorePath()}.lock`, "other writer");
    await vi.advanceTimersByTimeAsync(1200);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    expect(h.storage.getJob("one")?.enabled).toBe(true);
    expect(h.storage.getJob("one")?.attemptCount).toBeUndefined();
    fs.rmSync(`${h.storage.getStorePath()}.lock`);
    h.scheduler.onAgentSettled();
    await vi.advanceTimersByTimeAsync(250);
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(1);
    h.scheduler.stop();
  });

  it("does not arm new timers while stopped (batch/print mode)", async () => {
    const h = harness();
    h.scheduler.stop();
    h.scheduler.addJob(h.storage.getJob("one")!);
    h.setIdle(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    expect(h.scheduler.getNextRun("one")).toBeNull();
  });

  it("serializes lifetime admission across storage instances", () => {
    const h = harness(job({ maxRuns: 1 }));
    const second = new CronStorage(h.ctx.cwd);
    expect(h.storage.admitJob("one", "owner")?.attemptCount).toBe(1);
    expect(second.admitJob("one", "owner")).toBeUndefined();
    expect(h.storage.getJob("one")?.attemptCount).toBe(1);
  });

  it("rejects a rename collision without losing the original records", () => {
    const h = harness();
    h.storage.addJob(job({ id: "two", name: "second" }));
    expect(() => h.storage.updateJob("one", { name: "second" })).toThrow(/Duplicate/);
    expect(h.storage.getJob("one")?.name).toBe("check");
  });

  it("pauses ambiguous host delivery instead of automatically retrying", async () => {
    const h = harness();
    h.pi.sendMessage.mockImplementation(() => { throw new Error("delivery outcome unknown"); });
    h.setIdle(true);
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.storage.getJob("one")?.enabled).toBe(false);
    expect(h.storage.getJob("one")?.lastStatus).toBe("unknown");
    h.scheduler.stop();
  });

  it("preserves corrupted bytes instead of silently overwriting an empty store", () => {
    const storage = new CronStorage(fixture());
    fs.mkdirSync(path.dirname(storage.getStorePath()));
    fs.writeFileSync(storage.getStorePath(), "not-json");
    expect(() => storage.addJob(job())).toThrow();
    expect(fs.readFileSync(storage.getStorePath(), "utf8")).toBe("not-json");
  });

  it("refuses a conflicting writer without losing jobs", () => {
    const storage = new CronStorage(fixture());
    storage.addJob(job());
    fs.writeFileSync(`${storage.getStorePath()}.lock`, "another writer");
    expect(() => storage.addJob(job({ id: "two", name: "second" }))).toThrow(/lock|busy/i);
    expect(storage.getAllJobs().map(j => j.id)).toEqual(["one"]);
  });

  it("writes task files privately and preserves unrelated jobs", () => {
    const cwd = fixture();
    const a = new CronStorage(cwd);
    const b = new CronStorage(cwd);
    a.addJob(job());
    b.addJob(job({ id: "two", name: "second", session: "other" }));
    a.updateJob("one", { enabled: false });
    expect(b.getJob("two")?.session).toBe("other");
    expect(fs.statSync(a.getStorePath()).mode & 0o777).toBe(0o600);
  });

  it.each(["remove", "disable", "enable", "update"])("rejects foreign-session %s", async (action) => {
    const h = harness(job({ session: "other" }));
    const tool = createCronTool(() => h.storage, () => h.scheduler);
    const result = await tool.execute("call", { action, jobId: "one", prompt: "overwrite" } as any,
      undefined, undefined, h.ctx as any);
    expect(result.isError).toBe(true);
    expect(h.storage.getJob("one")?.prompt).toBe("check the authorized task");
    h.scheduler.stop();
  });
});
