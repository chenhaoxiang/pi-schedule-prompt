import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DurableExecution } from "../src/durable.js";
import { CronScheduler } from "../src/scheduler.js";
import { CronStorage } from "../src/storage.js";
import type { CronJob, ExecutionReceipt } from "../src/types.js";

const owned: string[] = [];
const seed = (extra: Partial<CronJob> = {}): CronJob => ({ id: "one", name: "one", type: "interval", schedule: "1s", intervalMs: 1000, enabled: true, prompt: "authorized check", createdAt: new Date().toISOString(), runCount: 0, session: "owner", durable: true, catchUp: "latest", ...extra });
function fixture(extra: Partial<CronJob> = {}) {
  const base = path.resolve("tmp/durable-fixtures"); fs.mkdirSync(base, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(base, "case-")); owned.push(cwd);
  const storage = new CronStorage(cwd); storage.addJob(seed(extra));
  const receipts: ExecutionReceipt[] = [];
  const pi = { sendMessage: vi.fn(), appendEntry: vi.fn((type, data) => { if (type === "schedule_execution") receipts.push(data); }), events: { emit: vi.fn() } };
  const ctx = { cwd, hasUI: true, ui: { notify: vi.fn() }, abort: vi.fn(), isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => "owner", getEntries: () => [] } };
  return { cwd, storage, pi, ctx, receipts, durable: new DurableExecution(storage, pi as any, ctx as any) };
}
function claimed(h: ReturnType<typeof fixture>) {
  h.storage.queueTime("one", "owner"); return h.storage.claimJob("one", "owner", "old-owner")!.claim!;
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); for (const cwd of owned.splice(0)) fs.rmSync(cwd, { recursive: true, force: true }); });

describe("durable intent/claim recovery", () => {
  it("keeps one latest pending time intent through restart, not a backlog", () => {
    const h = fixture();
    h.storage.queueTime("one", "owner"); h.storage.queueTime("one", "owner");
    const second = new CronStorage(h.cwd);
    expect(second.getJob("one")?.pendingIntent?.binding).toMatch(/^[a-f0-9]{64}$/);
    expect(second.claimJob("one", "owner", "first")?.attemptCount).toBe(1);
    expect(second.claimJob("one", "owner", "second")).toBeUndefined();
    expect(h.storage.admitJob("one", "owner")).toBeUndefined();
  });
  it("restores only provably pre-dispatch dead-owner claims", () => {
    const h = fixture({ maxRuns: 1 }); const claim = claimed(h);
    h.storage.reconcileJob("one", "owner", "new-owner", [], () => false);
    expect(h.storage.getJob("one")?.claim).toBeUndefined();
    expect(h.storage.getJob("one")?.pendingIntent).toBeDefined();
    expect(h.storage.claimJob("one", "owner", "new-owner")?.claim?.id).not.toBe(claim.id);
  });
  it.each(["dispatched", "started"] as const)("pauses missing receipt after %s instead of replaying", phase => {
    const h = fixture(); const claim = claimed(h); h.storage.markClaim("one", claim.id, "dispatched"); h.storage.markClaim("one", claim.id, phase);
    h.storage.reconcileJob("one", "owner", "new-owner", [], () => false);
    expect(h.storage.getJob("one")).toMatchObject({ enabled: false, lastStatus: "unknown", claim: { outcome: "unknown" }, notice: { state: "pending" } });
    h.storage.updateJob("one", { enabled: true }); h.storage.queueTime("one", "owner");
    expect(h.storage.claimJob("one", "owner", "new-owner")).toBeUndefined();
  });
  it("reconciles an exact native receipt when terminal store write was lost", () => {
    const h = fixture(); const claim = claimed(h); h.storage.markClaim("one", claim.id, "dispatched");
    const receipt = { jobId: "one", claimId: claim.id, sessionId: "owner", outcome: "success" } as const;
    h.storage.reconcileJob("one", "owner", "new-owner", [receipt], () => false);
    expect(h.storage.getJob("one")).toMatchObject({ claim: { phase: "settled", outcome: "success" }, lastStatus: "success", runCount: 1 });
  });
  it("never steals a live owner even if its claim deadline is old", () => {
    const h = fixture(); const claim = claimed(h); h.storage.markClaim("one", claim.id, "dispatched");
    vi.advanceTimersByTime(86400000);
    h.storage.reconcileJob("one", "owner", "new-owner", [], () => true);
    expect(h.storage.getJob("one")?.claim?.phase).toBe("dispatched");
    expect(h.storage.getJob("one")?.enabled).toBe(true);
    expect(h.storage.claimJob("one", "owner", "new-owner")).toBeUndefined();
  });
  it("does not accept a foreign session/attempt receipt", () => {
    const h = fixture(); const claim = claimed(h); h.storage.markClaim("one", claim.id, "dispatched");
    expect(h.storage.settleClaim({ jobId: "one", claimId: "other", sessionId: "owner", outcome: "success" })).toBe(false);
    h.storage.reconcileJob("one", "owner", "new-owner", [{ jobId: "one", claimId: claim.id, sessionId: "foreign", outcome: "success" }], () => false);
    expect(h.storage.getJob("one")?.claim?.outcome).toBe("unknown");
  });
  it("drops a stale configuration-bound pending intent", () => {
    const h = fixture(); h.storage.queueTime("one", "owner"); h.storage.updateJob("one", { prompt: "new goal" });
    expect(h.storage.claimJob("one", "owner", "new-owner")).toBeUndefined();
  });
  it("requires explicit session binding and validates bounded deadline", () => {
    expect(() => fixture({ session: undefined })).toThrow(/durable/);
    expect(() => fixture({ deadlineMs: 1 })).toThrow(/durable/);
  });
});

