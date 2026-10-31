---
doc_type: runbook
project: pi-schedule-prompt
status: active
truth_mode: maintained
created: 2026-10-20
---

# Durable supervisor — stage D

## Contract

This is an opt-in execution envelope for a dedicated native Pi session, not a new child runner, permission database or goal tracker. Existing interactive/broadcast schedules retain their behavior. Set `durable: true` on session-bound jobs; the service refuses enabled broadcast/non-durable jobs in its own session, and requires both maxRuns and expiresAt. Durable model jobs reject notify:true: a second unclaimed parent inference is not a mere notification. Durable explicit-model jobs reuse the existing in-process runner, not another subprocess protocol.

The same private schedule file (schema 3; reads 1/2/3) retains one coalesced intent and the latest execution claim per job. A claim identifies its native Pi session, unique attempt, local owner process, immutable configuration binding, phase and deadline. Dispatch acceptance and Pi settlement are not business verification. No exactly-once guarantee for external effects is made.

Scheduled custom turns are unattended. The scheduler blocks the `ask_user_question` tool before its UI opens, records a metadata-only `schedule_input_required` marker plus `waitingReason: "user_input_required"` on the exact claim, and returns an actionable blocker to the model. The model must finish the round without guessing, claiming business completion, replaying earlier effects, or waiting on a human dialog. Ordinary user turns are unaffected; this boundary prevents a durable deadline from expiring while a question remains open.

1. Time ticks persist intent and the next occurrence before dispatch. Events use the existing bounded event inbox. `catchUp: none` discards missed intent; `latest` restores at most one. No replay of all missed occurrences.
2. Claim under the original store lock; attempt/daily limits are charged there. Mark `dispatched` durably **before** invoking Pi. At most one durable execution per scheduler, including explicit-model jobs. Cancellations retain that slot until the exact native/child handle settles.
3. Only the exact matching native custom turn may start/settle a claim. A bounded metadata-only `schedule_execution` session entry precedes terminal store update. On restart, inspect only these exact-session receipts. A matching receipt can reconcile terminal status; a dead owner's `claimed` phase is provably pre-dispatch and can restore one intent. A live owner is never stolen. A dispatched/started claim without receipt becomes unknown and disabled, with no automatic replay.
4. Default elapsed deadline is 10 minutes, configurable 1 second–24 hours. Deadline/stop abort only the owning Pi session or in-process run; external effects/independent Subagents may survive. Unknown/aborted work pauses. Three consecutive confirmed inference errors stop a durable schedule. No generic effectful retry; store-lock contention is the only automatic pre-admission retry.
5. The latest notification outbox records pending/accepted/failed separately from execution outcome, with at most3 delivery attempts. Each delivery attempt also appends metadata-only schedule_notice to the owning native session, so a later execution does not erase the previous failed-delivery evidence. Successful local event acceptance is not undone by a supplementary UI failure; neither means human receipt. Notification failure never disables or blocks new authorized execution and retrying it never reruns a job. A final assistant length stop is a confirmed error, not missing-receipt uncertainty.

## Scheduled-round wind-down and future-only recovery

Durable inline turns now receive absolute UTC soft/hard deadlines with the original prompt. The final third of a short round, capped at five minutes, is reserved **inside** the existing hard deadline. In that reserve, the native `tool_call` boundary rejects new operations (including nested calls and bash/codemode wrappers); direct read/write/edit/todo remain available for local checkpointing. A metadata-only `schedule_wind_down` entry records the transition without starting or steering a second turn. An in-flight tool or unusually slow final response can still exceed the hard deadline; it remains UNKNOWN, never assumed rolled back or complete. Ordinary user turns, explicit-model jobs and control-only follow-ups retain their existing behavior.

New terminal receipts, stored claims, notices and status expose bounded reason codes such as `deadline_exceeded`, `host_aborted`, `user_stopped`, `claim_changed` and `settlement_unknown`. Historical receipts without a reason remain readable. Installation is not hot loading.

After explicit authorization and external/checkpoint reconciliation, the owning session may call `schedule_prompt` with `action:"resume"`, `jobId`, exact settled UNKNOWN/aborted `claimId`, and a lowercase SHA-256 `evidenceFingerprint`. This operation is not available recursively inside scheduled turns. It atomically retains the disabled original job/claim and creates one future-only recurring timed successor: remaining lifetime attempts are subtracted, UTC daily usage is carried, expiry/deadline/model/permissions remain unchanged, and `catchUp:none` prevents replay of missed occurrences. A bounded recovery marker in the same job store makes repeated identical calls idempotent. Active/unsettled handles, foreign sessions, expired/exhausted budgets, event/once/follow-up replay and changed evidence are rejected. The hash records what the operator reconciled; it is not proof of business completion or a new authorization source. Generic cleanup retains UNKNOWN/recovery evidence.

## Native service boundary

The fixed package includes a small `scripts/supervisor.mjs` entry: foreground `run`, `status`, read-only `reconcile`, `stop`, and `plist`. It launches exactly one pinned native Pi CLI in RPC mode, with an explicit cwd, own stable session id, fixed package/model, normal trusted host credentials and extension discovery. No private history/profile/credential copy, arbitrary TUI stdin, or default boot prompt. It never restarts a potentially effectful child on timeout. A kernel-owned127.0.0.1 control port exposes only authenticated metadata status/reconciliation/stop; status performs a bounded fresh readback of job metadata when the child is ready, while reconcile inspects one exact job without changing the store. The nonce is retained only in private state. A fixed config identity prevents a second port/config from claiming the same state directory; raw prompts, transcripts, tool arguments, stderr and provider keys are not logged.

