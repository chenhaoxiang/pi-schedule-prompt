/** Existing TUI add flow with explicit legacy/resilient semantics; no old definition is migrated here. */
import { existsSync } from "node:fs";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { nativeCapability } from "../native.js";
import { effectiveTimezone, resilientDefinition } from "../resilient-policy.js";
import { CronScheduler } from "../scheduler.js";
import type { ScheduleSettings } from "../settings.js";
import type { CronStorage } from "../storage.js";
import type { CronJob, ResilientPolicy } from "../types.js";

async function inputValue<T>(ctx: ExtensionCommandContext, title: string, hint: string, parse: (raw: string) => T | undefined): Promise<T | undefined> {
  let placeholder = hint;
  while (true) {
    const raw = await ctx.ui.input(title, placeholder);
    if (raw === undefined) return;
    const value = parse(raw.trim());
    if (value !== undefined) return value;
    placeholder = "Invalid " + title.toLowerCase() + ". " + hint;
  }
}
const duration = (raw: string): number | undefined => {
  const ms = /^(\d+)ms$/.exec(raw);
  const value = ms ? Number(ms[1]) : CronScheduler.parseInterval(raw);
  return value && Number.isSafeInteger(value) && value > 0 && value <= 86400000 ? value : undefined;
};
const durationText = (ms: number) => ms % 60000 === 0 ? ms / 60000 + "m" : ms + "ms";

