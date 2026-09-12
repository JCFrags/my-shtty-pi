# ADR-014: Schema migration and repair

Status: records implemented per-store recovery boundaries, not a universal repair service or M12 acceptance. See the [documentation boundary](../README.md#current-documentation-boundary).

## Context

Stores have independent schemas and publication identities. An interrupted write, ordinary lag, corrupt physical database, and source mismatch are different failures. Treating all four as permission to delete and rebuild can break old pins or conceal damaged authority.

## Decision

Resume ordinary work from each store's own checkpoints. Reject unknown or incompatible identities. Use explicit reconstruction into a new generation or physical store as appropriate, validate it, and publish its route separately. Preserve old stores and source.

The catalog supports same-database generations and separate physical corruption recovery. Capsules use separate declared derived identities and immutable publication. Rollup repair has explicit `start`, `step`, `status`, and `publish` transitions. State read paths do not create or repair an existing corrupt store. Migration status only projects these layer checkpoints; it adds no lifetime cursor.

[Migration](../migration.md) maps these cases to the existing [catalog contract](../catalog-contract.md), [catalog publication](../catalog-store-publication.md), [capsule publication](ADR-003-immutable-segments-and-manifest-publication.md), and [rollup repair](ADR-012-versioned-rollup-repair-publication.md) owners.

## Alternatives

- In-place conversion of the only good store weakens rollback and old-reader identity.
- Relabeling a schema or reducer version can reuse incompatible content silently.
- Query-time repair makes normal reads unpredictable and potentially lifetime-sized.
- Scanning directories to infer ownership trusts unvalidated artifacts.
- Automatic source rewriting or cleanup violates source preservation.

## Consequences

Recovery uses extra disk and explicit operator intent. Failed or incomplete stages can remain. Old healthy pins stay usable where their original stores remain intact; corrupt stores cannot promise old-reader availability. Source changes and unsafe pointer metadata refuse rather than select a guessed replacement. There is no general `/chrono-repair` implementation or automatic garbage collection implied by the charter.

## Migration

Bind the chosen source view, schema/ruleset, store identity, and expected prior route before work. Retry the same valid stage/checkpoint. Publish only a complete validated replacement. Do not create a second stage merely because a call timed out after publication may have occurred.

## Reversal path

Leave the target unpublished, or restore a recorded compatible route through its authorized recovery procedure. Package rollback can ignore unsupported derived stores without deleting them. Preserve every source shard, logical manifest, healthy pin, and failed evidence. Follow [recovery](../recovery.md).
