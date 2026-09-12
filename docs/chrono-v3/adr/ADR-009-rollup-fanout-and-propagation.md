# ADR-009: Rollup fanout and protected propagation

Status: records implemented rollup-v3 behavior, not an optimal-fanout benchmark or M11 acceptance. See the [documentation boundary](../README.md#current-documentation-boundary).

## Context

Historical selection must not rebuild all episodes. Closed chronological units need a bounded hierarchy with explicit source coverage, while unresolved work must not silently disappear during compression.

## Decision

Use episode-fragment leaves of at most eight members and a fixed fanout of eight. Maintain an append frontier and immutable hash-identified nodes. A publication binds its root, branch, state generation, and cut. Only next-boundary-closed intervals enter the tree.

Propagate protected references and advisory metadata with explicit omission counts. Preserve ordered child/source recovery routes. Node and traversal bounds can reduce displayed detail, but closure never implies task completion. The current-state selection remains separate from historical rollups.

[Rollups](../rollups.md) owns the source map and operator behavior. The existing [rollup-repair record](ADR-012-versioned-rollup-repair-publication.md) owns replacement-store publication.

## Alternatives

- The charter proposes an initial fanout of 32. The implemented constants use eight to keep each parent and input page smaller. This ADR records that actual choice, not evidence that eight is globally optimal.
- Rebuilding a complete tree at each append repeats lifetime work.
- Updating closed node bytes breaks immutable handles.
- Treating the root as all current state hides open-tail exclusions and capped propagation.

## Consequences

Smaller fanout creates more levels. Bounded recall may require staged expansion and may remain partial. Omission counts must remain visible. A ready closed prefix does not certify later-cut mandatory coverage or semantic completeness.

## Migration

Ruleset or incompatible layout changes require a compatible explicit store identity. Repair builds a separate database from valid state pages and publishes only a complete validated target. Old stores and handles are retained.

## Reversal path

Leave a staged target unpublished or restore a recorded compatible active route through an authorized operation. There is no broad deletion or public arbitrary-pointer rollback command. Source, state, and old rollup nodes remain untouched. See [recovery](../recovery.md).
