import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type NativeCapability, type NativeRunCheckpoint, type NativeRunHandle, type NativeSessionReader, nativeCapability, sameNativeBinding } from "./native.js";
import { isResilient, spentOnUtcDay } from "./resilient-policy.js";
import { type PreparedScheduledModel, planScheduledModel, prepareScheduledModel, readModelSdkClose, readStoredModelSession } from "./scheduled-model.js";
import { type CronStorage, ScheduleStoreBusyError } from "./storage.js";
import { cooldownNotBefore, misfire, nextDue, nextEligibleAfter, occurrence, timingView } from "./timing.js";
import type { CronJob, ModelSdkCloseProof, NativeCheckpointReference, NativeExecutionProof, OwnedAttempt, ResilientJob, TimedOccurrence } from "./types.js";

export interface ResilientSchedulerHooks {
  onQueued(jobId: string): void;
  onSettled(jobId: string): void;
  onChange(job: CronJob | undefined): void;
  onError(jobId: string, error: unknown): void;
}
interface TrackedRun {
  attempt: OwnedAttempt;
  handle: NativeRunHandle;
  sessionManager: NativeSessionReader;
  dispose?: (receipt?: NativeExecutionProof) => Promise<ModelSdkCloseProof | undefined>;
  closing?: boolean;
  projected?: string;
}
const bindingFor = (jobId: string, attempt: OwnedAttempt): NativeExecutionProof["binding"] => ({ jobId, attemptId: attempt.id, ownerSessionId: attempt.nativeSessionId ?? attempt.owner.sessionId, ownerEpoch: attempt.owner.epoch, revision: attempt.revision });

