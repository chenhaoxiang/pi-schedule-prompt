# Sequential rollout tasks

## Analysis and owner plan
- [x] Verify existing public integration seams and pin routines/reactor references.
- [x] Write the single overall roadmap, capability mapping and per-stage acceptance.

## B — Online closed loop
- [x] Package a bounded supervisor prompt and operations contract using native tools.
- [x] Add provider-free two-peer end-to-end fixtures for wake, reply/evidence and stop/offline behavior.
- [x] Implement fixed payload/provenance/checksum and installation helpers, with source/file/tamper fixtures.
- [x] Produce and verify the exact reviewed fixed payload (stage B Release v0.4.1-fork.2, source d18f298).
- [x] Install into a dedicated supervisor context without disrupting business sessions (explicit pinned launcher; zero active targets/schedules).
- [x] Record exact source/review/CI/install fixture results and missing real pilot target (PR #2 delivery comment; later operator-selected one-peer stop pilot is recorded separately below).

## C — Event-driven admission
- [x] Add explicit local/lifecycle event triggers with unified task admission.
- [x] Add bounded dedup, daily limits, pause/expiry and missed-event policy.
- [x] Add selected GitHub PR/CI polling and optional authenticated loopback API, both explicitly configured/off by default.
- [x] Prove every fire path and publish exact-head stage evidence (PR #3; main55796b2, release fork.3,184 source tests/9 installed cases).


## D — Durable operation
- [x] Persist intents/claims and reconcile exact native execution receipts/owner handles after interruption.
- [x] Add bounded native supervisor service/start/status/confirmed stop and concurrency/deadline handling.
- [x] Add bounded pre-admission contention retry, consecutive-error stop and notification outbox.
- [x] Run controlled dispatch/receipt/ownership/deadline/duplicate-launch/real parent-crash/stop fixtures with native SDK/RPC and faux inference.
- [x] Publish exact-head D review/CI/fixed installation evidence (PR #4/main3594bbe/release fork.4;218 source tests,16 installed cases, actual native CLI and normal-host zero-job readback).
- [x] Run operator-selected one-peer live stop acceptance (game-development peer, one real native turn, completed/awaiting-user judgment, self-disable and confirmed own-host stop; docs/live-supervision-pilot.md). This narrows the original two-live-goal pilot; unfinished-goal advancement is not claimed.

## Final source/runtime delivery
- [x] Complete independent review, required CI and regular merge/readback for implementation stages B/C/D.
- [x] Report installed/active/live separately; the selected live stop case does not substitute for unfinished-goal/physical-device/OS-reboot acceptance.
