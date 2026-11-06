import { type Static, Type } from "typebox";
import type { ScheduleJobStatus } from "./status.js";

const StringEnum = <T extends string>(values: T[], options?: { description?: string }) =>
  Type.Union(values.map((value) => Type.Literal(value)), options);

/**
 * Type of cron job
 */
export type CronJobType = "cron" | "once" | "interval" | "event";

export type IntervalMode = "fixed-delay" | "fixed-rate";
export type ResilientPolicy = {
  mode: "resilient";
  version: 1;
  intervalMode?: IntervalMode;
  timezone?: string;
  anchorAt: string;
  overlapPolicy: "skip" | "buffer-one";
  misfirePolicy: "skip" | "latest";
  latenessMs: number;
  workBudgetMs: number;
};
export type ExecutionPolicy = { mode: "legacy" } | ResilientPolicy;
export interface TimedOccurrence { id: string; dueAt: string; revision: number; source: "timer" | "overlap" | "misfire" | "continuation"; }
export interface AttemptOwner { sessionId: string; instanceId: string; epoch: number; }
export interface NativeCheckpointReference { sessionId: string; entryId: string; runId: string; sessionFile?: string; }
export interface OwnedAttempt {
  id: string;
  revision: number;
  owner: AttemptOwner;
  occurrence: TimedOccurrence;
  admittedAt: string;
  deadlineMs: number;
  workBudgetMs: number;
  /** Accepted explicit-model route, if any; later definition edits do not change this attempt. */
  model?: string;
  nativeSessionId?: string;
  /** Exact persistent child transcript reserved before native start; absent for inline work. */
  nativeSessionFile?: string;
  nativeRunId?: string;
  nativeStartedAt?: string;
  nativeDeadlineAt?: string;
  checkpoint?: NativeCheckpointReference;
}
export type ResilientIdlePhase = "waiting" | "backoff" | "reconciling" | "waiting-input" | "attention-required" | "finished";
export type ResilientSlot =
  | { kind: "idle"; phase: ResilientIdlePhase; reason?: string }
  | { kind: "owned"; phase: "running" | "draining" | "cancelling" | "attention-required"; attempt: OwnedAttempt; reason?: string };
export interface ResilientRuntime {
  /** Preserved pre-schema4 spending, never replenished by recovery or ownership transfer. */
  baselineAttempts: number;
  baselineDailyUsage?: { day: string; attempts: number };
  /** Preserved uncertainty is not cleared by a status/UI/enable update. */
  legacyUncertainty?: { status: "unknown" | "aborted"; claimId?: string };
  /** First whole-claim recovery checkpoint; pre-checkpoint ticks can never become new attempts. */
  legacyFutureAfter?: string;
  slot: ResilientSlot;
  ownerEpoch: number;
  missedCount: number;
  cooldownStep: number;
  pending?: TimedOccurrence;
  lastFinishedAt?: string;
  nextEligibleAt?: string;
  notBefore?: string;
  continuation?: { attemptId: string; checkpoint: NativeCheckpointReference; evidenceFingerprint?: string };
}
export type NativeExecutionOutcome = "completed" | "failed" | "deferred" | "cancelled" | "interrupted";
/** Forward-typed public Pi v1 metadata; never a model-supplied settlement or a second protocol. */
export interface NativeExecutionProof {
  version: 1;
  runId: string;
  binding: { jobId: string; attemptId: string; ownerSessionId: string; ownerEpoch: number; revision: number };
  finishedAt: string;
  execution: NativeExecutionOutcome;
  checkpointEntryId: string;
  effectStatus: "none-observed" | "unknown";
  businessOutcome: "unverified";
  failedRecoveryMs: number;
  retryNotBefore?: string;
}
/** Schedule-owned acknowledgement of the persistent child SDK/file writer, distinct from native loop settlement. */
export interface ModelSdkCloseProof {
  version: 1;
  runId: string;
  binding: NativeExecutionProof["binding"];
  checkpointEntryId: string;
  closedAt: string;
}
/** Final records are immutable; later evidence is appended to attemptResolutions instead. */
export interface AttemptRecord {
  /** False only for a proven native refusal before execution, or an imported legacy record already counted in the baseline. */
  charged: boolean;
  id: string;
  revision: number;
  owner: AttemptOwner;
  occurrence: TimedOccurrence;
  admittedAt: string;
  closedAt: string;
  outcome: NativeExecutionOutcome | "unknown" | "not-started";
  model?: string;
  reason?: string;
  nativeProof?: NativeExecutionProof;
  modelSdkClose?: ModelSdkCloseProof;
  checkpoint?: NativeCheckpointReference;
  effectStatus: "none-observed" | "unknown";
  businessOutcome: "unverified";
}
export interface AttemptResolution {
  attemptId: string;
  evidenceFingerprint: string;
  at: string;
  disposition: "continue" | "waiting-input" | "unknown" | "native-closure";
  /** Required for a preserved legacy claim resolution, which has no fabricated native checkpoint. */
  legacyClaimBinding?: string;
  checkpoint?: NativeCheckpointReference;
  safeScopes?: string[];
}
export interface StoreMigration {
  fromVersion: 1 | 2 | 3;
  at: string;
  originalSha256: string;
  backupRef: string;
}
export interface LegacyOwnerHandover {
  predecessorJobId: string;
  successorJobId: string;
  fromSessionId: string;
  toSessionId: string;
  claimId: string;
  claimBinding: string;
  recoveryEvidenceFingerprint: string;
  handoverEvidenceFingerprint: string;
  evidenceRef: string;
}