The stock RpcClient was considered: it accumulates and forwards raw stderr, does not expose extension-UI replies or graceful stdin EOF. This service uses a bounded LF-only RPC transport for those specific needs; it is not a new agent protocol. UI confirmations are denied and selects/inputs/editors cancelled, leaving a visible blocked marker; they are not auto-approved. Fixed package identity/session/model and loaded scheduling command are checked after native startup.

Host lock recovery is conservative: an owner or recorded child that is still alive blocks a second launch. A stale host record can be reclaimed only when both recorded processes are proven absent. PID reuse can cause a safe HOLD, never permission to kill. An incomplete child record also stays HOLD. Config/state identity is fixed: use a new private state directory for a deliberate config change, rather than silently repointing a running owner. Stop uses the authenticated owned loopback endpoint and the retained child process handle; it does not signal a PID discovered in a file. A crash during the original schedule-store mutation can leave its writer lock: preserve it and diagnose with all writers quiescent, never remove it merely because it is old.

`plist` prints an opt-in user LaunchAgent definition (RunAtLoad, crash restart throttled, no provider secrets), but does not install/bootstrap it. Source, fixed installation, foreground idle readiness, OS-service activation and real-goal acceptance are separate states. OS reboot/sleep, 24/7 operation and hard billing caps are not claimed by local fixtures.

## Operation (fixed installation)

Use a private config file outside Git. Required: `version: 1`, absolute `cwd`, absolute `piCli`, `piCliSha256`, absolute `packageRoot`, `sourceCommit`, `sessionId`, exact `model` provider/id, private `stateDir`, and a selected loopback `controlPort` (49152–65535). Optional `thinkingLevel` defaults to the host setting; no implicit downgrade. Config is metadata, not authorization. Use the exact fixed installer receipt/package and trusted host binary hash. Do not put credentials or goal text in this config.

```
node /fixed/package/scripts/supervisor.mjs run /private/supervisor.json
node /fixed/package/scripts/supervisor.mjs status /private/supervisor.json
node /fixed/package/scripts/supervisor.mjs reconcile /private/supervisor.json <job-id>
node /fixed/package/scripts/supervisor.mjs stop /private/supervisor.json
node /fixed/package/scripts/supervisor.mjs plist /private/supervisor.json
```

Create finite authorized schedules only through an already-authorized local management path: the schedule_prompt tool in an owning interactive session with the exact pinned session id/session directory, or the fixed package's CronStorage API while the service is stopped. The RPC service deliberately exposes no prompt/create endpoint, cancels management dialogs, and the legacy Jobs UI does not collect durable/limit fields; it cannot enroll a compliant service job. Mixed enabled broadcast/non-durable/unbounded jobs cause startup rejection. No schedule or business target is created by installation.

## Status and UNKNOWN reconciliation

`status` reports two independent layers: native service readiness (`state`, `ready`, `active`) and the latest bounded schedule projection (`jobCounts`, `jobSummary`, `jobStatusFresh`). A ready service with zero enabled jobs is idle by design, not proof that a wake occurred. The projection contains only job identity, limits/timestamps, claim phase/outcome, exact-session receipt match and a reconciliation hint; it omits prompts and transcripts. Disabled UNKNOWN/error claims create a deduplicated local `healthAlerts` entry so repeated status reads do not look like repeated executions.

`reconcile <job-id>` is read-only. It checks the exact owning native session for a matching receipt and reports whether the owner is live, a claim is safely pre-dispatch-releasable, or an effectful UNKNOWN requires external evidence. It returns `modified:false`, `automaticReplay:false` and `businessCompletion:"not-verified"`. It never enables a job, rewrites a claim, removes an old record or infers that a peer acted. After external evidence is reviewed and continuation is authorized, an operator may use the exact-claim future-only `resume` tool above; a stale `nextRun` or a sent/received transport notice is not completion proof.

For an authorized offline management script, import CronStorage from `<fixed-package>/dist/storage.js`, create it with `config.cwd`, and add a unique id/name plus `type`, validated absolute schedule/intervalMs, self-contained authorized prompt, `createdAt`, `runCount:0`, `enabled:true`, `session:config.sessionId`, `durable:true`, `maxRuns`, `expiresAt`, `deadlineMs` and explicit `catchUp`. Confirm the existing goal references/peer ids externally before doing this; do not store a slash-template name expecting future expansion. This API validates job bounds/schema but is not authorization. Read the added record back before starting the host. Resolve unknown execution by checking the native session and existing Intercom/Subagents handles/evidence, then use `resumeFuture(jobId, exactSessionId, exactClaimId, evidenceFingerprint)` (or the owning-session `resume` tool) only for an authorized future continuation. Preserve the old job/claim and use the returned successor; do not remove/re-create UNKNOWN jobs, clear usage or manually copy limits. Enabling an unresolved claim does not bypass admission. Never infer that a missing notification or dead parent means a child did not act.

## Evidence

Stage C delivered PR #3, main `55796b2446a755778e11bbbe8c9bb417af076525`, release `v0.4.1-fork.3`, 184 source tests, Node22/26 CI and9 installed component cases. Stage D source/install evidence is recorded by [PR #4 terminal readback](https://github.com/chenhaoxiang/pi-schedule-prompt/pull/4#issuecomment-6289365199):218 source tests, exact-head Node22/26 CI,16 installed component cases, actual native CLI faux receipt/stop acceptance and normal-host zero-job readiness with real settings hash unchanged. The later [selected-peer live pilot](live-supervision-pilot.md) is separate: one existing completed/awaiting-user game goal, one real wake, explicit task disable and confirmed host stop. It does not prove advancement of an unfinished business goal.
