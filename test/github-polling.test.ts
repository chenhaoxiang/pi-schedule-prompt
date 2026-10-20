import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubFingerprint } from "../src/github-events.js";
import { CronScheduler } from "../src/scheduler.js";
import { CronStorage } from "../src/storage.js";

vi.mock("../src/github-events.js", () => ({ githubFingerprint: vi.fn() }));
const read = vi.mocked(githubFingerprint);
const owned: string[] = [];
beforeEach(() => { vi.useFakeTimers(); read.mockReset(); });
afterEach(() => { vi.useRealTimers(); for (const cwd of owned.splice(0)) fs.rmSync(cwd, { recursive: true, force: true }); });
function setup() {
  const root = path.resolve("tmp/github-poll-fixtures"); fs.mkdirSync(root, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(root, "case-")); owned.push(cwd);
  const storage = new CronStorage(cwd);
  storage.addJob({ id: "gh", name: "gh", type: "event", schedule: "github:workflow", prompt: "Inspect selected CI evidence", session: "owner", enabled: true, runCount: 0, createdAt: new Date().toISOString(), github: { repo: "owner/repo", kind: "workflow", pollSeconds: 60 } });
  const pi = { sendMessage: vi.fn(), events: { emit: vi.fn() } };
  const ctx = { cwd, isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionId: () => "owner" } };
  const scheduler = new CronScheduler(storage, pi as any, ctx as any); scheduler.start();
  return { storage, pi, scheduler };
}

describe("bounded selected GitHub producers", () => {
  it("seeds without inference and wakes only on the later metadata change", async () => {
    read.mockResolvedValueOnce("a".repeat(64)).mockResolvedValueOnce("b".repeat(64));
    const h = setup();
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.pi.sendMessage).toHaveBeenCalledOnce();
    expect(h.storage.getJob("gh")?.sourceFingerprint).toBe("b".repeat(64));
    h.scheduler.stop();
  });

  it("does not dispatch a stale response after disable/reload", async () => {
    let finish!: (value: string) => void;
    read.mockResolvedValueOnce("a".repeat(64)).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const h = setup(); await vi.advanceTimersByTimeAsync(120000);
    h.storage.updateJob("gh", { enabled: false });
    h.scheduler.updateJob("gh", h.storage.getJob("gh")!);
    finish("b".repeat(64)); await vi.advanceTimersByTimeAsync(0);
    expect(h.pi.sendMessage).not.toHaveBeenCalled(); h.scheduler.stop();
  });

  it("backs off unavailable reads and stops future polls on pause", async () => {
    read.mockRejectedValue(new Error("fixture unavailable"));
    const h = setup(); await vi.advanceTimersByTimeAsync(60000);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000); expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000); expect(read).toHaveBeenCalledTimes(2);
    h.storage.updateJob("gh", { enabled: false }); h.scheduler.updateJob("gh", h.storage.getJob("gh")!);
    await vi.advanceTimersByTimeAsync(600000); expect(read).toHaveBeenCalledTimes(2);
    expect(h.pi.sendMessage).not.toHaveBeenCalled(); h.scheduler.stop();
  });
});
