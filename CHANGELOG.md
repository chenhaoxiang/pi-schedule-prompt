# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.1-fork.2] - 2026-11-22 (recovery hardening; source/activation separate)

- Bind resilient continuation, checkpoint, settlement and late-receipt evidence to the exact session, transcript, cwd, attempt and owner metadata; reject mismatched or conflicting restore receipts.
- Require persisted checkpoint/session-file and final native/SDK closure evidence before releasing a resilient model attempt, preserving ambiguous effects as attention-required instead of replaying them.
- Keep the `0.5.1-fork.1` package and installation available for rollback. This release changes source/package selection only; it does not migrate live stores, edit settings, reload active sessions or start monitoring.

## [0.5.1-fork.1] - candidate (community v0.5.1 full integration; source/activation separate)

- Integrate the community v0.5.1 idle job type, inactivity lifecycle signals, local-offset display and duplicate-name/tool guidance fixes while retaining the fork's event, durable, resilient, native-guard, UNKNOWN and reconciliation contracts.
- Adopt the per-project agent-dir store layout with canonical project hashing, legacy-store preview/import APIs, explicit source/target fingerprints and rollback HOLD behavior. Startup does not silently copy a legacy store; maintenance-window cutover remains a separate operation.
- Keep fork peer compatibility, schema4 safeguards, one-active-writer semantics, provider-free verification and fixed-installation boundaries. This candidate does not modify the current main installation, settings, live store or running sessions.

## [0.4.1-fork.23] - 2026-11-18 (selective community v0.5.1 backports; release/activation separate)

- Backport the safe community protections already compatible with the maintained schema4 fork: exact duplicate-name rejection on job update, bounded far-future one-shot re-arming, and actionable interval range validation.
- Show one-shot/next/last timestamps in local wall-clock time with an explicit UTC offset while retaining UTC ISO persistence.
- Improve schedule tool guidance without enabling community v0.5.1 idle jobs or changing the fork's per-project store, native guard, UNKNOWN/reconcile or task lifecycle contracts.
- Defer community v0.5.1 per-project store migration, idle scheduling and broad scheduler lifecycle changes pending a separate compatibility/migration change; no real store or job was migrated.

### Development installation (source only)
- Opt into npm12 root-declared URL dependencies at project scope for the existing exact-commit/SRI-pinned pi-intercom test dependency; retain transitive-URL denial and lifecycle-script suppression without modifying user/global config files; environment/CLI precedence remains.
- Verify fresh dependency installation and synthetic default-deny/root-allow/transitive-deny cases; retain Node22 compatibility and pin npm12.2.2 for the Node26 CI lane. Existing runtime Release assets and installations are unchanged.

### Maintained fork 0.4.1-fork.22 (2026-11-11; retirement/activation separate)
- Add a separate explicitly authorized offline operator preview/CAS CLI for an exact expired, idle model job with matching original native/SDK closure; preserve normal foreign-session guards.
- Change only enabled intent after locked closure verification and a private backup; retain owner, UNKNOWN, attempts, budgets, limits and unrelated jobs. Never revive the retired session, reconcile effects or replay work.
- Accept npm12 keyed pack JSON as well as the preceding array format, requiring one exact package identity before producing provenance.

### Maintained fork 0.4.1-fork.21 (2026-11-10; activation separate)
- Reject ignored reconcile fields, including schedule, before changing effect resolution. Plain continue still means immediate checkpoint continuation, not an interval reset.
- Add explicit native continue-delayed with resumeAfterMs (1s–24h), bound to the original exact effect resolution. Existing persisted notBefore enforces the minimum wait before normal cadence/provider/day/expiry admission; retry/restart never renews it. Older tools reject the new resolution instead of silently dropping the delay.
- Preserve cadence after a short delay expires before enable/update; compatibility holds cannot erase timing. Derive lost timing projections from the immutable resolution at planning and admission, without claiming old scheduler writers are upgraded.
- Delayed reconciliation can remain disabled and later be explicitly enabled without misclassifying a pause as exhausted authority. Preserve legacy immediate-continue stop projection, exact closure/effect evidence, immutable UNKNOWN, counters and expiry; no real-job migration or forced reload.