export interface GithubTrigger { repo: string; kind: "pull-request" | "pull-request-checks" | "workflow"; number?: number; branch?: string; pollSeconds?: number; }
export interface PendingEvent { revision: number; binding: string; keys: string[]; acceptedAt: string; evidenceFingerprint?: string; }
export type EventResult = { status: "queued" | "duplicate" | "ignored"; reason?: string };

export type ExecutionOutcome = "success" | "error" | "aborted" | "unknown";
export const EXECUTION_REASONS = ["deadline_exceeded", "host_aborted", "user_stopped", "claim_changed", "settlement_unknown", "owner_lost"] as const;
export type ExecutionReason = (typeof EXECUTION_REASONS)[number];
export type ProgressOutcome = "advanced" | "unchanged" | "unknown";
export interface DurableIntent { revision: number; binding: string; acceptedAt: string; }
export interface ExecutionClaim {
  id: string; sessionId: string; ownerPid: number; ownerId: string;
  binding: string; phase: "claimed" | "dispatched" | "started" | "settled";
  claimedAt: string; deadlineAt: string;
  outcome?: ExecutionOutcome; outcomeReason?: ExecutionReason;
}
export interface ExecutionReceipt {
  jobId: string;
  claimId: string;
  sessionId: string;
  outcome: ExecutionOutcome;
  reason?: ExecutionReason;
  progress?: ProgressOutcome;
  evidenceFingerprint?: string;
  waitingReason?: string;
}
export interface ExecutionNotice {
  claimId: string;
  outcome: ExecutionOutcome;
  reason?: ExecutionReason;
  state: "pending" | "accepted" | "failed";
  attempts: number;
}
export type FollowupState = "pending" | "dispatched" | "answered" | "cancelled" | "unknown";
export interface FollowupRecord {
  version: 1;
  ownerSessionId: string;
  intercomSessionId: string;
  peerSessionId: string;
  messageId: string;
  requestId: string;
  goal: string;
  phase: string;
  deadlineAt: string;
  intervalMs: number;
  maxRuns: number;
  expiresAt: string;
  state: FollowupState;
  createdAt: string;
  updatedAt: string;
  coveredBy?: string;
  lastReply?: { id: string; kind: "ack" | "pending" | "other"; at: string; text?: string };
  reminderMessageId?: string;
  transportState?: "delivered" | "unknown";
  unknownReason?: string;
}

/**
 * Status of the last job execution
 */
export type CronJobStatus = "success" | "error" | "running" | "queued" | "dispatched" | "unknown" | "skipped" | "quiet";

/**
 * A scheduled cron job
 */
