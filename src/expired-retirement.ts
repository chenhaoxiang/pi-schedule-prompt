import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isResilient, validateModelSdkClose, validateNativeProof } from "./resilient-policy.js";
import type { CronJob } from "./types.js";

const TAIL_LIMIT = 1024 * 1024;
type Entry = { type?: string; id?: string; customType?: string; data?: Record<string, unknown> };

/** Offline operator preflight only; not another session's management tool or an execution/takeover port. */
export function inspectExpiredRetirement(cwd: string, job: CronJob | undefined, expectedOwner: string, now = Date.now()) {
  if (!job || !isResilient(job) || job.session !== expectedOwner) throw new Error("Expired retirement scope must match an exact resilient job and original owner");
  if (!job.expiresAt || Date.parse(job.expiresAt) > now) throw new Error("Retirement requires an already expired definition");
  if (job.runtime.slot.kind !== "idle" || job.runtime.pending || job.pendingIntent || job.pendingEvent) throw new Error("Retirement requires idle ownership and no pending work");
  if (job.runtime.legacyUncertainty || job.runtime.baselineAttempts || job.legacyLineage?.length || job.claim || job.recovery) throw new Error("Retirement closure of legacy/ambiguous resources is not supported by this narrow operator port");
  const last = job.attemptHistory.at(-1);
  const native = last?.nativeProof, close = last?.modelSdkClose, checkpoint = last?.checkpoint;
  if (!last?.charged || !last.model || !native || !close || !checkpoint?.sessionFile || (job.runtime.continuation && job.runtime.continuation.attemptId !== last.id)) throw new Error("Retirement requires the latest exact persistent-model closure and checkpoint");
  validateNativeProof(native); validateModelSdkClose(close, native);
  if (Date.parse(close.closedAt) < Date.parse(native.finishedAt) || Date.parse(close.closedAt) > now) throw new Error("Retirement SDK closure timing is not final");

  const directory = path.resolve(cwd, ".pi/schedule-native"), file = path.resolve(checkpoint.sessionFile);
  if (path.dirname(file) !== directory || !file.endsWith(".jsonl") || fs.realpathSync(directory) !== directory || fs.lstatSync(file).isSymbolicLink() || fs.realpathSync(file) !== file) throw new Error("Retirement requires the original canonical native transcript");
  const fd = fs.openSync(file, "r");
  let entries: Entry[];
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error("Retirement transcript is not a regular file");
    const headerBytes = Buffer.alloc(Math.min(before.size, 65536)); fs.readSync(fd, headerBytes, 0, headerBytes.length, 0);
    const newline = headerBytes.indexOf(10);
    if (newline < 0) throw new Error("Retirement transcript header exceeds its bound");
    const header = JSON.parse(headerBytes.subarray(0, newline).toString("utf8"));
    if (header.type !== "session" || header.version !== 3 || header.id !== checkpoint.sessionId || header.cwd !== path.resolve(cwd)) throw new Error("Retirement transcript identity is not exact");
    const start = Math.max(0, before.size - TAIL_LIMIT), bytes = Buffer.alloc(before.size - start);
    fs.readSync(fd, bytes, 0, bytes.length, start);
    let text = bytes.toString("utf8");
    if (start) {
      const previous = Buffer.alloc(1); fs.readSync(fd, previous, 0, 1, start - 1);
      if (previous[0] !== 10) text = text.slice(text.indexOf("\n") + 1);
    }
    entries = text.split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as Entry);
    const after = fs.fstatSync(fd), current = fs.statSync(file);
    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.size !== current.size || before.mtimeMs !== current.mtimeMs) throw new Error("Retirement transcript changed during closure read");
  } catch { throw new Error("Retirement transcript closure is unavailable within the bounded valid tail"); }
  finally { fs.closeSync(fd); }
  const checkpointEntry = entries.find(e => e.id === checkpoint.entryId && e.type === "custom" && e.customType === "pi.scheduled-checkpoint.v1");
  if (checkpointEntry?.data?.version !== 1 || checkpointEntry.data.runId !== native.runId || !isDeepStrictEqual(checkpointEntry.data.binding, native.binding)) throw new Error("Retirement checkpoint closure binding is unavailable");
  const receipt = entries.find(e => e.type === "custom" && e.customType === "pi.scheduled-receipt.v1" && e.data?.runId === native.runId && isDeepStrictEqual(e.data.binding, native.binding));
  const receiptProjection = Object.fromEntries(Object.keys(native).map(key => [key, receipt?.data?.[key]]));
  const final = entries.at(-1);
  if (!isDeepStrictEqual(receiptProjection, native) || final?.type !== "custom" || final.customType !== "schedule.model-sdk-closed.v1" || !isDeepStrictEqual(final.data, close)) throw new Error("Retirement native/SDK closure is missing, changed or followed by newer transcript activity");
  return { jobId: job.id, ownerSessionId: expectedOwner, attemptId: last.id, expiresAt: job.expiresAt, enabled: job.enabled, attemptCount: job.attemptCount, historyCount: job.attemptHistory.length, effectStatus: last.effectStatus, businessOutcome: "unverified" as const };
}
