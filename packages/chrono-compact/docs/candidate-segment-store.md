# Candidate segment store

The candidate segment store is a default-off derived-data cache for deterministic ChronoCompact candidates. It uses the incremental [source ledger](source-ledger.md) for exact byte positions. Pi JSONL remains authoritative.

## Boundary

The store changes background candidate preprocessing only. It does not intercept or change a tool result before the main model receives it. It does not replace normal full-branch parsing, resource lineage, causal analysis, final planning, final validation, or current-state rendering.

Set `incrementalPrecomputeEnabled` or `PI_CHRONO_INCREMENTAL_PRECOMPUTE=true` to enable it. When the setting is false, the extension does not create a source ledger or candidate store and does not schedule preprocessing.

The default store directory is `<session.jsonl>.chrono-candidate-segments-v1`. Old `.chrono-incremental-v2.json` files are ignored and retained.

## Dependency split

Persistent records have one of two dependency classes:

- `source-local`: the candidate depends only on one historical block and deterministic configuration.
- `pairing-dependent`: the candidate also depends on a verified tool call and result pair. The store carries at most 256 open call references across segment boundaries.

Candidates that can depend on later history are future-sensitive. File-read and search-result reductions are computed from current history at compaction time. Semantic assistant candidates also remain live and are never persisted. Raw, normalized, semantic, LLM-produced, and protected exact candidates are never stored.

Final use checks the block key, dependency class, candidate shape, token count, source references, reducer identity and version, and record integrity. Cached and live future-sensitive candidates then enter the unchanged final validator and planner. A missing or rejected record uses the normal cold computation for that block.

## Files and publication

`manifest.json` contains source identity and coverage, source-ledger integrity, configuration and reducer hashes, bounded segment descriptors, open pair references, generation, transition, timestamps, and an integrity hash. It does not contain the source path or source text.

Segment files are immutable and content-hashed. The default targets are 4 MiB of source bytes, 2,048 source entries, and 4,096 persistent records. A single large source entry remains unsplit and can exceed a target. An append creates new segments and does not rewrite old segments.

The directory is mode `0700`. The manifest, lock, and segment files are mode `0600`. One small exclusive writer lock serializes updates. A writer builds new immutable files before it atomically publishes the new manifest. Readers do not take the writer lock. They use the last complete manifest and do not wait for preprocessing. Old snapshot segments remain available while a rebuild is active. Orphan cleanup is an explicit maintenance operation.

A cold manifest load does not read segment files. Branch lookup loads only descriptors whose source-entry range can contain requested IDs. A byte-bounded least-recently-used cache limits loaded segment data.

## Updates and fallback

The source ledger passes newly parsed entry text through a request-local callback. This avoids reading the appended source range a second time. The callback text is not written to the ledger.

The store reports new, exact-hit, append, source replacement, truncation, tail rewrite, configuration change, reducer change, corruption, orphan recovery, and stale-ready conditions. A missing, stale, busy, unfinished, or corrupt store cannot block compaction. Compaction reads the last ready snapshot when possible and otherwise computes candidates cold.

Both the source ledger and candidate store are deletable. Removing either sidecar causes a safe rebuild from Pi JSONL.
