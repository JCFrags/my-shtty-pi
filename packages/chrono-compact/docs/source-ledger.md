# ChronoCompact source ledger

## Status

This is a personal-project component. It is not release approval. The default-off isolated worker and exact history tools can use it. Pi JSONL remains authoritative.

## Purpose

The source ledger is retrospective derived data. It streams an existing Pi JSONL file and records exact byte locations for session entries. It can update from appended source bytes without reading and parsing the complete session again. The sidecar can be deleted and rebuilt.

## Product boundary

The ledger operates only on source that Pi already stored. It does not process a tool result before the main LLM receives it. It does not intercept, change, sanitize, reduce, summarize, or replace tool results. Pi JSONL remains the authoritative exact source.

## Data model

The default sidecar suffix is `.chrono-source-ledger-v1.jsonl`. The append-only sidecar contains typed `header`, `entry`, and `checkpoint` records. Entry records contain IDs, source order, exact byte ranges, and hashes. They do not contain source text, message text, tool output, tool arguments, or the source path.

Only records through the last valid checkpoint are committed. Each checkpoint stores a 1,024-byte maximum tail anchor. The runtime object keeps an entry-ID map and source-order array. Average entry lookup is constant time.

The parser retains references to unread chunk parts. It joins those parts once when a complete line is ready. It does not copy the growing pending line after each 64 KiB read. This supports very large JSONL entries without a line-size limit.

## Update transitions

- `new` streams the source and atomically creates a sidecar.
- `exact-hit` verifies a bounded tail anchor and does not rewrite the sidecar.
- `append` reads a bounded anchor and bytes after the committed source position.
- `rebuild-truncation` rebuilds after the source becomes shorter.
- `rebuild-replacement` rebuilds after source file identity changes.
- `rebuild-tail-rewrite` rebuilds when the indexed tail anchor changes.
- `recover-incomplete-ledger-tail` removes records after the last valid checkpoint and continues.

A final incomplete JSON line remains unindexed until a later update completes it. Invalid JSON in a complete line fails closed.

## Exact branch reconstruction

The branch API starts at one required leaf and walks ledger parent metadata to one root. It returns root-to-leaf source order. Missing leaves, missing or invalid parents, cycles, duplicate IDs, and parents that occur after children fail closed. The cut API requires the exact first-kept entry on that branch. It never selects another leaf or cut.

Selected entries use coalesced source ranges. The defaults permit a 64 KiB gap, a 4 MiB normal range, and 2,048 entries per range. One oversized entry remains one range and is never split. Each selected slice must match its source hash, UTF-8 JSON value, entry ID, parent ID, and type. Metrics report exact selected bytes, total bytes read, gaps, unrelated bytes inside gaps, range counts, maximum sizes, and `1 - bytes read / source file bytes` as the clamped source-byte avoidance rate.

## Exact retrieval

Exact retrieval is separate from tail-anchor verification. `history_get` reads only its selected entry body. Neighbor information comes from ledger line and type metadata. `history_range` selects a parent-chain or file-order range from metadata before it reads selected small bodies. It can omit an oversized body from the range without reading it.

The extension uses one current-session in-memory ledger or loads an existing valid sidecar read-only. It does not create a ledger only because an exact history tool ran. Missing, busy, stale, corrupt, incomplete, or unsuitable ledgers use the existing parsed-session implementation. Session switch, fork, and shutdown clear the reference. `history_search` and `history_recall` are unchanged.

## Integrity

Every source entry has a source-content hash. Every sidecar record links to the previous record hash. New builds and rebuilds use an owner-only temporary file and atomic rename. Normal updates append entry records and a checkpoint, then flush the file. A broken committed chain is not accepted.

The append and exact-hit check reads and verifies at most 1,024 bytes immediately before the committed source position. This does not prove that every old source byte remains unchanged. An old-prefix change that does not affect the anchor is found when exact retrieval verifies that entry.

## Writer boundary

This version permits one writer per session. A small exclusive sidecar lock prevents simultaneous writes. A second writer receives a clear busy error. This version does not recover stale locks automatically.

## Performance model

A new build reads the available source once. A normal append reads new bytes plus the 1,024-byte maximum anchor. An exact hit reads only that anchor. Its cost does not depend on the prior final entry size. Exact retrieval reads the complete selected record and can therefore be much larger than an anchor read. Cold startup still replays the complete sidecar to rebuild runtime maps.

## Current limits

The default-off candidate segment store and isolated replay worker use the ledger. The worker still parses every entry on the selected active branch, then rebuilds resource state, causal state, candidates, planning, and validation. It does not parse unrelated branches after a valid ledger is available. The suffix and schema version remain V1. A checkpoint without valid fixed-anchor fields is rejected. A later update safely rebuilds the derived sidecar instead of migrating it. It does not replace the current parser or retrieval tools. File identity and a bounded tail anchor detect common replacement and rewrite cases, but they are not a full old-prefix verification. The one-writer lock has no process-identity recovery. A cold load remains proportional to sidecar size.
