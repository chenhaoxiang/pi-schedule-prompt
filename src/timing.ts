import { Cron } from "croner";
import { effectiveTimezone, instant, isResilient, requiresReconciliation, spentOnUtcDay } from "./resilient-policy.js";
import type { CronJob, ResilientJob, TimedOccurrence } from "./types.js";

export type MisfireDecision =
  | { action: "future"; dueAt: string }
  | { action: "eligible"; dueAt: string; source: "timer" | "misfire" }
  | { action: "skip"; dueAt: string; reason: "outside-lateness" | "policy-skip" };
export interface TimingView {
  mode: "fixed-delay" | "fixed-rate" | "cron";
  intervalMs?: number;
  anchorAt?: string;
  lastFinishedAt?: string;
  nextEligibleAt?: string;
  timezone?: string;
  expression?: string;
  misfirePolicy: "skip" | "latest";
  latenessMs: number;
  revision: number;
}
export const COOLDOWN_MS = [0, 60_000, 120_000, 300_000, 600_000, 1_800_000] as const;

/** Strictly future anchored tick, with the first interval at anchor+N rather than immediate enrollment. */
export function nextFixedRate(anchorAt: string, intervalMs: number, after: number): Date {
  if (!instant(anchorAt) || !Number.isSafeInteger(intervalMs) || intervalMs <= 0 || !Number.isFinite(after)) throw new Error("Invalid fixed-rate anchor/interval/clock");
  const anchor = Date.parse(anchorAt);
  return new Date(anchor + Math.max(1, Math.floor((after - anchor) / intervalMs) + 1) * intervalMs);
}

/** Raw completion-relative target; an overdue target remains overdue so restoration can apply misfire once. */
export function nextFixedDelay(lastFinishedAt: string | undefined, intervalMs: number, initialAt: number): Date {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || !Number.isFinite(initialAt) || (lastFinishedAt !== undefined && !instant(lastFinishedAt))) throw new Error("Invalid fixed-delay finish/interval/clock");
  return new Date((lastFinishedAt === undefined ? initialAt : Date.parse(lastFinishedAt)) + intervalMs);
}

export function nextCronOccurrence(expression: string, timezone: string, after: number): Date {
  if (effectiveTimezone(timezone) !== timezone || !Number.isFinite(after)) throw new Error("Cron requires its persisted effective timezone and a valid clock");
  const cron = new Cron(expression, { paused: true, timezone });
  try {
    const next = cron.nextRun(new Date(after));
    if (!next) throw new Error("Cron has no future occurrence");
    return next;
  } finally { cron.stop(); }
}

/** Normal future cadence. Fixed-delay rearming after an explicitly discarded old timer is persisted once. */
export function nextDue(view: TimingView, after: number): Date {
  if (view.mode === "fixed-rate") return nextFixedRate(view.anchorAt!, view.intervalMs!, after);
  if (view.mode === "cron") return nextCronOccurrence(view.expression!, view.timezone!, after);
  const due = nextFixedDelay(view.lastFinishedAt ?? view.anchorAt, view.intervalMs!, after);
  return due.getTime() > after ? due : new Date(after + view.intervalMs!);
}

function latestDue(view: TimingView, now: number): Date | undefined {
  if (view.mode === "fixed-delay") return view.nextEligibleAt && instant(view.nextEligibleAt) ? new Date(view.nextEligibleAt) : nextFixedDelay(view.lastFinishedAt ?? view.anchorAt, view.intervalMs!, now);
  if (view.mode === "fixed-rate") {
    const anchor = Date.parse(view.anchorAt!); const index = Math.floor((now - anchor) / view.intervalMs!);
    return index >= 1 ? new Date(anchor + index * view.intervalMs!) : undefined;
  }
  const cron = new Cron(view.expression!, { paused: true, timezone: view.timezone });
  try { return cron.previousRuns(1, new Date(Math.floor(now / 1000) * 1000 + 1000))[0]; }
  finally { cron.stop(); }
}

