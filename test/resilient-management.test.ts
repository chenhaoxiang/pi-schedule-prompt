import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronScheduler } from "../src/scheduler.js";
import { CronStorage } from "../src/storage.js";
import { createCronTool } from "../src/tool.js";
import type { CronJob, NativeExecutionProof, ResilientJob } from "../src/types.js";

const owned: string[] = [];
const schedulers: CronScheduler[] = [];
function fixture(scope: "session" | "workdir" = "session", supported = true) {
  const root = path.resolve("tmp/resilient-management-fixtures"); fs.mkdirSync(root, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(root, "case-")); owned.push(cwd);
  const entries = new Map<string, any>();
  const ctx = { cwd, isIdle: () => false, hasPendingMessages: () => false, abort: vi.fn(), hasUI: false, modelRegistry: { getAvailable: () => [] }, sessionManager: { getSessionId: () => "owner", getSessionFile: () => path.join(cwd, "native.jsonl"), getEntries: () => [...entries.values()], getEntry: (id: string) => entries.get(id) }, ...(supported ? { scheduledExecution: { version: 1, active: undefined as any, start: vi.fn(() => ({ accepted: false, reason: "busy" })) } } : {}) };
  const storage = new CronStorage(cwd); const pi = { sendMessage: vi.fn(), appendEntry: vi.fn(), events: { emit: vi.fn() } };
  const scheduler = new CronScheduler(storage, pi as any, ctx as any); schedulers.push(scheduler); scheduler.start();
  const tool = createCronTool(() => storage, () => scheduler, () => scope);
  const call = (params: any, context: any = ctx) => tool.execute("fixture", params, undefined, undefined, context);
  const add = (extra: any = {}) => call({ action: "add", type: "interval", schedule: "1h", mode: "resilient", prompt: "private synthetic goal", maxRuns: 5, expiresAt: new Date(Date.now() + 86400000).toISOString(), ...extra });
  const row = (id: string) => storage.getJob(id) as ResilientJob;
  return { cwd, entries, ctx, pi, storage, scheduler, tool, call, add, row };
}
function closedUnknown(h: ReturnType<typeof fixture>, id: string, extra: Partial<NativeExecutionProof> = {}) {
  const job = h.row(id); const tick = { id: "synthetic-closed-tick", dueAt: new Date().toISOString(), revision: job.revision!, source: "timer" as const };
  h.storage.queueResilient(id, "owner", tick);
  const reserved = h.storage.reserveResilient(id, "owner", "fixture-owner", job.revision!, tick.id)!;
  if (reserved.runtime.slot.kind !== "owned") throw new Error("No synthetic owner");
  const attempt = reserved.runtime.slot.attempt; const runId = "native-" + attempt.id;
  h.storage.bindResilientNative(id, attempt.id, attempt.owner, { runId, sessionId: "owner", startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + attempt.deadlineMs).toISOString() });
  const checkpoint = { sessionId: "owner", runId, entryId: "checkpoint-" + attempt.id, sessionFile: h.ctx.sessionManager.getSessionFile() };
  const proof: NativeExecutionProof = { version: 1, runId, binding: { jobId: id, attemptId: attempt.id, ownerSessionId: "owner", ownerEpoch: attempt.owner.epoch, revision: attempt.revision }, finishedAt: new Date().toISOString(), execution: "completed", checkpointEntryId: checkpoint.entryId, effectStatus: "unknown", businessOutcome: "unverified", failedRecoveryMs: 0, ...extra };
  h.entries.set(checkpoint.entryId, { type: "custom", customType: "pi.scheduled-checkpoint.v1", data: { ...proof, completedResults: [], completedResultCount: 0, declarations: { nextAction: "consume the retained synthetic checkpoint" } } });
  h.storage.settleResilient(id, attempt.id, attempt.owner, proof, checkpoint, { phase: "reconciling", reason: "effect_unknown" });
  return { attempt, proof, checkpoint };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-04T00:00:00.000Z")); });
afterEach(() => { for (const scheduler of schedulers.splice(0)) scheduler.stop(); vi.useRealTimers(); for (const cwd of owned.splice(0)) fs.rmSync(cwd, { recursive: true, force: true }); });

