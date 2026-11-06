# Spec Delta

## Purpose

Bind each scheduled attempt to a real native execution and retain truthful progress and cancellation evidence even when the final model response fails or tools outlive a cancellation request.

## ADDED Requirements

### Requirement: Exact native execution identity
Each resilient attempt SHALL bind a stable logical job, unique attempt, owning session/epoch, accepted configuration revision and native run handle. Dispatch, progress, cancellation and settlement SHALL apply only to that binding; delivery acceptance or session idle SHALL NOT prove business completion.

#### Scenario: Late receipt from an earlier owner
- **WHEN** a previous owner emits a receipt after ownership transferred to a later epoch
- **THEN** it is retained as historical evidence without settling or cancelling the new attempt

#### Scenario: Ordinary user turn interleaves
- **WHEN** the host starts an unrelated user turn while an earlier scheduled receipt is pending
- **THEN** scheduled deadline handling cannot cancel or settle that user turn

### Requirement: Single-flight survives cancellation and restart
At most one execution owner for the same logical job in the same store SHALL be active. Running, draining and cancelling handles SHALL retain the slot until exact settlement or verified termination. A timer, expired lease, process absence or cancellation request alone SHALL NOT authorize an overlapping executor.

#### Scenario: Slow cancellation acknowledgement
- **WHEN** a deadline requests cancellation but the owned tool or native run has not settled
- **THEN** the slot remains held, status reports cancellation pending and no new same-job attempt starts

#### Scenario: Duplicate host or owned child remains active
- **WHEN** another cooperating host tries to acquire the same job or an explicitly owned child remains in flight
- **THEN** a second executor is rejected or deferred without stealing the existing handle

### Requirement: Separate cadence and bounded execution clocks
Cadence, connection/first-response timeouts, tool timeouts, retry elapsed budget, soft work budget and hard execution deadline SHALL have distinct meanings. A next scheduled tick SHALL NOT itself cancel productive work; activity and retries SHALL NOT extend an explicit hard deadline.

#### Scenario: Execution exceeds cadence
- **WHEN** an eighty-minute execution has a sixty-minute cadence and a separately configured sufficient hard budget
- **THEN** it remains single-flight and follows overlap policy rather than being cancelled by the sixty-minute tick

#### Scenario: Repeated errors are not activity renewal
- **WHEN** provider errors or repeated tool reads continue until the hard deadline
- **THEN** the hard deadline stays unchanged and those events are not reported as business progress

### Requirement: Run-scoped retry policy
Scheduled execution SHALL apply an explicitly bounded retry profile only to its native run. It SHALL reuse native transient-error classification and completed-tool history. It SHALL NOT rewrite global retry settings, create a second provider retry loop or rerun completed tools when retrying a model response.

#### Scenario: Scheduled and ordinary interaction policies differ
- **WHEN** an unattended run uses a small retry budget and an ordinary user run uses existing retry settings
- **THEN** the scheduled policy ends with its run and does not leak to the ordinary run

#### Scenario: Provider requests a long retry delay
- **WHEN** Retry-After or the next retry would exceed the scheduled run's remaining budget
- **THEN** no premature retry is sent and the runtime returns a truthful deferred or interrupted result for scheduler backoff

### Requirement: Native drain and checkpoint do not require final prose
At a safe execution boundary, draining SHALL prevent new business work and persist a bounded native checkpoint without requiring a successful final model summary. Checkpoints SHALL reference actual completed result entries, declared artifacts and unresolved effects; unavailable next actions or business outcomes SHALL remain unknown rather than fabricated.

#### Scenario: Final summary repeatedly fails
- **WHEN** earlier tools finished but the final summary receives transient errors until its retry budget expires
- **THEN** completed results and an interrupted or deferred runtime receipt remain recoverable without rerunning those tools or claiming business success

#### Scenario: Drain begins while model work is in flight
- **WHEN** the soft budget expires during model processing
- **THEN** the next safe boundary enters draining without launching a new inference solely to produce bookkeeping prose

### Requirement: Safe finalization cannot bypass tool guards
Local checkpoint facilities SHALL remain available while draining without opening arbitrary shell, wrapper or external write execution. Existing tool guards SHALL apply to nested as well as direct calls; denied operations SHALL be clearly identified as not executed.

#### Scenario: Wrapper requests an external action during drain
- **WHEN** a shell or codemode wrapper would start new business work during finalization
- **THEN** the operation is denied and the runtime still has a supported native path to persist its checkpoint

### Requirement: Capability negotiation is explicit
The scheduler SHALL verify required native execution capabilities before admitting a resilient run. An unsupported host SHALL return an explicit compatibility disposition without inference, budget consumption or false success. Legacy jobs SHALL retain their declared legacy behavior rather than silently gaining unsafe recovery.

#### Scenario: New scheduler on an older Pi host
- **WHEN** the host lacks run-scoped control or settlement acknowledgement
- **THEN** the resilient job reports unsupported runtime and does not pretend a void cancellation request is an exit acknowledgement
