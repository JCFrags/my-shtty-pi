---
title: Indexing and exact history recovery
audience: [agents, maintainers]
status: current reference
purpose: Explain historical readiness, discovery, staged recall, exact coordinates, and safe continuation.
related:
  - chronology-episodes-resources.md
  - logical-sessions.md
  - ../context/recall.md
---

# Indexing and exact history recovery

## Source and derived layers

Pi JSONL is the original conversation source. Chrono preserves existing records and closed shards. New records append through the owning lifecycle. A derived index is not a substitute for the original files.

The catalog incrementally records order, ancestry, raw offsets, descriptors, hashes, and parser progress. It stores locations and metadata, not a searchable copy of every body. It publishes complete LF-terminated records. An incomplete last record stays pending. Malformed source or changed identity refuses instead of silently skipping records.

Capsules supply compact event alternatives and a separate store of exact decoded chunks. Search builds disk-backed lexical indexes over capsule cues and decoded text. Episodes, historical state, and rollups add bounded routes for broader recall. Each layer owns its own checkpoint. A query does not rebuild those layers.

Catalog first/tail checks detect selected changes during append work. They do not certify every archived byte. Explicit integrity work and exact span verification have different coverage.

## Choose the right interface

| Tool | Use | Important limit |
| --- | --- | --- |
| `history_status` | Read loaded identity, requested/indexed cuts, lag, safe errors, and composition status. | Cached observation only. No ingestion or archive reads. |
| `history_search` | Find likely events with ranked, exact literal, or supported regex matching. | Lexical candidate windows, not global semantic ranking. |
| `history_recall` | Expand a cue, episode, resource, historical state, rollup, or exact block. | Derived results remain partial and source-linked. |
| `history_get` | Read one exact raw entry or decoded block. | Branch, identity, and bounded coordinate validation still apply. |
| `history_range` | Read exact chronological records between named entries. | One physical shard per range. |

`context_recall` is different: it reads current native state cards. `memory_search` is also different: it searches explicitly accepted knowledge. Neither replaces historical exact recovery.

## A bounded recovery sequence

1. If readiness is unclear, call `history_status` once and inspect the relevant layer.
2. Search a specific cue, identifier, or phrase. For example, `history_search({"query":"checksum decision","tokenBudget":1000})`.
3. Continue a returned `nextCursor` unchanged when more candidate windows or logical routes matter. An empty filtered page can still have a continuation.
4. Expand a returned handle with `history_recall`. Select `episode`, `resource`, `state`, or `rollup` when that view fits the question.
5. Follow the returned recovery reference through `history_get` before relying on exact wording, permission, or a decisive correction.
6. Continue only from returned offsets or cursors. Preserve the same route and selectors.

Do not edit opaque handles to bypass a refusal. Search again against a compatible current view instead.

## Search semantics and bounds

Indexed search uses SQLite FTS5. It has no embeddings, general semantic graph, or autonomous model-driven recall loop.

A ranked window visits up to 64 cue postings and 64 raw-text postings, plus lookahead. Literal mode visits up to 128 raw-text postings plus lookahead. Filtering occurs after bounded posting selection. Results are ranked inside the admitted window and presented in chronological order, not ranked against the full archive.

The adapter currently returns at most one hit from one physical route per page. Logical routing checks at most eight routes per call. The same source can recur through another cue or chunk. Inspect coverage, omissions, and continuation instead of treating the requested `limit` as a promised result count.

Regex requires explicit bounded scan. A request scans at most 64 chunks and 250 ms of worker work. Unsupported expressions refuse. Indexed `unresolved` filtering and `currentState` other than `any` are not supported by this path even though the common tool schema retains compatibility fields. Use state recall instead.

A small result budget preserves recovery and continuation before optional diagnostics. If even those references do not fit, the operation refuses without advancing the cursor.

## Exact coordinates

| Output | Coordinate and continuation |
| --- | --- |
| Raw JSONL entry | Original bytes, returned as base64. First call uses `entryId` and an explicit `shardId` when needed. Omit `startByte` initially. Continue with `startByte` equal to the returned absolute `nextByte`. |
| Decoded text block | UTF-16 code units after JSON decoding, not raw bytes or Unicode character counts. Continue with `startChar` equal to returned `nextChar`. Indexed pages are capped at 8,192 units. |
| Exact range | Entry IDs and a pinned `nextCursor`. Indexed pages are capped at 16 events and 8,192 source bytes. |

A recovery handle already selects a decoded block. Do not combine it with byte offsets or raw-neighbor options. Preserve the complete route returned by the tool.

Raw `history_get` can read a cataloged entry before its final derived search branch is ready. This does not make decoded blocks, ranked search, ranges, state, or rollups ready. An uncataloged new entry can still be unavailable. After rollover, a predecessor entry needs its explicit `shardId`.

## Readiness is not a single flag

Status separates startup, catalog, capsules, index, state, rollup, and requested-cut progress. `awaiting-cut-validation` means the checkpoint layers report ready. It is not a compaction or semantic-completeness certificate.

Status is one observation. A later turn or tree move can select a newer leaf before recovery runs. For a focused status-to-recovery check, keep the bounded check and its read in the same agent run where practical. Do not turn stale readiness into an unbounded polling loop.

Source replacement, truncation, branch mismatch, missing routes, or corrupt spans require investigation. Ordinary append lag instead uses preserved checkpoints and, where validated, a compatible earlier prefix. Raw recovery does not initialize a missing search head.

[History index](README.md) · [Troubleshooting](../operations/troubleshooting-and-rollback.md) · [Catalog protocol](../../chrono-v3/catalog-contract.md)
