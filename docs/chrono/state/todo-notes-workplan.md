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

These providers form the Chrono context-state stack. Progressive Tools controls catalog visibility and schema exposure, not their implementation or persistence. Chrono consumes provider evidence and requests complete rollover checkpoints. It does not own their stores.

| Tool | Put here | Do not assume |
| --- | --- | --- |
| Todo | Immediate actions, dependencies, external waits, and progress. | Completing a task completes a linked project milestone. |
| Notes | Scratchpad text, investigation notes, and temporary coordination. | Notes are accepted Memory or fresh instructions. |
| Workplan | Goal, scope, constraints, decisions, milestones, evidence, and recovery checkpoints. | A saved plan authorizes new work or synchronizes linked Todo IDs. |

## Todo

Actions are `list`, `add`, `update`, `start`, `done`, `block`, `remove`, `reorder`, `clear_done`, and `replace`.

Dependencies, external waits, and one in-progress task are native state rules. `/todo-add` and supported Glance actions use the same serialized owner transaction as the tool. `/todos` changes presentation, not task state. Display preferences are separate from task revisions.

Admission allows at most 256 retained tasks and 1 MiB complete canonical native state. Task text, descriptions, waits, IDs, and dependency counts have separate bounds. An over-limit mutation or import refuses intact.

`list` defaults to `view:"current"`. It hides done tasks without deleting their IDs or satisfied dependency edges. Use `view:"all"` to read complete retained native state. `clear_done` and `remove` remain explicit mutations. Revise current tasks when direction changes instead of keeping an append-only log.

A large `list` can return a private file for the selected view with bounded display rows. Only the all-view file is complete native state. The file is private output, not a transfer checkpoint. A short visible list must not be mistaken for all fields or all state.

[Todo native reference](../../../packages/pi-context-kit/todo/README.md)

## Notes

Actions are `add`, `list`, `read`, `append`, `update`, `search`, `archive`, `remove`, and `clear_archived`. `expectedRevision` supports stale-write refusal.

Notes can retain 256 records, 32 KiB UTF-8 per body, and 1 MiB total bodies. Archived notes count toward those limits. Complete root admission separately allows metadata and escaped text. Invalid or oversized state is refused, not shortened.

Native reads retain exact note fields. Bounded renderers and private full-output recovery are display mechanisms, not the canonical store. Update scratchpad text when facts or direction change. Archive inactive notes. Updating or removing a note does not rewrite earlier immutable owned roots.

[Notes native reference](../../../packages/pi-context-kit/notes/README.md)

## Workplan

Workplan preserves a durable project goal and an explicit recovery position. Its main operations include create/list/status/read/recover, revision, milestone management, decisions/risks/questions, checkpoints, pause/resume, completion, archive, and restore.

Use `recover` after compaction or branch restoration when the current goal or next action is unclear. A checkpoint should state current focus and next actions as well as relevant evidence. Do not mark completion only because an agent says it finished.

Native mutation details matter:

- Supply top-level `rationale` for `revise`, `record_decision`, `pause`, `resume`, `complete`, `archive`, and `restore`.
- `record_decision` uses `content: { decision }`. Its reason belongs in `rationale`.
- Milestone states include `pending`, `in_progress`, `blocked`, and `completed`, not Todo's `done`.
- Start a pending milestone before completing it. Completion requires evidence and completed dependencies.
- Except for untargeted `create` and `list`, omitted `planId` selects the active plan. If no plan is active, supply an ID. No plan is activated implicitly.
- Omitted `expectedRevision` uses the selected plan's latest saved revision under serialization. An explicit stale revision still fails. Scope and commit conflicts remain enforced.

Pause and archive preserve unfinished plans without completing their milestones. `restore` returns an archive to its prior `draft`, `paused`, or `completed` status, not `active`. It preserves contents and archived edits. Recover its saved context and approval gates before a separate permitted `resume`. A completed plan is not reopened by restore. Default Recall still browses open plans with the active plan first; native list/read/recover can access archives.