### Maintained fork 0.4.1-fork.20 (2026-11-10; activation separate)
- Admit independent explicit-model work while its parent is busy or has pending messages; a queued inline intent cannot starve a later model job. Inline work still waits for an idle parent, and existing single-flight, claim/UNKNOWN, attempt/expiry and SDK-close boundaries remain.
- Make legacy model start/completion markers explicitly non-triggering unless completion notification was requested, preventing accidental extra parent inference while it is streaming.
- Route a model start-persistence failure only to that child controller, retaining its exact hold until release rather than aborting unrelated parent work. Inline failure handling is unchanged.
- Cover durable timers, ordinary/durable events, resilient model/inline paths and exact failure routing with synthetic regressions; an actual SDK/faux-provider case verifies child completion before the parent tool returns, then normal parent completion without an extra request. No existing job/store migration, real provider call or forced active-session reload.

### Maintained fork 0.4.1-fork.19 (2026-11-06; activation separate)
- Add an explicit `pull-request-checks` GitHub event selector over one PR’s current exact head, bounded latest check runs and legacy status contexts, with a final PR-binding recheck.
- Fingerprint closed metadata only; reject incomplete/oversized/foreign/changing snapshots, ignore response ordering and comment/output text, and preserve existing seed/quiet/ownership/pause/budget behavior.
- Notify once on the new selector’s first valid snapshot to handle CI that completed before enrollment; retain no-change dedup and none/latest restart policies.
- Events wake the original owner to recheck applicable review/CI and delivery authority; no automatic merge decision, required-check inference, extra executor or old-job migration. Existing PR/workflow selectors are unchanged; old runtimes refuse the new selector.

### Maintained fork 0.4.1-fork.18 (2026-11-06; activation separate)
- Accept explicit native `thinkingLevel: max` in fixed supervisor configuration and forward it unchanged, instead of rejecting a level supported by the current Pi host.
- Keep omitted-level inheritance, invalid-level rejection, model/host checks and execution bounds unchanged. Native/model support and actual loaded thinking still require runtime readback; no automatic downgrade or active-session reload.

### Maintained fork 0.4.1-fork.17 (2026-11-06; activation separate)
- Preserve the existing optional evidence fingerprint through the public event trigger and trusted local event bus, so configured unchanged-evidence suppression works without a second scheduling path.
- Keep invalid payload rejection, ordinary event-id behavior, owner/limit/quiet rules and UNKNOWN recovery unchanged.
- Add isolated native SDK write/read artifact verification and explicit stop/readback coverage; synthetic execution is not live business acceptance.

### Maintained fork 0.4.1-fork.16 (2026-11-06; source/installed/natural acceptance separate)
- Add an opt-in native read-only builtin tool profile through the existing Core CLI registry filter, with actual active/registered provenance verification before scheduler restoration and final reserve/admission as well as service readiness; do not use prompt-only restrictions, shell whitelists or unrestricted model children.
- Resume an explicitly selected existing canonical native session file with the same id/cwd and preserve history/checkpoints/results through a normal owned-host transition; never copy history, clear UNKNOWN or reset spending/expiry.
- Expose bounded actual tool loadout/session-file metadata through the existing runtime/service status, retaining unknown observations and refusing overridden builtins.
- Add provider-free real SDK and pinned real-CLI/faux-provider exact-file continuation, hard forbidden-tool, late/deferred/MCP and wrapped-reader rejection checks; synthetic rounds are not live natural acceptance.

### Maintained fork 0.4.1-fork.15 (2026-11-05; loaded/natural acceptance separate)
- Hand off unattended input/budget enforcement only to an actual native input-guard-v1 capability with an exact active run binding; detach only Schedule's legacy tool hook and restore it after native settlement or on ordinary/legacy work.
- Preserve old-host/no-unsubscribe/unknown-identity safety, arbitrary third-party call/result hook UNKNOWN, immutable history and all execution bounds.
- Expose actual unattendedInputGuardVersion in existing runtime metadata, not a version-derived claim.

