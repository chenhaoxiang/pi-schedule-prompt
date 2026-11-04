import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inheritLegacyBudget } from "../src/legacy-lineage.js";
import { requiresReconciliation } from "../src/resilient-policy.js";
import { CronStorage } from "../src/storage.js";
import type { CronJob, LegacyOwnerHandover, ResilientJob } from "../src/types.js";

const owned: string[] = [];
function legacy(id: string, session: string, spent: number, maxRuns: number): CronJob {
  return { id, name: id, type: "cron", schedule: "0 0 * * * *", prompt: "SYNTHETIC AUTHORIZED FUTURE WORK", enabled: false, session, durable: true, createdAt: new Date().toISOString(), runCount: spent, attemptCount: spent, maxRuns, maxRunsPerDay: 24, dailyUsage: { day: "2026-11-03", attempts: 4 }, deadlineMs: 2_700_000, expiresAt: "2026-11-06T07:44:18.000Z", lastStatus: "unknown", claim: { id: "claim-" + id, sessionId: session, ownerId: "fixture", ownerPid: 1, binding: "c".repeat(64), phase: "settled", outcome: "unknown", claimedAt: new Date().toISOString(), deadlineAt: new Date().toISOString() } };
}
function chain() {
  const parent = legacy("parent", "old-owner", 31, 157); const child = legacy("child", "owner", 4, 126);
  parent.recovery = { claimId: parent.claim!.id, successorJobId: child.id, evidenceFingerprint: "a".repeat(64), resumedAt: new Date().toISOString() };
  const handover: LegacyOwnerHandover = { predecessorJobId: parent.id, successorJobId: child.id, fromSessionId: parent.session!, toSessionId: child.session!, claimId: parent.claim!.id, claimBinding: parent.claim!.binding, recoveryEvidenceFingerprint: parent.recovery.evidenceFingerprint, handoverEvidenceFingerprint: "b".repeat(64), evidenceRef: "fixture:exact-owner-handover" };
  return { parent, child, handover };
}
function fixture(jobs: CronJob[]) {
  const base = path.resolve("tmp/legacy-recovery"); fs.mkdirSync(base, { recursive: true }); const cwd = fs.mkdtempSync(path.join(base, "case-")); owned.push(cwd);
  fs.mkdirSync(path.join(cwd, ".pi")); const storage = new CronStorage(cwd); fs.writeFileSync(storage.getStorePath(), JSON.stringify({ version: 3, jobs }));
  return storage;
}
const observed = () => ({ status: "verified" as const, activeRunIds: [], incompatibleWriterIds: [] });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-04T16:00:00.000Z")); });
afterEach(() => { vi.useRealTimers(); for (const cwd of owned.splice(0)) fs.rmSync(cwd, { recursive: true, force: true }); });
describe("legacy migration ownership evidence and future-only resolution", () => {
  it("requires exact cross-owner handover evidence and preserves both original rows and all spending", () => {
    const { parent, child, handover } = chain(); const storage = fixture([parent, child]);
    expect(() => inheritLegacyBudget([parent, child], child.id)).toThrow(/Unproven legacy lineage/);
    const result = storage.migrateJobToSchema4(child.id, "owner", { expectedSha256: storage.previewSchema4Migration().originalSha256, policy: { timezone: "Asia/Shanghai" }, legacyHandovers: [handover], inspectRuntime: observed });
    expect(result.job).toMatchObject({ enabled: false, maxRuns: 157, runCount: 35, attemptCount: 35, expiresAt: child.expiresAt, deadlineMs: child.deadlineMs, dailyUsage: child.dailyUsage, legacyLineage: [parent.id], legacyHandovers: [handover] });
    expect(storage.getJob(parent.id)).toEqual(parent); expect(result.job.claim).toEqual(child.claim); expect(result.job.attemptHistory).toEqual([]);
    expect(requiresReconciliation(result.job)).toBe(true); expect(result.job.maxRuns! - result.job.attemptCount!).toBe(122);
  });
  it("counts a complete three-row chain once, including the same-owner root before the proven handover", () => {
    const { parent, child, handover } = chain(); const root = legacy("root", "old-owner", 1, 158);
    root.recovery = { claimId: root.claim!.id, successorJobId: parent.id, evidenceFingerprint: "f".repeat(64), resumedAt: new Date().toISOString() };
    root.dailyUsage = { day: "2026-10-31", attempts: 2 }; parent.dailyUsage = { day: "2026-11-02", attempts: 3 };
    const storage = fixture([root, parent, child]);
    const result = storage.migrateJobToSchema4(child.id, "owner", { expectedSha256: storage.previewSchema4Migration().originalSha256, policy: { timezone: "Asia/Shanghai" }, legacyHandovers: [handover], inspectRuntime: observed });
    expect(result.job).toMatchObject({ enabled: false, maxRuns: 158, runCount: 36, attemptCount: 36, dailyUsage: child.dailyUsage, legacyLineage: [root.id, parent.id], legacyHandovers: [handover], runtime: { baselineAttempts: 36 } });
    expect(result.job.maxRuns! - result.job.attemptCount!).toBe(122); expect(result.job.claim).toEqual(child.claim); expect(requiresReconciliation(result.job)).toBe(true);
    expect(storage.getJob(root.id)).toEqual(root); expect(storage.getJob(parent.id)).toEqual(parent); expect(storage.getAllJobs()).toHaveLength(3);
  });
  it("rejects an enabled predecessor rather than retaining two future executors", () => {
    const { parent, child, handover } = chain(); parent.enabled = true; const storage = fixture([parent, child]); const bytes = fs.readFileSync(storage.getStorePath());
    expect(() => storage.migrateJobToSchema4(child.id, "owner", { expectedSha256: storage.previewSchema4Migration().originalSha256, policy: { timezone: "UTC" }, legacyHandovers: [handover], inspectRuntime: observed })).toThrow(/bounds changed/);
    expect(fs.readFileSync(storage.getStorePath())).toEqual(bytes);
  });
  it.each(["fromSessionId", "toSessionId", "claimId", "claimBinding", "recoveryEvidenceFingerprint", "handoverEvidenceFingerprint", "evidenceRef"] as const)("rejects mismatched/invalid handover %s without rewriting bytes", field => {
    const { parent, child, handover } = chain(); const storage = fixture([parent, child]); const bytes = fs.readFileSync(storage.getStorePath());
    const bad = { ...handover, [field]: field === "handoverEvidenceFingerprint" ? "not-evidence" : field === "evidenceRef" ? "" : "wrong" };
    expect(() => storage.migrateJobToSchema4(child.id, "owner", { expectedSha256: storage.previewSchema4Migration().originalSha256, policy: { timezone: "UTC" }, legacyHandovers: [bad], inspectRuntime: observed })).toThrow();
    expect(fs.readFileSync(storage.getStorePath())).toEqual(bytes);
  });
  it("admits only future native work on the same logical job after exact legacy reconciliation", () => {
    const { parent, child, handover } = chain(); const storage = fixture([parent, child]);
    const migrated = storage.migrateJobToSchema4(child.id, "owner", { expectedSha256: storage.previewSchema4Migration().originalSha256, policy: { timezone: "UTC" }, legacyHandovers: [handover], inspectRuntime: observed }).job;
    storage.reconcileLegacyClaim(child.id, "owner", child.claim!.id, child.claim!.binding, "d".repeat(64), "continue");
    storage.updateJob(child.id, { enabled: true }, "owner");
    const job = storage.getJob(child.id) as ResilientJob;
    expect(job.runtime.legacyFutureAfter).toBe("2026-11-04T16:00:00.000Z"); expect(job.runtime.notBefore).toBe("2026-11-04T17:00:00.000Z"); expect(job.runtime.lastFinishedAt).toBeUndefined();
    const oldTick = { id: "old-legacy-tick", dueAt: "2026-11-04T15:59:00.000Z", revision: job.revision!, source: "timer" as const };
    storage.queueResilient(job.id, "owner", oldTick); expect(storage.reserveResilient(job.id, "owner", "instance", job.revision!, oldTick.id)).toBeUndefined();
    vi.setSystemTime(new Date("2026-11-04T17:00:00.000Z"));
    const tick = { id: "new-future-tick", dueAt: new Date().toISOString(), revision: job.revision!, source: "timer" as const };
    storage.queueResilient(job.id, "owner", tick); const accepted = storage.reserveResilient(job.id, "owner", "instance", job.revision!, tick.id)!;
    expect(accepted.attemptCount).toBe(36); expect(accepted.runtime.slot.kind).toBe("owned"); expect(accepted.runtime.baselineAttempts).toBe(35); expect(accepted.maxRuns).toBe(157);
    expect(storage.getAllJobs()).toHaveLength(2); expect(storage.getJob(parent.id)).toEqual(parent); expect(accepted.claim).toEqual(migrated.claim); expect(accepted.attemptHistory).toEqual([]);
    const bytes = fs.readFileSync(storage.getStorePath()); expect(storage.reconcileLegacyClaim(child.id, "owner", child.claim!.id, child.claim!.binding, "e".repeat(64), "unknown")).toBe(false); expect(fs.readFileSync(storage.getStorePath())).toEqual(bytes);
  });

  it.each(["expired", "exhausted", "daily-limited"])("keeps %s bounds after legacy effect reconciliation without a free attempt", kind => {
    const { child } = chain();
    if (kind === "expired") child.expiresAt = "2026-11-04T15:00:00.000Z";
    if (kind === "exhausted") child.maxRuns = 4;
    if (kind === "daily-limited") { child.maxRunsPerDay = 4; child.dailyUsage = { day: "2026-11-04", attempts: 4 }; }
    const storage = fixture([child]); storage.migrateJobToSchema4(child.id, "owner", { expectedSha256: storage.previewSchema4Migration().originalSha256, policy: { timezone: "UTC" }, inspectRuntime: observed });
    storage.reconcileLegacyClaim(child.id, "owner", child.claim!.id, child.claim!.binding, "d".repeat(64), "continue"); storage.updateJob(child.id, { enabled: true }, "owner"); vi.setSystemTime(new Date("2026-11-04T17:00:00.000Z"));
    const job = storage.getJob(child.id) as ResilientJob; const tick = { id: "bounded-future", dueAt: new Date().toISOString(), revision: job.revision!, source: "timer" as const };
    storage.queueResilient(job.id, "owner", tick); expect(storage.reserveResilient(job.id, "owner", "instance", job.revision!, tick.id)).toBeUndefined();
    expect(storage.getJob(child.id)).toMatchObject({ attemptCount: 4, expiresAt: child.expiresAt, maxRuns: child.maxRuns });
  });

  it("does not accept duplicate/unrelated handovers or rewrite protected retained evidence", () => {
    const { parent, child, handover } = chain(); const storage = fixture([parent, child]); const req = { expectedSha256: storage.previewSchema4Migration().originalSha256, policy: { timezone: "UTC" }, inspectRuntime: observed };
    expect(() => storage.migrateJobToSchema4(child.id, "owner", { ...req, legacyHandovers: [handover, handover] })).toThrow();
    const migrated = storage.migrateJobToSchema4(child.id, "owner", { ...req, legacyHandovers: [handover] }).job;
    expect(() => storage.updateJob(child.id, { legacyHandovers: [] }, "owner")).toThrow(/protected|overwritt|immutable/i);
    expect(storage.getJob(child.id)?.legacyHandovers).toEqual(migrated.legacyHandovers);
  });

  it("does not treat handover evidence as effect reconciliation and requires exact retained legacy claim binding", () => {
    const { parent, child, handover } = chain(); const storage = fixture([parent, child]);
    const migrated = storage.migrateJobToSchema4(child.id, "owner", { expectedSha256: storage.previewSchema4Migration().originalSha256, policy: { timezone: "UTC" }, legacyHandovers: [handover], inspectRuntime: observed }).job;
    expect(storage.reconcileLegacyClaim(child.id, "foreign", child.claim!.id, child.claim!.binding, "d".repeat(64), "continue")).toBe(false);
    expect(storage.reconcileLegacyClaim(child.id, "owner", "stale", child.claim!.binding, "d".repeat(64), "continue")).toBe(false);
    expect(storage.reconcileLegacyClaim(child.id, "owner", child.claim!.id, "f".repeat(64), "d".repeat(64), "continue")).toBe(false);
    expect(storage.reconcileLegacyClaim(child.id, "owner", child.claim!.id, child.claim!.binding, "d".repeat(64), "continue", ["readonly-draft-check"])).toBe(true);
    expect(requiresReconciliation(storage.getJob(child.id) as ResilientJob)).toBe(true);
    expect(storage.reconcileLegacyClaim(child.id, "owner", child.claim!.id, child.claim!.binding, "e".repeat(64), "continue")).toBe(true);
    const final = storage.getJob(child.id) as ResilientJob;
    expect(requiresReconciliation(final)).toBe(false); expect(final.enabled).toBe(false); expect(final.runtime.pending).toBeUndefined(); expect(final.runtime.continuation).toBeUndefined();
    expect(final.claim).toEqual(migrated.claim); expect(final.runtime.legacyUncertainty).toEqual(migrated.runtime.legacyUncertainty); expect(final.attemptHistory).toEqual([]); expect(final.attemptCount).toBe(35); expect(final.maxRuns).toBe(157); expect(final.expiresAt).toBe(child.expiresAt);
    const before = fs.readFileSync(storage.getStorePath());
    expect(storage.reconcileLegacyClaim(child.id, "owner", child.claim!.id, child.claim!.binding, "e".repeat(64), "continue")).toBe(false); expect(fs.readFileSync(storage.getStorePath())).toEqual(before);
    expect(() => storage.reconcileLegacyClaim(child.id, "owner", child.claim!.id, child.claim!.binding, "e".repeat(64), "unknown")).toThrow(/different resolution/);
  });
});
