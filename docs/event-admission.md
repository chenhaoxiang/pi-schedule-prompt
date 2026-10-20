---
doc_type: design
project: pi-schedule-prompt
status: active
truth_mode: maintained
created: 2026-10-20
---

# Event admission (stage C)

The same schedule_prompt tool/store admits event jobs; no second routine/task database is introduced. Event jobs use type=event, a required session binding and a comma-separated schedule of safe names. Shared broadcast remains time-only to avoid cross-session event ownership ambiguity. Initial names include lifecycle:session-start, lifecycle:agent-settled, local:<name>, api:<name>, github:pull-request and github:workflow. The HTTP producer may emit only api: names, not spoof lifecycle/GitHub origins. One event task can match several names; mixing an independent time schedule into that task is not part of this slice.

A producer supplies only task id/name/event id, never a prompt, command, model or authority. Every path re-reads current enabled/session/revision/expiry state. Definition changes invalidate pending events. Duplicate keys are SHA-256 projections bounded to128 retained keys per task; task content/revision binding prevents a queued old event from running a hand-edited new prompt; multiple pending events coalesce to one current intent with bounded keys. Admission and lifetime/daily counts share the store lock. maxRunsPerDay counts admitted attempts in UTC calendar days, not fees or business successes.

Version2 stores read existing version1 data but writes require upgraded cooperating runtimes; old versions reject the new store rather than silently ignoring limits. Event intent is persisted before dispatch so dedup/restart behavior is truthful. catchUp=none (default) drops pending pre-dispatch events on restoration; latest restores at most one. Post-dispatch unknown work is not re-enqueued. Timer offline catch-up and general execution recovery remain stage D.

The extension exposes a trusted process-local schedule:event bus seam and tool action=trigger. A lifecycle settled event never re-triggers from this extension's own scheduled turn, avoiding self-wake loops. Pause/expiry/limits apply to all paths. This is local trusted-code composition, not authentication between malicious extensions.

An optional loopback HTTP producer is disabled by default, requires a token supplied by an explicitly named environment variable, fixed POST /events, strict small JSON keys, loopback/Host/Origin checks, constant-time token comparison and bounded request rate. It selects existing event tasks only. No public listener, unsigned webhook or arbitrary event prompt is provided.

An optional per-task GitHub poller uses the existing gh identity and fixed argv/API paths, never shell interpolation. A configured source requires an exact owner/repo and either a PR number or a selected latest workflow/branch. There are at most10 local sources; requests are fixed GET calls with a10s deadline/1MiB limit and60s minimum interval. The first successful result seeds a safe metadata fingerprint without firing. Only later selected PR/workflow state changes enqueue events; raw bodies/comments are not injected. Failures back off up to a one-hour interval without inference. On restart catchUp=none re-seeds, while latest compares the existing fingerprint and retains the latest capped change until it can be admitted. Unit/component fixtures stub requests; no actual repository is polled until explicitly configured.

Controlled acceptance covers local/lifecycle/API/GitHub events, duplicate/busy coalescing, UTC reset, pause/revision/expiry, corrupt/locked stores and restart catch-up. Source, fixed package installation and real external operation remain separate evidence levels.