### Maintained fork 0.4.1-fork.14 (2026-11-04; source candidate, live acceptance separate)
- Preserve complete legacy recovery spending across an explicitly evidenced cross-session handover; retain disabled predecessors and reject mismatched, duplicate or unused handover tuples without rewriting their original claims.
- Add exact migrated-legacy claim reconciliation through the existing owning-session tool/API, without fabricated native history, automatic enablement, replacement jobs, replay or new lifetime/daily/expiry allowance.
- Report bounded loaded Schedule/native/registered-work metadata through existing status paths; distinguish bound SDK from actual Core and leave unobserved SDK resources explicitly unknown.
- Add provider-free full-ancestry, future-only, negative-evidence and actual SDK installed-package regressions.

### Maintained fork 0.4.1-fork.13 (2026-11-04)
- Declare the imported Pi SDK packages and typebox as wildcard host peers; keep exact typebox only in development dependencies, not the fixed runtime payload.
- Bind fixed installations to the selected host's actual resolved typebox package (hoisted or nested), validate its declared name/version and exact path, and reject independent replacement copies or changed reuse bindings.
- Remove the host-provided dependency warning without suppressing diagnostics or changing scheduling/runtime behavior; preserve canonical Pi1.3/1.4/1.5 support and existing immutable installations.

### Maintained fork 0.4.1-fork.12 (2026-11-04; source candidate, release/install acceptance separate)
- Add explicit resilient recurrence with native v1 capability negotiation, exact serial attempt ownership and run-scoped work/recovery/hard budgets; preserve legacy scheduling when no resilient mode is selected.
- Separate fixed-delay/fixed-rate cadence, cron timezone, overlap and misfire policies from execution deadlines, with bounded pending work and preserved lifetime/daily/expiry limits.
- Persist native completed-result checkpoints and retain model-child ownership through exact SDK close acknowledgement; uncertain effects require exact owner reconciliation, never automatic replay.
- Add canonical tool/TUI management and bounded status, explicit schema4 preview/quiescent migration, and state-aware rollback assessment that cannot restore stale backups over newer activity.
- Bind fixed installation to canonical Pi1.3/1.4/1.5 exact peers; unsupported native hosts hold without spending an attempt. Source, release, loaded runtime and natural/business acceptance remain distinct.

### Maintained fork 0.4.1-fork.11 (2026-11-01; supersedes local-only fork.10 candidate)
- Add absolute per-round time budgets and a native tool-boundary wind-down reserve inside the unchanged hard deadline; preserve local checkpointing and prevent new long/effectful work during finalization.
- Preserve exact interruption reasons in receipts, claims, notices and read-only status.
- Add explicit idempotent future-only recovery for finite recurring timed jobs: retain old UNKNOWN evidence, subtract spent lifetime attempts, carry daily usage/expiry, and never replay missed or uncertain effects.

### Maintained fork 0.4.1-fork.9 (2026-10-31)
- Keep read-only host-status probes on the native metadata side channel so a status check cannot steer or extend a scheduled model turn.

### Maintained fork 0.4.1-fork.8 (2026-10-31)
- Expose bounded native-service/job health summaries that distinguish online readiness, enabled/disabled state, last outcome and stale UNKNOWN claims without exposing prompts or transcripts.
- Add a read-only `supervisor.mjs reconcile <config> <jobId>` inspection path and one-time, state-backed attention metadata; it never replays, enables or marks business work complete.
- Keep service/runtime pointers explicit in the fixed supervisor status and preserve exact claim/receipt evidence across restarts.

### Maintained fork 0.4.1-fork.7 (2026-10-31)
- Block unattended scheduled turns from opening `ask_user_question` dialogs before tool execution, returning a local input blocker instead of waiting until the durable deadline aborts.
- Preserve exact-claim input-required metadata in native receipts without changing elapsed deadlines, UNKNOWN recovery, attempt budgets or ordinary user-turn questions.

### Maintained fork 0.4.1-fork.6 (2026-10-30)
- Preflight explicit model jobs against the current authenticated model registry and persist the canonical `provider/model-id` route; reject unknown or ambiguous bare ids before saving or firing.
- Include the reviewed opt-in no-change quieting and fixed supervisor extension-discovery isolation from the maintenance main branch.

