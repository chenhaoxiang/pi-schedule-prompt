import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resilientDefinition } from "../src/resilient-policy.js";
import { CronStorage, type MigrationRuntimeReadback } from "../src/storage.js";
import type { CronJob, ResilientJob } from "../src/types.js";

const owned: string[] = [];
const observed = (): MigrationRuntimeReadback => ({ status: "verified", activeRunIds: [], incompatibleWriterIds: [] });
function legacy(extra: Partial<CronJob> = {}): CronJob {
  return { id: "legacy", name: "legacy", type: "interval", schedule: "1s", intervalMs: 1000, enabled: false, prompt: "authorized synthetic work", createdAt: new Date().toISOString(), runCount: 4, attemptCount: 4, session: "owner", durable: true, maxRuns: 126, maxRunsPerDay: 24, dailyUsage: { day: "2026-11-03", attempts: 4 }, expiresAt: "2026-11-06T07:44:18.000Z", deadlineMs: 2_700_000, lastStatus: "unknown", ...extra };
}
function fixture(jobs = [legacy()], version = 3) {
  const root = path.resolve("tmp/state-migration-fixtures"); fs.mkdirSync(root, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(root, "case-")); owned.push(cwd);
  const storage = new CronStorage(cwd); fs.mkdirSync(path.dirname(storage.getStorePath()), { mode: 0o700 });
  // Preserve a noncanonical original encoding to test byte-for-byte backups rather than reserialization.
  fs.writeFileSync(storage.getStorePath(), "\n" + JSON.stringify({ version, jobs }) + "\n", { mode: 0o600 });
  return { cwd, storage };
}
function request(storage: CronStorage, inspectRuntime = observed) {
  return { expectedSha256: storage.previewSchema4Migration().originalSha256, policy: { intervalMode: "fixed-rate" as const, workBudgetMs: 1_500_000 }, inspectRuntime };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-03T10:00:00.000Z")); });
afterEach(() => { vi.useRealTimers(); for (const cwd of owned.splice(0)) fs.rmSync(cwd, { recursive: true, force: true }); });

describe("pure preview and explicit private schema4 migration", () => {
  it.each([1, 2, 3])("previews schema%d without mutation and retains disabled UNKNOWN, budget and exact original bytes", version => {
    const h = fixture([legacy()], version); const original = fs.readFileSync(h.storage.getStorePath());
    const preview = h.storage.previewSchema4Migration();
    expect(preview).toMatchObject({ sourceVersion: version, targetVersion: 4, jobs: [{ id: "legacy", enabled: false, unknown: true, attempts: 4 }] });
    expect(fs.readFileSync(h.storage.getStorePath())).toEqual(original);
    expect(fs.readdirSync(path.dirname(h.storage.getStorePath()))).toEqual(["schedule-prompts.json"]);
    const inspect = vi.fn(observed);
    const req = request(h.storage, inspect); const result = h.storage.migrateJobToSchema4("legacy", "owner", req);
    expect(inspect).toHaveBeenCalledWith(undefined);
    expect(result).toMatchObject({ changed: true, job: { enabled: false, attemptCount: 4, maxRuns: 126, expiresAt: "2026-11-06T07:44:18.000Z", deadlineMs: 2_700_000, runtime: { baselineAttempts: 4, legacyUncertainty: { status: "unknown" }, slot: { phase: "reconciling" } } } });
    expect(h.storage.load().version).toBe(4);
    expect(fs.readFileSync(result.backupPath!)).toEqual(original);
    expect(fs.statSync(result.backupPath!).mode & 0o777).toBe(0o600);
    expect(createHash("sha256").update(fs.readFileSync(result.backupPath!)).digest("hex")).toBe(preview.originalSha256);
    const converted = fs.readFileSync(h.storage.getStorePath());
    expect(h.storage.migrateJobToSchema4("legacy", "owner", req).changed).toBe(false);
    expect(fs.readFileSync(h.storage.getStorePath())).toEqual(converted);
  });

  it.each(["unknown", "held", "old-writer"])("holds the migration for %s actual runtime facts, not just a settled JSON claim", kind => {
    const claim: NonNullable<CronJob["claim"]> = { id: "old-claim", sessionId: "owner", ownerId: "old-instance", ownerPid: 1, binding: "a".repeat(64), phase: "settled", outcome: "unknown", claimedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 2_700_000).toISOString() };
    const h = fixture([legacy({ claim })]); const original = fs.readFileSync(h.storage.getStorePath());
    const inspect = (): MigrationRuntimeReadback => kind === "unknown" ? { status: "unknown", reason: "not observed" } : { status: "verified", activeRunIds: kind === "held" ? ["exact-cancelling-native-run"] : [], incompatibleWriterIds: kind === "old-writer" ? ["schema3-loaded-session"] : [] };
    expect(() => h.storage.migrateJobToSchema4("legacy", "owner", request(h.storage, inspect))).toThrow(/verified quiescent/);
    expect(fs.readFileSync(h.storage.getStorePath())).toEqual(original);
    expect(fs.readdirSync(path.dirname(h.storage.getStorePath()))).toEqual(["schedule-prompts.json"]);
  });

  it("rejects a stale source fingerprint instead of backing up one head and converting a different input", () => {
    const h = fixture(); const req = request(h.storage);
    const raw = JSON.parse(fs.readFileSync(h.storage.getStorePath(), "utf8")); raw.jobs[0].description = "newer owner update";
    fs.writeFileSync(h.storage.getStorePath(), JSON.stringify(raw)); const latest = fs.readFileSync(h.storage.getStorePath());
    expect(() => h.storage.migrateJobToSchema4("legacy", "owner", req)).toThrow(/input changed/);
    expect(fs.readFileSync(h.storage.getStorePath())).toEqual(latest);
    expect(fs.readdirSync(path.dirname(h.storage.getStorePath()))).toEqual(["schedule-prompts.json"]);
  });

  it("refuses pending persistent ownership even when a contradictory runtime callback says idle", () => {
    const job = legacy({ claim: { id: "unsettled", sessionId: "owner", ownerId: "old-instance", ownerPid: 1, binding: "a".repeat(64), phase: "started", claimedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 2_700_000).toISOString() } });
    const h = fixture([job]); const bytes = fs.readFileSync(h.storage.getStorePath());
    expect(() => h.storage.migrateJobToSchema4("legacy", "owner", request(h.storage))).toThrow(/unsettled execution/);
    expect(fs.readFileSync(h.storage.getStorePath())).toEqual(bytes);
  });

  it("does not silently select completion delay for an unchanged legacy interval", () => {
    const h = fixture(); const req = request(h.storage);
    expect(() => h.storage.migrateJobToSchema4("legacy", "owner", { ...req, policy: {} })).toThrow(/explicit fixed-delay/);
    expect(h.storage.load().version).toBe(3);
  });

  it("retains expired metadata without extending expiry or enabling another business attempt", () => {
    const h = fixture([legacy({ expiresAt: "2026-11-02T10:00:00.000Z" })]);
    const result = h.storage.migrateJobToSchema4("legacy", "owner", request(h.storage));
    expect(result.job).toMatchObject({ enabled: false, expiresAt: "2026-11-02T10:00:00.000Z", attemptCount: 4 });
    expect(result.job.runtime.slot).toMatchObject({ kind: "idle", phase: "reconciling" });
  });

  it("a later job-only promotion does not stop or replace independent schema4 ownership", () => {
    const live = resilientDefinition(legacy({ id: "live", name: "live", enabled: true, lastStatus: undefined, attemptCount: 0, runCount: 0, dailyUsage: undefined }), { intervalMode: "fixed-rate", workBudgetMs: 1_500_000 });
    const h = fixture([live, legacy()], 4);
    h.storage.queueResilient("live", "owner", { id: "live-tick", revision: 1, dueAt: new Date().toISOString(), source: "timer" });
    const active = h.storage.reserveResilient("live", "owner", "live-instance", 1, "live-tick") as ResilientJob;
    const inspect = vi.fn(observed);
    h.storage.migrateJobToSchema4("legacy", "owner", request(h.storage, inspect));
    expect(inspect).toHaveBeenCalledWith("legacy");
    expect((h.storage.getJob("live") as ResilientJob).runtime.slot).toEqual(active.runtime.slot);
    expect(h.storage.getJob("live")?.attemptCount).toBe(1);
  });

  it("a conflicting writer, malformed input or changed policy never overwrites retained bytes", () => {
    const h = fixture(); const req = request(h.storage); fs.writeFileSync(h.storage.getStorePath() + ".lock", "owned by another writer");
    const bytes = fs.readFileSync(h.storage.getStorePath());
    expect(() => h.storage.migrateJobToSchema4("legacy", "owner", req)).toThrow(/busy/);
    expect(fs.readFileSync(h.storage.getStorePath())).toEqual(bytes);
    fs.rmSync(h.storage.getStorePath() + ".lock");
    h.storage.migrateJobToSchema4("legacy", "owner", req);
    const converted = fs.readFileSync(h.storage.getStorePath());
    expect(() => h.storage.migrateJobToSchema4("legacy", "owner", { ...req, policy: { intervalMode: "fixed-delay" } })).toThrow(/different policy/);
    expect(fs.readFileSync(h.storage.getStorePath())).toEqual(converted);
    fs.writeFileSync(h.storage.getStorePath(), "not JSON");
    expect(() => h.storage.previewSchema4Migration()).toThrow(); expect(fs.readFileSync(h.storage.getStorePath(), "utf8")).toBe("not JSON");
  });
});
