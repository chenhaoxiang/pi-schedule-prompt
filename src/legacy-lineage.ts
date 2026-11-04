import { validEventId, validEvidenceFingerprint } from "./events.js";
import type { CronJob, LegacyOwnerHandover } from "./types.js";

export function validateLegacyHandover(value: LegacyOwnerHandover): void {
  if (!value || ![value.predecessorJobId, value.successorJobId, value.fromSessionId, value.toSessionId, value.claimId].every(validEventId) || value.predecessorJobId === value.successorJobId || value.fromSessionId === value.toSessionId || ![value.claimBinding, value.recoveryEvidenceFingerprint, value.handoverEvidenceFingerprint].every(validEvidenceFingerprint) || typeof value.evidenceRef !== "string" || !value.evidenceRef.trim() || value.evidenceRef.length > 2048 || /[\u0000-\u001f\u007f]/.test(value.evidenceRef)) throw new Error("Invalid exact legacy handover evidence");
}

/** Pure, conservative budget mapping for a proven legacy resume chain; original rows are never rewritten. */
export function inheritLegacyBudget(jobs: CronJob[], id: string, handovers: LegacyOwnerHandover[] = []): CronJob {
  const current = jobs.find(job => job.id === id);
  if (!current) throw new Error("Legacy successor is missing");
  if (current.policy?.mode === "resilient") throw new Error("Already resilient; never rebase spending a second time");
  if (!Array.isArray(handovers) || handovers.length > 32) throw new Error("Invalid bounded legacy handover evidence");
  for (const item of handovers) validateLegacyHandover(item);
  const used: LegacyOwnerHandover[] = [];
  const chain: CronJob[] = [current];
  const seen = new Set([id]);
  for (;;) {
    const child = chain[chain.length - 1];
    const parents = jobs.filter(job => job.recovery?.successorJobId === child.id);
    if (!parents.length) break;
    if (parents.length !== 1) throw new Error("Unproven legacy lineage: multiple predecessors");
    const parent = parents[0];
    if (parent.policy?.mode === "resilient") throw new Error("A resilient record cannot become a legacy budget predecessor");
    if (seen.has(parent.id)) throw new Error("Unproven legacy lineage: cycle");
    const spent = parent.attemptCount ?? parent.runCount;
    if (parent.session !== child.session) {
      const matches = handovers.filter(item => item.predecessorJobId === parent.id && item.successorJobId === child.id);
      const proof = matches[0];
      if (matches.length !== 1 || proof.fromSessionId !== parent.session || proof.toSessionId !== child.session || proof.claimId !== parent.claim?.id || proof.claimBinding !== parent.claim?.binding || proof.recoveryEvidenceFingerprint !== parent.recovery?.evidenceFingerprint) throw new Error("Unproven legacy lineage: exact cross-owner handover evidence required");
      used.push(proof);
    }
    if (parent.enabled || !parent.recovery || !validEvidenceFingerprint(parent.recovery.evidenceFingerprint) || parent.claim?.id !== parent.recovery.claimId || parent.claim.phase !== "settled" || !["unknown", "aborted"].includes(parent.claim.outcome ?? "") || !parent.maxRuns || !parent.expiresAt || !child.maxRuns || child.maxRuns !== parent.maxRuns - spent || child.expiresAt !== parent.expiresAt || child.maxRunsPerDay !== parent.maxRunsPerDay || child.deadlineMs !== parent.deadlineMs) throw new Error("Unproven legacy lineage: identity or inherited bounds changed");
    if (spent < parent.runCount || (parent.dailyUsage && (!child.dailyUsage || child.dailyUsage.day < parent.dailyUsage.day || (child.dailyUsage.day === parent.dailyUsage.day && child.dailyUsage.attempts < parent.dailyUsage.attempts)))) throw new Error("Unproven legacy lineage: spending was reset");
    chain.push(parent); seen.add(parent.id);
  }
  if (used.length !== handovers.length) throw new Error("Unproven legacy lineage: unused or duplicate handover evidence");
  const root = chain[chain.length - 1];
  const totalSpent = chain.reduce((sum, job) => sum + (job.attemptCount ?? job.runCount), 0);
  if (chain.some(job => (job.attemptCount ?? job.runCount) < job.runCount) || !Number.isSafeInteger(totalSpent) || (root.maxRuns !== undefined && totalSpent > root.maxRuns)) throw new Error("Invalid inherited lifetime spending");
  return {
    ...structuredClone(current),
    ...(root.maxRuns === undefined ? {} : { maxRuns: root.maxRuns }),
    attemptCount: totalSpent,
    runCount: chain.reduce((sum, job) => sum + job.runCount, 0),
    // The successor daily counter already includes its predecessor at the recovery boundary. Never sum it again.
    dailyUsage: current.dailyUsage ? { ...current.dailyUsage } : undefined,
    legacyLineage: chain.slice(1).reverse().map(job => job.id),
    ...(used.length ? { legacyHandovers: structuredClone(used.reverse()) } : {}),
  };
}
