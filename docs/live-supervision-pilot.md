---
doc_type: report
project: pi-schedule-prompt
status: completed
truth_mode: snapshot
created: 2026-10-20
---

# First selected-peer live supervision pilot

## Scope and result

On2026-10-20 the operator selected only the existing **小游戏开发** Pi session, not every connected session. The trial was bounded to10-minute cadence, at most6 attempts and1-hour expiry, with one immediate first check. It was **early-stopped after one successful native turn** because the selected existing goal was already delivered and awaiting the operator. This proves real wake/status judgment/stop behavior, not new game implementation, two-peer goal progress, device acceptance or production delivery.

The supervisor reused the maintained fork installed at0.4.1-fork.4, source `3594bbe4a6dd679ee8c7c3b7aa74e5e48c0699a2` ([PR #4](https://github.com/chenhaoxiang/pi-schedule-prompt/pull/4)). Native host was Pi1.3.0-fork.1 with normal extension/guard/resource discovery and the explicitly pinned current model. No policy/config bypass or new business permission was introduced.

## Baseline and independent evidence

- Selected peer: short session id `01a154e4`, expected cwd `<business-root>/game`, implementation `<worktree-root>/game/visual-size-prototype`. Full local coordinates were compared exactly and are retained only in the private runtime record. These are fixed test coordinates, not a durable alias that may be reused without fresh discovery.
- Before enrollment the parent obtained a concrete peer reply:0.3.0-test.1 LAN delivery and the latest operator-requested user-experience diagnosis were complete; no implementation/build/release/child run was in flight. Suggested UI changes had not been authorized as new work. Older todos and idle status were not evidence of failure.
- The parent independently read the worktree `README.md`, `openspec/changes/survival-social-v1/tasks.md` and `docs/V03-VALIDATION.md`. They agreed on the versioned LAN artifact and remaining platform/device boundaries. The early canonical README was historical and not used as current completion evidence.
- Existing release Jar presence and SHA256 were independently checked against that validation summary: `8d8c63b1bd2123cd2dd4fa12712ed43d7153108023abf6fcf56b951d2cd7781f`. No build, HTTP/DB validation, credentials or raw private game logs were read/run by the supervisor.

## Actual runtime sequence

1. An authorized offline management script created one session-bound durable interval job in the existing schedule store: `game-supervision-01a154e4`, maxRuns6, maxRunsPerDay6, expiresAt one hour after enrollment, deadlineMs180000, catchUp none. The self-contained prompt referred to the existing goal/evidence and explicitly forbade scope expansion.
2. The dedicated native RPC host started its own pinned session `pi-schedule-supervisor`. Its persisted first occurrence woke a real model/custom turn; no synthetic human message, new child runner or arbitrary-terminal stdin was used.
3. The supervisor re-listed Intercom peers and verified the selected identity/cwd, then re-read the three current documents. They contained no contrary evidence. It did **not** send another ask/continue to the peer or turn proposed UI improvements into new work.
4. The supervisor used `schedule_prompt disable`, then `list` and read back enabled=false. It sent a single result to the exact parent identity with explicit wake; parent received message `1582f17d-69c5-40c5-a8bc-c500efb997f8`. The message correctly said the native turn was still running/started and left terminal proof to the native receipt.
5. The parent subsequently read only its own execution metadata: claim `f6f4a1fb-d13e-421b-8426-ee8e974899d4`, phase settled, outcome success, attempts1/runCount1, local notice accepted, and final assistant stopReason stop. Exactly one `schedule_execution` and one `schedule_notice` entry were retained for this job. Transport delivery was not substituted for settlement.
6. The parent requested own-host stop and obtained confirmedStopped=true/exit0; final store had zero enabled schedules. The real global settings file's before/after SHA256 was unchanged. No business session/shared broker was stopped, no LaunchAgent was bootstrapped and no other peer was enrolled.

## Operational handoff

The installed package remains available. The dedicated context retains `start.sh` (interactive), `service.sh run|status|stop|plist`, `supervisor.json`, private runtime state and the disabled pilot job/receipt. **The host is stopped, not silently supervising.** Reusing a session id or old pilot job requires fresh identity/goal checks; do not replay a completed/unknown attempt merely to make activity appear continuous. Local sanitized pilot readbacks are under the context's `tmp/`; native session data stays private and is not copied into this public report.

This pilot's correct next action is awaiting the operator's next actual game instruction, not filling the remaining five check slots. Real WeChat/Douyin configuration and platform permissions, HTTPS/real location consent, second physical-device behavior, and game Git remote/commit/merge were not completed by this experiment. OS reboot/sleep,24×7 operation, hard billing caps and advancement of an unfinished live goal are also unverified. Those limits are not failures to hide or reasons to manufacture new tasks.
