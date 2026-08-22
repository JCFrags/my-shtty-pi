# ChronoCompact source ledger

## Status

This is a personal-project component. It is not release approval. It is not yet connected to normal ChronoCompact compaction.

## Purpose

The source ledger is retrospective derived data. It streams an existing Pi JSONL file and records exact byte locations for session entries. It can update from appended source bytes without reading and parsing the complete session again. The sidecar can be deleted and rebuilt.

## Product boundary

The ledger operates only on source that Pi already stored. It does not process a tool result before the main LLM receives it. It does not intercept, change, sanitize, reduce, summarize, or replace tool results. Pi JSONL remains the authoritative exact source.

## Data model

The default sidecar suffix is `.chrono-source-ledger-v1.jsonl`. The append-only sidecar contains typed `header`, `entry`, and `checkpoint` records. Entry records contain IDs, source order, exact byte ranges, and hashes. They do not contain source text, message text, tool output, tool arguments, or the source path.

Only records through the last valid checkpoint are committed. The runtime object keeps an entry-ID map and source-order array. Average entry lookup is constant time.

## Update transitions

- `new` streams the source and atomically creates a sidecar.
- `exact-hit` verifies a bounded tail anchor and does not rewrite the sidecar.
- `append` reads a bounded anchor and bytes after the committed source position.
- `rebuild-truncation` rebuilds after the source becomes shorter.
- `rebuild-replacement` rebuilds after source file identity changes.
- `rebuild-tail-rewrite` rebuilds when the indexed tail anchor changes.
- `recover-incomplete-ledger-tail` removes records after the last valid checkpoint and continues.

A final incomplete JSON line remains unindexed until a later update completes it. Invalid JSON in a complete line fails closed.

## Exact retrieval

Exact retrieval finds entry metadata in the runtime map and reads only its byte range. It verifies the content hash, JSON entry ID, and UTF-8 JSON before returning the exact JSON object text. Changed bytes produce a stale-ledger error and no text.

## Integrity

Every source entry has a source-content hash. Every sidecar record links to the previous record hash. New builds and rebuilds use an owner-only temporary file and atomic rename. Normal updates append entry records and a checkpoint, then flush the file. A broken committed chain is not accepted.

The append and exact-hit check verifies a bounded tail anchor. This does not prove that every old source byte remains unchanged. An old-prefix change that does not affect the anchor is found when exact retrieval verifies that entry.

## Writer boundary

This version permits one writer per session. A small exclusive sidecar lock prevents simultaneous writes. A second writer receives a clear busy error. This version does not recover stale locks automatically.

## Performance model

A new build reads the available source once. A normal append reads new bytes plus a bounded anchor. An exact hit reads only the anchor. Exact retrieval reads only one selected record. Cold startup still replays the complete sidecar to rebuild runtime maps.

## Current limits

The ledger is not connected to normal compaction. It does not replace the current parser or retrieval tools. File identity and a bounded tail anchor detect common replacement and rewrite cases, but they are not a full old-prefix verification. The one-writer lock has no process-identity recovery. A cold load remains proportional to sidecar size.
