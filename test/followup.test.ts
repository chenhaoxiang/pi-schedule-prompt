import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followupName } from "../src/followup.js";
import { CronScheduler } from "../src/scheduler.js";
import { CronStorage } from "../src/storage.js";
import type { CronJob } from "../src/types.js";

const owned: string[] = [];
function fixture() {
  const root = path.resolve("tmp/followup-fixtures");
  fs.mkdirSync(root, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(root, "case-"));
  owned.push(cwd);
  return new CronStorage(cwd);
}
function followupJob(overrides: Partial<CronJob> = {}): CronJob {
  const now = Date.now();
  const binding = {
    ownerSessionId: "owner",
    intercomSessionId: "intercom-owner",
    peerSessionId: "peer",
    messageId: "message-1",
  } as const;
  return {
    id: "followup-1",
    name: followupName(binding),
    type: "once",
    schedule: new Date(now + 60_000).toISOString(),
    prompt: "bounded control reminder",
    enabled: true,
    createdAt: new Date(now).toISOString(),
    runCount: 0,
    maxRuns: 1,
    expiresAt: new Date(now + 120_000).toISOString(),
    durable: true,
    catchUp: "none",
    session: "owner",
    followUp: {
      version: 1,
      ...binding,
      requestId: "request-1",
      goal: "accepted artifact readiness",
      phase: "artifact-ready",
      deadlineAt: new Date(now + 120_000).toISOString(),
      intervalMs: 60_000,
      maxRuns: 1,
      expiresAt: new Date(now + 120_000).toISOString(),
      state: "pending",
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      ...overrides.followUp,
    },
    ...overrides,
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  for (const dir of owned.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("bounded reply follow-up persistence", () => {
  it("deduplicates the exact session/request/message binding", () => {
    const storage = fixture();
    const first = followupJob();
    expect(storage.createFollowUp(first)).toMatchObject({ created: true, job: { id: first.id } });
    expect(storage.createFollowUp({ ...first, id: "different-id" })).toMatchObject({ created: false, job: { id: first.id } });
    expect(storage.getAllJobs()).toHaveLength(1);
  });

  it("does not let a different peer or message cancel the tracked timer", () => {
    const storage = fixture();
    const job = followupJob();
    storage.createFollowUp(job);
    expect(storage.cancelFollowUp({ ...job.followUp!, peerSessionId: "other-peer" })).toEqual({ found: false });
    expect(storage.getJob(job.id)?.followUp?.state).toBe("pending");
  });

  it("cancels pending work and keeps business completion unknown", () => {
    const storage = fixture();
    const job = followupJob();
    storage.createFollowUp(job);
    expect(storage.cancelFollowUp(job.followUp!)).toMatchObject({ found: true, state: "cancelled", jobId: job.id });
    expect(storage.getJob(job.id)).toMatchObject({ enabled: false, followUp: { state: "cancelled" } });
  });

  it("records unknown when cancellation races with a dispatched reminder", () => {
    const storage = fixture();
    const job = followupJob();
    storage.createFollowUp(job);
    storage.queueTime(job.id, "owner");
    const claim = storage.claimJob(job.id, "owner", "owner-runtime")!.claim!;
    expect(storage.markClaim(job.id, claim.id, "dispatched")).toBe(true);
    expect(storage.beginFollowUpDispatch(job.id, claim.id)).toBe(true);
    expect(storage.cancelFollowUp(job.followUp!)).toMatchObject({ found: true, state: "unknown", unknown: true });
    expect(storage.getJob(job.id)).toMatchObject({ enabled: false, lastStatus: "unknown", followUp: { state: "unknown" } });
  });

  it("records ACK/PENDING as an answer without settling the business goal", () => {
    const storage = fixture();
    const job = followupJob();
    storage.createFollowUp(job);
    const result = storage.observeFollowUpReply(job.followUp!, { id: "reply-1", kind: "pending", at: new Date().toISOString(), text: "PENDING — still working" });
    expect(result).toMatchObject({ found: true, state: "answered", completion: "unknown" });
    expect(storage.getJob(job.id)).toMatchObject({ followUp: { state: "answered", lastReply: { kind: "pending" } } });
  });

  it("does not create a second bounded timer for an active covered schedule", () => {
    const storage = fixture();
    const existing = followupJob({ followUp: { ...followupJob().followUp!, coveredBy: "tuding-six-workstreams-hourly-01a182e1" } });
    storage.createFollowUp(existing);
    const next = followupJob({ id: "followup-2", name: "reply-followup-second", followUp: { ...existing.followUp!, messageId: "message-2", coveredBy: "tuding-six-workstreams-hourly-01a182e1" } });
    expect(() => storage.createFollowUp(next)).toThrow(/no second loop/);
  });

  it("rechecks the exact state before a queued follow-up wake can send", async () => {
    const storage = fixture();
    const base = followupJob();
    const now = Date.now();
    const job = { ...base, schedule: new Date(now + 1000).toISOString(), followUp: { ...base.followUp!, deadlineAt: new Date(now + 120_000).toISOString(), expiresAt: new Date(now + 120_000).toISOString() } };
    storage.createFollowUp(job);
    let due: { isCurrent: () => boolean } | undefined;
    const pi = { sendMessage: vi.fn(), events: { emit: vi.fn((name: string, payload: unknown) => { if (name === "schedule:reply-followup-due:v1") due = payload as { isCurrent: () => boolean }; }) } };
    const ctx = { isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionId: () => "owner" } };
    const scheduler = new CronScheduler(storage, pi as any, ctx as any);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(2500);
    expect(due).toBeDefined();
    expect(storage.getJob(job.id)?.followUp?.state).toBe("dispatched");
    scheduler.cancelFollowUp(job.followUp!);
    expect(due!.isCurrent()).toBe(false);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("keeps restart/late-reply uncertainty explicit", () => {
    const storage = fixture();
    const job = followupJob();
    storage.createFollowUp(job);
    expect(storage.markFollowUpUnknown(job.followUp!, "owner restarted before reconciliation")).toMatchObject({ found: true, state: "unknown" });
    const late = storage.observeFollowUpReply(job.followUp!, { id: "late-reply", kind: "ack", at: new Date().toISOString(), text: "ACK" });
    expect(late).toMatchObject({ found: true, state: "unknown", completion: "unknown" });
    expect(storage.getJob(job.id)).toMatchObject({ followUp: { state: "unknown", lastReply: { id: "late-reply" } } });
  });
});
