# Design

## Context

See proposal.md for the approved problem and capability scope. Planning baselines, fetched on 2026-11-03, are Schedule main `654cc84e0e08b907c579b58f89879b499e9bac86` and Pi main `0903c552e926e29c739c982e728422a38c67a866`. These identify planning inputs, not future acceptance heads.

Current Schedule persists schema3, one latest claim and pending intent; its elapsed timer calls abort and immediately writes UNKNOWN, while an in-memory held claim protects the cancellation window. UNKNOWN/aborted and three errors disable a job. Interval timers rearm on ticks, not settlement. Wind-down blocks non-local-checkpoint tools but still depends on another successful model response. Pi already has transient-error classification, stepped retry, a configurable same-error circuit and `agent_settled`; do not reimplement them.

Two synthetic incident patterns define the regression target: a run spending its full budget in continuous provider overload, and a run with completed tools plus five intermittent overload responses that fails to finish inside a 45-minute hard deadline. No private session logs, real account identifiers or browser payloads enter fixtures or published source.

Existing unrelated Pi retry/rate-limit work and older Schedule management candidates must remain intact. Use isolated worktrees; integrate applicable merged changes normally rather than taking over dirty legacy trees. Re-read current origin/main at delivery, especially around retry classification and versions.

## Goals / Non-Goals

**Goals:** implement the four capability specs as one cross-repository program with verifiable vertical slices; preserve guarded tool execution, histories, finite bounds, default same-job serialization and existing authorization. The core owns execution facts; Schedule owns future admission.

**Non-Goals:** no second runner, database, scheduler daemon, global retry rewrite, automatic model/provider switching, generic external-effect exactly-once promise, production business change, forced active-session reload or global service restart. Desk/Vista are optional projections. Intercom/Subagents change only if required by an exercised compatibility contract; they are not mandatory expansion projects.

## Decisions

### 1. Single planning owner and sequential contract slices

This Change in `pi-schedule-prompt` owns requirements, acceptance and task status for both repositories. The Pi implementation PR links the exact owner Change revision and its native API evidence; it does not create a parallel OpenSpec program. Code remains in each owner repo. The designated implementation session owns both implementation worktrees after explicit handoff; the coordinating session does not concurrently edit them.

Use independent source/release boundaries: Schedule can develop/test against a faux native capability while Pi develops its narrow native seam. Do not enable resilient live jobs before the actual host capability is available. Source implementation and synthetic tests continue while an unrelated store or installation is busy.

### 2. Canonical configuration and compatibility

Keep existing job kinds (`cron`, `interval`, `once`, `event`) rather than adding duplicate meanings for cron. For intervals add one canonical mode selector, `intervalMode: fixed-delay | fixed-rate`. New resilient interval creation defaults to fixed-delay; unchanged legacy intervals retain their documented tick/coalescing behavior until explicitly migrated. Cron keeps its expression and a persisted effective timezone. Public tool/UI descriptions must explain that completion-plus-one-hour is not hourly fixed-rate.

For resilient recurring timed jobs expose `overlapPolicy: skip | buffer-one` (default skip), `misfirePolicy: skip | latest` (default skip), and a bounded lateness window. Buffer-one retains the first waiting occurrence; it is not latest replacement. Existing `catchUp` is a legacy alias only when unambiguous; conflicting policy inputs are rejected. Single-flight is an invariant, not a configurable accidental concurrency escape hatch. Deliberate legacy broadcast remains explicitly identified and is not silently converted into resilient multi-owner execution.

Use a discriminated legacy/resilient policy so old definitions do not accidentally acquire new defaults. Validate durations, supported modes, ownership, timezone and finite service limits before mutation. Do not expose redundant selectors or unused generic concurrency frameworks. Equivalent low-risk API naming is permitted only if tools, docs, migration, tests and this design are updated together before integration; capability behavior is fixed.

### 3. Timing and eligibility are pure decisions

Separate occurrence calculation from admission and execution. Fixed-rate uses a persisted anchor plus integer multiples of interval, not `Date.now()+interval` after each late tick. Fixed-delay arms only after exact run closure and safe recovery classification, using persisted `lastFinishedAt + delay`. A failed but known safe execution can rearm; it need not become a business success.

