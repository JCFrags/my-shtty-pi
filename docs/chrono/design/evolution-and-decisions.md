---
title: Architectural evolution and decisions
audience: [agents, maintainers]
status: current rationale with historical links
purpose: Explain why the system changed and which earlier assumptions no longer apply.
related:
  - evidence-and-roadmap.md
  - ../architecture/system-overview.md
  - ../../chrono-v3/README.md
  - ../../chrono-v4/README.md
---

# Architectural evolution and decisions

## The durable goal

The goal is useful chronological recall during both short and very long tasks, while keeping active context and individual operations bounded. Exact source should remain recoverable when selected detail leaves the prompt.

This goal does not require a verbatim in-context inventory of every historical obligation. It also does not justify perfect-memory, infinite-capacity, or unmeasured speed claims. Practical agent behavior matters more than a small prompt alone.

## How the architecture changed

| Stage | Problem addressed | What changed and why |
| --- | --- | --- |
| Earlier replay and editable Memory | Repeated large histories and routine tool output consumed context. | Deterministic reducers, candidate alternatives, retention bands, source recovery, and an append-only Memory sidecar gave older events smaller forms. Compatibility modules remain available. |
| Segmented derivation and worker containment | Whole-session parsing, lifetime maps, and in-process allocation could grow with history. | Work moved toward incremental source cuts, immutable segments, bounded admission, and contained workers. A query no longer needs to construct a lifetime index. |
| Indexed chronological memory | Compact cues alone can miss exact wording or sequence. | Separate catalog, decoded chunks, lexical indexes, episodes, state, and rollups provide different fidelity/cost levels with exact recovery routes. |
| Logical sessions | Incremental Chrono indexes do not make Pi's active physical file smaller. | Preserved shards and safe-idle replacement limit future active-file growth without rewriting old source. Complete native checkpoints preserve tool state. |
| Default-on V3 | Earlier designs required a regular summary model and complete mandatory historical coverage. | The programmatic path became default. A small adaptive tail and disclosed selective history replaced the global verbatim inventory gate. An optional summary is no longer a prerequisite. |
| V3 patch corrections | Refusal/resume behavior, branch targeting, raw recovery readiness, and rollover startup could block useful use. | Narrow fixes preserve context on failure, defer search retargeting during compaction, allow catalog-only raw recovery, and recheck one eligible cached startup refusal. Read-only diagnostics do not repair admission. |
| Unified 3.0.5 interface | Many slash commands and turn-by-turn projection reselection made behavior harder to operate and reason about. | One `/Chrono` menu, background presets/model picker, report pages, and frozen projection text between compactions. The local scroll correction gives fullscreen report keys a focused overlay. |
| V4 independent owners and compiler | Current tool state was coupled to older storage or summaries, and total request accounting was incomplete. | Separate Memory/Todo/Notes/Workplan ownership, bounded native connectors, shared Recall collection, durable anchors, complete transfer, and deterministic receipt-based compaction. |

The local integration combines V4 with the current menu and projection behavior. It does not make every version-4-named subsystem new, nor turn retained compatibility code into the selected path. See [evidence](evidence-and-roadmap.md).

## Decisions that connect the components

### Preserve exact source, derive useful views

Catalogs and compact representations can be incomplete, stale to a compatible cut, or rebuildable. Original source retains exact evidence. Rewriting a transcript to make it smaller would destroy that boundary and complicate older handles and rollback.

Cost: more files and explicit routing. Recovery must validate source, branch, and store identity rather than guess by path.

Historical owners: [catalog binding](../../chrono-v3/adr/ADR-002-sqlite-catalog.md), [immutable publication](../../chrono-v3/adr/ADR-003-immutable-segments-and-manifest-publication.md).

### Separate layers and state owners

The source catalog locates records. Capsules encode alternatives. Search discovers. Historical state interprets supported source patterns. Native providers own current explicit state. Recall and compaction consume their bounded public records.

A shared database or large extension would couple startup, failures, migration, and resource scheduling. Shared pure contracts instead permit independent providers while keeping consistent validation.

Cost: there is no distributed transaction across providers. Receipts retain exact captured revisions and disclose that limit. A failed provider must not erase healthy peers.

Historical owners: [V4 design](../../chrono-v4/README.md), [completion scope](../../chrono-v4/completion-scope.md).

