# ChronoCompact rollup shadow evaluation

## Status

This is a personal-project evaluation feature. It is not release approval. The feature is off by default. Live rollup context is not approved by this work.

## Purpose

The shadow path compares safe quality and work metrics for the V2 hierarchical rollup with the current authoritative ChronoCompact replay. The measurements guide a later live-integration decision. Text equality is not a goal.

## Product boundary

Pi JSONL remains authoritative. The current replay remains authoritative for model context. Shadow output never reaches the model. It never replaces the compaction response, current validation, regular Pi summary, ChronoCompact replay, or retained raw tail. The 25,000-token replay limit and 30,000-token combined limit are unchanged.

The path runs only after compaction result creation. It does not intercept, change, sanitize, reduce, or summarize a tool result before the main model receives it.

## Scheduling

Enable `rollupShadowEnabled` in the settings screen or set `PI_CHRONO_ROLLUP_SHADOW=true`. The extension coalesces pending work for one session and cancels it on session switch, fork, shutdown, or replacement. It schedules a low-priority job through the existing host-wide worker slots and returns the current compaction response without waiting.

Replay work has scheduler priority over shadow work. Shadow does not wait for candidate updates. A busy rollup writer can use the last complete matching manifest.

## Worker job

The one-job local child loads the exact persisted source. It verifies the compacted prefix and uses the source entry immediately before `firstKeptEntryId` as the branch leaf. It updates V2, renders within the same historical hard bound, validates the final plan, calculates safe comparison metrics and complete local hashes, appends a safe sidecar record, and exits.

The response contains metrics and hashes only. It contains no replay text, rollup text, source text, source path, entry ID, source reference, tool argument, command, URL, or model output. The child has no model client and no network client. Model calls and network calls are zero.

## Metrics

Metrics include token counts, final restriction cue coverage, blocker coverage, unresolved-failure coverage, current-resource coverage, invalid references and ranges, cut lines, false completions, unsupported facts, missing recovery routes, update and render time, source and node bytes, query nodes, and worker timer delay.

`/chrono-rollup-shadow-status` displays aggregate values only. It displays no path, identifier, source reference, hash, source text, replay text, or rollup text.

## Sidecar

The sidecar is `<session.jsonl>.chrono-rollup-shadow-v2.jsonl`. It is owner-only and append-logical. Atomic compaction keeps at most the newest 1,000 records and at most 4 MiB.

A successful record contains only schema and generation numbers, safe aggregate metrics, safe validation issue counts, safe status, and complete SHA-256 hashes of the two local outputs. A failed record contains only a timestamp, generation, strict failure stage, strict safe code, and optional numeric context. Hashes support local change detection and are not shown in the UI. The reader rejects unknown or malformed record fields before a rewrite.

## Privacy

Private replay and rollup text are never stored. Public benchmarks use synthetic source only. Private evaluation uses owner-only temporary snapshots outside Git. It never writes a rollup store or shadow sidecar beside a real private session. Private reports contain anonymous aggregate values only and use mode `0600`.

## Failure behavior

Feature-off mode creates no V2 rollup store or shadow sidecar. Empty historical prefixes are not scheduled. Invalid cuts, source changes, corruption, worker timeout, crash, cancellation, or unavailable matching snapshots fail only the shadow job. Each failed shadow response uses one strict safe stage and one strict safe code. It contains no raw error, stack, path, source identifier, source reference, or output text.

The worker sends safe stage progress to its parent. A child crash can therefore retain its last known operation without exposing private content. Private diagnostic mode is explicit and writes owner-only safe records outside Git. It never runs during normal Pi use.

A measured memory gate uses current resident memory and the largest indexed source entry. It runs before the heavy rollup update. A memory-gate result is a safety result, not a core rollup failure. A sidecar write failure returns a safe warning and does not replace a successful evaluation. None of these results change or delay the current compaction result.

## Preservation benchmark boundary

The public compare and generation benchmarks clone the complete authoritative extension response before post-result shadow scheduling. They compare that frozen response with the returned response after shadow completion. A malicious fake shadow mutates its supplied clone and returns a replacement object. The integration helper ignores both. This measures the extension compaction response before and after post-result scheduling and proves that the shadow result does not enter that returned response. It does not prove unrelated integration properties.

## Current limits

This path measures a deterministic prototype. It does not provide live rollup context, fallback context, persistent ranked search, a daemon, remote work, or model-generated rollup records. The current replay and current retrieval tools remain unchanged. A later decision needs measured quality evidence and a separate review.
