import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runProjectCutover } from "../scripts/migrate-project-store.mjs";
import { resilientDefinition } from "../src/resilient-policy.js";
import { CronStorage, projectKey } from "../src/storage.js";
import type { CronJob, NativeExecutionProof } from "../src/types.js";

vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});

function exampleJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job-1",
    name: "demo",
    schedule: "+10s",
    prompt: "synthetic authorized work",
    enabled: true,
    type: "once",
    createdAt: new Date().toISOString(),
    runCount: 0,
    ...overrides,
  };
}

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("CronStorage — per-project agent-dir store and explicit legacy cutover", () => {
  let root: string;
  let agentDir: string;
  let projectA: string;
  let projectB: string;
  const owned: string[] = [];

  beforeEach(() => {
    const base = resolve("tmp/project-store-fixtures");
    mkdirSync(base, { recursive: true });
    root = realpathSync.native(mkdtempSync(join(base, "case-")));
    agentDir = join(root, "agent");
    mkdirSync(agentDir, { mode: 0o700 });
    projectA = join(root, "a");
    projectB = join(root, "b");
    mkdirSync(projectA);
    mkdirSync(projectB);
    owned.push(root);
  });

  afterEach(() => {
    for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const storage = (cwd: string) => new CronStorage(cwd, agentDir);
  const legacyPath = (cwd: string) => join(cwd, ".pi", "schedule-prompts.json");
  const writeLegacy = (cwd: string, jobs: CronJob[], version = 4) => {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(legacyPath(cwd), JSON.stringify({ version, jobs }, null, 2), { mode: 0o600 });
  };
  const request = (current: CronStorage) => {
    const preview = current.previewProjectMigration();
    return { trustedProject: true, writersConfirmedStopped: true, sourceSha256: preview.sourceSha256!, targetSha256: preview.targetSha256 };
  };

  it("stores jobs under the profile/project hash and records canonical cwd", () => {
    const current = storage(projectA);
    current.addJob(exampleJob());
    const file = join(agentDir, "schedule-prompts", "projects", `${projectKey(projectA)}.json`);
    expect(current.getStorePath()).toBe(file);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ cwd: projectA, jobs: [{ name: "demo" }] });
    expect(existsSync(join(projectA, ".pi"))).toBe(false);
  });

  it("keeps canonical projects apart and resolves symlink aliases to one store", () => {
    storage(projectA).addJob(exampleJob({ name: "only-a" }));
    expect(storage(projectB).getAllJobs()).toEqual([]);
    const link = join(root, "link-to-a");
    symlinkSync(projectA, link);
    expect(storage(link).getAllJobs().map(job => job.name)).toEqual(["only-a"]);
  });

  it("previews and imports a legacy store only with exact source/target hashes", () => {
    const legacyJob = exampleJob({ id: "legacy-1", name: "legacy" });
    writeLegacy(projectA, [legacyJob]);
    const current = storage(projectA);
    const preview = current.previewProjectMigration();
    expect(preview.state).toBe("needs-import");
    expect(preview.sourceSha256).toBeTruthy();
    const result = current.importProjectStore({
      trustedProject: true,
      writersConfirmedStopped: true,
      sourceSha256: preview.sourceSha256!,
      targetSha256: preview.targetSha256,
    });
    expect(result.changed).toBe(true);
    expect(current.getAllJobs()).toEqual([expect.objectContaining({ id: "legacy-1", name: "legacy" })]);
    expect(existsSync(legacyPath(projectA))).toBe(true);
    expect(current.previewProjectMigration().state).toBe("already-imported");
  });

  it("does not import an untrusted legacy store and holds normal reads until an explicit cutover", () => {
    writeLegacy(projectA, [exampleJob({ name: "legacy" })]);
    const current = storage(projectA);
    expect(() => current.getAllJobs()).toThrow(/explicit offline project-store migration/);
    expect(current.previewProjectMigration().state).toBe("needs-import");
    expect(() => current.importProjectStore({
      trustedProject: false,
      writersConfirmedStopped: true,
      sourceSha256: "a".repeat(64),
      targetSha256: null,
    })).toThrow(/trusted project/);
  });

  it("rejects a changed legacy source after import instead of loading divergent state", () => {
    writeLegacy(projectA, [exampleJob({ name: "legacy" })]);
    const current = storage(projectA);
    const preview = current.previewProjectMigration();
    current.importProjectStore({ trustedProject: true, writersConfirmedStopped: true, sourceSha256: preview.sourceSha256!, targetSha256: preview.targetSha256 });
    writeFileSync(legacyPath(projectA), JSON.stringify({ version: 4, jobs: [exampleJob({ name: "changed" })] }));
    expect(() => current.getAllJobs()).toThrow(/changed after cutover/);
  });

  it("preserves target jobs and rejects conflicting legacy IDs", () => {
    const current = storage(projectA);
    current.addJob(exampleJob({ id: "same", name: "target", prompt: "target" }));
    writeLegacy(projectA, [exampleJob({ id: "same", name: "legacy", prompt: "different" })]);
    const preview = current.previewProjectMigration();
    expect(() => current.importProjectStore({ trustedProject: true, writersConfirmedStopped: true, sourceSha256: preview.sourceSha256!, targetSha256: preview.targetSha256 })).toThrow(/Conflicting job ID/);
    expect(JSON.parse(readFileSync(current.getStorePath(), "utf8")).jobs).toEqual([expect.objectContaining({ id: "same", prompt: "target" })]);
  });

  it("keeps malformed legacy bytes untouched and refuses import", () => {
    mkdirSync(join(projectA, ".pi"), { recursive: true });
    writeFileSync(legacyPath(projectA), "{ malformed");
    const current = storage(projectA);
    expect(() => current.previewProjectMigration()).toThrow();
    expect(readFileSync(legacyPath(projectA))).toBeInstanceOf(Buffer);
    expect(() => current.importProjectStore({ trustedProject: true, writersConfirmedStopped: true, sourceSha256: sha(Buffer.from("{ malformed")), targetSha256: null })).toThrow();
    expect(readFileSync(legacyPath(projectA), "utf8")).toBe("{ malformed");
  });

  it.each([1, 2, 3, 4])("relocates schema %i without changing jobs or format", version => {
    const rows = [exampleJob({ session: "owner-a" }), exampleJob({ id: "held", name: "held", enabled: false, lastStatus: "unknown", runCount: 4, attemptCount: 5, maxRuns: 6, dailyUsage: { day: "2026-11-18", attempts: 2 }, expiresAt: "2026-11-01T00:00:00.000Z", session: "owner-b" })];
    writeLegacy(projectA, rows, version);
    const original = readFileSync(legacyPath(projectA));
    const current = storage(projectA);
    const req = request(current);
    expect(current.importProjectStore(req)).toMatchObject({ changed: true, jobs: 2 });
    expect(current.load()).toMatchObject({ version, jobs: rows });
    expect(readFileSync(legacyPath(projectA))).toEqual(original);
    expect(current.assessProjectRollback().action).toBe("same-state-retain-both");
    expect(statSync(current.getStorePath()).mode & 0o777).toBe(0o600);
    expect(() => new CronStorage(projectA, join(root, "other-profile")).load()).toThrow(/explicit offline/);
  });

  it("keeps native proof, UNKNOWN, disabled intent and UTC spending through layout import", () => {
    const seed = storage(projectB);
    const now = new Date();
    seed.addJob(resilientDefinition(exampleJob({ type: "interval", schedule: "1h", intervalMs: 3_600_000, session: "owner", maxRuns: 4, maxRunsPerDay: 2, expiresAt: new Date(+now + 86_400_000).toISOString(), deadlineMs: 10_000 }), { workBudgetMs: 5_000 }));
    seed.queueResilient("job-1", "owner", { id: "tick", source: "timer", revision: 1, dueAt: now.toISOString() });
    const admitted = seed.reserveResilient("job-1", "owner", "instance", 1, "tick")!;
    expect(admitted.runtime.slot.kind).toBe("owned");
    if (admitted.runtime.slot.kind !== "owned") throw new Error("fixture did not reserve");
    const { attempt } = admitted.runtime.slot;
    const checkpoint = { sessionId: "owner", entryId: "checkpoint", runId: "native-run" };
    const proof: NativeExecutionProof = { version: 1, runId: "native-run", binding: { jobId: "job-1", attemptId: attempt.id, ownerSessionId: "owner", ownerEpoch: attempt.owner.epoch, revision: 1 }, finishedAt: now.toISOString(), execution: "interrupted", effectStatus: "unknown", businessOutcome: "unverified", checkpointEntryId: "checkpoint", failedRecoveryMs: 0 };
    expect(seed.settleResilient("job-1", attempt.id, attempt.owner, proof, checkpoint, { phase: "reconciling" })).toBe(true);
    seed.updateJob("job-1", { enabled: false }, "owner");
    const original = seed.getAllJobs();
    writeLegacy(projectA, original);
    const current = storage(projectA);
    current.importProjectStore(request(current));
    expect(current.getAllJobs()).toEqual(original);
    expect(current.getJob("job-1")).toMatchObject({ enabled: false, attemptCount: 1, lastStatus: "unknown", dailyUsage: { attempts: 1 }, attemptHistory: [{ nativeProof: proof, checkpoint }] });
  });

  it("holds on a stale source or target and under either writer's lock", () => {
    const current = storage(projectA);
    current.addJob(exampleJob());
    writeLegacy(projectA, [exampleJob({ id: "other", name: "other" })]);
    const before = readFileSync(current.getStorePath());
    const req = request(current);
    expect(() => current.importProjectStore({ ...req, writersConfirmedStopped: false })).toThrow(/verified stopped/);
    for (const file of [legacyPath(projectA), current.getStorePath()]) {
      writeFileSync(file + ".lock", "other writer");
      expect(() => current.importProjectStore(req)).toThrow(/busy/);
      expect(readFileSync(file + ".lock", "utf8")).toBe("other writer");
      rmSync(file + ".lock");
    }
    writeFileSync(current.getStorePath(), Buffer.concat([before, Buffer.from("\n")]));
    expect(() => current.importProjectStore(req)).toThrow(/Target store changed/);
    const fresh = request(current);
    writeLegacy(projectA, [exampleJob({ id: "changed", name: "changed" })]);
    expect(() => current.importProjectStore(fresh)).toThrow(/Legacy store changed/);
  });

  it("an interrupted replacement retains both inputs and can be retried on a fresh preview", () => {
    const current = storage(projectA);
    current.addJob(exampleJob());
    writeLegacy(projectA, [exampleJob({ id: "other", name: "other", enabled: false })]);
    const old = readFileSync(legacyPath(projectA));
    const prev = readFileSync(current.getStorePath());
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error("synthetic interruption before rename"); });
    expect(() => current.importProjectStore(request(current))).toThrow(/synthetic interruption/);
    expect(readFileSync(legacyPath(projectA))).toEqual(old);
    expect(readFileSync(current.getStorePath())).toEqual(prev);
    expect(readdirSync(dirname(current.getStorePath())).some(file => file.endsWith(".lock") || file.endsWith(".tmp"))).toBe(false);
    const result = current.importProjectStore(request(current));
    expect(readFileSync(result.backupPath!)).toEqual(prev);
    expect(current.getAllJobs().map(job => job.id)).toEqual(["job-1", "other"]);
  });

  it("runs the offline CLI without a session, prevents re-import and holds rollback after target activity", async () => {
    const current = storage(projectA);
    writeLegacy(projectA, [exampleJob({ enabled: false })], 3);
    const args = ["--cwd", projectA, "--agent-dir", agentDir];
    const loader = async () => ({ CronStorage });
    const preview = await runProjectCutover(["preview", ...args], loader);
    expect(existsSync(current.getStorePath())).toBe(false);
    const apply = ["apply", ...args, "--source-sha256", preview.sourceSha256, "--target-sha256", "absent", "--trusted-project"];
    await expect(runProjectCutover(apply, loader)).rejects.toThrow(/Usage/);
    expect(await runProjectCutover([...apply, "--writers-stopped"], loader)).toMatchObject({ changed: true, executionStarted: false });
    current.removeJob("job-1");
    const unchanged = readFileSync(current.getStorePath());
    expect(await runProjectCutover([...apply, "--writers-stopped"], loader)).toMatchObject({ changed: false, jobs: 0 });
    expect(readFileSync(current.getStorePath())).toEqual(unchanged);
    expect(await runProjectCutover(["rollback-check", ...args], loader)).toMatchObject({ action: "hold-diverged-or-incompatible", backupRestorationAllowed: false });
    expect(readdirSync(dirname(current.getStorePath()))).toEqual([basename(current.getStorePath())]);
  });

  it("supports idle jobs in the maintained legacy-compatible schema", () => {
    const current = storage(projectA);
    current.addJob(exampleJob({ type: "idle", schedule: "10m", intervalMs: 600_000 }));
    expect(current.getAllJobs()[0]).toMatchObject({ type: "idle", intervalMs: 600_000 });
  });
});
