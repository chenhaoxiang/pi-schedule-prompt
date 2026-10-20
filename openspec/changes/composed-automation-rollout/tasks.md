# Sequential rollout tasks

## Analysis and owner plan
- [x] Verify existing public integration seams and pin routines/reactor references.
- [x] Write the single overall roadmap, capability mapping and per-stage acceptance.

## B — Online closed loop
- [x] Package a bounded supervisor prompt and operations contract using native tools.
- [x] Add provider-free two-peer end-to-end fixtures for wake, reply/evidence and stop/offline behavior.
- [x] Implement fixed payload/provenance/checksum and installation helpers, with source/file/tamper fixtures.
- [ ] Produce and verify the exact reviewed fixed payload.
- [ ] Install into a dedicated supervisor context without disrupting business sessions.
- [ ] Record exact source/review/CI/install fixture results and any missing real pilot target.

## C — Event-driven admission
- [ ] Add explicit local/lifecycle event triggers with unified task admission.
- [ ] Add bounded dedup, daily limits, pause/expiry and missed-event policy.
- [ ] Add selected GitHub PR/CI polling and optional authenticated loopback API only as required.
- [ ] Prove every fire path and publish exact-head stage evidence.

## D — Durable operation
- [ ] Persist intents/claims and reconcile existing execution handles after interruption.
- [ ] Add bounded native supervisor service/start/status/stop and concurrency/deadline handling.
- [ ] Add safe pre-effect retry, consecutive-failure stop and notification state.
- [ ] Run controlled crash/recovery/duplicate-launch/stop fixtures, then scoped live acceptance.

## Final source/runtime delivery
- [ ] Complete independent review, required CI and regular merge/readback per stage.
- [ ] Report installed/active/live separately; do not declare missing target acceptance complete.
