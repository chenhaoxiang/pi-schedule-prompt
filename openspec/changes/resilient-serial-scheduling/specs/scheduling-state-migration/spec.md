# Spec Delta

## Purpose

Evolve the existing local scheduling store and installed native contract without losing historical UNKNOWN evidence, resetting budgets, racing older writers or confusing a disk installation with a live runtime upgrade.

## ADDED Requirements

### Requirement: Stable job identity and attempt history
Routine recovery SHALL keep a stable logical job identity with separately identifiable attempts, owners and immutable outcome evidence. Legacy successor chains SHALL remain readable and retain their original identities and budget lineage. Ownership transfer SHALL NOT create a second active logical executor.

#### Scenario: Repeated recoverable failures
- **WHEN** a recurring job experiences several recoverable failures and continuations
- **THEN** one logical job retains the attempt history rather than recursively appending replacement job prompts

#### Scenario: Legacy successor migration
- **WHEN** a historical predecessor/successor chain is imported
- **THEN** old identifiers, UNKNOWN claims, spent attempts, expiry and evidence references remain traceable without merging unrelated jobs

### Requirement: Atomic ownership and budget accounting
Cooperating local writers SHALL serialize admission, ownership transfer, attempt accounting, checkpoint references and next eligibility in the existing store. Recovered business executions SHALL obey the same lifetime accounting; request-level model retries and skipped ticks SHALL remain distinct observations.

#### Scenario: Two writers race
- **WHEN** two sessions concurrently attempt to acquire or resume the same logical job
- **THEN** at most one becomes execution owner and counters cannot be reset or double-spent by the losing path

### Requirement: Versioned migration rejects mixed writers
New state SHALL have an explicit schema and capability contract. Migration SHALL require the affected store's writers to be quiescent and preserve backup bytes. Older writers SHALL refuse unsupported state without overwriting or downgrading it. Unrelated worktrees and stores SHALL not be stopped for this migration.

#### Scenario: Old runtime sees upgraded state
- **WHEN** a runtime that only understands the old schema opens the upgraded shared store
- **THEN** it refuses mutation with an actionable incompatibility reason and original bytes remain intact

#### Scenario: Another writer is still active
- **WHEN** a store migration is requested while an affected writer or exact execution remains in flight
- **THEN** migration is held for that store without resetting it or blocking independent source implementation

### Requirement: Legacy enablement is not guessed
Migration SHALL preserve existing disabled jobs and explicit UNKNOWN claims. If historical data cannot distinguish operator disablement from automatic disablement, it SHALL NOT infer renewed user intent. Authorized exact-claim continuation SHALL preserve original finite bounds and be idempotent.

#### Scenario: Disabled UNKNOWN job is upgraded
- **WHEN** new software reads a disabled historical UNKNOWN job
- **THEN** the job remains non-executing until an authorized recovery explicitly resolves its eligibility

#### Scenario: Identical recovery request is repeated
- **WHEN** the same job/claim and evidence fingerprint are submitted twice
- **THEN** one recorded continuation is returned without duplicating an execution or replenishing limits

### Requirement: Existing feature contracts remain isolated
One-shot, event, explicit-model, session-bound, legacy broadcast and Intercom reply-follow-up behavior SHALL remain supported within their declared policies. A one-shot reply reminder SHALL NOT become a recurring retry, and a delivery or ACK SHALL NOT settle business work.

#### Scenario: Exact reply cancels its reminder
- **WHEN** an Intercom reply matches its original message binding after the store upgrade
- **THEN** only that reminder closes with persisted readback and no recurring business retry is created

#### Scenario: Ordinary interactive Pi work
- **WHEN** non-scheduled user work runs after a scheduled attempt finishes
- **THEN** its model route, retry configuration, tools and history retain their original behavior

### Requirement: Rollback is state-aware
Rollout SHALL distinguish source, release, installation, selected runtime, loaded runtime, store migration and business verification. Rollback SHALL use a compatible reader and preserve post-migration attempts/effects; restoring stale backup bytes over later activity SHALL NOT be called a safe rollback.

#### Scenario: Package installed but old session remains loaded
- **WHEN** a new package exists on disk but a busy session still runs the old version
- **THEN** status reports the mismatch and no forced reload or false live-upgrade claim occurs

#### Scenario: Rollback after new activity
- **WHEN** newer state contains attempts absent from the pre-migration backup
- **THEN** rollback preserves that evidence through a supported conversion or compatible runtime rather than overwriting it

### Requirement: Failure fixtures and release evidence are truthful
Verification SHALL include synthetic continuous and intermittent provider failures, cancellation races, restart/misfire, budget and migration failures without real providers, credentials or external business submissions. Natural acceptance SHALL be separately scoped and reported; passing fixtures SHALL NOT imply business completion or all-session adoption.

#### Scenario: Prior incident reproduced synthetically
- **WHEN** synthetic tests exercise continuous transient failure and five intermittent failures near finalization
- **THEN** the system preserves checkpoints and safety invariants without permanent automatic disablement or paid external calls