export interface CronJob {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Cron expression, ISO timestamp, or interval description */
  schedule: string;
  /** The prompt to execute */
  prompt: string;
  /** User enablement intent for resilient jobs; legacy jobs retain their historical automatic-disable behavior. */
  enabled: boolean;
  /** Absence means legacy behavior. Incompatible resilient state is schema4 only. */
  policy?: ExecutionPolicy;
  runtime?: ResilientRuntime;
  attemptHistory?: AttemptRecord[];
  attemptResolutions?: AttemptResolution[];
  /** Proven legacy predecessor identities; original jobs/UNKNOWN claims remain retained. */
  legacyLineage?: string[];
  /** Explicit evidence for an owner/session takeover; never inferred from recovery metadata alone. */
  legacyHandovers?: LegacyOwnerHandover[];
  /** Type of job */
  type: CronJobType;
  /** Interval in milliseconds (for interval type) */
  intervalMs?: number;
  /** When the job was created */
  createdAt: string;
  /** Last execution timestamp */
  lastRun?: string;
  /** Status of last execution */
  lastStatus?: CronJobStatus;
  /** Next scheduled run (computed) */
  nextRun?: string;
  /** Inline dispatches or successful model runs; not business acceptance. */
  runCount: number;
  /** Admitted dispatch/model attempts, including failed attempts. */
  attemptCount?: number;
  /** Optional lifetime attempt limit. */
  maxRuns?: number;
  /** Optional absolute expiry; no new work is admitted at/after this time. */
  expiresAt?: string;
  /** UTC-calendar daily attempt cap; not an invoice cap. */
  maxRunsPerDay?: number;
  dailyUsage?: { day: string; attempts: number };
  revision?: number;
  pendingEvent?: PendingEvent;
  recentEventKeys?: string[];
  catchUp?: "none" | "latest";
  github?: GithubTrigger;
  sourceFingerprint?: string;
  /** Opt-in local durable execution, only for session-bound jobs. */
  durable?: boolean;
  deadlineMs?: number;
  pendingIntent?: DurableIntent;
  claim?: ExecutionClaim;
  consecutiveErrors?: number;
  notice?: ExecutionNotice;
  /** Future-only continuation; never rewrites the retained UNKNOWN claim. */
  recovery?: { claimId: string; successorJobId: string; evidenceFingerprint: string; resumedAt: string };
  /** Exact Intercom request binding for a finite, control-only follow-up. */
  followUp?: FollowupRecord;
  /** Optional bounded no-progress quieting; disabled by default for compatibility. */
  quietOnNoChange?: boolean;
  /** Number of consecutive unchanged evidence observations before quieting. */
  noChangeThreshold?: number;
  /** Quiet duration after the threshold is reached. */
  quietForMs?: number;
  /** Last evidence fingerprint reported by the owner. */
  lastEvidenceFingerprint?: string;
  /** Consecutive unchanged observations for the current fingerprint. */
  noChangeCount?: number;
  /** Human-readable bounded reason for waiting/quiet state. */
  waitingReason?: string;
  /** Until when automatic admission remains quiet. */
  quietUntil?: string;
  /** Optional description */
  description?: string;
  /** If set, run the prompt in a separate in-process agent session using this model instead of injecting into the current chat. */
  model?: string;
  /** Subagent jobs only. If true, the parent agent is woken up to react to the subagent's result. Default false (result lands in chat silently). */
  notify?: boolean;
  /** Subagent jobs only. If true, loads all registered extensions. If an array of package names, only those extensions. Default undefined (none). */
  extensions?: boolean | string[];
  /** Subagent jobs only. If true, loads all skills. If an array of skill names, only those skills. Default undefined (none). */
  skills?: boolean | string[];
  /** Session id this job is bound to. When absent, every pi in the cwd loads it. */
  session?: string;
}

/**
 * Persistent storage for cron jobs
 */
export interface CronStore {
  jobs: CronJob[];
  version: number;
  migration?: StoreMigration;
}

export type ResilientJob = CronJob & { policy: ResilientPolicy; runtime: ResilientRuntime; attemptHistory: AttemptRecord[]; attemptResolutions: AttemptResolution[] };

/**
 * Tool result details for LLM context
 */
export interface CronToolDetails {
  action: string;
  jobs: CronJob[];
  status?: ScheduleJobStatus[];
  truncated?: boolean;
  error?: string;
  jobId?: string;
  jobName?: string;
}

/**
 * Tool parameter schema
 */
