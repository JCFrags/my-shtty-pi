# Chrono Memory Engine current architecture

## Evidence boundary

This document describes source revision `30668f7586781410e9958fc56d8f677d08bc7d4e`. It is operational documentation, not M11 qualification or V3 acceptance. That source retains package metadata `2.0.25`, but its continuation-only shard persistence correction was not included in the immutable `2.0.25` distribution at `aa160c082dd9f027b0e378c53c2784e00ef1727e`. A distinct `2.0.26` package followed at `fac5d3566339b8ac51379c1703bcb1347e768d8b`; exact `2.0.26` CI and the installed-Pi retry remain pending.

`memoryEngineEnabled` remains `false` by default. The source contains the indexed memory path, logical-session commands, and the unbundled continuation-only shard persistence correction, but the corrected ten-shard installed-Pi retry has not run. The original `state-v4` catch-up campaign and the exact `2.0.25` M11 core campaign are separate work. No default activation, scale pass, all-session adoption, N-of-N live-session result, or exercised deployment rollback is established here.

## Source and derived data

Pi session JSONL is the exact source. ChronoCompact does not rewrite or delete an old source shard. Catalogs, capsules, search indexes, state, rollups, and composition artifacts are derived data. Derived-store reconstruction does not edit source. Rollout records and logical manifests are routing data and require their validated recovery paths rather than an assumed rebuild.

For an ordinary physical session, the extension derives a session key from the Pi session ID and a shard key from the source path. The catalog lives beside the source under an owner-scoped `.chrono-catalog` directory. The catalog pins a branch view to a generation and event cut. All later handles include that scope.

The active indexed pipeline is:

```text
complete source records
  -> catalog append ingestion and pinned view
  -> deterministic capsule and decoded-chunk pages
  -> disk-backed search publication
  -> state-v4 materialization
  -> rollup-v3 materialization from closed state-v4 episodes
```

Each store owns its checkpoint. Migration does not add another lifetime cursor.

## Startup and adoption

On `session_start`, the extension performs these operations:

1. It loads the JSON configuration and resolves environment overrides.
2. It reads the exact session/source rollout record, if one exists.
3. It validates a recorded logical adoption or continuation binding, if one exists.
4. If `memoryEngineEnabled` is on, no valid logical binding exists, and no exclusion applies, it adopts the current persisted Pi source as shard zero on branch `main`.
5. It starts or verifies the authorized bounded worker runtime.
6. When startup is ready, it schedules catalog, capsule, and search catch-up. State and rollup work follow in bounded turns.

Adoption is idempotent. A retry must resolve to the same owner, branch, Pi session ID, and source path. A copied, malformed, or conflicting binding refuses. Adoption writes one non-model `chrono-logical-adoption` custom entry after manifest and live identity validation.

These conditions prevent automatic adoption or indexed activation:

- `PI_CHRONO_MEMORY_ENGINE` or the JSON setting leaves the memory engine off;
- an explicit `PI_CHRONO_SEARCH_INDEX=false` or JSON `searchIndexEnabled: false` disables search, even when the memory engine is on;
- an exact per-session rollout record contains `enabled: false`;
- the rollout directory or record fails owner, mode, no-follow, identity, or size checks;
- the logical manifest or binding does not match the current Pi session and source;
- the worker startup transition is unavailable.

A logical continuation cannot override an exact persisted exclusion. An unsafe rollout read sets the session search override off and reports `search-v3-rollout-unsafe`.

## Indexed search and exact recovery

Search reads the last validated, ready index generation. It does not ingest or create an index in the query call. Ranked, literal, and supported regular-expression queries return bounded cues and opaque, cut-bound handles. An explicit scan is limited to 64 chunks and 250 ms per worker request. The adapter currently returns at most one hit from one physical route per page. Logical search checks at most eight routes per call and returns a continuation cursor when more routes remain.

