# Spec Delta

## Purpose

Provides one finite, exact-message-bound follow-up timer for an Intercom request, so a missing reply receives a bounded checkpoint reminder without replaying the original business action or creating duplicate supervision.

## ADDED Requirements

### Requirement: Exact binding
The follow-up SHALL persist and compare the originating session, Intercom session/request identifier, original message identifier, target session, goal, and phase before creating, cancelling, dispatching, or reporting a follow-up.

#### Scenario: Same message deduplicates
- **WHEN** creation is requested twice with the same exact binding and an active follow-up already exists
- **THEN** the second request returns the existing timer identity and does not create another schedule or wake

#### Scenario: Different message does not deduplicate
- **WHEN** a follow-up is requested for a different original message or target
- **THEN** it is treated as a separate binding and is not allowed to cancel or reuse the first timer

### Requirement: Finite schedule bounds
A follow-up SHALL require a positive deadline, a positive frequency/initial delay, a positive maximum run count, and an absolute future expiry; no unbounded follow-up is accepted.

#### Scenario: Invalid or unbounded request
- **WHEN** any bound is missing, non-positive, exceeds the supported limit, or has expired
- **THEN** creation is rejected without writing a job or scheduling a wake

#### Scenario: Existing hourly schedule
- **WHEN** the owner already has the configured hourly inspection schedule
- **THEN** creating a reply follow-up does not create a second recurring inspection schedule; the request is either covered by the exact existing schedule or rejected as a duplicate, with a readback reason

### Requirement: Reply cancellation is exact and read back
An exact reply carrying `replyTo` equal to the original message identifier SHALL close only that reply-wait and cancel only its matching follow-up; cancellation SHALL return a persisted readback showing disabled/removed or an explicit unknown result.

#### Scenario: Matching reply arrives before the timer
- **WHEN** the original target sends a reply whose `replyTo` exactly equals the tracked message identifier
- **THEN** the reply-wait closes, the matching timer is cancelled, and the caller receives cancellation readback; execution and business completion remain unknown

#### Scenario: Unrelated ordinary message arrives
- **WHEN** a message lacks `replyTo` or points to another message
- **THEN** no follow-up is cancelled and the original reply-wait remains governed by its deadline

### Requirement: Cancel and dispatch are race-safe
Cancellation SHALL purge queued follow-up work and the scheduler SHALL re-read binding, enabled state, expiry, run count, and phase immediately before dispatch; a stale queued wake SHALL not send after a successful cancellation.

#### Scenario: Cancel while queued
- **WHEN** a timer becomes due while the owner is busy and is then cancelled before the owner becomes idle
- **THEN** the queued wake is removed and no follow-up transport is attempted after idle

#### Scenario: Cancel races with due dispatch
- **WHEN** cancellation and due dispatch overlap
- **THEN** at most one path wins the persisted state transition; the loser records cancelled or unknown and does not replay the original action

### Requirement: Checkpoint semantics
A follow-up reminder SHALL identify the exact phase and goal and SHALL state that ACK/PENDING is not business completion; an ACK/PENDING observation SHALL not settle the underlying business goal or create a new action automatically.

#### Scenario: ACK or PENDING reply
- **WHEN** the target replies with ACK/PENDING for the follow-up
- **THEN** the transport/reply wait is recorded as answered, business completion remains unknown, and any next reminder requires a new explicit checkpoint binding

### Requirement: Unknown recovery evidence
Restart, disconnect, late reply, timer delivery timeout, or uncertain send outcome SHALL retain an `unknown` record tied to the exact binding; the implementation SHALL not infer execution or completion from delivered, received, injected, wake-requested, or idle state.

#### Scenario: Restart or disconnect
- **WHEN** the owner or broker restarts/disconnects while a follow-up claim or transport is unresolved
- **THEN** the persisted follow-up is marked unknown or paused for reconciliation and is not blindly replayed

#### Scenario: Late reply after expiry
- **WHEN** an exact reply arrives after the follow-up expired, was cancelled, or was recorded unknown
- **THEN** it is recorded as a late reply for the same message identifier without reopening or replaying the timer
