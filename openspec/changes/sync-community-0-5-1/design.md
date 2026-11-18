# Design

## Decisions

1. **Reuse the existing scheduler and admission.** Idle timers produce only a local intent. Busy state, blocking dialogs, user input and final agent settlement control that intent; normal fork authorization, dispatch and accounting still own execution. Idle is not a resilient cadence or an unattended retry.
2. **Use the community profile/project address, not its startup import.** A dedicated offline command reads two exact snapshots, then locks the legacy source and destination in that order. It will merge disjoint definitions or byte-equivalent parsed rows, but not choose between conflicting definitions/evidence. It preserves the source and any overwritten target bytes. No import or schema promotion is required for an empty project.
3. **Keep fork release and Pi runtime contracts.** Peers remain host-bound; candidate testing covers both the existing SDK baseline and maintained Pi 1.5.2. The legacy model runner preserves isolated child extension loaders and the fork's route validation. Its bounded wait does not manufacture an SDK-close receipt for a native attempt.

## Migration and rollback

See the operator steps in [the existing reliability runbook](../../../docs/reliable-scheduling.md#project-store-cutover-from-041-fork23). Assign each old project-local file to exactly one target profile. Old binaries can still read the old file: an import lock is not proof that they stopped or won't restart. An unexpected legacy mutation or target conflict holds the new store. Before rollback, compare current state on both sides; never copy a stale backup over current work.