### Maintained fork 0.4.1-fork.5
- Bind optional Intercom reply follow-ups to the existing session-bound schedule store with exact message/request/goal/phase identity.
- Enforce finite one-shot delay/deadline/expiry and `maxRuns=1`; deduplicate active bindings and reject a second loop covered by an existing schedule.
- Cancel exact replies with persisted readback, purge queued work and re-check state before due transport; preserve `unknown` for restart, disconnect, late reply and uncertain delivery.
- Keep ACK/PENDING and transport/wake receipts separate from execution and business completion.

### Maintained fork 0.4.1-fork.4
- Add opt-in session-owned durable timers/events with schema3 intent/claim metadata, exact native execution receipts and conservative restart reconciliation.
- Bound local durable concurrency/deadlines and pre-effect contention retries; pause ambiguous/aborted work, stop after three confirmed errors and retain notification delivery separately.
- Package a fixed native Pi RPC service with config/binary/installation/session pins, authenticated loopback status/confirmed stop, duplicate/orphan protection and opt-in launchd output.
- Preserve normal host guards/resources/credentials and legacy interactive jobs; no global setting change, generic effectful retry, business target enrollment or auto-approved UI consent.

### Maintained fork 0.4.1-fork.3
- Add session-owned event jobs with existing tool/local bus/lifecycle ingress and non-recursive settled events.
- Persist bounded dedup/pending intent and content binding, UTC daily admission caps and none/latest restoration; new writes use store version2.
- Add explicitly configured metadata-only GitHub sources with bounded GET/backoff, and an optional authenticated loopback API that only selects existing api: jobs.
- Keep event payloads out of prompts and preserve native custom-turn execution; no external source is activated by default.

### Maintained fork 0.4.1-fork.2
- Add a single sequential automation roadmap with pinned routines/reactor reference mapping.
- Package the bounded /supervise recipe using existing Intercom/Subagents tools, without a second goal database or runner.
- Verify online two-peer progress/evidence/stop and offline behavior through real SDK tools and an isolated real Intercom broker with faux inference.
- Add fixed payload/provenance packing and verified versioned installation helpers; do not edit global settings or reload business sessions.

### Maintained fork 0.4.1-fork.1
- Move maintenance to main and preserve pure community upstream-main.
- Target Pi 1.3 with pinned SDK/toolchain and provider-free CI on Node 22/26.
- Dispatch inline jobs as native custom turns, coalesce busy ticks, preserve paused jobs and report dispatched/unknown truthfully.
- Add lifetime maxRuns/expiresAt admission controls, serialized validated private storage and foreign-session management protection.
- Retain explicit model jobs with current SDK provider setup, no same-job overlap, self-extension exclusion and session disposal.
- Add reliable scheduling and real-SDK faux-provider regressions, bilingual fork guidance and scoped design.

## [0.5.1] - 2026-11-16

