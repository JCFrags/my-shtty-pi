# Local search

`local_search` is the sole model-facing local search tool. It contains the required exact text, exact file-path, and exploratory fuzzy behavior behind explicit strategies.

## Strategies

- `text` uses structured ripgrep JSON. It paginates match hits before it renders context.
- `files` uses a NUL-delimited fd inventory. A glob with `/` matches a full relative path. A glob without `/` matches any basename.
- `fuzzy` ranks likely file paths. It is non-exhaustive and keeps its Git-change boost visible.

Each response uses result schema version 1. It states the engine, normalized request, request fingerprint, scope, coverage, completion state, absence-evidence state, qualifications, warnings, structured hits, page metadata, and `fallbackAttempted: false`. Continuation cursors are exact four-field records tied to the query. Continuation reads the current filesystem snapshot.

Optional `sessionId` is supported only for exact `text` and `files` queries. It must name an existing local session or an SSH session with file-resource protocol v1. Relative scope uses the working directory captured in the session FIFO slot. Local queries use the normal local engines. SSH queries use the provider's bounded structured ripgrep results or fd inventory, then Grounded keeps filtering, pagination, cursor checks, and rendering. The session ID and captured directory are part of the cursor fingerprint, so a cursor cannot cross stateless and session routes, session IDs, or changed session directories. `strategy=fuzzy` with `sessionId` fails explicitly. No query opens a session, selects an active SSH route, or falls back locally.

A successful exact zero result is valid absence evidence under the reported qualifications. An exact failure is incomplete evidence. Neither condition invokes fuzzy search. Missing Git metadata disables only the fuzzy change boost and adds an explicit qualification.

The tool intentionally has no automatic routing, hybrid ranking, BM25 index, server, or optional metadata selector. Exact zero results and exact failures never trigger fuzzy search.

## Examples

```text
local_search { action: "query", strategy: "text", query: "validateSession", path: "src" }
local_search { action: "query", strategy: "files", pathGlob: "src/*.ts", path: "." }
local_search { action: "query", strategy: "fuzzy", query: "session auth", path: "." }
local_search { action: "query", strategy: "text", query: "needle", path: ".", sessionId: "s_..." }
```

## Verification

Run:

```bash
npm run typecheck
node --import tsx --test tests/search.test.ts tests/files-extension.test.ts
npm run pack:check
```

Also run the complete package test before release. The strict package payload must include this document.

## Rollback

Restore the final consolidation baseline from `~/.pi/agent/activation-backups/2026-08-26-local-search-consolidation/` only after confirming that no later wanted changes use these files. The earlier Phase 1 candidate remains available as a separate rollback point.
