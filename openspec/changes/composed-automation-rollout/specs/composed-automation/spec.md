## ADDED Requirements

### Requirement: Compose online supervision from existing owners
The system SHALL keep the parent Pi session as controller and use Intercom for selected existing peers and Subagents for new delegated execution. It SHALL reference existing goal/evidence sources rather than duplicate task authority.

#### Scenario: Timed supervisor check
- **WHEN** an explicitly scoped supervisor is woken
- **THEN** it confirms current peer identity/repository and advances only a concrete authorized next step
- **AND** transport acknowledgement is not reported as business completion

### Requirement: Unified bounded event admission
Every configured trigger SHALL honor pause, ownership, revision, expiry, lifetime/daily limits and bounded duplicate suppression. External payloads SHALL remain data selecting an existing authorized task.

#### Scenario: Repeated event while busy
- **WHEN** duplicate events arrive while the task is pending
- **THEN** at most one due intent is admitted without another inference request

### Requirement: Recover without blind replay
Durable operation SHALL reconcile exact existing execution handles before a new attempt. Unknown post-dispatch effects SHALL remain unknown and SHALL NOT trigger automatic replay.

#### Scenario: Restart after a lost launch response
- **WHEN** a dispatch may have started before the host stopped
- **THEN** recovery checks the existing execution owner
- **AND** lack of a response is not treated as proof of no execution

### Requirement: Separate evidence levels
The rollout SHALL distinguish source, synthetic fixture, installed fixture and live selected-peer results.

#### Scenario: No real pilot target supplied
- **WHEN** synthetic and installed fixtures pass but concrete live goals or peers are missing
- **THEN** independent implementation continues
- **AND** live supervision acceptance remains pending rather than being fabricated
