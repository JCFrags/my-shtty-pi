# ChronoCompact V3 / Chrono Memory Engine
## Master Goal, Architecture Charter, and Ultra-Detailed Work Plan

**Document status:** Authoritative working charter  
**Date established:** September 2, 2026  
**Repository:** `JCFrags/my-shtty-pi`  
**Primary package:** `packages/pi-chrono-compaction`  
**Current deployed product name:** ChronoCompact  
**Target architecture name:** Chrono Memory Engine, delivered through ChronoCompact  
**Intended release line:** safety fixes in `2.x`; authoritative memory-engine transition in `3.0.0`  
**Audience:** the directing assistant, the local Pi coding agent, reviewers, and the repository owner  
**Publication status:** private working material; this document does not authorize public release or package publication

---

# 1. Purpose of this document

This document is the governing plan for rebuilding ChronoCompact into a durable, source-linked temporal-memory system for long-running Pi agents.

It exists to prevent the project from becoming a sequence of local patches without a coherent destination. Every implementation instruction, commit, test, deployment, and architectural decision must be evaluated against this charter.

The project will be directed through a repeated control loop:

1. The directing assistant defines a bounded milestone and issues one self-contained instruction block to the local Pi agent.
2. The Pi agent inspects the real workstation state, implements the milestone, tests it, commits it, pushes it to GitHub, and reports exact evidence.
3. The directing assistant reviews the pushed source, tests, documentation, generated artifacts, and deployment record through GitHub.
4. The next instruction is based on the reviewed repository state and the evidence returned by the Pi agent.
5. Safe, independently useful milestones are deployed into the live Pi extension installation as soon as they satisfy their deployment gates.
6. No milestone is called complete merely because code exists. It is complete only when its acceptance criteria, migration behavior, rollback path, and live verification are established.

This document is intentionally more detailed than an ordinary project plan. ChronoCompact sits on a critical path: it modifies the context given to an autonomous coding agent, processes private session history, and must remain stable under extremely large histories and multiple simultaneous agents. Ambiguity in this project becomes data loss, context loss, process failure, or misleading agent memory.

---

# 2. Master goal

Build ChronoCompact as a **local, incremental, bounded-memory temporal-memory engine** that:

- preserves every Pi event exactly in the immutable session archive;
- gives the active agent a compact, source-linked, chronologically useful working memory after compaction;
- maintains explicit current state, unresolved work, decisions, failures, restrictions, and resource evolution;
- supports exact or partial recall of every archived event;
- supports fuzzy search and staged recall across extremely large logical sessions;
- remains safe when several Pi agents use separate long-running sessions concurrently;
- performs normal ingestion, search, recall, and compaction without work proportional to total lifetime history;
- fails locally and predictably without crashing the main Pi process or corrupting source history;
- can be upgraded, rolled back, rebuilt, and diagnosed without destructive edits to session JSONL;
- retains the regular Pi summary rather than replacing it;
- deploys progressively, with each useful layer activated only after measurable safety gates pass.

The target scale is not merely “larger than today.” The design must remain structurally sound for:

- individual logical sessions containing hundreds of millions of estimated tokens;
- logical sessions composed of many bounded physical Pi session shards;
- multiple logical sessions active on the same workstation;
- multiple background ingestion, search, recall, and compaction requests;
- years of append-only use, repeated compactions, forks, restarts, crashes, and upgrades.

The central design law is:

> No normal operation may have CPU cost, memory cost, or latency proportional to the complete lifetime history of a logical session.

Full rebuilds are allowed only as explicit repair or migration operations. They must stream from source, have fixed memory bounds, expose progress, be resumable or restartable, and never run implicitly in an interactive search or compaction path.

---

# 3. Responsibility model

## 3.1 Directing assistant responsibilities

The directing assistant is the architectural and acceptance authority for this project. It must:

- preserve the long-term architectural direction in this document;
- decompose work into safe, reviewable milestones;
- issue precise instructions to the Pi agent;
- require evidence rather than accepting unsupported claims;
- inspect every pushed milestone through GitHub;
- identify regressions, missing tests, accidental scope growth, and privacy risks;
- maintain the milestone ledger and decision log;
- separate emergency containment from permanent architecture;
- approve progression from shadow mode to live use only after acceptance gates pass;
- ensure live deployment always points to a known Git commit;
- prevent private session data, credentials, local secrets, and raw diagnostics from entering Git;
- keep the repository and live deployment synchronized and auditable;
- avoid unnecessary rewrites when existing code is correct and reusable;
- require rollback capability before enabling any context-affecting behavior;
- treat exact history as authoritative and all derived memory as replaceable.

The directing assistant must not infer that a local deployment succeeded merely because a build passed. It must require a live smoke result and the deployed commit/hash evidence.

## 3.2 Pi agent responsibilities

The Pi agent is the local execution authority. It must:

- inspect the actual repository, runtime, configuration, active extension paths, and current process state;
- preserve unrelated local changes;
- create a dedicated branch or worktree for each milestone unless explicitly directed otherwise;
- make focused commits with meaningful messages;
- add or update tests before declaring a defect fixed;
- run the required package and root verification commands;
- push every coherent milestone to GitHub;
- deploy only after the milestone-specific deployment gate passes;
- create an atomic rollback point before modifying the live extension;
- report exact branch names, commit SHAs, tests, benchmarks, deployment hashes, failures, and remaining risks;
- never upload raw Pi session files, private logs, credentials, access tokens, home-directory dumps, core files, or user content;
- never publish to npm, create a public release, change repository visibility, or enable external telemetry without explicit authorization;
- stop and report when a required credential, irreversible destructive action, or unresolved source-of-truth conflict is encountered.

## 3.3 Evidence hierarchy

When evidence conflicts, use this order:

1. Immutable Pi session JSONL and exact source hashes.
2. Actual live deployed files and their hashes.
3. Local Git commit and working-tree state.
4. Pushed GitHub commit contents.
5. Test and benchmark output.
6. Derived manifests and diagnostics.
7. Human-readable summaries.

A summary is never proof that source or deployment matches.

---

# 4. Product model

ChronoCompact must be treated as five related products with separate purposes.

## 4.1 Exact archive

**Purpose for the agent:** definitive evidence and complete recovery.

The exact archive is the original Pi session history. ChronoCompact does not rewrite or sanitize it. It must remain possible to retrieve:

- the complete original event;
- a selected message content block;
- a selected decoded text range;
- neighboring events;
- a chronological event range;
- source metadata and integrity hashes.

The archive can be divided into immutable physical shards, but the logical session remains continuous.

## 4.2 Incremental memory store

**Purpose for the agent:** searchable and composable representations of exact history.

The memory store contains bounded, source-linked derived data:

- event capsules;
- content chunk descriptors;
- lexical postings;
- identifiers and paths;
- resource observations;
- episodes;
- lifecycle relations;
- hierarchical rollups;
- current-state items;
- compaction snapshots.

The memory store is disposable and rebuildable.

## 4.3 Active context composer

**Purpose for the agent:** continue current work after Pi compaction without pretending all history remains present.

The composer selects a bounded working set containing:

- direct restrictions and protected instructions;
- current goals and unresolved state;
- the regular Pi summary;
- recent chronological episodes;
- selected older relevant memory;
- an exact recent raw tail;
- recovery routes.

It does not rebuild memory at compaction time.

## 4.4 Search and recall service

**Purpose for the agent:** locate and expand forgotten history.

Search returns compact cues and handles. Recall expands selected cues. Exact retrieval returns original evidence. These are distinct operations with different cost and output limits.

## 4.5 Operations and repair surface

**Purpose for the user and agent:** make failures diagnosable without opening private data or damaging the archive.

This includes status, doctor, worker, rebuild, migration, quarantine, and rollback commands.

---

# 5. Non-negotiable invariants

Every implementation must preserve these invariants.

## 5.1 Source and truth invariants

1. Pi session JSONL remains the authoritative source.
2. ChronoCompact never silently edits historical source JSONL.
3. Derived stores are versioned and replaceable.
4. Every lossy representation carries resolvable source references.
5. Every source reference is hash-bound to the source event or block.
6. A missing derived artifact reduces capability but never invalidates exact source.
7. Corrupt derived data is quarantined, not trusted.
8. No migration deletes an old source shard automatically.
9. Historical compaction records are not treated as independent source truth when raw source events remain available.
10. Exact retrieval clearly distinguishes raw JSON bytes, decoded message text, and derived summaries.

## 5.2 Agent-context invariants

1. The primary model receives each new tool result in full before retrospective reduction.
2. ChronoCompact does not intercept or pre-compress a new tool result.
3. The regular Pi summary remains present unless Pi itself cannot produce it.
4. User restrictions, project instructions, active blockers, unresolved failures, and pending approvals receive reserved context budget.
5. Lossy text identifies itself as memory rather than exact evidence.
6. The composer must not claim a task completed without source support.
7. Superseded state must be marked superseded rather than displayed as current.
8. Current state must retain provenance and confidence.
9. A failed optional subsystem must not erase the last known-good context snapshot.
10. Failure of ChronoCompact must fall back to a safe, bounded path rather than an implicit full-history rebuild.

## 5.3 Scale invariants

