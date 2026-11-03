# Tasks

This is the single implementation/acceptance checklist for both owner repositories. The user approved the complete refactor on 2026-11-03; ordinary implementation details and applicable validation/PR delivery do not need step-by-step reapproval. Check a task only against actual evidence; unresolved runtime acceptance stays open even after source CI passes.

## 1. Freeze baselines and the additive native contract

- [x] 1.1 Read existing owner/spec contracts and verify fresh clean maintenance baselines; evidence is Schedule `654cc84e0e08b907c579b58f89879b499e9bac86` and Pi `0903c552e926e29c739c982e728422a38c67a866`, with isolated worktrees and existing unrelated dirty trees preserved.
- [ ] 1.2 Read this complete Change and affected native docs/examples, confirm the designated writer/branch/index handoff, and verify `openspec validate resilient-serial-scheduling --strict --no-interactive` before runtime changes.
- [ ] 1.3 Define the minimal additive native execution capability and typed version negotiation in Pi, with a synthetic consumer proving exact run identity, missing-capability refusal and unchanged legacy `ctx.abort` behavior; document the contract in the existing SDK/extension owner docs.
- [ ] 1.4 Add provider-free characterization for ordinary interaction, completed tool history, one-shot/event/reply-follow-up/model-job and existing legacy interval behavior; verify these fixtures before changing their affected seams.

## 2. Implement native run-scoped budgets and safe closure in Pi

- [ ] 2.1 Bind accepted scheduled custom turns to an opaque native run identity and per-run policy without editing global SettingsManager state; tests must prove policy cleanup, source binding and no leakage into an interleaved user turn.
- [ ] 2.2 Reuse native retry classification/fingerprint/backoff for bounded scheduled response retries and cumulative recovery elapsed time; tests must cover continuous/intermittent overload, quota exclusions, Retry-After, cancellation and preserved completed tool results.
- [ ] 2.3 Separate soft work/drain and hard elapsed budgets from cadence and provider acknowledgement/streaming timeouts; fake-clock tests must prove productive runs can exceed cadence without extending a hard limit.
- [ ] 2.4 Provide exact-run drain/yield and acknowledged cancellation/settlement, retaining the slot while tools or explicitly owned handles remain alive; tests must cover slow/non-cooperative cancellation, stale run tokens and unrelated user turns.
- [ ] 2.5 Persist a native checkpoint from actual completed result entries at safe boundaries and close an interrupted/deferred run without an additional successful model summary; a faux-provider regression must reproduce completed tools followed by failed final prose without replay or false business success.
- [ ] 2.6 Update Pi's existing SDK/extension/settings/fork runtime docs for the capability and scheduled-only defaults, then run the affected targeted tests and owner `npm run check`; record exact head/input evidence without using real providers or generic Pi `npm test`.

## 3. Implement versioned Schedule intent, attempts and ownership

- [ ] 3.1 Add the legacy/resilient policy and discriminated intent/runtime/attempt types plus schema4 validation in the existing store; unit tests must reject inconsistent identities, invalid limits/policies and unsafe foreign-owner mutation.
- [ ] 3.2 Implement stable logical job identity, immutable attempt/receipt history and atomic exact-owner admission/release; race tests must prove one owner under concurrent acquisition, transfer and older-epoch receipts.
- [ ] 3.3 Represent running/draining/cancelling separately from final effect uncertainty, retaining persistent and in-memory protection until exact native closure; restart and cancellation-race tests must fail any early replacement attempt.
- [ ] 3.4 Preserve lifetime/daily/expiry accounting across recovery and proven legacy successor lineage; tests must distinguish skipped ticks/request retries from admitted business attempts and forbid budget replenishment.
- [ ] 3.5 Document the state and ownership model in existing Schedule owner docs and run storage/durable/status regressions for this slice; keep old UNKNOWN records untouched.

## 4. Implement explicit recurrence and bounded pending work

- [ ] 4.1 Implement fixed-delay arming from exact safe finish and persist next eligibility; fake-clock tests must cover long runs, confirmed failures, restart and stop/update without duplicate timers.
- [ ] 4.2 Implement stable fixed-rate anchors and persisted effective cron timezone; tests must cover late execution, process timezone changes and wall-clock jumps without silently changing the original mode.
- [ ] 4.3 Implement overlap skip and first-occurrence buffer-one with bounded lateness; tests must prove repeated busy ticks neither infer concurrency nor create more than one waiting execution.
- [ ] 4.4 Separate misfire skip/latest from overlap and combine cadence with cooldown, daily caps and expiry; restart/sleep fixtures must prove at most one permitted catch-up and no charging for discarded intents.
- [ ] 4.5 Add canonical mode/policy management to tool and existing UI paths with clear completion-delay semantics and conflicting-input validation; test create/update/list/reload behavior and document the examples.

