---
doc_type: design
project: pi-schedule-prompt
status: active
truth_mode: maintained
created: 2026-10-20
---

# Reliable scheduled prompt delivery

## Scope

The first maintained slice upgrades the fork from community 0.4.1's locked Pi 0.78 development SDK to Pi 1.3 and retains cron, interval, one-shot, UI and explicit model jobs. It does not implement a daemon, external webhook, global monitor, new runner, permission framework or automatic installation.

## Runtime

Inline work is a single scheduled_prompt native custom turn with triggerTurn and followUp. A pending Set keeps at most one due intent per job. It drains only when the host is idle with no pending messages. An agent_settled signal requests an idle drain; a one-second unref watchdog exists only while pending as a safety net. It does not request inference while busy. Definitions are re-read before dispatch, so stale timer closures cannot execute old prompts. The storage attempt is recorded before delivery; acceptance is dispatched, never business success. An ambiguous delivery pauses rather than replaying.

Explicit model jobs are preflighted against the current authenticated model registry when added, updated, enabled, loaded, and dispatched. Unique aliases are persisted as the canonical `provider/model-id` route; unknown and provider-ambiguous requests are rejected before storage or admission. The runner repeats the same resolution without falling back to registry order, so a bare id cannot silently select a different provider. Automatic startup/dispatch preflight validates legacy aliases without rewriting their stored model, revision or accepted-work bindings; canonical routes are persisted only on new definitions and explicit management updates. This preserves queued events, durable intents, next occurrences and immutable claim evidence during upgrades.

The scheduler discards pending local work on disable, delete, update and shutdown. Explicit model jobs remain local single-flight; generation checks suppress late completion after rescheduling. Shutdown aborts those model sessions and suppresses late results. Pausing future fires does not cancel already executing tools. Lifecycle handlers identify recursion from before_agent_start's custom source, not old transcript markers. Print/JSON batch modes register management but do not arm timers.

maxRuns counts admitted attempts, including failures, for the task lifetime. expiresAt is an absolute timestamp checked at admission. They are not token or invoice ceilings. Re-enabling does not bypass an exhausted limit: deliberately update the limit or create another task. No business completion claim follows from dispatch status. The tool does not clear limits by omission; an existing expiresAt can be moved forward or the task can be replaced.

## Persistence and concurrency

The foundation used a version-1 local store. Stage C reads version1/2 and writes version2 so older runtimes reject unsupported event/limit data; do not share newly upgraded state with older schedulers. Storage remains local to cwd. Every mutation holds an exclusive .lock, re-reads latest bytes, validates, writes to a unique 0600 temporary file, fsyncs and atomically renames. Management contention fails promptly; pre-admission scheduled contention retains one pending intent and retries without spending an attempt. Post-admission failures remain ambiguous and pause. Malformed data and duplicate ids/names fail without replacing the original. Lifetime admission uses the same lock. Stale locks are not auto-broken because elapsed time/PID reuse cannot prove ownership loss.

This is a cooperating same-user local process boundary. It does not promise NFS safety, adversarial symlink isolation, crash-atomic external effects or exactly-once inference. Shared/unbound schedules retain explicit broadcast behavior; session-bound is the safe default. Paused definitions survive reload and shutdown; explicit cleanup remains available.

## Composition

Intercom owns peer messaging and explicit wake requests. Subagents owns independent delegated workflow execution, schedules and mission recovery. Messenger owns Crew dependencies where already adopted. This fork does not clone their records or interpret observations as permission. Future event/daemon work must earn its scope and use these existing public interfaces. No raw prompt is sent to Vista; cron:change is a local observational event, not a public sanitized protocol.

## Bounded Intercom reply follow-up

The optional `schedule:reply-followup:v1` seam lets `pi-intercom` persist one finite, exact-message-bound control reminder in this existing store. A record binds the owner/intercom/peer sessions, original message id, request id, goal and phase; it requires a finite delay, `maxRuns=1`, deadline and expiry. An active `coveredBy` schedule is rejected rather than creating a second loop. A matching `replyTo` observation cancels the record and reads back the persisted state; an unrelated message cannot cancel it.

Due work emits `schedule:reply-followup-due:v1` for Intercom to send a status-only reminder. The scheduler rechecks the persisted claim before emission and cancellation purges local pending work. Delivered, wake-requested, injected and ACK/PENDING observations never settle the business goal. A dispatched or interrupted follow-up remains `unknown` when restart, disconnect, late reply or transport uncertainty prevents reconciliation; no original business action is replayed.

## Bounded no-change quieting

Event jobs may opt in to no-change quieting with `quietOnNoChange`, a bounded
`noChangeThreshold` (1–10) and `quietForMs` (1 second–24 hours). A producer may
supply an `evidenceFingerprint` (64 lowercase hex characters) with an admitted
event or send a `schedule:progress:v1` observation for an active durable claim.
The scheduler stores only the fingerprint, bounded counter, `waitingReason` and
`quietUntil`; it never stores raw evidence or prompt content.

A repeated fingerprint is returned as `{ status: "duplicate", reason:
"no-change" }` and does not create another pending event or consume an attempt.
Once the threshold is reached, the job enters `lastStatus: "quiet"` until its
bounded quiet window expires. A new fingerprint resets the no-change counter and
clears the quiet marker. This is opt-in and does not change legacy timer jobs,
external business completion, or the existing ambiguous-delivery `unknown`
semantics.

`progress` observations are metadata only: `advanced`, `unchanged`, and
`unknown` do not prove business completion. Receipt persistence remains
receipt-first; observer or notice failure does not replay the original action.

## Verification and boundaries

The original 103-test baseline passed before changes. The first 15 reliability regression cases failed against that baseline. Maintained tests cover coalescing, native delivery, pause/remove/stop, fresh disk content, one-shot retention, expiry/attempt limits, corrupt stores, writer contention, private modes and foreign-session mutation.

UI reads and management callbacks contain storage faults, display an explicit unavailable/error state rather than an empty success, and preserve corrupt bytes. This includes the 30-second widget timer, render callback and asynchronous add-flow completion.

A real SDK lifecycle fixture uses only an in-memory faux provider, no discovered context, isolated credentials/models/settings, no network, and no paid calls. It checks custom source, one inference, no synthetic user messages, dispatched status and preservation of paused jobs. A second real-SDK case runs the retained explicit model mode through an extension-registered native faux provider with an isolated agent directory; virtual-model inheritance is not established by this fixture. Local verification includes community Pi 1.3 and an explicitly aliased installed Pi 1.3.0-fork.1 host; this is an isolated fixture, not global installation or all-live-session activation.

Initial independent review of 561e042 reported one P1 (uncontained runtime UI storage errors) and report-only notes. The follow-up contains UI refresh/render/action faults visibly, retries only provably pre-admission lock contention, adds tool-limit/recursion and real-SDK model-mode tests, and reduces the fallback polling frequency. The alleged user-input race between idle check and synchronous dispatch was not reproduced: the native host marks the run active synchronously before its first await. Source provenance remains tied to before_agent_start and is retained until agent_settled. Incremental review and final exact-head CI are tracked on the delivery PR.

Current provider-free results and exact PR head should be read from the delivery PR/CI. Source, fixture, actual-host fixture, release, installation and real unattended operation are separate evidence levels. No release or live rollout is inferred from this design.
