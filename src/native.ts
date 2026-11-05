import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NativeExecutionProof } from "./types.js";

export type NativeSessionReader = Pick<ExtensionContext["sessionManager"], "getSessionId" | "getSessionFile" | "getEntry" | "getEntries">;

/** Forward structural typing for Pi's additive public v1 API; this is not a fallback runner/protocol. */
export interface NativeRunSnapshot {
  runId: string;
  binding: NativeExecutionProof["binding"];
  phase: "running" | "draining" | "cancelling" | "settled" | "attention-required";
  reason?: string;
  startedAt: string;
  softDeadlineAt: string;
  hardDeadlineAt: string;
  nativeClosed: boolean;
  ownedHandles: string[];
  requestCount: number;
  retryCount: number;
  failedRecoveryMs: number;
  providerPhase: "unknown" | "request-started" | "response-received";
  retryNotBefore?: string;
  checkpointEntryId?: string;
}
export interface NativeCheckpointDeclaration {
  artifacts?: Array<{ ref: string; sha256?: string }>;
  effects?: Array<{ id: string; scope: string; evidenceRefs: string[] }>;
  nextAction?: string;
  waitingReason?: string;
}
export interface NativeRunCheckpoint {
  version: 1;
  runId: string;
  binding: NativeExecutionProof["binding"];
  createdAt: string;
  completedResults: Array<{ entryId: string; toolCallId: string; toolName: string; isError: boolean }>;
  completedResultCount: number;
  lastResultEntryId?: string;
  declarations: NativeCheckpointDeclaration;
  effectStatus: "none-observed" | "unknown";
  businessOutcome: "unverified";
}
export interface NativeRunHandle {
  readonly runId: string;
  readonly settled: Promise<NativeExecutionProof & { reason?: string }>;
  snapshot(): NativeRunSnapshot;
  checkpoint(declaration?: NativeCheckpointDeclaration): string;
  requestDrain(reason?: string): boolean;
  requestCancel(reason?: string): boolean;
  own(handle: { id: string; closed: Promise<void>; cancel?: () => void }): void;
}
export interface NativeCapability {
  readonly version: 1;
  readonly unattendedInputGuardVersion?: 1;
  readonly active: NativeRunHandle | undefined;
  start(request: { binding: NativeExecutionProof["binding"]; policy: { softDeadlineMs: number; hardDeadlineMs: number; recoveryBudgetMs?: number }; content: string }): { accepted: true; handle: NativeRunHandle } | { accepted: false; reason: "busy" | "disposed" };
}

export function nativeCapability(host: unknown): NativeCapability | undefined {
  const value = (host as { scheduledExecution?: NativeCapability } | undefined)?.scheduledExecution;
  return value?.version === 1 && typeof value.start === "function" ? value : undefined;
}

export function sameNativeBinding(a: NativeExecutionProof["binding"], b: NativeExecutionProof["binding"]): boolean {
  return !!a && !!b && a.jobId === b.jobId && a.attemptId === b.attemptId && a.ownerSessionId === b.ownerSessionId && a.ownerEpoch === b.ownerEpoch && a.revision === b.revision;
}
