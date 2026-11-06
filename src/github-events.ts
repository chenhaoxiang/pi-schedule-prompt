import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { validateGithub } from "./events.js";
import type { GithubTrigger } from "./types.js";

export type GithubRead = (args: string[]) => Promise<unknown>;
export const readGithub: GithubRead = args => new Promise((resolve, reject) => {
  execFile("gh", args, { timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
    if (error) return reject(new Error("Selected GitHub source unavailable"));
    try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Invalid GitHub response")); }
  });
});
// Fixed gh projections strip bodies, output text, descriptions and URLs before
// bounded stdout is returned. Only these metadata fields enter the fingerprint.
const PR_PROJECTION = "{number,state,merged,head:{sha:.head.sha},base:{sha:.base.sha}}";
const CHECK_PROJECTION = "{total_count,check_runs:[.check_runs[]|{id,name,head_sha,status,conclusion,app_id:.app.id}]}";
const STATUS_PROJECTION = "{sha,total_count,statuses:[.statuses[]|{id,context,state}]}";
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid selected PR check metadata");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.length || value.length > max) throw new Error("Invalid bounded PR check field");
  return value;
}
function id(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("Invalid PR check identity");
  return value as number;
}
function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) throw new Error("Invalid PR commit identity");
  return value;
}
function prBinding(value: unknown, number: number) {
  const row = record(value);
  if (row.number !== number || !["open", "closed"].includes(row.state as string) || typeof row.merged !== "boolean") throw new Error("Selected PR identity/state mismatch");
  return { number, state: row.state, merged: row.merged, head: sha(record(row.head).sha), base: sha(record(row.base).sha) };
}
function collection(value: Record<string, unknown>, field: string): unknown[] {
  const rows = value[field], count = value.total_count;
  if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 100 || !Array.isArray(rows) || rows.length !== count) throw new Error("Incomplete or oversized PR check collection");
  return rows;
}
async function prChecksFingerprint(config: GithubTrigger, read: GithubRead): Promise<string> {
  const prRoute = `repos/${config.repo}/pulls/${config.number}`;
  const get = (route: string, projection: string) => read(["api", "--method", "GET", route, "--jq", projection]);
  const first = prBinding(await get(prRoute, PR_PROJECTION), config.number!);
  const checkData = record(await get(`repos/${config.repo}/commits/${first.head}/check-runs?filter=latest&per_page=100`, CHECK_PROJECTION));
  const checks = collection(checkData, "check_runs").map(value => {
    const row = record(value);
    if (row.head_sha !== first.head) throw new Error("Check run belongs to a different PR head");
    return { id: id(row.id), name: text(row.name), status: text(row.status, 32), conclusion: row.conclusion === null ? null : text(row.conclusion, 32), app: row.app_id === null ? null : id(row.app_id) };
  }).sort((a, b) => a.id - b.id);
  if (new Set(checks.map(row => row.id)).size !== checks.length) throw new Error("Duplicate check run identity");
  const statusData = record(await get(`repos/${config.repo}/commits/${first.head}/status?per_page=100`, STATUS_PROJECTION));
  if (statusData.sha !== first.head) throw new Error("Commit statuses belong to a different PR head");
  const statuses = collection(statusData, "statuses").map(value => {
    const row = record(value);
    return { id: id(row.id), context: text(row.context), state: text(row.state, 32) };
  }).sort((a, b) => a.id - b.id);
  if (new Set(statuses.map(row => row.id)).size !== statuses.length || new Set(statuses.map(row => row.context.toLowerCase())).size !== statuses.length) throw new Error("Duplicate combined status identity/context");
  const last = prBinding(await get(prRoute, PR_PROJECTION), config.number!);
  if (JSON.stringify(first) !== JSON.stringify(last)) throw new Error("Selected PR binding changed during observation");
  // Change notification only: the original owner still checks requirements,
  // reviews, current head, mergeability and authorization before any action.
  return createHash("sha256").update(JSON.stringify({ repo: config.repo, kind: config.kind, pr: first, checks, statuses })).digest("hex");
}

export async function githubFingerprint(config: GithubTrigger, read: GithubRead = readGithub): Promise<string> {
  validateGithub(config);
  if (config.kind === "pull-request-checks") return prChecksFingerprint(config, read);
  const route = config.kind === "pull-request" ? `repos/${config.repo}/pulls/${config.number}` : `repos/${config.repo}/actions/runs?per_page=1${config.branch ? "&branch=" + encodeURIComponent(config.branch) : ""}`;
  const raw = await read(["api", "--method", "GET", route]);
  if (!raw || typeof raw !== "object") throw new Error("Invalid selected GitHub source");
  const data = raw as Record<string, unknown>;
  if (config.kind === "workflow" && !Array.isArray(data.workflow_runs)) throw new Error("Invalid workflow list");
  const selected = config.kind === "workflow" ? (Array.isArray(data.workflow_runs) ? data.workflow_runs[0] : undefined) : data;
  if (selected !== undefined && (!selected || typeof selected !== "object")) throw new Error("Invalid GitHub metadata");
  const row = (selected ?? {}) as Record<string, unknown>;
  // Only bounded state metadata; never PR bodies, comments, URLs or instructions.
  const fields = config.kind === "pull-request" ? ["number", "state", "updated_at", "merged_at"] : ["id", "status", "conclusion", "updated_at", "head_sha"];
  if (config.kind === "pull-request" && row.number !== config.number) throw new Error("Selected PR identity mismatch");
  const safe: Record<string, unknown> = Object.fromEntries(fields.map(key => [key, row[key] ?? null]));
  if (config.kind === "pull-request") safe.head_sha = (row.head && typeof row.head === "object" ? (row.head as Record<string, unknown>).sha : null) ?? null;
  if (Object.values(safe).some(value => value !== null && (typeof value !== "string" && typeof value !== "number"))) throw new Error("Invalid GitHub state fields");
  if (JSON.stringify(safe).length > 2048) throw new Error("GitHub state exceeds metadata bound");
  return createHash("sha256").update(JSON.stringify({ repo: config.repo, kind: config.kind, number: config.number, branch: config.branch, state: safe })).digest("hex");
}
