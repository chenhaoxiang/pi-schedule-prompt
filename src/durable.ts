import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { eventBinding } from "./events.js";
import type { CronStorage } from "./storage.js";
import type { CronJob, ExecutionOutcome, ExecutionReason, ExecutionReceipt } from "./types.js";

export const RECEIPT_TYPE = "schedule_execution";

/** Reserve at most five minutes INSIDE the existing deadline, never extend it. */
export function turnBudget(job: CronJob): { softDeadlineAt: string; deadlineAt: string } | undefined {
  if (!job.claim || job.model || job.followUp) return;
  const hardDeadline = Date.parse(job.claim.deadlineAt);
  const duration = hardDeadline - Date.parse(job.claim.claimedAt);
  const reserve = Math.min(300_000, Math.max(1, Math.floor(duration / 3)));
  return {
    softDeadlineAt: new Date(hardDeadline - reserve).toISOString(),
    deadlineAt: job.claim.deadlineAt,
  };
}

export function budgetPrompt(job: CronJob): string {
  const budget = turnBudget(job);
  if (!budget) return "";
  return `\n\n[Native scheduled-round budget — not additional authorization]\nJob: ${job.id}; claim: ${job.claim!.id}. Current UTC: ${new Date().toISOString()}.\nStop new business work by ${budget.softDeadlineAt}; hard abort at ${budget.deadlineAt}. The hard deadline is total elapsed time, NOT idle time, and progress does not extend it. Save checkpoints as you go. During the finalization reserve use only direct read/write/edit/todo for local checkpointing, then end with a concise final response. Do not launch another slice, long validation, external submission, bash/codemode wrapper or question while winding down. Preserve completed artifacts and unknown effects; later rounds consume checkpoints, never replay unknown actions. Normal round settlement is not business completion.`;
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** One native execution envelope, not a child runner or business completion ledger. */
export class DurableExecution {
  readonly ownerId = randomUUID();
  private active?: { job: CronJob; started: boolean; stopReason?: string; deadline: NodeJS.Timeout; softDeadline?: NodeJS.Timeout; softDeadlineAt?: string; windingDown?: boolean; abort?: () => void };
  private progress?: { progress: "advanced" | "unchanged" | "unknown"; evidenceFingerprint: string; waitingReason?: string };
  private sessionId: string;
  private heldClaim?: { id: string; started: boolean; model: boolean };
  private turnClaimId?: string;
  private inputRequired = false;
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
      if (latest.catchUp !== "latest" || latest.pendingIntent?.binding !== eventBinding(latest)) this.storage.updateJob(job.id, { pendingIntent: undefined });
    }
    this.flushNotices();
  }

  busy(): boolean { return !!this.active || !!this.heldClaim; }
  activeClaimId(): string | undefined { return this.active?.job.claim?.id; }
  release(claimId: string): void { if (this.heldClaim?.id === claimId) this.heldClaim = undefined; }

  private windDown(): void {
    const active = this.active;
    if (!active || active.windingDown) return;
    active.windingDown = true;
    try { this.pi.appendEntry("schedule_wind_down", { jobId: active.job.id, claimId: active.job.claim!.id, sessionId: this.sessionId, softDeadlineAt: active.softDeadlineAt, deadlineAt: active.job.claim!.deadlineAt }); }
    catch { console.error("[pi-schedule-prompt] Wind-down metadata unavailable"); }
  }

  blockTool(toolName: string): { block: true; reason: string } | undefined {
    const active = this.active;
    if (!active?.started || !active.softDeadlineAt || this.turnClaimId !== active.job.claim?.id) return;
    if (!active.windingDown && Date.now() < Date.parse(active.softDeadlineAt)) return;
    this.windDown();
    if (["read", "write", "edit", "todo"].includes(toolName)) return;
    return { block: true, reason: `Scheduled-round finalization reserve: ${toolName} was NOT executed. Hard deadline ${active.job.claim!.deadlineAt} is unchanged. Use direct read/write/edit/todo only to save a LOCAL checkpoint, then give a concise final response now. Do not retry or wrap this operation; completed or UNKNOWN external effects must not be replayed.` };
  }

  recordProgress(progress: { jobId: string; claimId: string; progress: "advanced" | "unchanged" | "unknown"; evidenceFingerprint: string; waitingReason?: string }): boolean {
    if (!this.active?.job.claim || this.active.job.id !== progress.jobId || this.active.job.claim.id !== progress.claimId) return false;
    this.progress = { progress: progress.progress, evidenceFingerprint: progress.evidenceFingerprint, ...(progress.waitingReason === undefined ? {} : { waitingReason: progress.waitingReason }) };
    return true;
  }

  begin(id: string): CronJob | undefined {
    if (this.busy()) return;
    this.flushNotices();
    const job = this.storage.claimJob(id, this.sessionId, this.ownerId);
    if (!job?.claim) return;
    const budget = turnBudget(job);
    const deadline = setTimeout(() => {
      const current = this.active;
      if (!current || current.job.claim?.id !== job.claim?.id) return;
      this.heldClaim = { id: job.claim!.id, started: current.started, model: !!job.model };
      current.abort?.();
      // A previous accepted turn is not permission to abort a different user turn.
      if (!job.model && current.started && this.turnClaimId === job.claim!.id) this.ctx.abort();
      this.finish("unknown", "deadline_exceeded");
    }, Math.max(1, Date.parse(job.claim.deadlineAt) - Date.now()));
    deadline.unref?.();
    this.active = { job, started: false, deadline };

    if (budget) {
      this.active.softDeadlineAt = budget.softDeadlineAt;
      this.active.softDeadline = setTimeout(() => { if (this.active?.job.claim?.id === job.claim?.id) this.windDown(); }, Math.max(1, Date.parse(budget.softDeadlineAt) - Date.now()));
      this.active.softDeadline.unref?.();
    }
    try {
      if (!this.storage.markClaim(job.id, job.claim.id, "dispatched")) throw new Error("Claim changed before dispatch");
    } catch (error) { this.finish("unknown", "claim_changed"); throw error; }
    return job;
  }

  setAbort(claimId: string, abort: () => void): void { if (this.active?.job.claim?.id === claimId) this.active.abort = abort; }

  started(claimId: unknown): void {
    this.turnClaimId = typeof claimId === "string" ? claimId : undefined;
    if (this.heldClaim && this.heldClaim.id === claimId && !this.heldClaim.model) { this.heldClaim.started = true; this.ctx.abort(); return; }
    const current = this.active;
    if (!current || current.job.claim?.id !== claimId) return;
    current.started = true;
    try { this.storage.markClaim(current.job.id, current.job.claim!.id, "started"); }
    catch { this.ctx.abort(); this.finish("unknown", "claim_changed"); }
  }

  deferInput(toolCallId: string): boolean {
    const current = this.active;
    if (!current?.started || current.job.model || this.turnClaimId !== current.job.claim?.id) return false;
    if (!this.inputRequired) {
      this.inputRequired = true;
      try { this.pi.appendEntry("schedule_input_required", { jobId: current.job.id, claimId: current.job.claim!.id, sessionId: this.sessionId, toolCallId }); }
      catch { console.error("[pi-schedule-prompt] Input blocker metadata unavailable; question remains deferred"); }
    }
    return true;
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
    const wasAborted = aborted || this.active.stopReason === "aborted";
    const outcome = wasAborted ? "aborted" : ["error", "length"].includes(this.active.stopReason ?? "") ? "error" : this.active.stopReason === "stop" ? "success" : "unknown";
    this.finish(outcome, wasAborted ? "host_aborted" : outcome === "unknown" ? "settlement_unknown" : undefined);
  }

  finish(outcome: ExecutionOutcome, reason?: ExecutionReason): void {
    const active = this.active;
    if (!active?.job.claim) return;
    clearTimeout(active.deadline);
    if (active.softDeadline) clearTimeout(active.softDeadline);
    const receipt: ExecutionReceipt = { jobId: active.job.id, claimId: active.job.claim.id, sessionId: this.sessionId, outcome, ...(reason ? { reason } : {}), ...(this.progress ?? {}), ...(this.inputRequired ? { waitingReason: "user_input_required" } : {}) };
    this.progress = undefined;
    this.inputRequired = false;
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
    if (this.active.started && !this.active.job.model && this.turnClaimId === this.active.job.claim!.id) this.ctx.abort();
    this.finish("unknown", "user_stopped");
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
          try { this.ctx.ui.notify(`Scheduled execution ${notice.outcome}: ${job.id}; claim ${notice.claimId}; reason ${notice.reason ?? "not-recorded"}; inspect exact claim`, "warning"); }
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