Compute eligibility from cadence, cooldown/not-before, buffered occurrence freshness, daily cap recovery and absolute expiry. Cron/fixed-rate select a legal future tick after not-before unless an explicit bounded misfire intent is still valid. A skipped/buffered tick never spends an admitted attempt. Restart applies a missed-occurrence policy once rather than rebuilding a backlog or repeatedly resetting delay. Test wall-clock changes with an injected clock; live elapsed budgets use monotonic accounting while persisted timestamps remain explicit UTC facts.

Timers only select an existing intent. They cannot carry new prompt text, authorization, model routes or retry instructions. Admission rechecks the latest definition and revision atomically.

### 4. Separate intent, runtime disposition and history

Use three orthogonal facts:

- User intent: enablement/explicit pause or stop. Automatic provider failure does not edit it.
- Runtime disposition: waiting, running, draining, cancelling, backoff, reconciling, waiting-input, attention-required, finished, each with a bounded reason and next eligibility or unblock condition.
- Attempt history: unique execution identity, factual execution outcome, checkpoint references, known/unknown effects and business outcome. Runtime closure is not business success.

A recurring job keeps one stable logical identity and a current owned attempt reference. Attempts and recovery receipts are immutable once finalized; later reconciliation appends evidence/resolution rather than rewriting UNKNOWN to success. Retain them in the existing Schedule store/native session receipt infrastructure, with bounded status projection and referenced older history as needed; no second task ledger or independent database.

Do not rely only on the last assistant stopReason. A completed native run can have unverified business output; a verifiably cancelled run can have uncertain external effects. Notifications remain a separate outbox and cannot decide execution success or trigger replay.

### 5. Exact ownership and acknowledged cancellation

Persist job/attempt, owner session and epoch, accepted revision and native run identity. Existing local exclusive storage mutation remains the cross-process serialization point; it is not an NFS/distributed lock claim. Running, draining and cancelling retain the logical job slot until the exact native handle closes or its termination is reliably established.

Hard deadline requests cancellation for that run only. It enters cancelling first; writing a receipt is not itself exit acknowledgement. Timeout/lease expiry/PID absence cannot authorize a replacement while native/owned-child execution may still write. Keep a bounded attention reason if cancellation cannot be confirmed. Late receipts from an older epoch cannot settle a newer attempt. User turns or other jobs must not be aborted by a stale scheduled timer.

Use explicitly owned Subagents handles when the scheduled contract actually waits for a child; mere notification delivery or parent idle cannot stand in for child closure. Preserve existing independent detached-child semantics: do not claim their effects were rolled back.

### 6. Native Pi capability, not global setting mutation

Add an additive, capability-versioned native execution seam for an accepted scheduled custom turn: run-scoped retry/execution policy, opaque run identity, metadata-only execution state, drain/yield request, and exact cancellation/settlement result. The concrete API belongs to Pi's session/extension types and documented SDK seam, not a model-provided event payload. Preserve the existing `ctx.abort(): void` compatibility contract; add an acknowledged exact-run operation instead of changing every extension or assuming void means stopped.

The native core must apply this policy for the accepted run only, including its automatic continuations. Clear it on exact settlement/session replacement; never mutate SettingsManager globals temporarily. Propagate budgets/signals through native model requests, retry sleep and relevant owned operations. Reuse existing classification/fingerprint/backoff helpers and quota/billing exclusions; do not fork a second classifier into Schedule. Normal user runs, compaction and unrelated contexts retain their existing behavior unless part of the accepted scheduled execution.

Old host capability absence is visible before admission: report unsupported runtime, spend no attempt and dispatch no inference for a resilient job. Legacy operation can remain explicitly legacy. No unsafe fallback to generic abort, arbitrary CLI sessions or a second executor.

### 7. Checkpoint and drain are native safe-boundary operations

Persist important completed tool-batch evidence at native boundaries where result entries actually exist. A checkpoint references exact result/entry IDs, declared artifact references/hashes, completed effects and unresolved effects. The model can supply a bounded next-action or waiting reason, but missing fields remain unknown and cannot grant authority. Do not infer a tool is effect-free merely from its name or a wrapper's text.

Offer a direct native/local `schedule_checkpoint` facility or equivalent supported path, so finalization does not require permitting arbitrary bash/codemode wrappers. Native drain marks the same run, stops new business slices at the next safe boundary, writes its real checkpoint and closes/defer-settles without launching another model request solely for bookkeeping. Completed tools are not rerun if final prose fails. Preserve partial/failed assistant history and result matching; do not rewrite checkpoints or fabricate a natural-language summary.

