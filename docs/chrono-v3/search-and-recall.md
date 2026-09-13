# Search and staged recall

Use search to locate a cue, recall to expand selected memory, and exact retrieval to verify source. These operations have different fidelity and cost. See the [candidate boundary](README.md#current-documentation-boundary) and the command sequence in [operations](operations.md#search-and-recall).

## Implemented index

The search store uses SQLite FTS5 for bounded capsule cues, identifiers, paths, and a raw lexical locator over decoded chunk text. It does not implement embeddings, a semantic-claim store, or an autonomous recall loop. Lifecycle ingestion publishes indexes before queries use them. A query never starts index construction or a whole-session parser.

Ranked queries find lexical cues. Literal queries verify selected text and coordinates. Regular-expression mode requires an explicit bounded scan and supports only the implemented subset. Unsupported assertions and empty-matching expressions refuse. Common ranked or literal queries return bounded candidate pages, not a refusal merely because more matches exist.

Indexed queries rank at most 128 candidates per window. Ranked mode visits up to 64 cue postings and 64 raw-text postings, plus one lookahead posting per index. Literal mode visits up to 128 raw-text postings plus one lookahead. SQLite limits the matching postings before source-view and other filters. A selective filter can therefore produce an empty page with `nextCursor`. Continue that cursor rather than treating an empty page as absence.

Windows start with the newest indexed postings and use a pinned generation and descending rowid continuation. Ranking applies within one window, not across the entire history. Selected hits retain chronological order within each page. A source can recur in a later window through another chunk or its cue. No match count, whole-history query scan, embedding, or provider call is required. Older query cursors from the former candidate planner refuse rather than silently changing their meaning. Exact recovery handles remain compatible.

An explicit scan is capped at 64 chunks and 250 ms per worker request. These are work limits, not an exhaustive-search promise. Inspect partial/coverage fields and continue the supplied cursor. The current query path rejects unresolved-state filtering and `currentState` values other than `any`; use staged state recall rather than implying those filters exist.

## Recovery routes

| Interface | Result and limit |
| --- | --- |
| `history_search` | Bounded cues and opaque handles. Logical routing checks at most eight shard routes per call. Continue even an empty page when it has `nextCursor`. |
| `history_recall` | Cue, episode, resource, state, rollup, or bounded block expansion. Derived results remain partial and source-linked. |
| `history_get` | Exact decoded text or raw event bytes. Decoded pages are capped at 8,192 UTF-16 units. Raw pages continue with `nextByte`. |
| `history_range` | Bounded chronological source pages within one named shard, not a cross-shard concatenation. |
| `history_status` | Cached readiness, requested/indexed cuts, lag, and safe errors. No source read or ingestion. |

For a small response budget, the adapter removes optional diagnostics and shortens the cue before removing recovery information. Search and rollup pages retain immutable recovery/expansion and continuation references. `detailsOmitted` or `cuePartial` marks reduced display. If the references themselves cannot fit, the request refuses without advancing the cursor. Use `history_status` separately for readiness. A 500-token search budget is useful for an ordinary one-hit cue page, but it cannot guarantee space for every possible reference or logical route.

Handles bind the catalog, capsule and search identities, generation, branch, cut, and source coordinates. A stale or incompatible handle refuses. Obtain a new search handle rather than modifying it. A known compatible older prefix can remain usable while later ingestion catches up.

Generated retrieval content is classified separately to prevent copied answers from becoming independent evidence. A search hit is not proof of exact wording, current state, task resolution, or approval. Follow exact recovery before relying on those claims.

## Owners

[ADR-006](adr/ADR-006-cue-index-and-raw-lexical-locator.md) records the index decision. The [protocol](../../packages/pi-chrono-compaction/src/search-v3-contract.ts), [store](../../packages/pi-chrono-compaction/src/search-v3-store.ts), and [Pi adapter](../../packages/pi-chrono-compaction/src/history-search-adapter.ts) own detailed query, cursor, and rendering behavior. [Recovery](recovery.md#search-and-exact-recovery-problems) owns refusal handling. For a local retrieval check, follow the [controlled SQLite build procedure](adr/ADR-002-sqlite-catalog.md#focused-evidence-and-reproduction). The native build script requires explicit node-gyp, headers-root, and target-version arguments. It does not infer them. No scale or final-candidate qualification result is established here.