describe("canonical resilient management", () => {
  it("reports bounded loaded schedule/native capability metadata without inferring unrelated SDK closure", () => {
    const h = fixture(); const readback = h.scheduler.runtimeReadback();
    expect(readback.loadedSchedule).toMatchObject({ name: "pi-schedule-prompt", version: JSON.parse(fs.readFileSync("package.json", "utf8")).version, readerSchemas: [1, 2, 3, 4] });
    expect(readback.sessionId).toBe("owner"); expect(readback.pid).toBe(process.pid); expect(readback.nativeCapabilityVersion).toBe(1);
    expect(readback.registered).toMatchObject({ running: true, legacyDurableBusy: false, activeLegacyJobCount: 0, activeLegacyModelControllerCount: 0, pendingJobCount: 0 });
    expect(readback.untrackedSdkHandles).toBe("not-observed"); expect(readback.closureEvidence).toContain("not proof");
  });

  it("reports actual active/registered tool provenance with bounded metadata and unknown on missing or throwing APIs", () => {
    const h = fixture(); expect(h.scheduler.runtimeReadback().tools).toMatchObject({ state: "unknown", active: null, registered: null });
    const pi = h.pi as any;
    pi.getActiveTools = () => ["read"];
    pi.getAllTools = () => [{ name: "read", exposure: "direct", sourceInfo: { source: "builtin", path: "builtin:read" }, parameters: { PRIVATE_SCHEMA: "must not leak" }, description: "PRIVATE_DESCRIPTION" }];
    const observed = h.scheduler.runtimeReadback();
    expect(observed.sessionFile).toBe(h.ctx.sessionManager.getSessionFile());
    expect(observed.tools).toEqual({ state: "observed", truncated: false, active: ["read"], registered: [{ name: "read", exposure: "direct", source: "builtin", path: "builtin:read", reachesTools: false }] });
    expect(JSON.stringify(observed)).not.toContain("PRIVATE_");
    pi.getAllTools = () => Array.from({ length: 70 }, (_, index) => ({ name: String(index), exposure: "deferred", sourceInfo: { source: "sdk", path: "x".repeat(1100) }, reachesTools: () => "all" }));
    const bounded = h.scheduler.runtimeReadback().tools; expect(bounded.truncated).toBe(true); expect(bounded.registered).toHaveLength(64); expect(bounded.registered![0].path).toHaveLength(1024); expect(bounded.registered![0].reachesTools).toBe(true);
    pi.getActiveTools = () => { throw new Error("unavailable"); };
    expect(h.scheduler.runtimeReadback().tools.state).toBe("unknown");
  });

  it("creates schema4 only for an explicit new resilient store and defaults to completion-delay", async () => {
    const h = fixture(); const result = await h.add(); expect(result.isError).not.toBe(true);
    const job = h.row(result.details!.jobId!);
    expect(h.storage.load().version).toBe(4); expect(job).toMatchObject({ session: "owner", durable: true, maxRuns: 5, attemptCount: 0, policy: { mode: "resilient", version: 1, intervalMode: "fixed-delay", overlapPolicy: "skip", misfirePolicy: "skip" } });
    expect(h.ctx.scheduledExecution!.start).not.toHaveBeenCalled();
  });

  it("persists explicit anchored rate/cron timezone and rejects conflicting selectors before mutation", async () => {
    const h = fixture(); const rate = await h.add({ intervalMode: "fixed-rate", overlapPolicy: "buffer-one", catchUp: "latest", misfirePolicy: "latest", latenessMs: 60000, workBudgetMs: 300000, deadlineMs: 600000 });
    expect(rate.isError).not.toBe(true); expect(h.row(rate.details!.jobId!).policy).toMatchObject({ intervalMode: "fixed-rate", overlapPolicy: "buffer-one", misfirePolicy: "latest", workBudgetMs: 300000 });
    const calendar = await h.add({ type: "cron", schedule: "0 0 9 * * *", timezone: "Asia/Tokyo" }); expect(calendar.isError).not.toBe(true); expect(h.row(calendar.details!.jobId!).policy.timezone).toBe("Asia/Tokyo");
    const bytes = fs.readFileSync(h.storage.getStorePath());
    for (const extra of [{ intervalMode: "fixed-delay", timezone: "UTC" }, { type: "cron", schedule: "0 * * * * *", intervalMode: "fixed-rate" }, { catchUp: "latest", misfirePolicy: "skip" }, { workBudgetMs: 600000, deadlineMs: 600000 }, { durable: false }]) {
      expect((await h.add(extra)).isError).toBe(true); expect(fs.readFileSync(h.storage.getStorePath())).toEqual(bytes);
    }
  });

  it("refuses unsupported hosts, shared mode and unbounded definitions without writing a store", async () => {
    for (const make of [() => fixture("session", false), () => fixture("workdir", true)]) {
      const h = make(); expect((await h.add()).isError).toBe(true); expect(fs.existsSync(h.storage.getStorePath())).toBe(false);
    }
    const h = fixture(); expect((await h.add({ maxRuns: undefined })).isError).toBe(true); expect((await h.add({ expiresAt: undefined })).isError).toBe(true); expect(fs.existsSync(h.storage.getStorePath())).toBe(false);
  });

  it("never silently promotes an existing schema3 store or legacy cadence through add/update", async () => {
    const h = fixture(); const legacy = await h.call({ action: "add", type: "interval", schedule: "1h", prompt: "legacy" }); const id = legacy.details!.jobId!;
    const bytes = fs.readFileSync(h.storage.getStorePath()); expect(h.storage.load().version).toBe(3);
    expect((await h.add()).isError).toBe(true); expect((await h.call({ action: "update", jobId: id, mode: "resilient", intervalMode: "fixed-delay" })).isError).toBe(true);
    expect((await h.call({ action: "update", jobId: id, intervalMode: "fixed-rate" })).isError).toBe(true); expect(fs.readFileSync(h.storage.getStorePath())).toEqual(bytes);
    const preview = await h.call({ action: "preview" }); expect(preview.isError).not.toBe(true); expect(fs.readFileSync(h.storage.getStorePath())).toEqual(bytes);
  });

  it("updates canonical future policy and user enablement without overwriting spending/history", async () => {
    const h = fixture(); const added = await h.add(); const id = added.details!.jobId!; const first = closedUnknown(h, id); const history = h.row(id).attemptHistory;
    expect((await h.call({ action: "update", jobId: id, intervalMode: "fixed-rate", overlapPolicy: "buffer-one", misfirePolicy: "latest", catchUp: "latest" })).isError).not.toBe(true);
    expect(h.row(id)).toMatchObject({ attemptCount: 1, policy: { intervalMode: "fixed-rate", overlapPolicy: "buffer-one", misfirePolicy: "latest" }, runtime: { continuation: { attemptId: first.attempt.id } } }); expect(h.row(id).attemptHistory).toEqual(history);
    expect((await h.call({ action: "disable", jobId: id })).isError).not.toBe(true); expect(h.row(id).enabled).toBe(false);
    expect((await h.call({ action: "enable", jobId: id })).isError).not.toBe(true); expect(h.row(id).enabled).toBe(true); expect(h.row(id).runtime.slot.phase).toBe("reconciling");
    expect((await h.call({ action: "update", jobId: id, mode: "legacy" })).isError).toBe(true); expect(h.row(id).attemptHistory).toEqual(history);
  });

  it("keeps exact owner control and retains history on remove/cleanup", async () => {
    const h = fixture(); const added = await h.add(); const id = added.details!.jobId!; closedUnknown(h, id);
    const foreign = { ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionId: () => "foreign" } };
    expect((await h.call({ action: "disable", jobId: id }, foreign)).isError).toBe(true);
    expect((await h.call({ action: "remove", jobId: id })).isError).not.toBe(true); expect(h.row(id)).toMatchObject({ enabled: false, attemptCount: 1 });
    expect((await h.call({ action: "cleanup" })).isError).not.toBe(true); expect(h.row(id).attemptHistory).toHaveLength(1);
  });

  it("reconciles exact evidence idempotently without mutating the old UNKNOWN or granting a scoped replay", async () => {
    const h = fixture(); const added = await h.add(); const id = added.details!.jobId!; const first = closedUnknown(h, id); const original = h.row(id).attemptHistory;
    const scoped = { action: "reconcile", jobId: id, attemptId: first.attempt.id, evidenceFingerprint: "a".repeat(64), resolution: "continue", safeScopes: ["read-only"] };
    expect((await h.call(scoped)).isError).not.toBe(true); expect(h.row(id).runtime.slot.phase).toBe("reconciling"); expect(h.row(id).attemptCount).toBe(1);
    const resolved = { ...scoped, evidenceFingerprint: "b".repeat(64), safeScopes: [] };
    expect((await h.call(resolved)).isError).not.toBe(true); const count = h.row(id).attemptResolutions.length;
    expect((await h.call(resolved)).isError).not.toBe(true); expect(h.row(id).attemptResolutions).toHaveLength(count); expect(h.row(id).attemptHistory).toEqual(original); expect(h.row(id).attemptCount).toBe(1); expect(h.ctx.scheduledExecution!.start).not.toHaveBeenCalled();
  });

  it("keeps provider Retry-After and UTC-day bounds stronger than an owner checkpoint continuation", async () => {
    const h = fixture(); const added = await h.add({ maxRunsPerDay: 1, expiresAt: new Date(Date.now() + 3 * 86400000).toISOString() }); const id = added.details!.jobId!;
    const notBefore = new Date(Date.now() + 3 * 3600000).toISOString(); const first = closedUnknown(h, id, { execution: "deferred", retryNotBefore: notBefore });
    expect((await h.call({ action: "reconcile", jobId: id, attemptId: first.attempt.id, evidenceFingerprint: "a".repeat(64), resolution: "continue" })).isError).not.toBe(true);
    expect(h.row(id).runtime.notBefore).toBe(notBefore); expect(h.scheduler.getNextRun(id)?.toISOString()).toBe("2026-11-05T00:00:00.000Z"); expect(h.row(id).attemptCount).toBe(1); expect(h.ctx.scheduledExecution!.start).not.toHaveBeenCalled();
  });

  it("reconciles a migrated legacy claim through the official tool without making another job or native proof", async () => {
    const h = fixture(); const legacy: CronJob = { id: "imported", name: "imported", type: "cron", schedule: "0 0 * * * *", prompt: "private synthetic goal", enabled: false, session: "owner", durable: true, createdAt: new Date().toISOString(), runCount: 4, attemptCount: 4, maxRuns: 126, expiresAt: new Date(Date.now() + 86400000).toISOString(), maxRunsPerDay: 24, deadlineMs: 2700000, lastStatus: "unknown", claim: { id: "legacy-claim", binding: "c".repeat(64), sessionId: "owner", ownerId: "fixture", ownerPid: 1, phase: "settled", outcome: "unknown", claimedAt: new Date().toISOString(), deadlineAt: new Date().toISOString() } };
    h.storage.addJob(legacy); h.storage.migrateJobToSchema4(legacy.id, "owner", { expectedSha256: h.storage.previewSchema4Migration().originalSha256, policy: { timezone: "UTC" }, inspectRuntime: () => ({ status: "verified", activeRunIds: [], incompatibleWriterIds: [] }) });
    const params = { action: "reconcile", jobId: legacy.id, claimId: legacy.claim!.id, claimBinding: legacy.claim!.binding, evidenceFingerprint: "e".repeat(64), resolution: "continue" };
    expect((await h.call({ ...params, claimBinding: undefined })).isError).toBe(true);
    expect((await h.call({ ...params, attemptId: "other" })).isError).toBe(true);
    h.scheduler.setScheduledTurn(true); expect((await h.call(params)).isError).toBe(true); h.scheduler.setScheduledTurn(false);
    expect((await h.call(params)).isError).not.toBe(true); expect((await h.call(params)).isError).not.toBe(true);
    expect(h.row(legacy.id)).toMatchObject({ enabled: false, attemptCount: 4, maxRuns: 126, claim: legacy.claim, attemptHistory: [] });
    expect((await h.call({ action: "enable", jobId: legacy.id })).isError).not.toBe(true);
    expect(h.scheduler.getNextRun(legacy.id)?.toISOString()).toBe("2026-11-04T01:00:00.000Z");
    expect(h.storage.getAllJobs()).toHaveLength(1); expect(h.ctx.scheduledExecution!.start).not.toHaveBeenCalled();
  });

  it("can record/release an exact retained input wait with no observed effects without replaying completed history", async () => {
    const h = fixture(); const added = await h.add(); const id = added.details!.jobId!; const first = closedUnknown(h, id, { execution: "deferred", effectStatus: "none-observed" }); const history = h.row(id).attemptHistory;
    expect((await h.call({ action: "reconcile", jobId: id, attemptId: first.attempt.id, evidenceFingerprint: "a".repeat(64), resolution: "waiting-input" })).isError).not.toBe(true); expect(h.row(id).runtime.slot.phase).toBe("waiting-input");
    expect((await h.call({ action: "reconcile", jobId: id, attemptId: first.attempt.id, evidenceFingerprint: "b".repeat(64), resolution: "continue" })).isError).not.toBe(true);
    expect(h.row(id).attemptHistory).toEqual(history); expect(h.row(id).attemptCount).toBe(1); expect(h.ctx.scheduledExecution!.start).not.toHaveBeenCalled();
  });

  it("drains only the exact owned native handle through its local checkpoint API", async () => {
    const h = fixture(); const added = await h.add(); const id = added.details!.jobId!; const job = h.row(id); const now = new Date().toISOString();
    h.storage.queueResilient(id, "owner", { id: "owned-tick", revision: job.revision!, dueAt: now, source: "timer" });
    const reserved = h.storage.reserveResilient(id, "owner", "fixture-owner", job.revision!, "owned-tick")!; if (reserved.runtime.slot.kind !== "owned") throw new Error("No fixture owner"); const attempt = reserved.runtime.slot.attempt;
    const runId = "owned-native-run"; const binding = { jobId: id, attemptId: attempt.id, ownerSessionId: "owner", ownerEpoch: attempt.owner.epoch, revision: attempt.revision };
    const handle = { runId, settled: new Promise(() => {}), snapshot: () => ({ runId, binding, phase: "running", nativeClosed: false, ownedHandles: [], startedAt: now, softDeadlineAt: new Date(Date.now() + attempt.workBudgetMs).toISOString(), hardDeadlineAt: new Date(Date.now() + attempt.deadlineMs).toISOString(), requestCount: 1, retryCount: 0, failedRecoveryMs: 0, providerPhase: "unknown" }), checkpoint: vi.fn(() => "checkpoint"), requestDrain: vi.fn(() => true), requestCancel: vi.fn(), own: vi.fn() };
    h.ctx.scheduledExecution!.active = handle; h.scheduler.start();
    const result = await h.call({ action: "drain", jobId: id }); expect(result.isError).not.toBe(true); expect(handle.checkpoint).toHaveBeenCalledOnce(); expect(handle.requestDrain).toHaveBeenCalledWith("operator_drain"); expect(h.ctx.abort).not.toHaveBeenCalled(); expect(h.ctx.scheduledExecution!.start).not.toHaveBeenCalled();
    expect((await h.call({ action: "drain", jobId: "unrelated" })).isError).toBe(true);
  });

  it("does not let an actual scheduled turn renew definitions or self-certify reconciliation", async () => {
    const h = fixture(); const added = await h.add(); const id = added.details!.jobId!; const first = closedUnknown(h, id); const bytes = fs.readFileSync(h.storage.getStorePath()); h.scheduler.setScheduledTurn(true);
    for (const params of [{ action: "update", jobId: id, maxRuns: 999 }, { action: "enable", jobId: id }, { action: "reconcile", jobId: id, attemptId: first.attempt.id, evidenceFingerprint: "a".repeat(64), resolution: "continue" }]) expect((await h.call(params)).isError).toBe(true);
    expect(fs.readFileSync(h.storage.getStorePath())).toEqual(bytes);
  });

  it("exposes bounded status without prompts or model wakes", async () => {
    const h = fixture(); for (let index = 0; index < 22; index++) expect((await h.add({ name: "job-" + index })).isError).not.toBe(true);
    const bytes = fs.readFileSync(h.storage.getStorePath()); const result = await h.call({ action: "status" });
    expect(result.isError).not.toBe(true); expect(result.details!.status).toHaveLength(20); expect(result.details!.truncated).toBe(true); expect(result.details!.jobs).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private synthetic goal"); expect(fs.readFileSync(h.storage.getStorePath())).toEqual(bytes); expect(h.ctx.scheduledExecution!.start).not.toHaveBeenCalled();
  });
});
