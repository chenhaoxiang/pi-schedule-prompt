# recurring-trigger-policy Specification

## Purpose
Define when a recurring timed job becomes eligible, independently of how long its previous execution takes, while preventing overlapping attempts and unbounded catch-up work.

## Requirements

### Requirement: Completion-relative delay
A fixed-delay job SHALL become eligible N milliseconds after its previous owned execution has verifiably ended and its continuation is safe. Running, draining, cancelling or unresolved ownership SHALL NOT arm a second execution. Confirmed failure SHALL NOT require eventual business success before a future occurrence can be scheduled.

#### Scenario: Run lasts longer than the configured delay
- **WHEN** a fixed-delay job starts at 10:00, ends safely at 11:20 and has a ten-minute delay
- **THEN** its next occurrence is eligible no earlier than 11:30 and no overlapping occurrence exists

#### Scenario: Confirmed transient failure
- **WHEN** an execution fails without unresolved effects and releases its exact handle
- **THEN** a future occurrence can be scheduled using the completion delay and failure cooldown without changing user enablement

### Requirement: Stable fixed-rate and calendar anchors
Fixed-rate jobs SHALL preserve their original interval anchor. Cron jobs SHALL preserve their calendar expression and explicit effective timezone. A delayed finish, backoff or host restart SHALL NOT silently convert either mode into completion-relative timing.

#### Scenario: Long fixed-rate execution
- **WHEN** an hourly fixed-rate job runs from 10:00 until 11:20 with overlap skipping
- **THEN** the overlapping 11:00 occurrence is skipped and the next normal occurrence is 12:00

#### Scenario: Explicit cron timezone
- **WHEN** a cron job is restored on a host with a different process timezone
- **THEN** its persisted effective timezone determines future calendar occurrences

### Requirement: Bounded overlap policy
New resilient recurring jobs SHALL default to single-flight overlap skipping. An explicit buffer-one policy SHALL retain at most the first waiting occurrence while busy; additional ticks SHALL be counted as skipped rather than appended. Existing legacy coalescing SHALL remain identified as legacy until explicitly migrated.

#### Scenario: Several ticks while busy
- **WHEN** three ticks arrive during one active execution under buffer-one
- **THEN** at most one waiting occurrence is retained and no inference is dispatched until the current execution closes safely

#### Scenario: Buffered occurrence expires
- **WHEN** a buffered occurrence exceeds its configured lateness window before the execution slot is available
- **THEN** it is discarded without spending an admitted-attempt budget

### Requirement: Missed occurrences are separate from overlap
Restart, sleep and scheduler downtime SHALL follow an explicit misfire policy independent of overlap. The default SHALL skip missed occurrences; an opt-in latest policy SHALL recover at most one occurrence still inside its lateness window. No automatic unbounded catch-up SHALL occur.

#### Scenario: Restart after many missed ticks
- **WHEN** a scheduler restarts after ten hourly occurrences were missed with misfire skip
- **THEN** it waits for the next valid future occurrence rather than starting ten attempts

#### Scenario: Restore an overdue fixed-delay timer
- **WHEN** a fixed-delay job restarts after its persisted next eligibility time
- **THEN** its misfire policy is applied once and startup does not repeatedly postpone or multiply the delay

### Requirement: Eligibility combines all existing bounds
Dispatch SHALL satisfy cadence, persisted cooldown, expiry, lifetime admission and UTC daily limits. A skipped tick, state probe or coalesced intent SHALL NOT consume an execution attempt. Scheduling or retry policies SHALL NOT extend an accepted execution's hard deadline or the job's authorization.

#### Scenario: Backoff extends beyond a calendar tick
- **WHEN** a cron tick occurs before the job's cooldown expires
- **THEN** no execution is admitted and later eligibility follows the configured future calendar or bounded misfire policy

#### Scenario: Budget or expiry reached
- **WHEN** the lifetime limit is exhausted or absolute expiry has passed
- **THEN** no new business attempt starts even if a timer, buffered intent or retry becomes due

### Requirement: Mode changes are explicit and persistent
Existing interval/cron jobs SHALL retain their cadence unless an authorized update selects another mode. New timing parameters SHALL be validated and persisted through all supported management paths; invalid or conflicting legacy/new policy inputs SHALL fail before mutation.

#### Scenario: Existing hourly cron is upgraded
- **WHEN** new software loads an unchanged hourly cron definition
- **THEN** it remains an hourly cron rather than becoming completion-plus-one-hour

#### Scenario: User selects completion delay
- **WHEN** a user explicitly selects fixed-delay with N through the tool or UI
- **THEN** persisted readback identifies the new mode and N, and reload preserves that choice
