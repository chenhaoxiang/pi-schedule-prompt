import { describe, expect, it } from "vitest";
import { claimKey, receiptsByClaim, summarizeJob, summarizeJobs } from "../src/status.js";
import type { CronJob } from "../src/types.js";

const base = (overrides: Partial<CronJob> = {}): CronJob => ({
  id: "job-1",
  name: "bounded check",
  type: "interval",
  schedule: "1h",
  intervalMs: 3600000,
  prompt: "private prompt is never included in status",
  enabled: false,
  createdAt: "2026-10-31T00:00:00.000Z",
  runCount: 1,
  session: "service",
  durable: true,
  ...overrides,
});

describe("bounded scheduling status", () => {
  it("separates disabled UNKNOWN from an online native service", () => {
    const job = base({
      lastStatus: "unknown",
      attemptCount: 1,
      claim: { id: "claim-1", sessionId: "service", ownerPid: 999999, ownerId: "owner-1", binding: "a".repeat(64), phase: "settled", outcome: "unknown", claimedAt: "2026-10-31T00:00:00.000Z", deadlineAt: "2026-10-31T00:10:00.000Z" },
    });
    expect(summarizeJob(job, { ownerAlive: () => false })).toMatchObject({
      enabled: false,
      operationalState: "disabled-unknown",
      reconciliation: "unknown-needs-external-reconciliation",
      claim: { phase: "settled", outcome: "unknown" },
    });
    expect(summarizeJobs([job], { ownerAlive: () => false })).toHaveLength(1);
  });

  it("exposes the exact deadline cause without inventing a reason for historical claims", () => {
    const job = base({ lastStatus: "unknown", claim: { id: "claim-1", sessionId: "service", ownerPid: 42, ownerId: "owner-1", binding: "a".repeat(64), phase: "settled", outcome: "unknown", outcomeReason: "deadline_exceeded", claimedAt: "2026-10-31T00:00:00.000Z", deadlineAt: "2026-10-31T00:45:00.000Z" } });
    expect(summarizeJob(job)).toMatchObject({ claim: { outcomeReason: "deadline_exceeded" } });
    expect(summarizeJob(job).reconciliationReason).toContain("hard elapsed deadline");
    delete job.claim!.outcomeReason;
    expect(summarizeJob(job).claim?.outcomeReason).toBeUndefined();
  });

  it("distinguishes a live owner and a provably pre-dispatch dead owner", () => {
    const claim = { id: "claim-1", sessionId: "service", ownerPid: 42, ownerId: "owner-1", binding: "a".repeat(64), phase: "dispatched" as const, claimedAt: "2026-10-31T00:00:00.000Z", deadlineAt: "2026-10-31T00:10:00.000Z" };
    expect(summarizeJob(base({ enabled: true, lastStatus: "dispatched", claim }), { ownerAlive: () => true })).toMatchObject({ reconciliation: "owner-live", claim: { ownerAlive: true } });
    expect(summarizeJob(base({ claim: { ...claim, phase: "claimed" } }), { ownerAlive: () => false })).toMatchObject({ reconciliation: "pre-dispatch-releasable", claim: { ownerAlive: false } });
  });

  it("only accepts an exact session receipt and never exposes the prompt", () => {
    const job = base({
      enabled: true,
      lastStatus: "dispatched",
      claim: { id: "claim-1", sessionId: "service", ownerPid: 42, ownerId: "owner-1", binding: "a".repeat(64), phase: "dispatched", claimedAt: "2026-10-31T00:00:00.000Z", deadlineAt: "2026-10-31T00:10:00.000Z" },
    });
    const entries = [
      { type: "custom", customType: "schedule_execution", data: { jobId: job.id, claimId: "claim-1", sessionId: "foreign", outcome: "success" } },
      { type: "custom", customType: "schedule_execution", data: { jobId: job.id, claimId: "claim-1", sessionId: "service", outcome: "success" } },
    ];
    const foreign = summarizeJob(job, { receiptByClaim: receiptsByClaim(entries.slice(0, 1)), ownerAlive: () => false });
    expect(foreign.reconciliation).toBe("unknown-needs-external-reconciliation");
    const receipts = receiptsByClaim(entries);
    expect(receipts.get(claimKey(job.id, "claim-1", "service"))?.sessionId).toBe("service");
    const result = summarizeJob(job, { receiptByClaim: receipts, ownerAlive: () => false });
    expect(result).toMatchObject({ reconciliation: "receipt-found", claim: { receiptOutcome: "success" } });
    expect(JSON.stringify(result)).not.toContain(job.prompt);
  });

  it("does not imply that enabling an unresolved claim or an old nextRun permits replay", () => {
    const job = base({ enabled: true, lastStatus: "unknown", nextRun: "2026-10-30T01:00:00.000Z", claim: { id: "claim-1", sessionId: "service", ownerPid: 42, ownerId: "owner-1", binding: "a".repeat(64), phase: "settled", outcome: "unknown", claimedAt: "2026-10-30T00:00:00.000Z", deadlineAt: "2026-10-30T00:10:00.000Z" } });
    const before = JSON.stringify(job);
    const result = summarizeJob(job, { nextRun: () => new Date("2026-11-01T01:00:00.000Z") });
    expect(result).toMatchObject({ enabled: true, operationalState: "blocked-unknown", recordedNextRun: job.nextRun });
    expect(result.nextRun).toBeUndefined();
    expect(result.claim?.ownerAlive).toBeUndefined();
    expect(JSON.stringify(job)).toBe(before);
  });
});
