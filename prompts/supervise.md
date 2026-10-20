---
description: Bound a timed multi-session supervision loop using existing Pi tools
---

Act as the parent supervisor for the explicitly named existing goals and Pi sessions below. This is an orchestration recipe, not a new permission source. Do not start work until the target session ids, expected repositories, existing goal/evidence references, cadence, expiry and maximum check count are concrete. Inspect existing context and ask only for genuinely missing decisions. Do not invent target peers from a title or silently supervise every visible session.

Use the current session model and existing schedule_prompt, Intercom and Subagents tools. Do not implement another agent runner, copy project task databases, change model/provider/thinking, or install/reload other sessions. Create a session-bound inline schedule only when an ongoing loop was requested; use the agreed maxRuns/expiresAt. Do not create another schedule from a scheduled turn. One-time checks need no schedule. Persist a self-contained recurring prompt with exact peer ids/cwds, goal/evidence references, check/stop rules and limits. Do not store only `/supervise ...`: native scheduled custom turns do not expand slash templates. Record the schedule id and existing task references in the normal handoff; no permission ledger.

Each check:
1. Re-list live Intercom sessions, resolve exact identity and expected cwd. Treat a missing peer as offline, not authorization to create a replacement. Avoid changing aliases or moving another session's pane.
2. Distinguish active work/live children from idle, waiting for a user decision and genuinely failed execution. Do not use file age or 'thinking for a long time' as proof of a dead run. Do not interrupt healthy work with generic 'continue' messages.
3. Read only the selected current goal/spec/task/PR and bounded returned evidence. Stay within that project's existing authorization and instructions. Do not mine private transcripts or credentials for context.
4. If a concrete authorized next step is ready, use Intercom send with wake:true or ask for a short opening acknowledgement when a blocking answer is necessary. Keep at most one unresolved request for the same step. Use exact replyTo when answering an ask. Do not resend because a receipt is missing: first reconcile the known message/run.
5. Separate transport delivery, opening acknowledgement, actual execution and business verification. A peer's 'done' is a claim; confirm the agreed artifact/test/PR evidence through the owning project. Preserve unknown or unavailable evidence; do not fabricate success.
6. New independently delegated tasks use the existing Subagents path with explicit scope and worktree ownership. A peer owns its own children; do not assume the supervisor can stop/revive them. Existing Crew dependencies remain Crew's state.
7. If nothing changed and no intervention is useful, stay quiet. Notify the operator for a real decision/permission/technical blocker, persistent failure, or completion. Ordinary status messages use wake:false and do not request acknowledgement echoes.
8. When all selected goals are verified complete, the agreed expiry/check count is reached, or the operator pauses, disable the known schedule and summarize completed, blocked and unverified work. Stopping future checks does not cancel an executing tool or undo side effects.

An interrupted/uncertain dispatch is not safe to replay blindly. Do not claim a hard token/money budget from maxRuns or SDK cost. Do not auto-merge, deploy or perform financial/production operations unless those exact actions are already authorized and all owning gates are satisfied.

Targets, existing authorization/evidence references, cadence, expiry and max checks:

$@
