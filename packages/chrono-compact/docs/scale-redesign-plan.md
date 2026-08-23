# ChronoCompact scale redesign plan

## Status

This is a working plan for a personal project. It is not release approval. The package remains quarantined during this work.

## Purpose

ChronoCompact is retrospective only. It does not change, sanitize, reduce, summarize, or replace a tool result before the main LLM receives it.

The sequence is:

1. The tool returns the full result.
2. The main LLM receives the full result.
3. Pi stores the full result in the JSONL session.
4. ChronoCompact can later create a smaller active-context representation.
5. The exact JSONL source remains available.

The goal is better long-session working memory than a normal single summary.

## Product invariants

- New information reaches the main LLM before later loss is allowed.
- Pi JSONL remains the exact source of truth.
- ChronoCompact does not rewrite source JSONL.
- Lossy representations identify the loss.
- Exact recovery remains available.
- Current goals, current restrictions, open work, blockers, failures, decisions, and next actions receive priority.
- Deterministic code controls final text, source links, token limits, and validation.
- An optional LLM can give value advice only.
- Optional LLM failure must not block compaction.
- Normal processing must depend mainly on new data, not all old data.

## Prototype milestone

The hardened V2 hierarchical history rollup is complete. It adds explicit lifecycle relations, linked resolution, cross-leaf exact call context, full SHA-256 identities, bounded changed-path append, safe lock ownership, top-down dynamic query, typed final planning, final-line quality metrics, and final-plan validation. The default-off shadow path is evaluation only. It remains outside authoritative replay and model context. Live integration is a separate later decision. See [history-rollup-store.md](history-rollup-store.md) and [scale-baseline.md](scale-baseline.md).

## Rollup shadow gate

The V2 rollup store is hardened. Shadow evaluation is default-off. Current replay output remains unchanged and authoritative. Shadow metrics guide a later live-integration decision. This work does not approve live rollup use.

The evaluator runs after current compaction result creation in a low-priority local worker. Its output never reaches the model. It stores safe metrics and complete local hashes only. See [rollup-shadow.md](rollup-shadow.md).

## Scale targets

- The first or second compaction can include 250,000 to 500,000 source tokens.
- A session can contain 25 million to 50 million source tokens or more.
- A session can contain 30 to 50 compaction generations or more.
- More than one Pi agent can run on the same host.
- The active model context remains bounded.
- The agent still receives useful current state and exact recovery paths.

## Non-goals

- No pre-LLM tool-result compression.
- No destructive session rewrite.
- No promise to keep all old text in active context.
- No requirement for production certification or production service-level rules.
- No use of a prior rendered replay as authoritative source evidence.
- No normal full-session rebuild after the incremental data is available.

## Current baseline

The current V2 design has useful typed reducers, source references, exact retrieval tools, resource tracking, and validation.

The normal compaction path still rebuilds full-branch parsing, resource lineage, causal analysis, planning, and final validation from the selected historical prefix. This preserves authoritative current-history behavior.

## Implemented scale components

The [source ledger](source-ledger.md) indexes exact source byte locations and supports incremental append updates. The default-off [candidate segment store](candidate-segment-store.md) uses it to persist only source-local and verified pairing-dependent candidates in immutable segments. Warm append preprocessing reads only appended source plus bounded pairing context. Future-sensitive work remains current at compaction time.

## Ledger-backed branch reads

The isolated worker resolves one exact selected branch from source-ledger parent metadata and reads verified source ranges for that branch. It does not parse abandoned branches after a valid ledger is available. Exact `history_get` and `history_range` calls can use one already-existing valid ledger and otherwise keep the current parser fallback. Search and recall do not use this path. Cold ledger loading remains linear in ledger size. Full active-branch analysis and final replay planning remain non-incremental.

## Private real-session measurement

The [explicit session-set benchmark](local-session-benchmark.md) can measure local real sessions from a supplied manifest. The script does not discover files. Private benchmark results stay outside the repository. These measurements guide later scale work.

## Long-session outcome metrics

Benchmark outcomes now use safe code categories. `no-net-savings` is separate from a validation defect. All-history protected visibility is separate from heuristic state-model restriction coverage. Current-state rendering keeps complete source-linked lines within its bounded share of the unchanged hard output limit. Private numeric results remain outside the repository.

## Local CPU isolation correction

The default-off isolated worker moves deterministic replay compaction, replay generation hashing, candidate snapshot loading, deterministic summary rebase, and enabled candidate updates to one-job local child processes. A host-wide owner-only scheduler permits 1 through 4 jobs and defaults to one. Waiting replay has priority over waiting candidate updates. This change limits simultaneous host pressure and main-process event-loop delay. It does not reduce total deterministic work. Pi JSONL remains authoritative, and provider-backed summary work remains in Pi. See [compaction-worker.md](compaction-worker.md).
