# Tasks

## 1. Persist exact follow-up bindings

- [x] 1.1 Add validated follow-up metadata to the existing schedule store, bind owner/intercom/peer/message/request/goal/phase, and verify `npm run typecheck` plus storage dedup/cancel/unknown tests.
- [x] 1.2 Enforce finite delay, deadline, expiry and `maxRuns=1`, reject active covered schedules, and verify invalid-bound and no-second-loop tests.

## 2. Race-safe scheduler composition

- [x] 2.1 Dispatch follow-ups through the local versioned Intercom event seam, re-read the persisted claim before emission, and verify cancellation purges queued work and stale dispatch records `unknown`.
- [x] 2.2 Consume exact reply/disconnect observations, preserve late-reply/ACK/PENDING semantics, and verify restart/disconnect/late-reply tests leave business completion unknown.
- [x] 2.3 Document the bounded Intercom composition and verify the owner docs describe source, install and runtime boundaries separately.

## 3. Intercom integration

- [x] 3.1 Add optional `ask.followUp` creation with exact message binding, create/cancel readback and a 60-second bounded in-memory cleanup, and verify the focused Intercom test suite.
- [x] 3.2 Add status-only due reminders and exact queued-message cancellation without replaying the original body/action; verify delivery/wake never become execution/completion claims.

## 4. Integration verification

- [ ] 4.1 Run OpenSpec validation, package checks, focused provider-free tests and full suites on both exact worktree heads; record commit/test/install/runtime boundaries before delivery.

## Workflow follow-up

- Submit each repository through its normal PR/CI path and re-read the exact head/CI results.
- Installation or active-session reload is separate from source delivery; do not claim hot loading or live business acceptance from these tests.