1. Normal ingestion is proportional to appended bytes.
2. Ordinary search does not build an index.
3. Ordinary compaction does not parse full history.
4. Ordinary recall reads only selected records or segments.
5. Runtime memory has a fixed configurable ceiling independent of lifetime history.
6. Physical Pi sessions remain bounded through logical-session sharding.
7. Background workers have explicit resource limits.
8. Concurrent requests for the same checkpoint coalesce.
9. Multi-agent fairness and host-wide pressure are controlled.
10. A crash cannot leave an unrecoverable permanent worker-slot state.

## 5.4 Security and privacy invariants

1. No API key or credential enters a local worker environment unless explicitly required for an opt-in model job.
2. Raw session data never enters Git.
3. Raw private diagnostics never enter the model context.
4. Local storage defaults to owner-only permissions.
5. Symlink traversal and unsafe path replacement are rejected.
6. Optional model advice is off by default.
7. Protected exact user or project instructions are never sent to an optional value model.
8. No telemetry leaves the workstation by default.
9. File names and scheduler artifacts exposed host-wide do not contain source text or private paths.
10. GitHub commits contain source, tests, safe documentation, and reproducible generated artifacts only.

---

# 6. Scope and non-goals

## 6.1 In scope

- Stabilizing current worker and history-search failures.
- Restoring or rebuilding comprehensive tests in the current monorepo.
- Mandatory incremental source cataloging.
- Logical sessions and bounded physical session shards.
- Exact source retrieval.
- Partial retrieval for large events.
- Incremental deterministic event reduction.
- Disk-backed cue and lexical search.
- Staged recall.
- Episode construction.
- Current-state materialization.
- Hierarchical temporal rollups.
- Context composition integrated with Pi’s regular summary.
- Multi-agent worker scheduling and resource isolation.
- Migration from current ChronoCompact sidecars and settings.
- Deployment, rollback, diagnostics, and repair commands.
- Repository and live deployment synchronization.
- Documentation and operational runbooks.

## 6.2 Not in scope without a separate decision

- Public release.
- npm publication.
- Remote hosted memory services.
- Cloud telemetry.
- Destructive rewriting of old session archives.
- Replacing Pi’s entire session manager unless extension APIs make bounded sharding impossible.
- Giving an optional model authority over final retained content.
- Pretending every old detail can remain in active context.
- Guaranteeing constant disk usage as history grows.
- Using a larger V8 heap as the primary fix.
- Accepting unbounded regex scans as an interactive operation.
- Committing private benchmark datasets.
- Automatically deleting archived shards.

---

# 7. Target architecture

## 7.1 High-level flow

```text
New Pi event
    │
    ▼
Exact append-only physical session shard
    │ appended range only
    ▼
Transactional source catalog
    ├── exact event offsets and hashes
    ├── parent/branch metadata
    ├── content-block descriptors
    └── ingestion checkpoint
    │
    ▼
Immutable memory generation
    ├── event capsules
    ├── decoded content chunks for large blocks
    ├── cue-search index
    ├── raw lexical locator
    ├── resource observations
    ├── episodes
    ├── current-state updates
    └── rollup frontier
    │
    ├──────────────► history_search
    ├──────────────► history_recall
    ├──────────────► history_get / history_range
    └──────────────► context composer
                             │
                             ├── protected contract
                             ├── current work state
                             ├── regular Pi summary
                             ├── recent memory
                             ├── relevant old memory
                             ├── exact raw tail
                             └── recovery routes
```

## 7.2 Logical and physical session model

A **logical session** represents the continuous long-lived memory of an agent or project branch.

A **physical shard** is a bounded Pi session JSONL file.

Logical session metadata must include:

- logical session ID;
- logical branch ID;
- owner project identity;
- creation timestamp;
- parent logical session or branch when forked;
- ordered shard list;
- shard source identity and final checkpoint;
- current active shard;
- continuation-capsule generation;
- memory-store schema versions;
- archive status;
- integrity state.

A physical shard rolls over at a safe boundary when one or more thresholds are reached. Thresholds are configurable, but defaults should initially target:

- 256 MiB source bytes;
- 50,000 records;
- 32 compaction generations;
- or a measured token threshold.

The first production defaults must be based on benchmark evidence and Pi API behavior, not intuition alone.

Rollover must occur only at a safe agent boundary:

- no in-flight tool call;
- no unmatched tool result;
- no active streaming response;
- no pending session switch;
- no active compaction transaction.

The continuation capsule becomes initial memory in the new shard. Search and exact recall continue across old shards.

## 7.3 Storage layout

The preferred layout is an owner-only logical-session directory outside Git, for example:

```text
~/.pi/agent/chrono-memory/
  <logical-session-hash>/
    manifest.json
    catalog.sqlite
    catalog.sqlite-wal
    catalog.sqlite-shm
    segments/
      capsules/
      lexical/
      chunks/
      episodes/
      rollups/
    snapshots/
    diagnostics/
    quarantine/
    migrations/
```

The exact naming may change after local compatibility review, but the rules are fixed:

- directories are `0700`;
- files are `0600`;
- source paths are stored only in owner-only metadata;
- public/safe diagnostics use logical IDs or hashes;
- immutable segments are content-addressed;
- current generation is published atomically;
- incomplete temporary files are never treated as committed;
- derived-store schema versions are independent from package version.

## 7.4 Transactional catalog

Use SQLite in WAL mode through a runtime-supported binding, provided the local Node/Pi runtime passes compatibility and fault tests.

The catalog is per logical session. It stores metadata and bounded searchable cues, not the complete raw archive.

Core tables or equivalent structures:

### `logical_session`

- `logical_session_id`
- `schema_version`
- `created_at`
- `current_branch_id`
- `current_shard_id`
- `state`
- `last_committed_generation`
- `integrity_hash`

### `logical_branch`

- `branch_id`
- `logical_session_id`
- `parent_branch_id`
- `fork_event_id`
- `created_at`
- `state`

### `physical_shard`

- `shard_id`
- `branch_id`
- `ordinal`
- `source_path`
- `device_id`
- `inode_id`
- `source_session_identity`
- `start_event_ordinal`
- `end_event_ordinal`
- `committed_byte_offset`
- `source_size`
- `prefix_hash`
- `state`
- `created_at`
- `closed_at`

### `source_event`

- `event_id`
- `shard_id`
- `branch_id`
- `logical_ordinal`
- `parent_event_id`
- `record_type`
- `role`
- `timestamp`
- `tool_name`
- `tool_call_id`
- `source_byte_offset`
- `source_byte_length`
- `source_hash`
- `estimated_tokens`
- `ingest_generation`

### `content_block`

- `block_id`
- `event_id`
- `block_index`
- `block_kind`
- `decoded_length`
- `estimated_tokens`
- `exact_hash`
- `chunk_manifest_id`
- `protected`
- `unresolved`
- `resource_key`

### `event_capsule`

- `capsule_id`
- `block_id`
- `capsule_schema`
- `cue_text`
- `action_text`
- `outcome_text`
- `identifiers`
- `paths`
- `state_flags`
- `importance`
- `source_ref`
- `capsule_hash`
- `generation`

### `resource_observation`

- `observation_id`
- `resource_key`
- `resource_kind`
- `block_id`
- `version_hash`
- `logical_ordinal`
- `lifecycle_state`

### `episode`

- `episode_id`
- `branch_id`
- `start_ordinal`
- `end_ordinal`
- `status`
- `summary`
- `cue`
- `source_refs`
- `episode_hash`
- `generation`

### `rollup_node`

- `node_id`
- `branch_id`
- `level`
- `start_ordinal`
- `end_ordinal`
- `child_ids`
- `summary`
- `state_digest`
- `source_coverage`
- `node_hash`
- `generation`

### `current_state_item`

- `state_item_id`
- `category`
- `key`
- `text`
- `status`
- `confidence`
- `first_source_ref`
- `latest_source_ref`
- `superseded_by`
- `updated_ordinal`
- `generation`

### `memory_generation`

- `generation`
- `source_checkpoint`
- `capsule_manifest`
- `search_manifest`
- `episode_manifest`
- `rollup_manifest`
- `state_snapshot`
- `created_at`
- `integrity_hash`
- `status`

### `job_lease` only if a broker is selected

Prefer kernel locks and SQLite writer serialization. Do not recreate fragile persistent JSON semaphores unless no alternative exists.

## 7.5 Immutable segment types

Large derived data should be stored in immutable, content-addressed segments:

1. **Capsule segments**  
   Bounded event representations and identifiers.

2. **Decoded chunk segments**  
   Optional decoded text chunks for large tool results, each linked to source hash and character range.

3. **Cue-search segments**  
   Compact term/posting data or FTS-backed indexed cues.

4. **Raw lexical locator segments**  
   Incremental term/trigram postings mapping to event/block IDs.

5. **Episode segments**  
   Completed chronological episodes.

6. **Rollup segments**  
   Closed hierarchical nodes.

A generation manifest references a complete compatible set of segments. Readers pin one generation.

---

# 8. Memory hierarchy

## 8.1 Level 0: exact archive

Retention: permanent unless the user explicitly archives or deletes source.

Use cases:

- exact user instruction;
- original tool output;
- original command;
- complete test failure;
- exact prior file observation;
- complete assistant message;
- forensic replay.

Access characteristics:

- direct offset read by event ID;
- bounded range reads;
- streaming decode;
- no whole-session materialization;
- exact hash verification.

