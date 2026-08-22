# Hierarchical history rollup prototype

## Status and boundary

The history rollup store is an isolated prototype. It is not connected to the Pi extension, replay, retrieval tools, candidate selection, the compaction worker, or the memory store. Pi JSONL is authoritative. The source ledger and this store are deletable derived data.

The prototype runs only after Pi has persisted source. It never changes a tool result before the main model receives that result. It does not make network or model calls.

## Typed history value

`src/history-value.ts` extracts bounded typed records from historical blocks. A record contains:

- a category, source authority, lifecycle, and priority from A through E;
- evidence and confidence types;
- exact source references and a source range;
- a bounded cue, static value signals, and recovery and reproduction costs;
- optional resource, task, duplicate, conflict, or supersession relations.

Leaf extraction fixes static value. The renderer computes dynamic value from current retention hints, recent terms, open tasks, resource identities, retrieval feedback, and unresolved failures. Dynamic value never rewrites a node.

Protected current restrictions keep generic metadata and source references. They do not store exact protected instruction text. Tool call and successful tool result cues omit complete arguments and output.

Supersession needs a deterministic state, resource, task, failure, or correction relation. Recency alone is not enough. An unrelated pass cannot resolve a failure. A task episode closes only with successful linked validation, user acceptance, or an explicit recorded completion event. A final assistant message does not close it.

## Store layout

For `session.jsonl`, the owner-only store is `session.jsonl.chrono-history-rollups-v1/`:

- `manifest.json` points to the active branch manifest.
- `branches/<hash>.json` records exact branch order and tree nodes.
- `nodes/<hash>.json` contains an immutable leaf or rollup node.
- `tmp/` supports atomic publication.
- `writer.lock` contains a process ID, process start identity, and random nonce while one writer runs.

Directories use mode `0700`. Files use mode `0600`. Node IDs are hashes of canonical node content. Each node and manifest also has an integrity hash. Publication writes and syncs a temporary file, then renames it.

Default leaf targets are 4 MiB, 2,048 source entries, or 4,096 blocks. One JSONL entry is never split. Rollup fan-out is eight. A node keeps at most 1,024 structured records, 8,000 cue tokens, and 1 MiB. The lazy runtime cache defaults to 16 MiB.

A same-branch append reads only new source. It combines a stored typed open leaf with new typed records, then publishes a replacement open leaf. It never reads the old leaf source again. Full leaves seal and never change. Parent nodes change only on the path to the root.

A branch switch verifies leaf source digests against the exact source-ledger branch. It reuses only sealed common-prefix nodes. It rebuilds the divergent suffix. Abandoned-branch records are not part of the active manifest.

## Prototype rendering

`src/history-rollup-renderer.ts` renders four sections:

1. `# CURRENT WORK`
2. `# RECENT EVENTS`
3. `# SELECTED OLDER EVIDENCE`
4. `# ARCHIVE MAP`

The default target is 20,000 tokens. The hard maximum is 25,000 tokens. The renderer adds only complete lines. Every lossy line states that detail was omitted and includes an exact `history_get` or `history_range` recovery route.

The renderer reads the root, at most two recent leaves, and exact current restrictions from the authoritative source through the source ledger. If an exact restriction does not fit, it emits one complete recovery cue instead. It does not load every old leaf.

The prototype validator checks source references, missing recovery routes, unsupported records, false completion changes, and the hard token limit without reading all old source.

## Failure and recovery

A missing or corrupt manifest leaves Pi JSONL unchanged. A corrupt node fails closed. Delete the derived rollup directory to rebuild it.

A live verified writer lock causes a busy error. A stale lock can be replaced only after process identity verification. Cancellation before manifest publication leaves the prior manifest active. Unreferenced immutable nodes are safe derived data and can be removed by a later cleanup pass.

## Public benchmark

Build first, then use strict modes:

```sh
npm run benchmark:history-rollups -- series --final-tasks 1000 --batches 20
npm run benchmark:history-rollups -- render --tasks 1000 --target-tokens 20000
npm run benchmark:history-rollups -- scale --source-tokens 50000000 --batches 50 --target-tokens 20000
npm run benchmark:history-rollups -- branch --common-tasks 5000 --left-tasks 5000 --right-tasks 5000
npm run benchmark:history-rollups -- compare --tasks 5000
```

The benchmark uses synthetic source, owner-only temporary files, bounded numeric arguments, and no network. It reports source and block amplification, node work, update and render time, bytes read, memory, timer delay, branch reuse, integrity, recovery, and coverage measures.
