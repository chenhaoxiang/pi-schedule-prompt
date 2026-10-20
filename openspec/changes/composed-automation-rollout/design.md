# Design

Normative scope and reference pins: docs/automation-roadmap.md. Stages B/C/D execute sequentially and retain prior stage evidence.

The online controller is the existing parent Pi session plus a packaged bounded supervision prompt. Native tools provide live peer identity and explicit wake. This deliberately avoids a new goal database or peer runner. An event source may only select a configured task; payloads are bounded data and cannot supply new commands/authority. Existing disabled/expiry/ownership controls apply to every path.

Persistent scheduling intent and transport/launch acknowledgements are separate from execution and business verification. Current job store remains the task-definition owner. Stage C/D persistence contains only event dedup, occurrence/claim and existing execution handle references. Reconciliation is read-before-replay: missing/expired aliases do not prove no effect. No generic catch-and-retry wraps model/side-effectful work.

The dedicated installed supervisor uses fixed package/runtime pins and the current SDK/RPC. It never takes over an arbitrary terminal. Launchd is an optional native lifecycle wrapper, not another agent execution engine. Existing host credentials and model scopes stay in place.

Acceptance ascends from unit/controlled SDK/broker fixtures to installed two-peer fixtures and bounded real selected peers. No paid calls or private coordination histories are used as test fixtures. No production/external operations are inferred from a successful event or reminder.
