# Maintained fork contract

This repository is chenhaoxiang/pi-schedule-prompt, maintained from tintinweb/pi-schedule-prompt.

- main is the reviewed integration branch. upstream-main is an exact community mirror, without fork commits. The upstream remote is fetch-only; never force-push or install the mirror.
- Work in an isolated worktree. Preserve unrelated work and active Pi sessions. Use topic PRs and regular merges; do not push maintenance changes directly to main.
- Keep the upstream MIT license and attribution. Versions use <community-version>-fork.<revision>. Never publish under the community npm identity. Releases/installations are separate from source delivery.
- Target Pi 1.3 native custom turns. Scheduling is not user authorization, business completion, or a new child runner. Reuse Intercom for peers and Subagents for independently delegated workflows.
- Preserve existing scheduling/UI/model-job features unless an approved change explicitly replaces them. Do not start real scheduled work, read private session history/credentials, or change global Pi settings during tests.
- Run npm run check with synthetic fixtures and a bounded test pool. Temporary logs and packages belong in tmp/. Unix-socket fixtures may use an owned short OS temporary tmp/ subtree outside Git/node_modules ancestors and must clean only their own directory/processes. Tests may not call real providers. Pin dependency changes; install with lifecycle scripts disabled.

## Documentation map

- docs/durable-supervisor.md: stage D opt-in durable intent/claim/receipt reconciliation, bounded native RPC service and stop/install evidence.

- docs/event-admission.md: stage C unified local/lifecycle/GitHub/optional loopback admission, UTC daily bounds, bounded dedup and restart policy.

- docs/online-supervision.md: bounded supervisor prompt, native tool composition, isolated real-component fixtures, fixed installation and selected-peer acceptance.
- docs/automation-roadmap.md: single overall rollout, fixed reference mapping, online/event/durable stages and separate install/live acceptance.
- openspec/changes/composed-automation-rollout/: sequential implementation contract/tasks; do not mistake the timer-foundation closeout for the whole rollout.

- docs/reliable-scheduling.md: native prompt dispatch, coalescing, limits, lifecycle/storage guarantees, integration boundaries and verification.
- openspec/changes/reliable-prompt-scheduling/: the single implementation scope, design, requirements and tasks for the first maintained slice.
- README.md / docs/README.zh-CN.md: installation source, capabilities and operational boundaries.