## 5. Implement truthful checkpoint, recovery and backoff in Schedule

- [ ] 5.1 Negotiate and consume the real native execution capability for inline and supported explicit-model recurring jobs; faux SDK tests must reject unsupported hosts before admission rather than silently falling back to unsafe control.
- [ ] 5.2 Replace resilient jobs' error-to-disabled coupling with user intent plus persisted backoff/reconciling/waiting-input dispositions; tests must preserve user stops and finite bounds while keeping transient failures recoverable.
- [ ] 5.3 Implement native checkpoint consumption, draining and safe local checkpoint access without arbitrary wrapper bypass; combined tests must reproduce both historical failure patterns and failed final-summary recovery without tool replay.
- [ ] 5.4 Implement exact effect/checkpoint reconciliation and idempotent authorized continuation; synthetic submission-timeout tests must preserve UNKNOWN, query original results, block conflicting writes and allow only provably independent already-authorized work.
- [ ] 5.5 Expose exact attempt, phase, reason, next eligibility and waiting condition through bounded read-only status/supervisor/UI projections; tests must cover notification failure, unchanged attention dedup, zero-job readiness and no extra model wakes.
- [ ] 5.6 Update existing Schedule operational/reliable-scheduling docs and run all affected scheduler/recovery/UI/status regressions; any optional Intercom/Subagents changes must be tied to a demonstrated compatibility failure, not added as an unrelated prerequisite.

## 6. Validate migration and packed cross-repository compatibility

- [ ] 6.1 Implement pure schema1/2/3 preview and explicit schema4 migration with backup/reference preservation; fixtures must prove disabled UNKNOWN jobs are not auto-enabled, legacy lineage is traceable and corrupt/locked input bytes survive failure.
- [ ] 6.2 Refuse mixed old writers without version downgrade and migrate only the affected quiescent store; multi-process fixtures must verify active-owner holds and no interruption of independent stores.
- [ ] 6.3 Implement state-aware rollback/compatibility readback and test post-migration activity preservation; do not call stale-byte restore over newer attempts a successful rollback.
- [ ] 6.4 Run Schedule `npm run check`, package/installed faux-native fixtures and exact packed Pi candidate integration against all four capability specs; test legacy host refusal and ordinary interactive behavior without paid calls.
- [ ] 6.5 Refresh current remote bases and integrate applicable in-flight Pi fixes normally, preserving unrelated work; rerun only affected checks and bind evidence/review to the resulting exact heads.

## 7. Review and deliver source through existing owner gates

- [ ] 7.1 Return exact diffs/heads, test originals, failed/unknown cases and remaining acceptance to the coordinating session for independent read-only source review; verify no self-review is represented as independent approval.
- [ ] 7.2 Address concrete same-scope findings and create ordinary owner PRs linking this single Change and companion revision; require actual exact-head owner CI, including Pi `build-check-test` and `mcp-conformance`, without bypass or direct main push.
- [ ] 7.3 Complete authorized normal merges and post-merge readback for both repositories, reusing valid evidence and preserving strict head freshness; report source/CI status separately from release or loaded behavior.
- [ ] 7.4 Produce immutable fork releases through owner packaging procedures and verify fresh-download manifest/SHA-256 and installed payload compatibility; do not rewrite published tags/assets, provider settings or files beneath running processes.

## 8. Safely activate and verify the approved finite runtime scope

- [ ] 8.1 Inventory intended runtime/store writers and loaded capabilities at a safe checkpoint, preserving active business tools/children; verify supported install/supervisor identity transition and prior rollback pointers without forced global reload or broker restart.
- [ ] 8.2 Preview, back up and atomically migrate only the approved quiescent store, then verify exact runtime/status/policy readback; unresolved resource conflicts hold only this activation, not independent delivery.
- [ ] 8.3 Reconcile each explicitly selected historical UNKNOWN claim/checkpoint with its business owner before future continuation; verify original effects are not replayed and remaining lifetime/daily/expiry bounds match the preserved baseline.
- [ ] 8.4 Observe 3–5 natural authorized finite occurrences for mode, serial ownership, checkpoint, fault/backoff and real settlement; keep business completion separately verified and leave this item open if expiry, input, availability or insufficient natural samples prevents acceptance.
- [ ] 8.5 Report implementation, tests, merges, releases, disk installs, loaded versions, migration and natural/business acceptance separately with exact evidence and real unresolved conditions; verify no optional UI/platform work was silently made a new prerequisite.

## Workflow follow-up

- Archive this owner Change with the official CLI only after applicable owner review and actual tracked acceptance are satisfied; do not check off unobserved natural acceptance to make archive green.
- Optional Desk/Vista read-only presentation can reference the delivered state contract in a later scoped change. It is not part of the execution repair's minimum delivery gate.