export async function runAddFlow(ctx: ExtensionCommandContext, storage: CronStorage, scheduler: CronScheduler, settings: ScheduleSettings, mySessionId: string | undefined): Promise<void> {
  const name = await ctx.ui.input("Job Name", "Enter a name for this scheduled prompt");
  if (!name) return;
  if (storage.hasJobWithName(name)) { ctx.ui.notify(`A job named "${name}" already exists`, "error"); return; }
  const typeChoice = await ctx.ui.select("Job Type", ["Cron (recurring)", "Once (one-shot)", "Interval (periodic)"]);
  if (!typeChoice) return;
  const typeMap: Record<string, "cron" | "once" | "interval"> = { "Cron (recurring)": "cron", "Once (one-shot)": "once", "Interval (periodic)": "interval" };
  const jobType = typeMap[typeChoice];
  const placeholders = { cron: "6-field cron, e.g. '0 0 9 * * *'", once: "ISO timestamp or relative time (+10s, +5m)", interval: "Duration, e.g. '5m', '1h', '30s'" };
  let schedule: string | undefined; let intervalMs: number | undefined; let placeholder = placeholders[jobType];
  while (true) {
    const raw = await ctx.ui.input("Schedule", placeholder); if (!raw) return;
    const result = CronScheduler.validateSchedule(jobType, raw.trim());
    if (result.ok) { schedule = result.schedule; intervalMs = result.intervalMs; break; }
    placeholder = result.error;
  }
  const prompt = await ctx.ui.input("Prompt", "Enter the prompt to execute"); if (!prompt) return;

  let policy: Partial<ResilientPolicy> | undefined;
  let maxRuns: number | undefined; let expiresAt: string | undefined; let deadlineMs: number | undefined;
  if (jobType !== "once") {
    const native = "Resilient native — serial checkpoint/recovery"; const legacy = "Legacy — existing scheduling behavior";
    const choice = await ctx.ui.select("Execution contract", nativeCapability(ctx) ? [native, legacy] : [legacy, native]);
    if (!choice) return;
    if (choice === native) {
      if (!nativeCapability(ctx)) { ctx.ui.notify("Native capability v1 is not loaded. Choose Legacy or switch this idle context to a compatible host first.", "error"); return; }
      if (storage.load().version !== 4 && existsSync(storage.getStorePath())) { ctx.ui.notify("Existing store needs verified quiescent schema4 migration. Use read-only preview first; no job was created.", "error"); return; }
      policy = {};
      if (jobType === "interval") {
        const mode = await ctx.ui.select("Interval mode", ["Fixed-delay — N after exact safe finish", "Fixed-rate — anchored cadence"]); if (!mode) return;
        policy.intervalMode = mode.startsWith("Fixed-rate") ? "fixed-rate" : "fixed-delay";
      } else {
        const timezone = await inputValue(ctx, "Cron timezone", "IANA zone (empty uses " + effectiveTimezone() + ")", raw => { try { return effectiveTimezone(raw || undefined); } catch { return undefined; } });
        if (!timezone) return; policy.timezone = timezone;
      }
      if (policy.intervalMode !== "fixed-delay") {
        const overlap = await ctx.ui.select("Live overlap", ["Skip busy ticks", "Buffer first waiting tick (one only)"]); if (!overlap) return;
        policy.overlapPolicy = overlap.startsWith("Buffer") ? "buffer-one" : "skip";
      }
      const misfire = await ctx.ui.select("Restart/sleep misfire", ["Skip missed occurrences", "Latest one occurrence within lateness"]); if (!misfire) return;
      policy.misfirePolicy = misfire.startsWith("Latest") ? "latest" : "skip";
      policy.latenessMs = await inputValue(ctx, "Occurrence lateness", "5m (empty uses 5m); not an execution timeout", raw => duration(raw || "5m")); if (!policy.latenessMs) return;
      deadlineMs = await inputValue(ctx, "Hard elapsed deadline", "45m (empty uses 45m); progress cannot extend it", raw => { const value = duration(raw || "45m"); return value && value >= 1000 ? value : undefined; }); if (!deadlineMs) return;
      const softDefault = Math.min(25 * 60000, Math.floor(deadlineMs * 2 / 3));
      policy.workBudgetMs = await inputValue(ctx, "Soft work/drain target", durationText(softDefault) + " (empty uses this); must be below hard deadline", raw => { const value = duration(raw || durationText(softDefault)); return value && value < deadlineMs! ? value : undefined; }); if (!policy.workBudgetMs) return;
      maxRuns = await inputValue(ctx, "Maximum admitted attempts", "Required positive finite lifetime bound, e.g. 24; not an invoice cap", raw => /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : undefined); if (!maxRuns) return;
      expiresAt = await inputValue(ctx, "Absolute expiry", "Required future ISO timestamp or relative +7d for this new job", raw => { const value = CronScheduler.parseRelativeTime(raw) ?? raw; return Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now() ? new Date(value).toISOString() : undefined; }); if (!expiresAt) return;
    }
  }

  const SCOPE_SESSION = "Bind to this session — only this pi fires it";
  const SCOPE_SHARED = "Shared — every pi in this cwd fires it (accepts duplicate fires)";
  let session: string | undefined;
  if (policy) session = mySessionId;
  else {
    const scoped = (settings.defaultJobScope ?? "session") === "session";
    const choice = await ctx.ui.select("Scope", scoped ? [SCOPE_SESSION, SCOPE_SHARED] : [SCOPE_SHARED, SCOPE_SESSION]); if (!choice) return;
    session = choice === SCOPE_SESSION ? mySessionId : undefined;
    if (choice === SCOPE_SESSION && !session) { ctx.ui.notify("Session-bound jobs require a session id", "error"); return; }
  }
  if (policy && !session) { ctx.ui.notify("Resilient jobs require this exact session; shared/broadcast is not supported.", "error"); return; }
  const human = policy?.intervalMode === "fixed-delay" ? schedule + " after exact safe finish" : CronScheduler.describeSchedule(jobType, schedule);
  const execution = policy ? `\nMode: ${policy.intervalMode ?? "cron / " + policy.timezone}\nWork/drain target: ${durationText(policy.workBudgetMs!)}; hard elapsed: ${durationText(deadlineMs!)}\nOverlap: ${policy.overlapPolicy ?? "skip"}; misfire: ${policy.misfirePolicy}; lateness: ${durationText(policy.latenessMs!)}\nLifetime attempts: ${maxRuns}; expiry: ${expiresAt}` : "\nMode: legacy (unchanged semantics)";
  if (!await ctx.ui.confirm("Confirm", `Save "${name}"?\nSchedule: ${human}\nScope: ${session ? "session-bound" : "shared (any pi here)"}${execution}\nPrompt: ${prompt}`)) return;
  const definition: CronJob = { id: nanoid(10), name, schedule, prompt, enabled: true, type: jobType, intervalMs, createdAt: new Date().toISOString(), runCount: 0, session, ...(policy ? { durable: true, maxRuns, expiresAt, deadlineMs } : {}) };
  try {
    const job = policy ? resilientDefinition(definition, policy) : definition;
    storage.addJob(job); scheduler.addJob(job);
    ctx.ui.notify(`Created scheduled prompt: ${name} (${human})`, "info");
  } catch (error) { ctx.ui.notify("No creation confirmed: " + (error instanceof Error ? error.message : String(error)), "error"); }
}