`history_recall` expands a cue, state item, episode, rollup node, or exact block. Derived output identifies itself as partial and source-linked. `history_get` resolves a recovery handle or entry coordinate to exact source. Decoded reads are capped at 8,192 UTF-16 units per page. Raw event recovery uses bounded byte pages and returns `nextByte` when a whole record is too large. `history_range` stays within one named shard and returns at most 16 events and 8,192 source bytes per indexed page.

Handles bind the catalog store, catalog generation, session, branch, event cut, index generation, and source coordinates. A handle outside the currently compatible pinned view refuses.

## State-v4 derivation

`state-v4.sqlite` is inside the search generation directory. It is created only by `materializeState`. Status, recall, composition selection, and rollup input are read-only operations and refuse if the store is absent, incompatible, corrupt, unsafe, or beyond its pinned view.

The scheduler materializes state after a validated search prefix exists. It records episode membership and source-backed state such as restrictions, goals, open work, blockers, decisions, approvals, failures, resource observations, memory metadata, and retention hints. State authority and confidence remain explicit. Ordinary writer metadata does not become a user instruction.

The state head separately tracks body progress and metadata progress. `knownThroughCut` is the bounded cut supported by the materialized state. A ready state store does not prove that a later requested cut has complete mandatory coverage.

## Rollup-v3 derivation

`rollup-v3.sqlite` is inside the same search generation directory. It is created only by `materializeRollup`. The rollup reads bounded pages exported from `state-v4.sqlite`; it does not derive directly from lifetime source history.

Only closed episode intervals enter rollups. Closure means that the next episode boundary exists. It does not mean that a task completed. Open history remains excluded. Protected restrictions, blockers, and open work retain source references and explicit omission counts. Memory and retention hints in immutable rollup leaves are historical, advisory metadata.

Rollup status reports the state generation, rollup generation, processed cut, processed metadata cut, represented closed range, open-tail exclusion, and remaining work. A rollup can be ready for its closed prefix while the current state or requested source cut is later.

## Readiness and cut eligibility

`history_status` and `/chrono-search-status` return cached lifecycle state. They do not read the archive or advance ingestion. Migration phases are `disabled`, `unavailable`, `startup`, `catalog`, `capsules`, `index`, `memory`, `rollup`, and `awaiting-cut-validation`.

`awaiting-cut-validation` means all derived layers report ready at their checkpoints. It does not authorize composition. Every compaction cut must still pass:

- exact pin compatibility at Pi's prepared boundary;
- safe tool-call and tool-result pairing;
- complete restriction and open-work coverage;
- no omitted protected or open-work proposition;
- an independently produced regular Pi summary;
- a safe retained tail;
- the 30,000-token combined ceiling;
- unchanged session, branch leaf, and cancellation identity.

If a V3 gate fails, ChronoCompact cancels that compaction and preserves the current context. It does not fall back to the legacy lifetime reconstruction while the memory engine or canary path is selected.

## Logical sessions

A logical manifest is owner-only and versioned. Each shard records an immutable source route and catalog cut. The active branch searches its own shards and ancestors. Sibling branches are excluded unless separately selected by a supported route.

Rollover and logical fork are manual. They require an idle persisted session, no unmatched tool pair, no active compaction or switch, an exact caught-up cut, the regular Pi summary, complete mandatory continuation coverage, and the combined ceiling. Logical fork creates an empty Pi child and does not use Pi's physical `/fork` behavior.

At this revision, the command adapter persists the exact continuation-only replacement source that Pi `0.85.1` otherwise defers. It validates the generated path, version-3 header, identifiers, parent source, bootstrap chain, continuation identity, ownership, mode, link count, and bytes. Publication uses an owner-only exclusive temporary file, a no-overwrite hard link, file and directory synchronization, and reload through the public SessionManager API. It never opens the old shard for writing.

Automatic rollover is not implemented. Actual corrected ten-shard rollover, fork, restart, and recovery qualification remains pending.
