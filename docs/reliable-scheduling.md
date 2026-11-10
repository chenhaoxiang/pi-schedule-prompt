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

Explicit-model jobs use their own in-process session, so parent activity or pending parent messages do not delay their admission. Drain skips blocked inline intents to reach eligible model work without charging the inline job. Legacy durable work still uses its existing single execution envelope; model single-flight, resilient exact ownership and SDK-close acknowledgements are unchanged. Start and non-notifying completion markers explicitly use `triggerTurn:false`: omitting that option would steer a streaming parent and could cause another inference. Explicit `notify:true` completion still uses the requested follow-up. If a model start-record write fails, only the child controller is cancelled and its exact hold is retained until release; the unrelated parent is never aborted.

Explicit model jobs are preflighted against the current authenticated model registry when added, updated, enabled, loaded, and dispatched. Unique aliases are persisted as the canonical `provider/model-id` route; unknown and provider-ambiguous requests are rejected before storage or admission. The runner repeats the same resolution without falling back to registry order, so a bare id cannot silently select a different provider. Automatic startup/dispatch preflight validates legacy aliases without rewriting their stored model, revision or accepted-work bindings; canonical routes are persisted only on new definitions and explicit management updates. This preserves queued events, durable intents, next occurrences and immutable claim evidence during upgrades.

The scheduler discards pending local work on disable, delete, update and shutdown. Explicit model jobs remain local single-flight; generation checks suppress late completion after rescheduling. Shutdown aborts those model sessions and suppresses late results. Pausing future fires does not cancel already executing tools. Lifecycle handlers identify recursion from before_agent_start's custom source, not old transcript markers. Print/JSON batch modes register management but do not arm timers.

maxRuns counts admitted attempts, including failures, for the task lifetime. expiresAt is an absolute timestamp checked at admission. They are not token or invoice ceilings. Re-enabling does not bypass an exhausted limit: deliberately update the limit or create another task. No business completion claim follows from dispatch status. The tool does not clear limits by omission; an existing expiresAt can be moved forward or the task can be replaced.

## Persistence and concurrency

The foundation used a version-1 local store. Stage C reads version1/2 and writes version2 so older runtimes reject unsupported event/limit data; do not share newly upgraded state with older schedulers. Storage remains local to cwd. Every mutation holds an exclusive .lock, re-reads latest bytes, validates, writes to a unique 0600 temporary file, fsyncs and atomically renames. Management contention fails promptly; pre-admission scheduled contention retains one pending intent and retries without spending an attempt. Post-admission failures remain ambiguous and pause. Malformed data and duplicate ids/names fail without replacing the original. Lifetime admission uses the same lock. Stale locks are not auto-broken because elapsed time/PID reuse cannot prove ownership loss.

This is a cooperating same-user local process boundary. It does not promise NFS safety, adversarial symlink isolation, crash-atomic external effects or exactly-once inference. Shared/unbound schedules retain explicit broadcast behavior; session-bound is the safe default. Paused definitions survive reload and shutdown; explicit cleanup remains available.

## Schema4 resilient state and ownership

The delivered resilient scheduling contract ([canonical requirements](../openspec/specs/scheduling-state-migration/spec.md); [archived owner Change](../openspec/changes/archive/2026-11-06-resilient-serial-scheduling/proposal.md)) adds an explicit `policy.mode: "resilient"` for finite, session-bound recurring timed jobs. Missing policy or `mode: "legacy"` keeps the preceding behavior. Reading legacy state never invents completion-delay defaults, enables an UNKNOWN job or upgrades the file format. Normal legacy writes remain schema3; an already upgraded schema4 file is never downgraded. One-shot/event/broadcast/reply-follow-up records keep their declared legacy contracts.

For a resilient job, `enabled` is the user's intent. `runtime.slot` separately distinguishes idle waiting/backoff/reconciling/waiting-input/attention/finished from owned running/draining/cancelling/attention. An owned slot contains the unique attempt, owning session/instance/epoch, accepted revision/occurrence and frozen execution budgets. A config update affects future work, not that attempt. No expiry, PID absence, cancellation request, status refresh or older-epoch receipt releases the owned slot. Two real local processes race the same existing exclusive store lock; other logical jobs are not globally excluded by that storage claim.

