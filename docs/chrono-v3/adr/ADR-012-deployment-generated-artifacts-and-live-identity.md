# ADR-012: Deployment, generated artifacts, and live identity

Status: records the delivery contract and implemented identity checks, not a completed deployment. See the [documentation boundary](../README.md#current-documentation-boundary).

This is charter section 25's deployment topic. The pre-existing [ADR-012 rollup-repair record](ADR-012-versioned-rollup-repair-publication.md) has a different subject. Both filenames remain stable; use full links to distinguish them.

## Context

A built candidate can differ from accepted remote source or from the code already loaded by Pi. Compiled modules, native dependencies, aliases, settings, and active processes have different update boundaries.

## Decision

Treat the complete selected package, tracked distribution, locked dependencies, native SQLite build, and deployment manifest as one identified artifact. Preserve an exact accepted source/build receipt. Verify remote integration, local registration, loaded hashes, effective settings, and practical behavior separately.

Capture loaded entrypoint and deployment-manifest hashes in runtime status. Map those hashes back to the intended accepted build; a version string or alias is insufficient. Use retained package roots and safe reloads. Rollback restores only Chrono-owned values and preserves unrelated settings and all source/derived data.

[Deployment](../deployment.md) maps evidence owners. [Operations](../operations.md#deployment-and-reload-safeguards) and [recovery](../recovery.md#deployment-rollback) own the procedures.

## Alternatives

- Building live from uncommitted source prevents exact source/build attribution.
- Retargeting an unchanged alias alone does not prove an existing Pi process loaded new compiled modules.
- Treating package metadata as proof ignores distribution/native differences.
- Restoring a whole old settings snapshot can overwrite another package's newer selection.

## Consequences

Each intended process needs its own safe activation evidence. A partial roster remains partial. A backup or rollback check is not an exercised package rollback. The package stays a candidate until the required independent evidence and acceptance exist. This ADR does not authorize npm publication, a release, or a default-on change.

## Migration

Prepare the exact candidate through the controlled native/build procedure. Preserve the prior package and Chrono registration values privately before an authorized switch. Keep historical reports bound to their own revisions rather than rewriting them as current receipts.

## Reversal path

Restore the previous verified package source and compatible Chrono-owned settings at settled process boundaries. Verify loaded hashes and bounded use after rollback. Preserve old shards, routing manifests, failed derived stores, and recovery assets.
