---
title: Chrono documentation
audience: [users, agents, maintainers]
status: current reference
purpose: Route readers to the approved compaction baseline, candidate implementation, retained runtime behavior, and revision-bound evidence.
related:
  - compaction-reference/reference.md
  - context/interval-compaction.md
  - USER-GUIDE.md
  - design/evidence-and-roadmap.md
---

# Chrono documentation

Chrono keeps useful chronological context small while preserving routes to original history. Context Kit supplies independent current-state tools. Neither promises perfect recall or unlimited capacity.

Start with the [approved Markdown reference](compaction-reference/reference.md) or its [standalone styled HTML](compaction-reference/reference.html). Status: Approved implementation baseline; implementation in progress. The [interval implementation guide](context/interval-compaction.md) describes source `4.1.5-local.20261010`, with Chrono Pi/AI/TUI development pins at `1.1.0` and peer ranges `>=1.1.0 <1.2.0`. Root tooling and other product pins remain `0.85.1`. The package typecheck, build, and bounded offline Pi 1.1 lifecycle check passed, including saved normal/recovery commits, cancellation, and one continuation per commit. These earlier checks do not verify later repairs or loaded activation. Updates use the current required repository checks and [authorization-before-selection procedure](operations/startup-authorization.md). These are Chrono documents, not official upstream Pi documentation.

For retained runtime behavior, start with the [user guide](USER-GUIDE.md). Agents should read the [system overview](architecture/system-overview.md) and [contracts and trust boundaries](architecture/contracts-and-trust.md), then the relevant subject below. Those routes describe the earlier runtime baseline, not completion of the new design. Check the [implementation and evidence boundary](design/evidence-and-roadmap.md) and actual selected source before describing a feature as installed.

| Subject | Read here |
| --- | --- |
| Approved compaction baseline, implementation in progress | [Markdown](compaction-reference/reference.md) · [Styled HTML](compaction-reference/reference.html) · [Offline maintenance](compaction-reference/README.md) |
| Candidate A/B/C source contract, same-agent exchange, helpers, budgets, and recovery | [Interval implementation](context/interval-compaction.md) |
| Components, ownership, data flow, and source map | [Architecture](architecture/README.md) |
| Exact history, indexes, episodes, resources, and physical sessions | [History](history/README.md) |
| Compaction, budgets, retention, and current-state Recall | [Context](context/README.md) |
| Memory, Todo, Notes, Workplan, persistence, and complete transfer | [State](state/README.md) |
| `/Chrono`, configuration, workers, caches, Telemetry, migration, and rollback | [Operations](operations/README.md) |
| Why the architecture changed, evidence, limitations, and future choices | [Design](design/README.md) |

## How to read the older material

The approved compaction reference is the starting point. The interval guide follows candidate source. The other subject routes retain the earlier runtime baseline. [V3 records](../chrono-v3/README.md) and [V4 records](../chrono-v4/README.md) retain design decisions, exact low-level contracts, and dated evidence. Their milestone plans, old defaults, and old command lists are not current operating instructions. A linked historical pass applies only to its recorded revision.

Chrono uses one `/Chrono` menu, not the older collection of `/chrono-*` commands. The candidate's V4 settings show automatic policy and explicit history roles. All roles start unselected. Legacy tuners remain for older paths and rollback, not interval-policy control. State ownership and compiler selection remain separate. Source implementation, selected settings, loaded code, and exercised behavior are separate facts.

[Repository](../../README.md) · [Chrono package](../../packages/pi-chrono-compaction/README.md) · [Context Kit packages](../../packages/pi-context-kit/README.md)
