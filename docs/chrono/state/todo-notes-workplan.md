---
title: Todo, Notes, and Workplan
audience: [users, agents, maintainers]
status: implemented, selection-dependent
purpose: Explain distinct state responsibilities, native controls, branch visibility, and practical use.
related:
  - memory.md
  - persistence-and-transfer.md
  - ../context/recall.md
---

# Todo, Notes, and Workplan

Use these tools for different kinds of current state. Each Context Kit provider owns its persistence and remains usable without the others, Recall, or Chrono. The tools retain existing native reducers, read interfaces, and applicable Project Glance contracts.

| Tool | Put here | Do not assume |
| --- | --- | --- |
| Todo | Immediate actions, dependencies, external waits, and progress. | Completing a task completes a linked project milestone. |
| Notes | Scratchpad text, investigation notes, and temporary coordination. | Notes are accepted Memory or fresh instructions. |
| Workplan | Goal, scope, constraints, decisions, milestones, evidence, and recovery checkpoints. | A saved plan authorizes new work or synchronizes linked Todo IDs. |

## Todo

Actions are `list`, `add`, `update`, `start`, `done`, `block`, `remove`, `reorder`, `clear_done`, and `replace`.

Dependencies, external waits, and one in-progress task are native state rules. `/todo-add` and supported Glance actions use the same serialized owner transaction as the tool. `/todos` changes presentation, not task state. Display preferences are separate from task revisions.

Admission allows at most 256 retained tasks and 1 MiB complete canonical native state. Task text, descriptions, waits, IDs, and dependency counts have separate bounds. An over-limit mutation or import refuses intact.

A large `list` can return a private complete-state recovery file with bounded display rows. The file is private output, not a transfer checkpoint. A short visible list must not be mistaken for all fields or all state.

[Todo native reference](../../../packages/pi-context-kit/todo/README.md)

## Notes

Actions are `add`, `list`, `read`, `append`, `update`, `search`, `archive`, `remove`, and `clear_archived`. `expectedRevision` supports stale-write refusal.

Notes can retain 256 records, 32 KiB UTF-8 per body, and 1 MiB total bodies. Archived notes count toward those limits. Complete root admission separately allows metadata and escaped text. Invalid or oversized state is refused, not shortened.

Native reads retain exact note fields. Bounded renderers and private full-output recovery are display mechanisms, not the canonical store. Updating or removing a note does not rewrite earlier immutable owned roots.

[Notes native reference](../../../packages/pi-context-kit/notes/README.md)

## Workplan

Workplan preserves a durable project goal and an explicit recovery position. Its main operations include create/list/status/read/recover, revision, milestone management, decisions/risks/questions, checkpoints, pause/resume, completion, and archive.

Use `recover` after compaction or branch restoration when the current goal or next action is unclear. A checkpoint should state current focus and next actions as well as relevant evidence. Do not mark completion only because an agent says it finished.

Native mutation details matter:

- Supply top-level `rationale` for `revise`, `record_decision`, `pause`, `resume`, `complete`, and `archive`.
- `record_decision` uses `content: { decision }`. Its reason belongs in `rationale`.
- Milestone states include `pending`, `in_progress`, `blocked`, and `completed`, not Todo's `done`.
- Start a pending milestone before completing it. Completion requires evidence and completed dependencies.
- Mutation revisions use the native `expectedRevision` contract.

Storage separates a bounded manifest, per-plan immutable objects, and bounded projections. A selected-plan mutation does not load unrelated plan bodies. List/status can use metadata and cached projections. Read/recover loads the selected plan.

Limits include 256 plan references, 64 open plans, one active plan, a 1 MiB manifest, and 64 MiB per complete native plan including revision history. The per-plan context projection is limited to 64 KiB. Work still depends on the admitted selected plan and its collections. This is not constant-cost processing.

A plan may fit native storage but exceed the 8 MiB complete transfer budget. Refuse rollover before switching rather than trimming history.

[Workplan native reference](../../../packages/pi-context-kit/workplan/README.md)

## Branch and persistence behavior

All three providers follow the selected branch. Forked anchors can inherit exact source state. Later writes create separate source-bound commits. A tree move invalidates the selected view before bounded resolution.

A successful native write requires an existing persisted session and verified durable Pi anchor. Ephemeral or deferred sessions do not receive a false durable success. A missing or corrupt root does not become empty state.

Startup resolves direct bindings or a bounded ancestry page. Native calls can advance pending resolution. Context queries only read already-resolved state. They do not replay history, restore it, or start import.

## Migration and integration

Replace only the selected legacy registration. Do not load both legacy and owned writers. Existing legacy branches use `/todo-import`, `/notes-import`, and `/workplan-import` until complete. A new code selection is not a migration.

Fresh rollover replacements can bootstrap complete checkpoints. After new owned writes, rollback to legacy providers also requires a fresh replacement with the latest complete checkpoint before any ordinary legacy state. Reopening the pre-import branch loses later state and is not a valid data rollback.

Glance reads public summary/activity contracts. Recall reads bounded native cards. Neither owns or silently changes provider state.

[State index](README.md) · [Persistence and complete transfer](persistence-and-transfer.md) · [Activation and migration](../operations/activation-and-migration.md)
