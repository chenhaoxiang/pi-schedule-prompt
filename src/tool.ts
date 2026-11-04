import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { nanoid } from "nanoid";
import { validateGithub, validEventId, validEvidenceFingerprint } from "./events.js";
import { nativeCapability } from "./native.js";
import { isResilient, resilientDefinition } from "./resilient-policy.js";
import { planScheduledModel } from "./scheduled-model.js";
import { CronScheduler } from "./scheduler.js";
import type { JobScope } from "./settings.js";
import { summarizeJobs } from "./status.js";
import { type CronStorage, canCleanupJob } from "./storage.js";
import { resolveModelRoute } from "./subagent.js";
import type { CronJob, CronJobType, CronToolDetails, CronToolParamsType, ResilientPolicy } from "./types.js";
import { CronToolParams } from "./types.js";

const resilientFields = ["intervalMode", "timezone", "overlapPolicy", "misfirePolicy", "latenessMs", "workBudgetMs"] as const;
function policyOptions(params: CronToolParamsType, job?: CronJob): Partial<ResilientPolicy> | undefined {
  const mode = params.mode ?? job?.policy?.mode ?? "legacy";
  if (!["legacy", "resilient"].includes(mode)) throw new Error("mode must be legacy or resilient");
  if (job && isResilient(job) && mode !== "resilient") throw new Error("Resilient execution/history cannot be downgraded to legacy mode");
  if (mode === "legacy") {
    if (resilientFields.some(field => params[field] !== undefined)) throw new Error("Resilient policy fields require mode=resilient; legacy cadence is never silently reinterpreted");
    return undefined;
  }
  if (job && !isResilient(job)) throw new Error("Existing legacy jobs require explicit schema4 migration after verified runtime quiescence; preview is read-only");
  if (params.durable === false) throw new Error("Resilient jobs require durable native ownership");
  if (params.quietOnNoChange === true || params.github !== undefined) throw new Error("Resilient timing does not reinterpret legacy event/GitHub quiet controls");
  const alias = params.catchUp === "latest" ? "latest" : params.catchUp === "none" ? "skip" : undefined;
  if (alias && params.misfirePolicy && alias !== params.misfirePolicy) throw new Error("catchUp conflicts with misfirePolicy");
  return { ...Object.fromEntries(resilientFields.filter(field => params[field] !== undefined).map(field => [field, params[field]])), ...(params.misfirePolicy ?? alias ? { misfirePolicy: params.misfirePolicy ?? alias } : {}) };
}

/**
 * Create the schedule_prompt tool definition.
 * `getDefaultScope` is a getter so live setting toggles affect the next `add`.
 */
