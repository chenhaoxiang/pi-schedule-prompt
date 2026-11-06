# scheduled-recovery Specification

## Purpose
Keep authorized recurring work recoverable through transient provider failures while preserving historical uncertainty, completed actions, user stop decisions and all original spending and execution bounds.

## Requirements

### Requirement: Enablement is separate from attempt disposition
Recurring resilient jobs SHALL distinguish user enablement, current runtime state and per-attempt outcome. A transient failure, recoverable interruption or UNKNOWN SHALL NOT alone change user enablement to false. Unsafe continuation SHALL remain visibly blocked or reconciling rather than being reported as healthy execution.

#### Scenario: Retry budget is exhausted
- **WHEN** a transient model failure exhausts the run's retry budget
- **THEN** the job remains user-enabled and exposes backoff or reconciliation with a concrete reason and next eligibility or recovery condition

#### Scenario: Deadline interrupted a run
- **WHEN** the hard deadline requests cancellation
- **THEN** runtime cancellation and effect uncertainty are recorded separately rather than inferring that the user disabled the recurring job

### Requirement: Persisted bounded backoff
Recoverable failures SHALL use a finite capped cooldown with jitter and persisted next eligibility. Scheduler restarts SHALL NOT reset cooldown or create duplicate retries. The scheduler SHALL honor any still-applicable provider delay and original lifetime/daily/expiry restrictions.

#### Scenario: Restart during provider outage
- **WHEN** a job in cooldown is restored before its next eligibility time
- **THEN** no business inference is sent early and only the existing future recovery intent remains

#### Scenario: Continuous and intermittent failures
- **WHEN** a provider produces either repeated identical failures or intermittent failures between successful model/tool steps
- **THEN** cumulative run budgets still bound the attempt and neither pattern causes an unbounded retry chain or permanent automatic disablement

### Requirement: Resume consumes completed work
A resumed execution SHALL consume its exact prior checkpoint and completed tool results. It SHALL NOT restart the full business prompt as if no work occurred, synthesize missing completion evidence or erase failed attempts.

#### Scenario: Earlier tools completed before model failure
- **WHEN** a checkpoint contains completed tool results and the next model response failed
- **THEN** continuation starts from those results and does not repeat the completed tool actions

### Requirement: Unknown effects are reconciled before replay
Uncertain external effects SHALL retain stable identifiers and UNKNOWN until the original result is queried or equivalent owner evidence resolves it. Absence of notification, a dead process, a timeout or a final summary failure SHALL NOT prove the effect did not occur.

#### Scenario: External submission timed out
- **WHEN** a write or submission may have reached its external destination before interruption
- **THEN** recovery queries the original result without repeating that submission or consuming another paid effect

#### Scenario: No reliable effect classification exists
- **WHEN** an arbitrary tool or wrapper cannot prove whether or where effects occurred
- **THEN** classification remains unknown and the potentially conflicting business writes remain held

#### Scenario: Migrated legacy uncertainty has no native checkpoint
- **WHEN** the ordinary owning operator reconciles an exact migrated legacy claim with separate external effect evidence
- **THEN** the official path appends its exact claim binding without fabricating native history, preserves the original UNKNOWN and disabled intent, and admits only separately enabled future occurrences after whole-claim reconciliation while scope-only evidence remains blocked

### Requirement: A local blocker does not stop independent work
After the prior executor verifiably ends, a precisely scoped unresolved effect or missing input SHALL block only conflicting work when its boundary is provable. Independent already-authorized work can continue; an unbounded or ambiguous effect scope SHALL keep that job's business writes held and request attention.

#### Scenario: One channel awaits a user challenge
- **WHEN** one branch needs MFA while another branch is independent and already authorized
- **THEN** the blocked branch remains waiting-input and the independent branch can advance without answering or bypassing the challenge

### Requirement: User stop and finite bounds remain authoritative
User disable, explicit stop/cancellation, revoked authorization, job expiry and exhausted limits SHALL prevent automatic business resumption. Recovery SHALL NOT clear counters, add attempts, extend deadlines, select another model/provider or reinterpret prior UNKNOWN as success.

#### Scenario: User disables a cooling-down job
- **WHEN** a user disables the job before cooldown expires
- **THEN** no automatic business attempt starts when the old timer becomes due

#### Scenario: Reconciliation after expiry
- **WHEN** external evidence becomes available after the original job expired
- **THEN** its history can be reconciled without authorizing a new expired business attempt

### Requirement: Recovery is observable without notification loops
Status SHALL report the exact job/attempt, execution phase, bounded reason, next eligibility or required input, and known/unknown business outcome. Repeated unchanged probes SHALL NOT create repeated model wakes; notification failure SHALL NOT cause business replay.

#### Scenario: Unchanged unresolved status
- **WHEN** repeated status checks find the same UNKNOWN effect and recovery condition
- **THEN** they remain read-only, preserve evidence and do not wake another business execution
