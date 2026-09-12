# Search and staged recall

Use search to locate a cue, recall to expand selected memory, and exact retrieval to verify source. These operations have different fidelity and cost. See the [candidate boundary](README.md#current-documentation-boundary) and the command sequence in [operations](operations.md#search-and-recall).

## Implemented index

The search store uses SQLite FTS5 for bounded capsule cues, identifiers, paths, and a raw lexical locator over decoded chunk text. It does not implement embeddings, a semantic-claim store, or an autonomous recall loop. Lifecycle ingestion publishes indexes before queries use them. A query never starts index construction or a whole-session parser.

Ranked queries find lexical cues. Literal queries verify selected text and coordinates. Regular-expression mode requires an explicit bounded scan and supports only the implemented subset. Unsupported assertions and empty-matching expressions refuse. Nonselective queries can return `search-v3-query-budget`; narrow the query or use the supported explicit scan instead of increasing limits.

An explicit scan is capped at 64 chunks and 250 ms per worker request. The query candidate bound is 128. These are work limits, not an exhaustive-search promise. Inspect partial/coverage fields and continue the supplied cursor. The current query path rejects unresolved-state filtering and `currentState` values other than `any`; use staged state recall rather than implying those filters exist.

## Recovery routes

| Interface | Result and limit |
| --- | --- |
| `history_search` | Bounded cues and opaque handles. Logical routing checks at most eight shard routes per call. Continue even an empty page when it has `nextCursor`. |
| `history_recall` | Cue, episode, resource, state, rollup, or bounded block expansion. Derived results remain partial and source-linked. |
| `history_get` | Exact decoded text or raw event bytes. Decoded pages are capped at 8,192 UTF-16 units. Raw pages continue with `nextByte`. |
| `history_range` | Bounded chronological source pages within one named shard, not a cross-shard concatenation. |
| `history_status` | Cached readiness, requested/indexed cuts, lag, and safe errors. No source read or ingestion. |

Handles bind the catalog, capsule and search identities, generation, branch, cut, and source coordinates. A stale or incompatible handle refuses. Obtain a new search handle rather than modifying it. A known compatible older prefix can remain usable while later ingestion catches up.

Generated retrieval content is classified separately to prevent copied answers from becoming independent evidence. A search hit is not proof of exact wording, current state, task resolution, or approval. Follow exact recovery before relying on those claims.

## Owners

[ADR-006](adr/ADR-006-cue-index-and-raw-lexical-locator.md) records the index decision. The [protocol](../../packages/pi-chrono-compaction/src/search-v3-contract.ts), [store](../../packages/pi-chrono-compaction/src/search-v3-store.ts), and [Pi adapter](../../packages/pi-chrono-compaction/src/history-search-adapter.ts) own detailed query, cursor, and rendering behavior. [Recovery](recovery.md#search-and-exact-recovery-problems) owns refusal handling. No scale or final-candidate qualification result is established here.
