/**
 * pi-schedule-prompt — A pi extension for scheduling agent prompts
 *
 * Provides:
 * - A `schedule_prompt` tool for managing scheduled prompts
 * - A widget displaying all scheduled prompts with status
 * - /schedule-prompt command for interactive management
 * - Persistence via .pi/schedule-prompts.json (jobs) and .pi/schedule-prompts-settings.json (settings)
 */

import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { startEventApi } from "./event-api.js";
import { EVENT_REQUEST, PROGRESS_REQUEST, validEventId, validEvidenceFingerprint, validProgressOutcome } from "./events.js";
import { classifyFollowupReply, FOLLOWUP_CANCEL_TRANSPORT_EVENT, FOLLOWUP_OBSERVED_EVENT, FOLLOWUP_SCHEDULE_EVENT, type FollowupObservation, type FollowupRecord, type FollowupScheduleRequest, followupName, followupPrompt, validateFollowupBinding, validateFollowupOptions } from "./followup.js";
import { scheduledToolCallBlock } from "./input-guard.js";
import { CronScheduler } from "./scheduler.js";
import { loadSettings, type ScheduleSettings, saveSettings } from "./settings.js";
import { receiptsByClaim, summarizeJobs } from "./status.js";
import { CronStorage } from "./storage.js";
import { createCronTool } from "./tool.js";
import { runAddFlow } from "./ui/add-flow.js";
import { CronWidget } from "./ui/cron-widget.js";
import { JobsView } from "./ui/jobs-view.js";

