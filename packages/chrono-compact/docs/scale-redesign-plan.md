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

The current normal compaction path rebuilds important derived data from the full selected historical prefix. The optional incremental checkpoint still walks and hashes the complete branch. These full-history operations do not meet the scale targets.
