import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type NativeCapability, type NativeRunCheckpoint, type NativeRunHandle, type NativeSessionReader, nativeCapability, sameNativeBinding } from "./native.js";
import { isResilient, spentOnUtcDay } from "./resilient-policy.js";
import { type PreparedScheduledModel, planScheduledModel, prepareScheduledModel, readModelSdkClose, readStoredModelSession } from "./scheduled-model.js";
import { type CronStorage, ScheduleStoreBusyError } from "./storage.js";
import { cooldownNotBefore, misfire, nextDue, nextEligibleAfter, occurrence, timingView } from "./timing.js";
import type { CronJob, ModelSdkCloseProof, NativeCheckpointReference, NativeExecutionProof, OwnedAttempt, ResilientJob, ResilientRuntimeExpectation, TimedOccurrence } from "./types.js";

export interface ResilientSchedulerHooks {
  onQueued(jobId: string): void;
  onSettled(jobId: string): void;
  onChange(job: CronJob | undefined): void;
  onError(jobId: string, error: unknown): void;
}
interface ProjectedPhase {
  phase: "running" | "draining" | "cancelling" | "attention-required";
  reason?: string;
  checkpointEntryId?: string;
}
interface TrackedRun {
  attempt: OwnedAttempt;
  handle: NativeRunHandle;
  sessionManager: NativeSessionReader;
  dispose?: (receipt?: NativeExecutionProof) => Promise<ModelSdkCloseProof | undefined>;
  closing?: boolean;
  projected?: ProjectedPhase;
}
interface PendingSettlementRecovery {
  id: string;
  attempt: OwnedAttempt;
  receipt: NativeExecutionProof & { reason?: string };
  manager: NativeSessionReader;
  checkpoint: NativeCheckpointReference;
  waitingReason?: string;
  modelSdkClose?: ModelSdkCloseProof;
  timer?: NodeJS.Timeout;
}
interface PendingSettlementNotification {
  id: string;
  attempt: OwnedAttempt;
  receipt: NativeExecutionProof;
  changeNotified: boolean;
  settledNotified: boolean;
  retries: number;
  timer?: NodeJS.Timeout;
}
const SETTLEMENT_RECOVERY_DELAY_MS = 1000;
const MAX_CONTENTION_RETRIES = 3;
type RecoveryMode = false | "restore";
type PreflightToken = ResilientRuntimeExpectation & { jobId: string; revision: number; };
const bindingFor = (jobId: string, attempt: OwnedAttempt): NativeExecutionProof["binding"] => ({ jobId, attemptId: attempt.id, ownerSessionId: attempt.nativeSessionId ?? attempt.owner.sessionId, ownerEpoch: attempt.owner.epoch, revision: attempt.revision });
const runtimeExpectation = (job: ResilientJob): ResilientRuntimeExpectation => {
  const slot = job.runtime.slot;
  return {
    phase: slot.phase,
    ...(slot.reason !== undefined ? { reason: slot.reason } : {}),
    ownerEpoch: job.runtime.ownerEpoch,
    ...(slot.kind === "owned" ? { attemptId: slot.attempt.id } : {}),
    nextEligibleAt: job.runtime.nextEligibleAt,
    pendingId: job.runtime.pending?.id,
    pendingRevision: job.runtime.pending?.revision,
  };
};
const hasExpectation = (expected: ResilientRuntimeExpectation, key: keyof ResilientRuntimeExpectation): boolean => Object.hasOwn(expected, key);
const preflightToken = (job: ResilientJob): PreflightToken => ({ jobId: job.id, revision: job.revision ?? 0, ...runtimeExpectation(job) });
const sameRuntimeExpectation = (job: ResilientJob, expected: ResilientRuntimeExpectation): boolean => {
  const slot = job.runtime.slot;
  return slot.phase === expected.phase && slot.reason === expected.reason &&
    (expected.ownerEpoch === undefined || job.runtime.ownerEpoch === expected.ownerEpoch) &&
    (expected.attemptId === undefined || slot.kind === "owned" && slot.attempt.id === expected.attemptId && slot.attempt.owner.epoch === expected.ownerEpoch) &&
    (!hasExpectation(expected, "nextEligibleAt") || job.runtime.nextEligibleAt === expected.nextEligibleAt) &&
    (!hasExpectation(expected, "pendingId") || job.runtime.pending?.id === expected.pendingId) &&
    (!hasExpectation(expected, "pendingRevision") || job.runtime.pending?.revision === expected.pendingRevision);
};

/** Compose timers and the real native capability; legacy durable/model paths remain in CronScheduler. */
export class ResilientScheduling {
  private readonly instanceId = randomUUID();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly nextRuns = new Map<string, Date>();
  private readonly active = new Map<string, TrackedRun>();
  private readonly settlementRecovery = new Map<string, PendingSettlementRecovery>();
  private readonly settlementNotification = new Map<string, PendingSettlementNotification>();
  private readonly lastSettledAttempt = new Map<string, string>();
  private readonly lastSettledEvidence = new Map<string, { attempt: OwnedAttempt; receipt: NativeExecutionProof }>();
  private readonly scheduledSettlementAttempt = new Map<string, string>();
  private readonly settlementCadenceRecovery = new Map<string, { retries: number; timer?: NodeJS.Timeout }>();
  private readonly preparing = new Set<string>();
  private monitor?: NodeJS.Timeout;
  private stopped = false;

  private ownedRuntimeExpectation(job: ResilientJob, attempt: OwnedAttempt): ResilientRuntimeExpectation | undefined {
    const slot = job.runtime.slot;
    if (slot.kind !== "owned" || job.runtime.ownerEpoch !== attempt.owner.epoch || slot.attempt.id !== attempt.id || slot.attempt.owner.sessionId !== attempt.owner.sessionId || slot.attempt.owner.instanceId !== attempt.owner.instanceId || slot.attempt.owner.epoch !== attempt.owner.epoch) return;
    return runtimeExpectation(job);
  }

  constructor(private readonly storage: CronStorage, private readonly ctx: ExtensionContext, private readonly hooks: ResilientSchedulerHooks) {}