## 8.2 Level 1: event capsules

Retention: all meaningful events, compact and immutable.

A capsule must answer:

- What happened?
- What object or resource was involved?
- What was the outcome?
- Did it fail?
- Is it unresolved?
- Was it later superseded?
- Where is the exact source?

Capsules are generated deterministically through reducer families. Current reducers should be reused after being separated from full-history planning.

Capsule quality requirements:

- no unsupported completion claims;
- preserve explicit error codes and decisive failure lines;
- preserve commands or paths when they are future-relevant;
- preserve source links;
- identify omissions;
- stay within family-specific token ceilings;
- remain deterministic for the same source and reducer version.

## 8.3 Level 2: episodes

Retention: all completed episodes, with open episodes maintained incrementally.

Episode boundaries may be driven by:

- user request;
- task or subtask transition;
- tool-call cluster;
- resource-focused work;
- explicit completion;
- failure and retry cycle;
- compaction boundary;
- session rollover;
- prolonged inactivity.

Episode content:

- initiating goal;
- restrictions;
- actions;
- important observations;
- failures;
- decisions;
- resource changes;
- resolution status;
- unresolved next action;
- source references.

Episode construction must be deterministic by default. Optional model advice can suggest boundaries or importance but cannot author the final episode without deterministic validation.

## 8.4 Level 3: hierarchical rollups

Retention: all closed historical ranges represented at multiple temporal resolutions.

Recommended initial fanout: 32 children per node, adjustable after benchmark.

Properties:

- append-only closed nodes;
- only the open frontier changes;
- update work approximately logarithmic in episode count;
- child references and source coverage are explicit;
- active restrictions and unresolved state propagate upward;
- current resource state is not inferred solely from old rollups;
- exact recovery remains through child and source references.

The existing history-rollup code should be audited and adapted rather than discarded. Shadow validation remains required until coverage and false-completion gates pass.

## 8.5 Level 4: materialized current-state view

This layer answers “What is true or unresolved now?”

Categories include:

- active restrictions;
- project requirements;
- current goals;
- open tasks;
- blockers;
- unresolved failures;
- pending approvals;
- accepted decisions;
- rejected approaches;
- current resource versions;
- commands not to repeat;
- environment facts;
- pinned working knowledge.

Each state item has lifecycle:

- `current`
- `resolved`
- `superseded`
- `abandoned`
- `uncertain`

State items must include provenance and confidence. No state item becomes authoritative merely because a model suggested it.

## 8.6 Level 5: active context snapshot

This is composed for a specific cut and model budget. It is never the sole archive.

Recommended ordering:

1. Current contract and protected restrictions.
2. Current work state and unresolved next actions.
3. Regular Pi summary.
4. Recent chronological memory.
5. Relevant older memory.
6. Exact raw tail.
7. Recovery routes.

The exact order may be tuned through experiments, but protected current state must remain highly visible.

---

# 9. Search and recall design

## 9.1 Tool contracts

Preserve compatible tool names where practical:

### `history_search`

Purpose: find likely historical items.

Output:

- stable handle;
- time/range;
- kind;
- cue;
- resource;
- current/superseded state;
- score reason;
- exact-source availability.

It must not return large raw bodies.

### `history_recall`

Purpose: expand selected memories.

Inputs:

- search handle or query;
- recall level;
- token budget;
- branch scope;
- source scope.

Levels:

- cue;
- event capsule;
- episode;
- resource evolution;
- rollup branch;
- bounded exact snippet.

### `history_get`

Purpose: exact retrieval by event/block handle.

Options:

- raw JSON record;
- decoded block;
- character range;
- byte range;
- neighboring event count;
- maximum output size;
- cursor.

### `history_range`

Purpose: exact chronological page.

Rules:

- bounded page size;
- resumable cursor;
- branch-aware;
- no arbitrary full-range materialization.

### `history_status`

Purpose: expose index and archive readiness without private text.

### `history_resource`

Optional purpose: show source-linked resource evolution and current version.

## 9.2 Search indexes

### Cue and metadata index

Use SQLite FTS5 or an equivalent disk-backed index over bounded capsule text and episode cues.

Fields:

- cue;
- action;
- outcome;
- identifiers;
- normalized paths;
- tool name;
- error state;
- unresolved state;
- resource key;
- branch;
- time range;
- lifecycle state.

### Raw lexical locator

Use append-only term or trigram postings over decoded blocks when exhaustive literal discovery is needed.

Design requirements:

- paged disk reads;
- no complete postings map in process memory;
- immutable segments;
- checkpointed merges;
- source hash verification;
- configurable indexing exclusions;
- bounded query planner.

Regex behavior:

1. Extract literals and metadata constraints.
2. Narrow candidate blocks through indexes.
3. Run regex only on selected blocks.
4. For an unconstrained regex, require an explicit scan mode with byte/time budget and cursor.
5. Never perform an implicit full logical-session regex scan in an interactive tool call.

## 9.3 Self-amplification prevention

Exclude from ordinary content indexing:

- `history_search` invocations;
- rendered search-result payloads;
- retrieval telemetry;
- status/doctor output;
- repetitive compaction diagnostics;
- generated memory snapshots;
- rollup metrics.

A minimal audit record can be stored in a separate bounded telemetry stream.

## 9.4 Query concurrency

- Multiple readers can search the same immutable generation.
- Index builds happen during ingestion, never inside search.
- Searches pin a generation.
- In-flight duplicate queries may share cached bounded results.
- Query-result caches have a strict byte limit and short lifetime.
- Caches are keyed by logical session, generation, branch scope, normalized query, filters, and output budget.
- No cache retains full decoded source records.

---

# 10. Context composition design

## 10.1 Inputs

The composer receives:

- Pi compaction preparation;
- branch entries for the bounded current physical shard;
- selected cut;
- latest compatible committed memory generation at or before the cut;
- bounded unindexed delta;
- current-state snapshot;
- regular Pi summary result;
- user retention hints;
- recent retrieval feedback;
- model context limit;
- configured section budgets.

## 10.2 Composition algorithm

1. Validate the Pi cut and tool-call/result safety.
2. Identify the logical session, branch, shard, and source checkpoint.
3. Pin the latest committed memory generation not beyond the cut.
4. Measure the delta from the generation checkpoint to the cut.
5. If the delta is within the configured maximum, reduce only that delta in a bounded worker.
6. If the delta is too large, use the last committed snapshot and increase the exact raw tail or trigger a safe pre-compaction catch-up job.
7. Build protected contract items.
8. Build current work-state items.
9. Obtain or reuse the regular Pi summary.
10. Select recent episodes and event capsules.
11. Derive retrieval queries from current goals, paths, resource keys, failures, and retention hints.
12. Select relevant older episodes or rollups.
13. Reserve exact raw-tail budget.
14. Add source-linked recovery handles.
15. Render sections deterministically.
16. Validate token ceilings, source coverage, restriction coverage, blocker coverage, unresolved-failure coverage, tool-pair integrity, and unsupported completion claims.
17. Return the custom compaction.
18. Publish a small compaction snapshot artifact outside the Pi session.
19. Persist only the minimal compaction envelope in the Pi JSONL.

## 10.3 Section budgets

Initial policy for a 25,000-token historical-memory budget:

| Section | Floor | Typical target | Ceiling |
| --- | ---: | ---: | ---: |
| Protected contract | 1,000 | 2,000 | 3,500 |
| Current work state | 1,500 | 3,000 | 5,000 |
| Regular Pi summary | 512 | 2,500 | 4,000 |
| Recent chronological memory | 4,000 | 8,000 | 11,000 |
| Relevant older memory | 2,000 | 6,500 | 10,000 |
| Recovery map and wrappers | 400 | 1,000 | 1,800 |
| Exact raw tail | configured separately | 3,000–8,000 | hard combined cap |

Unused budget may flow to recent or relevant older memory. Protected sections never lose their floor unless the entire context limit is smaller than supported, in which case the extension must clearly degrade.

## 10.4 Degradation ladder

From best to safest fallback:

1. Current committed memory generation plus bounded delta plus regular Pi summary.
2. Current committed memory generation without delta plus larger raw tail plus regular Pi summary.
3. Last good current-state snapshot plus recent capsules plus regular Pi summary.
4. Last good current-state snapshot plus regular Pi summary plus raw tail.
5. Regular Pi summary plus raw tail.
6. Pi default compactor.

No fallback may invoke a complete historical parse merely because a worker failed.

## 10.5 Minimal persisted compaction envelope

Persist in Pi:

- combined summary text;
- logical session ID or opaque handle;
- branch ID;
- shard ID;
- source cut event ID;
- memory generation;
- summary hash;
- token totals;
- validation status;
- artifact hash/reference;
- ChronoCompact version.

Do not persist:

- full planning unit arrays;
- complete source-entry ID arrays;
- duplicated regular summary fields;
- full worker diagnostics;
- detailed performance traces;
- complete validation issue objects when code counts suffice.

---

# 11. Worker and concurrency architecture

## 11.1 Worker process model

Retain one-shot local worker processes for isolation.

Each job includes:

- job ID;
- job type;
- logical session;
- source checkpoint;
- memory generation;
- deadline;
- memory limit;
- output limit;
- priority;
- schema version;
- cancellation channel.

Worker job types:

