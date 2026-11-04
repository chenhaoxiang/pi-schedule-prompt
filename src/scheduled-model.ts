import * as fs from "node:fs";
import * as path from "node:path";
import { AgentSession, CURRENT_SESSION_VERSION, type ExtensionContext, type FileEntry, type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { type NativeCapability, type NativeSessionReader, nativeCapability, sameNativeBinding } from "./native.js";
import { validateModelSdkClose, validateNativeProof } from "./resilient-policy.js";
import { prepareModelSession, resolveModelRoute } from "./subagent.js";
import type { ModelSdkCloseProof, NativeCheckpointReference, NativeExecutionProof, OwnedAttempt, ResilientJob } from "./types.js";

export const MODEL_SDK_CLOSE_ENTRY = "schedule.model-sdk-closed.v1";

export interface ScheduledModelPlan { route: string; checkpoint?: NativeCheckpointReference; }
export interface PreparedScheduledModel {
  capability: NativeCapability;
  sessionManager: NativeSessionReader;
  dispose(receipt?: NativeExecutionProof): Promise<ModelSdkCloseProof | undefined>;
}
const sessionDirectory = (cwd: string) => path.resolve(cwd, ".pi", "schedule-native");
const staticCapabilityVersion = () => (AgentSession as unknown as { scheduledExecutionVersion?: number }).scheduledExecutionVersion;

function selectedFile(cwd: string, sessionFile: string): string {
  const selected = path.resolve(sessionFile);
  if (path.dirname(selected) !== sessionDirectory(cwd) || !selected.endsWith(".jsonl") || fs.lstatSync(selected).isSymbolicLink() || fs.realpathSync(selected) !== selected) throw new Error("Scheduled model transcript is not the exact owned native file");
  return selected;
}

/** A strict metadata-only read. Never call SessionManager.open (which may repair/migrate bytes) during preflight/readback. */
export function readStoredModelSession(cwd: string, sessionId: string, sessionFile: string): NativeSessionReader {
  const selected = selectedFile(cwd, sessionFile);
  const values = fs.readFileSync(selected, "utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as FileEntry);
  const header = values[0];
  if (header?.type !== "session" || header.id !== sessionId || header.version !== CURRENT_SESSION_VERSION) throw new Error("Native transcript identity/format is unavailable; preserve original bytes");
  const entries = values.slice(1) as SessionEntry[];
  if (entries.some(entry => !entry || typeof entry.id !== "string" || !entry.id) || new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error("Native transcript entries are malformed/duplicated; preserve original bytes");
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  return { getSessionId: () => sessionId, getSessionFile: () => selected, getEntry: id => structuredClone(byId.get(id)), getEntries: () => structuredClone(entries) };
}

/** A native run receipt cannot substitute for this separate persistent SDK/file-writer acknowledgement. */
export function readModelSdkClose(manager: NativeSessionReader, native: NativeExecutionProof): ModelSdkCloseProof | undefined {
  const entries = manager.getEntries();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== MODEL_SDK_CLOSE_ENTRY) continue;
    const proof = entry.data as ModelSdkCloseProof;
    if (proof?.runId !== native.runId || !sameNativeBinding(proof.binding, native.binding) || proof.checkpointEntryId !== native.checkpointEntryId) continue;
    validateModelSdkClose(proof, native);
    return structuredClone(proof);
  }
  return undefined;
}

/** Pure route/checkpoint/SDK preflight. It constructs no SDK session and writes no transcript. */
export function planScheduledModel(ctx: ExtensionContext, job: ResilientJob): ScheduledModelPlan {
  if (!job.model) throw new Error("A persisted explicit model route is required");
  if (staticCapabilityVersion() !== 1) throw new Error("Scheduled model SDK lacks native capability v1");
  const resolution = resolveModelRoute(ctx.modelRegistry, job.model);
  if (!resolution.ok) throw new Error(resolution.error);
  const continuation = job.runtime.continuation;
  const previousModel = continuation && job.attemptHistory.find(record => record.id === continuation.attemptId)?.model;
  if (previousModel && previousModel !== resolution.route) throw new Error("A native checkpoint cannot silently continue on a different model route");
  if (continuation) {
    if (!continuation.checkpoint.sessionFile) throw new Error("A model continuation requires the exact persistent native checkpoint file");
    const manager = readStoredModelSession(ctx.cwd, continuation.checkpoint.sessionId, continuation.checkpoint.sessionFile);
    const entry = manager.getEntry(continuation.checkpoint.entryId);
    const data = entry?.type === "custom" && entry.customType === "pi.scheduled-checkpoint.v1" ? entry.data as { version?: number; runId?: string; binding?: NativeExecutionProof["binding"] } : undefined;
    if (data?.version !== 1 || data.runId !== continuation.checkpoint.runId || data.binding?.jobId !== job.id || data.binding.attemptId !== continuation.attemptId || data.binding.ownerSessionId !== continuation.checkpoint.sessionId) throw new Error("Model continuation checkpoint/binding is unavailable; do not create a replay session");
  }
  return { route: resolution.route, ...(continuation ? { checkpoint: structuredClone(continuation.checkpoint) } : {}) };
}

/** Construct the one persistent child SDK session only after atomic attempt admission and file binding. */
export async function prepareScheduledModel(ctx: ExtensionContext, job: ResilientJob, attempt: OwnedAttempt, route: string, bindFile: (sessionFile: string) => void): Promise<PreparedScheduledModel> {
  if (!job.model || attempt.model !== route || !attempt.nativeSessionId) throw new Error("Native model admission route/session is not exact");
  const checkpoint = job.runtime.continuation?.checkpoint;
  let manager: SessionManager;
  if (checkpoint) {
    if (!checkpoint.sessionFile || checkpoint.sessionId !== attempt.nativeSessionId || checkpoint.sessionFile !== attempt.nativeSessionFile) throw new Error("Admitted model continuation changed its persistent session binding");
    // Admission owns this transcript now. Validate the latest bytes without a repairing read first.
    readStoredModelSession(ctx.cwd, checkpoint.sessionId, checkpoint.sessionFile);
    bindFile(checkpoint.sessionFile);
    manager = SessionManager.open(checkpoint.sessionFile, sessionDirectory(ctx.cwd), ctx.cwd);
  } else {
    const directory = sessionDirectory(ctx.cwd);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    manager = SessionManager.create(ctx.cwd, directory, { id: attempt.nativeSessionId });
    const file = manager.getSessionFile();
    if (!file) throw new Error("Scheduled native model session is not persistent");
    bindFile(file);
  }
  const session = await prepareModelSession(ctx, route, { extensions: job.extensions, skills: job.skills }, manager, true);
  let cleanup: Promise<string> | undefined;
  let acknowledged: ModelSdkCloseProof | undefined;
  const dispose = async (receipt?: NativeExecutionProof): Promise<ModelSdkCloseProof | undefined> => {
    if (receipt) {
      validateNativeProof(receipt);
      if (!sameNativeBinding(receipt.binding, { jobId: job.id, attemptId: attempt.id, ownerSessionId: manager.getSessionId(), ownerEpoch: attempt.owner.epoch, revision: attempt.revision })) throw new Error("SDK close cannot acknowledge a different native attempt");
    }
    cleanup ??= (async () => {
      await session.waitForIdle();
      let shutdownFailed = false;
      const unsubscribe = session.extensionRunner.onError(error => { if (error.event === "session_shutdown") shutdownFailed = true; });
      try {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        if (shutdownFailed) throw new Error("Model SDK shutdown handler failed; file-writer closure remains unacknowledged");
      } finally { unsubscribe(); session.dispose(); }
      // dispose() signals abort but returns void; acknowledge any SDK loop a shutdown hook left alive only after idle.
      await session.waitForIdle();
      return new Date().toISOString();
    })();
    const closedAt = await cleanup;
    if (!receipt) return undefined;
    if (acknowledged) { validateModelSdkClose(acknowledged, receipt); return structuredClone(acknowledged); }
    const proof: ModelSdkCloseProof = { version: 1, runId: receipt.runId, binding: { ...receipt.binding }, checkpointEntryId: receipt.checkpointEntryId, closedAt };
    manager.appendCustomEntry(MODEL_SDK_CLOSE_ENTRY, proof);
    acknowledged = proof;
    return structuredClone(proof);
  };
  if (staticCapabilityVersion() !== 1 || !session.model || `${session.model.provider}/${session.model.id}` !== route) { await dispose(); throw new Error("Scheduled model session did not select the exact native route/capability"); }
  const capability = nativeCapability(session);
  if (!capability) { await dispose(); throw new Error("Scheduled model session lacks native capability v1"); }
  return { capability, sessionManager: manager, dispose };
}
