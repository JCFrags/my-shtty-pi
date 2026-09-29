---
title: Chrono project and source map
audience: [agents, maintainers]
status: current reference
purpose: Identify implementation owners without reorganizing runtime files or duplicating contracts.
related:
  - system-overview.md
  - ../design/evolution-and-decisions.md
---

# Project and source map

Read the subject guide first. Use this map when a change needs exact implementation details. File names such as `search-v3` or `state-v4` identify subsystem generations. They do not by themselves identify the selected package release or compiler.

## Package boundaries

| Location | Responsibility |
| --- | --- |
| [pi-chrono-compaction](../../../packages/pi-chrono-compaction/README.md) | Compiled Chrono extension, historical stores, workers, compaction, logical sessions, and retained compatibility code. |
| [pi-context-kit](../../../packages/pi-context-kit/README.md) | Six independently loaded Memory, Todo, Notes, Workplan, Recall, and Telemetry extensions. |
| [Context protocol](../../../packages/pi-context-kit/protocol/README.md) | Pure bounded collection and transfer contracts. No Pi entrypoint. Compiled exports also support Chrono. |
| [Owned state store](../../../packages/pi-context-kit/state-store/API.md) | Immutable objects, source-bound anchors, and bounded ancestry resolution. No Pi entrypoint. |
| [Grounded Tools](../../../packages/grounded-tools/README.md) | Shared native reducers/renderers and projectors, process readiness, and coding tools. Current state-provider entrypoints belong to Context Kit. |
| [Project Glance](../../../packages/pi-project-glance/README.md) | Presentation over public provider events. It does not own Todo or Workplan state. |
| [Progressive Tools](../../../packages/pi-progressive-tools/README.md) | Tool catalog, help, and visibility policy. Recall respects that policy. |

Context Kit reuses pure native reducers where sufficient. It does not wrap old extension factories. Keep one writer for each native tool name.

## Chrono modules

All files in this table are under `packages/pi-chrono-compaction/src/`.

| Responsibility | Primary source | Subject guide |
| --- | --- | --- |
| Pi lifecycle, tool registration, menu dispatch, startup selection | [pi-extension.ts](../../../packages/pi-chrono-compaction/src/pi-extension.ts) | [Overview](system-overview.md), [configuration](../operations/menu-and-configuration.md) |
| Persistent settings and validation | [user-config.ts](../../../packages/pi-chrono-compaction/src/user-config.ts) | [Configuration](../operations/menu-and-configuration.md) |
| Current menu report rendering | `chrono-ui.ts` in the unified-menu integration | [Configuration](../operations/menu-and-configuration.md) |
| V4 frozen input, selection, receipt | [context-compiler.ts](../../../packages/pi-chrono-compaction/src/context-compiler.ts) | [Compaction](../context/compaction-and-budgets.md) |
| Request accounting and adaptive tail | [context-budget.ts](../../../packages/pi-chrono-compaction/src/context-budget.ts), [pi-hybrid.ts](../../../packages/pi-chrono-compaction/src/pi-hybrid.ts), [tail-selection.ts](../../../packages/pi-chrono-compaction/src/tail-selection.ts) | [Compaction](../context/compaction-and-budgets.md) |
| Historical rendering, preview, fallback | [context-composer.ts](../../../packages/pi-chrono-compaction/src/context-composer.ts), [composition-preview.ts](../../../packages/pi-chrono-compaction/src/composition-preview.ts), [bounded-memory.ts](../../../packages/pi-chrono-compaction/src/bounded-memory.ts) | [Compaction](../context/compaction-and-budgets.md) |
| Boundary-stable tool-result shortening | [context-projection.ts](../../../packages/pi-chrono-compaction/src/context-projection.ts) | [Retention](../context/retention-and-projections.md) |
| Exact catalog protocol, parser, physical store | [catalog-contract.ts](../../../packages/pi-chrono-compaction/src/catalog-contract.ts), [catalog-engine.ts](../../../packages/pi-chrono-compaction/src/catalog-engine.ts), [catalog-store.ts](../../../packages/pi-chrono-compaction/src/catalog-store.ts), [catalog-parser.ts](../../../packages/pi-chrono-compaction/src/catalog-parser.ts) | [History recovery](../history/indexing-and-exact-recovery.md) |
| SQLite worker-only binding | [catalog-sqlite.ts](../../../packages/pi-chrono-compaction/src/catalog-sqlite.ts) | [Workers](../operations/workers-and-caches.md) |
| Capsules and exact decoded chunks | [capsule-contract.ts](../../../packages/pi-chrono-compaction/src/capsule-contract.ts), [capsule-derive.ts](../../../packages/pi-chrono-compaction/src/capsule-derive.ts), [capsule-store.ts](../../../packages/pi-chrono-compaction/src/capsule-store.ts), [capsule-segment.ts](../../../packages/pi-chrono-compaction/src/capsule-segment.ts) | [Chronology](../history/chronology-episodes-resources.md) |
| Query contract, persisted search, Pi adaptation | [search-v3-contract.ts](../../../packages/pi-chrono-compaction/src/search-v3-contract.ts), [search-v3-store.ts](../../../packages/pi-chrono-compaction/src/search-v3-store.ts), [history-search-adapter.ts](../../../packages/pi-chrono-compaction/src/history-search-adapter.ts), [search-lifecycle.ts](../../../packages/pi-chrono-compaction/src/search-lifecycle.ts) | [History recovery](../history/indexing-and-exact-recovery.md) |
| Episodes, historical state, resources, rollups | [episode-state-contract.ts](../../../packages/pi-chrono-compaction/src/episode-state-contract.ts), [episode-state-reducer.ts](../../../packages/pi-chrono-compaction/src/episode-state-reducer.ts), [episode-state-store.ts](../../../packages/pi-chrono-compaction/src/episode-state-store.ts), [episode-rollup-store.ts](../../../packages/pi-chrono-compaction/src/episode-rollup-store.ts) | [Chronology](../history/chronology-episodes-resources.md) |
| Logical manifest and transitions | [logical-session-contract.ts](../../../packages/pi-chrono-compaction/src/logical-session-contract.ts), [logical-session-store.ts](../../../packages/pi-chrono-compaction/src/logical-session-store.ts), [logical-session-rollover.ts](../../../packages/pi-chrono-compaction/src/logical-session-rollover.ts), [logical-session-integration.ts](../../../packages/pi-chrono-compaction/src/logical-session-integration.ts) | [Logical sessions](../history/logical-sessions.md) |
| Bootstrap persistence, state transfer, routing | [logical-session-persistence.ts](../../../packages/pi-chrono-compaction/src/logical-session-persistence.ts), [logical-session-checkpoints.ts](../../../packages/pi-chrono-compaction/src/logical-session-checkpoints.ts), [logical-session-routing.ts](../../../packages/pi-chrono-compaction/src/logical-session-routing.ts) | [Transfer](../state/persistence-and-transfer.md) |
| Host admission and contained execution | [host-worker-scheduler.ts](../../../packages/pi-chrono-compaction/src/host-worker-scheduler.ts), [worker-runtime.ts](../../../packages/pi-chrono-compaction/src/worker-runtime.ts), [worker-runtime-systemd.ts](../../../packages/pi-chrono-compaction/src/worker-runtime-systemd.ts), [worker-runtime-limits.ts](../../../packages/pi-chrono-compaction/src/worker-runtime-limits.ts) | [Workers](../operations/workers-and-caches.md) |
| Optional value advice | [value-worker.ts](../../../packages/pi-chrono-compaction/src/value-worker.ts), [value-worker-prompt.ts](../../../packages/pi-chrono-compaction/src/value-worker-prompt.ts), [value-advice-store.ts](../../../packages/pi-chrono-compaction/src/value-advice-store.ts), [value-advice-application.ts](../../../packages/pi-chrono-compaction/src/value-advice-application.ts) | [Workers](../operations/workers-and-caches.md) |
| Legacy Memory and compatibility replay/cache | [memory-store.ts](../../../packages/pi-chrono-compaction/src/memory-store.ts), [compactor.ts](../../../packages/pi-chrono-compaction/src/compactor.ts), [candidate-segment-store.ts](../../../packages/pi-chrono-compaction/src/candidate-segment-store.ts), [cache.ts](../../../packages/pi-chrono-compaction/src/cache.ts) | [Evolution](../design/evolution-and-decisions.md) |
| Loaded identity and status projection | [runtime-identity.ts](../../../packages/pi-chrono-compaction/src/runtime-identity.ts), [session-migration.ts](../../../packages/pi-chrono-compaction/src/session-migration.ts) | [Activation](../operations/activation-and-migration.md) |