Revise plan sections when direction changes. The latest checkpoint replaces the saved current position and next actions. Earlier checkpoints and revisions remain history. Recovery labels the last saved revision and time. `recovery=saved` means a visible recovery matches that saved revision, not that unsaved work is current.

Recovery retains checkpoint focus/actions as saved guidance after lifecycle-only changes. After content changes, it shows current milestone guidance plus bounded, possibly stale checkpoint guidance. The last four post-checkpoint lifecycle rationales retain their revisions. Omitted earlier history may contain unresolved waits. Read the complete plan when needed; a later archive/restore does not resolve an earlier condition or grant new permission.

At a meaningful task or direction change:

1. Recover missing project facts through permitted native reads. Pending state is not empty state.
2. Keep purpose, useful exact code locations, approach, and reasons in the plan. Save a checkpoint with actual results, current focus, next actions, unresolved work, external waits, and approval gates.
3. If leaving the project, pause it. Archive only when the intent is to remove it from current-work views. Keep its ID and recovery route.
4. After the writes settle, use an available, permitted `request_compaction({})` when substantial earlier detail is no longer useful. Do not trigger it for every ordinary milestone, checkpoint, or temporary wait. If unavailable, retain the checkpoint and report the limit.
5. Follow the sole-summary-submission exchange. Compaction does not authorize a next task or cross an approval gate.

Before the first `restore` write, account for reader compatibility. Old reducers reject its immutable revision record even in a complete V1 checkpoint. Keep a restore-compatible native reader afterward. A pre-restore branch omits later writes and is not a data-preserving rollback.

Storage separates a bounded manifest, per-plan immutable objects, and bounded projections. A selected-plan mutation does not load unrelated plan bodies. List/status can use metadata and cached projections. Read/recover loads the selected plan.

Limits include 256 plan references, 64 open plans, one active plan, a 1 MiB manifest, and 64 MiB per complete native plan including revision history. The per-plan context projection is limited to 64 KiB. Work still depends on the admitted selected plan and its collections. This is not constant-cost processing.

A plan may fit native storage but exceed the 8 MiB complete transfer budget. Refuse rollover before switching rather than trimming history.

[Workplan native reference](../../../packages/pi-context-kit/workplan/README.md)

## Branch and persistence behavior

All three providers follow the selected branch. Forked anchors can inherit exact source state. Later writes create separate source-bound commits. A tree move invalidates the selected view before bounded resolution.

A successful native write requires an existing persisted session and verified durable Pi anchor. Ephemeral or deferred sessions do not receive a false durable success. A missing or corrupt root does not become empty state.

Startup resolves direct bindings or a bounded ancestry page. Native calls resolve routine pending pages internally, with cancellation, at most 32 pages, and a two-second deadline. A timeout retains progress. Legacy import and source-identity recovery remain explicit. Todo and Notes context queries read already-selected state. Workplan context queries can advance bounded resolution and write derived indexes or receipts. These queries do not import or mutate canonical state, but Workplan's query is not a filesystem-read-only diagnostic.

## Migration and integration

Context Kit supplies the only supported current Todo, Notes, and Workplan registrations. If a retained older installation selects a Grounded writer, replace only that registration with its Context Kit provider. Do not load both legacy and owned writers. Existing legacy branches use `/todo-import`, `/notes-import`, and `/workplan-import` until complete. A new code selection is not a migration.

Fresh rollover replacements can bootstrap complete checkpoints. After new owned writes, rollback to legacy providers also requires a fresh replacement with the latest complete checkpoint before any ordinary legacy state. Reopening the pre-import branch loses later state and is not a valid data rollback.

Glance reads public summary/activity contracts. Recall reads bounded native cards. Neither owns or silently changes provider state.

[State index](README.md) · [Persistence and complete transfer](persistence-and-transfer.md) · [Activation and migration](../operations/activation-and-migration.md)
