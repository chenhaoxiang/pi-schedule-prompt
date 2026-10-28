# Proposal

## Why

An Intercom `ask` can time out while the original message is still queued, received, or executing; waiting indefinitely is not acceptable, while replaying the business request is unsafe. The existing schedule store already provides bounded, session-bound timers and persistence, so the missing capability is a narrow binding between one exact Intercom message and one finite follow-up/checkpoint timer.

## What Changes

- Add a process-local, versioned follow-up seam between the existing `pi-intercom` extension and `pi-schedule-prompt` extension.
- Persist the original session, request, message, target and goal/phase binding on the existing schedule job; use the existing schedule store and timer rather than a second supervisor or timer database.
- Enforce finite `deadline`, `frequency`, `maxRuns` and `expiry`, and deduplicate an active follow-up by the exact binding.
- On an exact `replyTo` reply, close only the matching reply-wait and cancel the matching follow-up; read back the cancelled/absent state before reporting the timer closed.
- Treat ACK/PENDING as a checkpoint observation only. It must not mark the business goal complete or replay the original action; the next reminder must carry a new explicit phase/checkpoint binding.
- Re-check the persisted binding and enabled state immediately before dispatch. Cancellation must remove pending in-memory work and prevent a queued wake from executing after cancellation.
- Preserve `unknown` evidence for restart, disconnect, timeout, late reply, or uncertain transport outcomes. Delivered/wake/receiver receipts remain transport evidence, never execution or business completion.

## Capabilities

### New Capabilities

- `reply-followup-binding`: Finite, exact-message-bound follow-up timers with cancellation, deduplication, checkpoint semantics and unknown-state recovery.

### Modified Capabilities

- None.

## Impact

- `pi-schedule-prompt/src/types.ts`, `src/storage.ts`, `src/scheduler.ts`, `src/index.ts` and focused tests.
- `pi-intercom/followup-api.ts`, `index.ts`, `types/tests` and maintenance documentation.
- No Java/runtime worktree, production/provider/CLI/payment path, shared broker restart, or new global supervisor/approval ledger.
- Source delivery and provider-free validation are in scope; package installation, active-session reload and live business acceptance remain separately reported.
