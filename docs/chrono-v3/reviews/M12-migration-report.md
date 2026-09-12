# M12 migration candidate

Status: implementation and focused integration evidence. M11 qualification, protected publication, default activation, all-session adoption, and exercised deployment rollback remain pending. This is not V3 acceptance.

## Normal architecture

`memoryEngineEnabled` selects the existing indexed pipeline and readiness-gated snapshot composer. `PI_CHRONO_MEMORY_ENGINE` is the environment override. The candidate default remains off until final qualification. No activation command is required when deployment enables this setting.

Each enabled session reads its exact session/source exclusion before adoption. An explicit search disable, persisted false record, unsafe rollout path, or invalid logical binding prevents activation. A logical continuation cannot override a persisted exclusion.

Eligible fresh and existing sessions adopt their current physical file as logical shard zero. The deterministic logical-store identity supports retry after a crash between manifest publication and binding append. One non-model custom entry records the binding. Resume validates the manifest against the actual Pi session and source path. A copied or malformed binding refuses instead of creating a replacement identity.

The migration status machine reads the catalog, capsule, search, memory, and rollup checkpoints. These stores own restart progress. No second lifetime migration cursor or source rebuild is introduced. `awaiting-cut-validation` means the stores are ready for a cut-specific check, not that composition coverage passed.

The normal V3 path does not schedule the legacy incremental candidate reconstruction. It estimates only Pi's retained tail before snapshot selection. It does not construct the compatibility estimator over historical bodies. Before a provider summary call, it requires the actual pinned selection to cover mandatory state. It then retains the independently obtained regular Pi summary, validates the tail and combined ceiling, and writes only the minimal composition envelope to Pi. A failed gate cancels compaction and preserves the current context.

## Logical-session interface

- Startup adoption and manual adoption use the same idempotent binding path.
- `chrono-logical-session fork` uses the same validated continuation and idle/source checks as rollover. The child starts empty and retains explicit parent catalog ancestry.
- Recovery can return from an empty replacement to its exact old parent after a pre-setup interruption.
- Status reports source byte size from file metadata and record/compaction counts from the already loaded physical branch. It does not parse archived source to obtain these counts.
- Automatic rollover remains disabled. Physical Pi `/fork` is not the logical-fork operation.

## Operator boundaries

1. Build and verify an exact accepted revision before changing its registration. Keep the package, startup authorization, and native dependency identity together.
2. Save the current Chrono source slot, alias, configuration, and rollback assets. Restore only Chrono-owned values, not a whole settings snapshot that can overwrite another package's newer selection.
3. Refresh the complete live process roster. A changed package source does not prove a running process loaded it.
4. Reload a session only after its tools, managed jobs, compaction, and switch have settled and its editor is empty. Pi reload emits shutdown events and can stop managed jobs. Preserve drafts and let work finish naturally.
5. Check loaded runtime identity, automatic tools, migration progress, actual composition gates, and bounded retrieval for each live session. Record blocked coverage and pending reloads separately.
6. For migration repair, resume the existing store checkpoints. Do not reset catalog or source identity, delete old shards, or clear coverage gaps to force readiness.
7. Exercise scoped rollback only at the same safe boundary. Retain both source and derived stores so the prior release can reopen its own supported generations. A rollback-check result is not an exercised rollback.

No shared deployment or live-session rollback has been performed for this candidate. The final receipt must record those results independently from the focused fixture below.

## Focused evidence

1. The exclusion fixture passed all three cases: explicit configuration disable, persisted exclusion, and unsafe rollout directory. Each existing-session compaction cancelled before legacy reconstruction. Migration readiness did not claim cut eligibility.
2. A real Pi 0.85.1 process opened an existing synthetic on-disk session, adopted it without an activation command, and performed search, staged recall, and exact recovery. A second fresh process resumed the same session and repeated those operations. Both observed exactly one adoption entry and one logical route. The combined check passed in 14.54 seconds. No provider call or shared configuration change occurred.

The first private fixture attempt lacked dependency resolution from its external output directory. It failed before execution. After the staged metadata and dependency link were supplied, the affected fixture passed. The prerequisite is documented in `test-recovery.md`.

These checks do not prove original large-session coverage, ten-store retrieval, full-scale composition, default deployment, or all-session live adoption. Those criteria remain open. Later command integration and qualification use the required CI and consolidated M11 evidence rather than another broad local suite.
