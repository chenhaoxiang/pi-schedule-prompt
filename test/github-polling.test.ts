import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubFingerprint } from "../src/github-events.js";
import { CronScheduler } from "../src/scheduler.js";
import { CronStorage } from "../src/storage.js";
import type { GithubTrigger } from "../src/types.js";

vi.mock("../src/github-events.js", () => ({ githubFingerprint: vi.fn() }));
const read = vi.mocked(githubFingerprint);
const owned: string[] = [];
beforeEach(() => { vi.useFakeTimers(); read.mockReset(); });
afterEach(() => { vi.useRealTimers(); for (const cwd of owned.splice(0)) fs.rmSync(cwd, { recursive: true, force: true }); });
function setup(github: GithubTrigger = { repo: "owner/repo", kind: "workflow", pollSeconds: 60 }) {
  const root = path.resolve("tmp/github-poll-fixtures"); fs.mkdirSync(root, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(root, "case-")); owned.push(cwd);
  const storage = new CronStorage(cwd);
  storage.addJob({ id: "gh", name: "gh", type: "event", prompt: "Inspect selected CI evidence", session: "owner", enabled: true, runCount: 0, createdAt: new Date().toISOString(), github, schedule: "github:" + github.kind });
  const pi = { sendMessage: vi.fn(), events: { emit: vi.fn() } };
  const ctx = { cwd, isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionId: () => "owner" } };
  const scheduler = new CronScheduler(storage, pi as any, ctx as any); scheduler.start();
  return { storage, pi, scheduler };
}

