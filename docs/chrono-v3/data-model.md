# Data model and identity

This page describes the implemented candidate model under the [documentation boundary](README.md#current-documentation-boundary). It is a map of ownership, not a second schema specification.

## Data owners

| Data | Owner and role |
| --- | --- |
| Exact events | Pi session JSONL. Existing source records and closed shards are not rewritten by ChronoCompact. |
| Logical routing | The owner-only logical manifest binds branches, physical source routes, final catalog cuts, and pending rollover operations. This routing data is not a disposable summary. |
| Source catalog | The catalog stores event order, ancestry, offsets, descriptors, hashes, and parser checkpoints. It does not store searchable bodies or semantic claims. |
| Capsules and decoded chunks | A separate derived store binds its own physical identity to the catalog. Immutable segments hold lossy capsule alternatives and exact decoded text chunks. |
| Search | A separate search identity binds catalog and capsule inputs to disk-backed cue and raw lexical indexes. Each branch lineage has ingestion progress. |
| Episodes and state | `state-v4.sqlite` stores episode membership, source-backed propositions, resource observations, and advisory memory metadata. Body and metadata progress are separate. |
| Rollups | `rollup-v3.sqlite`, or an explicitly published replacement, stores immutable closed-episode nodes and a bounded append frontier. |
| Composition | A minimal envelope stays in Pi's compaction entry. Selected rows and comparison details stay in private composition artifacts. Neither replaces source. |

See [source catalog](source-catalog.md), [capsules](event-capsules.md), [search](search-and-recall.md), [state](episodes-and-state.md), [rollups](rollups.md), and [logical sessions](logical-sessions.md) for their distinct read and write paths.

## Terms that must remain distinct

- A **physical store identity** names one database or derived-store instance. Rebuilding another instance does not preserve its identity.
- A **generation** names a publication within its owning store. Catalog, search, state, and rollup generation numbers are not interchangeable.
- A **cut** is the selected historical boundary. A catalog view binds that cut to the physical catalog, session, branch, and ancestor segment cuts.
- A **source reference** binds an event and descriptor to raw or decoded coordinates and integrity metadata. An entry ID alone is not a complete reference.
- A **recovery handle** adds the route and publication scope needed to resolve selected evidence. Do not edit a handle to force it into another view.

Compatible appends can preserve an older pin. A sibling branch, different store, changed source, or incompatible generation cannot gain access merely because an event number is below the cut.

## Authority and compatibility

Exact copied text identifies what a source said. It does not prove the statement true or grant the source user authority. Generated retrieval copies, summaries, and ordinary memory retain their provenance. Cut readiness and category coverage are not semantic certification.

The binding contracts are [catalog](../../packages/pi-chrono-compaction/src/catalog-contract.ts), [capsule](../../packages/pi-chrono-compaction/src/capsule-contract.ts), [search](../../packages/pi-chrono-compaction/src/search-v3-contract.ts), [state](../../packages/pi-chrono-compaction/src/episode-state-contract.ts), and [logical session](../../packages/pi-chrono-compaction/src/logical-session-contract.ts). Schema and reducer identities are independent of package version. Follow [migration](migration.md) for incompatible data, not an in-place version relabel.