/** Restore one persisted timer, never a backlog. This is not the normal live-timer overlap decision. */
export function misfire(view: TimingView, now: number): MisfireDecision {
  const raw = view.nextEligibleAt && instant(view.nextEligibleAt) ? new Date(view.nextEligibleAt)
    : view.mode === "fixed-delay" ? nextFixedDelay(view.lastFinishedAt ?? view.anchorAt, view.intervalMs!, now) : nextDue(view, now);
  if (raw.getTime() > now) return { action: "future", dueAt: raw.toISOString() };
  if (raw.getTime() === now) return { action: "eligible", dueAt: raw.toISOString(), source: "timer" };
  if (view.misfirePolicy === "skip") return { action: "skip", dueAt: raw.toISOString(), reason: "policy-skip" };
  const candidate = latestDue(view, now);
  if (!candidate || candidate.getTime() < raw.getTime() || candidate.getTime() > now || now - candidate.getTime() > view.latenessMs) return { action: "skip", dueAt: raw.toISOString(), reason: "outside-lateness" };
  return { action: "eligible", dueAt: candidate.toISOString(), source: "misfire" };
}

/** A live armed tick uses lateness/overlap, not startup's skip-misfire default. */
export function occurrence(view: TimingView, now: number, source: TimedOccurrence["source"] = "timer"): TimedOccurrence {
  let dueAt: string;
  if (source === "misfire") {
    const restored = misfire(view, now);
    if (restored.action !== "eligible") throw new Error("No permitted restored occurrence");
    dueAt = restored.dueAt;
  } else {
    dueAt = view.nextEligibleAt ?? nextDue(view, now - 1).toISOString();
    if (!instant(dueAt) || Date.parse(dueAt) > now || now - Date.parse(dueAt) > view.latenessMs) throw new Error("Live occurrence is early or outside lateness");
  }
  return { id: `${view.revision}:${dueAt}`, dueAt, revision: view.revision, source };
}

export function timingView(job: CronJob): TimingView {
  if (!isResilient(job)) throw new Error("Timing view requires a resilient job");
  return {
    mode: job.type === "cron" ? "cron" : job.policy.intervalMode!, intervalMs: job.intervalMs,
    anchorAt: job.policy.anchorAt, lastFinishedAt: job.runtime.lastFinishedAt, nextEligibleAt: job.runtime.nextEligibleAt,
    timezone: job.policy.timezone, ...(job.type === "cron" ? { expression: job.schedule } : {}),
    misfirePolicy: job.policy.misfirePolicy, latenessMs: job.policy.latenessMs, revision: job.revision!,
  };
}

/** Earliest future legal cadence under cooldown, UTC limits, user intent and expiry; never execution permission. */
export function nextEligibleAfter(job: ResilientJob, now = Date.now()): Date | undefined {
  if (!job.enabled || requiresReconciliation(job) || Date.parse(job.expiresAt!) <= now || job.attemptCount! >= job.maxRuns!) return;
  const slot = job.runtime.slot;
  if (slot.kind === "owned" && (job.policy.intervalMode === "fixed-delay" || slot.phase === "attention-required")) return;
  if (slot.kind === "idle" && !["waiting", "backoff"].includes(slot.phase)) return;
  const day = new Date(now).toISOString().slice(0, 10);
  let notBefore = job.runtime.notBefore ? Date.parse(job.runtime.notBefore) : now;
  if (job.maxRunsPerDay !== undefined && spentOnUtcDay(job, day) >= job.maxRunsPerDay) notBefore = Math.max(notBefore, Date.parse(day + "T00:00:00.000Z") + 86_400_000);
  if (job.dailyUsage && day < job.dailyUsage.day) notBefore = Math.max(notBefore, Date.parse(job.dailyUsage.day + "T00:00:00.000Z"));
  const view = timingView(job);
  let next: Date;
  if (view.mode === "fixed-delay") {
    const raw = nextFixedDelay(view.lastFinishedAt ?? view.anchorAt, view.intervalMs!, now).getTime();
    const stored = view.nextEligibleAt ? Date.parse(view.nextEligibleAt) : Number.NaN;
    next = new Date(Math.max(stored > now ? stored : raw > now ? raw : now + view.intervalMs!, notBefore));
  } else next = nextDue(view, Math.max(now, notBefore - 1));
  return next.getTime() < Date.parse(job.expiresAt!) ? next : undefined;
}

/** Persist the chosen jitter/deadline once; a restart must not select a different cooldown. */
export function cooldownNotBefore(now: number, step: number, jitterMs = 0): string {
  if (!Number.isSafeInteger(step) || !Number.isFinite(now)) throw new Error("Invalid cooldown step/clock");
  const bounded = Math.max(1, Math.min(COOLDOWN_MS.length - 1, step));
  if (!Number.isSafeInteger(jitterMs) || jitterMs < 0 || jitterMs > Math.min(60_000, COOLDOWN_MS[bounded] / 10)) throw new Error("Invalid bounded cooldown jitter");
  return new Date(now + COOLDOWN_MS[bounded] + jitterMs).toISOString();
}