describe("bounded selected GitHub producers", () => {
  it("keeps exact-PR unchanged or unstable observations quiet, then dispatches only stable new evidence", async () => {
    read.mockResolvedValueOnce("a".repeat(64)).mockResolvedValueOnce("a".repeat(64)).mockRejectedValueOnce(new Error("PR head changed while reading")).mockResolvedValueOnce("b".repeat(64));
    const h = setup({ repo: "owner/repo", kind: "pull-request-checks", number: 42, pollSeconds: 60 });
    await vi.advanceTimersByTimeAsync(180000);
    expect(h.pi.sendMessage).toHaveBeenCalledOnce();
    expect(h.storage.getJob("gh")?.sourceFingerprint).toBe("a".repeat(64));
    await vi.advanceTimersByTimeAsync(120000);
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.storage.getJob("gh")?.sourceFingerprint).toBe("b".repeat(64));
    h.storage.updateJob("gh", { enabled: false }); h.scheduler.updateJob("gh", h.storage.getJob("gh")!);
    await vi.advanceTimersByTimeAsync(120000);
    expect(read).toHaveBeenCalledTimes(4); expect(h.pi.sendMessage).toHaveBeenCalledTimes(2);
    h.scheduler.stop();
  });
  it.each(["none", "latest"] as const)("preserves %s restart policy after initial PR-check notification", async catchUp => {
    read.mockResolvedValueOnce("a".repeat(64)).mockRejectedValueOnce(new Error("temporary unavailable")).mockResolvedValueOnce("b".repeat(64)).mockResolvedValueOnce("c".repeat(64));
    const h = setup({ repo: "owner/repo", kind: "pull-request-checks", number: 42, pollSeconds: 60 });
    h.storage.updateJob("gh", { catchUp });
    await vi.advanceTimersByTimeAsync(60000); expect(h.pi.sendMessage).toHaveBeenCalledOnce();
    h.scheduler.stop(); h.scheduler.start();
    await vi.advanceTimersByTimeAsync(180000);
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(catchUp === "none" ? 1 : 2);
    expect(h.storage.getJob("gh")?.sourceFingerprint).toBe("b".repeat(64));
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(catchUp === "none" ? 2 : 3);
    h.scheduler.stop();
  });

  it("does not lose the established PR baseline across a restart during failed reseeding", async () => {
    read.mockResolvedValueOnce("a".repeat(64)).mockRejectedValueOnce(new Error("temporary unavailable")).mockResolvedValueOnce("b".repeat(64)).mockResolvedValueOnce("c".repeat(64));
    const h = setup({ repo: "owner/repo", kind: "pull-request-checks", number: 42, pollSeconds: 60 });
    await vi.advanceTimersByTimeAsync(60000); expect(h.pi.sendMessage).toHaveBeenCalledOnce();
    h.scheduler.stop(); h.scheduler.start();
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.storage.getJob("gh")?.sourceFingerprint).toBe("a".repeat(64));
    h.scheduler.stop(); h.scheduler.start();
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.pi.sendMessage).toHaveBeenCalledOnce();
    expect(h.storage.getJob("gh")?.sourceFingerprint).toBe("b".repeat(64));
    await vi.advanceTimersByTimeAsync(60000); expect(h.pi.sendMessage).toHaveBeenCalledTimes(2);
    h.scheduler.stop();
  });

  it("preserves an outstanding silent reseed across metadata-only rearming", async () => {
    read.mockResolvedValueOnce("a".repeat(64)).mockResolvedValueOnce("b".repeat(64));
    const h = setup({ repo: "owner/repo", kind: "pull-request-checks", number: 42, pollSeconds: 60 });
    await vi.advanceTimersByTimeAsync(60000); expect(h.pi.sendMessage).toHaveBeenCalledOnce();
    h.scheduler.stop(); h.scheduler.start();
    const before = h.storage.getJob("gh")!;
    h.storage.updateJob("gh", { description: "Changed display note only" });
    expect(h.storage.getJob("gh")?.revision).toBe(before.revision);
    h.scheduler.updateJob("gh", h.storage.getJob("gh")!);
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.pi.sendMessage).toHaveBeenCalledOnce();
    expect(h.storage.getJob("gh")?.sourceFingerprint).toBe("b".repeat(64));
    h.scheduler.stop();
  });

  it("does not carry silent reseeding into a changed PR definition", async () => {
    read.mockResolvedValueOnce("a".repeat(64)).mockResolvedValueOnce("b".repeat(64));
    const h = setup({ repo: "owner/repo", kind: "pull-request-checks", number: 42, pollSeconds: 60 });
    await vi.advanceTimersByTimeAsync(60000);
    h.scheduler.stop(); h.scheduler.start();
    h.storage.updateJob("gh", { github: { repo: "owner/repo", kind: "pull-request-checks", number: 43, pollSeconds: 60 } });
    h.scheduler.updateJob("gh", h.storage.getJob("gh")!);
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1][0].number).toBe(43); h.scheduler.stop();
  });

  it.each(["resolve", "reject"])("fences an older in-flight GitHub %s across same-instance stop/start", async outcome => {
    let finish!: (value: string) => void;
    read.mockResolvedValueOnce("a".repeat(64)).mockImplementationOnce(() => new Promise((resolve, reject) => { finish = value => outcome === "resolve" ? resolve(value) : reject(new Error("stale failure")); })).mockResolvedValueOnce("c".repeat(64));
    const h = setup({ repo: "owner/repo", kind: "pull-request-checks", number: 42, pollSeconds: 60 });
    await vi.advanceTimersByTimeAsync(120000); expect(h.pi.sendMessage).toHaveBeenCalledOnce();
    h.scheduler.stop(); h.scheduler.start();
    finish("b".repeat(64)); await vi.advanceTimersByTimeAsync(0);
    expect(h.storage.getJob("gh")?.sourceFingerprint).toBe("a".repeat(64));
    expect(h.pi.sendMessage).toHaveBeenCalledOnce();
    expect(h.pi.events.emit.mock.calls.some(([, payload]) => payload?.type === "error")).toBe(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.storage.getJob("gh")?.sourceFingerprint).toBe("c".repeat(64));
    expect(h.pi.sendMessage).toHaveBeenCalledOnce(); h.scheduler.stop();
  });

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
