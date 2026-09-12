# Hierarchical rollups

The indexed `rollup-v3` layer compresses closed chronological ranges from `state-v4`. It is separate from the older `rollupShadowEnabled` replay-comparison path. See the [candidate boundary](README.md#current-documentation-boundary) and [configuration](configuration.md#retired-and-separate-controls).

## Formation and meaning

`materializeRollup` reads bounded state pages, not lifetime source history. A leaf holds an episode fragment with at most eight members. The fixed fanout is eight children, not the charter's proposed initial 32. Materialization updates the bounded frontier, writes immutable hash-identified nodes, and publishes a root with its source cut and state generation.

Only intervals closed by the next episode boundary enter rollups. Open history stays outside the represented closed range. Closure does not resolve a task. Protected references and advisory metadata propagate with explicit omission counts. Node-size limits can remove detail, so a root is not a complete current contract. Child and source routes remain the recovery path.

Status distinguishes requested cut, processed body/metadata cuts, represented closed range, excluded open tail, and remaining work. A ready closed-prefix publication does not prove later-cut mandatory coverage. Recall and older-memory selection use bounded node traversal and report partial results.

[ADR-009](adr/ADR-009-rollup-fanout-and-propagation.md) owns fanout and propagation. The [state contract](../../packages/pi-chrono-compaction/src/episode-state-contract.ts) owns limits. The [rollup store](../../packages/pi-chrono-compaction/src/episode-rollup-store.ts) owns nodes, frontier, publications, and read paths.

## Explicit repair surface

Repair changes derived data. Use it only in an authorized recovery scope, with preserved source and stores and a stable selected cut. The existing [rollup-repair ADR](adr/ADR-012-versioned-rollup-repair-publication.md) owns stage identity and publication guarantees.

The implemented command runs one bounded transition per invocation:

```text
/chrono-rollup-repair start <repairId>
/chrono-rollup-repair step <repairId>
/chrono-rollup-repair status <repairId>
/chrono-rollup-repair publish <repairId> <legacy|expected-store-id>
```

1. Start one repair and retain its stage identity, bound cut, and prior active store.
2. Run a bounded step, then inspect status. Continue only while that same stage remains valid. There is no automatic repair loop.
3. Publish only a complete validated target, using the recorded prior active store. `legacy` denotes the original `rollup-v3.sqlite` route, not an instruction to guess or bypass a conflict.

The target is a new database. Publication compares the active route with the recorded expectation before changing it. Old handles without `storeId` still select the legacy store. Replacement handles bind their explicit store ID. Repair does not delete or overwrite old stores or source.

There is no general public command to restore an arbitrary active pointer. Reversal of a published route requires a separately authorized, validated operation. Ordinary lag needs resumed materialization, not repair. See [recovery](recovery.md#catch-up-and-store-refusal).
