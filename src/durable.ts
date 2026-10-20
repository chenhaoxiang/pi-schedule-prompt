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
  private sessionId: string;
  private heldClaim?: string;
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
  release(claimId: string): void { if (this.heldClaim === claimId) this.heldClaim = undefined; }
  begin(id: string): CronJob | undefined {
    if (this.busy()) return;
    this.flushNotices();
    const job = this.storage.claimJob(id, this.sessionId, this.ownerId);
    if (!job?.claim) return;
    const deadline = setTimeout(() => {
      const current = this.active;
      if (!current || current.job.claim?.id !== job.claim?.id) return;
      // Never abort an unrelated host turn if our custom message never started.
      this.heldClaim = job.claim?.id;
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
    if (!this.active) { this.heldClaim = undefined; return; }
    if (!this.active.started || this.active.job.model) return;
    this.finish(aborted ? "aborted" : this.active.stopReason === "error" ? "error"
      : this.active.stopReason === "stop" ? "success" : "unknown");
  }

  finish(outcome: ExecutionOutcome): void {
    const active = this.active;
    if (!active?.job.claim) return;
    clearTimeout(active.deadline);
    const receipt: ExecutionReceipt = { jobId: active.job.id, claimId: active.job.claim.id, sessionId: this.sessionId, outcome };
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
        if (notice.outcome !== "success") {
          if (!this.ctx.hasUI) throw new Error("No local notice sink");
          this.ctx.ui.notify(`Scheduled execution ${notice.outcome}: ${job.id}; inspect exact claim`, "warning");
        }
        accepted = true;
      } catch { console.error("[pi-schedule-prompt] Execution notice delivery failed; execution will not be replayed"); }
      try { this.storage.recordNotice(job.id, notice.claimId, accepted); }
      catch { console.error("[pi-schedule-prompt] Notification receipt not persisted"); }
    }
  }
}