- ingest delta;
- build capsule segment;
- build lexical segment;
- close episode;
- update rollup frontier;
- compose compaction delta;
- exact large-event decode;
- repair/rebuild segment;
- optional value advice.

## 11.2 Scheduling

Replace persistent JSON ownership records with one of:

1. Kernel-managed `flock` slot files.
2. A small user-level worker broker using an authenticated local socket.

Initial preference: `flock` slots plus per-session SQLite writer serialization, because kernel locks are automatically released on process death and require less daemon lifecycle management.

Host-wide limits:

- total active deterministic workers;
- total active optional model workers;
- total estimated RSS budget;
- per-priority queue depth;
- maximum jobs per logical session.

Priority classes:

1. Interactive exact retrieval.
2. Compaction delta/composition.
3. Search recall requiring source reads.
4. Ingestion catch-up.
5. Background segment and rollup maintenance.
6. Optional model advice.

## 11.3 Coalescing

Coalesce jobs by:

```text
logical_session_id
branch_id
source_checkpoint
job_type
schema_version
configuration_hash
```

A duplicate request waits for or reuses the existing result. It does not start another full build.

## 11.4 Resource limits

Each worker must be constrained by:

- explicit Node heap limit;
- optional cgroup or systemd scope when available;
- maximum source bytes read;
- maximum decoded bytes;
- maximum output bytes;
- deadline;
- abort signal;
- restricted environment;
- bounded stderr capture;
- stage reporting.

A worker OOM or crash must produce a stable safe code and diagnostic record without crashing Pi.

## 11.5 Failure codes

Stable public codes should include:

- `scheduler-timeout`
- `worker-timeout`
- `worker-aborted`
- `worker-crashed`
- `worker-entry-missing`
- `worker-version-mismatch`
- `worker-protocol-error`
- `worker-response-too-large`
- `worker-resource-limit`
- `worker-internal-error`
- `source-missing`
- `source-replaced`
- `source-truncated`
- `source-prefix-changed`
- `source-incomplete-tail`
- `catalog-busy`
- `catalog-corrupt`
- `catalog-version-mismatch`
- `segment-missing`
- `segment-corrupt`
- `generation-incomplete`
- `index-lag-too-large`
- `invalid-cut`
- `branch-not-persisted`
- `validation-rejected`
- `no-net-savings`

Public errors remain safe. Private diagnostics contain the local technical detail.

---

# 12. Source ingestion and exact retrieval

## 12.1 Streaming ingestion

Never use `readFile(..., "utf8")` plus `split("\n")` for large live sessions.

The streaming reader must:

- open with no-follow semantics;
- read fixed-size byte chunks;
- assemble only the current line;
- tolerate an incomplete trailing line;
- track maximum line size;
- apply a separate large-record path above a threshold;
- update a rolling prefix hash or integrity chain;
- commit only complete records;
- resume from the last committed offset;
- detect replacement, truncation, and prefix rewrite.

## 12.2 Append-safe snapshots

A snapshot binds:

- device and inode;
- committed byte offset;
- prefix hash or checkpoint chain;
- source event at the cut;
- branch ancestry.

Pure appends after the committed offset are allowed.

Reject:

- device/inode replacement;
- file size below committed offset;
- changed prefix hash;
- missing cut event;
- branch parent mismatch.

## 12.3 Large records

For records above a configured threshold:

- stream-parse JSON;
- extract metadata without holding duplicate whole strings;
- divide decoded text content into fixed-size chunks;
- hash each chunk;
- write optional compressed chunk segments;
- retain exact source byte range;
- support partial decoded retrieval by chunk;
- verify derived chunk manifest against the source event hash.

The system may read memory proportional to one requested event for exact full retrieval. It may not read memory proportional to the entire session.

## 12.4 Repair rebuild

A repair rebuild:

- is explicit;
- streams every shard in logical order;
- emits progress by bytes and events;
- writes a new store generation;
- never overwrites the current good generation in place;
- publishes only after validation;
- can resume at shard/checkpoint boundaries;
- runs at low priority;
- remains bounded in memory.

---

# 13. Logical session rollover

## 13.1 Rollover trigger

Rollover is evaluated at agent-settled boundaries.

Initial configurable triggers:

- source bytes;
- record count;
- compaction generation count;
- measured branch-materialization cost;
- manual command.

## 13.2 Rollover sequence

1. Stop scheduling new low-priority work for the current shard.
2. Ensure no tool pair is open.
3. Catch ingestion up to the final complete event.
4. Finalize current state, open episode, and rollup frontier.
5. Build and validate a continuation capsule.
6. Close and hash the shard.
7. Add it to the logical-session manifest.
8. Create a new Pi session shard.
9. Inject the continuation capsule and logical-session metadata.
10. Switch the active session.
11. Verify search and exact recall across old and new shards.
12. Record a rollback path to reopen the old shard.

If Pi extension APIs do not support safe automatic creation/switching, implement:

- a `/chrono-rollover` command;
- a safe pending-rollover notification;
- a CLI helper;
- or a minimal upstream-compatible Pi patch.

The least invasive reliable option should be selected after API inspection and documented in an ADR.

## 13.3 Fork behavior

A fork creates a new logical branch:

- shares immutable ancestor shards;
- has its own active shard;
- has a branch-specific current-state view;
- can search ancestors by default;
- can include sibling branches only when requested;
- never mutates ancestor memory segments.

---

# 14. Security, privacy, and repository hygiene

## 14.1 Never commit

- Pi session JSONL files.
- Source-ledger sidecars containing private paths or history.
- SQLite catalogs.
- Event capsule stores derived from private sessions.
- Worker diagnostics.
- Core dumps.
- benchmark manifests naming private sessions.
- access tokens or credential files.
- `.env` files.
- home-directory inventory.
- deployed backup copies containing private configuration.
- `node_modules`.

## 14.2 Safe to commit

- source code;
- deterministic tests;
- generated synthetic fixtures;
- sanitized benchmark scripts;
- schema definitions;
- architecture documents;
- migration code;
- compiled `dist` only where the repository’s deployed-baseline policy requires it;
- hash manifests;
- safe aggregate benchmark summaries without private paths or source text.

## 14.3 Optional model privacy

Optional value-model jobs must:

- remain off by default;
- require explicit mode and cost budget;
- exclude protected user/project instructions;
- exclude credentials and secrets;
- use bounded excerpts;
- store advice locally;
- never directly author final replay;
- expose provider/model usage and cost;
- fail without blocking deterministic memory.

---

# 15. GitHub and live deployment operating model

## 15.1 Branching

Use a long-lived integration branch:

```text
rebuild/chrono-memory-v3
```

Use milestone branches or worktrees:

```text
work/chrono-v3-m00-baseline
work/chrono-v3-m01-stabilize
work/chrono-v3-m02-runtime
...
```

Every coherent commit is pushed promptly.

A milestone branch merges to the integration branch after its local tests pass. It merges to `main` when it is suitable for live deployment or when the repository owner’s mirror policy requires main to reflect the live baseline.

## 15.2 Commit rules

Each commit must:

- have one logical purpose;
- include tests with the behavior change;
- avoid unrelated formatting churn;
- update documentation when behavior changes;
- update generated `dist` and deployment hashes when required;
- pass package typecheck/build/tests;
- pass root repository verification;
- contain no private data.

Suggested prefixes:

- `fix(chrono):`
- `feat(chrono):`
- `refactor(chrono):`
- `test(chrono):`
- `docs(chrono):`
- `perf(chrono):`
- `chore(chrono):`

## 15.3 Pull requests

Use a PR for each milestone when practical. PR description includes:

- problem;
- architecture impact;
- source files;
- tests;
- benchmarks;
- migration behavior;
- live deployment plan;
- rollback;
- privacy review;
- known limitations.

The directing assistant reviews pushed files even when the local agent can merge autonomously.

## 15.4 Deployment source of truth

Every live deployment must record:

- Git commit SHA;
- package version;
- build timestamp;
- source tree hash;
- compiled entrypoint hash;
- configuration schema version;
- deployed path;
- backup/rollback identity;
- smoke-test result.

The live extension must not be built from uncommitted source.

## 15.5 Atomic deployment

Preferred sequence:

1. Verify clean milestone commit.
2. Run full tests.
3. Build in a clean or disposable directory.
4. Verify generated files.
5. Create owner-only backup of current live deployment.
6. Copy new package to a temporary deployment directory.
7. Verify hashes in the temporary directory.
8. Atomically switch symlink or rename directories.
9. Restart or reload Pi safely.
10. Run live smoke tests.
11. Record deployed SHA and hashes.
12. Push any deployment-manifest updates.
13. Retain a bounded number of rollback backups.

## 15.6 Early live deployment policy

Deploy safety and observability improvements early:

- worker diagnostics;
- legal internal failure codes;
- scheduler repair;
- whole-file search size gate;
- no-build-on-search;
- deployment doctor;
- bounded caches.

Deploy new architecture initially in:

- write-only shadow mode;
- read-only status mode;
- compare mode;
- opt-in canary mode.

Do not enable authoritative memory composition until comparison gates pass.

---

# 16. Detailed milestone plan

## Milestone M00 — Establish evidence and freeze the baseline

### Objective

Create a precise, reproducible record of the current repository, live deployment, configuration, failure symptoms, and private-data boundaries.

