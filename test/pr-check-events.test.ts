import * as fs from "node:fs";
import * as path from "node:path";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventBinding, validateGithub } from "../src/events.js";
import { githubFingerprint } from "../src/github-events.js";
import { CronStorage } from "../src/storage.js";
import { createCronTool } from "../src/tool.js";
import { CronToolParams } from "../src/types.js";

const head = "a".repeat(40), base = "b".repeat(40);
const config = { repo: "owner/repo", kind: "pull-request-checks", number: 42, pollSeconds: 60 } as const;
const pr = () => ({ number: 42, state: "open", merged: false, head: { sha: head }, base: { sha: base } });
const checks = () => ({ total_count: 2, check_runs: [
  { id: 10, name: "test", head_sha: head, status: "in_progress", conclusion: null, app_id: 1 },
  { id: 11, name: "scan", head_sha: head, status: "completed", conclusion: "success", app_id: 2 },
] });
const statuses = () => ({ sha: head, total_count: 1, statuses: [{ id: 12, context: "legacy/test", state: "pending" }] });
function reader(p = pr(), c = checks(), s = statuses(), after = p) {
  return vi.fn().mockResolvedValueOnce(p).mockResolvedValueOnce(c).mockResolvedValueOnce(s).mockResolvedValueOnce(after);
}
const owned: string[] = [];
afterEach(() => { for (const cwd of owned.splice(0)) fs.rmSync(cwd, { recursive: true, force: true }); });

