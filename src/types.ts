import { type Static, Type } from "@earendil-works/pi-ai";

const StringEnum = <T extends string>(values: T[], options?: { description?: string }) =>
  Type.Union(values.map((value) => Type.Literal(value)), options);

/**
 * Type of cron job
 */
export type CronJobType = "cron" | "once" | "interval" | "event";

export interface GithubTrigger { repo: string; kind: "pull-request" | "workflow"; number?: number; branch?: string; pollSeconds?: number; }
export interface PendingEvent { revision: number; binding: string; keys: string[]; acceptedAt: string; evidenceFingerprint?: string; }
export type EventResult = { status: "queued" | "duplicate" | "ignored"; reason?: string };

export type ExecutionOutcome = "success" | "error" | "aborted" | "unknown";
export type ProgressOutcome = "advanced" | "unchanged" | "unknown";
export interface DurableIntent { revision: number; binding: string; acceptedAt: string; }
export interface ExecutionClaim {
  id: string; sessionId: string; ownerPid: number; ownerId: string;
  binding: string; phase: "claimed" | "dispatched" | "started" | "settled";
  claimedAt: string; deadlineAt: string; outcome?: ExecutionOutcome;
}
export interface ExecutionReceipt {
  jobId: string;
  claimId: string;
  sessionId: string;
  outcome: ExecutionOutcome;
  progress?: ProgressOutcome;
  evidenceFingerprint?: string;
  waitingReason?: string;
}
export interface ExecutionNotice { claimId: string; outcome: ExecutionOutcome; state: "pending" | "accepted" | "failed"; attempts: number; }
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
  /** Whether the job is enabled */
  enabled: boolean;
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
}

/**
 * Tool result details for LLM context
 */
export interface CronToolDetails {
  action: string;
  jobs: CronJob[];
  error?: string;
  jobId?: string;
  jobName?: string;
}

/**
 * Tool parameter schema
 */
export const CronToolParams = Type.Object({
  action: StringEnum(["add", "remove", "list", "enable", "disable", "update", "cleanup", "trigger"], {
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
  eventName: Type.Optional(Type.String({ description: "Required for trigger. Must match the existing event job schedule." })),
  eventId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Required for trigger; stable producer id, never prompt text." })),
  maxRunsPerDay: Type.Optional(Type.Integer({ minimum: 1, description: "UTC daily admitted-attempt limit." })),
  catchUp: Type.Optional(StringEnum(["none", "latest"], { description: "Missed event/durable timer policy; default none." })),
  durable: Type.Optional(Type.Boolean({ description: "Opt-in durable claims; requires session binding. Unknown execution pauses, never blindly retries." })),
  deadlineMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 86400000, description: "Durable run elapsed deadline; default 600000. Abort is not rollback." })),
  quietOnNoChange: Type.Optional(Type.Boolean({ description: "Event/evidence jobs only. Quiet after repeated unchanged fingerprints; default false." })),
  noChangeThreshold: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Consecutive unchanged evidence observations before quieting; default 2." })),
  quietForMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 86400000, description: "Quiet duration after no-change threshold; default 3600000." })),
  github: Type.Optional(Type.Object({ repo: Type.String(), kind: StringEnum(["pull-request", "workflow"]), number: Type.Optional(Type.Integer({ minimum: 1 })), branch: Type.Optional(Type.String()), pollSeconds: Type.Optional(Type.Integer({ minimum: 60, maximum: 3600 })) })),
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
