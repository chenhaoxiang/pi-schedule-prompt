import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventBinding } from "../src/events.js";
import { CronScheduler } from "../src/scheduler.js";
import { CronStorage } from "../src/storage.js";
import { runSubagentOnce } from "../src/subagent.js";
import { createCronTool } from "../src/tool.js";

vi.mock("../src/subagent.js", () => ({ runSubagentOnce: vi.fn() }));

import type { CronJob } from "../src/types.js";

const owned: string[] = [];
function setup(overrides: Partial<CronJob> = {}) {
  const root = path.resolve("tmp/event-fixtures");
  fs.mkdirSync(root, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(root, "case-")); owned.push(cwd);
  const storage = new CronStorage(cwd);
  storage.addJob({ id: "event", name: "event", type: "event", schedule: "local:build", prompt: "configured authorized prompt", enabled: true,
    createdAt: new Date().toISOString(), runCount: 0, session: "owner", ...overrides });
  let idle = false;
  const pi = { sendMessage: vi.fn(), events: { emit: vi.fn() } };
  const ctx = { cwd, isIdle: () => idle, hasPendingMessages: () => false, sessionManager: { getSessionId: () => "owner" } };
  const scheduler = new CronScheduler(storage, pi as any, ctx as any); scheduler.start();
  return { storage, pi, ctx, scheduler, idle: () => { idle = true; scheduler.onAgentSettled(); } };
}
beforeEach(() => { vi.mocked(runSubagentOnce).mockReset(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-20T12:00:00Z")); });
afterEach(() => { vi.useRealTimers(); for (const cwd of owned.splice(0)) fs.rmSync(cwd, { recursive: true, force: true }); });

describe("unified event admission", () => {
  it("creates and triggers event jobs through the existing tool with daily limits", async () => {
    const h = setup();
    const tool = createCronTool(() => h.storage, () => h.scheduler);
    const created = await tool.execute("call", { action: "add", name: "second", type: "event", schedule: "local:test", prompt: "bounded check", maxRunsPerDay: 2, catchUp: "latest" }, undefined, undefined, h.ctx as any);
    expect(created.isError).not.toBe(true);
    expect(created.details?.jobs[0].maxRunsPerDay).toBe(2);
    const triggered = await tool.execute("call", { action: "trigger", jobId: created.details!.jobId, eventName: "local:test", eventId: "once" }, undefined, undefined, h.ctx as any);
    expect(triggered.content[0]).toEqual({ type: "text", text: "Event queued" });
    h.idle(); expect(h.pi.sendMessage).toHaveBeenCalledTimes(1); h.scheduler.stop();
  });

  it("retains the next coalesced event while the same model job is still active", async () => {
    let finish!: (value: { ok: true; text: string }) => void;
    const run = vi.mocked(runSubagentOnce);
    run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ ok: true, text: "done" });
    const h = setup({ model: "fixture" }); h.idle();
    h.scheduler.receiveEvent("event", "local:build", "one");
    h.scheduler.receiveEvent("event", "local:build", "two");
    expect(run).toHaveBeenCalledTimes(1);
    expect(h.storage.getJob("event")?.pendingEvent).toBeDefined();
    finish({ ok: true, text: "done" }); await vi.advanceTimersByTimeAsync(1200);
    expect(run).toHaveBeenCalledTimes(2);
    expect(h.storage.getJob("event")?.attemptCount).toBe(2); h.scheduler.stop();
  });

  it("coalesces pending events, persists dedup and dispatches only the configured prompt", () => {
    const h = setup();
    expect(h.scheduler.receiveEvent("event", "local:build", "one").status).toBe("queued");
    expect(h.scheduler.receiveEvent("event", "local:build", "one").status).toBe("duplicate");
    expect(h.scheduler.receiveEvent("event", "local:build", "two").status).toBe("queued");
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    h.idle();
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.pi.sendMessage.mock.calls[0][0].content).toBe("configured authorized prompt");
    expect(h.storage.getJob("event")?.attemptCount).toBe(1);
    expect(h.storage.queueEvent("event", "local:build", "two", "owner").status).toBe("duplicate");
    expect(h.storage.getJob("event")?.pendingEvent).toBeUndefined();
    h.scheduler.stop();
  });

  it.each(["paused", "expired", "foreign", "mismatch"])("does not admit %s events", kind => {
    const h = setup(kind === "expired" ? { expiresAt: "2026-10-20T11:00:00Z" } : kind === "paused" ? { enabled: false } : kind === "foreign" ? { session: "other" } : {});
    const result = h.scheduler.receiveEvent("event", kind === "mismatch" ? "local:other" : "local:build", "id");
    expect(result.status).toBe("ignored");
    h.idle(); expect(h.pi.sendMessage).not.toHaveBeenCalled(); h.scheduler.stop();
  });

  it("enforces the daily cap across event and timer admission, then resets at UTC midnight", () => {
    const h = setup({ maxRunsPerDay: 1 }); h.idle();
    h.scheduler.receiveEvent("event", "local:build", "one");
    expect(h.scheduler.receiveEvent("event", "local:build", "two")).toEqual({ status: "ignored", reason: "daily-limit" });
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
    h.scheduler.receiveEvent("event", "local:build", "two");
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.storage.getJob("event")?.dailyUsage).toEqual({ day: "2026-10-21", attempts: 1 }); h.scheduler.stop();
  });

  it("applies the same UTC daily cap to timed inline jobs", async () => {
    const h = setup({ type: "interval", schedule: "1s", intervalMs: 1000, maxRunsPerDay: 1 });
    h.idle(); await vi.advanceTimersByTimeAsync(2500);
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.storage.getJob("event")?.lastStatus).toBe("skipped");
    expect(h.storage.getJob("event")?.enabled).toBe(true);
    vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(2); h.scheduler.stop();
  });

  it("discards events invalidated by a definition update or manual binding drift", () => {
    const h = setup(); h.scheduler.receiveEvent("event", "local:build", "one");
    const store = h.storage.load(); store.jobs[0].prompt = "hand edited prompt";
    fs.writeFileSync(h.storage.getStorePath(), JSON.stringify(store));
    h.idle();
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    expect(h.storage.getJob("event")?.pendingEvent).toBeUndefined(); h.scheduler.stop();
  });

  it.each(["none", "latest"] as const)("restores only the explicit %s event policy", async catchUp => {
    const h = setup({ catchUp }); h.scheduler.receiveEvent("event", "local:build", "one"); h.scheduler.stop();
    const next = new CronScheduler(h.storage, h.pi as any, { ...h.ctx, isIdle: () => true } as any);
    next.start(); await vi.advanceTimersByTimeAsync(1200);
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(catchUp === "latest" ? 1 : 0);
    expect(h.storage.getJob("event")?.pendingEvent).toBeUndefined(); next.stop();
  });

  it("bounds dedup history and serializes two local producers", () => {
    const h = setup();
    for (let index = 0; index < 160; index++) h.storage.queueEvent("event", "local:build", "e" + index, "owner");
    expect(h.storage.getJob("event")?.recentEventKeys).toHaveLength(128);
    const second = new CronStorage(h.ctx.cwd);
    expect(second.queueEvent("event", "local:build", "e159", "owner").status).toBe("duplicate"); h.scheduler.stop();
  });

  it("seeds GitHub safely and atomically persists only later changes as an intent", () => {
    const h = setup({ schedule: "github:pull-request", github: { repo: "owner/repo", kind: "pull-request", number: 1 } });
    const job = h.storage.getJob("event")!;
    expect(h.storage.observeGithub(job.id, job.revision!, "a".repeat(64), "owner", eventBinding(job)).reason).toBe("seeded");
    expect(h.storage.getJob("event")?.pendingEvent).toBeUndefined();
    expect(h.storage.observeGithub(job.id, job.revision!, "b".repeat(64), "owner", eventBinding(job)).status).toBe("queued");
    expect(h.storage.getJob("event")?.pendingEvent).toBeDefined(); h.scheduler.stop();
  });

  it("does not spend attempts on duplicate/locked admission and writes version2", () => {
    const h = setup();
    fs.writeFileSync(h.storage.getStorePath() + ".lock", "other");
    expect(() => h.scheduler.receiveEvent("event", "local:build", "one")).toThrow(/busy/);
    fs.rmSync(h.storage.getStorePath() + ".lock");
    expect(h.storage.getJob("event")?.attemptCount).toBeUndefined();
    expect(h.storage.load().version).toBe(2); h.scheduler.stop();
  });
});
