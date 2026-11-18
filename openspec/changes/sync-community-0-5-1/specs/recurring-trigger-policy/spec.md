# Inactivity-trigger addition

## ADDED Requirements

### Requirement: One idle admission per user inactivity stretch
An explicit idle schedule SHALL wait its configured positive duration and for the agent to settle. It SHALL re-arm on actual user input or a new session, not on its own turn, an unrelated scheduled turn or an edit to an enabled job. It SHALL use existing authorization and admission limits without durable catch-up.

#### Scenario: User is inactive through an always-visible overlay
- **WHEN** the threshold passes with no user input, no blocking question and no active agent run
- **THEN** the eligible idle job fires once even if a passive overlay is visible

#### Scenario: A blocking prompt defers a due job
- **WHEN** a question dialog is open or there is no final agent-settled state
- **THEN** the job waits without consuming an attempt; a stale pending idle deadline cannot override newer user activity
