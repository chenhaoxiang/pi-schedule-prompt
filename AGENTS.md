# Maintained fork contract

This repository is chenhaoxiang/pi-schedule-prompt, maintained from tintinweb/pi-schedule-prompt.

- main is the reviewed integration branch. upstream-main is an exact community mirror, without fork commits. The upstream remote is fetch-only; never force-push or install the mirror.
- Work in an isolated worktree. Preserve unrelated work and active Pi sessions. Use topic PRs and regular merges; do not push maintenance changes directly to main.
- Keep the upstream MIT license and attribution. Versions use <community-version>-fork.<revision>. Never publish under the community npm identity. Releases/installations are separate from source delivery.
- Target Pi 1.3 native custom turns. Scheduling is not user authorization, business completion, or a new child runner. Reuse Intercom for peers and Subagents for independently delegated workflows.
- Preserve existing scheduling/UI/model-job features unless an approved change explicitly replaces them. Do not start real scheduled work, read private session history/credentials, or change global Pi settings during tests.
- Run npm run check with synthetic fixtures and a bounded test pool. Temporary logs, fixtures and packages belong in tmp/. Tests may not call real providers. Pin dependency changes; install with lifecycle scripts disabled.

## Documentation map

- docs/reliable-scheduling.md: native prompt dispatch, coalescing, limits, lifecycle/storage guarantees, integration boundaries and verification.
- openspec/changes/reliable-prompt-scheduling/: the single implementation scope, design, requirements and tasks for the first maintained slice.
- README.md / docs/README.zh-CN.md: installation source, capabilities and operational boundaries.