### Tasks

1. Create the integration branch.
2. Capture:
   - current Git SHA;
   - working-tree status;
   - package source hashes;
   - compiled `dist` hashes;
   - live extension path and hashes;
   - Node version;
   - Pi package versions;
   - ChronoCompact config;
   - active feature flags;
   - scheduler directory status;
   - last safe failure codes;
   - size and record count of selected test sessions.
3. Sanitize all evidence before committing.
4. Add `docs/chrono-v3/baseline.md`.
5. Add a private local evidence directory ignored by Git.
6. Add a script that compares repository source, built artifacts, and live deployment without exposing source history.
7. Restore the historical test suite into a current, runnable test project or explicitly document which tests cannot yet compile.
8. Run current build and verification.
9. Push the baseline branch.

### Exit criteria

- Repository and live deployment relationship is known.
- Current failure code is reproduced or instrumented enough to identify.
- No private session data is committed.
- A rollback copy of the current live extension exists.
- The integration branch is visible on GitHub.

### Deployment

None, except read-only diagnostic scripts.

---

## Milestone M01 — Contain current crash and worker-failure modes

### Objective

Stop known catastrophic behavior before adding new architecture.

### Required changes

1. Add a hard size gate to whole-file history loaders.
2. Above the threshold:
   - `history_search` must refuse the legacy path;
   - `history_recall` must refuse the legacy path;
   - exact tools must use the ledger or return a safe unavailable status;
   - no implicit full parser fallback.
3. Fix cache-before-build ordering.
4. Remove multi-generation full in-memory index retention.
5. Coalesce same-session builds.
6. Add `worker-internal-error` to the protocol.
7. Preserve the real safe code instead of converting it into a protocol failure.
8. Capture bounded stderr, exit code, signal, stage, entrypoint identity, and sizes in a private diagnostic for replay workers.
9. Repair malformed scheduler artifacts safely or replace scheduler occupancy with kernel locks.
10. Add `/chrono-worker-status` and `/chrono-doctor` read-only commands.
11. Add regression tests for:
    - 205 MiB session refusal without high RSS;
    - concurrent search refusal;
    - malformed slot file recovery;
    - unexpected worker exception;
    - missing worker entrypoint;
    - protocol-range mismatch;
    - exact source append during worker operation.
12. Keep the huge affected session untouched.

### Exit criteria

- Current crash is no longer reproducible under a fixed heap.
- A malformed scheduler artifact cannot block all agents indefinitely.
- Worker failures report a stable code.
- Main Pi remains alive when a worker crashes or exhausts its resource limit.
- Legacy search on large sessions fails safely and instructively.
- Tests and root verifier pass.

### Deployment gate

Deploy immediately after:

- regression tests pass;
- live smoke on a small fresh session passes;
- isolated worker can succeed once;
- forced worker failure produces a safe code;
- rollback is verified.

### Default behavior

Safety gates enabled by default. New architectural features remain off.

---

## Milestone M02 — Rebuild the test and benchmark foundation

### Objective

Make future architecture changes measurable and prevent accidental regressions.

### Tasks

1. Restore and update:
   - worker tests;
   - scheduler tests;
   - source-ledger tests;
   - candidate-store tests;
   - retrieval tests;
   - extension integration tests;
   - compaction equivalence tests;
   - rollup tests;
   - privacy tests.
2. Add synthetic session generator supporting:
   - configurable records;
   - configurable average tool-result size;
   - very large single records;
   - branches and forks;
   - repeated compactions;
   - malformed tails;
   - source replacement;
   - session rollover.
3. Add benchmark harness with JSON output.
4. Add fixed-heap test runners:
   - 512 MiB;
   - 1 GiB;
   - optional 2 GiB.
5. Add fault injection:
   - process kill between file operations;
   - partial segment write;
   - SQLite transaction abort;
   - missing segment;
   - corrupted manifest;
   - worker timeout;
   - concurrent append.
6. Add privacy scanner for committed fixtures and docs.
7. Add CI jobs for:
   - typecheck;
   - unit tests;
   - integration tests;
   - deterministic output;
   - repository verification;
   - package build;
   - generated artifact consistency.
8. Keep giant scale benchmarks local, with only scripts and safe summaries committed.

### Exit criteria

- One command runs the complete normal suite.
- One command runs fixed-heap scale regressions.
- Test output is machine-readable.
- Existing behavior has a characterization baseline.
- CI is green.

### Deployment

Test infrastructure itself does not change live behavior.

---

## Milestone M03 — Transactional runtime and scheduler

### Objective

Establish reliable process coordination before introducing persistent V3 memory.

### Tasks

1. Implement kernel-managed worker slots or local broker.
2. Add priority queue semantics.
3. Add per-session job coalescing.
4. Add per-job memory, source-read, output, and deadline limits.
5. Add stage progress for every worker job type.
6. Add stable public failure codes.
7. Add owner-only diagnostics.
8. Add host-wide status.
9. Add dead-process, crash, reboot, malformed-artifact, and PID-reuse tests.
10. Verify no worker inherits provider credentials unless explicitly authorized.
11. Implement a compatibility wrapper so current replay jobs can use the new runtime before V3 storage exists.

### Exit criteria

- Four or more agents can queue work without stale occupancy.
- Worker death releases capacity automatically.
- Replay priority behaves correctly.
- Duplicate checkpoint work coalesces.
- Resource-limit failures are controlled.
- No private path is exposed in shared artifacts.

### Deployment gate

Deploy the runtime under existing ChronoCompact behavior after worker equality tests pass.

---

## Milestone M04 — Mandatory incremental source catalog

### Objective

Make streaming, exact source indexing the universal foundation.

### Tasks

1. Define logical-session and shard identity schemas.
2. Implement SQLite compatibility probe.
3. Implement catalog creation and migrations.
4. Import or reuse current source-ledger checkpoints where valid.
5. Stream only appended bytes.
6. Detect replacement, truncation, tail rewrite, and incomplete tail.
7. Store event metadata and block descriptors.
8. Preserve parent and branch relationships.
9. Implement append-safe source snapshots.
10. Implement direct exact event retrieval.
11. Implement bounded exact range retrieval.
12. Implement large-record streaming parse path.
13. Add owner-only storage permissions and no-follow path checks.
14. Add catalog status and integrity commands.
15. Add explicit rebuild command.
16. Make whole-file parser unavailable above the small-session threshold.
17. Add migration and rollback tests.

### Exit criteria

- A large session can be cataloged under a fixed heap.
- Subsequent updates read only appended bytes plus bounded anchors.
- Exact event retrieval reads only the selected event/range.
- Pure appends do not invalidate a pinned prefix snapshot.
- Source rewrite is detected.
- Catalog corruption does not modify source.
- Rebuild is streaming and publishes atomically.

### Deployment mode

Shadow ingestion enabled by default only after storage-path and privacy review. Current compaction remains authoritative.

---

## Milestone M05 — Event capsule and chunk segment store

### Objective

Move deterministic reduction from compaction time to incremental ingestion time.

### Tasks

1. Define event-capsule schema.
2. Version each reducer family.
3. Refactor existing reducers into pure source-block-to-capsule functions.
4. Define protected fields and omission markers.
5. Implement immutable capsule segments.
6. Implement content-addressed manifests.
7. Implement decoded large-block chunks.
8. Add capsule quality validation.
9. Add deterministic output tests.
10. Add segment corruption and partial-publication tests.
11. Add incremental append benchmarks.
12. Add source-reference resolution tests.
13. Add a compatibility adapter for the current compactor to consume precomputed capsules.

### Exit criteria

- Capsule generation processes only new events.
- Same source and reducer version produce identical bytes.
- Every capsule resolves to exact source.
- Large event processing remains within memory limits.
- Missing capsule segment triggers bounded regeneration or degraded behavior.
- Current compactor output remains equivalent or safely characterized.

### Deployment mode

Dual-write shadow mode. Status command exposes progress. No model-facing change yet.

---

## Milestone M06 — Disk-backed search and exact staged recall

### Objective

Replace full-session in-memory search permanently.

### Tasks

1. Build cue/metadata search over capsules.
2. Build raw lexical locator incrementally.
3. Add branch and shard scoping.
4. Add current/superseded filters.
5. Add path and identifier normalization.
6. Add result diversity.
7. Add cursor pagination.
8. Separate search, recall, and exact retrieval.
9. Add query planner for regex and literal searches.
10. Add explicit bounded scan mode.
11. Exclude retrieval output from normal indexing.
12. Add query cache with strict byte cap.
13. Add concurrent-reader tests.
14. Add generation pinning.
15. Add compatibility response rendering for current tool names.
16. Add scale tests with sequential and parallel search under fixed heap.
17. Add search quality fixture suite.

### Exit criteria

- Search never calls the whole-session parser.
- Search never builds an index.
- Repeated searches do not increase retained memory by session size.
- Concurrent searches use one immutable generation.
- Exact retrieval works for every hit.
- Regex scans are bounded and resumable.
- Search results fit strict token budgets.
- Old affected session can be searched without approaching heap exhaustion.

### Deployment gate

Enable new search backend for indexed sessions. Keep a small-session compatibility path only below a hard threshold.

---

## Milestone M07 — Episodes, resource evolution, and current-state materialization

### Objective