  start(): void {
    this.stopped = false;
    for (const recovery of this.settlementRecovery.values()) this.armSettlementRecovery(recovery);
    for (const notification of this.settlementNotification.values()) this.armSettlementNotification(notification);
    for (const [id, recovery] of this.settlementCadenceRecovery) {
      if (!recovery.timer) this.armSettlementCadenceRecovery(id, recovery.retries);
    }
  }
  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear(); this.nextRuns.clear();
    for (const recovery of this.settlementRecovery.values()) {
      if (recovery.timer) clearTimeout(recovery.timer);
      recovery.timer = undefined;
    }
    for (const notification of this.settlementNotification.values()) {
      if (notification.timer) clearTimeout(notification.timer);
      notification.timer = undefined;
    }
    for (const recovery of this.settlementCadenceRecovery.values()) {
      if (recovery.timer) clearTimeout(recovery.timer);
      recovery.timer = undefined;
    }
    if (this.monitor) clearTimeout(this.monitor);
    this.monitor = undefined;
    for (const [id, run] of this.active) {
      try {
        if (run.handle.snapshot().phase === "settled") continue;
        run.handle.requestCancel("scheduler_stopped");
        const current = this.current(id);
        const expectedRuntime = current ? this.ownedRuntimeExpectation(current, run.attempt) : undefined;
        if (expectedRuntime) this.storage.markResilientPhase(id, run.attempt.id, run.attempt.owner, "cancelling", "scheduler_stopped", undefined, expectedRuntime);
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
  recoverContention(id: string, mode: RecoveryMode = false): void { this.armAfterContention(id, Date.now() + 1000, undefined, mode); }
  isOwned(id: string): boolean { return this.active.has(id) || this.preparing.has(id); }
  snapshot(id: string) { return this.active.get(id)?.handle.snapshot(); }

  schedule(raw: CronJob, mode: RecoveryMode = false, contentionRetries = 0): void {
    if (this.stopped || !isResilient(raw)) return;
    const restoring = mode === "restore";
    let job = raw;
    const snapshotRevision = raw.revision ?? 0;
    const snapshotRuntime = runtimeExpectation(raw);
    try {
      if (raw.session !== this.ctx.sessionManager.getSessionId()) return;
      if (job.runtime.slot.kind === "owned") { this.restoreOwned(job); return; }
      if (!job.enabled) return;
      if (!this.capability()) { this.hold(job, "runtime_unavailable", undefined, snapshotRevision, snapshotRuntime, mode); return; }
      if (job.runtime.slot.phase === "attention-required" && ["runtime_unavailable", "native_disposed", "native_model_route_unsupported", "native_model_unavailable"].includes(job.runtime.slot.reason ?? "")) {
        const expectedRevision = job.revision ?? 0;
        const expectedRuntime = runtimeExpectation(job);
        if (!this.storage.setResilientDisposition(job.id, job.session!, { phase: "waiting" }, expectedRevision, expectedRuntime)) {
          this.rescheduleCurrent(job.id, expectedRevision, expectedRuntime, mode);
          return;
        }
        const current = this.current(job.id);
        if (!current) return;
        job = current;
      }
      const preflight = this.preflightModel(job, mode);
      if (!preflight) return;
      if (job.runtime.slot.kind !== "idle" || !["waiting", "backoff"].includes(job.runtime.slot.phase)) return;
      const now = Date.now();
      const day = new Date(now).toISOString().slice(0, 10);
      const delayed = (job.runtime.notBefore && Date.parse(job.runtime.notBefore) > now) || (job.maxRunsPerDay !== undefined && spentOnUtcDay(job, day) >= job.maxRunsPerDay) || (job.dailyUsage && day < job.dailyUsage.day);
      if (delayed) { const next = nextEligibleAfter(job, now); if (next) this.persistAndArm(job, next.getTime(), true, preflight, mode); return; }
      if (job.runtime.pending) {
        if (restoring && job.policy.misfirePolicy === "skip") {
          const next = nextEligibleAfter(job, now);
          if (next) this.persistAndArm(job, next.getTime(), true, preflight, mode);
          return;
        }
        this.hooks.onQueued(job.id);
        const next = this.nextCadence(job, Date.parse(job.runtime.pending.dueAt));
        if (next) this.persistAndArm(job, next.getTime(), false, preflight, mode);
        return;
      }
      if (!restoring && job.runtime.nextEligibleAt && Date.parse(job.runtime.nextEligibleAt) > now) {
        this.persistAndArm(job, Date.parse(job.runtime.nextEligibleAt), false, preflight, mode);
        return;
      }
      if (restoring && job.runtime.continuation && job.runtime.slot.phase === "waiting" && !job.runtime.nextEligibleAt) {
        const continuation = job.runtime.continuation;
        const resolution = job.attemptResolutions.find(item => item.attemptId === continuation.attemptId && item.evidenceFingerprint === continuation.evidenceFingerprint);
        if (resolution?.resumeAfterMs !== undefined) {
          // Expired minimum wait is not permission to skip the original cadence.
          const next = nextEligibleAfter(job, now);
          if (next) this.persistAndArm(job, next.getTime(), true, preflight, mode);
          return;
        }
        this.queue(job, { id: `${job.revision}:continuation:${job.runtime.continuation.attemptId}`, dueAt: new Date(now).toISOString(), revision: job.revision!, source: "continuation" }, undefined, preflight, mode);
        return;
      }
      if (restoring) {
        const decision = misfire(timingView(job), now);
        if (decision.action === "future") { this.persistAndArm(job, Date.parse(decision.dueAt), false, preflight, mode); return; }
        if (decision.action === "skip") {
          const next = nextEligibleAfter(job, now);
          if (next) this.persistAndArm(job, next.getTime(), true, preflight, mode);
          return;
        }
        this.queue(job, { id: `${job.revision}:${decision.dueAt}`, dueAt: decision.dueAt, revision: job.revision!, source: decision.source }, this.nextCadence(job, now), preflight, mode);
        return;
      }
      const due = nextEligibleAfter(job, now);
      if (due) this.persistAndArm(job, due.getTime(), false, preflight, mode);
    } catch (error) {
      if (error instanceof ScheduleStoreBusyError) this.armAfterContention(job.id, Date.now() + 1000, undefined, mode, contentionRetries);
      else this.hold(job, "timing_unavailable", error, snapshotRevision, snapshotRuntime, mode);
    }
  }

  /** Registered in-process runs, including SDK-closing owners; not an external SDK/process census. */
  registeredJobIds(): string[] { return [...this.active.keys()]; }

  scheduleAfterSettlement(id: string, contentionRetries = 0): void {
    if (this.stopped) return;
    const settledAttempt = this.lastSettledAttempt.get(id);
    if (settledAttempt && this.scheduledSettlementAttempt.get(id) === settledAttempt) return;
    try {
      const job = this.current(id);
      const evidence = this.lastSettledEvidence.get(id);
      if (evidence && !this.settledByOtherWriter(job, evidence.attempt, evidence.receipt)) return;
      if (!job?.enabled || job.runtime.slot.kind !== "idle") return;
      if (job.runtime.pending) this.hooks.onQueued(id);
      this.stopJob(id);
      if (job.runtime.slot.kind === "idle" && ["waiting", "backoff"].includes(job.runtime.slot.phase)) this.schedule(job, false, contentionRetries);
      if (settledAttempt) this.scheduledSettlementAttempt.set(id, settledAttempt);
    } catch (error) {
      if (error instanceof ScheduleStoreBusyError) {
        this.armSettlementCadenceRecovery(id, contentionRetries + 1);
        return;
      }
      throw error;
    }
  }

  execute(id: string): void {
    let job: ResilientJob | undefined;
    try { job = this.current(id); }
    catch (error) {
      if (error instanceof ScheduleStoreBusyError) {
        this.hooks.onQueued(id);
        this.recoverContention(id, false);
        return;
      }
      throw error;
    }
    if (this.stopped || !job?.enabled || job.runtime.slot.kind !== "idle" || !["waiting", "backoff"].includes(job.runtime.slot.phase)) return;
    const expectedRevision = job.revision ?? 0;
    const expectedRuntime = runtimeExpectation(job);
    if (job.model) {
      void this.executeModel(job).catch(error => this.hooks.onError(id, error));
      return;
    }
    const capability = this.capability();
    if (!capability) { this.hold(job, "runtime_unavailable", undefined, expectedRevision, expectedRuntime); return; }
    const pending = job.runtime.pending;
    if (!pending) return;
    let admitted: ResilientJob | undefined;
    try { admitted = this.storage.reserveResilient(id, job.session!, this.instanceId, expectedRevision, pending.id); }
    catch (error) {
      if (error instanceof ScheduleStoreBusyError) this.hooks.onQueued(id);
      else this.hooks.onError(id, error);
      return;
    }
    if (admitted?.runtime.slot.kind !== "owned") {
      this.rescheduleCurrent(id, expectedRevision, expectedRuntime, false);
      return;
    }
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
    const expectedRevision = snapshot.revision ?? 0;
    const expectedRuntime = runtimeExpectation(snapshot);
    const expectedPendingId = snapshot.runtime.pending?.id;
    let prepared: PreparedScheduledModel | undefined;
    let preparedDispose: Promise<ModelSdkCloseProof | undefined> | undefined;
    let preparedDisposeFailure: unknown;
    let admitted: ResilientJob | undefined;
    let attempt: OwnedAttempt | undefined;
    const disposePrepared = (receipt?: NativeExecutionProof): Promise<ModelSdkCloseProof | undefined> => {
      if (!prepared) return Promise.resolve(undefined);
      if (!preparedDispose) {
        const ownedPrepared = prepared;
        preparedDispose = Promise.resolve().then(() => ownedPrepared.dispose(receipt)).catch(error => {
          preparedDisposeFailure = error;
          throw error;
        });
      }
      return preparedDispose;
    };
    try {
      const current = this.current(snapshot.id);
      if (this.stopped || !current?.enabled || !current.runtime.pending || current.runtime.pending.id !== expectedPendingId || (current.revision ?? 0) !== expectedRevision || !sameRuntimeExpectation(current, expectedRuntime) || current.model !== snapshot.model) {
        if (current) this.schedule(current, false);
        return;
      }
      if (!this.capability()) { this.hold(current, "runtime_unavailable", undefined, expectedRevision, expectedRuntime); return; }
      // No SDK construction or transcript writer is allowed before atomic ownership.
      const plan = planScheduledModel(this.ctx, current);
      admitted = this.storage.reserveResilient(current.id, current.session!, this.instanceId, expectedRevision, expectedPendingId!, Date.now(), { model: current.model!, ...plan });
      if (admitted?.runtime.slot.kind !== "owned") {
        this.rescheduleCurrent(snapshot.id, expectedRevision, expectedRuntime, false);
        return;
      }
      attempt = admitted.runtime.slot.attempt;
      const acceptedJob = admitted;
      const acceptedAttempt = attempt;
      prepared = await prepareScheduledModel(this.ctx, admitted, attempt, plan.route, file => {
        if (!this.storage.bindResilientModelFile(acceptedJob.id, acceptedAttempt.id, acceptedAttempt.owner, file)) throw new Error("Native child transcript could not bind its exact admitted owner");
      });
      const latest = this.current(current.id);
      if (this.stopped || !latest?.enabled) {
        try { await disposePrepared(); }
        catch (error) {
          prepared = undefined;
          this.keepOwned(admitted, attempt, "model_sdk_close_failed", error);
          return;
        }
        prepared = undefined;
        this.keepOwned(admitted, attempt, "user_stopped_before_native_start");
        return;
      }
      const accepted = prepared.capability.start({ binding: bindingFor(admitted.id, attempt), policy: { softDeadlineMs: attempt.workBudgetMs, hardDeadlineMs: attempt.deadlineMs, recoveryBudgetMs: 300_000 }, content: this.prompt(admitted, prepared.sessionManager) });
      if (!accepted.accepted) {
        try { await disposePrepared(); }
        catch (error) {
          prepared = undefined;
          this.keepOwned(admitted, attempt, "model_sdk_close_failed", error);
          return;
        }
        prepared = undefined;
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
      if (!admitted && error instanceof ScheduleStoreBusyError) { this.hooks.onQueued(snapshot.id); this.recoverContention(snapshot.id, false); return; }
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
        } else if (!active) {
          if (!preparedDisposeFailure) {
            try { await disposePrepared(); }
            catch (failure) { preparedDisposeFailure = failure; }
          }
          prepared = undefined;
          if (preparedDisposeFailure) {
            if (admitted && attempt) {
              this.keepOwned(admitted, attempt, "model_sdk_close_failed", preparedDisposeFailure);
              return;
            }
            this.hooks.onError(snapshot.id, preparedDisposeFailure);
            return;
          }
        } else {
          const dispose = prepared.dispose;
          void active.settled.then(receipt => dispose(receipt)).catch(failure => this.hooks.onError(snapshot.id, failure));
        }
      }
      if (admitted && attempt) this.keepOwned(admitted, attempt, "native_model_preparation_failed", error);
      else {
        const current = this.current(snapshot.id);
        if (current) {
          const held = this.hold(current, "native_model_unavailable", error, expectedRevision, expectedRuntime);
          if (held) {
            const heldCurrent = this.current(current.id);
            if (heldCurrent) this.clearProjection(heldCurrent, expectedRevision, { ...runtimeExpectation(heldCurrent), phase: "attention-required", reason: "native_model_unavailable" });
          } else this.rescheduleCurrent(snapshot.id, expectedRevision, expectedRuntime, false);
        } else this.hooks.onError(snapshot.id, error);
      }
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
    return job && isResilient(job) && job.session === this.ctx.sessionManager.getSessionId() ? job : undefined;
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
        if (next) {
          if (job.runtime.nextEligibleAt && Date.parse(job.runtime.nextEligibleAt) <= Date.now()) this.fire(job.id);
          else this.persistAndArm(job, next.getTime());
        }
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
      const initialProjection = job.runtime.slot.kind === "owned" ? { phase: job.runtime.slot.phase, ...(job.runtime.slot.reason !== undefined ? { reason: job.runtime.slot.reason } : {}), ...(job.runtime.slot.attempt.checkpoint?.entryId ? { checkpointEntryId: job.runtime.slot.attempt.checkpoint.entryId } : {}) } : { phase: "running" as const };
      this.active.set(job.id, { attempt: structuredClone(attempt), handle, ...context, projected: initialProjection });
      void handle.settled.then(async receipt => {
        if (attempt.model) {
          const tracked = this.active.get(job.id);
          if (tracked?.attempt.id === attempt.id) tracked.closing = true;
          try {
            const current = this.current(job.id);
            const expectedRuntime = current ? this.ownedRuntimeExpectation(current, attempt) : undefined;
            const projected = expectedRuntime && this.storage.markResilientPhase(job.id, attempt.id, attempt.owner, "draining", "awaiting_sdk_shutdown", { sessionId: receipt.binding.ownerSessionId, runId: receipt.runId, entryId: receipt.checkpointEntryId, sessionFile: context.sessionManager.getSessionFile() }, expectedRuntime);
            if (projected) this.emitChange(job.id);
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

  private finish(id: string, attempt: OwnedAttempt, receipt: NativeExecutionProof & { reason?: string }, manager: NativeSessionReader, allowRecovery = true, retained?: { checkpoint: NativeCheckpointReference; waitingReason?: string; modelSdkClose?: ModelSdkCloseProof }): void {
    let before: ResilientJob | undefined;
    let recoveryCheckpoint: NativeCheckpointReference | undefined;
    let recoveryWaitingReason: string | undefined;
    let recoveryModelSdkClose: ModelSdkCloseProof | undefined;
    try {
      // Read the immutable receipt/checkpoint evidence before touching the
      // store. If the store is busy, this exact receipt can still be retained
      // for a persistence-only retry; no new native action is authorized.
      const checkpoint = retained ? { reference: structuredClone(retained.checkpoint), ...(retained.waitingReason !== undefined ? { waitingReason: retained.waitingReason } : {}) } : this.checkpoint(receipt, manager);
      recoveryCheckpoint = checkpoint.reference;
      recoveryWaitingReason = checkpoint.waitingReason;
      const modelSdkClose = attempt.model ? retained?.modelSdkClose ?? readModelSdkClose(manager, receipt) : undefined;
      recoveryModelSdkClose = modelSdkClose;
      before = this.current(id);
      if (!before) {
        this.clearSettlementRecovery(id);
        return;
      }
      if (attempt.model && !modelSdkClose) { this.keepOwned(before, attempt, "model_sdk_closure_unconfirmed", undefined, recoveryCheckpoint); return; }
      const safelyFinishedAt = modelSdkClose?.closedAt ?? receipt.finishedAt;
      const input = receipt.reason === "user_input_required" || checkpoint.waitingReason === "user_input_required";
      const unknown = receipt.effectStatus === "unknown";

      // A false settlement CAS is not evidence that this native owner moved.
      // Re-read the exact slot and retry the persistence-only settlement a
      // bounded number of times; never start another native action here.
      for (let retry = 0; retry < 2; retry++) {
        before = this.current(id);
        if (!before) return;
        if (!this.sameOwnedAttempt(before, attempt)) {
          if (this.settledByOtherWriter(before, attempt, receipt)) this.confirmSettlement(id, attempt, receipt);
          return;
        }
        const exhausted = !before.enabled || Date.parse(before.expiresAt!) <= Date.now() || before.attemptCount! >= before.maxRuns!;
        const phase = input ? "waiting-input" as const : unknown ? "reconciling" as const : exhausted ? "finished" as const : receipt.execution === "completed" ? "waiting" as const : receipt.execution === "deferred" ? "backoff" as const : "attention-required" as const;
        const notBefore = phase === "backoff" ? new Date(Math.max(Date.parse(cooldownNotBefore(Date.parse(safelyFinishedAt), before.runtime.cooldownStep + 1)), receipt.retryNotBefore ? Date.parse(receipt.retryNotBefore) : 0)).toISOString() : undefined;
        const expectedRuntime = this.ownedRuntimeExpectation(before, attempt);
        if (!expectedRuntime) continue;
        const committed = this.storage.settleResilient(id, attempt.id, attempt.owner, receipt, checkpoint.reference, { phase, reason: input ? "user_input_required" : receipt.reason, ...(notBefore ? { notBefore } : {}), ...(["waiting", "backoff"].includes(phase) && before.runtime.nextEligibleAt ? { nextEligibleAt: before.runtime.nextEligibleAt } : {}) }, modelSdkClose, expectedRuntime);
        if (committed) {
          this.confirmSettlement(id, attempt, receipt);
          return;
        }
        const latest = this.current(id);
        if (!this.sameOwnedAttempt(latest, attempt)) {
          if (this.settledByOtherWriter(latest, attempt, receipt)) this.confirmSettlement(id, attempt, receipt);
          return;
        }
      }
      // The native handle is already settled here. Retain exact ownership and
      // checkpoint evidence, then give this scheduler one bounded,
      // receipt-only recovery pass. It must not start another native action.
      if (allowRecovery) this.scheduleSettlementRecovery({ id, attempt: structuredClone(attempt), receipt: structuredClone(receipt), manager, checkpoint: structuredClone(recoveryCheckpoint!), ...(checkpoint.waitingReason !== undefined ? { waitingReason: checkpoint.waitingReason } : {}), ...(modelSdkClose ? { modelSdkClose: structuredClone(modelSdkClose) } : {}) });
      else {
        const current = this.current(id);
        if (current && this.sameOwnedAttempt(current, attempt)) {
          this.active.delete(id);
          this.keepOwned(current, attempt, "native_settlement_failed", new Error("Native settlement recovery remained uncommitted after bounded receipt-only retry"), recoveryCheckpoint);
        }
      }
    } catch (error) {
      if (this.active.get(id)?.attempt.id === attempt.id) this.active.delete(id);
      if (error instanceof ScheduleStoreBusyError && recoveryCheckpoint) {
        if (allowRecovery) {
          this.scheduleSettlementRecovery({ id, attempt: structuredClone(attempt), receipt: structuredClone(receipt), manager, checkpoint: structuredClone(recoveryCheckpoint), ...(recoveryWaitingReason !== undefined ? { waitingReason: recoveryWaitingReason } : {}), ...(recoveryModelSdkClose ? { modelSdkClose: structuredClone(recoveryModelSdkClose) } : {}) });
        } else {
          // The one receipt-only pass is bounded. If contention persists, make
          // the exact owner/checkpoint observable as attention-required rather
          // than dropping the receipt or entering another settlement loop.
          this.armOwnedRecovery(id, () => {
            const current = this.current(id);
            if (current) this.keepOwned(current, attempt, "native_settlement_failed", error, recoveryCheckpoint);
          });
        }
        return;
      }
      if (before) this.keepOwned(before, attempt, "native_settlement_failed", error, recoveryCheckpoint);
      else this.hooks.onError(id, error);
    }
  }

  private confirmSettlement(id: string, attempt: OwnedAttempt, receipt: NativeExecutionProof): void {
    this.clearSettlementRecovery(id);
    if (this.active.get(id)?.attempt.id === attempt.id) this.active.delete(id);
    const notification: PendingSettlementNotification = {
      id, attempt: structuredClone(attempt), receipt: structuredClone(receipt), changeNotified: false, settledNotified: false, retries: 0,
    };
    this.lastSettledAttempt.set(id, attempt.id);
    this.lastSettledEvidence.set(id, { attempt: structuredClone(attempt), receipt: structuredClone(receipt) });
    this.scheduledSettlementAttempt.delete(id);
    const existing = this.settlementNotification.get(id);
    if (!existing || existing.attempt.id !== attempt.id) this.settlementNotification.set(id, notification);
    const current = this.settlementNotification.get(id);
    if (current) this.notifySettlement(current);
  }

  private notifySettlement(notification: PendingSettlementNotification): void {
    if (this.stopped || this.settlementNotification.get(notification.id) !== notification) return;
    let current: ResilientJob | undefined;
    try { current = this.current(notification.id); }
    catch (error) {
      if (error instanceof ScheduleStoreBusyError) this.armSettlementNotification(notification);
      else { this.settlementNotification.delete(notification.id); this.hooks.onError(notification.id, error); }
      return;
    }
    if (!current || !this.settledByOtherWriter(current, notification.attempt, notification.receipt)) {
      this.settlementNotification.delete(notification.id);
      return;
    }
    try {
      if (!notification.changeNotified) {
        this.hooks.onChange(current);
        notification.changeNotified = true;
      }
      if (!notification.settledNotified) {
        this.hooks.onSettled(notification.id);
        notification.settledNotified = true;
      }
      if (notification.changeNotified && notification.settledNotified) this.settlementNotification.delete(notification.id);
    } catch (error) {
      if (error instanceof ScheduleStoreBusyError) this.armSettlementNotification(notification);
      else { this.settlementNotification.delete(notification.id); this.hooks.onError(notification.id, error); }
    }
  }

  private armSettlementNotification(notification: PendingSettlementNotification): void {
    if (this.stopped || notification.timer) return;
    if (notification.retries >= MAX_CONTENTION_RETRIES) {
      this.settlementNotification.delete(notification.id);
      this.hooks.onError(notification.id, new Error("Post-settlement store contention retry budget exhausted; exact history retained but cadence requires attention"));
      return;
    }
    notification.timer = setTimeout(() => {
      notification.timer = undefined;
      notification.retries++;
      this.notifySettlement(notification);
    }, SETTLEMENT_RECOVERY_DELAY_MS);
    notification.timer.unref?.();
  }

  private armSettlementCadenceRecovery(id: string, retries: number): void {
    if (this.stopped) return;
    const existing = this.settlementCadenceRecovery.get(id);
    if (existing?.timer) return;
    if (existing) retries = existing.retries;
    if (retries > MAX_CONTENTION_RETRIES) {
      this.hooks.onError(id, new Error("Post-settlement cadence store contention retry budget exhausted; exact history retained but cadence requires attention"));
      return;
    }
    const recovery: { retries: number; timer?: NodeJS.Timeout } = { retries };
    this.settlementCadenceRecovery.set(id, recovery);
    recovery.timer = setTimeout(() => {
      recovery.timer = undefined;
      this.settlementCadenceRecovery.delete(id);
      this.scheduleAfterSettlement(id, retries);
    }, SETTLEMENT_RECOVERY_DELAY_MS);
    recovery.timer.unref?.();
  }

  private scheduleSettlementRecovery(recovery: PendingSettlementRecovery): void {
    const existing = this.settlementRecovery.get(recovery.id);
    if (existing) return;
    this.settlementRecovery.set(recovery.id, recovery);
    this.armSettlementRecovery(recovery);
  }

  private armSettlementRecovery(recovery: PendingSettlementRecovery): void {
    if (this.stopped || recovery.timer) return;
    recovery.timer = setTimeout(() => {
      recovery.timer = undefined;
      this.settlementRecovery.delete(recovery.id);
      // This invocation is deliberately receipt-only and does not schedule a
      // second recovery loop if persistence remains unavailable.
      this.finish(recovery.id, recovery.attempt, recovery.receipt, recovery.manager, false, { checkpoint: recovery.checkpoint, ...(recovery.waitingReason !== undefined ? { waitingReason: recovery.waitingReason } : {}), ...(recovery.modelSdkClose ? { modelSdkClose: recovery.modelSdkClose } : {}) });
    }, SETTLEMENT_RECOVERY_DELAY_MS);
    recovery.timer.unref?.();
  }

  /** Retry only persistence/recovery after contention; never re-enter admission. */
  private armOwnedRecovery(id: string, recovery: () => void, retries = 1): void {
    if (this.stopped) return;
    this.stopJob(id);
    const target = Date.now() + SETTLEMENT_RECOVERY_DELAY_MS;
    this.nextRuns.set(id, new Date(target));
    const timer = setTimeout(() => {
      if (this.timers.get(id) !== timer) return;
      this.timers.delete(id); this.nextRuns.delete(id);
      try { recovery(); }
      catch (error) {
        if (error instanceof ScheduleStoreBusyError && retries > 0) this.armOwnedRecovery(id, recovery, retries - 1);
        else this.hooks.onError(id, error);
      }
    }, SETTLEMENT_RECOVERY_DELAY_MS);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private clearSettlementRecovery(id: string): void {
    const recovery = this.settlementRecovery.get(id);
    if (!recovery) return;
    if (recovery.timer) clearTimeout(recovery.timer);
    this.settlementRecovery.delete(id);
  }

  private sameOwnedAttempt(job: ResilientJob | undefined, attempt: OwnedAttempt): boolean {
    if (!job) return false;
    const slot = job.runtime.slot;
    return slot.kind === "owned" && slot.attempt.id === attempt.id && slot.attempt.owner.sessionId === attempt.owner.sessionId && slot.attempt.owner.instanceId === attempt.owner.instanceId && slot.attempt.owner.epoch === attempt.owner.epoch;
  }

  private settledByOtherWriter(job: ResilientJob | undefined, attempt: OwnedAttempt, receipt: NativeExecutionProof): boolean {
    return !!job?.attemptHistory.some(record => record.charged && record.id === attempt.id && record.owner.sessionId === attempt.owner.sessionId && record.owner.instanceId === attempt.owner.instanceId && record.owner.epoch === attempt.owner.epoch && record.nativeProof?.runId === receipt.runId && record.nativeProof.binding.attemptId === attempt.id && record.nativeProof.binding.ownerEpoch === attempt.owner.epoch);
  }

  private emitChange(id: string): void {
    try { this.hooks.onChange(this.current(id)); }
    catch (error) { this.hooks.onError(id, error); }
  }

  private rescheduleCurrent(id: string, expectedRevision?: number, expectedRuntime?: ResilientRuntimeExpectation, mode: RecoveryMode = false): void {
    const current = this.current(id);
    if (!current || this.stopped) return;
    if ((expectedRevision !== undefined && (current.revision ?? 0) !== expectedRevision) || (expectedRuntime !== undefined && !sameRuntimeExpectation(current, expectedRuntime))) this.schedule(current, mode);
  }

  private hold(job: ResilientJob, reason: string, error?: unknown, expectedRevision?: number, expectedRuntime?: ResilientRuntimeExpectation, mode: RecoveryMode = false): boolean {
    const expected = expectedRuntime ?? runtimeExpectation(job);
    let committed = false;
    try {
      if (job.runtime.slot.kind === "owned") {
        if (expectedRevision !== undefined && (job.revision ?? 0) !== expectedRevision) return false;
        committed = this.storage.markResilientPhase(job.id, job.runtime.slot.attempt.id, job.runtime.slot.attempt.owner, "attention-required", reason, undefined, expected);
      } else committed = this.storage.setResilientDisposition(job.id, job.session!, { phase: "attention-required", reason }, expectedRevision, expected);
    } catch (failure) {
      if (failure instanceof ScheduleStoreBusyError) {
        // A failed hold must not be followed by projection cleanup. Retry the
        // whole resilient schedule so the same revision can be revalidated.
        this.arm(job.id, Date.now() + 1000, undefined, mode);
        return false;
      }
      this.hooks.onError(job.id, failure);
      this.stopJob(job.id); this.emitChange(job.id);
      this.hooks.onError(job.id, error ?? new Error(reason));
      return false;
    }
    if (!committed) {
      this.rescheduleCurrent(job.id, expectedRevision, expected, mode);
      return false;
    }
    this.stopJob(job.id); this.emitChange(job.id);
    this.hooks.onError(job.id, error ?? new Error(reason));
    return true;
  }
  private keepOwned(job: ResilientJob, attempt: OwnedAttempt, reason: string, error?: unknown, checkpoint?: NativeCheckpointReference, contentionRetries = 2): void {
    // Preparation can yield while another writer changes the same attempt's
    // projection or definition. Never use the admitted snapshot for cleanup:
    // re-read the exact owner and derive the CAS expectation from that read.
    const retryAfterBusy = (failure: unknown) => {
      if (contentionRetries > 0) this.armOwnedRecovery(job.id, () => this.keepOwned(job, attempt, reason, error, checkpoint, contentionRetries - 1));
      else this.hooks.onError(job.id, failure);
    };
    const retryAfterCasLoss = () => {
      if (contentionRetries > 0) this.armOwnedRecovery(job.id, () => this.keepOwned(job, attempt, reason, error, checkpoint, contentionRetries - 1));
    };
    for (let retry = 0; retry < 2; retry++) {
      let current: ResilientJob | undefined;
      try { current = this.current(job.id); }
      catch (failure) {
        if (failure instanceof ScheduleStoreBusyError) retryAfterBusy(failure);
        else this.hooks.onError(job.id, failure);
        return;
      }
      if (current?.runtime.slot.kind !== "owned" || !this.sameOwnedAttempt(current, attempt)) return;
      const currentAttempt = current.runtime.slot.attempt;
      const expectedRuntime = this.ownedRuntimeExpectation(current, currentAttempt);
      if (!expectedRuntime) return;
      let committed = false;
      try {
        committed = this.storage.markResilientPhase(job.id, currentAttempt.id, currentAttempt.owner, "attention-required", reason, checkpoint, expectedRuntime);
      } catch (failure) {
        if (failure instanceof ScheduleStoreBusyError) {
          retryAfterBusy(failure);
          return;
        }
        this.hooks.onError(job.id, failure);
        this.stopJob(job.id); this.emitChange(job.id);
        return;
      }
      if (committed) {
        this.stopJob(job.id); this.emitChange(job.id);
        this.hooks.onError(job.id, error ?? new Error(reason));
        return;
      }
      // A false CAS is not permission to stop a newer owner/projection. The
      // next bounded pass re-reads it and either applies the hold to this exact
      // attempt or leaves the newer state alone.
    }
    let current: ResilientJob | undefined;
    try { current = this.current(job.id); }
    catch (failure) {
      if (failure instanceof ScheduleStoreBusyError) retryAfterBusy(failure);
      else this.hooks.onError(job.id, failure);
      return;
    }
    if (current?.runtime.slot.kind === "owned" && this.sameOwnedAttempt(current, attempt) && this.ownedRuntimeExpectation(current, current.runtime.slot.attempt)) retryAfterCasLoss();
  }

  private armMonitor(): void {
    if (this.stopped || this.monitor || !this.active.size) return;
    this.monitor = setTimeout(() => {
      this.monitor = undefined;
      for (const [id, run] of this.active) {
        try {
          const snapshot = run.handle.snapshot();
          if (["draining", "cancelling", "attention-required"].includes(snapshot.phase)) {
            const nextProjection: ProjectedPhase = { phase: snapshot.phase as Exclude<ProjectedPhase["phase"], "running">, ...(snapshot.reason !== undefined ? { reason: snapshot.reason } : {}), ...(snapshot.checkpointEntryId ? { checkpointEntryId: snapshot.checkpointEntryId } : {}) };
            const previous = run.projected;
            if ((!previous || previous.phase !== nextProjection.phase || previous.reason !== nextProjection.reason || previous.checkpointEntryId !== nextProjection.checkpointEntryId) && !run.closing) {
              const current = this.current(id);
              const ownedExpected = current ? this.ownedRuntimeExpectation(current, run.attempt) : undefined;
              if (nextProjection.phase === "running" || !ownedExpected) continue;
              const expectedRuntime: ResilientRuntimeExpectation = { ...ownedExpected, phase: previous?.phase ?? "running", ...(previous?.reason !== undefined ? { reason: previous.reason } : { reason: undefined }) };
              const committed = this.storage.markResilientPhase(id, run.attempt.id, run.attempt.owner, nextProjection.phase, nextProjection.reason, nextProjection.checkpointEntryId ? { sessionId: snapshot.binding.ownerSessionId, runId: snapshot.runId, entryId: nextProjection.checkpointEntryId } : undefined, expectedRuntime);
              if (committed) { run.projected = nextProjection; this.hooks.onChange(this.current(id)); }
            }
          }
        } catch (error) { this.hooks.onError(id, error); }
      }
      this.armMonitor();
    }, 1000);
    this.monitor.unref?.();
  }

  private preflightModel(job: ResilientJob, mode: RecoveryMode = false): PreflightToken | undefined {
    const revision = job.revision ?? 0;
    const expectedRuntime = runtimeExpectation(job);
    if (!job.model || job.runtime.slot.kind === "owned") return { jobId: job.id, revision, ...expectedRuntime };
    try { planScheduledModel(this.ctx, job); return { jobId: job.id, revision, ...expectedRuntime }; }
    catch (error) {
      const slot = job.runtime.slot;
      const canHoldPreflight = slot.kind === "idle" && (["waiting", "backoff"].includes(slot.phase) ||
        (slot.phase === "attention-required" && ["runtime_unavailable", "native_disposed", "native_model_route_unsupported", "native_model_unavailable"].includes(slot.reason ?? "")));
      if (canHoldPreflight) {
        if (this.hold(job, "native_model_unavailable", error, revision, expectedRuntime, mode)) {
          const heldCurrent = this.current(job.id);
          if (heldCurrent) this.clearProjection(heldCurrent, revision, { ...runtimeExpectation(heldCurrent), phase: "attention-required", reason: "native_model_unavailable" }, mode);
        }
      } else {
        // Keep UNKNOWN/reconciling and waiting-input barriers intact; only
        // future timer/pending projection is removed when their route cannot be read.
        if (this.clearProjection(job, revision, expectedRuntime, mode)) {
          this.emitChange(job.id);
          this.hooks.onError(job.id, error);
        }
      }
      return undefined;
    }
  }
  private clearProjection(job: ResilientJob, expectedRevision: number, expectedRuntime?: ResilientRuntimeExpectation, mode: RecoveryMode = false): boolean {
    const current = this.current(job.id);
    if (!current || (current.revision ?? 0) !== expectedRevision || (expectedRuntime && !sameRuntimeExpectation(current, expectedRuntime))) {
      this.rescheduleCurrent(job.id, expectedRevision, expectedRuntime, mode);
      return false;
    }
    try {
      const cleared = this.storage.clearResilientProjection(job.id, current.session!, expectedRevision, expectedRuntime);
      if (cleared) this.stopJob(job.id);
      else this.rescheduleCurrent(job.id, expectedRevision, expectedRuntime, mode);
      return cleared;
    } catch (error) {
      if (error instanceof ScheduleStoreBusyError) {
        this.arm(job.id, Date.now() + 1000, undefined, mode);
        return false;
      }
      throw error;
    }
  }
  private persistAndArm(job: ResilientJob, target: number, discardPending = false, preflight?: PreflightToken, mode: RecoveryMode = false): void {
    if (!preflight || preflight.jobId !== job.id || preflight.revision !== (job.revision ?? 0) || !sameRuntimeExpectation(job, preflight)) {
      preflight = this.preflightModel(job, mode);
      if (!preflight) return;
    }
    if (target >= Date.parse(job.expiresAt!)) return;
    if (this.storage.setResilientEligibility(job.id, job.session!, job.revision!, new Date(target).toISOString(), discardPending, preflight)) {
      const current = this.current(job.id);
      if (current) this.arm(job.id, target, preflightToken(current));
    } else this.rescheduleCurrent(job.id, preflight.revision, preflight, mode);
  }
  private armAfterContention(id: string, recoveryTarget: number, armTarget = recoveryTarget, mode: RecoveryMode | undefined = undefined, contentionRetries = 0): void {
    if (this.stopped) return;
    let job: ResilientJob | undefined;
    try { job = this.current(id); }
    catch (error) {
      if (!(error instanceof ScheduleStoreBusyError)) throw error;
      if (contentionRetries >= MAX_CONTENTION_RETRIES) { this.exhaustContention(id, error); return; }
      this.armTimer(id, recoveryTarget, () => this.armAfterContention(id, Date.now() + 1000, armTarget, mode, contentionRetries + 1), contentionRetries, mode, armTarget);
      return;
    }
    if (!job) return;
    const retryMode = mode ?? this.recoverableAttentionHold(job);
    this.arm(id, armTarget, undefined, retryMode, contentionRetries);
  }

  private armTimer(id: string, target: number, onFire: () => void, contentionRetries = 0, mode: RecoveryMode | undefined = undefined, armTarget = target): void {
    if (this.stopped) return;
    this.stopJob(id); this.nextRuns.set(id, new Date(target));
    const timer = setTimeout(() => {
      if (this.timers.get(id) !== timer) return;
      this.timers.delete(id); this.nextRuns.delete(id);
      try { onFire(); }
      catch (error) {
        if (error instanceof ScheduleStoreBusyError) {
          if (contentionRetries >= MAX_CONTENTION_RETRIES) this.exhaustContention(id, error);
          else {
            try { this.armAfterContention(id, Date.now() + 1000, armTarget, mode, contentionRetries + 1); }
            catch (failure) { this.hooks.onError(id, failure); }
          }
        } else this.handleTimingFailure(id, error);
      }
    }, Math.max(1, Math.min(2_147_483_647, target - Date.now())));
    timer.unref?.(); this.timers.set(id, timer);
  }

  private exhaustContention(id: string, cause: unknown): void {
    this.stopJob(id);
    const error = new Error("Schedule store contention retry budget exhausted; persisted resilient intent requires attention", { cause });
    try {
      const job = this.current(id);
      if (job?.runtime.slot.kind === "idle" && ["waiting", "backoff"].includes(job.runtime.slot.phase)) {
        const committed = this.storage.setResilientDisposition(id, job.session!, { phase: "attention-required", reason: "store_contention_retry_exhausted" }, job.revision ?? 0, runtimeExpectation(job));
        if (committed) this.emitChange(id);
      }
    } catch (failure) {
      this.hooks.onError(id, failure);
    }
    this.hooks.onError(id, error);
  }

  private handleTimingFailure(id: string, error: unknown): void {
    try {
      const job = this.current(id);
      if (job) this.hold(job, "timing_persistence_failed", error, job.revision ?? 0, runtimeExpectation(job));
      else this.hooks.onError(id, error);
    }
    catch (failure) {
      if (failure instanceof ScheduleStoreBusyError) {
        try { this.armAfterContention(id, Date.now() + 1000); }
        catch (nested) { this.hooks.onError(id, nested); }
      } else this.hooks.onError(id, failure);
    }
  }

  private arm(id: string, target: number, preflight?: PreflightToken, mode?: RecoveryMode, contentionRetries = 0): void {
    if (this.stopped) return;
    let job: ResilientJob | undefined;
    try { job = this.current(id); }
    catch (error) {
      if (!(error instanceof ScheduleStoreBusyError)) throw error;
      if (contentionRetries >= MAX_CONTENTION_RETRIES) { this.exhaustContention(id, error); return; }
      this.armTimer(id, Date.now() + 1000, () => this.arm(id, target, preflight, mode, contentionRetries + 1), contentionRetries, mode, target);
      return;
    }
    if (!job) return;
    if (mode === undefined && (!preflight || preflight.jobId !== job.id || preflight.revision !== (job.revision ?? 0) || !sameRuntimeExpectation(job, preflight))) {
      preflight = this.preflightModel(job, false);
      if (!preflight) return;
    }
    this.stopJob(id); this.nextRuns.set(id, new Date(target));
    const timer = setTimeout(() => {
      this.timers.delete(id); this.nextRuns.delete(id);
      try {
        const current = this.current(id);
        if (mode !== undefined) {
          if (current) this.schedule(current, mode, contentionRetries);
        } else if (!current || !preflight || (current.revision ?? 0) !== preflight.revision || !sameRuntimeExpectation(current, preflight)) {
          // A timer owns only its captured revision/runtime. Re-enter the
          // scheduler against the current snapshot instead of firing its old
          // target into a new cadence or a reconciliation/input barrier.
          if (current) this.schedule(current, false, contentionRetries);
        } else {
          const slot = current.runtime.slot;
          const phaseAllowed = slot.kind === "owned" ? slot.phase !== "attention-required" : ["waiting", "backoff"].includes(slot.phase);
          const targetStillOwned = current.runtime.nextEligibleAt === new Date(target).toISOString();
          if (!phaseAllowed || (slot.kind === "idle" && !targetStillOwned)) this.schedule(current, false, contentionRetries);
          else this.fire(id);
        }
      }
      catch (error) {
        if (error instanceof ScheduleStoreBusyError) {
          if (contentionRetries >= MAX_CONTENTION_RETRIES) this.exhaustContention(id, error);
          else {
            try { this.armAfterContention(id, Date.now() + 1000, target, mode, contentionRetries + 1); }
            catch (failure) { this.hooks.onError(id, failure); }
          }
        } else this.handleTimingFailure(id, error);
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
    const preflight = this.preflightModel(job);
    if (!preflight) return;
    this.queue(job, { ...due, ...(job.runtime.continuation ? { source: "continuation" as const } : {}) }, this.nextCadence(job, now), preflight);
  }
  private queue(job: ResilientJob, due: TimedOccurrence, next?: Date, preflight?: PreflightToken, mode: RecoveryMode = false): void {
    const expectedRuntime = preflight ?? runtimeExpectation(job);
    const result = this.storage.queueResilient(job.id, job.session!, due, next?.toISOString(), Date.now(), expectedRuntime);
    if (result.status === "queued") this.hooks.onQueued(job.id);
    if (result.status === "ignored" && result.reason === "authorization-bound") return;
    const current = this.current(job.id);
    if (result.status === "ignored" && ["disabled-or-changed", "runtime-changed"].includes(result.reason ?? "")) {
      // The cadence target was computed from the rejected occurrence's
      // revision. Re-enter against the current definition instead of writing
      // that stale target into the newer revision, preserving restore mode.
      if (current) this.schedule(current, mode);
      return;
    }
    const currentPreflight = result.status === "ignored" ? undefined : current ? preflightToken(current) : undefined;
    if (next && current?.enabled && (current.runtime.slot.kind === "owned" || ["waiting", "backoff"].includes(current.runtime.slot.phase))) this.persistAndArm(current, next.getTime(), false, currentPreflight, mode);
  }
  private recoverableAttentionHold(job: ResilientJob | undefined): RecoveryMode | undefined {
    const slot = job?.runtime.slot;
    return slot?.kind === "idle" && slot.phase === "attention-required" && ["runtime_unavailable", "native_disposed", "native_model_route_unsupported", "native_model_unavailable"].includes(slot.reason ?? "") ? false : undefined;
  }

  private nextCadence(job: ResilientJob, after: number): Date | undefined {
    return job.policy.intervalMode === "fixed-delay" ? undefined : nextDue(timingView(job), after);
  }
}
