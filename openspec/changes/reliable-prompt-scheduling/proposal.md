# Reliable prompt scheduling

## Why

The operator needs an explicit timed wake for existing Pi sessions, composed with maintained Intercom and Subagents rather than another execution platform. Community 0.4.1 labels an accepted inline prompt as success, injects synthetic user prompts, can accumulate follow-ups, silently treats malformed stores as empty, and shares an unlocked read-modify-write file.

## What Changes

- Maintain main and a pure upstream-main mirror; support the current Pi 1.3 SDK and preserve upstream cron/interval/one-shot, UI and explicit model-job features.
- Dispatch one native custom message from an idle session; retain at most one pending inline fire per job and re-read definition/ownership before dispatch.
- Distinguish queued/dispatched/unknown from model execution success; retain disabled jobs across reload so pause does not become delete.
- Add optional lifetime maxRuns and expiresAt controls, using dispatch attempts rather than assuming a model result is an invoice or business acceptance.
- Serialize store mutations and fail visibly on corrupt data/contention; preserve other sessions' jobs and reject foreign-session mutations.
- Prove lifecycle, timer, limit, storage and host compatibility with provider-free fixtures.

## Impact

Scope is this fork only. No daemon, public webhook, live monitor activation, global installation, automatic new child runner, permission ledger, cross-process exactly-once guarantee or changes to other Pi projects. Shared/unbound jobs keep their explicit broadcast semantics.