Create memory structures that serve the agent’s actual cognitive needs.

### Tasks

1. Define deterministic episode-boundary rules.
2. Implement open episode state.
3. Close episodes at safe boundaries.
4. Integrate resource lineage.
5. Implement current-state categories and lifecycle.
6. Detect resolution and supersession.
7. Preserve unresolved failures and blockers.
8. Integrate explicit editable memory and retention hints.
9. Add confidence and provenance.
10. Add resource-evolution recall.
11. Add tests for:
    - repeated file revisions;
    - failed then successful command;
    - abandoned approach;
    - changed user restriction;
    - pending approval;
    - unresolved tool failure;
    - branch fork;
    - compaction boundary;
    - rollover boundary.
12. Add quality metrics:
    - restriction coverage;
    - blocker coverage;
    - unresolved-failure coverage;
    - current-resource coverage;
    - false completion count;
    - unsupported fact count.

### Exit criteria

- Current state reflects the latest supported status.
- Superseded items do not appear current.
- Open work survives many episodes.
- Every state item resolves to source.
- Episode formation is incremental.
- Quality metrics meet defined floors on fixtures.

### Deployment mode

Shadow state and episode generation. Expose through status/diagnostic commands and optional manual recall.

---

## Milestone M08 — Authoritative hierarchical rollups

### Objective

Make old history compact, navigable, and incrementally maintainable.

### Tasks

1. Audit existing rollup store and validation.
2. Align it with logical sessions and episode IDs.
3. Implement fixed-fanout append frontier.
4. Store immutable closed nodes.
5. Propagate protected state and unresolved items.
6. Add source and child coverage hashes.
7. Add query-time top-down selection.
8. Add rollup repair and rebuild.
9. Compare current deterministic replay with rollup selection.
10. Run shadow evaluations across:
    - synthetic long runs;
    - sanitized local session manifests;
    - forks;
    - repeated compactions;
    - large tool outputs.
11. Establish live gate:
    - zero invalid references;
    - zero false completions;
    - complete protected restriction coverage;
    - complete blocker coverage;
    - complete unresolved-failure coverage;
    - acceptable resource coverage;
    - bounded update time and memory.

### Exit criteria

- Rollup updates touch only the frontier.
- Query reads scale with selected nodes, not total episodes.
- Exact recovery works from every rollup item.
- Shadow quality gates pass.

### Deployment mode

Continue shadow until M09 composer can compare complete context outputs.

---

## Milestone M09 — V3 context composer

### Objective

Replace full-history compaction reconstruction with snapshot composition.

### Tasks

1. Define composer input/output schemas.
2. Implement generation pinning.
3. Implement bounded delta reduction.
4. Implement protected section floors.
5. Integrate current state.
6. Integrate regular Pi summary.
7. Select recent capsules and episodes.
8. Select relevant older rollups.
9. Integrate exact raw tail.
10. Add recovery map.
11. Implement token planner.
12. Implement validation.
13. Implement degradation ladder.
14. Slim Pi compaction records.
15. Write detailed artifacts outside the session.
16. Add compare mode:
    - current replay;
    - V3 composition;
    - regular Pi fallback.
17. Measure:
    - token totals;
    - source coverage;
    - current-state coverage;
    - false completions;
    - output determinism;
    - compaction wall time;
    - worker RSS;
    - model continuation quality on controlled tasks.
18. Add canary flag per logical session.

### Exit criteria

- Steady-state compaction does not parse old shards.
- Compaction cost is bounded by output plus delta.
- Regular Pi summary remains present.
- Current restrictions and unresolved state meet coverage floors.
- Combined context stays below hard cap.
- Failure falls through the degradation ladder.
- Compare metrics meet or exceed current replay on required safety dimensions.

### Deployment progression

1. Shadow composition.
2. Manual preview.
3. Opt-in fresh-session canary.
4. Selected existing moderate session.
5. Default for V3-indexed sessions.
6. Current full-replay path becomes compatibility fallback only.

---

## Milestone M10 — Logical-session sharding and continuation

### Objective

Remove the physical Pi session file as the lifetime scale ceiling.

### Tasks

1. Inspect Pi APIs for safe session creation/switching.
2. Write ADR selecting extension command, CLI helper, or minimal Pi patch.
3. Implement logical-session manifest.
4. Implement rollover eligibility.
5. Implement continuation capsule.
6. Create new shard and bind it to the logical session.
7. Preserve branch ancestry.
8. Search and recall across shards.
9. Add manual rollback/reopen path.
10. Add migration command to adopt existing sessions as shard 0.
11. Add fork handling.
12. Add tests for:
    - rollover during idle;
    - refusal during open tool pair;
    - crash between close and new shard;
    - duplicate rollover attempt;
    - continuation capsule validation;
    - old-shard exact recall;
    - branch fork after rollover;
    - rollback.
13. Add operator status for shard sizes and thresholds.

### Exit criteria

- Logical session continues across at least ten shards.
- Pi active branch remains bounded.
- Exact recall spans all shards.
- Search spans current branch and ancestors.
- Rollover is atomic or recoverable.
- No old shard is deleted.
- Continuation context is source-linked and validated.

### Deployment progression

Manual command first, then optional automatic rollover after sustained canary success.

---

## Milestone M11 — Multi-agent scale and fault campaign

### Objective

Prove that the architecture remains stable under the intended concurrency and history size.

### Test matrix

- 4, 8, and 16 active logical sessions.
- 1–4 deterministic worker slots.
- concurrent ingestion and search;
- concurrent compaction and search;
- concurrent exact retrieval of large events;
- repeated worker crashes;
- process kill during transaction;
- system restart;
- source append during snapshot;
- corrupted derived segment;
- stale schema generation;
- one session with hundreds of millions of estimated tokens;
- multiple sessions totaling at least one billion estimated tokens;
- repeated physical shard rollover;
- 100+ compaction generations;
- forks and abandoned branches.

### Required measurements

- main Pi RSS over baseline;
- worker peak RSS;
- total host RSS;
- event-loop delay;
- ingestion lag;
- search p50/p95/p99;
- recall p50/p95;
- compaction composition time excluding Pi model summary;
- source bytes read per operation;
- segment bytes read;
- queue wait;
- failure counts;
- recovery time;
- exact-reference validation;
- context coverage metrics.

### Exit criteria

- Memory remains within configured ceilings.
- No process-local V8 OOM in normal operations.
- One session cannot starve all others indefinitely.
- A crashed worker cannot block capacity after death.
- Search and compaction never initiate full logical-history reads.
- Exact recall remains valid after restart and migration.
- Fault injection leaves source untouched.
- Performance targets are met or documented with justified revised thresholds.

---

## Milestone M12 — Migration, default activation, and cleanup

### Objective

Move from V2 compatibility to V3 as the normal architecture without losing rollback.

### Tasks

1. Add migration state machine.
2. Adopt current session as logical shard.
3. Reuse valid ledgers where safe.
4. Rebuild missing V3 derived data in background.
5. Keep current compaction authoritative until V3 ready.
6. Enable V3 search when index ready.
7. Enable V3 composer after canary.
8. Preserve compatibility tools.
9. Deprecate:
   - full-session search;
   - full-history compaction reconstruction;
   - multi-generation index cache;
   - JSON scheduler ownership;
   - bulky compaction details.
10. Update README, architecture, operations, recovery, privacy, and configuration docs.
11. Update version to `3.0.0` only when authoritative composition and logical-session support are ready.
12. Run clean install and upgrade tests.
13. Verify deployed-baseline reproducibility.
14. Tag an internal checkpoint if desired, without public release.
15. Retain rollback package and migration backups.

### Exit criteria

- Fresh and migrated sessions use V3 paths.
- Old archives remain readable.
- Default behavior is bounded and incremental.
- Live deployment matches GitHub main/deployed SHA.
- Operational docs are complete.
- All acceptance tests pass.

---

# 17. Test strategy

## 17.1 Unit tests

Cover pure functions:

- JSONL line parsing;
- source identity;
- prefix hash;
- event metadata extraction;
- block identification;
- capsule reduction;
- episode boundaries;
- lifecycle transitions;
- state supersession;
- rollup node formation;
- token budgeting;
- result validation;
- query normalization;
- cursor encoding;
- source-reference resolution.

## 17.2 Property-based and fuzz tests

Generate:

- arbitrary valid and invalid JSONL;
- large escaped strings;
- Unicode;
- ANSI terminal output;
- embedded newlines;
- malformed partial tails;
- repeated IDs;
- missing parents;
- branch cycles;
- extreme path strings;
- large numbers;
- hostile regex;
- nested compaction metadata.

Properties:

- parser never accepts invalid source silently;
- source offsets round-trip;
- exact retrieved bytes hash correctly;
- deterministic reducers are stable;
- token output stays bounded;
- cursor pagination has no duplicates or gaps;
- migration is idempotent;
- crash recovery never publishes incomplete generations.

## 17.3 Integration tests

- Pi extension event lifecycle.
- Session start, compact, fork, switch, shutdown.
- Tool call/result pairing.
- Regular Pi summary integration.
- Live worker fork and IPC.
- Catalog and immutable segment publication.
- Search-to-recall-to-exact recovery.
- Shard rollover.
- Deployment reload.

## 17.4 Fault tests

Inject termination after every critical write step:

