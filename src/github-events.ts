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
export async function githubFingerprint(config: GithubTrigger, read: GithubRead = readGithub): Promise<string> {
  validateGithub(config);
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
