# Sync community Schedule Prompt 0.5.1

## Why

Bring in the community release's idle scheduling, Pi lifecycle fixes and project/profile storage isolation. The maintenance fork must not lose its existing exact-owner scheduling, budgets or UNKNOWN evidence.

## What Changes

- Use both exact community v0.5.1 and maintained v0.4.1-fork.23 as parents of the integration commit. Retain the fork's native, durable, event, follow-up and rollback contracts.
- Add the community idle job via the existing tool, Jobs view and admission flow.
- **BREAKING:** live job storage follows the Pi profile and canonical project path. Existing project-local data requires an explicit offline copy, not a startup migration.
- Deliver and verify a candidate first; activation is a separate, operator-scheduled action.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `recurring-trigger-policy`: add inactivity trigger semantics alongside timed recurrence.
- `scheduling-state-migration`: add the profile/project store transition and conservative rollback.

## Impact

Extension lifecycle, tool/UI, fixed supervisor, explicit offline migration script and provider-free fixtures. No Pi core changes or real jobs/providers are in scope for candidate verification.
