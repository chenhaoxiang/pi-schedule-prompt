# Design

## Context

See `proposal.md` and `specs/reply-followup-binding/spec.md`. `pi-schedule-prompt` already persists session-bound finite jobs, coalesces pending work, re-checks expiry/limits before dispatch, and records durable execution as `unknown` when effects cannot be reconciled. `pi-intercom` already exposes exact message IDs, reply matching, independent transport status, cancellation controls, and a process-local extension event seam.

## Goals / Non-Goals

**Goals:**

- Keep one exact binding from the original Intercom request through timer creation, reply cancellation, dispatch and readback.
- Reuse the existing schedule store and scheduler lifecycle; one reply-follow-up is a bounded one-shot control reminder, not a second hourly loop.
- Make create/cancel/reply and due-dispatch races fail closed, with persisted unknown evidence instead of replay.
- Keep ACK/PENDING separate from business completion and require a new phase binding for another checkpoint.

**Non-Goals:**

- No new broker, global supervisor, approval ledger, child runner, provider call, Java/runtime change, or production operation.
- No inference from delivery, wake, idle, receiver receipt, or a short acknowledgement.
- No automatic replay of the original message or business action.

## Decisions

1. **Use a local event seam, not a package dependency.** `pi-intercom` emits a versioned request to the already-loaded schedule extension and receives an explicit callback/readback. This avoids coupling release packages or creating a second scheduler. If schedule is absent, the request returns `unknown`/unsupported and never silently creates an in-memory fallback timer.
2. **Represent follow-ups as existing session-bound durable jobs.** A follow-up stores a narrow binding object on the job and uses a one-shot schedule with `maxRuns=1` (or an explicitly bounded finite set for a phase). The existing hourly inspection job is detected by its exact owner/session binding and is never duplicated; follow-up reminders are control prompts only.
3. **Make the persisted binding the arbiter.** Creation, cancellation and dispatch use the schedule store lock. Dispatch claims the exact binding before sending, then re-reads it immediately before `sendMessage`. Cancellation clears pending scheduler state and disables the job; if a send already crossed the effect boundary, the result is `unknown`, not replayed.
4. **Observe replies from the Intercom message path.** The intercom extension emits exact inbound `replyTo` observations. The schedule side cancels only a job whose stored message ID and session/target binding match. Ordinary messages and replies to other IDs are ignored. Late replies append an observation without reopening the job.
5. **Use explicit status text for reminders.** The scheduled prompt includes request/message/goal/phase and instructs the owner to query current evidence and send a status-only follow-up. It does not include the original business body or authorize a new action. The prompt states that ACK/PENDING is not completion.
6. **Persist unknown at every ambiguous boundary.** Disconnect, broker status-query timeout, owner restart with a dispatched claim, or late delivery leaves `lastStatus=unknown` / a follow-up observation and disables blind replay. The existing execution receipt mechanism remains the source of durable native execution evidence.

## Risks / Trade-offs

- [A scheduled control prompt can still be injected just before cancellation] → the execution path re-reads the exact binding before sending, and tests assert no post-cancel send; if the send already occurred, retain `unknown` and never replay.
- [The local event seam may be absent or receive an older extension] → requests require a claimed callback and bounded timeout; absence is reported as unknown/unsupported rather than creating a second timer.
- [A reply may arrive after restart or after the timer is unknown] → exact message ID correlation records a late observation without reopening or marking business completion.
- [The existing schedule store may contain hand-edited/legacy jobs] → schema validation rejects malformed follow-up metadata and configuration revision invalidates pending work before dispatch.

## Migration Plan

1. Add optional follow-up metadata to the existing schedule schema; legacy jobs remain valid and unchanged.
2. Load the schedule extension seam only when `pi-intercom` requests it; existing sessions and hourly jobs continue without modification.
3. Run provider-free unit and integration tests in isolated temporary stores and synthetic Intercom fixtures.
4. Deliver source through normal PR/CI. Installation and active-session reload are separate operations; rollback is the prior fixed package with no follow-up requests.
