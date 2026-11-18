# Project-store layout transition

## ADDED Requirements

### Requirement: One explicit project-store import
The active store SHALL be scoped by Pi profile and canonical project path. Moving a legacy store SHALL require operator-observed writer and handle quiescence plus exact source and target snapshots. Startup SHALL NOT import it, and migration SHALL preserve schema, owner, enablement, budgets and retained execution evidence.

#### Scenario: Exact migration with settled UNKNOWN
- **WHEN** the verified legacy source and target still match the preview and no execution is owned
- **THEN** the target retains the original job rows and UNKNOWN evidence; the source is left untouched and retry cannot resurrect removed jobs

#### Scenario: Conflicting or changed snapshot
- **WHEN** either layout is corrupt, a writer still holds its lock, a preview has changed or IDs contain conflicting data
- **THEN** migration refuses to overwrite either store

### Requirement: Layout-aware rollback readback
Rollback across layouts SHALL distinguish the comparable on-disk state from loaded version and handle closure. A stale source, new unsupported idle record or newer target activity SHALL hold rollback rather than rewrite either layout.

#### Scenario: New version has admitted more work
- **WHEN** the target contains an attempt not present in the old layout
- **THEN** the read-only rollback check holds and reports no permission to restore an older snapshot
