import { createHash } from "node:crypto";
import type { CronJob, GithubTrigger } from "./types.js";

export const EVENT_REQUEST = "schedule:event:v1";
export const EVENT_KEY_LIMIT = 128;
export const validEventName = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9:-]{0,63}$/.test(value);
export const validEventId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
export function eventNames(schedule: string): string[] {
  const names = schedule.split(",").map(value => value.trim());
  if (!names.length || names.length > 4 || new Set(names).size !== names.length || !names.every(validEventName)) {
    throw new Error("Event schedule must contain 1–4 distinct safe event names");
  }
  return names;
}
export function eventKey(job: CronJob, name: string, id: string): string {
  return createHash("sha256").update(`${job.id}:${name}:${id}`).digest("hex");
}
export function eventBinding(job: CronJob): string {
  const { type, schedule, prompt, session, model, notify, extensions, skills, maxRuns, maxRunsPerDay, expiresAt, github, catchUp, durable, deadlineMs } = job;
  return createHash("sha256").update(JSON.stringify({ type, schedule, prompt, session, model, notify, extensions, skills, maxRuns, maxRunsPerDay, expiresAt, github, catchUp, durable, deadlineMs })).digest("hex");
}
export function dailyLimited(job: CronJob, now = Date.now()): boolean {
  return job.maxRunsPerDay !== undefined && job.dailyUsage?.day === new Date(now).toISOString().slice(0, 10)
    && job.dailyUsage.attempts >= job.maxRunsPerDay;
}
export function validateGithub(value: GithubTrigger): void {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value.repo) || [".", ".."].includes(value.repo.split("/")[1]) ||
    !["pull-request", "workflow"].includes(value.kind) ||
    (value.kind === "pull-request" && (!Number.isSafeInteger(value.number) || (value.number ?? 0) < 1)) ||
    (value.branch !== undefined && !/^[A-Za-z0-9_./-]{1,100}$/.test(value.branch)) ||
    (value.pollSeconds !== undefined && (!Number.isSafeInteger(value.pollSeconds) || value.pollSeconds < 60 || value.pollSeconds > 3600))) {
    throw new Error("GitHub trigger requires a safe owner/repo, pull-request/workflow kind and 60–3600 second poll interval");
  }
}
