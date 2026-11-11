import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRetirementArguments, runRetirement } from "../scripts/retire-expired.mjs";
import { resilientDefinition } from "../src/resilient-policy.js";
import { CronStorage } from "../src/storage.js";
import type { ModelSdkCloseProof, NativeExecutionProof, ResilientJob } from "../src/types.js";

const dirs: string[] = [];
const root = path.resolve("tmp/expired-retirement-fixtures");
function fixture() {
  fs.mkdirSync(root, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(root, "case-")); dirs.push(cwd);
  const storage = new CronStorage(cwd);
  const now = Date.now();
  const job = resilientDefinition({ id: "job", name: "job", type: "interval", schedule: "1s", intervalMs: 1000, prompt: "synthetic secret must not appear in metadata", enabled: true, createdAt: new Date(now).toISOString(), session: "retired-owner", model: "fixture/model", runCount: 0, maxRuns: 4, deadlineMs: 10_000, expiresAt: new Date(now + 60_000).toISOString() }, { workBudgetMs: 5000 });
  fs.mkdirSync(path.dirname(storage.getStorePath()), { mode: 0o700 });
  fs.writeFileSync(storage.getStorePath(), JSON.stringify({ version: 4, jobs: [job, { id: "other", name: "other", type: "once", schedule: "+1h", prompt: "unrelated private fixture", enabled: false, createdAt: new Date(now).toISOString(), runCount: 0 }] }), { mode: 0o600 });
  const tick = { id: "tick", dueAt: new Date(now).toISOString(), revision: job.revision!, source: "timer" as const };
  storage.queueResilient(job.id, job.session!, tick);
  const claimed = storage.reserveResilient(job.id, job.session!, "old-runtime", job.revision!, tick.id)!;
  if (claimed.runtime.slot.kind !== "owned") throw new Error("fixture admission missing");
  const attempt = claimed.runtime.slot.attempt;
  const sessionId = attempt.nativeSessionId!, runId = "synthetic-native-run";
  storage.bindResilientNative(job.id, attempt.id, attempt.owner, { runId, sessionId, startedAt: new Date(now).toISOString(), deadlineAt: new Date(now + 10_000).toISOString() });
  const nativeDir = path.join(cwd, ".pi/schedule-native"); fs.mkdirSync(nativeDir);
  const nativeFile = path.join(nativeDir, "synthetic.jsonl");
  const checkpoint = { sessionId, runId, entryId: "checkpoint", sessionFile: nativeFile };
  const native: NativeExecutionProof = { version: 1, runId, binding: { jobId: job.id, attemptId: attempt.id, ownerSessionId: sessionId, ownerEpoch: attempt.owner.epoch, revision: attempt.revision }, finishedAt: new Date(now).toISOString(), execution: "completed", checkpointEntryId: checkpoint.entryId, effectStatus: "unknown", businessOutcome: "unverified", failedRecoveryMs: 0 };
  const sdk: ModelSdkCloseProof = { version: 1, runId, binding: { ...native.binding }, checkpointEntryId: checkpoint.entryId, closedAt: new Date(now + 1).toISOString() };
  const entries = [
    { type: "session", version: 3, id: sessionId, cwd },
    { type: "custom", id: "checkpoint", customType: "pi.scheduled-checkpoint.v1", data: { version: 1, runId, binding: native.binding } },
    { type: "custom", id: "receipt", customType: "pi.scheduled-receipt.v1", data: native },
    { type: "custom", id: "sdk-close", customType: "schedule.model-sdk-closed.v1", data: sdk },
  ];
  const writeNative = () => fs.writeFileSync(nativeFile, entries.map(e => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
  writeNative();
  storage.settleResilient(job.id, attempt.id, attempt.owner, native, checkpoint, { phase: "reconciling", reason: "effect_unknown" }, sdk);
  vi.advanceTimersByTime(61_000);
  const bytes = () => fs.readFileSync(storage.getStorePath());
  const change = (update: (job: ResilientJob) => void) => { const data = storage.load(); update(data.jobs[0] as ResilientJob); fs.writeFileSync(storage.getStorePath(), JSON.stringify(data)); };
  return { cwd, storage, nativeFile, entries, writeNative, bytes, change, attempt };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-11T18:00:00.000Z")); });
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("explicit offline expired-model retirement", () => {
  it("previews without writing and retires only future intent, preserving exact UNKNOWN, owner, history, budget and other rows", () => {
    const h = fixture(), before = h.bytes(), original = h.storage.load();
    expect(() => h.storage.removeJob("job", "foreign-session")).toThrow(/owning session/);
    const preview = h.storage.previewExpiredRetirement("job", "retired-owner");
    expect(h.bytes()).toEqual(before);
    expect(preview.expectedSha256).toBe(createHash("sha256").update(before).digest("hex"));
    expect(JSON.stringify(preview)).not.toContain("synthetic secret");
    const result = h.storage.retireExpiredJob("job", "retired-owner", preview.expectedSha256);
    expect(result.changed).toBe(true);
    const after = h.storage.load();
    expect(after).toEqual({ ...original, jobs: original.jobs.map(j => j.id === "job" ? { ...j, enabled: false } : j) });
    expect(after.jobs[0].lastStatus).toBe("unknown");
    expect(fs.readFileSync(path.join(path.dirname(h.storage.getStorePath()), result.backupRef!))).toEqual(before);
    expect(fs.statSync(path.join(path.dirname(h.storage.getStorePath()), result.backupRef!)).mode & 0o777).toBe(0o600);
    const once = h.bytes(), again = h.storage.previewExpiredRetirement("job", "retired-owner");
    expect(h.storage.retireExpiredJob("job", "retired-owner", again.expectedSha256).changed).toBe(false);
    expect(h.bytes()).toEqual(once);
  });
  it("refuses a changed snapshot and does not overwrite unrelated newer work", () => {
    const h = fixture(), preview = h.storage.previewExpiredRetirement("job", "retired-owner");
    h.storage.updateJob("other", { description: "newer unrelated metadata" }); const before = h.bytes();
    expect(() => h.storage.retireExpiredJob("job", "retired-owner", preview.expectedSha256)).toThrow(/changed/);
    expect(h.bytes()).toEqual(before);
  });
  it.each(["wrong-owner", "other"])("refuses mismatched exact scope %s", value => {
    const h = fixture(), before = h.bytes();
    expect(() => h.storage.previewExpiredRetirement(value === "other" ? value : "job", value === "other" ? "retired-owner" : value)).toThrow(/scope/);
    expect(h.bytes()).toEqual(before);
  });
  it("refuses a nonexpired definition", () => {
    const h = fixture(); h.change(j => { j.expiresAt = new Date(Date.now() + 1000).toISOString(); }); const before = h.bytes();
    expect(() => h.storage.previewExpiredRetirement("job", "retired-owner")).toThrow(/expired/);
    expect(h.bytes()).toEqual(before);
  });
  it("refuses pending intent even when expired", () => {
    const h = fixture(); h.change(j => { j.runtime.pending = { id: "pending", dueAt: new Date().toISOString(), revision: j.revision!, source: "timer" }; }); const before = h.bytes();
    expect(() => h.storage.previewExpiredRetirement("job", "retired-owner")).toThrow(/idle|pending/);
    expect(h.bytes()).toEqual(before);
  });
  it.each(["missing-ack", "foreign-ack", "later-entry", "missing-checkpoint", "malformed-tail"])("refuses %s closure metadata without changing state", mode => {
    const h = fixture();
    if (mode === "missing-ack") h.entries.pop();
    if (mode === "foreign-ack") (h.entries.at(-1)!.data as ModelSdkCloseProof).binding.attemptId = "foreign";
    if (mode === "later-entry") h.entries.push({ type: "custom", id: "later", customType: "pi.scheduled-start.v1", data: {} } as typeof h.entries[number]);
    if (mode === "missing-checkpoint") h.entries.splice(1, 1);
    h.writeNative(); if (mode === "malformed-tail") fs.appendFileSync(h.nativeFile, "not-json\n");
    const before = h.bytes(); expect(() => h.storage.previewExpiredRetirement("job", "retired-owner")).toThrow(/closure|checkpoint|transcript/);
    expect(h.bytes()).toEqual(before);
  });
  it("honors the existing store lock, never breaks it or changes intent", () => {
    const h = fixture(), preview = h.storage.previewExpiredRetirement("job", "retired-owner"), before = h.bytes();
    fs.writeFileSync(h.storage.getStorePath() + ".lock", "owned synthetic lock");
    expect(() => h.storage.retireExpiredJob("job", "retired-owner", preview.expectedSha256)).toThrow(/busy/);
    expect(h.bytes()).toEqual(before);
    expect(fs.readFileSync(h.storage.getStorePath() + ".lock", "utf8")).toBe("owned synthetic lock");
  });
  it("rechecks closure inside the atomic mutation instead of trusting an earlier preview", () => {
    const h = fixture(), preview = h.storage.previewExpiredRetirement("job", "retired-owner"), before = h.bytes();
    h.entries.pop(); h.writeNative();
    expect(() => h.storage.retireExpiredJob("job", "retired-owner", preview.expectedSha256)).toThrow(/closure/);
    expect(h.bytes()).toEqual(before);
  });
  it("refuses actual owned execution despite expiry", () => {
    const h = fixture(); h.change(j => {
      j.attemptCount!++;
      if (j.dailyUsage) j.dailyUsage.attempts++;
      j.runtime.slot = { kind: "owned", phase: "draining", attempt: { ...h.attempt, id: "still-live", occurrence: { ...h.attempt.occurrence, id: "second" } } };
    });
    const before = h.bytes(); expect(() => h.storage.previewExpiredRetirement("job", "retired-owner")).toThrow(/idle/);
    expect(h.bytes()).toEqual(before);
  });
  it("does not infer closure of imported legacy attempts", () => {
    const h = fixture(); h.change(j => { j.runtime.baselineAttempts++; j.attemptCount!++; });
    const before = h.bytes(); expect(() => h.storage.previewExpiredRetirement("job", "retired-owner")).toThrow(/legacy/);
    expect(h.bytes()).toEqual(before);
  });
  it("rejects symlinked native sources", () => {
    const h = fixture(); fs.renameSync(h.nativeFile, h.nativeFile + ".original"); fs.symlinkSync(h.nativeFile + ".original", h.nativeFile);
    const before = h.bytes(); expect(() => h.storage.previewExpiredRetirement("job", "retired-owner")).toThrow(/canonical/);
    expect(h.bytes()).toEqual(before);
  });
  it("requires a CAS digest even when called outside the CLI", () => {
    const h = fixture(), before = h.bytes(); expect(() => h.storage.retireExpiredJob("job", "retired-owner", "")).toThrow(/SHA-256/);
    expect(h.bytes()).toEqual(before);
  });
  it("runs the actual CLI preview/apply path against synthetic storage without starting an SDK", async () => {
    const h = fixture(), before = h.bytes(), args = ["--cwd", h.cwd, "--job", "job", "--expected-owner", "retired-owner"];
    const load = async () => ({ CronStorage });
    const preview = await runRetirement(args, load);
    expect(preview.action).toBe("preview-retirement"); expect(h.bytes()).toEqual(before);
    const result = await runRetirement([...args, "--apply", "--sha256", preview.expectedSha256], load);
    expect(result).toMatchObject({ action: "retire-expired", enabled: false, changed: true, historyRetained: true, ownerChanged: false, effectsReconciled: false, executionStarted: false, sdkCreated: false });
    expect(JSON.stringify(result)).not.toContain("synthetic secret");
  });
  it.each([
    [], ["--cwd", "/synthetic", "--job", "job", "--expected-owner", "owner", "--apply"],
    ["--cwd", "relative", "--job", "job", "--expected-owner", "owner"],
    ["--cwd", "/synthetic", "--job", "../job", "--expected-owner", "owner"],
    ["--cwd", "/synthetic", "--job", "job", "--expected-owner", "owner", "--sha256", "a".repeat(64)],
    ["--cwd", "/synthetic", "--job", "job", "--expected-owner", "owner", "--all"],
  ].map(args => ({ args })))("refuses incomplete or widened CLI scope $args", ({ args }) => {
    expect(() => parseRetirementArguments(args)).toThrow(/arguments/);
  });
});