A normal concise final response remains useful when available, but is not a prerequisite for a truthful interrupted/deferred runtime receipt. Browser/effect status stays unverified unless actual evidence establishes it. Repeated reads, heartbeats and tool counts are not business progress.

### 8. Distinct budgets and one retry owner

Cadence, provider connect/first-ack timeout, tool timeout, failed-request recovery elapsed budget, soft business-work budget, finalization reserve, hard elapsed deadline, job expiry and attempt/fee limits are separate. An interval tick does not kill productive work; progress and errors cannot extend a hard limit.

Initial resilient scheduled profile: at most three additional retries for one model response, an equivalent-error threshold of three failed responses (including the first), and at most five minutes of cumulative failed-request recovery time per run. The elapsed recovery budget includes failed-call/retry-wait time, not successful normal model reasoning; the hard run deadline still covers everything. Success can reset a per-response consecutive count but not the run's spent recovery budget. Respect provider Retry-After; if it exceeds remaining run budget, persist deferral instead of retrying early.

After exact safe closure, scheduler cooldown steps are 1, 2, 5, 10 and 30 minutes, capped at 30, with bounded jitter. Persist the chosen deadline so restarts do not change it. Native request retry handles one failed response; scheduler cooldown handles future continuation from checkpoint, never replay of an entire side-effectful prompt. A recovery resume that executes business work must have an admitted attempt/counter record; metadata-only probes do not spend a business attempt. Original expiry always wins.

Preserve existing explicit global retry choices, including a disabled global circuit. For the legacy 45-minute jobs, migrate no hard limit implicitly; use an earlier configurable business-work target (initially 25 minutes) with checkpoint/drain inside that limit. New explicitly configured longer jobs can span multiple cadence ticks without concurrency. Long model thinking after transport acknowledgement is not a blanket retry timeout.

### 9. UNKNOWN is effect-scoped, not a replay policy

Classify continuation only from reliable execution/effect evidence. Known pre-effect failure or exact completed result permits safe continuation; an uncertain external submission retains stable effect identity and enters read-only reconciliation. If an adapter supports an idempotency key, reuse it, but do not invent an exactly-once guarantee for arbitrary browser writes. Absent a reliable classification, keep the relevant writes held.

After the old executor closes, a provably independent already-authorized branch can continue while one effect awaits evidence or input. If conflict scope cannot be established, the job's business writes stay reconciling/attention-required; future status checks remain metadata/read-only and do not restart the same action. Missing MFA/consent/account input is not a retryable provider fault. User stop/disable, revoked authority and exhausted/expired bounds never auto-resume.

### 10. Versioned state and deployment sequence

Use schema4 for the new contract in the existing store. Keep schema1/2/3 reading and a pure preview/validation path. Migrate a store only after its affected writers/exact executions are quiescent; preserve private backup bytes and finite budgets. Current old code rejects unsupported versions, so stale writers must fail without touching schema4. Never silently keep schema3 while inserting incompatible states to make old code overwrite them.

Migration does not auto-enable legacy disabled UNKNOWN jobs because historical bytes may not prove whether a user later disabled them. Recovery is an explicit idempotent transition bound to the exact claim/evidence and original scope. Existing predecessor/successor chains remain retained; map only proven lineages to stable identity without summing unrelated counters. Owner transfer is atomic and does not replenish lifetime or UTC daily usage.

Roll out the native capability first, then the compatible Schedule package; synthetic integration can use an exact packed Pi candidate. Publish normal owner PRs/releases and verify fresh-download hashes/installed payloads. Preserve current package pins and old binaries. Safely switch only idle authorized runtime contexts; one shared store's mixed writers must converge before that store migration, without blocking other source tasks. The dedicated supervisor uses its existing config/identity/service contract; changing its pinned core/package/state configuration requires a deliberate supported safe transition, not editing an active host underneath it.

Package rollback must understand state. Before migration, restore prior software without changing original bytes. After new attempts, do not restore an old backup over activity; use a compatible reader/conversion preserving newer receipts or hold rollback with a concrete reason. No automatic launchd enrollment or global broker restart.

## Repository and verification mapping

