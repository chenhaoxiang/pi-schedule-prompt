import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventBinding } from "../src/events.js";
import { CronScheduler } from "../src/scheduler.js";
import { CronStorage } from "../src/storage.js";
import { runSubagentOnce } from "../src/subagent.js";
import type { CronJob } from "../src/types.js";

vi.mock("../src/subagent.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/subagent.js")>(),
  runSubagentOnce: vi.fn(async () => ({ ok: true, text: "synthetic result" })),
}));

const owned: string[] = [];
const schedulers: CronScheduler[] = [];
const model = { provider: "fixture", id: "haiku-model", name: "Fixture Haiku" };
function fixture(extra: Partial<CronJob> = {}) {
  const base = path.resolve("tmp/model-preflight-recovery");
  fs.mkdirSync(base, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(base, "case-"));
  owned.push(cwd);
  const storage = new CronStorage(cwd);
  storage.addJob({ id: "one", name: "one", type: "interval", schedule: "1h", intervalMs: 3600000,
    enabled: true, prompt: "synthetic check", createdAt: new Date().toISOString(), runCount: 0,
    session: "owner", model: "haiku", catchUp: "latest", ...extra });
  let idle = false;
  const pi = { sendMessage: vi.fn(), appendEntry: vi.fn(), events: { emit: vi.fn() } };
  const ctx = { cwd, abort: vi.fn(), isIdle: () => idle, hasPendingMessages: () => false,
    modelRegistry: { getAvailable: () => [model], find: () => model },
    sessionManager: { getSessionId: () => "owner", getEntries: () => [] } };
  const scheduler = new CronScheduler(storage, pi as any, ctx as any);
  schedulers.push(scheduler);
  return { storage, pi, scheduler, release: () => { idle = true; scheduler.onAgentSettled(); } };
}

beforeEach(() => { vi.useFakeTimers(); vi.mocked(runSubagentOnce).mockClear(); });
afterEach(() => {
  for (const scheduler of schedulers.splice(0)) scheduler.stop();
  vi.useRealTimers();
  for (const cwd of owned.splice(0)) fs.rmSync(cwd, { recursive: true, force: true });
});

describe("real-store restored model alias preflight", () => {
  it("restores an accepted event exactly once without invalidating its binding or dedup key", async () => {
    const h = fixture({ type: "event", schedule: "local:build", intervalMs: undefined });
    expect(h.storage.queueEvent("one", "local:build", "original", "owner").status).toBe("queued");
    const before = h.storage.getJob("one")!;
    h.scheduler.start();
    expect(h.storage.getJob("one")?.pendingEvent).toEqual(before.pendingEvent);
    expect(h.storage.getJob("one")?.revision).toBe(before.revision);
    h.release();
    await vi.advanceTimersByTimeAsync(1200);
    expect(runSubagentOnce).toHaveBeenCalledTimes(1);
    expect(h.storage.getJob("one")).toMatchObject({ attemptCount: 1, runCount: 1 });
    expect(h.scheduler.receiveEvent("one", "local:build", "original").status).toBe("duplicate");
    await vi.advanceTimersByTimeAsync(1200);
    expect(runSubagentOnce).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("retains durable intent and nextRun with dead pre-dispatch claim=%s", async deadClaim => {
    const h = fixture({ durable: true });
    const nextRun = new Date(Date.now() + 3600000).toISOString();
    h.storage.queueTime("one", "owner", nextRun);
    if (deadClaim) {
      const claimed = h.storage.claimJob("one", "owner", "previous-owner")!;
      // Synthetic nonexistent PID; never signal a live process.
      h.storage.updateJob("one", { claim: { ...claimed.claim!, ownerPid: 2147483646 } });
    }
    const revision = h.storage.getJob("one")!.revision;
    h.scheduler.start();
    const restored = h.storage.getJob("one")!;
    expect(restored.pendingIntent).toMatchObject({ revision, binding: eventBinding(restored) });
    expect(restored.nextRun).toBe(nextRun);
    expect(restored.attemptCount ?? 0).toBe(0);
    h.release();
    await vi.advanceTimersByTimeAsync(1200);
    expect(runSubagentOnce).toHaveBeenCalledTimes(1);
    expect(h.storage.getJob("one")).toMatchObject({ attemptCount: 1, runCount: 1, claim: { outcome: "success" } });
    await vi.advanceTimersByTimeAsync(1200);
    expect(runSubagentOnce).toHaveBeenCalledTimes(1);
  });

  it("preserves unknown post-dispatch evidence without replay", async () => {
    const h = fixture({ durable: true });
    h.storage.queueTime("one", "owner");
    const claimed = h.storage.claimJob("one", "owner", "previous-owner")!;
    h.storage.markClaim("one", claimed.claim!.id, "dispatched");
    h.storage.updateJob("one", { claim: { ...h.storage.getJob("one")!.claim!, ownerPid: 2147483646 } });
    h.scheduler.start();
    h.release();
    await vi.advanceTimersByTimeAsync(1200);
    expect(h.storage.getJob("one")).toMatchObject({ enabled: false, attemptCount: 1, claim: { outcome: "unknown" } });
    expect(runSubagentOnce).not.toHaveBeenCalled();
  });
});
