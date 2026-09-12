# Event capsules and decoded chunks

Capsules move source-local reduction to incremental derivation. They do not establish current truth or replace the timeline. This is implemented candidate behavior under the [documentation boundary](README.md#current-documentation-boundary).

## Two different products

- A **capsule** is a deterministic, explicitly lossy alternative with source references, reducer identity, protected cues, and omission information.
- A **decoded chunk** preserves exact decoded UTF-16LE bytes for selected recovery. Fixed chunks contain at most 32,768 UTF-16 code units. A boundary can split a surrogate pair, so callers must preserve coordinates rather than normalize text.

The catalog supplies pinned event and descriptor access. Derivation writes a separate `derived.sqlite` plus immutable capsule/chunk segments. Content manifests describe immutable bytes. Publication receipts record bounded checkpoint progress. Receipts can vary with job partitioning even when canonical content does not.

[ADR-005](adr/ADR-005-event-capsule-schema-and-reducer-versioning.md) owns the reducer contract and version history. [ADR-003](adr/ADR-003-immutable-segments-and-manifest-publication.md) owns encoding, publication order, private decode carry, and recovery. These records retain their original milestone status language.

## Reduction and readiness

Source-local reducers operate on bounded windows. They preserve selected exact conditions, exceptions, negation, identifiers, and decisive outcomes with coordinates. Missing structural support stays unknown. A cue, quoted success, or generated retrieval copy cannot establish completion or approval.

Request-specific relevance, later resource evidence, current-state transitions, and final context selection are not frozen as source-local reducer facts. The [state layer](episodes-and-state.md) and [composer](context-composer.md) own those later operations.

Capsule and chunk readiness are separate from catalog readiness. Unsupported, excluded, failed, or degraded content must not be counted as successful reduction. A missing or corrupt segment makes a read refuse. The read does not regenerate bytes, scan segment directories, or overwrite a hash-named object.

## Compatibility and recovery

A schema, reducer-set, configuration, or physical catalog change requires a compatible declared identity, not a relabeled old store. Explicit reconstruction uses bounded catalog access and a new derived identity. Retain old healthy pins and all source. Use [migration](migration.md) for the recovery boundary.

Implementation entry points: [contract](../../packages/pi-chrono-compaction/src/capsule-contract.ts), [derivation](../../packages/pi-chrono-compaction/src/capsule-derive.ts), and [store](../../packages/pi-chrono-compaction/src/capsule-store.ts).
