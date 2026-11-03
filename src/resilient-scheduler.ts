import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type NativeCapability, type NativeRunHandle, nativeCapability, sameNativeBinding } from "./native.js";
import { isResilient } from "./resilient-policy.js";
import { type CronStorage, ScheduleStoreBusyError } from "./storage.js";
import { cooldownNotBefore, misfire, nextDue, nextEligibleAfter, occurrence, timingView } from "./timing.js";
import type { CronJob, NativeCheckpointReference, NativeExecutionProof, OwnedAttempt, ResilientJob, TimedOccurrence } from "./types.js";

export interface ResilientSchedulerHooks {
  onQueued(jobId: string): void;
  onSettled(jobId: string): void;
  onChange(job: CronJob | undefined): void;
  onError(jobId: string, error: unknown): void;
}
interface TrackedRun { attempt: OwnedAttempt; handle: NativeRunHandle; projected?: string; }
const bindingFor = (jobId: string, attempt: OwnedAttempt): NativeExecutionProof["binding"] => ({ jobId, attemptId: attempt.id, ownerSessionId: attempt.nativeSessionId ?? attempt.owner.sessionId, ownerEpoch: attempt.owner.epoch, revision: attempt.revision });

/** Compose timers and the real native capability; legacy durable/model paths remain in CronScheduler. */
export class ResilientScheduling {
  private readonly instanceId = randomUUID();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly nextRuns = new Map<string, Date>();
  private readonly active = new Map<string, TrackedRun>();
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
  isOwned(id: string): boolean { return this.active.has(id); }
  snapshot(id: string) { return this.active.get(id)?.handle.snapshot(); }