- temporary segment written;
- segment fsynced;
- manifest written;
- catalog committed;
- current-generation pointer switched;
- shard closed;
- new shard created;
- deployment copied;
- deployment activated.

After restart:

- last good generation remains readable;
- incomplete files are ignored or quarantined;
- source remains unchanged;
- operation can retry safely.

## 17.5 Scale tests

Do not commit giant fixtures. Generate them locally.

Tiers:

### Tier S — ordinary CI

- 10–100 MiB;
- thousands of events;
- fast enough for routine CI.

### Tier M — nightly/local

- 250–500 MiB;
- 50,000+ records;
- repeated searches and compactions under 1 GiB heap.

### Tier L — release gate

- 1–4 GiB logical history;
- hundreds of millions of estimated tokens;
- multiple shards;
- multiple agents.

### Tier XL — architecture stress

- aggregate billion-token archive;
- 8+ logical sessions;
- fault campaign.

## 17.6 Context quality tests

Fixtures must assert:

- exact user restrictions retained;
- blocker retained;
- unresolved test failure retained;
- rejected approach marked rejected;
- current file version distinguished from old;
- pending approval not converted to completion;
- old irrelevant repetition compressed;
- recent actions remain visible;
- recovery handles resolve;
- unsupported facts count is zero;
- false completion count is zero.

## 17.7 Privacy tests

- worker environment allowlist;
- no credential strings in diagnostics;
- no source text in scheduler artifacts;
- no private paths in committed benchmark output;
- optional model prompt excludes protected content;
- Git scan blocks session JSONL patterns and known secrets.

---

# 18. Performance and capacity targets

These are initial engineering targets. Any revision requires benchmark evidence and an ADR.

## 18.1 Memory

- Main Pi incremental overhead: target under 250 MiB above Pi baseline for an active V3 session.
- Ordinary search process: target under 256 MiB RSS.
- Ingestion worker: target under 512 MiB RSS.
- Large-event exact retrieval worker: bounded by configured event/chunk limit, default under 768 MiB RSS.
- Compaction composer worker: target under 512 MiB RSS.
- No ordinary operation’s retained memory increases with total archive size.

## 18.2 Latency

For a fully indexed local session on the reference workstation:

- cue search p95: under 300 ms;
- staged capsule recall p95: under 500 ms;
- episode recall p95: under 1 s;
- exact event retrieval up to 1 MiB p95: under 500 ms;
- steady-state deterministic context composition excluding Pi model summary p95: under 2 s;
- ingestion of ordinary append batch: under 5 s lag after agent settles;
- status command: under 200 ms.

## 18.3 I/O proportionality

- Search source JSONL bytes read: normally zero.
- Exact retrieval bytes read: selected record/range plus bounded overhead.
- Compaction old-shard bytes read: zero in steady state.
- Ingestion bytes read: appended bytes plus bounded anchor.
- Rollup update: open frontier only.
- Startup: manifests and current shard metadata only.

## 18.4 Reliability

- Zero source corruption.
- Zero invalid source references in accepted generations.
- Zero false completion claims in release-gate fixtures.
- Zero permanent scheduler occupancy after process death.
- Zero implicit whole-history operations above the small-session threshold.
- Recovery from worker crash without Pi process crash.
- Recovery from interrupted derived-store write without manual source repair.

---

# 19. Diagnostics and operational commands

## `/chrono-status`

Show:

- package and schema versions;
- logical session and branch;
- active shard;
- shard count;
- source bytes;
- estimated tokens;
- source checkpoint;
- ingestion lag;
- current generation;
- capsule/index/episode/rollup readiness;
- current-state item counts;
- last compaction generation;
- last failure code;
- worker queue summary.

No source text.

## `/chrono-doctor`

Read-only by default.

Checks:

- deployed SHA and hashes;
- catalog integrity;
- source prefix;
- shard manifest;
- segment existence and hashes;
- incomplete temporary files;
- schema compatibility;
- worker entrypoint;
- scheduler capacity;
- permissions;
- optional model configuration;
- Git/live mismatch.

Repair actions require an explicit separate command.

## `/chrono-repair`

Supports:

- quarantine malformed derived data;
- rebuild selected generation;
- rebuild search;
- rebuild rollups;
- rebind moved shard by exact identity/hash;
- clear safe caches;
- repair deployment from known commit.

Never edits source JSONL automatically.

## `/chrono-rollover`

Manual safe shard rollover.

## `/chrono-worker-status`

Shows:

- active job IDs and safe types;
- priorities;
- queue positions;
- runtime;
- RSS;
- stage;
- recent safe failures.

## `/chrono-migration-status`

Shows:

- source adoption state;
- current migration stage;
- bytes/events processed;
- remaining shards;
- last checkpoint;
- rollback availability.

---

# 20. Migration strategy

## 20.1 Principles

- Non-destructive.
- Idempotent.
- Versioned.
- Restartable.
- Shadow-first.
- Old source remains exact.
- Last good V2 path remains available until V3 acceptance.

## 20.2 Existing session adoption

1. Register current JSONL as shard 0.
2. Import valid source-ledger metadata after verifying source identity and hashes.
3. Ignore or quarantine invalid legacy sidecars.
4. Build V3 catalog incrementally from existing offsets where possible.
5. Generate capsules and indexes in background.
6. Keep current compaction active.
7. Enable V3 search when ready.
8. Run V3 composer in shadow.
9. Enable per-session canary.
10. Retain V2 rollback.

## 20.3 Huge affected session

The known large archived session must remain an explicit forensic and regression asset locally, not in Git.

Migration sequence:

- never open it through legacy `history_search`;
- catalog with fixed heap;
- verify record count and source hash;
- build capsule/index segments under resource limits;
- run sequential and concurrent search regression;
- verify exact retrieval;
- optionally adopt as a closed shard rather than reopen it as a live Pi session.

## 20.4 Schema migrations

- Each migration has `from`, `to`, precondition, operation, validation, rollback/quarantine behavior.
- No in-place destructive transformation of the only valid generation.
- New generation built beside old.
- Atomic current pointer switch.
- Previous generation retained until post-deploy verification.

---

# 21. Deployment and rollback runbook

## 21.1 Pre-deploy checklist

- clean Git commit;
- branch pushed;
- code reviewed;
- package typecheck passed;
- unit/integration tests passed;
- relevant scale regression passed;
- root verifier passed;
- privacy scan passed;
- built artifacts reproducible;
- migration compatibility checked;
- feature default reviewed;
- rollback directory prepared;
- no active compaction or worker job;
- live agents notified or safely restarted.

## 21.2 Live smoke checklist

- extension loads;
- version/status command works;
- small exact history lookup works;
- worker can start and exit;
- forced worker failure reports safe code;
- compaction on a synthetic/fresh session succeeds;
- regular Pi summary remains present;
- fallback works with a disabled subsystem;
- no scheduler residue;
- no unexpected diagnostic leakage;
- live hash matches deployed SHA.

## 21.3 Rollback triggers

Rollback immediately for:

- Pi startup failure;
- repeated worker crash;
- source integrity mismatch;
- invalid or unresolved source references;
- false completion in composed context;
- compaction loop;
- context exceeding hard cap;
- unexplained cross-agent blocking;
- unexpected provider call;
- migration modifies source;
- live deployment hash mismatch.

## 21.4 Rollback procedure

1. Stop new background work.
2. Disable new feature flags.
3. Switch atomically to previous deployment.
4. Restart Pi.
5. verify status and a small compaction.
6. Preserve failed derived state in quarantine.
7. record failure evidence privately.
8. push a safe incident note without private data.
9. fix on a new branch.
10. do not delete source or failed evidence until reviewed.

---

# 22. Instruction protocol for the Pi agent

Every future execution instruction from the directing assistant must be delivered as **exactly one fenced code block** with no prose outside the block.

The block must be self-contained and include:

1. **Role**
   - The Pi agent is local implementer and evidence collector.

2. **Milestone**
   - exact milestone ID and objective.

3. **Starting conditions**
   - branch;
   - repository path;
   - known commit;
   - files or systems to inspect.

4. **Safety constraints**
   - preserve unrelated changes;
   - no private history in Git;
   - no destructive source edits;
   - no publication;
   - no deployment before gates.

5. **Inspection**
   - precise commands or facts to establish before editing.

6. **Implementation**
   - exact required behavior;
   - architecture constraints;
   - expected files/modules;
   - compatibility requirements.

7. **Tests**
   - exact unit, integration, fixed-heap, fault, privacy, and root-verification commands.

8. **Git**
   - branch naming;
   - commit structure;
   - push requirement;
   - PR or merge instructions.

9. **Deployment**
   - whether allowed;
   - gates;
   - atomic deployment;
   - rollback;
   - live smoke.

10. **Report**
    - commit SHAs;
    - changed files;
    - tests;
    - benchmarks;
    - deployment status;
    - live hash;
    - remaining risks;
    - blockers.

11. **Stop conditions**
    - credentials;
    - irreversible action;
    - source mismatch;
    - private-data risk;
    - inability to reproduce required baseline.

The Pi agent should not be instructed to “fix everything” in one turn. Each block must be large enough to produce meaningful progress but bounded enough to review.

---

# 23. Required Pi-agent completion report format