Schedule: types/storage/scheduler/durable/index/tool/status, all affected UI entry points and fixed supervisor status/install compatibility. Reuse owner docs/reliable-scheduling.md and docs/durable-supervisor.md. Per-slice tests accompany their code, then `npm run check` with bounded workers, packing and isolated native fixtures.

Pi: coding-agent agent-session, extension types/runner and accepted custom-turn options; extend shared retry helpers/schema only when needed. Preserve intentional behavior and ordinary extension API compatibility. Read actual Pi docs/examples completely before editing affected APIs; use owner `npm run check`, applicable provider-free targeted tests and existing required CI (`build-check-test`, `mcp-conformance`). Do not call generic `npm test` in Pi. Keep model catalog/dependency pins and unrelated rate-limit fixes intact.

Optional consumer changes are justified by concrete failing integration tests, not by this roadmap alone. Existing Intercom one-shot reply cancellation, explicit-model jobs, legacy broadcast and Subagents independent handles stay within their original contracts. Optional Desk/Vista displays can be follow-up without delaying the execution repair.

## Acceptance matrix

Use fake clocks, synthetic state and faux providers, not paid live inference or private transcript fixtures:

1. Eighty-minute run/sixty-minute cadence; exact completion-relative delay; stable fixed-rate/cron anchors and timezone.
2. Busy skip versus one buffered occurrence; expired buffered intent; restart/sleep with many missed ticks; clock changes; explicit policy conflicts.
3. Two writers, owner transfer, older epoch receipt, slow/non-cooperative cancellation, stale deadline during a user turn, owned-child completion after parent.
4. Continuous equivalent provider faults and five intermittent faults; preserved request/tool history; long valid reasoning; cumulative retry budget and Retry-After.
5. Tools completed/final summary failed; native checkpoint without extra inference; wrapper denied during drain while checkpoint remains available.
6. External submission timeout, missing effect classifier, scoped independent work, required user challenge and stale status probes.
7. User stop/disable, expiry, lifetime/daily/fee bounds, admission counters versus model retries; no model/channel/global-setting mutation.
8. Unsupported native host; ordinary interaction and legacy feature compatibility; malformed/locked stores; schema3 to schema4 dry-run, mixed writers, interruption and state-aware rollback.
9. Readiness versus execution status, zero enabled jobs, notification failure and unchanged attention dedup.
10. Published/packed native plus Schedule integration and finite natural-task acceptance, recorded separately from source/unit greens.

## Risks / Trade-offs

- Fixed-delay reduces start frequency by execution duration → show explicit mode and delay, never reinterpret an existing hourly job silently.
- Unknown external effects cannot always be reconciled automatically → expose concrete local attention and keep only conflicting actions held; no false guarantee of uninterrupted writes during permanent provider outage or missing human input.
- Stable attempts and schema4 increase state requirements → reuse existing receipts/store, bound status payloads, reject old writers and validate migration/rollback before live use.
- Native scheduled policy can leak into user continuations if run binding is weak → opaque exact run/epoch plus lifecycle reset and explicit interleaving tests.
- Source tests do not establish real provider availability or every live session's loaded version → capability readback and authorized natural observations remain distinct evidence.

## Migration Plan

1. Finish per-slice tests/docs and source integration in the two isolated worktrees; independently review exact heads and pass applicable owner CI.
2. Publish immutable Pi/Schedule releases and verify fresh-download checksums, installed payloads and zero-real-provider integration. Do not change current active software beneath running sessions.
3. Inventory only the intended shared store's actual writers, legacy lineage/bounds and run handles; preview migration. Wait only on truly conflicting live resources.
4. At a safe supported point, verify loaded native capability/Schedule version, back up bytes and migrate atomically; verify unsupported-old-writer refusal and read-only projections.
5. Before continuing a prior UNKNOWN job, reconcile its exact checkpoint/effects with its business owner; preserve original remaining attempts, daily usage and expiry. Never repost or re-spend an uncertain effect for acceptance.
6. Observe 3–5 natural finite authorized occurrences, distinguishing runtime settlement from business acceptance. If an expiry/budget/technical condition prevents these observations, record that real limitation and keep the acceptance item open, not a fabricated green.
7. Use a state-aware rollback or retain a compatible held runtime; do not overwrite post-migration evidence. Archive this Change only after its real acceptance/owner requirements are met.
