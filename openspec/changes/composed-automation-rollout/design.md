# Design

Normative scope and reference pins: docs/automation-roadmap.md. Stages B/C/D execute sequentially and retain prior stage evidence.

The online controller is the existing parent Pi session plus a packaged bounded supervision prompt. Native tools provide live peer identity and explicit wake. This deliberately avoids a new goal database or peer runner. An event source may only select a configured task; payloads are bounded data and cannot supply new commands/authority. Existing disabled/expiry/ownership controls apply to every path.

Persistent scheduling intent and transport/launch acknowledgements are separate from execution and business verification. Current job store remains the task-definition owner. Stage C/D persistence contains only event dedup, occurrence/claim and existing execution handle references. Reconciliation is read-before-replay: missing/expired aliases do not prove no effect. No generic catch-and-retry wraps model/side-effectful work.

The dedicated installed supervisor uses fixed package/runtime pins and the current SDK/RPC. It never takes over an arbitrary terminal. Launchd is an optional native lifecycle wrapper, not another agent execution engine. Existing host credentials and model scopes stay in place.

Stage D uses opt-in session-bound durable jobs, schema3 of the original store and unique local claims. A pre-dispatch dead-owner claim can release its unspent admission; dispatched/started work needs an exact native schedule_execution receipt or becomes unknown/paused. Local owner liveness is not terminal proof and never authorizes stealing a live child. One durable slot is serialized across cooperating writers in the same store/session; deadlines hold the local slot until the exact handle settles. Notification acceptance is separately retained, never interpreted as execution failure/retry permission.

The fixed native RPC host requires maxRuns/expiresAt on service jobs. It pins binary/installer/cwd/session/model, retains normal CLI guards/resources, owns a kernel-held authenticated loopback control endpoint and private fixed-config identity, and stops only its own child. Native stock RpcClient was not reused because its raw stderr forwarding/unbounded retention and SIGTERM stop do not satisfy this metadata-only graceful-EOF envelope. The transport remains the documented native RPC protocol, with bounded LF framing/requests and denied/cancelled unattended UI. No arbitrary extra CLI arguments or default boot prompt are accepted. launchd output is opt-in, not service activation. Exact behavior and operational HOLD boundaries: docs/durable-supervisor.md.

Acceptance ascends from unit/controlled SDK/broker fixtures to installed two-peer fixtures and bounded real selected peers. No paid calls or private coordination histories are used as test fixtures. No production/external operations are inferred from a successful event or reminder.