/** Compose timers and the real native capability; legacy durable/model paths remain in CronScheduler. */
export class ResilientScheduling {
  private readonly instanceId = randomUUID();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly nextRuns = new Map<string, Date>();
  private readonly active = new Map<string, TrackedRun>();
  private readonly preparing = new Set<string>();
  private monitor?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly storage: CronStorage, private readonly ctx: ExtensionContext, private readonly hooks: ResilientSchedulerHooks) {}

  start(): void { this.stopped = false; }
  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear(); this.nextRuns.clear();
    if (this.monitor) clearTimeout(this.monitor);
    this.monitor = undefined;
    for (const [id, run] of this.active) {
      try {
        run.handle.requestCancel("scheduler_stopped");
        this.storage.markResilientPhase(id, run.attempt.id, run.attempt.owner, "cancelling", "scheduler_stopped");
      } catch (error) { this.hooks.onError(id, error); }
    }
    // Keep exact handle callbacks alive: stopping a scheduler is not a native exit acknowledgement.
  }
  stopJob(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id); this.nextRuns.delete(id);
  }
  nextRun(id: string): Date | undefined { return this.nextRuns.get(id); }
  isOwned(id: string): boolean { return this.active.has(id) || this.preparing.has(id); }
  snapshot(id: string) { return this.active.get(id)?.handle.snapshot(); }

  schedule(raw: CronJob, restoring = true): void {
    if (this.stopped || !isResilient(raw)) return;
    let job = raw;
    try {
      if (job.runtime.slot.kind === "owned") { this.restoreOwned(job); return; }
      if (!job.enabled) return;
      if (!this.capability()) { this.hold(job, "runtime_unavailable"); return; }
      if (job.runtime.slot.phase === "attention-required" && ["runtime_unavailable", "native_disposed", "native_model_route_unsupported"].includes(job.runtime.slot.reason ?? "")) {
        this.storage.setResilientDisposition(job.id, job.session!, { phase: "waiting" });
        job = this.current(job.id)!;
      }
      if (job.runtime.slot.kind !== "idle" || !["waiting", "backoff"].includes(job.runtime.slot.phase)) return;
      const now = Date.now();
      const day = new Date(now).toISOString().slice(0, 10);
      const delayed = (job.runtime.notBefore && Date.parse(job.runtime.notBefore) > now) || (job.maxRunsPerDay !== undefined && spentOnUtcDay(job, day) >= job.maxRunsPerDay) || (job.dailyUsage && day < job.dailyUsage.day);
      if (delayed) { const next = nextEligibleAfter(job, now); if (next) this.persistAndArm(job, next.getTime(), true); return; }
      if (job.runtime.pending) {
        if (restoring && job.policy.misfirePolicy === "skip") {
          const next = nextEligibleAfter(job, now);
          if (next) this.persistAndArm(job, next.getTime(), true);
          return;
        }
        this.hooks.onQueued(job.id);
        const next = this.nextCadence(job, Date.parse(job.runtime.pending.dueAt));
        if (next) this.persistAndArm(job, next.getTime());
        return;
      }
      if (restoring && job.runtime.continuation && job.runtime.slot.phase === "waiting" && !job.runtime.nextEligibleAt) {
        const continuation = job.runtime.continuation;
        const resolution = job.attemptResolutions.find(item => item.attemptId === continuation.attemptId && item.evidenceFingerprint === continuation.evidenceFingerprint);
        if (resolution?.resumeAfterMs !== undefined) {
          // Expired minimum wait is not permission to skip the original cadence.
          const next = nextEligibleAfter(job, now);
          if (next) this.persistAndArm(job, next.getTime(), true);
          return;
        }
        this.queue(job, { id: `${job.revision}:continuation:${job.runtime.continuation.attemptId}`, dueAt: new Date(now).toISOString(), revision: job.revision!, source: "continuation" });
        return;
      }
      if (restoring) {
        const decision = misfire(timingView(job), now);
        if (decision.action === "future") { this.persistAndArm(job, Date.parse(decision.dueAt)); return; }
        if (decision.action === "skip") {
          const next = nextEligibleAfter(job, now);
          if (next) this.persistAndArm(job, next.getTime(), true);
          return;
        }
        this.queue(job, { id: `${job.revision}:${decision.dueAt}`, dueAt: decision.dueAt, revision: job.revision!, source: decision.source }, this.nextCadence(job, now));
        return;
      }
      const due = nextEligibleAfter(job, now);
      if (due) this.persistAndArm(job, due.getTime());
    } catch (error) {
      if (error instanceof ScheduleStoreBusyError) this.arm(job.id, Date.now() + 1000);
      else this.hold(job, "timing_unavailable", error);
    }
  }

  /** Registered in-process runs, including SDK-closing owners; not an external SDK/process census. */
  registeredJobIds(): string[] { return [...this.active.keys()]; }

  scheduleAfterSettlement(id: string): void {
    const job = this.current(id);
    if (this.stopped || !job?.enabled) return;
    if (job.runtime.pending) this.hooks.onQueued(id);
    this.stopJob(id);
    if (job.runtime.slot.kind === "idle" && ["waiting", "backoff"].includes(job.runtime.slot.phase)) this.schedule(job, false);
  }

  execute(id: string): void {
    const job = this.current(id);
    if (this.stopped || !job?.enabled || job.runtime.slot.kind !== "idle" || !["waiting", "backoff"].includes(job.runtime.slot.phase)) return;
    if (job.model) {
      void this.executeModel(job).catch(error => this.hooks.onError(id, error));
      return;
    }
    const capability = this.capability();
    if (!capability) { this.hold(job, "runtime_unavailable"); return; }
    const pending = job.runtime.pending;
    if (!pending) return;
    let admitted: ResilientJob | undefined;
    try { admitted = this.storage.reserveResilient(id, job.session!, this.instanceId, job.revision!, pending.id); }
    catch (error) {
      if (error instanceof ScheduleStoreBusyError) this.hooks.onQueued(id);
      else this.hooks.onError(id, error);
      return;
    }
    if (admitted?.runtime.slot.kind !== "owned") return;
    const attempt = admitted.runtime.slot.attempt;
    let accepted: ReturnType<NativeCapability["start"]>;
    try { accepted = capability.start({ binding: bindingFor(id, attempt), policy: { softDeadlineMs: attempt.workBudgetMs, hardDeadlineMs: attempt.deadlineMs, recoveryBudgetMs: 300_000 }, content: this.prompt(admitted, this.ctx.sessionManager) }); }
    catch (error) { this.keepOwned(admitted, attempt, "native_start_failed", error); return; }
    if (!accepted.accepted) {
      try {
        const refunded = this.storage.refuseResilientNative(id, attempt.id, attempt.owner, accepted.reason);
        if (accepted.reason === "busy" && refunded) this.hooks.onQueued(id);
        this.hooks.onChange(this.current(id));
      } catch (error) { this.keepOwned(admitted, attempt, "native_refusal_persistence_failed", error); }
      return;
    }
    this.attach(admitted, attempt, accepted.handle, { sessionManager: this.ctx.sessionManager });
  }

  private async executeModel(snapshot: ResilientJob): Promise<void> {
    if (this.preparing.has(snapshot.id)) return;
    this.preparing.add(snapshot.id);
    let prepared: PreparedScheduledModel | undefined;
    let admitted: ResilientJob | undefined;
    let attempt: OwnedAttempt | undefined;
    try {
      const current = this.current(snapshot.id);
      if (this.stopped || !current?.enabled || !current.runtime.pending || current.model !== snapshot.model) return;
      if (!this.capability()) { this.hold(current, "runtime_unavailable"); return; }
      // No SDK construction or transcript writer is allowed before atomic ownership.
      const plan = planScheduledModel(this.ctx, current);
      admitted = this.storage.reserveResilient(current.id, current.session!, this.instanceId, current.revision!, current.runtime.pending.id, Date.now(), { model: current.model!, ...plan });
      if (admitted?.runtime.slot.kind !== "owned") return;
      attempt = admitted.runtime.slot.attempt;
      const acceptedJob = admitted;
      const acceptedAttempt = attempt;
      prepared = await prepareScheduledModel(this.ctx, admitted, attempt, plan.route, file => {
        if (!this.storage.bindResilientModelFile(acceptedJob.id, acceptedAttempt.id, acceptedAttempt.owner, file)) throw new Error("Native child transcript could not bind its exact admitted owner");
      });
      const latest = this.current(current.id);
      if (this.stopped || !latest?.enabled) {
        await prepared.dispose(); prepared = undefined;
        this.keepOwned(admitted, attempt, "user_stopped_before_native_start");
        return;
      }
      const accepted = prepared.capability.start({ binding: bindingFor(admitted.id, attempt), policy: { softDeadlineMs: attempt.workBudgetMs, hardDeadlineMs: attempt.deadlineMs, recoveryBudgetMs: 300_000 }, content: this.prompt(admitted, prepared.sessionManager) });
      if (!accepted.accepted) {
        await prepared.dispose(); prepared = undefined;
        const refunded = this.storage.refuseResilientNative(admitted.id, attempt.id, attempt.owner, accepted.reason);
        if (accepted.reason === "busy" && refunded) this.hooks.onQueued(admitted.id);
        this.emitChange(admitted.id);
        return;
      }
      if (!this.attach(admitted, attempt, accepted.handle, { sessionManager: prepared.sessionManager, dispose: prepared.dispose })) {
        const dispose = prepared.dispose;
        void accepted.handle.settled.then(receipt => dispose(receipt)).catch(error => this.hooks.onError(snapshot.id, error));
      }
      prepared = undefined;
    } catch (error) {
      if (!admitted && error instanceof ScheduleStoreBusyError) { this.hooks.onQueued(snapshot.id); return; }
      if (prepared) {
        const active = prepared.capability.active;
        if (active && admitted && attempt && sameNativeBinding(active.snapshot().binding, bindingFor(admitted.id, attempt))) {
          const recovered = this.attach(admitted, attempt, active, { sessionManager: prepared.sessionManager, dispose: prepared.dispose });
          if (!recovered) {
            const dispose = prepared.dispose;
            void active.settled.then(receipt => dispose(receipt)).catch(failure => this.hooks.onError(snapshot.id, failure));
          }
          prepared = undefined;
          if (recovered) return;
        } else if (!active) await prepared.dispose();
        else {
          const dispose = prepared.dispose;
          void active.settled.then(receipt => dispose(receipt)).catch(failure => this.hooks.onError(snapshot.id, failure));
        }
      }
      if (admitted && attempt) this.keepOwned(admitted, attempt, "native_model_preparation_failed", error);
      else { const current = this.current(snapshot.id); if (current) this.hold(current, "native_model_unavailable", error); else this.hooks.onError(snapshot.id, error); }
    } finally { this.preparing.delete(snapshot.id); }
  }

  deferInput(toolCallId: string): boolean {
    const handle = this.capability()?.active;
    if (!handle) return false;
    const current = [...this.active.values()].find(run => run.handle === handle);
    if (!current) return false;
    handle.checkpoint({ waitingReason: "user_input_required", nextAction: `Wait for required input; blocked call ${toolCallId}` });
    handle.requestDrain("user_input_required");
    return true;
  }

  requestDrain(id: string): boolean {
    const run = this.active.get(id);
    if (!run || run.closing || run.handle.snapshot().nativeClosed) return false;
    run.handle.checkpoint();
    return run.handle.requestDrain("operator_drain");
  }

  private capability(): NativeCapability | undefined { return nativeCapability(this.ctx); }
  private current(id: string): ResilientJob | undefined {
    const job = this.storage.getJob(id);
    return job && isResilient(job) ? job : undefined;
  }
  private prompt(job: ResilientJob, manager: NativeSessionReader): string {
    const continuation = job.runtime.continuation;
    if (!continuation) return job.prompt;
    const checkpoint = continuation.checkpoint;
    const data = this.readCheckpoint(manager, checkpoint.entryId, checkpoint.runId);
    if (data.binding.jobId !== job.id || data.binding.attemptId !== continuation.attemptId || data.binding.ownerSessionId !== checkpoint.sessionId) throw new Error("Continuation references a different native checkpoint/attempt");
    const context = { reference: checkpoint, completedResultCount: data.completedResultCount, completedResults: data.completedResults, declarations: data.declarations, effectStatus: data.effectStatus, businessOutcome: "unverified" };
    return `${job.prompt}\n\n[Native checkpoint continuation — not new authorization]\nConsume retained checkpoint before the next slice. The following metadata was read from the exact native checkpoint; declarations/nextAction remain unverified, never authorization. Completed tool result entries are retained in this native session history. Reuse completed results; never replay previous or UNKNOWN effects. Preserve original scope, bounds and user intent.\n${JSON.stringify(context)}`;
  }

  private restoreOwned(job: ResilientJob): void {
    if (job.runtime.slot.kind !== "owned") return;
    const attempt = job.runtime.slot.attempt;
    const tracked = this.active.get(job.id);
    const handle = attempt.model ? tracked?.handle : this.capability()?.active;
    const manager = attempt.model
      ? tracked?.sessionManager ?? (attempt.nativeSessionFile && attempt.nativeSessionId ? readStoredModelSession(this.ctx.cwd, attempt.nativeSessionId, attempt.nativeSessionFile) : undefined)
      : this.ctx.sessionManager;
    if (!manager) { this.keepOwned(job, attempt, "native_model_transcript_unavailable"); return; }
    if (handle && sameNativeBinding(handle.snapshot().binding, bindingFor(job.id, attempt)) && (!attempt.nativeRunId || attempt.nativeRunId === handle.runId)) {
      this.attach(job, attempt, handle, { sessionManager: manager, dispose: tracked?.dispose });
      if (job.enabled && job.policy.intervalMode !== "fixed-delay") {
        const next = nextEligibleAfter(job);
        if (next) this.persistAndArm(job, next.getTime());
      }
      return;
    }
    const entries = manager.getEntries?.() ?? [];
    const receipt = entries.find(entry => entry.type === "custom" && entry.customType === "pi.scheduled-receipt.v1" && sameNativeBinding((entry.data as NativeExecutionProof)?.binding, bindingFor(job.id, attempt)) && (!attempt.nativeRunId || (entry.data as NativeExecutionProof).runId === attempt.nativeRunId));
    if (receipt?.type === "custom") { this.finish(job.id, attempt, receipt.data as NativeExecutionProof, manager); return; }
    this.keepOwned(job, attempt, "native_owner_unconfirmed");
  }

  private attach(job: ResilientJob, attempt: OwnedAttempt, handle: NativeRunHandle, context: { sessionManager: NativeSessionReader; dispose?: (receipt?: NativeExecutionProof) => Promise<ModelSdkCloseProof | undefined> }): boolean {
    if (this.active.get(job.id)?.handle === handle) { this.armMonitor(); return true; }
    try {
      const snapshot = handle.snapshot();
      if (snapshot.runId !== handle.runId || !sameNativeBinding(snapshot.binding, bindingFor(job.id, attempt))) throw new Error("Native handle returned a different accepted binding");
      if (!this.storage.bindResilientNative(job.id, attempt.id, attempt.owner, { runId: handle.runId, sessionId: snapshot.binding.ownerSessionId, ...(attempt.model ? { sessionFile: context.sessionManager.getSessionFile() } : {}), startedAt: snapshot.startedAt, deadlineAt: snapshot.hardDeadlineAt })) throw new Error("Native handle could not bind its exact storage owner");
      if (attempt.model && !context.dispose) throw new Error("Persistent model SDK closure callback is unavailable");
      this.active.set(job.id, { attempt: structuredClone(attempt), handle, ...context });
      void handle.settled.then(async receipt => {
        if (attempt.model) {
          const tracked = this.active.get(job.id);
          if (tracked?.attempt.id === attempt.id) tracked.closing = true;
          try {
            this.storage.markResilientPhase(job.id, attempt.id, attempt.owner, "draining", "awaiting_sdk_shutdown", { sessionId: receipt.binding.ownerSessionId, runId: receipt.runId, entryId: receipt.checkpointEntryId, sessionFile: context.sessionManager.getSessionFile() });
            this.emitChange(job.id);
          } catch (error) { this.hooks.onError(job.id, error); }
          try { await context.dispose!(receipt); }
          catch (error) { this.keepOwned(job, attempt, "model_sdk_close_failed", error); return; }
        }
        this.finish(job.id, attempt, receipt, context.sessionManager);
      }, error => this.keepOwned(job, attempt, "native_settlement_unknown", error)).catch(error => this.keepOwned(job, attempt, "native_settlement_unknown", error));
      this.armMonitor();
      return true;
    } catch (error) {
      try { handle.requestCancel("native_binding_failed"); } catch (failure) { this.hooks.onError(job.id, failure); }
      this.keepOwned(job, attempt, "native_binding_failed", error);
      return false;
    }
  }

  private readCheckpoint(manager: NativeSessionReader, entryId: string, runId: string): NativeRunCheckpoint {
    const entry = manager.getEntry(entryId);
    const data = entry?.type === "custom" && entry.customType === "pi.scheduled-checkpoint.v1" ? entry.data as NativeRunCheckpoint : undefined;
    if (data?.version !== 1 || data.runId !== runId || !data.binding || !Array.isArray(data.completedResults) || data.completedResults.length > 256 || !Number.isSafeInteger(data.completedResultCount) || data.completedResultCount < data.completedResults.length || !data.declarations || !["none-observed", "unknown"].includes(data.effectStatus) || data.businessOutcome !== "unverified") throw new Error("Exact native checkpoint unavailable; do not replay the run");
    return data;
  }

  private checkpoint(receipt: NativeExecutionProof, manager: NativeSessionReader): { reference: NativeCheckpointReference; waitingReason?: string } {
    const data = this.readCheckpoint(manager, receipt.checkpointEntryId, receipt.runId);
    if (!sameNativeBinding(data.binding, receipt.binding)) throw new Error("Exact native checkpoint binding changed; do not replay the run");
    const sessionFile = manager.getSessionFile?.();
    return { reference: { sessionId: receipt.binding.ownerSessionId, entryId: receipt.checkpointEntryId, runId: receipt.runId, ...(sessionFile ? { sessionFile } : {}) }, waitingReason: data.declarations?.waitingReason };
  }

  private finish(id: string, attempt: OwnedAttempt, receipt: NativeExecutionProof & { reason?: string }, manager: NativeSessionReader): void {
    let before: ResilientJob | undefined;
    try {
      before = this.current(id);
      if (!before) return;
      const checkpoint = this.checkpoint(receipt, manager);
      const modelSdkClose = attempt.model ? readModelSdkClose(manager, receipt) : undefined;
      if (attempt.model && !modelSdkClose) { this.keepOwned(before, attempt, "model_sdk_closure_unconfirmed"); return; }
      const safelyFinishedAt = modelSdkClose?.closedAt ?? receipt.finishedAt;
      const input = receipt.reason === "user_input_required" || checkpoint.waitingReason === "user_input_required";
      const unknown = receipt.effectStatus === "unknown";
      const exhausted = !before.enabled || Date.parse(before.expiresAt!) <= Date.now() || before.attemptCount! >= before.maxRuns!;
      const phase = input ? "waiting-input" as const : unknown ? "reconciling" as const : exhausted ? "finished" as const : receipt.execution === "completed" ? "waiting" as const : receipt.execution === "deferred" ? "backoff" as const : "attention-required" as const;
      const notBefore = phase === "backoff" ? new Date(Math.max(Date.parse(cooldownNotBefore(Date.parse(safelyFinishedAt), before.runtime.cooldownStep + 1)), receipt.retryNotBefore ? Date.parse(receipt.retryNotBefore) : 0)).toISOString() : undefined;
      const committed = this.storage.settleResilient(id, attempt.id, attempt.owner, receipt, checkpoint.reference, { phase, reason: input ? "user_input_required" : receipt.reason, ...(notBefore ? { notBefore } : {}), ...(["waiting", "backoff"].includes(phase) && before.runtime.nextEligibleAt ? { nextEligibleAt: before.runtime.nextEligibleAt } : {}) }, modelSdkClose);
      if (this.active.get(id)?.attempt.id === attempt.id) this.active.delete(id);
      if (committed) {
        this.hooks.onChange(this.current(id));
        this.hooks.onSettled(id);
      }
    } catch (error) {
      if (before) this.keepOwned(before, attempt, "native_settlement_failed", error);
      else this.hooks.onError(id, error);
    }
  }

  private emitChange(id: string): void {
    try { this.hooks.onChange(this.current(id)); }
    catch (error) { this.hooks.onError(id, error); }
  }

  private hold(job: ResilientJob, reason: string, error?: unknown): void {
    try {
      if (job.runtime.slot.kind === "owned") this.storage.markResilientPhase(job.id, job.runtime.slot.attempt.id, job.runtime.slot.attempt.owner, "attention-required", reason);
      else this.storage.setResilientDisposition(job.id, job.session!, { phase: "attention-required", reason });
    } catch (failure) { this.hooks.onError(job.id, failure); }
    this.stopJob(job.id); this.emitChange(job.id);
    this.hooks.onError(job.id, error ?? new Error(reason));
  }
  private keepOwned(job: ResilientJob, attempt: OwnedAttempt, reason: string, error?: unknown): void {
    try { this.storage.markResilientPhase(job.id, attempt.id, attempt.owner, "attention-required", reason); }
    catch (failure) { this.hooks.onError(job.id, failure); }
    this.stopJob(job.id); this.emitChange(job.id);
    this.hooks.onError(job.id, error ?? new Error(reason));
  }

  private armMonitor(): void {
    if (this.stopped || this.monitor || !this.active.size) return;
    this.monitor = setTimeout(() => {
      this.monitor = undefined;
      for (const [id, run] of this.active) {
        try {
          const snapshot = run.handle.snapshot();
          if (["draining", "cancelling", "attention-required"].includes(snapshot.phase)) {
            const key = `${snapshot.phase}:${snapshot.reason ?? ""}:${snapshot.checkpointEntryId ?? ""}`;
            if (run.projected !== key && !run.closing) {
              const phase = snapshot.phase as "draining" | "cancelling" | "attention-required";
              this.storage.markResilientPhase(id, run.attempt.id, run.attempt.owner, phase, snapshot.reason, snapshot.checkpointEntryId ? { sessionId: snapshot.binding.ownerSessionId, runId: snapshot.runId, entryId: snapshot.checkpointEntryId } : undefined);
              run.projected = key; this.hooks.onChange(this.current(id));
            }
          }
        } catch (error) { this.hooks.onError(id, error); }
      }
      this.armMonitor();
    }, 1000);
    this.monitor.unref?.();
  }

  private persistAndArm(job: ResilientJob, target: number, discardPending = false): void {
    if (target >= Date.parse(job.expiresAt!)) return;
    if (this.storage.setResilientEligibility(job.id, job.session!, job.revision!, new Date(target).toISOString(), discardPending)) this.arm(job.id, target);
  }
  private arm(id: string, target: number): void {
    if (this.stopped) return;
    this.stopJob(id); this.nextRuns.set(id, new Date(target));
    const timer = setTimeout(() => {
      this.timers.delete(id); this.nextRuns.delete(id);
      try { this.fire(id); }
      catch (error) {
        if (error instanceof ScheduleStoreBusyError) this.arm(id, Date.now() + 1000);
        else {
          try { const job = this.current(id); if (job) this.hold(job, "timing_persistence_failed", error); else this.hooks.onError(id, error); }
          catch (failure) { this.hooks.onError(id, failure); }
        }
      }
    }, Math.max(1, Math.min(2_147_483_647, target - Date.now())));
    timer.unref?.(); this.timers.set(id, timer);
  }
  private fire(id: string): void {
    const job = this.current(id);
    if (this.stopped || !job?.enabled || (job.runtime.slot.kind === "idle" && !["waiting", "backoff"].includes(job.runtime.slot.phase)) || (job.runtime.slot.kind === "owned" && job.runtime.slot.phase === "attention-required")) return;
    const now = Date.now();
    const view = timingView(job);
    if (view.nextEligibleAt && Date.parse(view.nextEligibleAt) > now) { this.arm(id, Date.parse(view.nextEligibleAt)); return; }
    let due: TimedOccurrence;
    try { due = occurrence(view, now); }
    catch {
      const next = this.nextCadence(job, now) ?? nextEligibleAfter(job, now);
      if (next) this.persistAndArm(job, next.getTime(), true);
      return;
    }
    this.queue(job, { ...due, ...(job.runtime.continuation ? { source: "continuation" as const } : {}) }, this.nextCadence(job, now));
  }
  private queue(job: ResilientJob, due: TimedOccurrence, next?: Date): void {
    const result = this.storage.queueResilient(job.id, job.session!, due, next?.toISOString());
    if (result.status === "queued") this.hooks.onQueued(job.id);
    if (result.status === "ignored" && result.reason === "authorization-bound") return;
    const current = this.current(job.id);
    if (next && current?.enabled && (current.runtime.slot.kind === "owned" || ["waiting", "backoff"].includes(current.runtime.slot.phase))) this.persistAndArm(current, next.getTime());
  }
  private nextCadence(job: ResilientJob, after: number): Date | undefined {
    return job.policy.intervalMode === "fixed-delay" ? undefined : nextDue(timingView(job), after);
  }
}
