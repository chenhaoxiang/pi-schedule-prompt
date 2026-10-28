import { createHash } from "node:crypto";
import type { CronJob } from "./types.js";

export const FOLLOWUP_SCHEDULE_EVENT = "schedule:reply-followup:v1";
export const FOLLOWUP_DUE_EVENT = "schedule:reply-followup-due:v1";
export const FOLLOWUP_CANCEL_TRANSPORT_EVENT = "schedule:reply-followup-cancel-transport:v1";
export const FOLLOWUP_OBSERVED_EVENT = "intercom:followup-observed:v1";

export type FollowupState = "pending" | "dispatched" | "answered" | "cancelled" | "unknown";
export type FollowupReplyKind = "ack" | "pending" | "other";

export interface FollowupBinding {
  ownerSessionId: string;
  intercomSessionId: string;
  peerSessionId: string;
  messageId: string;
}
export interface FollowupOptions {
  requestId: string;
  goal: string;
  phase: string;
  deadlineAt: string;
  intervalMs: number;
  maxRuns: number;
  expiresAt: string;
  coveredBy?: string;
}
export interface FollowupRecord extends FollowupBinding {
  version: 1;
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
  lastReply?: { id: string; kind: FollowupReplyKind; at: string; text?: string };
  reminderMessageId?: string;
  transportState?: "delivered" | "unknown";
  unknownReason?: string;
}

export interface FollowupCancelTransportRequest {
  version: 1;
  ownerSessionId: string;
  intercomSessionId: string;
  peerSessionId: string;
  originalMessageId: string;
  reminderMessageId: string;
}

export interface FollowupDueRequest {
  version: 1;
  binding: FollowupBinding;
  record: FollowupRecord;
  jobId: string;
  claimId: string;
  claim(): void;
  isCurrent(): boolean;
  respond(result: { delivered: boolean; messageId?: string; reason?: string; unknown?: boolean }): void;
}

export interface FollowupScheduleRequest {
  version: 1;
  action: "create" | "get" | "cancel";
  binding: FollowupBinding;
  options?: FollowupOptions;
  claim(): void;
  respond(result: { ok: boolean; jobId?: string; created?: boolean; state?: FollowupState; enabled?: boolean; pending?: boolean; reason?: string; completion?: "unknown" }): void;
}
export interface FollowupObservation {
  version: 1;
  kind: "reply" | "disconnected";
  ownerSessionId: string;
  intercomSessionId: string;
  peerSessionId?: string;
  messageId?: string;
  replyTo?: string;
  text?: string;
  at: number;
}

export function followupKey(binding: Pick<FollowupBinding, "ownerSessionId" | "intercomSessionId" | "peerSessionId" | "messageId">): string {
  return createHash("sha256").update(JSON.stringify([
    binding.ownerSessionId,
    binding.intercomSessionId,
    binding.peerSessionId,
    binding.messageId,
  ])).digest("hex");
}

export function followupName(binding: FollowupBinding): string {
  return `reply-followup-${followupKey(binding).slice(0, 16)}`;
}

export function isFollowupFor(job: CronJob, binding: FollowupBinding): boolean {
  const record = job.followUp;
  return !!record && record.version === 1
    && record.ownerSessionId === binding.ownerSessionId
    && record.intercomSessionId === binding.intercomSessionId
    && record.peerSessionId === binding.peerSessionId
    && record.messageId === binding.messageId;
}

export function isFollowupActive(job: CronJob): boolean {
  return !!job.followUp && ["pending", "dispatched"].includes(job.followUp.state) && job.enabled;
}

export function followupPrompt(record: Pick<FollowupRecord, "intercomSessionId" | "messageId" | "requestId" | "goal" | "phase">): string {
  return [
    "[Bounded Intercom status check — NOT a replay or new business authorization]",
    `Original session: ${record.intercomSessionId}`,
    `Original messageId: ${record.messageId}`,
    `Request: ${record.requestId}; phase: ${record.phase}`,
    `Goal reference: ${JSON.stringify(record.goal)}`,
    "Query current transport/receiver/execution evidence for this exact request before contacting the peer.",
    "Do not repeat the original business action, create a replacement executor, or infer failure from silence.",
    "ACK/PENDING closes only the reply-wait; it is not business completion. If still pending, create a separate next-checkpoint reminder with a new phase binding.",
  ].join("\n");
}

export function classifyFollowupReply(text: string): FollowupReplyKind {
  const normalized = text.trim().toLowerCase();
  if (/^(ack|acked|acknowledged|收到|已收到)(?:[\s.!，。]|$)/i.test(normalized)) return "ack";
  if (/\bpending\b|\bqueued\b|\bworking\b|处理中|进行中|等待/.test(normalized)) return "pending";
  return "other";
}

export function validateFollowupBinding(binding: FollowupBinding): void {
  for (const [name, value] of Object.entries(binding)) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`Follow-up ${name} must be a non-empty string`);
  }
}

export function validateFollowupOptions(options: FollowupOptions, now = Date.now()): void {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1000 || options.intervalMs > 86400000) throw new Error("Follow-up intervalMs must be 1000–86400000");
  if (!Number.isSafeInteger(options.maxRuns) || options.maxRuns !== 1) throw new Error("Follow-up maxRuns must be exactly 1; create a new phase binding for another checkpoint");
  if (!Number.isFinite(Date.parse(options.deadlineAt)) || Date.parse(options.deadlineAt) <= now) throw new Error("Follow-up deadlineAt must be a future timestamp");
  if (!Number.isFinite(Date.parse(options.expiresAt)) || Date.parse(options.expiresAt) <= now) throw new Error("Follow-up expiresAt must be a future timestamp");
  if (Date.parse(options.expiresAt) < Date.parse(options.deadlineAt)) throw new Error("Follow-up expiresAt must not precede deadlineAt");
  for (const [name, value] of [["requestId", options.requestId], ["goal", options.goal], ["phase", options.phase]] as const) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`Follow-up ${name} must be a non-empty string`);
  }
}