```markdown
# Milestone report

## Identity
- Milestone:
- Branch:
- Starting SHA:
- Final SHA:
- Pushed remote:

## Baseline findings
- Repository state:
- Live deployment state:
- Relevant configuration:
- Reproduced failure:

## Changes
- Source files:
- Tests:
- Documentation:
- Generated artifacts:

## Validation
- Typecheck:
- Unit tests:
- Integration tests:
- Fixed-heap tests:
- Fault tests:
- Privacy scan:
- Root verifier:
- Benchmarks:

## Deployment
- Deployed: yes/no
- Deployed SHA:
- Backup/rollback:
- Live hashes:
- Smoke tests:

## Risks and remaining work
- Known limitations:
- Deferred items:
- Unexpected findings:
- Recommended next milestone:
```

Reports must distinguish “not run,” “failed,” and “passed.” Missing output is not a pass.

---

# 24. Risk register

## R1 — Pi itself materializes large physical branches

**Impact:** ChronoCompact becomes efficient but Pi still exhausts memory.  
**Mitigation:** logical-session sharding; inspect Pi APIs early; bounded physical shards are mandatory for claimed scale.

## R2 — SQLite runtime incompatibility

**Impact:** catalog cannot load in live Pi.  
**Mitigation:** compatibility probe and ADR; support runtime upgrade, pinned binding, or broker-side SQLite. Do not quietly fall back to whole-file parsing.

## R3 — Native binding deployment fragility

**Impact:** workstation upgrades break extension.  
**Mitigation:** prefer supported built-in binding; otherwise reproducible binary/build checks and doctor command.

## R4 — Derived-store corruption

**Impact:** search or compaction unavailable.  
**Mitigation:** immutable generations, atomic publication, integrity hashes, quarantine, streaming rebuild.

## R5 — Search quality declines after aggressive reduction

**Impact:** exact event exists but is difficult to locate.  
**Mitigation:** dual cue/raw locator indexes, identifiers, paths, resource evolution, staged recall, explicit bounded raw scan.

## R6 — Rollups omit unresolved work

**Impact:** agent falsely believes work is complete.  
**Mitigation:** protected propagation, current-state layer, coverage metrics, false-completion tests, shadow gate.

## R7 — Context composer overweights old history

**Impact:** current work becomes less visible.  
**Mitigation:** section floors/ceilings, recent exact tail, current-state priority, retrieval relevance.

## R8 — Context composer overweights recent history

**Impact:** important older restrictions disappear.  
**Mitigation:** protected contract layer and pinned state independent from recency.

## R9 — Multi-agent host pressure

**Impact:** agents stall or system swaps.  
**Mitigation:** host-wide worker and RSS budgets, priorities, coalescing, fixed slots, low-priority background work.

## R10 — Live deployment diverges from GitHub

**Impact:** directing assistant reviews different code from execution.  
**Mitigation:** deployed SHA manifest, hash comparison, build only from committed source, root verification.

## R11 — Private data enters GitHub

**Impact:** privacy breach.  
**Mitigation:** strict ignores, privacy scanner, synthetic fixtures, sanitized reports, no raw diagnostics.

## R12 — Migration traps old sessions

**Impact:** sessions cannot use old or new path.  
**Mitigation:** non-destructive adoption, old path retained, per-session canary, atomic generation switch.

## R13 — Compaction record growth repeats the original problem

**Impact:** archives bloat with duplicated metadata.  
**Mitigation:** minimal envelope, detailed sidecars, historical-compaction exclusion from indexes.

## R14 — Optional model advice becomes authority

**Impact:** unsupported facts or omissions.  
**Mitigation:** deterministic final composition and validation; model advice only modifies bounded scores.

## R15 — Project scope becomes unreviewable

**Impact:** large risky changes cannot be audited.  
**Mitigation:** milestone branches, focused commits, push/review loop, deployment gates.

---

# 25. Architecture decision records required

Create and maintain ADRs for:

1. `ADR-001`: logical sessions and bounded physical shards.
2. `ADR-002`: transactional catalog storage and SQLite binding.
3. `ADR-003`: immutable segment format and manifest publication.
4. `ADR-004`: kernel locks versus worker broker.
5. `ADR-005`: event capsule schema and reducer versioning.
6. `ADR-006`: cue index and raw lexical locator.
7. `ADR-007`: episode-boundary rules.
8. `ADR-008`: current-state lifecycle model.
9. `ADR-009`: rollup fanout and propagation rules.
10. `ADR-010`: context section budgets and validation.
11. `ADR-011`: logical-session rollover integration with Pi.
12. `ADR-012`: deployment, generated artifacts, and live SHA recording.
13. `ADR-013`: optional model advice privacy and authority boundary.
14. `ADR-014`: schema migration and repair strategy.

Each ADR includes context, decision, alternatives, consequences, migration, and reversal path.

---

# 26. Configuration model

Retain safe defaults and introduce explicit V3 settings.

Proposed categories:

## Archive/catalog

- `catalogEnabled`
- `catalogPath`
- `smallSessionWholeFileLimitBytes`
- `largeRecordThresholdBytes`
- `decodedChunkBytes`
- `ingestBatchBytes`
- `ingestLagLimitBytes`

## Search

- `searchBackend`
- `rawLexicalIndexEnabled`
- `searchResultTokenBudget`
- `searchCacheBytes`
- `regexScanByteBudget`

## Memory

- `capsuleEnabled`
- `episodeEnabled`
- `rollupEnabled`
- `currentStateEnabled`
- `rollupFanout`
- `hotHistoryTokens`
- `warmHistoryTokens`

## Composer

- `composerMode`: `off | shadow | canary | authoritative`
- `protectedContractTokens`
- `currentStateTokens`
- `regularSummaryTokens`
- `recentMemoryTokens`
- `olderMemoryTokens`
- `rawTailMode`
- `hardCombinedCapTokens`
- `maxDeltaBytes`

## Sharding

- `logicalSessionsEnabled`
- `rolloverMode`: `off | manual | automatic`
- `rolloverBytes`
- `rolloverRecords`
- `rolloverCompactions`

## Workers

- `workerSlots`
- `workerHeapMiB`
- `workerRssBudgetMiB`
- `workerTimeoutSeconds`
- `workerNiceLevel`
- `optionalModelSlots`

Configuration loading must validate ranges, preserve unknown future keys only through explicit migration, and display effective settings in status.

---

# 27. Documentation deliverables

The repository must eventually contain:

- `docs/chrono-v3/goal-and-work-plan.md`
- `docs/chrono-v3/architecture.md`
- `docs/chrono-v3/data-model.md`
- `docs/chrono-v3/source-catalog.md`
- `docs/chrono-v3/event-capsules.md`
- `docs/chrono-v3/search-and-recall.md`
- `docs/chrono-v3/episodes-and-state.md`
- `docs/chrono-v3/rollups.md`
- `docs/chrono-v3/context-composer.md`
- `docs/chrono-v3/logical-sessions.md`
- `docs/chrono-v3/workers.md`
- `docs/chrono-v3/migration.md`
- `docs/chrono-v3/operations.md`
- `docs/chrono-v3/privacy.md`
- `docs/chrono-v3/testing.md`
- `docs/chrono-v3/deployment.md`
- ADR directory
- changelog entries for each deployed milestone.

Documentation must describe actual behavior, not intended behavior that has not shipped.

---

# 28. Definition of complete project

The project is complete only when all of the following are true:

1. A logical session can span many bounded physical Pi shards.
2. The exact source archive remains intact and directly retrievable.
3. Every event can be recalled in full or in a bounded partial form.
4. Fuzzy search does not parse or index full history on demand.
5. Search and recall operate under fixed memory limits on hundred-million-token histories.
6. Event capsules are generated incrementally.
7. Episodes and current-state views update incrementally.
8. Rollups update only the frontier.
9. Compaction reads a committed snapshot plus bounded delta.
10. The regular Pi summary remains in the composed context.
11. Current restrictions, blockers, failures, and unresolved work meet coverage gates.
12. Context output has no invalid references or unsupported completion claims.
13. Multiple agents can operate concurrently without stale global locks or uncontrolled memory growth.
14. Worker crashes do not crash Pi.
15. Derived-store corruption is repairable without source edits.
16. Migration from current sessions is non-destructive and restartable.
17. Live deployment is traceable to GitHub commit and hashes.
18. Rollback has been exercised.
19. Full tests, fixed-heap tests, fault tests, privacy tests, and release-scale benchmarks pass.
20. Documentation and operational commands are complete.
21. The old full-history paths are retired from large-session operation.
22. The repository remains unpublicized and unpublished unless separately authorized.

---

# 29. Immediate next action

The first execution instruction after adopting this document should be **Milestone M00: Establish evidence and freeze the baseline**.

That instruction must:

- tell the Pi agent to add this document to the repository;
- create the integration branch;
- inspect the live and repository state;
- restore test visibility;
- collect safe baseline evidence;
- push the branch;
- avoid changing live behavior except for read-only diagnostics;
- return the required milestone report.

No architectural implementation should begin until the baseline and deployment relationship are proven.

---

# 30. Final governing principle

ChronoCompact must not reconstruct a lifetime of memory when the agent suddenly needs it.

It must maintain a trustworthy memory structure continuously as events arrive, preserve exact source forever, and compose only the bounded view needed for the current moment.

Every future choice should be judged by that principle.