export default async function (pi: ExtensionAPI) {
  let storage: CronStorage;
  let scheduler: CronScheduler;
  let widget: CronWidget;
  let eventServer: Server | undefined;
  let generation = 0;
  let currentSessionId = "";
  // Refreshed in initializeSession; mutated by Settings submenu. The tool and
  // widget read via closure so toggles take effect without re-registering.
  let settings: ScheduleSettings = {};
  const isWidgetVisible = () => settings.widgetVisible !== false;

  // Register custom message renderer for scheduled prompts
  pi.registerMessageRenderer("scheduled_prompt", (message, _options, theme) => {
    const details = message.details as
      | {
          jobId: string;
          jobName: string;
          prompt: string;
          mode?: "inline" | "subagent_start" | "subagent_done" | "subagent_error";
          model?: string;
          output?: string;
          error?: string;
        }
      | undefined;
    const jobName = details?.jobName || "Unknown";
    const prompt = details?.prompt || "";
    const model = details?.model;
    const tag = model ? ` (subagent: ${model})` : "";

    let line: string;
    switch (details?.mode) {
      case "subagent_start":
        line =
          theme.fg("accent", `🕐 Scheduled${tag}: ${jobName}`) +
          (prompt ? theme.fg("dim", ` → "${prompt}"`) : "");
        break;
      case "subagent_done":
        line =
          theme.fg("accent", `✓ Scheduled${tag} finished: ${jobName}`) +
          (details?.output ? theme.fg("dim", ` → ${details.output}`) : "");
        break;
      case "subagent_error":
        line =
          theme.fg("error", `✗ Scheduled${tag} failed: ${jobName}`) +
          (details?.error ? theme.fg("dim", ` → ${details.error}`) : "");
        break;
      default:
        line =
          theme.fg("accent", `🕐 Scheduled: ${jobName}`) +
          (prompt ? theme.fg("dim", ` → "${prompt}"`) : "");
    }

    return new Text(line, 0, 0);
  });

  // Register the tool once with getter functions
  const tool = createCronTool(
    () => storage,
    () => scheduler,
    () => settings.defaultJobScope ?? "session",
  );
  pi.registerTool(tool);

  // --- Session initialization ---

  const initializeSession = (ctx: ExtensionContext) => {
    // Idempotent: tear down any prior instance before creating a new one.
    // Without this, every `session_start` (fires on reload/resume/fork too, not
    // only on fresh startup) leaks a live croner timer into the event loop,
    // accumulating duplicate fires for every recurring job over time.
    cleanupSession(ctx);

    settings = loadSettings(ctx.cwd);
    currentSessionId = ctx.sessionManager.getSessionId();
    storage = new CronStorage(ctx.cwd);
    scheduler = new CronScheduler(storage, pi, ctx);
    widget = new CronWidget(storage, scheduler, pi, isWidgetVisible, ctx.sessionManager.getSessionId());

    const serviceSession = process.env.PI_SCHEDULE_SERVICE_SESSION;
    if (serviceSession && (serviceSession !== ctx.sessionManager.getSessionId() || storage.getAllJobs().some(job => job.enabled && (!job.session || (job.session === serviceSession && (!job.durable || !job.maxRuns || !job.expiresAt)))))) {
      throw new Error("Dedicated service requires finite exact session-bound durable schedules");
    }
    // Batch invocations register management tools without running background timers.
    if (ctx.mode === "print" || ctx.mode === "json") { scheduler.stop(); return; }
    scheduler.start();

    // Show widget
    if (ctx.hasUI && isWidgetVisible()) {
      widget.show(ctx);
    }
  };

  const cleanupSession = (ctx: ExtensionContext) => {
    generation += 1;
    currentSessionId = "";
    eventServer?.closeAllConnections();
    eventServer?.close();
    eventServer = undefined;
    // Stop scheduler
    if (scheduler) {
      scheduler.stop();
    }

    // Hide widget
    if (widget) {
      widget.hide(ctx);
      widget.destroy();
    }
  };

  // --- Lifecycle events ---

  pi.on("session_start", async (_event, ctx) => {
    try {
      initializeSession(ctx);
      if (ctx.mode !== "print" && ctx.mode !== "json") {
        scheduler.emitEvent("lifecycle:session-start", "start:" + ctx.sessionManager.getSessionId() + ":" + randomUUID());
        const api = settings.eventApi;
        if (api?.enabled) {
          const own = scheduler;
          const epoch = generation;
          try {
            const server = await startEventApi({ port: api.port, token: process.env[api.tokenEnv] ?? "" }, (id, name, eventId, evidenceFingerprint) => own.receiveEvent(id, name, eventId, evidenceFingerprint));
            if (epoch !== generation) { server.closeAllConnections(); server.close(); }
            else { eventServer = server; pi.appendEntry("schedule_event_api", { port: (server.address() as { port: number }).port, host: "127.0.0.1" }); }
          } catch {
            const message = "Local event API could not start; other scheduling remains available";
            console.error(message);
            pi.appendEntry("schedule_event_api", { state: "unavailable", reason: "startup-failed" });
            if (ctx.hasUI) ctx.ui.notify(message, "warning");
          }
        }
      }
    }
    catch (error) {
      cleanupSession(ctx);
      console.error("[pi-schedule-prompt] Initialization failed:", error);
      if (ctx.hasUI) ctx.ui.notify("Schedule store could not be loaded; timers are stopped. Check the local store.", "error");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    cleanupSession(ctx);
  });

  pi.on("before_agent_start", (event) => {
    scheduler?.setScheduledTurn(event.messageType === "custom" && event.message.customType === "scheduled_prompt");
    scheduler?.onScheduledStart(event.messageType === "custom" && event.message.customType === "scheduled_prompt" ? (event.message.details as { claimId?: string } | undefined)?.claimId : undefined);
  });
  pi.on("tool_call", event => {
    const blocked = scheduledToolCallBlock(scheduler?.isScheduledTurn() ?? false, event.toolName);
    if (!blocked) return;
    scheduler?.recordScheduledInputRequired(event.toolCallId);
    return blocked;
  });
  pi.on("message_end", event => { scheduler?.onMessageEnd(event.message); });
  pi.on("agent_settled", event => {
    if (scheduler && !scheduler.isScheduledTurn()) {
      try { scheduler.emitEvent("lifecycle:agent-settled", randomUUID()); }
      catch { console.error("Lifecycle event admission unavailable"); }
    }
    scheduler?.setScheduledTurn(false);
    scheduler?.onAgentSettled(event.aborted);
  });

  const stopFollowupBus = pi.events.on(FOLLOWUP_SCHEDULE_EVENT, payload => {
    if (!payload || typeof payload !== "object") return;
    const request = payload as FollowupScheduleRequest;
    if (request.version !== 1 || typeof request.claim !== "function" || typeof request.respond !== "function") return;
    const ownerSessionId = currentSessionId;
    if (request.binding?.ownerSessionId !== ownerSessionId) return;
    request.claim();
    try {
      validateFollowupBinding(request.binding);
      if (request.action === "create") {
        if (!request.options) throw new Error("Follow-up options are required");
        validateFollowupOptions(request.options);
        const now = new Date().toISOString();
        const record: FollowupRecord = {
          version: 1,
          ...request.binding,
          requestId: request.options.requestId,
          goal: request.options.goal,
          phase: request.options.phase,
          deadlineAt: request.options.deadlineAt,
          intervalMs: request.options.intervalMs,
          maxRuns: request.options.maxRuns,
          expiresAt: request.options.expiresAt,
          state: "pending",
          createdAt: now,
          updatedAt: now,
          ...(request.options.coveredBy ? { coveredBy: request.options.coveredBy } : {}),
        };
        const job = {
          id: followupName(request.binding),
          name: followupName(request.binding),
          schedule: new Date(Date.now() + request.options.intervalMs).toISOString(),
          prompt: followupPrompt(record),
          enabled: true,
          type: "once" as const,
          createdAt: now,
          runCount: 0,
          maxRuns: 1,
          expiresAt: request.options.expiresAt,
          durable: true,
          catchUp: "none" as const,
          deadlineMs: Math.max(1000, Math.min(86400000, Date.parse(request.options.deadlineAt) - Date.now())),
          session: ownerSessionId,
          followUp: record,
        };
        const created = storage.createFollowUp(job);
        if (created.created) scheduler.addJob(created.job);
        request.respond({ ok: true, created: created.created, jobId: created.job.id, state: created.job.followUp?.state, enabled: created.job.enabled, pending: created.job.followUp?.state === "pending", completion: "unknown" });
        return;
      }
      const found = storage.findFollowUp(request.binding);
      if (request.action === "get") {
        request.respond(found
          ? { ok: true, jobId: found.id, state: found.followUp?.state, enabled: found.enabled, pending: found.followUp?.state === "pending", completion: "unknown" }
          : { ok: false, state: "unknown", reason: "No exact follow-up binding found", completion: "unknown" });
        return;
      }
      const result = scheduler.cancelFollowUp(request.binding);
      request.respond({ ok: result.found, jobId: result.jobId, state: result.state as any, enabled: false, pending: false, reason: result.found ? undefined : "No exact follow-up binding found", completion: "unknown" });
    } catch (error) {
      request.respond({ ok: false, state: "unknown", reason: error instanceof Error ? error.message : String(error), completion: "unknown" });
    }
  });

  const stopFollowupObservationBus = pi.events.on(FOLLOWUP_OBSERVED_EVENT, payload => {
    if (!payload || typeof payload !== "object") return;
    const observation = payload as FollowupObservation;
    if (observation.version !== 1 || observation.ownerSessionId !== currentSessionId) return;
    try {
      if (observation.kind === "reply" && observation.peerSessionId && observation.messageId && observation.replyTo) {
        const result = scheduler.observeFollowUpReply({ ownerSessionId: observation.ownerSessionId, intercomSessionId: observation.intercomSessionId, peerSessionId: observation.peerSessionId, messageId: observation.replyTo }, {
          id: observation.messageId,
          kind: classifyFollowupReply(observation.text ?? ""),
          at: new Date(observation.at).toISOString(),
          ...(observation.text ? { text: observation.text } : {}),
        });
        const reminderMessageId = result.jobId ? storage.getJob(result.jobId)?.followUp?.reminderMessageId : undefined;
        if (reminderMessageId) {
          try {
            pi.events.emit(FOLLOWUP_CANCEL_TRANSPORT_EVENT, {
              version: 1,
              ownerSessionId: observation.ownerSessionId,
              intercomSessionId: observation.intercomSessionId,
              peerSessionId: observation.peerSessionId,
              originalMessageId: observation.replyTo,
              reminderMessageId,
            });
          } catch { console.error("[pi-schedule-prompt] Follow-up transport cancellation unavailable"); }
        }
      } else if (observation.kind === "disconnected") {
        for (const job of storage.getAllJobs()) {
          const record = job.followUp;
          if (record?.ownerSessionId === observation.ownerSessionId && record.intercomSessionId === observation.intercomSessionId && ["pending", "dispatched"].includes(record.state)) {
            scheduler.markFollowUpUnknown({ ownerSessionId: record.ownerSessionId, intercomSessionId: record.intercomSessionId, peerSessionId: record.peerSessionId, messageId: record.messageId }, "Intercom disconnected while follow-up was unresolved");
          }
        }
      }
    } catch { console.error("[pi-schedule-prompt] Follow-up observation could not be reconciled"); }
  });

  const stopProgressBus = pi.events.on(PROGRESS_REQUEST, payload => {
    if (!payload || typeof payload !== "object") return;
    const request = payload as Record<string, unknown>;
    let result: unknown = { status: "ignored", reason: "invalid-progress" };
    try {
      if (request.version === 1 &&
        typeof request.jobId === "string" && validEventId(request.jobId) &&
        typeof request.claimId === "string" && validEventId(request.claimId) &&
        validProgressOutcome(request.progress) && validEvidenceFingerprint(request.evidenceFingerprint) &&
        (request.waitingReason === undefined || (typeof request.waitingReason === "string" && request.waitingReason.length <= 128 && !/[\u0000-\u001f\u007f]/.test(request.waitingReason)))) {
        result = { status: scheduler?.recordProgress({ jobId: request.jobId, claimId: request.claimId, progress: request.progress, evidenceFingerprint: request.evidenceFingerprint, ...(request.waitingReason === undefined ? {} : { waitingReason: request.waitingReason }) }) ? "recorded" : "ignored" };
      }
    } catch { result = { status: "ignored", reason: "admission-unavailable" }; }
    try { pi.events.emit(PROGRESS_REQUEST + ":result:" + String(request.requestId ?? "unknown"), result); }
    catch { console.error("Local progress observer failed"); }
  });

  const stopEventBus = pi.events.on(EVENT_REQUEST, payload => {
    if (!payload || typeof payload !== "object") return;
    const request = payload as Record<string, unknown>;
    if (request.version !== 1 || !validEventId(request.requestId)) return;
    let result: unknown = { status: "ignored", reason: "invalid-request" };
    try {
      if (Object.keys(request).every(key => ["version", "requestId", "jobId", "eventName", "eventId"].includes(key)) && typeof request.jobId === "string" && typeof request.eventName === "string" && typeof request.eventId === "string" && scheduler) {
        result = scheduler.receiveEvent(request.jobId, request.eventName, request.eventId);
      }
    } catch { result = { status: "ignored", reason: "admission-unavailable" }; }
    try { pi.events.emit(EVENT_REQUEST + ":result:" + request.requestId, result); }
    catch { console.error("Local event observer failed"); }
  });
  pi.on("session_shutdown", () => { stopProgressBus(); stopEventBus(); stopFollowupBus(); stopFollowupObservationBus(); });

  pi.registerCommand("schedule-host-status", {
    description: "Read-only readiness, job state and exact-claim reconciliation metadata for the dedicated native host",
    handler: async (args, ctx) => {
      const match = /^([a-f0-9]{32})(?: ([a-zA-Z0-9][a-zA-Z0-9._-]{0,127}))?$/.exec(args);
      if (!match) return;
      const sessionId = ctx.sessionManager.getSessionId();
      const jobs = storage?.getAllJobs().filter(job => CronScheduler.isLoadedFor(job, sessionId)) ?? [];
      const selected = match[2] ? jobs.filter(job => job.id === match[2]) : jobs.slice(0, 20);
      const jobSummary = summarizeJobs(selected, {
        receiptByClaim: receiptsByClaim(ctx.sessionManager.getEntries?.()),
        nextRun: id => scheduler?.getNextRun(id) ?? null,
      });
      const details = {
        requestId: match[1], ready: !!scheduler?.isRunning(), pid: process.pid, sessionId,
        jobs: jobs.length,
        counts: {
          enabled: jobs.filter(job => job.enabled).length,
          disabled: jobs.filter(job => !job.enabled).length,
          disabledUnknown: jobs.filter(job => !job.enabled && (job.lastStatus === "unknown" || job.claim?.outcome === "unknown" || job.followUp?.state === "unknown")).length,
        },
        jobSummary, jobSummaryTruncated: !match[2] && jobs.length > selected.length,
      };
      // RPC UI status is an immediate side channel. A custom message during
      // streaming would otherwise steer/extend the active model turn (or, with
      // triggerTurn:false, wait until settlement instead of answering now).
      if (ctx.mode === "rpc") ctx.ui.setStatus("schedule_host_status", JSON.stringify(details));
      else pi.sendMessage({ customType: "schedule_host_status", display: false, content: "Scheduling host metadata", details }, { triggerTurn: false });
    },
  });

  // --- Register /schedule-prompt command ---

  pi.registerCommand("schedule-prompt", {
    description: "Manage scheduled prompts interactively",
    handler: async (_args, ctx) => {
      const mySessionId = ctx.sessionManager.getSessionId();

      const action = await ctx.ui.select("Scheduled Prompts", ["Jobs", "Settings"]);
      if (!action) return;

      switch (action) {
        case "Jobs": {
          // Hide the Jobs overlay while the add flow's dialogs are open —
          // otherwise it sits on top of them and steals input.
          let jobsOverlay: OverlayHandle | undefined;
          const wrappedRunAdd = async () => {
            jobsOverlay?.setHidden(true);
            try {
              await runAddFlow(ctx, storage, scheduler, settings, mySessionId);
            } finally {
              jobsOverlay?.setHidden(false);
              jobsOverlay?.focus();
            }
          };
          await ctx.ui.custom<void>(
            (tui, theme, _kb, done) =>
              new JobsView(
                storage,
                scheduler,
                mySessionId,
                wrappedRunAdd,
                theme,
                () => tui.requestRender(),
                () => done(undefined),
              ),
            {
              overlay: true,
              overlayOptions: { width: "100%", maxHeight: "100%" },
              onHandle: (h) => {
                jobsOverlay = h;
              },
            },
          );
          break;
        }

        case "Settings": {
          // Loop so the menu redraws with current state after each change —
          // the menu is the truth display; only persist failures need a toast.
          while (true) {
            const widgetState = isWidgetVisible() ? "shown" : "hidden";
            const bound = (settings.defaultJobScope ?? "session") === "session";
            const choice = await ctx.ui.select("Settings", [
              `Widget visibility: ${widgetState}`,
              `Bind new jobs to session: ${bound ? "yes" : "no"}`,
              "Back",
            ]);
            if (!choice || choice === "Back") return;
            if (choice.startsWith("Widget visibility:")) {
              const next = !isWidgetVisible();
              settings = { ...settings, widgetVisible: next };
              next ? widget.show(ctx) : widget.hide(ctx);
              const persisted = saveSettings(ctx.cwd, { widgetVisible: next });
              if (!persisted) {
                ctx.ui.notify(
                  `Widget ${next ? "shown" : "hidden"} (session only; failed to persist)`,
                  "warning",
                );
              }
            } else if (choice.startsWith("Bind new jobs to session:")) {
              // Affects newly-created jobs only; existing jobs keep their binding.
              const next = bound ? "workdir" : "session";
              settings = { ...settings, defaultJobScope: next };
              const persisted = saveSettings(ctx.cwd, { defaultJobScope: next });
              if (!persisted) {
                ctx.ui.notify(
                  `Bind new jobs to session: ${next === "session" ? "yes" : "no"} (session only; failed to persist)`,
                  "warning",
                );
              }
            }
          }
        }
      }
    },
  });
}
