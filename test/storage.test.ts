import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CronStorage, projectKey } from "../src/storage.js";
import type { CronJob } from "../src/types.js";

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

function currentProjectPath(cwd: string): string {
  return realpathSync.native(cwd);
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
    root = mkdtempSync(join(tmpdir(), "pi-schedule-storage-"));
    agentDir = join(root, "agent");
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
  const writeLegacy = (cwd: string, jobs: CronJob[]) => {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(legacyPath(cwd), JSON.stringify({ version: 4, jobs }, null, 2), { mode: 0o600 });
  };

  it("stores jobs under the profile/project hash and records canonical cwd", () => {
    const current = storage(projectA);
    current.addJob(exampleJob());
    const file = join(agentDir, "schedule-prompts", "projects", `${projectKey(projectA)}.json`);
    expect(current.getStorePath()).toBe(file);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ cwd: currentProjectPath(projectA), jobs: [{ name: "demo" }] });
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
    rmSync(join(projectA, ".pi"), { recursive: true, force: true });
    expect(current.getJob("same")?.prompt).toBe("target");
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

  it("supports idle jobs in the maintained legacy-compatible schema", () => {
    const current = storage(projectA);
    current.addJob(exampleJob({ type: "idle", schedule: "10m", intervalMs: 600_000 }));
    expect(current.getAllJobs()[0]).toMatchObject({ type: "idle", intervalMs: 600_000 });
  });
});
