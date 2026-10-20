## ADDED Requirements

### Requirement: Native bounded prompt dispatch
The extension SHALL dispatch inline scheduled work as a native custom turn only when the session is idle and has no pending host messages. It SHALL coalesce repeated due fires for the same job into one pending entry.

#### Scenario: Busy session receives repeated ticks
- **WHEN** a job becomes due repeatedly while Pi is busy
- **THEN** no model prompt is sent and only one pending entry is retained
- **AND** the latest enabled, owned definition is used when the session becomes idle

### Requirement: Lifecycle and operator limits
The extension SHALL re-check enabled state, session ownership and optional maxRuns/expiresAt immediately before dispatch. It SHALL discard pending local work when a job is removed, disabled or rescheduled and during session shutdown.

#### Scenario: Pause while waiting
- **WHEN** a due job is paused before Pi becomes idle
- **THEN** no prompt is dispatched and the paused job remains persisted after reload

### Requirement: Truthful status
An inline prompt accepted by the host SHALL be reported as dispatched, not completed or successful. An interrupted model execution without terminal evidence SHALL remain unknown.

#### Scenario: Host accepts the scheduled custom message
- **WHEN** custom-turn delivery is accepted
- **THEN** the dispatch count advances without claiming business completion

### Requirement: Safe local storage
Cooperating local writers SHALL serialize mutations, preserve unrelated jobs and fail visibly on contention or malformed data. Foreign-session jobs SHALL not be mutated through another session's management tool.

#### Scenario: Corrupt store
- **WHEN** the persisted store is malformed
- **THEN** the operation fails and does not overwrite the original bytes