### Use lexical discovery with staged recovery

Cue search is useful but lossy. Raw lexical indexing retains a route to exact wording. Bounded candidate windows and explicit continuation avoid an unbounded query or full-memory postings map.

Embeddings and a second all-history graph would add another maintained identity and resource path. They remain future choices, not hidden capabilities. The current cost is possible lexical misses and ranking within a page rather than globally.

Historical owner: [cue and lexical index decision](../../chrono-v3/adr/ADR-006-cue-index-and-raw-lexical-locator.md).

### Keep code required and model assistance optional

Required ingestion, selection, fitting, and recovery use code. Optional model advice has restricted inputs, typed output, cost controls, and no authority over source or final context. A provider outage must not disable deterministic memory.

The current value worker remains a compatibility subsystem paused under the normal memory engine. Its presets do not enrich V4. Future indexed assistance needs its own bounded integration and evidence.

The older ADR's claim that a regular summary is required is superseded. See [current budgets](../context/compaction-and-budgets.md), [the historical advice boundary](../../chrono-v3/adr/ADR-013-optional-model-advice-boundary.md), and [value-worker detail](../../../packages/pi-chrono-compaction/docs/value-worker.md).

### Fit the whole request and keep a small exact tail

Large Pi default tails can consume most of a useful compaction budget. Chrono uses an adaptive tool-safe tail. V4 accounts for system text, active schemas, message framing, summary, raw tail, and response reserve, then validates the rendered result.

The estimate is explicit rather than advertised as an exact tokenizer result. Whole admitted records and recoverable omissions preserve conditions better than arbitrary string clipping.

Historical owner: [budget decision](../../chrono-v3/adr/ADR-010-context-budgets-and-validation.md).

### Freeze request-local projections

Changing earlier tool text on every turn creates avoidable prefix changes. Select shortening at compaction boundaries and reuse the exact snapshot afterward. Keep new results exact and preserve authoritative source bindings.

Cost: some shortening waits until another boundary. Stable prefixes are not a guarantee of cache hits, lower bills, or better answers.

Current owner: [retention and projections](../context/retention-and-projections.md).

### Separate discovery cards from complete transfer

Small context cards are useful precisely because they omit detail. They are therefore unsuitable as a backup or rollover checkpoint. Native transfer must capture the full state or refuse. Memory's same-store binding avoids copying a database but requires retaining that database.

Cost: a state object that fits its native store can exceed replacement limits. The safe result is a refused rollover, not silent data loss.

Current owner: [persistence and transfer](../state/persistence-and-transfer.md).

### Verify anchors before exposing state

An in-memory append or `message_end` event is too early to claim durable persistence. Providers publish owned data, verify the actual Pi anchor on disk, and expose state only afterward. Uncertain operations remain reconcilable.

Cost: persistence checks and explicit refusal in ephemeral sessions. The benefit is an honest success boundary and a source-linked return path.

Current owner: [state-store API](../../../packages/pi-context-kit/state-store/API.md).

### Separate runtime observation from quality evidence

Latency, token use, tool success, and compaction counts describe execution. They do not prove correct recall or good agent action. Quality needs an explicit source-known case or separately labeled self-report.

Cost: quality remains unknown without observations. This is preferable to invented performance or accuracy claims.

Current owner: [Telemetry](../operations/telemetry.md).

## Superseded assumptions

Read old records at their recorded revision. In particular:

- Disabled-default V3, manual-only rollover, a required Pi summary, and a universal 30,000-token ceiling describe earlier designs.
- A ready index is not proof that a later cut fits or that every obligation was understood.
- Older unbounded candidate refusal descriptions do not replace the current bounded search continuation behavior.
- Older 14-command registration tables are not the unified menu.
- An old scale or acceptance plan is not a requirement to repeat a campaign for every change.
- Earlier success does not establish a later build's loaded activation or data migration.

The historical [V3 decision map](../../chrono-v3/README.md#architecture-decision-map), milestone ledger, and reports remain preserved. Current subject pages link to those exact protocol and evidence owners without moving runtime modules or creating duplicate schemas.

[Design index](README.md) · [Evidence and future choices](evidence-and-roadmap.md) · [Source map](../architecture/source-map.md)
