---
doc_type: plan
project: pi-schedule-prompt
status: active
truth_mode: maintained
created: 2026-10-20
ssot: true
---

# Composed Pi automation rollout

## 1. Goal and current delivery

One operator can keep authorized goals moving across explicitly selected Pi sessions, using timed/event wakeups, visible evidence, bounded execution and restart reconciliation. This is not another general agent framework, permission system or project tracker.

The reliable timer foundation is delivered by PR #1, merge eb2a880fe8d1f7e98bdae041a69386a2955529d4. Local checks were 137 provider-free tests plus lint/typecheck/build; two isolated real-Pi-1.3-fork SDK fixtures passed. This proves source and isolated host compatibility, not installed/live multi-session operation. The earlier reliable-prompt-scheduling Change retains its pre-merge checkbox; the PR readback is its terminal evidence.

This document is the single overall roadmap. Implementation requirements/tasks live in openspec/changes/composed-automation-rollout/. Application facts remain here; other projects are linked, not assigned a duplicate task state.

## 2. Composition and authority

- pi-schedule-prompt owns time/event admission, pending intent and scheduling UI.
- The parent Pi session owns goal interpretation, next action, evidence checks and escalation.
- Intercom owns live peer discovery, exact-session messaging, explicit wake, receipts and replies.
- pi-subagents owns new bounded child execution, workflows, managed worktrees, Missions/Schedules and run recovery. Existing schedules must not be mirrored into this fork.
- Messenger owns Crew dependencies and reservations where a project already uses it. This rollout does not migrate every project to Crew.
- Vista may consume a separately sanitized projection. Neither raw cron:change nor stored prompts are its public input, and it cannot grant execution authority.
- The existing host/project rules remain authoritative. A stored task or event is not new user authorization; already authorized steps do not acquire extra approval ceremonies.

## 3. Fixed reference mapping

References are MIT-licensed designs, not installed dependencies or claims of upstream behavior in this fork. Retain attribution if code is copied. Prefer minimal original adaptations over a parallel execution engine.

| Reference | Pin | Adopted/needed mechanism | Local destination and status |
| --- | --- | --- | --- |
| tintinweb/pi-schedule-prompt | 5556775276202c26654ff9323541fe6983f6ee38 (0.4.1) | cron/interval/once, session binding and management | foundation delivered; native custom turns/coalescing/locking are maintained additions |
| Davidcreador/pi-routines | c54f09a27252f3638922f3d23e58f7287f756168 (source 0.6.0) | event-origin queue, dedup/backpressure, daily cap, pause-all-fire-paths, explicit missed-tick policy | stage C; lifetime maxRuns already exists, not a daily cap |
| pacoyang/pi-reactor | d77ddced1a80e283dce7d85e4f4cdc79c5f7f33c (0.2.3) | durable enqueue/claim, concurrency, deadline, safe failure classification, breaker, outbox, service lifetime | stage D; current task-file lock is not a durable execution claim |

Important differences: routines GitHub polling is not a complete CI event adapter. Reactor creates fresh sessions and has its own provider/credential setup; neither path is copied wholesale. Current expiresAt prevents new admissions, not active-run termination. Runtime SDK cost is observation, not a reconciled invoice or a hard money limit.

## 4. Stage A — foundation (delivered)

Native custom turns; busy tick coalescing; latest-definition admission; session binding; truthful queued/dispatched/unknown; paused persistence; private serialized validated storage; optional lifetime maxRuns/expiresAt; isolated SDK coverage. No offline catch-up, external event source or daemon yet.

## 5. Stage B — online supervision and fixed installation (delivered; real business pilot pending)

### Smallest implementation

Ship a bounded supervision prompt template and operations guide using the existing schedule_prompt + Intercom/Subagents tools. No new peer runner, protocol, roster database or duplicated goal state is needed for this surface. The supervisor keeps references to an existing goal/spec/task/PR, exact peer ids and expected repositories, expiry/check cadence and a maximum check count. These references describe the scope; they do not authenticate permission.

On each wake: re-list peers and confirm identity/cwd, distinguish busy/live-child/waiting-human/offline, inspect available current evidence, continue only a concrete authorized next step, and stop or escalate when the goal/limit/expiry is reached. No-op ticks stay quiet. Do not send generic repeated 'continue' messages, treat idle as failure, or make normal status messages request an echo.

Keep transport receipt, opening acknowledgement, execution and business verification separate. Existing peers need not install a new supervisor protocol: the parent uses their ordinary Intercom interface. Subagents completion events already wake their owning parent, not a remote supervisor.