### Added
- `idle` job type: `schedule` is a duration (`10m`, `1h`). The job fires once after the user has been inactive that long, as soon as the agent is idle, then waits for new user activity (a message, `!` command or abort) before it can fire again. Idle is tracked with pi's `agent_settled` event, so retries, compaction retries and queued follow-ups count as busy; if pi is busy without a run (e.g. a manual `/compact`), a due job re-checks every 5s. The clock measures user inactivity: it restarts after your own turns, aborts, `!` commands and closed dialogs, not after scheduled turns, so frequent scheduled jobs can't starve it. Question dialogs (select, confirm, input, editor) pause it; overlays don't, so a long-lived panel can't block idle jobs. In the Jobs view each key press restarts the clock and the add flow pauses it. Its own scheduled turn, or an edit to it, never re-arms it; a job added or re-enabled waits its full duration. The widget shows a countdown while it is armed. Works with `model` like other job types ([#21](https://github.com/tintinweb/pi-schedule-prompt/issues/21)).

### Changed
- `schedule_prompt` tool and parameter descriptions rewritten. Weaker models called the tool with `type: "once"`, `schedule: "+1s"` and a `model` to spawn parallel workers; the description now leads with when to use it (a time or user-inactivity trigger) and says to do immediate work directly. It also states rules the model was never told: `type` must match the schedule format, units and limits, how a fired prompt is delivered, what a `model` job's separate session can see, the recursion guard, what `update` and `cleanup` do, and that `type` cannot be updated. Model-visible results and errors say "separate session" instead of "subagent". Based on [#20](https://github.com/tintinweb/pi-schedule-prompt/pull/20) by @brycelelbach.

### Fixed
- `update` rejects renaming a job to a name another job already has, matching `add`.

## [0.5.0] - 2026-11-16

### Changed
- **Breaking**: jobs moved from `<cwd>/.pi/schedule-prompts.json` to `<agentDir>/schedule-prompts/projects/<sha256(realpath(cwd))>.json`, the layout pi-subagents uses for per-project state. The store now follows `PI_CODING_AGENT_DIR` (each pi profile has its own jobs) and stays per project, so shared jobs still fire only in their own project. When pi trusts the project, its old file is merged in once (jobs already in the new store win on an id clash) and kept as a backup; a store records the import, so a project trusted only later still imports. Each project migrates on its own.
- **Breaking**: peer dependency floor raised to pi `>=1.5.0` (`@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui`); dev dependencies now test against 1.5.2. `typebox` added as a peer (pi supplies it to extensions at runtime).
- `Type`/`Static` are imported from `typebox` again, reversing the 0.4.0 change: pi-ai 1.5 no longer re-exports TypeBox. `StringEnum` is now a local helper with the same `{ type: "string", enum }` output as pi's, because pi-ai's own export returns a pi-schema type that TypeBox's `Static` cannot infer.

### Fixed
- Subagent jobs run on the parent session's model runtime again. Since pi 0.80.8, `createAgentSession` ignores the `modelRegistry` option we passed, so each subagent built a fresh runtime from `auth.json`/`models.json` and lost providers registered by other extensions and runtime-only API keys. The runtime is now passed as `modelRuntime`, read from `ctx.modelRegistry` (pi has no public accessor); if that is unavailable, pi's default runtime is used and a one-time warning is logged. Jobs with `extensions` enabled keep a separate runtime, so subagent extensions cannot overwrite or remove the parent session's providers.
- Subagent sessions are now torn down after each run, including on error, the same way pi tears down its own sessions: any in-flight run is settled, loaded extensions get `session_shutdown` (so e.g. MCP servers and child processes they started are stopped), then the session is disposed. Previously every fired subagent job left a live session (listeners, extension runner, cache-warmer timer, extension child processes) behind for the life of the pi process. Teardown errors are logged and never turn a successful run into a failure, and each teardown step is capped at 5s so a hung extension shutdown cannot leave a job stuck in "running".
- A subagent job whose abort signal fired during setup no longer runs its prompt anyway: aborting an idle pi session is a no-op, so the job now returns early, before creating the session or starting its extensions. A job aborted mid-run now returns `ok: false` instead of `ok: true` with partial text.
- Aborting a subagent job while its prompt is still in preflight (input hooks, auth check / OAuth refresh) now stops it. pi clears the abort flag when the run starts, so the model call and its tools used to run anyway after the scheduler stopped.
- Subagent extensions only get `session_shutdown` if they may have received `session_start`: a job aborted before its extensions were bound no longer sends an unpaired shutdown, and a job whose `bindExtensions` throws after `session_start` (e.g. on a malformed resource path) still shuts its extensions down.
- On pi shutdown, the `session_shutdown` handler now waits for in-flight subagent runs to finish tearing down, including runs from a scheduler replaced by a repeated `session_start` (a defensive path; pi always sends `session_shutdown` first). pi exits right after `session_shutdown` handlers resolve, so subagent extensions' cleanup (e.g. stopping MCP servers) used to be cut off. The wait is capped at 10s, so a run stuck in setup (e.g. an extension whose `session_start` never resolves) cannot hang quit. `CronScheduler.stop()` now returns a promise that settles once its runs' teardown is done.
- Aborting a running subagent job no longer leaves `session.abort()` promises unhandled.
- `nanoid` raised to `^5.1.16` (security advisory).
- Project files are found through pi's `CONFIG_DIR_NAME` rather than a hardcoded `.pi`, so builds that rename the config directory work.
- One-shot jobs scheduled more than ~24.8 days ahead now fire at their scheduled time instead of immediately. They used `setTimeout`, which Node caps at 2³¹−1 ms and replaces longer delays with 1 ms; they now use `croner`, which waits in chunks of at most 30s. Pending one-shot jobs also show their next run time in the widget, jobs view and `list` output (#18).
- Intervals longer than ~24.8 days (e.g. `30d`) are now rejected with a hint to use a cron expression. Node replaced the delay with 1 ms, so these jobs fired every millisecond. Stored over-limit intervals are disabled on load instead of scheduled.
- Times are shown in local time with their UTC offset (e.g. `2026-11-16 10:30:00 -03:00`) instead of raw UTC ISO strings: next and last run in the jobs view and `list` output, last run in the tool renderer, one-shot schedules in `add`/`list` output, and the past-timestamp error. Stored values stay UTC (#11).

### Security
- Project-local files follow pi's project-trust decision (`ctx.isProjectTrusted()`), as pi's extension docs ask: the one-time import of a legacy `.pi/schedule-prompts.json` and the project settings file `.pi/schedule-prompts-settings.json` are skipped when pi does not trust the project. Jobs themselves no longer live in the repo, so a checkout cannot add jobs after the import. Limitation: pi does not count these files as trust-requiring, so a repo whose `.pi/` contains nothing else is trusted automatically, without a prompt, and its legacy file is imported. Projects with a saved "do not trust" decision, or with pi's own protected files (`.pi/settings.json`, `.pi/extensions`, …), are covered.

## [0.4.1] - 2026-06-23

### Added
- Per-job `extensions` and `skills` fields on subagent jobs (closes #13). Each accepts `boolean | string[]`: `true` loads all registered extensions/skills, an array loads only the named ones, and unset or an empty array loads none (default — current behavior unchanged). Plumbed from the `schedule_prompt` `add`/`update` tool params through `CronJob` to `runSubagentOnce`, which drives `noExtensions`/`noSkills` and `extensionsOverride`/`skillsOverride` on the resource loader
- Enabling `extensions` also switches the subagent from the default builtin toolset to the full set (`tools: undefined`) and calls `session.bindExtensions()` — both are required for extension-provided tools to activate (e.g. MCP, Telegram). `skills` does not widen the toolset: skills surface via the system prompt and the `read` tool. Both fields are no-ops for inline (no-model) jobs

### Fixed
- Widget no longer crashes rendering a job with an undefined `runCount` (now defaults to `0`)

## [0.4.0] - 2026-05-31

### Changed
- **Breaking**: pi runtime packages migrated from the `@mariozechner/*` scope to `@earendil-works/*`. Peer deps are now `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, with the floor raised to `>=0.74.0`. Import paths in `src/` updated accordingly.
- `Type`/`Static` are now imported from `@earendil-works/pi-ai` (which re-exports them from `typebox`) rather than the `typebox` package directly — using a single typebox identity avoids a `TUnsafe` portability error in the inferred tool-param type. Dropped the direct `typebox` dependency.

## [0.3.0] - 2026-05-03

### Added
- Per-session job binding (closes #5): each job has an optional `session` field on `CronJob`. Jobs without a `session` field still load in every pi running in the cwd — the explicit opt-in to "any pi runs it" (useful for hand-edited project-wide cron; accepts duplicate fires)
- `defaultJobScope` setting (`"session"` | `"workdir"`) controls whether newly-created jobs are bound to the creating session. Toggle via `/schedule-prompt → Settings → Bind new jobs to session`; persists in the existing two-layer settings file
- Defensive re-read at dispatch: `executeJob` / `executeJobInSubagent` re-read the job from storage before firing and bail if it's been removed, disabled, or rebound to another session mid-tick
- `CronScheduler.validateSchedule(type, schedule)` — single source of truth for schedule validation, shared by tool `add`/`update` and the UI. `CronScheduler.describeSchedule(type, schedule)` renders a humanized form for confirm dialogs and the widget
- `/schedule-prompt → Add New Job`: the schedule step re-prompts on validation failure instead of bailing the whole flow — the user no longer loses name, type, and prompt to a single typo
- `/schedule-prompt → Add New Job`: confirm dialog with the humanized schedule before save (e.g. `Schedule: daily at 9:00`), so a typo'd cron expression like `0 9 * * * *` (every minute past hour 9) doesn't silently get saved as if it were `0 0 9 * * *` (9am daily)
- `/schedule-prompt → Add New Job` now accepts relative time (`+5m`, `+10s`) and rejects past / too-soon timestamps with the same messages the tool uses; previously the manual flow only accepted ISO strings
- Add flow now asks per-job whether to bind to this session or share with every pi in this cwd. The choice is pre-listed by the global `defaultJobScope` setting (so hitting enter takes the configured default), but every individual add can override it
- New `Jobs` overlay (`/schedule-prompt → Jobs`) — a single TUI view with hotkey-driven actions (`↑↓` navigate, `a` add, `t` toggle enabled, `s` toggle scope (session-bound ↔ shared), `x` remove, `c` cleanup disabled, `q` quit). Foreign-session jobs render read-only in a dedicated "Other sessions" group; actions ignore them. The selected job's full details (id, type, next run, last run, run count, prompt) show below the list

### Changed
- **`/schedule-prompt` menu collapsed to two items**: `Jobs` and `Settings`. The previous five job operations (`View All Jobs`, `Add New Job`, `Toggle Job`, `Remove Job`, `Cleanup Disabled Jobs`) are folded into the `Jobs` overlay
- **Default behaviour change:** new jobs are now bound to the creating session by default (`defaultJobScope: "session"`). Two pi sessions in the same cwd no longer fire the same newly-added job twice. Existing jobs from older versions have no `session` field and keep firing in every pi — flip the setting and re-add (or hand-edit) to migrate them
- Widget, the tool's `list`/`cleanup` actions, and shutdown auto-cleanup all filter to "loaded" jobs only (`!session || session === mySessionId`). Foreign-session jobs are invisible to other pi sessions and never touched on shutdown. The Jobs overlay deliberately shows foreign jobs read-only so the user can still see what else is scheduled in this cwd
- `humanizeCron` and `formatISOShort` lifted from `cron-widget.ts` into `scheduler.ts` (re-exported) so the widget and the confirm dialog produce identical strings

### Fixed
- `saveSettings` now writes only the deliberately-changed field to the project settings file (`<cwd>/.pi/schedule-prompts-settings.json`) instead of snapshotting the merged in-memory state. Previously, toggling `widgetVisible` would also pin the merged value of `defaultJobScope` (or any other field set via the global file) into the project file, masking subsequent global edits
- Widget now actually re-renders on `cron:change` events (add/remove/update/fire/error). Previously the refresh path was gated on a callback pi only registered on theme changes, so the widget went stale until a manual refresh. The 30-second tick used the same gate and was also a no-op
- Widget no longer leaks event listeners across `session_start` / `session_shutdown` cycles. The `pi.events.on("cron:change", …)` subscription's unsubscribe handle is now captured and called from `destroy()` — without it, every reload spawned a zombie widget instance that would also try to render against a stale `ctx`
- `/schedule-prompt → Add New Job` now checks for duplicate names before any prompts — was only checked on the tool path

## [0.2.0] - 2026-05-01

### Added
- Optional `model` field on scheduled jobs (closes #4, #7): when set, the prompt runs in a fresh in-process `AgentSession` with the chosen model instead of being injected into the current chat. The current chat keeps its own model and context untouched. Permissive resolution: `"haiku"`, `"sonnet"`, or `"provider/model-id"` — first match in the available registry wins
- Optional `notify` flag (subagent jobs only): when `true`, the subagent's result is delivered to the parent agent as a follow-up that triggers a new turn. Default is silent. No-op for inline (no-model) jobs — the prompt itself already wakes the parent — and accepted without rejection so existing inline jobs aren't broken by stray `notify` values
- Subagent lifecycle markers in the chat: `subagent_start`, `subagent_done` (with a 500-char output snippet), and `subagent_error` — rendered with a `(subagent: <model>)` tag
- Widget badges for subagent jobs: `[<model>]` per row, with a trailing `!` when `notify=true`
- Active subagents are tracked per `AbortController` and aborted when the scheduler stops (session shutdown / switch / fork), preventing late completions and unhandled rejections
- Test suite (`vitest`): scheduler, subagent runner, and tool — 45 tests covering the new paths
- CI workflow (`.github/workflows/ci.yml`) and Biome config
- Persistent widget visibility setting via a two-layer config (closes #2):
  - Global: `~/.pi/agent/schedule-prompts-settings.json` — manual user defaults
  - Project: `<cwd>/.pi/schedule-prompts-settings.json` — written by the UI
  - Project overrides global on load; survives package upgrades
- `Settings` submenu in `/schedule-prompt` displaying the current widget visibility state live in the row label, with redraw after each change

### Changed
- `executeJob` branches on `job.model`: with no model, prompt is injected into the current chat (existing behavior); with a model, runs the prompt in a subagent. The marker is posted before `sendUserMessage` so it always lands above the prompt
- `model` parameter must be a non-empty string (`minLength: 1` in the schema, plus runtime checks in `add` and `update`). To switch a job from subagent back to inline mode, remove and re-add it without `model` — there's no in-place clearing
- Replaced "Toggle Widget Visibility" menu item with the new `Settings` submenu — the menu itself is the source of truth for current state, removing the need for a success toast
- Schedule input (`/schedule-prompt → Add New Job`) is trimmed before validation, so pasted strings with surrounding whitespace validate cleanly
- Package description updated to reference "Pi's Heartbeat"
- Migrated from `@sinclair/typebox` (v0.34.x legacy line) to the unscoped `typebox` (^1.1.24) package — pi's runtime packages migrated to the new namespace, and mixing the two produced "TUnsafe<string> not assignable to TSchema" errors across `tool.ts` / `types.ts`

### Removed
- Success toast on widget visibility toggle (the menu shows the new state directly). The "session only; failed to persist" warning toast is retained because it's the only signal the user couldn't otherwise observe.
- Dead `session_switch` / `session_fork` listeners — those event names don't exist in pi's `ExtensionEvent` API (the real events are `session_before_switch` / `session_before_fork`), so the handlers never fired and `session_start` already covers the reload/new/resume/fork cases (#3)

### Fixed
- Scheduler no longer leaks croner timers across `session_start` (which fires on reload/resume/fork too): `initializeSession` is now idempotent and tears down any prior scheduler/widget before creating new ones, eliminating duplicate fires of recurring jobs in long-lived sessions (#3)
- `runCount` now advances on every fire: `executeJob` re-reads the job from storage instead of using the closure-captured snapshot, which previously kept writing the same stale `snapshot + 1` value (#3). Same fix applied to the subagent execution path (#7)
- Subagent jobs no longer leave `lastStatus: "running"` if the post-completion marker `pi.sendMessage` throws: storage is advanced to the terminal status before the (best-effort) marker is posted, so a teardown-time failure can't crash the process or stick the job
- Scheduled prompts no longer inject twice into the parent agent's context: the chat marker now carries empty `content` so it's purely a UI event — the renderer still draws it from `details`, and only `sendUserMessage` carries the prompt to the LLM. Previously the prompt text was in both, producing duplicate turns / "PROMPT\n\nPROMPT" rendering, especially when the agent was streaming at fire time
- `notify: false` on subagent jobs is now genuinely silent: the done/error markers are posted with no delivery options (instead of `{deliverAs: "followUp", triggerTurn: false}`) so the parent agent isn't woken even when it was streaming at completion time — pi's `sendCustomMessage` would otherwise take the `followUp` branch and queue a turn regardless of `triggerTurn`. The renderer still surfaces the snippet/error from `details`. `notify: true` still uses `followUp` + `triggerTurn: true` and carries the result snippet in `content` so the parent can react to it
- Stale `lastStatus: "running"` no longer persists across sessions: `CronScheduler.start()` clears the flag for any job that was interrupted mid-execution (subagent aborted by shutdown, process kill). Without this, the widget would render `⟳` for a job that isn't actually running until the cron next fired
- Subagent error messages are now truncated to 500 chars with an ellipsis, matching the success-snippet behavior — verbose API errors / stack traces would otherwise overflow the chat row when the marker is rendered
- `update` action now resolves relative-time schedules (`+5m`, `+10s`, etc.) the same way `add` does, so `update {schedule: "+5m"}` no longer fails with "Invalid timestamp: +5m". Same past-timestamp / too-soon guards as `add`

---

Earlier releases (`v0.1.0`–`v0.1.2`): see [git tags](https://github.com/tintinweb/pi-schedule-prompt/tags).