  schedule(raw: CronJob, restoring = true): void {
    if (this.stopped || !isResilient(raw)) return;
    let job = raw;
    try {
      if (job.runtime.slot.kind === "owned") { this.restoreOwned(job); return; }
      if (!job.enabled) return;
      if (job.model) { this.hold(job, "native_model_route_unsupported"); return; }
      if (!this.capability()) { this.hold(job, "runtime_unavailable"); return; }
      if (job.runtime.slot.phase === "attention-required" && ["runtime_unavailable", "native_disposed"].includes(job.runtime.slot.reason ?? "")) {
        this.storage.setResilientDisposition(job.id, job.session!, { phase: "waiting" });
        job = this.current(job.id)!;
      }
      if (job.runtime.slot.kind !== "idle" || !["waiting", "backoff"].includes(job.runtime.slot.phase)) return;
      const now = Date.now();
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
    const capability = this.capability();
    if (!capability) { this.hold(job, "runtime_unavailable"); return; }
    if (job.model) { this.hold(job, "native_model_route_unsupported"); return; }
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
    const request = { binding: bindingFor(id, attempt), policy: { softDeadlineMs: attempt.workBudgetMs, hardDeadlineMs: attempt.deadlineMs, recoveryBudgetMs: 300_000 }, content: this.prompt(admitted) };
    let accepted: ReturnType<NativeCapability["start"]>;
    try { accepted = capability.start(request); }
    catch (error) { this.keepOwned(admitted, attempt, "native_start_failed", error); return; }
    if (!accepted.accepted) {
      try {
        const refunded = this.storage.refuseResilientNative(id, attempt.id, attempt.owner, accepted.reason);
        if (accepted.reason === "busy" && refunded) this.hooks.onQueued(id);
        this.hooks.onChange(this.current(id));
      } catch (error) { this.keepOwned(admitted, attempt, "native_refusal_persistence_failed", error); }
      return;
    }
    this.attach(admitted, attempt, accepted.handle);
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
    if (!run) return false;
    run.handle.checkpoint();
    return run.handle.requestDrain("operator_drain");
  }

  private capability(): NativeCapability | undefined { return nativeCapability(this.ctx); }
  private current(id: string): ResilientJob | undefined {
    const job = this.storage.getJob(id);
    return job && isResilient(job) ? job : undefined;
  }
  private prompt(job: ResilientJob): string {
    const checkpoint = job.runtime.continuation?.checkpoint;
    return !checkpoint ? job.prompt : `${job.prompt}\n\n[Native checkpoint continuation — not new authorization]\nConsume retained checkpoint ${checkpoint.entryId} from run ${checkpoint.runId} before the next slice. Reuse completed results; never replay previous or UNKNOWN effects. Preserve original scope, bounds and user intent.`;
  }

  private restoreOwned(job: ResilientJob): void {
    if (job.runtime.slot.kind !== "owned") return;
    const attempt = job.runtime.slot.attempt;
    const handle = this.capability()?.active;
    if (handle && sameNativeBinding(handle.snapshot().binding, bindingFor(job.id, attempt)) && (!attempt.nativeRunId || attempt.nativeRunId === handle.runId)) {
      this.attach(job, attempt, handle);
      if (job.enabled && job.policy.intervalMode !== "fixed-delay") {
        const next = nextEligibleAfter(job);
        if (next) this.persistAndArm(job, next.getTime());
      }
      return;
    }
    const entries = this.ctx.sessionManager.getEntries?.() ?? [];
    const receipt = entries.find(entry => entry.type === "custom" && entry.customType === "pi.scheduled-receipt.v1" && sameNativeBinding((entry.data as NativeExecutionProof)?.binding, bindingFor(job.id, attempt)) && (!attempt.nativeRunId || (entry.data as NativeExecutionProof).runId === attempt.nativeRunId));
    if (receipt?.type === "custom") { this.finish(job.id, attempt, receipt.data as NativeExecutionProof); return; }
    this.keepOwned(job, attempt, "native_owner_unconfirmed");
  }

  private attach(job: ResilientJob, attempt: OwnedAttempt, handle: NativeRunHandle): void {
    if (this.active.get(job.id)?.handle === handle) { this.armMonitor(); return; }
    try {
      const snapshot = handle.snapshot();
      if (snapshot.runId !== handle.runId || !sameNativeBinding(snapshot.binding, bindingFor(job.id, attempt))) throw new Error("Native handle returned a different accepted binding");
      if (!this.storage.bindResilientNative(job.id, attempt.id, attempt.owner, { runId: handle.runId, sessionId: snapshot.binding.ownerSessionId, startedAt: snapshot.startedAt, deadlineAt: snapshot.hardDeadlineAt })) throw new Error("Native handle could not bind its exact storage owner");
      this.active.set(job.id, { attempt: structuredClone(attempt), handle });
      void handle.settled.then(receipt => this.finish(job.id, attempt, receipt), error => this.keepOwned(job, attempt, "native_settlement_unknown", error));
      this.armMonitor();
    } catch (error) { this.keepOwned(job, attempt, "native_binding_failed", error); }
  }

  private checkpoint(receipt: NativeExecutionProof): { reference: NativeCheckpointReference; waitingReason?: string } {
    const entry = this.ctx.sessionManager.getEntry(receipt.checkpointEntryId);
    const data = entry?.type === "custom" && entry.customType === "pi.scheduled-checkpoint.v1" ? entry.data as { version: number; runId: string; binding: NativeExecutionProof["binding"]; declarations?: { waitingReason?: string } } : undefined;
    if (data?.version !== 1 || data.runId !== receipt.runId || !sameNativeBinding(data.binding, receipt.binding)) throw new Error("Exact native checkpoint unavailable; do not replay the run");
    const sessionFile = this.ctx.sessionManager.getSessionFile?.();
    return { reference: { sessionId: receipt.binding.ownerSessionId, entryId: receipt.checkpointEntryId, runId: receipt.runId, ...(sessionFile ? { sessionFile } : {}) }, waitingReason: data.declarations?.waitingReason };
  }

  private finish(id: string, attempt: OwnedAttempt, receipt: NativeExecutionProof & { reason?: string }): void {
    let before: ResilientJob | undefined;
    try {
      before = this.current(id);
      if (!before) return;
      const checkpoint = this.checkpoint(receipt);
      const input = receipt.reason === "user_input_required" || checkpoint.waitingReason === "user_input_required";
      const unknown = receipt.effectStatus === "unknown";
      const exhausted = !before.enabled || Date.parse(before.expiresAt!) <= Date.now() || before.attemptCount! >= before.maxRuns!;
      const phase = input ? "waiting-input" as const : unknown ? "reconciling" as const : exhausted ? "finished" as const : receipt.execution === "completed" ? "waiting" as const : receipt.execution === "deferred" ? "backoff" as const : "attention-required" as const;
      const notBefore = phase === "backoff" ? new Date(Math.max(Date.parse(cooldownNotBefore(Date.parse(receipt.finishedAt), before.runtime.cooldownStep + 1)), receipt.retryNotBefore ? Date.parse(receipt.retryNotBefore) : 0)).toISOString() : undefined;
      const committed = this.storage.settleResilient(id, attempt.id, attempt.owner, receipt, checkpoint.reference, { phase, reason: input ? "user_input_required" : receipt.reason, ...(notBefore ? { notBefore } : {}), ...(["waiting", "backoff"].includes(phase) && before.runtime.nextEligibleAt ? { nextEligibleAt: before.runtime.nextEligibleAt } : {}) });
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
            if (run.projected !== key) {
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
