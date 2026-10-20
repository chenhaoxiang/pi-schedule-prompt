---
doc_type: runbook
project: pi-schedule-prompt
status: active
truth_mode: maintained
created: 2026-10-20
---

# Online supervision

## Contract

Use `/supervise` in a dedicated owning Pi session, with exact peer ids and expected repositories, existing goal/spec/task/PR references, completion evidence, cadence, expiry and max checks. The prompt is an orchestration recipe, not a new runtime executor or permission source. Scheduled custom turns do not expand slash commands: the recurring prompt must be cold-start complete, not just `/supervise`. Do not silently bind to every live session.

The controller uses the existing Intercom tool to re-list peers, confirm exact identity/cwd, ask for missing scoped context and request only concrete authorized next actions with explicit wake. Busy with active children is not stalled; offline is not permission to open a replacement. A short opening acknowledgement is not completion. Read current artifact/test/PR evidence before marking a goal verified. Stop the known schedule on goal completion, expiry/check limit or user pause.

New bounded work uses existing Subagents. Existing peer children stay peer-owned. Crew/task/PR state remains with its existing owner; no duplicate goal database or all-session transcript scanner is introduced. A raw event or persisted prompt cannot expand authorization.

## Fixed installation

Build and pack the exact reviewed source into a versioned permanent package directory with provenance and SHA-256 checksums. Host SDK peers remain host-owned, never bundled copies. Use scripts/pack-fixed.mjs from clean reviewed source, then scripts/install-fixed.mjs with the externally checked source SHA and PI_SCHEDULE_HOST_PACKAGE_DIR pointing to the exact maintained host. The installer verifies payload bytes, hydrates only exact production dependencies with lifecycle scripts disabled, and links SDK peers to that host without copying them. The private receipt records the canonical host path and version; reuse also re-verifies all SDK symlink targets. Production dependency hydration uses the source-lock integrity entries via npm ci, not merely a fresh version resolution; checksums/provenance are integrity evidence, not independent source authentication. A dedicated supervisor loads the explicit fixed extension and prompt paths, or its own scoped settings; do not automatically edit global settings or reload existing business sessions. Installation is not activation. Keep the prior package/config for rollback.

The native launcher remains the maintained Pi CLI. Select the already-approved provider/model/thinking explicitly when a dedicated session must match the current parent. This extension must not choose another cheaper model or untrusted relay. A supervisor with no selected targets must remain idle.

## Provider-free component integration

`test/online-integration.test.ts` spawns a fresh isolated process and real Intercom broker using a fixed dev-only fork dependency. The actual Pi SDK creates three independent sessions: one timed supervisor, two peers. Faux inference calls the real Intercom send, native write/read and schedule disable tools. It writes two synthetic results, independently reads those artifacts, completes a second timed check and proves no further check fires. Separate offline and cwd-mismatch cases prove a missing peer is reported without a replacement session and a mismatched repository receives no work. The list tool displays bounded id prefixes; the harness confirms full ids against the isolated broker and dispatch uses those full ids. Reported counts derive from observed session/task state.

Installed acceptance can set PI_SCHEDULE_PACKAGE_ROOT to load the package through its pi.extensions declaration and verify the supervise prompt is discovered; fixture logs record the selected host version, entry and manifest route. Source import and direct dist import are distinct verification routes.

No live broker, real credential/profile, private history, paid inference or business session is used. Fixture processes/agent directory are owned and cleaned by the test. Unix sockets require short paths outside repository/node_modules ancestors; use PI_SCHEDULE_FIXTURE_ROOT under a dedicated tmp/ directory. CI supplies runner.temp/tmp/pi-schedule-online; local fallback is the OS temporary directory under tmp/sp. Logs and package outputs stay in the owner worktree tmp/.

This scripted faux-provider test proves component wiring and failure/stop behavior. It does not prove that an arbitrary model can judge business progress, that real projects have completed, or that the template is an autonomous product acceptance.

## Real selected-peer pilot

After fixed-package loading and the same isolated tests pass, select two concrete peer goals and verify the original action/acceptance scope. Record only bounded evidence pointers and observed results. Do not call the pilot complete if peers, current goals, or permission for necessary external actions are missing. Continue independent event/recovery implementation rather than inventing pilot success.

## Rollback

Disable the supervisor schedule, stop only its dedicated owning session/service, and point that dedicated context at the prior fixed package. This does not stop or roll back peer tools. Preserve interrupted/unknown handles for reconciliation; do not reset repositories, delete shared state, or terminate the shared Intercom broker.