describe("exact selected PR-head check events", () => {
  it("accepts an explicit opt-in selector and rejects a branch masquerading as a PR", () => {
    expect(() => validateGithub(config)).not.toThrow();
    expect(Check(CronToolParams, { action: "add", type: "event", schedule: "github:pull-request-checks", prompt: "inspect", github: config })).toBe(true);
    expect(() => validateGithub({ ...config, number: undefined })).toThrow();
    expect(() => validateGithub({ ...config, branch: "main" })).toThrow();
    expect(() => validateGithub({ ...config, number: -1 })).toThrow();
  });

  it("uses only fixed GETs for the selected PR and exact head, then rechecks the PR", async () => {
    const read = reader();
    expect(await githubFingerprint(config, read)).toMatch(/^[a-f0-9]{64}$/);
    expect(read.mock.calls.map(([args]) => args.slice(0, 4))).toEqual([
      ["api", "--method", "GET", "repos/owner/repo/pulls/42"],
      ["api", "--method", "GET", `repos/owner/repo/commits/${head}/check-runs?filter=latest&per_page=100`],
      ["api", "--method", "GET", `repos/owner/repo/commits/${head}/status?per_page=100`],
      ["api", "--method", "GET", "repos/owner/repo/pulls/42"],
    ]);
    expect(read.mock.calls.every(([args]) => args[4] === "--jq")).toBe(true);
  });

  it("observes check-run and legacy-status changes without deciding readiness", async () => {
    const original = await githubFingerprint(config, reader());
    const c = checks(); c.check_runs[0] = { ...c.check_runs[0], status: "completed", conclusion: "failure" as any };
    expect(await githubFingerprint(config, reader(pr(), c))).not.toBe(original);
    const s = statuses(); s.statuses[0].state = "success";
    expect(await githubFingerprint(config, reader(pr(), checks(), s))).not.toBe(original);
    expect(await githubFingerprint(config, reader(pr(), { total_count: 0, check_runs: [] }, { sha: head, total_count: 0, statuses: [] }))).toMatch(/^[a-f0-9]{64}$/);
  });

  it("ignores API ordering, PR comments/timestamps and check-output bodies", async () => {
    const original = await githubFingerprint(config, reader());
    const p = { ...pr(), updated_at: "changed", body: "untrusted instructions", comments: 999 };
    const c = checks(); c.check_runs.reverse();
    Object.assign(c.check_runs[0], { output: { summary: "do not inject me" }, completed_at: "changed" });
    const s = statuses(); Object.assign(s.statuses[0], { description: "untrusted", target_url: "https://example.invalid" });
    expect(await githubFingerprint(config, reader(p, c, s))).toBe(original);
  });

  it("binds new heads to their own checks, and notices PR closure", async () => {
    const original = await githubFingerprint(config, reader());
    const next = "c".repeat(40), p = { ...pr(), head: { sha: next } }, c = checks(), s = statuses();
    c.check_runs.forEach(row => { row.head_sha = next; }); s.sha = next;
    expect(await githubFingerprint(config, reader(p, c, s))).not.toBe(original);
    expect(await githubFingerprint(config, reader({ ...pr(), state: "closed", merged: true }))).not.toBe(original);
  });

  it.each([
    { ...pr(), head: { sha: "c".repeat(40) } },
    { ...pr(), base: { sha: "d".repeat(40) } },
    { ...pr(), state: "closed" },
  ])("refuses a PR binding changed during its four-read window", async after => {
    await expect(githubFingerprint(config, reader(pr(), checks(), statuses(), after))).rejects.toThrow();
  });

  it("refuses foreign identity before reusing any earlier checks", async () => {
    await expect(githubFingerprint(config, reader({ ...pr(), number: 43 }))).rejects.toThrow();
    const c = checks(); c.check_runs[0].head_sha = "e".repeat(40);
    await expect(githubFingerprint(config, reader(pr(), c))).rejects.toThrow();
    await expect(githubFingerprint(config, reader(pr(), checks(), { ...statuses(), sha: "f".repeat(40) }))).rejects.toThrow();
  });

  it("refuses incomplete, oversized, duplicate or malformed collections instead of hashing partial green", async () => {
    const badChecks = [
      {}, { ...checks(), total_count: 101 }, { ...checks(), total_count: 3 },
      { ...checks(), check_runs: [checks().check_runs[0], checks().check_runs[0]] },
      { ...checks(), check_runs: [{ ...checks().check_runs[0], id: "10" }, checks().check_runs[1]] },
      { ...checks(), check_runs: [{ ...checks().check_runs[0], name: "x".repeat(257) }, checks().check_runs[1]] },
    ];
    for (const c of badChecks) await expect(githubFingerprint(config, reader(pr(), c as any))).rejects.toThrow();
    for (const s of [{ ...statuses(), total_count: 101 }, { ...statuses(), total_count: 2 }, { ...statuses(), statuses: [] },
      { ...statuses(), total_count: 2, statuses: [statuses().statuses[0], { ...statuses().statuses[0], context: "another" }] }]) {
      await expect(githubFingerprint(config, reader(pr(), checks(), s))).rejects.toThrow();
    }
  });

  it("retains the existing store/admission contract: seed, quiet, change, foreign owner and stop", async () => {
    const root = path.resolve("tmp/pr-check-event-fixtures"); fs.mkdirSync(root, { recursive: true });
    const cwd = fs.mkdtempSync(path.join(root, "case-")); owned.push(cwd);
    const storage = new CronStorage(cwd);
    storage.addJob({ id: "exact", name: "exact", type: "event", schedule: "github:pull-request-checks", github: config, prompt: "Recheck original evidence; no automatic merge", session: "owner", enabled: true, createdAt: new Date().toISOString(), runCount: 0, maxRuns: 2 });
    const current = storage.getJob("exact")!;
    const before = await githubFingerprint(config, reader());
    expect(storage.observeGithub("exact", current.revision!, before, "owner", eventBinding(current))).toMatchObject({ status: "ignored", reason: "seeded" });
    expect(storage.observeGithub("exact", current.revision!, before, "owner", eventBinding(current))).toEqual({ status: "duplicate" });
    const s = statuses(); s.statuses[0].state = "failure";
    const changed = await githubFingerprint(config, reader(pr(), checks(), s));
    expect(storage.observeGithub("exact", current.revision!, changed, "foreign", eventBinding(current))).toMatchObject({ status: "ignored" });
    expect(storage.observeGithub("exact", current.revision!, changed, "owner", eventBinding(current))).toEqual({ status: "queued" });
    expect(storage.getJob("exact")?.pendingEvent?.keys).toHaveLength(1);
    storage.updateJob("exact", { enabled: false });
    expect(storage.observeGithub("exact", current.revision!, before, "owner", eventBinding(current))).toMatchObject({ status: "ignored" });
    expect(storage.getJob("exact")?.attemptCount ?? 0).toBe(0);
  });

  it("admits the explicit selector through the existing public tool and reloads the same record", async () => {
    const root = path.resolve("tmp/pr-check-event-fixtures"); fs.mkdirSync(root, { recursive: true });
    const cwd = fs.mkdtempSync(path.join(root, "tool-")); owned.push(cwd);
    const storage = new CronStorage(cwd), scheduler = { addJob: vi.fn(), getNextRun: () => undefined };
    const tool = createCronTool(() => storage, () => scheduler as any, () => "session");
    const result = await tool.execute("call", { action: "add", name: "selected-pr", type: "event", schedule: "github:pull-request-checks", github: config, prompt: "Inspect this PR's original checks", maxRuns: 2 } as any, undefined, undefined, { sessionManager: { getSessionId: () => "owner" } } as any);
    expect(result.details?.error).toBeUndefined();
    expect(new CronStorage(cwd).getAllJobs()[0]).toMatchObject({ session: "owner", github: config });
    expect(scheduler.addJob).toHaveBeenCalledOnce();
  });
});
