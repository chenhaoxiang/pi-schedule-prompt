# Proposal

## Why

Recurring AI work currently turns an elapsed deadline or uncertain settlement into permanent job disablement, even when earlier tools finished successfully. Variable model latency and transient errors also expose the gap between fixed-rate triggers, single-run ownership, safe checkpointing and business-effect reconciliation; changing the timer alone does not repair that lifecycle.

## What Changes

- Add completion-relative fixed-delay scheduling alongside fixed-rate intervals and timezone-explicit cron, with single-flight ownership, explicit overlap and missed-occurrence policies.
- Separate user enablement, current runtime disposition and immutable per-attempt outcomes; transient errors use persisted backoff rather than silently cancelling future authorized work.
- Integrate native Pi run-scoped retry/budget, drain, checkpoint and exact cancellation/settlement capabilities. Successful final model prose is not required to persist a truthful interrupted-run checkpoint.
- Reconcile uncertain external effects before continuation; never re-execute completed tools or infer rollback from a timeout. Keep finite lifetime/daily/expiry bounds and existing authorization.
- Retain one stable logical job identity across attempts and ownership transfers instead of growing successor-job chains for routine recovery.
- **BREAKING, controlled migration:** introduce a versioned shared-store/runtime contract and operator-visible status projections. Older writers must not downgrade or mutate the new format; existing disabled UNKNOWN jobs are not automatically re-enabled.
- Preserve one-shot/event/Intercom reply-follow-up contracts and ordinary interactive Pi retry behavior. Reuse the existing scheduler/store/native host, not a second execution system.

## Capabilities

### New Capabilities

- `recurring-trigger-policy`: fixed-delay/fixed-rate/cron timing, bounded overlap and restart/misfire handling.
- `scheduled-run-lifecycle`: run-bound budgets, ownership, drain/checkpoint and cancellation acknowledgement independent of final prose.
- `scheduled-recovery`: separated intent/outcome, persisted backoff, safe continuation and effect-specific UNKNOWN reconciliation.
- `scheduling-state-migration`: durable identities/history/budgets, compatible consumer projections and safe shared-store rollout/rollback.

### Modified Capabilities

None under `openspec/specs/`: the official inventory is currently empty. Historical changes `reliable-prompt-scheduling`, `composed-automation-rollout` and `bounded-reply-followup` were read in full. This successor changes recurring timed resilient jobs' busy/automatic-disable behavior explicitly; it retains their native dispatch, guarded storage, exact receipts and non-replay guarantees. Historical artifacts are not rewritten or automatically archived.

## Impact

- Primary owner: `chenhaoxiang/pi-schedule-prompt` (`src/{types,storage,scheduler,durable,index,tool,status}.ts`, UI, supervisor scripts, tests and existing owner docs).
- Required native counterpart: `chenhaoxiang/pi` (coding-agent session/extension execution seams, existing AI retry policy helpers, settings/schema and provider-free tests). This owner Change remains the single cross-repository plan; the Pi PR references it instead of minting a competing plan.
- Conditional compatibility only: Intercom reply-follow-up and Subagents owned-child handles, when exercised by changed contracts. Optional Desk/Vista read-only status is not a prerequisite for the core repair.
- No production/business-site changes, new providers/models, global retry rewrites, second runner/database/control plane, credential changes or forced active-session reloads.
- Delivery distinguishes source/CI, immutable release, disk installation, actual loaded capability, state migration and authorized natural-task evidence. User approval on 2026-11-03 authorizes the plan and implementation; normal repository gates still apply.
