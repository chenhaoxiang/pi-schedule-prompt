import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { eventBinding } from "./events.js";
import type { CronStorage } from "./storage.js";
import type { CronJob, ExecutionOutcome, ExecutionReceipt } from "./types.js";

export const RECEIPT_TYPE = "schedule_execution";
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** One native execution envelope, not a child runner or business completion ledger. */
export class DurableExecution {
  readonly ownerId = randomUUID();
  private active?: { job: CronJob; started: boolean; stopReason?: string; deadline: NodeJS.Timeout; abort?: () => void };
  private progress?: { progress: "advanced" | "unchanged" | "unknown"; evidenceFingerprint: string; waitingReason?: string };
  private sessionId: string;
  private heldClaim?: { id: string; started: boolean; model: boolean };
  private turnClaimId?: string;
  constructor(private storage: CronStorage, private pi: ExtensionAPI, private ctx: ExtensionContext) {
    this.sessionId = ctx.sessionManager.getSessionId() ?? "";
  }

  restore(): void {
    const receipts = (this.ctx.sessionManager.getEntries?.() ?? [])
      .filter(entry => entry.type === "custom" && entry.customType === RECEIPT_TYPE)
      .map(entry => (entry as { data: ExecutionReceipt }).data)
      .filter(data => data && data.sessionId === this.sessionId && ["success", "error", "aborted", "unknown"].includes(data.outcome));
    for (const job of this.storage.getAllJobs()) {
      if (!job.durable || job.session !== this.sessionId) continue;
      this.storage.reconcileJob(job.id, this.sessionId, this.ownerId, receipts, processAlive);
      const latest = this.storage.getJob(job.id)!;
      if (latest.catchUp !== "latest" || latest.pendingIntent?.binding !== eventBinding(latest)) {
        this.storage.updateJob(job.id, { pendingIntent: undefined });
      }
    }
    this.flushNotices();
  }

  busy(): boolean { return !!this.active || !!this.heldClaim; }
  activeClaimId(): string | undefined { return this.active?.job.claim?.id; }
  release(claimId: string): void { if (this.heldClaim?.id === claimId) this.heldClaim = undefined; }
  recordProgress(progress: { jobId: string; claimId: string; progress: "advanced" | "unchanged" | "unknown"; evidenceFingerprint: string; waitingReason?: string }): boolean {
    if (!this.active?.job.claim || this.active.job.id !== progress.jobId || this.active.job.claim.id !== progress.claimId) return false;
    this.progress = {
      progress: progress.progress,
      evidenceFingerprint: progress.evidenceFingerprint,
      ...(progress.waitingReason === undefined ? {} : { waitingReason: progress.waitingReason }),
    };
    return true;
  }
  begin(id: string): CronJob | undefined {
    if (this.busy()) return;
    this.flushNotices();
    const job = this.storage.claimJob(id, this.sessionId, this.ownerId);
    if (!job?.claim) return;
    const deadline = setTimeout(() => {
      const current = this.active;
      if (!current || current.job.claim?.id !== job.claim?.id) return;
      // Never abort an unrelated host turn if our custom message never started.
      this.heldClaim = { id: job.claim!.id, started: current.started, model: !!job.model };
      current.abort?.();
      if (!job.model && current.started) this.ctx.abort();
      this.finish("unknown");
    }, Math.max(1, Date.parse(job.claim.deadlineAt) - Date.now()));
    deadline.unref?.();
    this.active = { job, started: false, deadline };
    try {
      if (!this.storage.markClaim(job.id, job.claim.id, "dispatched")) throw new Error("Claim changed before dispatch");
    } catch (error) { this.finish("unknown"); throw error; }
    return job;
  }

  setAbort(claimId: string, abort: () => void): void {
    if (this.active?.job.claim?.id === claimId) this.active.abort = abort;
  }

  started(claimId: unknown): void {
    this.turnClaimId = typeof claimId === "string" ? claimId : undefined;
    if (this.heldClaim && this.heldClaim.id === claimId && !this.heldClaim.model) {
      this.heldClaim.started = true;
      this.ctx.abort(); // An already accepted but late-starting timed-out custom turn is not a new attempt.
      return;
    }
    const current = this.active;
    if (!current || current.job.claim?.id !== claimId) return;
    current.started = true;
    try { this.storage.markClaim(current.job.id, current.job.claim!.id, "started"); }
    catch { this.ctx.abort(); this.finish("unknown"); }
  }

  messageEnd(message: { role: string; stopReason?: string }): void {
    if (this.active?.started && !this.active.job.model && message.role === "assistant") this.active.stopReason = message.stopReason;
  }

  settled(aborted: boolean): void {
    if (!this.active) {
      if (this.heldClaim?.started && !this.heldClaim.model && this.turnClaimId === this.heldClaim.id) this.heldClaim = undefined;
      this.turnClaimId = undefined;
      return;
    }
    if (!this.active.started || this.active.job.model || this.turnClaimId !== this.active.job.claim?.id) return;
    this.finish(aborted || this.active.stopReason === "aborted" ? "aborted" : ["error", "length"].includes(this.active.stopReason ?? "") ? "error"
      : this.active.stopReason === "stop" ? "success" : "unknown");
  }

  finish(outcome: ExecutionOutcome): void {
    const active = this.active;
    if (!active?.job.claim) return;
    clearTimeout(active.deadline);
    const receipt: ExecutionReceipt = {
      jobId: active.job.id,
      claimId: active.job.claim.id,
      sessionId: this.sessionId,
      outcome,
      ...(this.progress ?? {}),
    };
    this.progress = undefined;
    // Receipt-first lets a later store write failure reconcile without replay.
    try { this.pi.appendEntry(RECEIPT_TYPE, receipt); }
    catch { console.error("[pi-schedule-prompt] Native execution receipt unavailable"); }
    try { this.storage.settleClaim(receipt); }
    catch { console.error("[pi-schedule-prompt] Execution outcome not committed; retained claim requires reconciliation"); }
    this.active = undefined;
    this.flushNotices();
  }

  stop(): void {
    if (!this.active) return;
    this.heldClaim = { id: this.active.job.claim!.id, started: this.active.started, model: !!this.active.job.model };
    this.active.abort?.();
    if (this.active.started && !this.active.job.model) this.ctx.abort();
    this.finish("unknown");
  }

  flushNotices(): void {
    for (const job of this.storage.getAllJobs()) {
      const notice = job.notice;
      if (!job.durable || job.session !== this.sessionId || !notice || notice.state === "accepted" || notice.attempts >= 3) continue;
      let accepted = false;
      try {
        this.pi.events.emit("schedule:execution", { version: 1, jobId: job.id, ...notice });
        accepted = true;
        if (notice.outcome !== "success" && this.ctx.hasUI) {
          try { this.ctx.ui.notify(`Scheduled execution ${notice.outcome}: ${job.id}; inspect exact claim`, "warning"); }
          catch { console.error("[pi-schedule-prompt] Supplementary UI notice unavailable; local event acceptance is unchanged"); }
        }
      } catch { console.error("[pi-schedule-prompt] Execution notice delivery failed; execution will not be replayed"); }
      try {
        this.storage.recordNotice(job.id, notice.claimId, accepted);
        this.pi.appendEntry("schedule_notice", { jobId: job.id, claimId: notice.claimId, state: accepted ? "accepted" : "failed", attempts: notice.attempts + 1 });
      } catch { console.error("[pi-schedule-prompt] Notification receipt not persisted"); }
    }
  }
}
