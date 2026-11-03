import type { NativeExecutionProof } from "./types.js";

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
