import type { CronJob, ExecutionReceipt } from "./types.js";

export type ReconciliationState =
  | "not-required"
  | "receipt-found"
  | "owner-live"
  | "pre-dispatch-releasable"
  | "unknown-needs-external-reconciliation";

export interface ScheduleJobStatus {
  id: string;
  name: string;
  type: CronJob["type"];
  enabled: boolean;
  operationalState: "enabled" | "disabled" | "disabled-unknown" | "blocked-unknown" | "quiet";
  lastStatus?: CronJob["lastStatus"];
  lastRun?: string;
  nextRun?: string;
  recordedNextRun?: string;
  expiresAt?: string;
  runCount: number;
  attemptCount?: number;
  waitingReason?: string;
  quietUntil?: string;
  claim?: {
    id: string;
    phase: NonNullable<CronJob["claim"]>["phase"];
    outcome?: NonNullable<CronJob["claim"]>["outcome"];
    outcomeReason?: NonNullable<CronJob["claim"]>["outcomeReason"];
    ownerAlive?: boolean;
    receiptOutcome?: ExecutionReceipt["outcome"];
  };
  followUp?: {
    state: NonNullable<CronJob["followUp"]>["state"];
    transportState?: NonNullable<CronJob["followUp"]>["transportState"];
    unknownReason?: string;
  };
  reconciliation: ReconciliationState;
  reconciliationReason?: string;
}

export interface JobStatusOptions {
  receiptByClaim?: ReadonlyMap<string, ExecutionReceipt>;
  ownerAlive?: (pid: number) => boolean;
  nextRun?: (jobId: string) => Date | null;
}

export const claimKey = (jobId: string, claimId: string, sessionId: string): string => `${sessionId}\u0000${jobId}\u0000${claimId}`;

/** Extract only bounded execution metadata; prompts and transcript bodies are ignored. */
export function receiptsByClaim(entries: readonly unknown[] | undefined): Map<string, ExecutionReceipt> {
  const result = new Map<string, ExecutionReceipt>();
  for (const entry of entries ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (candidate.type !== "custom" || candidate.customType !== "schedule_execution" || !candidate.data || typeof candidate.data !== "object") continue;
    const receipt = candidate.data as Partial<ExecutionReceipt>;
    if (typeof receipt.jobId !== "string" || typeof receipt.claimId !== "string" || typeof receipt.sessionId !== "string" || !["success", "error", "aborted", "unknown"].includes(receipt.outcome ?? "")) continue;
    result.set(claimKey(receipt.jobId, receipt.claimId, receipt.sessionId), receipt as ExecutionReceipt);
  }
  return result;
}

function defaultOwnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function unknownReason(job: CronJob): string {
  return job.followUp?.unknownReason
    ?? (job.claim?.outcomeReason === "deadline_exceeded" ? "Scheduled turn exceeded its hard elapsed deadline; inspect the exact claim and external evidence before any new attempt." : undefined)
    ?? (job.claim?.outcomeReason === "host_aborted" ? "The owning host aborted this turn; inspect the exact claim and external evidence before any new attempt." : undefined)
    ?? (job.claim?.outcomeReason === "user_stopped" ? "The owning session stopped this turn; inspect the exact claim and external evidence before any new attempt." : undefined)
    ?? job.waitingReason
    ?? "Execution outcome is unknown; inspect the exact claim and external evidence before any new attempt.";
}

export function summarizeJob(job: CronJob, options: JobStatusOptions = {}): ScheduleJobStatus {
  const ownerAlive = options.ownerAlive ?? defaultOwnerAlive;
  const candidate = job.claim ? options.receiptByClaim?.get(claimKey(job.id, job.claim.id, job.claim.sessionId)) : undefined;
  const receipt = candidate?.sessionId === job.session ? candidate : undefined;
  const nextRun = options.nextRun?.(job.id);
  const unresolvedClaim = job.claim?.phase === "settled" && ["unknown", "aborted"].includes(job.claim.outcome ?? "unknown");
  const operationalState = job.enabled
    ? (unresolvedClaim ? "blocked-unknown" : job.lastStatus === "quiet" ? "quiet" : "enabled")
    : (job.lastStatus === "unknown" || unresolvedClaim || job.followUp?.state === "unknown" ? "disabled-unknown" : "disabled");

  let reconciliation: ReconciliationState = "not-required";
  let reconciliationReason: string | undefined;
  if (receipt && ["success", "error"].includes(receipt.outcome)) {
    reconciliation = "receipt-found";
    reconciliationReason = "Exact native receipt found; reconcile the terminal store record, never replay the claim.";
  } else if (job.claim && job.claim.phase !== "settled") {
    if (ownerAlive(job.claim.ownerPid)) {
      reconciliation = "owner-live";
      reconciliationReason = "The claim owner is still live; do not take over or replay it.";
    } else if (job.claim.phase === "claimed") {
      reconciliation = "pre-dispatch-releasable";
      reconciliationReason = "The recorded owner is gone before dispatch; only this exact pre-dispatch intent may be reconciled.";
    } else {
      reconciliation = "unknown-needs-external-reconciliation";
      reconciliationReason = "Dispatch may already have had an effect and no exact receipt is available; inspect external evidence before any new attempt.";
    }
  } else if (receipt?.outcome === "unknown" || receipt?.outcome === "aborted" || job.lastStatus === "unknown" || job.claim?.outcome === "unknown" || job.followUp?.state === "unknown") {
    reconciliation = "unknown-needs-external-reconciliation";
    reconciliationReason = unknownReason(job);
  }

  return {
    id: job.id.slice(0, 128),
    name: job.name.slice(0, 128),
    type: job.type,
    enabled: job.enabled,
    operationalState,
    ...(job.lastStatus === undefined ? {} : { lastStatus: job.lastStatus }),
    ...(job.lastRun ? { lastRun: job.lastRun } : {}),
    ...(job.enabled && !unresolvedClaim && nextRun ? { nextRun: nextRun.toISOString() } : {}),
    ...(job.nextRun ? { recordedNextRun: job.nextRun } : {}),
    ...(job.expiresAt ? { expiresAt: job.expiresAt } : {}),
    runCount: job.runCount,
    ...(job.attemptCount === undefined ? {} : { attemptCount: job.attemptCount }),
    ...(job.waitingReason ? { waitingReason: job.waitingReason.slice(0, 128) } : {}),
    ...(job.quietUntil ? { quietUntil: job.quietUntil } : {}),
    ...(job.claim ? {
      claim: {
        id: job.claim.id,
        phase: job.claim.phase,
        ...(job.claim.outcome ? { outcome: job.claim.outcome } : {}),
        ...(job.claim.outcomeReason ? { outcomeReason: job.claim.outcomeReason } : {}),
        ...(job.claim.phase === "settled" ? {} : { ownerAlive: ownerAlive(job.claim.ownerPid) }),
        ...(receipt ? { receiptOutcome: receipt.outcome } : {}),
      },
    } : {}),
    ...(job.followUp ? {
      followUp: {
        state: job.followUp.state,
        ...(job.followUp.transportState ? { transportState: job.followUp.transportState } : {}),
        ...(job.followUp.unknownReason ? { unknownReason: job.followUp.unknownReason.slice(0, 256) } : {}),
      },
    } : {}),
    reconciliation,
    ...(reconciliationReason ? { reconciliationReason: reconciliationReason.slice(0, 256) } : {}),
  };
}

export function summarizeJobs(jobs: readonly CronJob[], options: JobStatusOptions = {}): ScheduleJobStatus[] {
  return jobs.map(job => summarizeJob(job, options));
}