Chrono's `src/telemetry.ts` supports its own compaction diagnostics. It is not the independent Context Kit Telemetry extension. Older `history-rollup-*` shadow modules are separate from indexed `episode-rollup-store.ts`.

## Context Kit modules

| Owner | Entry and supporting source |
| --- | --- |
| Memory | [src/index.ts](../../../packages/pi-context-kit/memory/src/index.ts), `store.ts`, `operations.ts`, `connector.ts`, `bindings.ts`, `legacy-import.ts`, `reverse-export.ts`. |
| Todo | [index.ts](../../../packages/pi-context-kit/todo/index.ts), provider-local store and import code. |
| Notes | [index.ts](../../../packages/pi-context-kit/notes/index.ts), provider-local store and import code. |
| Workplan | [index.ts](../../../packages/pi-context-kit/workplan/index.ts), per-plan store and import code. |
| Recall | [src/index.ts](../../../packages/pi-context-kit/recall/src/index.ts), with shared collection in protocol `src/collect.ts`. |
| Telemetry | [README and source owner](../../../packages/pi-context-kit/telemetry/README.md). Runtime and quality collection stay separate from history. |
| Protocol | [src/index.ts](../../../packages/pi-context-kit/protocol/src/index.ts), [collect.ts](../../../packages/pi-context-kit/protocol/src/collect.ts), [transfer.ts](../../../packages/pi-context-kit/protocol/src/transfer.ts). |
| State store | [src/owner.ts](../../../packages/pi-context-kit/state-store/src/owner.ts), `objects.ts`, `source.ts`, `ancestry.ts`, `validation.ts`. |

## Build and documentation owners

Chrono uses a package-local lock and compiled `dist/`. Context Kit uses the root workspace lock. The protocol's tracked JavaScript/declarations must match its source build. Chrono's local protocol dependency requires the retained sibling package, not a lone Chrono tarball.

The root [verification workflow](../../../README.md#verification), [release compatibility](../../chrono-release-compatibility.md), `DEPLOYED.sha256`, and `scripts/verify-chrono-v3-baseline.mjs` own build identities. The [activation runbook](../../activation.md) owns loader and rollback procedure. Builds and pins do not prove activation.

This map preserves existing module boundaries. It does not move runtime files for naming or documentation style.

[Architecture index](README.md) · [Documentation index](../README.md)