export const CronToolParams = Type.Object({
  action: StringEnum(["add", "remove", "list", "status", "enable", "disable", "update", "cleanup", "trigger", "resume", "reconcile", "drain", "preview"], {
    description: "Action to perform",
  }),
  name: Type.Optional(
    Type.String({
      description: "Job name, auto-generated if omitted",
    })
  ),
  schedule: Type.Optional(
    Type.String({
      description:
        "Required for add. Cron expression, ISO timestamp, relative time (+10s, +5m), or interval string",
    })
  ),
  prompt: Type.Optional(
    Type.String({
      description: "Required for add. The prompt text to execute",
    })
  ),
  jobId: Type.Optional(
    Type.String({
      description: "Job ID for remove, enable, disable, or update actions",
    })
  ),
  type: Type.Optional(
    StringEnum(["cron", "once", "interval", "event"], {
      description: "Job type. Use 'once' for relative times like '+10s'. Default is cron",
    })
  ),
  description: Type.Optional(
    Type.String({
      description: "Optional job description",
    })
  ),
  mode: Type.Optional(StringEnum(["legacy", "resilient"], { description: "Explicit execution contract. Omission keeps legacy behavior; resilient is finite, session-bound recurring timing on native capability v1/schema4." })),
  intervalMode: Type.Optional(StringEnum(["fixed-delay", "fixed-rate"], { description: "Resilient intervals only. fixed-delay waits N after exact safe finish; fixed-rate keeps an anchored cadence. New resilient intervals default fixed-delay." })),
  timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Resilient cron effective IANA timezone, persisted so process timezone changes do not alter the schedule." })),
  overlapPolicy: Type.Optional(StringEnum(["skip", "buffer-one"], { description: "Resilient overlap policy; default skip. buffer-one retains the first waiting occurrence, never an unbounded backlog. Fixed-delay arms only after closure." })),
  misfirePolicy: Type.Optional(StringEnum(["skip", "latest"], { description: "Resilient restart/sleep policy; default skip. latest admits at most one fresh missed occurrence, distinct from live overlap." })),
  latenessMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400000, description: "Resilient occurrence freshness window, independent of cadence and execution budgets; default 300000." })),
  workBudgetMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400000, description: "Resilient soft work/drain target, strictly below deadlineMs; never a cadence timeout or a renewed authority." })),
  attemptId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Required for reconcile: exact finalized resilient attempt id/checkpoint. Native/SDK resource closure must already be acknowledged." })),
  resolution: Type.Optional(StringEnum(["continue", "waiting-input", "unknown"], { description: "Required for reconcile. Records the owning operator's verified evidence, not business success or new authorization." })),
  safeScopes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" }), { maxItems: 32, description: "Optional bounded scopes of reconciliation evidence; scoped evidence does not release the whole job's conflicting writes." })),
  claimId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Exact settled UNKNOWN/aborted legacy claim ID for resume or migrated-legacy reconcile; never a native attempt alias." })),
  claimBinding: Type.Optional(Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$", description: "Required with claimId for migrated-legacy reconcile: exact retained claim binding. External effect evidence is separate." })),
  evidenceFingerprint: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$", description: "Optional for trigger: SHA-256 of the selected evidence, enabling configured no-change quieting. Required for resume/reconcile: reconciled checkpoint/effect evidence; never replay or mark an old claim successful." })),
  eventName: Type.Optional(Type.String({ description: "Required for trigger. Must match the existing event job schedule." })),
  eventId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Required for trigger; stable producer id, never prompt text." })),
  maxRunsPerDay: Type.Optional(Type.Integer({ minimum: 1, description: "UTC daily admitted-attempt limit." })),
  catchUp: Type.Optional(StringEnum(["none", "latest"], { description: "Missed event/durable timer policy; default none." })),
  durable: Type.Optional(Type.Boolean({ description: "Opt-in durable claims; requires session binding. Unknown execution pauses, never blindly retries." })),
  deadlineMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 86400000, description: "Durable run elapsed deadline; default 600000. Abort is not rollback." })),
  quietOnNoChange: Type.Optional(Type.Boolean({ description: "Event/evidence jobs only. Quiet after repeated unchanged fingerprints; default false." })),
  noChangeThreshold: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Consecutive unchanged evidence observations before quieting; default 2." })),
  quietForMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 86400000, description: "Quiet duration after no-change threshold; default 3600000." })),
  github: Type.Optional(Type.Object({ repo: Type.String(), kind: StringEnum(["pull-request", "pull-request-checks", "workflow"]), number: Type.Optional(Type.Integer({ minimum: 1 })), branch: Type.Optional(Type.String()), pollSeconds: Type.Optional(Type.Integer({ minimum: 60, maximum: 3600 })) })),
  maxRuns: Type.Optional(Type.Integer({ minimum: 1, description: "Lifetime dispatch/attempt limit, not a token or invoice cap." })),
  expiresAt: Type.Optional(Type.String({ description: "Absolute ISO expiry. New fires stop at this time." })),
  model: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Optional. If set, runs the prompt in a separate in-process agent session using this model (e.g. 'haiku', 'sonnet', or 'provider/model-id'). The scheduler resolves it against currently available authenticated models and persists the canonical provider/model-id route; unknown or ambiguous ids are rejected before saving. If omitted, the prompt is injected into the current chat. Must be a non-empty string — to switch a job from subagent back to inline mode, remove the job and re-add it without a model.",
    })
  ),
  notify: Type.Optional(
    Type.Boolean({
      description:
        "Subagent jobs only. If true, the parent agent is nudged to react to the subagent's result. Default false: the result is shown in chat but the parent is not interrupted. Ignored for inline (no-model) jobs, where the prompt itself already wakes the parent. Recommended only for low-frequency jobs.",
    })
  ),
  extensions: Type.Optional(
    Type.Union([
      Type.Boolean({
        description: "If true, loads all registered extensions.",
      }),
      Type.Array(Type.String(), {
        description: "List of extension package names to load.",
      }),
    ])
  ),
  skills: Type.Optional(
    Type.Union([
      Type.Boolean({
        description: "If true, loads all skills.",
      }),
      Type.Array(Type.String(), {
        description: "List of skill names to load.",
      }),
    ])
  ),
});

export type CronToolParamsType = Static<typeof CronToolParams>;

/**
 * Event emitted when a job is added, removed, or updated
 */
export interface CronChangeEvent {
  type: "add" | "remove" | "update" | "fire" | "error";
  job?: CronJob;
  jobId?: string;
  error?: string;
}