`attemptHistory` finalizes only against exact native closure metadata and keeps actual result/checkpoint references plus `businessOutcome: "unverified"`. Later closure/reconciliation evidence is appended to `attemptResolutions`, never used to rewrite an old UNKNOWN record or settle a newer owner. Generic updates cannot overwrite histories, spending or owner state. Removal disables future work while retaining live ownership and execution evidence.

Lifetime and UTC-day spending are the preserved legacy baseline plus charged new attempts/current ownership. Skipped ticks, model-request retries and read-only probes are not additional admitted attempts. Only an explicit native pre-execution refusal can refund its one provisional reservation; timeout/throw/UNKNOWN cannot. Proven legacy resume chains are mapped by their exact predecessor/claim/recovery marker and inherited limits. Their original rows stay intact, daily counters are not summed twice, and a changed/cyclic/ambiguous lineage fails instead of replenishing budget.

Uncertain legacy import is sticky `runtime.legacyUncertainty`, independent of display status. A missing native capability, an enable toggle or a stop/finished projection cannot clear it. The same rule applies to finalized native attempts: `execution: "completed"` with `effectStatus: "unknown"` retains its exact checkpoint and enters reconciling even if a caller requests waiting/finished. The immutable unknown record, not an optional continuation pointer, enforces the barrier. An owner resolution appends SHA-256 evidence bound to that exact checkpoint; a later unknown/waiting-input resolution supersedes earlier continuation evidence. Scoped read-only evidence does not release the entire job's conflicting writes. Completed work with `none-observed` effects can rearm normally. Native runtime completion is still not business acceptance or a generic external exactly-once guarantee.

The pure cadence helpers distinguish a fixed-delay target (safe finish plus interval) from a fixed-rate anchor or timezone-persisted cron occurrence. Restoring a persisted target applies skip/latest misfire at most once; a live tick instead uses its own lateness bound. Cooldown, UTC-day limits and expiry restrict future cadence without changing the original anchor or charging discarded ticks. A previously charged occurrence cannot be admitted again after its owner closes.

The first consumer slice connects **inline** resilient jobs to Pi's version-1 native capability. It refuses an absent/unsupported capability before charging or inference, passes the frozen work/hard budgets to the exact native handle, and never uses `ctx.abort` or a legacy custom-message fallback. Completion-delay/anchored-rate/cron timers re-read current definitions, retain at most one bounded pending occurrence and arm only legal future work. A native accepted:false refusal can refund its provisional reservation; a thrown/ambiguous start retains charged attention-required ownership.

Only the exact native checkpoint plus settled receipt releases the owned slot. Reload can attach an existing matching handle or consume its persisted closure receipt; no current handle/receipt means attention-required ownership, not proof that an old executor stopped. A metadata-only monitor projects drain/cancellation/attention changes once without waking the model. A required-input guard writes a native checkpoint and requests drain. Known pre-effect deferral uses persisted cooldown/Retry-After without resetting user intent or limits; unknown effects require reconciliation. Pause/update affects future cadence, not the accepted run's immutable policy.

For explicit-model resilient work, a pure planner checks the imported SDK's static v1 declaration and current canonical route before admission. It reads an existing continuation transcript strictly as metadata, never through an SDK open/repair operation. Only the atomic admitted owner binds the reserved child session file and constructs its persistent SDK session; the actual instance capability and selected model are checked again before inference. A missing old-SDK declaration or unavailable route therefore spends no attempt, while an ambiguous post-admission preparation failure retains charged attention-required ownership.

The child session id/file remains bound to the attempt and exact checkpoint. Continuation reopens that same file after admission, validates the checkpoint binding, and projects bounded completed-result/declaration metadata into the next native prompt. It never falls back to the legacy in-memory runner, a new model or another provider.

