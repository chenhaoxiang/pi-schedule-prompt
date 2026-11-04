import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resilientDefinition } from "../src/resilient-policy.js";
import { CronScheduler } from "../src/scheduler.js";
import { CronStorage } from "../src/storage.js";
import { runAddFlow } from "../src/ui/add-flow.js";
import { JobsView } from "../src/ui/jobs-view.js";

const directories: string[] = []; const schedulers: CronScheduler[] = [];
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
function fixture(values: Record<string, string | string[]> = {}, choices: Record<string, string> = {}, supported = true) {
  const root = path.resolve("tmp/resilient-ui-fixtures"); fs.mkdirSync(root, { recursive: true }); const cwd = fs.mkdtempSync(path.join(root, "case-")); directories.push(cwd);
  const inputs = { "Job Name": "new-ui-job", Schedule: "1h", Prompt: "synthetic goal", "Occurrence lateness": "", "Hard elapsed deadline": "", "Soft work/drain target": "", "Maximum admitted attempts": "24", "Absolute expiry": "+1d", ...values };
  const ctx = { cwd, hasUI: true, isIdle: () => false, hasPendingMessages: () => false, abort: vi.fn(), sessionManager: { getSessionId: () => "owner", getEntries: () => [] }, modelRegistry: { getAvailable: () => [] }, ...(supported ? { scheduledExecution: { version: 1, active: undefined, start: vi.fn() } } : {}), ui: {
    input: vi.fn(async (title: string) => { const value = inputs[title as keyof typeof inputs]; return Array.isArray(value) ? value.shift() : value; }),
    select: vi.fn(async (title: string, options: string[]) => choices[title] ?? (title === "Job Type" ? "Interval (periodic)" : options[0])),
    confirm: vi.fn(async () => true), notify: vi.fn(),
  } };
  const storage = new CronStorage(cwd); const scheduler = new CronScheduler(storage, { sendMessage: vi.fn(), appendEntry: vi.fn(), events: { emit: vi.fn() } } as any, ctx as any); schedulers.push(scheduler); scheduler.start();
  const add = () => runAddFlow(ctx as any, storage, scheduler, { defaultJobScope: "workdir" }, "owner");
  return { ctx, storage, scheduler, add };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-04T00:00:00.000Z")); });
afterEach(() => { for (const scheduler of schedulers.splice(0)) scheduler.stop(); vi.useRealTimers(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe("resilient canonical TUI paths", () => {
  it("creates a finite completion-delay job with explicit budgets, preserves prior fields on validation retry and does not offer broadcast", async () => {
    const h = fixture({ "Maximum admitted attempts": ["not-a-number", "24"] }); await h.add();
    const job = h.storage.getAllJobs()[0]; expect(job).toMatchObject({ session: "owner", maxRuns: 24, deadlineMs: 2700000, policy: { mode: "resilient", intervalMode: "fixed-delay", workBudgetMs: 1500000, latenessMs: 300000 } });
    expect(h.storage.load().version).toBe(4); expect(h.ctx.ui.input.mock.calls.filter(([title]) => title === "Job Name")).toHaveLength(1); expect(h.ctx.ui.input.mock.calls.filter(([title]) => title === "Maximum admitted attempts")).toHaveLength(2);
    expect(h.ctx.ui.select.mock.calls.some(([title]) => title === "Scope")).toBe(false);
    const confirm = h.ctx.ui.confirm.mock.calls[0] as unknown as [string, string]; expect(confirm[1]).toContain("1h after exact safe finish"); expect(confirm[1]).toContain("hard elapsed: 45m"); expect(confirm[1]).toContain("Lifetime attempts: 24");
    expect(h.ctx.scheduledExecution!.start).not.toHaveBeenCalled();
  });

  it("keeps the existing one-shot/shared flow legacy instead of silently applying resilient defaults", async () => {
    const h = fixture({ Schedule: "+5m" }, { "Job Type": "Once (one-shot)" }, false); await h.add();
    const job = h.storage.getAllJobs()[0]; expect(job.type).toBe("once"); expect(job.policy).toBeUndefined(); expect(job.session).toBeUndefined(); expect(h.storage.load().version).toBe(3);
    expect(h.ctx.ui.select.mock.calls.some(([title]) => title === "Execution contract")).toBe(false);
  });

  it("persists effective cron timezone and first-buffer/latest policy with separate inputs", async () => {
    const h = fixture({ Schedule: "0 0 9 * * *", "Cron timezone": "Asia/Tokyo" }, { "Job Type": "Cron (recurring)", "Live overlap": "Buffer first waiting tick (one only)", "Restart/sleep misfire": "Latest one occurrence within lateness" }); await h.add();
    expect(h.storage.getAllJobs()[0]).toMatchObject({ type: "cron", policy: { mode: "resilient", timezone: "Asia/Tokyo", overlapPolicy: "buffer-one", misfirePolicy: "latest" } });
  });

  it("shows actionable unsupported-host/migration errors without creating or rewriting definitions", async () => {
    const missing = fixture({}, { "Execution contract": "Resilient native — serial checkpoint/recovery" }, false); await missing.add(); expect(missing.storage.getAllJobs()).toEqual([]); expect(missing.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("capability v1 is not loaded"), "error");
    const old = fixture(); old.storage.addJob({ id: "old", name: "old", type: "interval", schedule: "1h", intervalMs: 3600000, prompt: "legacy", enabled: false, createdAt: new Date().toISOString(), runCount: 0 }); const bytes = fs.readFileSync(old.storage.getStorePath()); await old.add();
    expect(fs.readFileSync(old.storage.getStorePath())).toEqual(bytes); expect(old.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("verified quiescent schema4 migration"), "error"); expect(old.ctx.ui.confirm).not.toHaveBeenCalled();
  });

  it("toggles user intent with exact owner, reports completion-delay and blocks shared scope", async () => {
    const h = fixture(); await h.add(); const id = h.storage.getAllJobs()[0].id;
    const view = new JobsView(h.storage, h.scheduler, "owner", async () => {}, theme, () => {}, () => {}); view.handleInput("s"); expect(view.render(100).join("\n")).toContain("stay session-bound"); expect(h.storage.getJob(id)?.session).toBe("owner");
    view.handleInput("t"); expect(h.storage.getJob(id)?.enabled).toBe(false); const text = view.render(100).join("\n"); expect(text).toContain("finish + 1h"); expect(text).toContain("fixed-delay"); expect(text).toContain("User intent: disabled");
  });

  it("keeps spending/UNKNOWN evidence out of generic TUI cleanup", () => {
    const h = fixture(); const job = resilientDefinition({ id: "retained", name: "retained", type: "interval", schedule: "1h", intervalMs: 3600000, prompt: "synthetic", enabled: false, createdAt: new Date().toISOString(), runCount: 1, attemptCount: 1, session: "owner", maxRuns: 4, expiresAt: new Date(Date.now() + 86400000).toISOString() }); h.storage.addJob(job);
    const view = new JobsView(h.storage, h.scheduler, "owner", async () => {}, theme, () => {}, () => {}); view.handleInput("c"); view.handleInput("y"); expect(h.storage.getJob(job.id)?.attemptCount).toBe(1);
  });
});