### Installation and acceptance

Create immutable source-derived install payload/provenance/checksums, verify unpacked bytes and peer SDK resolution, and install into a dedicated supervisor context first. Preserve old packages/settings; do not hot-reload or restart business sessions. A fixed package on disk is not a runtime acknowledgement.

Acceptance sequence: provider-free tool/SDK tests; two isolated peers plus one timed supervisor with faux inference exercising wake/ack/evidence/stop; then a bounded real-session pilot only when selected peers, goals and completion evidence are concrete. User's rollout authorization covers implementation and necessary installation; missing pilot targets pauses that dependent live step, not all work.

Deliverable: a current-session timed supervisor genuinely advances two selected goals or reports their exact blockers, then stops at its declared boundary.

Stage B source was delivered through PR #2, main d18f298, with148 tests and Node22/26 PR/post-merge CI. Release v0.4.1-fork.2 was freshly downloaded/checksummed, installed into a permanent version directory, and passed3/3 installed-manifest component cases. A dedicated pinned launcher exists with zero targets/schedules; global settings and business sessions were unchanged. Real business-goal acceptance still requires selected peers/goals.

## 6. Stage C — event-driven admission and daily bounds (delivered)

Add optional event triggers to the existing job definitions rather than a second timer store. Begin with lifecycle and explicit local events; GitHub polling follows for actual PR/CI needs. A localhost authenticated API is optional and off by default, with bounded input and no arbitrary prompt/command from event payloads. Events select an existing task id; untrusted body text is data, not instructions or authority.

Common admission checks enabled state, task revision/owner, expiry, lifetime/daily counts, event identity, and pending/in-flight dedup. Daily counts use an explicit calendar/timezone convention. Retain only bounded dedup/history. Every trigger path honors pause. Each task chooses skip or latest-only missed occurrence; never unbounded replay.

Acceptance: duplicate events cause one admitted intent; events during busy work coalesce; paused/expired/capped tasks do not start inference; restart preserves the chosen missed/dedup semantics. Safe local fixtures first; external reads only for selected authorized repositories.

Stage C delivered PR #3, merge55796b2 and release v0.4.1-fork.3:184 source tests, Node22/26 PR/post-merge CI and9 installed component cases. No real external source/API was activated.

## 7. Stage D — durable unattended operation and recovery

The implementation envelope is opt-in durable session-bound jobs, the original schema3 store and exact native Pi receipt/owner handles, with one local durable slot. Existing interactive/broadcast modes remain compatible. The native RPC wrapper controls only its own child; selected port/config identity and live-child checks prevent duplicate takeover. Full behavior, bounds, missed-tick policy, pinned start/status/stop and opt-in launchd entry are in [the durable supervisor runbook](durable-supervisor.md).

Persist scheduled/event intents before effectful dispatch and claim them under a local single-owner lifecycle. Reuse existing execution handles; store references and uncertainty, not a copy of every child's transcript or task database. A dedicated long-lived Pi supervisor is controlled through the existing native SDK/RPC; do not attach to or write stdin of arbitrary TUI processes.

Provide a minimal user-level service entry (launchd on macOS) with explicit start/status/stop, fixed executable/cwd/package pins, concurrency and elapsed deadlines. Keep credentials in the existing trusted host path; do not copy user profiles or create a second credential store. A missed notification never proves the run did not execute.

After restart, reconcile exact run/message handles first. Reattach/resume only when the owning execution API proves eligibility. Unknown or potentially effectful failures pause for diagnosis; only provably pre-effect/idempotent failures use bounded backoff. Consecutive real failures can disable a schedule; budget refusal is not a business failure. Delivery outbox states stay visible; no false 'notified' on timeout.

Acceptance: controlled crash-before-dispatch, crash-after-dispatch, lost receipt, active child through parent restart, duplicate launcher, offline target, graceful stop and broken notification. No exactly-once claim for external side effects. Service/faux fixtures precede real small-scope rollout. Live machine reboot/OS sleep, 24/7 reliability and hard billing caps require their own evidence, not a unit-test inference.

## 8. Delivery discipline and stopping

Stages run in B → C → D order, each with an independently reviewable PR and exact-head tests/CI; installation and pilot results are reported separately. A missing dependent external condition does not block source work that can be independently validated. Keep one writer per worktree and do not mutate unrelated repositories just to make integrations look complete.

Model/provider/thinking inheritance and existing channel isolation remain unchanged. No automatic use of untrusted relays. Notify the user only for a concrete decision/permission/technical blocker, persistent failure or completion. Full source delivery is not live operation.
