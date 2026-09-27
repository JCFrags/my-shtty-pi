---
title: Chrono documentation
audience: [users, agents, maintainers]
status: current reference
purpose: Route readers to current behavior, operating procedures, and revision-bound evidence.
related:
  - USER-GUIDE.md
  - design/evidence-and-roadmap.md
---

# Chrono documentation

Chrono keeps useful chronological context small while preserving routes to original history. Context Kit supplies independent current-state tools. Neither promises perfect recall or unlimited capacity.

Start with the [user guide](USER-GUIDE.md) for a non-technical explanation. Agents should read the [system overview](architecture/system-overview.md) and [contracts and trust boundaries](architecture/contracts-and-trust.md), then the relevant subject below. Check the [implementation and evidence boundary](design/evidence-and-roadmap.md) before describing a feature as installed.

| Subject | Read here |
| --- | --- |
| Components, ownership, data flow, and source map | [Architecture](architecture/README.md) |
| Exact history, indexes, episodes, resources, and physical sessions | [History](history/README.md) |
| Compaction, budgets, retention, and current-state Recall | [Context](context/README.md) |
| Memory, Todo, Notes, Workplan, persistence, and complete transfer | [State](state/README.md) |
| `/Chrono`, configuration, workers, caches, Telemetry, migration, and rollback | [Operations](operations/README.md) |
| Why the architecture changed, evidence, limitations, and future choices | [Design](design/README.md) |

## How to read the older material

This hierarchy is the current subject guide. [V3 records](../chrono-v3/README.md) and [V4 records](../chrono-v4/README.md) retain design decisions, exact low-level contracts, and dated evidence. Their milestone plans, old defaults, and old command lists are not current operating instructions. A linked historical pass applies only to its recorded revision.

Current Chrono uses one `/Chrono` menu, not the older collection of `/chrono-*` commands. V4 state ownership and compiler selection are separate from the menu. Source implementation, selected settings, loaded code, and exercised behavior are separate facts.

[Repository](../../README.md) · [Chrono package](../../packages/pi-chrono-compaction/README.md) · [Context Kit packages](../../packages/pi-context-kit/README.md)