Native settlement alone does not close the persistent child SDK/file writer. A model attempt stays owned/draining through SDK idle, awaited shutdown hooks, disposal and the final SDK idle acknowledgement. Only then does the existing native transcript receive a Schedule-owned `schedule.model-sdk-closed.v1` entry bound to that exact attempt/session/epoch/revision/run/checkpoint. The final attempt retains this acknowledgement; a missing/failed/foreign ACK keeps owned attention, including on restart when a native receipt already exists. A native refusal is refunded only after the prepared SDK has closed. Completion-delay and scheduler cooldown use the actual SDK-close timestamp, never the earlier native receipt timestamp. This is resource closure, not business acceptance. Legacy explicit-model/one-shot/event/reply-follow-up contracts remain unchanged.

Canonical management now distinguishes legacy and resilient contracts at the existing `schedule_prompt`/TUI seams. New resilient definitions require native v1, schema4, a session owner, finite `maxRuns` and absolute `expiresAt`; interval mode, cron timezone, overlap, misfire, lateness, work target and hard elapsed budget are explicit and conflicting inputs fail before mutation. Existing legacy rows are never silently promoted by update; `preview` is read-only and reports that migration still needs verified quiescence. `status` returns bounded attempt/phase/reason/next-eligibility/checkpoint/resource metadata without prompts or transcript bodies. `drain` addresses only the exact owned native handle, and `reconcile` requires an exact finalized attempt/evidence resolution from the owning ordinary context; user intent toggles never clear history, spend or UNKNOWN effects. TUI rows show mode, phase, cooldown/cadence, user intent and unverified business outcome; generic cleanup leaves live/UNKNOWN/history-bearing resilient rows intact. Supervisor health alerts retain the existing dedup/read-only behavior for legacy claims; release/loaded/migration/live acceptance remain separate.

## Canonical resilient management examples

These are source/fixture examples, not an instruction to activate an existing UNKNOWN task. Replace the expiry placeholder only with an already-authorized finite future expiry. A new store can opt into schema4; an existing schema1/2/3 file requires explicit, backed-up migration after affected writers/executions are verified quiescent.

```json
{"action":"add","type":"interval","schedule":"1h","mode":"resilient","intervalMode":"fixed-delay","prompt":"Advance the already-authorized bounded goal from saved results","maxRuns":20,"expiresAt":"REPLACE_WITH_ALREADY_AUTHORIZED_FUTURE_ISO","workBudgetMs":1500000,"deadlineMs":2700000,"overlapPolicy":"skip","misfirePolicy":"skip","latenessMs":300000}
```

`fixed-delay` means one hour after exact safe finish (including a child SDK writer's close ACK), not hourly start times. To choose anchored cadence explicitly, update an existing resilient definition with `intervalMode:"fixed-rate"`; `buffer-one` retains the first waiting occurrence and lateness still expires it. Cron uses a six-field expression plus an effective persisted IANA `timezone`. Legacy rows/default tool calls keep their preceding behavior.

```json
{"action":"status","jobId":"EXACT_JOB_ID"}
{"action":"preview"}
{"action":"drain","jobId":"EXACT_OWNED_JOB_ID"}
{"action":"reconcile","jobId":"EXACT_JOB_ID","attemptId":"EXACT_FINALIZED_ATTEMPT","evidenceFingerprint":"REPLACE_WITH_VERIFIED_LOWERCASE_SHA256","resolution":"waiting-input"}
```

`status`/`preview` are metadata reads and never model wakes. A drain request checkpoints/yields but is not closure acknowledgement. Reconciliation consumes the exact retained checkpoint after native/SDK resources have closed; inspect original results/external effects first, never manufacture evidence from a summary. Repeating identical evidence is idempotent, scoped evidence does not release global conflicting writes, and no operation rewrites old UNKNOWN to business success, renews authority, resets spending or removes an existing expiry. Required-input waits and provider Retry-After/cooldown/UTC limits remain explicit unblock conditions. Scheduled turns cannot self-create, renew/change resilient definitions or self-certify reconciliation through this tool.

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
