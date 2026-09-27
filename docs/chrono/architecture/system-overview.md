---
title: Chrono system overview
audience: [agents, maintainers]
status: current reference
purpose: Explain the complete system, its data flow, and component ownership without requiring source reading.
related:
  - contracts-and-trust.md
  - source-map.md
  - ../design/evolution-and-decisions.md
---

# System overview

ChronoCompact is a Pi extension that selects chronological context and supplies historical recovery tools. Context Kit is a group of separately loadable state, Recall, and Telemetry extensions. They cooperate through public contracts. They are not one database or a mandatory all-in-one package.

The goal is useful incomplete working context with recoverable evidence and finite per-operation resource use. Original history can grow on disk. The system does not promise infinite storage, perfect extraction, or constant total cost.

## Data flow

```text
Pi session source, with tree ancestry
  -> catalog of exact identities, cuts, hashes, and coordinates
  -> event capsules and exact decoded chunks
  -> lexical search indexes
  -> episodes, source-backed state, and resource observations
  -> closed-episode rollups
  -> bounded V3 historical selection and exact recovery

Memory       Todo       Notes       Workplan
  each owns its state and persistence
  -> bounded native context connectors
  -> shared collector
       -> context_recall result
       -> V4 receipt evidence, not a rendered state-card dump

same-session agent summary + compressed chronological replay + necessary exact tail
  -> V4 context compiler
  -> Pi compaction entry and recovery receipt
  -> model's next working context

Pi lifecycle events -> independent local Telemetry
```

Arrows describe data use, not automatic state promotion. Recall does not write Memory. The compiler does not complete tasks. Telemetry does not score a task from its runtime events.

## Ownership

| Component | Canonical responsibility | Derived output or consumer |
| --- | --- | --- |
| Pi | Conversation entries, selected branch, public lifecycle, model request execution. | Chrono uses public hooks and SessionManager interfaces. |
| Chrono history | Validated routes from an exact source cut to original records. | Catalog, capsule, search, state, and rollup stores each own their progress. |
| Logical-session manifest | Branch ancestry, physical shard routes, transition state. | Search and rollover use validated bindings. This is not a disposable cache. |
| Independent Memory | Accepted ordinary knowledge, proposals, revisions, validity, provenance. | Native tools and V2 context cards. |
| Context Kit Todo | Immediate task state and dependencies. | Native tools, Glance events, current-state cards. |
| Context Kit Notes | Explicit branch-local scratchpad state. | Native tools and current-state cards. |
| Context Kit Workplan | Goals, constraints, decisions, milestones, evidence, and checkpoints. | Native recovery, Glance events, current-state cards. |
| Context Kit protocol | Bounded messages, validation, collection, and complete transfer transport. | No provider store or extension entrypoint. |
| Recall | One bounded view over active native providers. | No historical ingestion, mutation, or hidden tool activation. |
| Context compiler | Selection and rendering at a frozen input boundary. | A derived context and receipt, not canonical knowledge. |
| Telemetry | Content-free runtime observations and separate caller-reported quality. | Local bounded counters and best-effort records. |

Memory's logical namespace survives tree moves within that namespace. Todo, Notes, and Workplan follow the selected branch. Neither model implies a global cross-project state store. These independent providers form the Chrono context-state stack. Chrono consumes their evidence and requests complete transfer. Each provider owns its persistence. Grounded Tools retains legacy compatibility providers. Do not load both writers for one native tool.

## The normal lifecycle

1. On startup, Chrono resolves settings and exact session exclusions. Eligible persisted sessions can adopt their source as logical shard zero.
2. The worker startup check validates the existing admission and containment arrangement. Unavailable startup does not authorize uncontained work or automatic repair.
3. Lifecycle scheduling advances each derived store through bounded jobs. Search and status do not construct indexes inside a query.
4. Agents explicitly mutate native state through its owning tools. Providers publish durable state before exposing a successful write.
5. Pi requests compaction through `session_before_compact`. Chrono selects the configured compiler, validates the current view, and returns a custom compaction or refuses safely.
6. Pi commits the compaction. V4 correlates the terminal event with the pending receipt rather than treating a proposed result as a committed one.
7. At a later safe idle boundary, physical rollover may create a smaller active shard after complete native transfer.

Historical derivation is deterministic. Optional model failure does not block that processing. Compatibility value advice is separate from the current V4 compiler, which requires the session agent's continuation summary. V3 can use an optional regular Pi summary. See [workers](../operations/workers-and-caches.md) and the [session-agent compaction contract](../context/session-agent-compaction.md).

## Three context paths

- **Compatibility replay:** retained older candidate/reducer machinery, its own caches and limits, and the optional value-advice worker. It is not the default V3 memory path.
- **V3 memory engine:** bounded historical selection and an adaptive raw tail. Missing optional indexed detail can use a disclosed bounded loaded-prefix fallback. An independent regular Pi summary is optional.
- **V4 compiler:** explicitly selected with `contextCompiler: "v4"`. It requires a summary from the same session agent, then fits compressed chronological replay and the necessary exact tail. Native cards remain evidence in the persisted receipt, not a second rendered state dump. Complete request charges remain estimates.

The package version, compiler selection, and Memory owner are independent facts. `memoryOwner: "context-kit"` is captured at factory load. Changing its JSON value does not stop an already-loaded legacy writer. See [activation and migration](../operations/activation-and-migration.md).

## What is automatic and what is not

| Automatic when enabled and eligible | Explicit action or selection |
| --- | --- |
| Incremental derivation after lifecycle changes. | Search, Recall, exact retrieval, and native state edits. |
| Pi pressure-triggered compaction. | Proactive Chrono threshold or a manual compaction request. |
| Safe-idle rollover after source-growth threshold. | Manual logical fork, recovery, rollback, and repair. |
| Local Telemetry collection while loaded. | Quality observations from a caller with a declared evidence basis. |
| Reuse of compatible derived data. | State-provider import, Memory ownership handoff, and reverse export. |

Missing optional cards can reduce useful context. Missing complete transfer state instead blocks replacement. The first is a selection problem. The second risks losing canonical state and therefore has a stricter contract.

## Adjacent integrations

Progressive Tools controls catalog visibility and schema exposure. It does not implement Todo, Notes, or Workplan and does not own their stores. Recall respects the active-tool set. Project Glance reads public Todo/Workplan contracts without owning their stores. Grounded Process readiness can block physical replacement while managed jobs or shells remain open. These integrations do not require a central mutable state service.

The private cache trace is a separate local diagnostic, not a bundled product, a Memory provider, or quality evidence. Repository documentation does not include private trace paths or records.

[Architecture index](README.md) · [Contracts](contracts-and-trust.md) · [Source map](source-map.md)