export function createCronTool(
  getStorage: () => CronStorage,
  getScheduler: () => CronScheduler,
  getDefaultScope: () => JobScope = () => "session",
): ToolDefinition<typeof CronToolParams, CronToolDetails> {
  return {
    name: "schedule_prompt",
    label: "Schedule Prompt",
    description:
      "IMPORTANT: For action='add', you MUST provide both 'schedule' parameter AND 'prompt' parameter. Schedule prompts at times/intervals. Schedule formats: 6-field cron (with seconds: '0 * * * * *' = every minute), ISO timestamp, relative time (+10s, +5m, +1h), or interval (5m, 1h). Type defaults to 'cron', use 'once' for relative/ISO times. Type event uses 1-4 comma-separated event names, not cron. Actions: add (needs schedule+prompt), list, remove/enable/disable/update (need jobId), cleanup, trigger (needs jobId,eventName,eventId), resume (needs jobId, exact settled UNKNOWN/aborted claimId and SHA-256 evidenceFingerprint). Resume creates only a FUTURE continuation; it never replays or marks the old claim successful. maxRunsPerDay counts UTC attempts. Explicit mode=resilient requires native v1, finite maxRuns/expiresAt and a new/prepared schema4 store for session-bound recurring jobs. New resilient intervals default fixed-delay (N after exact safe finish), never silently replacing legacy cadence. Read-only status/preview; drain checkpoints the exact owned handle; reconcile requires an exact finalized attemptId, SHA-256 evidenceFingerprint and resolution from the ordinary owning operator context, not new authority.",
    parameters: CronToolParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const storage = getStorage();
      const scheduler = getScheduler();
      
      // Source-based guard: historical notifications are not the current turn.
      if (["add", "resume"].includes(params.action) && scheduler.isScheduledTurn?.()) {
        throw new Error("Cannot create scheduled prompts from within a scheduled prompt execution.");
      }

      const action = params.action;
      const details: CronToolDetails = {
        action,
        jobs: [],
      };
      const canonicalModel = (value: string | undefined): string | undefined => {
        if (value === undefined) return undefined;
        const resolution = resolveModelRoute(ctx.modelRegistry, value);
        if (!resolution.ok) throw new Error(resolution.error);
        return resolution.route;
      };

      try {
        if (["remove", "enable", "disable", "update", "resume", "reconcile", "drain"].includes(action) && params.jobId) {
          const target = storage.getJob(params.jobId);
          if (target && !CronScheduler.isLoadedFor(target, ctx.sessionManager.getSessionId())) {
            throw new Error("Job belongs to another session and is read-only here");
          }
          if (target && isResilient(target) && ["update", "enable", "reconcile"].includes(action) && scheduler.isScheduledTurn?.()) throw new Error("A scheduled turn cannot renew/change resilient authorization or reconcile its own evidence; use the ordinary owning operator context");
        }
        if (params.maxRuns !== undefined && (!Number.isSafeInteger(params.maxRuns) || params.maxRuns < 1)) {
          throw new Error("maxRuns must be a positive safe integer");
        }
        if (params.deadlineMs !== undefined && (!Number.isSafeInteger(params.deadlineMs) || params.deadlineMs < 1000 || params.deadlineMs > 86400000)) throw new Error("deadlineMs must be 1000–86400000");
        if (params.noChangeThreshold !== undefined && (!Number.isSafeInteger(params.noChangeThreshold) || params.noChangeThreshold < 1 || params.noChangeThreshold > 10)) throw new Error("noChangeThreshold must be 1–10");
        if (params.quietForMs !== undefined && (!Number.isSafeInteger(params.quietForMs) || params.quietForMs < 1000 || params.quietForMs > 86400000)) throw new Error("quietForMs must be 1000–86400000");
        if (params.maxRunsPerDay !== undefined && (!Number.isSafeInteger(params.maxRunsPerDay) || params.maxRunsPerDay < 1)) throw new Error("maxRunsPerDay must be a positive safe integer");
        if (params.catchUp !== undefined && !["none", "latest"].includes(params.catchUp)) throw new Error("Invalid catchUp policy");
        if (params.github !== undefined) validateGithub(params.github);
        if (params.expiresAt !== undefined && (!Number.isFinite(Date.parse(params.expiresAt)) || Date.parse(params.expiresAt) <= Date.now())) {
          throw new Error("expiresAt must be an absolute future timestamp");
        }
        switch (action) {
          case "preview": {
            const preview = storage.previewSchema4Migration();
            return { content: [{ type: "text", text: "Read-only schema4 preview. This is not runtime quiescence, effect reconciliation or execution authorization.\n" + JSON.stringify(preview) }], details };
          }
          case "status": {
            const all = storage.getAllJobs().filter(job => CronScheduler.isLoadedFor(job, ctx.sessionManager.getSessionId()));
            const selected = params.jobId ? all.filter(job => job.id === params.jobId) : all.slice(0, 20);
            details.status = summarizeJobs(selected, { nextRun: id => scheduler.getNextRun(id), nativeSnapshot: id => scheduler.getNativeRunSnapshot(id) });
            details.truncated = !params.jobId && selected.length < all.length;
            return { content: [{ type: "text", text: JSON.stringify({ running: scheduler.isRunning?.() ?? false, jobs: all.length, truncated: details.truncated, status: details.status }) }], details };
          }
          case "drain": {
            if (!params.jobId) throw new Error("drain requires the exact jobId");
            if (!scheduler.drainResilientJob(params.jobId)) throw new Error("No exact owned resilient native handle is available to checkpoint/drain; no unrelated turn was aborted");
            details.jobId = params.jobId;
            return { content: [{ type: "text", text: "Requested native checkpoint/drain for the exact handle. This is not an exit acknowledgement or business success." }], details };
          }
          case "reconcile": {
            if (!params.jobId || !params.attemptId || !params.evidenceFingerprint || !params.resolution) throw new Error("reconcile requires jobId, exact finalized attemptId, SHA-256 evidenceFingerprint and resolution");
            const result = scheduler.reconcileResilientJob(params.jobId, params.attemptId, params.evidenceFingerprint, params.resolution, params.safeScopes);
            details.jobId = result.job.id; details.jobName = result.job.name; details.status = summarizeJobs([result.job], { nextRun: id => scheduler.getNextRun(id) });
            return { content: [{ type: "text", text: `Exact checkpoint resolution ${result.changed ? "recorded" : "already recorded"}. Old execution/effect history is unchanged; this does not create new authority or business success.` }], details };
          }
          case "resume": {
            if (!params.jobId || !params.claimId || !params.evidenceFingerprint) throw new Error("resume requires jobId, exact claimId and evidenceFingerprint");
            if (!validEventId(params.claimId) || !validEvidenceFingerprint(params.evidenceFingerprint)) throw new Error("resume requires a safe exact claimId and lowercase SHA-256 evidenceFingerprint");
            const resumed = scheduler.resumeFutureJob(params.jobId, params.claimId, params.evidenceFingerprint);
            details.jobs = [resumed.job];
            details.jobId = resumed.job.id;
            details.jobName = resumed.job.name;
            return { content: [{ type: "text", text: `✓ Future-only continuation ${resumed.created ? "created" : "already recorded"} for claim ${params.claimId}; the old UNKNOWN/aborted claim was not replayed` }], details };
          }
          case "trigger": {
            if (scheduler.isScheduledTurn?.()) throw new Error("Scheduled turns cannot trigger another schedule recursively");
            if (!params.jobId || !params.eventName || !params.eventId) throw new Error("trigger requires jobId,eventName,eventId");
            const result = scheduler.receiveEvent(params.jobId, params.eventName, params.eventId);
            details.jobs = storage.getAllJobs().filter(job => job.id === params.jobId && CronScheduler.isLoadedFor(job, ctx.sessionManager.getSessionId()));
            return { content: [{ type: "text", text: `Event ${result.status}${result.reason ? ": " + result.reason : ""}` }], details };
          }
          case "add": {
            if (process.env.PI_SCHEDULE_SERVICE_SESSION && ((params.durable !== true && params.mode !== "resilient") || getDefaultScope() !== "session" || !params.maxRuns || !params.expiresAt)) throw new Error("Dedicated service requires explicit finite durable session-bound jobs");
            if (!params.schedule || !params.prompt) {
              const missing = [];
              if (!params.schedule) missing.push("'schedule'");
              if (!params.prompt) missing.push("'prompt'");
              throw new Error(
                `Missing required parameters for add action: ${missing.join(" and ")}. You must provide both schedule (e.g., '+10s', '*/5 * * * * *') and prompt (the text to execute).`
              );
            }

            // Defense-in-depth — the schema also enforces this with minLength: 1,
            // but tool callers can bypass the schema by passing params directly.
            if (params.model !== undefined && !params.model.trim()) {
              throw new Error(
                "'model' must be a non-empty string. Omit the field for inline (no-model) jobs."
              );
            }
            const model = canonicalModel(params.model);

            // Generate name if not provided
            const jobName = params.name || `job-${nanoid(6)}`;

            // Check for duplicate names
            if (storage.hasJobWithName(jobName)) {
              throw new Error(
                `A job named "${jobName}" already exists. Please use a different name or remove the existing job first.`
              );
            }

            const type = (params.type || "cron") as CronJobType;
            const validated = CronScheduler.validateSchedule(type, params.schedule);
            if (!validated.ok) throw new Error(validated.error);
            const schedule = validated.schedule;
            const intervalMs = validated.intervalMs;

            const now = new Date().toISOString();
            const session =
              getDefaultScope() === "session" ? ctx.sessionManager.getSessionId() : undefined;
            if (getDefaultScope() === "session" && !session) throw new Error("Session-bound jobs require a session id");
            let job: CronJob = {
              id: nanoid(10),
              name: jobName,
              schedule,
              prompt: params.prompt,
              enabled: true,
              type,
              intervalMs,
              createdAt: now,
              runCount: 0,
              description: params.description,
              maxRuns: params.maxRuns,
              maxRunsPerDay: params.maxRunsPerDay,
              catchUp: params.catchUp,
              durable: params.durable,
              deadlineMs: params.deadlineMs,
              quietOnNoChange: params.quietOnNoChange,
              noChangeThreshold: params.noChangeThreshold,
              quietForMs: params.quietForMs,
              github: params.github,
              expiresAt: params.expiresAt,
              model,
              notify: params.notify,
              extensions: params.extensions,
              skills: params.skills,
              session,
            };

            const policy = policyOptions(params);
            if (policy) {
              if (!nativeCapability(ctx)) throw new Error("Resilient scheduling requires loaded native capability v1; no definition/attempt was created");
              if (!session) throw new Error("Resilient jobs must be explicitly session-bound, not shared/broadcast");
              const nativeJob = resilientDefinition(job, policy);
              if (nativeJob.model) planScheduledModel(ctx, nativeJob);
              job = nativeJob;
            }
            storage.addJob(job);
            scheduler.addJob(job);
            details.jobs = [job];
            details.jobId = job.id;
            details.jobName = job.name;

            const modelLine = job.model
              ? `\nModel: ${job.model} (${isResilient(job) ? "persistent native child" : "runs in subagent"}${job.notify ? ", notifies parent" : ""}${job.extensions ? ", extensions" : ""}${job.skills ? ", skills" : ""})`
              : "";
            const policyLine = isResilient(job) ? `\nMode: ${job.policy.intervalMode ?? "cron / " + job.policy.timezone} | Overlap: ${job.policy.overlapPolicy} | Misfire: ${job.policy.misfirePolicy} | Work target ms: ${job.policy.workBudgetMs} | Hard elapsed ms: ${job.deadlineMs}` : "";
            return {
              content: [
                {
                  type: "text",
                  text: `✓ Created cron job "${job.name}" (${job.id})\nType: ${job.type}\nSchedule: ${job.schedule}\nPrompt: ${job.prompt}${modelLine}${policyLine}`,
                },
              ],
              details,
            };
          }

          case "remove": {
            if (!params.jobId) {
              throw new Error("jobId is required for remove action");
            }

            const job = storage.getJob(params.jobId);
            if (!job) {
              throw new Error(`Job not found: ${params.jobId}`);
            }

            const removed = storage.removeJob(params.jobId, ctx.sessionManager.getSessionId());
            if (removed) {
              scheduler.removeJob(params.jobId);
              details.jobId = params.jobId;
              details.jobName = job.name;

              return {
                content: [
                  {
                    type: "text",
                    text: storage.getJob(params.jobId) ? `✓ Removed future fires for "${job.name}" (${params.jobId}); live/UNKNOWN/spending evidence is retained` : `✓ Removed cron job "${job.name}" (${params.jobId})`,
                  },
                ],
                details,
              };
            }
            throw new Error(`Failed to remove job: ${params.jobId}`);
          }

          case "enable":
          case "disable": {
            if (!params.jobId) {
              throw new Error(`jobId is required for ${action} action`);
            }

            const job = storage.getJob(params.jobId);
            if (!job) {
              throw new Error(`Job not found: ${params.jobId}`);
            }

            const enabled = action === "enable";
            const model = enabled ? canonicalModel(job.model) : undefined;
            const modelUpdate = model && model !== job.model && !isResilient(job) ? { model } : {};
            storage.updateJob(params.jobId, { enabled, ...modelUpdate }, ctx.sessionManager.getSessionId());
            const updated = storage.getJob(params.jobId)!;
            scheduler.updateJob(params.jobId, updated);

            details.jobs = [updated];
            details.jobId = params.jobId;
            details.jobName = job.name;

            return {
              content: [
                {
                  type: "text",
                  text: `✓ ${enabled ? "Enabled" : "Disabled"} cron job "${job.name}" (${params.jobId})${isResilient(updated) ? `; user intent only, runtime ${updated.runtime.slot.phase}; limits and reconciliation are unchanged` : ""}`,
                },
              ],
              details,
            };
          }

          case "cleanup": {
            // Only touch jobs this session can see — foreign-session jobs are
            // owned by other pis. Unbound disabled jobs are fair game.
            const mySessionId = ctx.sessionManager.getSessionId();
            const disabledJobs = storage
              .getAllJobs()
              .filter((j) => CronScheduler.isLoadedFor(j, mySessionId) && canCleanupJob(j));

            if (disabledJobs.length === 0) {
              details.jobs = [];
              return {
                content: [
                  {
                    type: "text",
                    text: "No disabled jobs to clean up",
                  },
                ],
                details,
              };
            }

            for (const job of disabledJobs) {
              storage.removeJob(job.id, mySessionId);
              scheduler.removeJob(job.id);
            }

            details.jobs = disabledJobs;

            return {
              content: [
                {
                  type: "text",
                  text: `✓ Removed ${disabledJobs.length} disabled job(s):\n${disabledJobs.map((j) => `  - ${j.name} (${j.id})`).join("\n")}`,
                },
              ],
              details,
            };
          }

          case "update": {
            if (!params.jobId) {
              throw new Error("jobId is required for update action");
            }

            const job = storage.getJob(params.jobId);
            if (!job) {
              throw new Error(`Job not found: ${params.jobId}`);
            }

            // Reject empty-string model (schema also enforces minLength: 1).
            // To switch a job from subagent → inline mode, remove and re-add
            // it without `model` — there's no in-place clearing.
            if (params.model !== undefined && !params.model.trim()) {
              throw new Error(
                "'model' must be a non-empty string. To switch a job from subagent back to inline, remove and re-add it without a model."
              );
            }

            const updates: Partial<CronJob> = {};
            if (process.env.PI_SCHEDULE_SERVICE_SESSION && params.durable === false) throw new Error("Dedicated service cannot disable durable execution");
            if (params.durable !== undefined) updates.durable = params.durable;
            if (params.deadlineMs !== undefined) updates.deadlineMs = params.deadlineMs;
            if (params.quietOnNoChange !== undefined) updates.quietOnNoChange = params.quietOnNoChange;
            if (params.noChangeThreshold !== undefined) updates.noChangeThreshold = params.noChangeThreshold;
            if (params.quietForMs !== undefined) updates.quietForMs = params.quietForMs;
            if (params.maxRuns !== undefined) updates.maxRuns = params.maxRuns;
            if (params.maxRunsPerDay !== undefined) updates.maxRunsPerDay = params.maxRunsPerDay;
            if (params.catchUp !== undefined) updates.catchUp = params.catchUp;
            if (params.github !== undefined) updates.github = params.github;
            if (params.expiresAt !== undefined) updates.expiresAt = params.expiresAt;
            if (params.name) updates.name = params.name;
            if (params.prompt) updates.prompt = params.prompt;
            if (params.description !== undefined) updates.description = params.description;
            const model = canonicalModel(params.model ?? (job.enabled ? job.model : undefined));
            if (model !== undefined && model !== job.model && (!isResilient(job) || params.model !== undefined)) updates.model = model;
            if (params.notify !== undefined) updates.notify = params.notify;
            if (params.extensions !== undefined) updates.extensions = params.extensions;
            if (params.skills !== undefined) updates.skills = params.skills;

            if (params.schedule) {
              // Same resolution rules as `add`: relative time (`+5m`) → ISO,
              // ISO accepted as-is, cron validated by croner.
              const validated = CronScheduler.validateSchedule(job.type, params.schedule);
              if (!validated.ok) throw new Error(validated.error);
              updates.schedule = validated.schedule;
              if (validated.intervalMs !== undefined) updates.intervalMs = validated.intervalMs;
            }

            const policy = policyOptions(params, job);
            if (policy) {
              if (params.type && params.type !== job.type) throw new Error("Resilient job kind cannot be silently changed; create a separate authorized definition");
              updates.policy = resilientDefinition({ ...job, ...updates }, policy).policy;
            }
            storage.updateJob(params.jobId, updates, ctx.sessionManager.getSessionId());
            const updated = storage.getJob(params.jobId)!;
            scheduler.updateJob(params.jobId, updated);

            details.jobs = [updated];
            details.jobId = params.jobId;
            details.jobName = updated.name;

            return {
              content: [
                {
                  type: "text",
                  text: `✓ Updated cron job "${updated.name}" (${params.jobId})`,
                },
              ],
              details,
            };
          }

          case "list": {
            const mySessionId = ctx.sessionManager.getSessionId();
            const jobs = storage
              .getAllJobs()
              .filter((j) => CronScheduler.isLoadedFor(j, mySessionId));
            details.jobs = jobs;

            if (jobs.length === 0) {
              return {
                content: [{ type: "text", text: "No cron jobs configured." }],
                details,
              };
            }

            const lines = ["Configured cron jobs:", ""];
            for (const job of jobs) {
              const status = job.enabled ? "✓" : "✗";
              const nextRun = scheduler.getNextRun(job.id);
              const nextStr = nextRun ? `Next: ${nextRun.toISOString()}` : "";
              const lastStr = job.lastRun ? `Last: ${job.lastRun}` : "Never run";

              lines.push(`${status} ${job.name} (${job.id})`);
              lines.push(`  Type: ${job.type} | Schedule: ${job.schedule}`);
              if (isResilient(job)) {
                lines.push(`  Native ${job.policy.intervalMode ?? "cron / " + job.policy.timezone} | Phase: ${job.runtime.slot.phase} | Reason: ${job.runtime.slot.reason ?? "none"} | Overlap: ${job.policy.overlapPolicy} | Misfire: ${job.policy.misfirePolicy}`);
                lines.push(`  Work target ms: ${job.policy.workBudgetMs} | Hard elapsed ms: ${job.deadlineMs} | Next cadence: ${job.runtime.nextEligibleAt ?? "none"} | Not before: ${job.runtime.notBefore ?? "none"} | Business outcome: unverified`);
              }
              else if (job.durable) lines.push(`  Durable claim: ${job.claim?.id ?? "none"} | Phase: ${job.claim?.phase ?? "none"} | Outcome: ${job.claim?.outcome ?? "not-proven"} | Deadline ms: ${job.deadlineMs ?? 600000} | Waiting: ${job.waitingReason ?? "none"} | Reason: ${job.claim?.outcomeReason ?? "not-recorded"} | Notice: ${job.notice?.state ?? "none"}`);
              if (job.quietOnNoChange) lines.push(`  No-change quiet: ${job.noChangeCount ?? 0}/${job.noChangeThreshold ?? 2} | Until: ${job.quietUntil ?? "not-quiet"} | Reason: ${job.waitingReason ?? "none"}`);
              if (job.maxRunsPerDay) lines.push(`  UTC daily cap: ${job.maxRunsPerDay} | Tracked day: ${job.dailyUsage?.day ?? "not-yet-tracked"} | Attempts: ${job.dailyUsage?.attempts ?? "unknown"}`);
              if (job.type === "event") lines.push(`  Event restore: ${job.catchUp ?? "none"} | Pending: ${!!job.pendingEvent}`);
              if (job.github) lines.push(`  Selected GitHub: ${JSON.stringify(job.github)}`);
              if (job.model) {
                lines.push(`  Model: ${job.model} (runs in subagent${job.notify ? ", notifies parent" : ""}${job.extensions ? ", extensions" : ""}${job.skills ? ", skills" : ""})`);
              }
              lines.push(`  Prompt: ${job.prompt}`);
              lines.push(`  ${lastStr} ${nextStr ? `| ${nextStr}` : ""}`);
              lines.push(`  Runs: ${job.runCount} | Status: ${job.lastStatus || "pending"}`);
              if (job.description) {
                lines.push(`  Description: ${job.description}`);
              }
              lines.push("");
            }

            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details,
            };
          }

          default:
            throw new Error(`Unknown action: ${action}`);
        }
      } catch (error) {
        details.error = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `✗ Error: ${details.error}`,
            },
          ],
          details,
        };
      }
    },

    renderCall(params, theme) {
      const action = params.action;
      const name = params.name || params.jobId || "";
      const actionText = theme.fg("accent", action);
      const nameText = theme.fg("text", name);

      let text: string;
      switch (action) {
        case "add":
          text = `Adding cron job: ${nameText}`;
          break;
        case "remove":
          text = `Removing cron job: ${nameText}`;
          break;
        case "enable":
        case "disable":
          text = `${actionText.charAt(0).toUpperCase() + actionText.slice(1)} job: ${nameText}`;
          break;
        case "update":
          text = `Updating cron job: ${nameText}`;
          break;
        case "list":
          text = `Listing all cron jobs`;
          break;
        default:
          text = `${actionText} cron job`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      if (!result.details) {
        const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        return new Text(text, 0, 0);
      }

      const details = result.details;
      const lines: string[] = [];

      // Show action result
      if (details.error) {
        lines.push(theme.fg("error", `✗ Error: ${details.error}`));
      } else {
        const action = details.action;
        const jobName = details.jobName || details.jobId || "";
        lines.push(theme.fg("success", `✓ ${action} ${jobName}`));
      }

      // Show job table for list action
      if (details.action === "list" && details.jobs.length > 0) {
        lines.push("");
        lines.push(theme.bold("Cron Jobs:"));
        for (const job of details.jobs) {
          const status = job.enabled ? theme.fg("success", "✓") : theme.fg("muted", "✗");
          lines.push(`${status} ${theme.fg("text", job.name)} ${theme.fg("dim", `(${job.id})`)}`);
          lines.push(
            `  ${theme.fg("dim", "Type:")} ${job.type} ${theme.fg("dim", "| Schedule:")} ${job.schedule}`
          );
          if (job.model) {
            const subagentTag = job.notify ? "(subagent, notifies parent)" : "(subagent)";
            const tags = [];
            if (job.extensions) tags.push("extensions");
            if (job.skills) tags.push("skills");
            const tagStr = tags.length ? ", " + tags.join(" + ") : "";
            lines.push(`  ${theme.fg("dim", "Model:")} ${job.model} ${theme.fg("dim", subagentTag)}${tagStr}`);
          }
          lines.push(`  ${theme.fg("dim", "Prompt:")} ${job.prompt}`);
          if (job.lastRun) {
            lines.push(`  ${theme.fg("dim", "Last run:")} ${job.lastRun}`);
          }
          lines.push(`  ${theme.fg("dim", "Runs:")} ${job.runCount}`);
        }
      }

      return new Text(lines.join("\n"), 0, 0);
    },
  };
}