describe("native execution envelope", () => {
  it("persists progress metadata in the native receipt without claiming business completion", () => {
    const h = fixture({ quietOnNoChange: true, noChangeThreshold: 2, quietForMs: 60_000 });
    h.storage.queueTime("one", "owner"); const job = h.durable.begin("one")!;
    expect(h.durable.recordProgress({ jobId: "one", claimId: job.claim!.id, progress: "unchanged", evidenceFingerprint: "a".repeat(64), waitingReason: "waiting_external" })).toBe(true);
    h.durable.started(job.claim!.id); h.durable.messageEnd({ role: "assistant", stopReason: "stop" }); h.durable.settled(false);
    expect(h.receipts[0]).toMatchObject({ progress: "unchanged", evidenceFingerprint: "a".repeat(64), waitingReason: "waiting_external" });
    expect(h.storage.getJob("one")).toMatchObject({ lastEvidenceFingerprint: "a".repeat(64), noChangeCount: 1, waitingReason: "waiting_external" });
  });

  it("persists claim-before-send, correlates exact turn, then receipt-before-terminal state", () => {
    const h = fixture(); h.storage.queueTime("one", "owner"); const job = h.durable.begin("one")!;
    expect(h.storage.getJob("one")?.claim?.phase).toBe("dispatched");
    h.durable.started("foreign"); h.durable.settled(false);
    expect(h.storage.getJob("one")?.claim?.phase).toBe("dispatched");
    h.durable.started(job.claim!.id); h.durable.messageEnd({ role: "assistant", stopReason: "stop" }); h.durable.settled(false);
    expect(h.receipts).toEqual([{ jobId: "one", claimId: job.claim!.id, sessionId: "owner", outcome: "success" }]);
    expect(h.storage.getJob("one")).toMatchObject({ lastStatus: "success", notice: { state: "accepted" } });
  });
  it("aborts only the exact started native turn at its deadline and does not restart it", async () => {
    const h = fixture({ deadlineMs: 1000 }); h.storage.queueTime("one", "owner"); const job = h.durable.begin("one")!; h.durable.started(job.claim!.id);
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.ctx.abort).toHaveBeenCalledTimes(1);
    expect(h.storage.getJob("one")).toMatchObject({ enabled: false, lastStatus: "unknown" });
    expect(h.durable.busy()).toBe(true); h.durable.settled(true); expect(h.durable.busy()).toBe(false);
  });
  it("does not abort unrelated user work when dispatch never started", async () => {
    const h = fixture({ deadlineMs: 1000 }); h.storage.queueTime("one", "owner"); h.durable.begin("one");
    await vi.advanceTimersByTimeAsync(1100); expect(h.ctx.abort).not.toHaveBeenCalled();
    expect(h.storage.getJob("one")?.enabled).toBe(false);
  });
  it("keeps a model deadline hold through unrelated parent settlement until the exact child releases", async () => {
    const h = fixture({ model: "synthetic/model", deadlineMs: 1000 }); h.storage.queueTime("one", "owner"); const job = h.durable.begin("one")!; h.durable.started(job.claim!.id);
    const abort = vi.fn(); h.durable.setAbort(job.claim!.id, abort);
    await vi.advanceTimersByTimeAsync(1100); expect(abort).toHaveBeenCalledOnce();
    h.durable.started(undefined); h.durable.settled(false); expect(h.durable.busy()).toBe(true);
    h.durable.release("foreign"); expect(h.durable.busy()).toBe(true);
    h.durable.release(job.claim!.id); expect(h.durable.busy()).toBe(false);
  });
  it("retains the exact stopped run slot until its owned native turn settles", () => {
    const h = fixture(); h.storage.queueTime("one", "owner"); const job = h.durable.begin("one")!; h.durable.started(job.claim!.id);
    h.durable.stop(); expect(h.durable.busy()).toBe(true);
    h.durable.settled(true); expect(h.durable.busy()).toBe(false);
  });
  it("classifies observed output truncation as a confirmed error, not unknown effects", () => {
    const h = fixture(); h.storage.queueTime("one", "owner"); const job = h.durable.begin("one")!; h.durable.started(job.claim!.id);
    h.durable.messageEnd({ role: "assistant", stopReason: "length" }); h.durable.settled(false);
    expect(h.storage.getJob("one")).toMatchObject({ enabled: true, consecutiveErrors: 1, lastStatus: "error", claim: { outcome: "error" } });
  });
  it("allows only one durable execution per scheduler, not one per job", () => {
    const h = fixture(); h.storage.addJob(seed({ id: "two", name: "two" }));
    h.storage.queueTime("one", "owner"); h.storage.queueTime("two", "owner");
    expect(h.durable.begin("one")).toBeDefined(); expect(h.durable.begin("two")).toBeUndefined();
    h.durable.stop();
  });
  it("stops after three confirmed errors and resets the counter on actual success", () => {
    const h = fixture();
    for (let attempt = 0; attempt < 3; attempt++) {
      h.storage.queueTime("one", "owner"); const job = h.durable.begin("one")!; h.durable.started(job.claim!.id);
      h.durable.messageEnd({ role: "assistant", stopReason: "error" }); h.durable.settled(false);
    }
    expect(h.storage.getJob("one")).toMatchObject({ enabled: false, consecutiveErrors: 3, lastStatus: "error" });
  });
  it("retains failed notification separately and retries it without a model call", () => {
    const h = fixture(); h.pi.events.emit.mockImplementation(() => { throw new Error("broken observer"); });
    h.storage.queueTime("one", "owner"); h.durable.begin("one"); h.durable.finish("error");
    expect(h.storage.getJob("one")?.notice).toMatchObject({ state: "failed", attempts: 1 });
    h.pi.events.emit.mockReset(); h.durable.flushNotices();
    expect(h.storage.getJob("one")).toMatchObject({ notice: { state: "accepted", attempts: 2 }, attemptCount: 1, lastStatus: "error" });
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
  });
  it("keeps local event acceptance when an optional UI notice fails", () => {
    const h = fixture(); h.ctx.ui.notify.mockImplementation(() => { throw new Error("UI unavailable"); });
    h.storage.queueTime("one", "owner"); h.durable.begin("one"); h.durable.finish("error");
    expect(h.storage.getJob("one")).toMatchObject({ enabled: true, notice: { state: "accepted" } });
  });
  it("does not disable or block future work solely because three notice deliveries failed", () => {
    const h = fixture(); h.pi.events.emit.mockImplementation(() => { throw new Error("observer unavailable"); });
    h.storage.queueTime("one", "owner"); h.durable.begin("one"); h.durable.finish("success"); h.durable.flushNotices(); h.durable.flushNotices();
    expect(h.storage.getJob("one")).toMatchObject({ enabled: true, lastStatus: "success", notice: { state: "failed", attempts: 3 } });
    h.storage.queueTime("one", "owner"); expect(h.durable.begin("one")).toBeDefined(); h.durable.stop();
  });
  it("uses event dedup/daily limits through the same durable claim and settlement", () => {
    const h = fixture({ type: "event", schedule: "local:build", maxRunsPerDay: 1 });
    expect(h.storage.queueEvent("one", "local:build", "id1", "owner").status).toBe("queued");
    const job = h.durable.begin("one")!; h.durable.started(job.claim!.id); h.durable.messageEnd({ role: "assistant", stopReason: "stop" }); h.durable.settled(false);
    expect(h.storage.queueEvent("one", "local:build", "id1", "owner").status).toBe("duplicate");
    expect(h.storage.queueEvent("one", "local:build", "id2", "owner")).toMatchObject({ status: "ignored", reason: "daily-limit" });
    expect(h.storage.getJob("one")).toMatchObject({ attemptCount: 1, claim: { phase: "settled", outcome: "success" } });
  });
  it("serializes claims across jobs and cooperating storage/scheduler instances", () => {
    const h = fixture(); h.storage.addJob(seed({ id: "two", name: "two" }));
    h.storage.queueTime("one", "owner"); h.storage.queueTime("two", "owner");
    const other = new CronStorage(h.cwd);
    expect(h.storage.claimJob("one", "owner", "first")).toBeDefined();
    expect(other.claimJob("two", "owner", "second")).toBeUndefined();
  });
  it("does not re-arm a durable interval after its first attempt consumes the lifetime cap", async () => {
    const h = fixture({ maxRuns: 1 }); const scheduler = new CronScheduler(h.storage, h.pi as any, h.ctx as any); scheduler.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(1); expect(scheduler.getNextRun("one")).toBeNull();
    scheduler.stop();
  });
  it("restores one missed one-shot only for latest, while none skips", async () => {
    for (const catchUp of ["none", "latest"] as const) {
      const h = fixture({ type: "once", schedule: new Date(Date.now() - 1000).toISOString(), catchUp });
      const scheduler = new CronScheduler(h.storage, h.pi as any, h.ctx as any); scheduler.start();
      await vi.advanceTimersByTimeAsync(1100);
      expect(h.pi.sendMessage).toHaveBeenCalledTimes(catchUp === "latest" ? 1 : 0);
      scheduler.stop();
    }
  });
});
