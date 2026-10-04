---
title: Owned Todo native reference
audience: [agents, maintainers, operators]
status: implemented, selection-dependent
purpose: Specify native Todo behavior, persistence, import, and complete transfer.
related:
  - ../../../docs/chrono/state/todo-notes-workplan.md
  - ../README.md
---

# Owned Todo

Read the [state-tools guide](../../../docs/chrono/state/todo-notes-workplan.md) for component roles and [activation and migration](../../../docs/chrono/operations/activation-and-migration.md) for the coordinated writer/import sequence.

`@context-kit/todo` is a separately loadable Pi extension. It owns Todo persistence and branch recovery. It uses the validated Grounded task operations, not the legacy extension factory. It does not require Notes, Memory, Workplan, Recall, or Chrono.

## Native interface

The `todo` tool supports `list`, `read`, `add`, `update`, `start`, `done`, `block`, `remove`, `reorder`, `clear_done`, and `replace`. Dependencies, external waits, and the single in-progress task rule use the native reducers. Existing source timestamps are not converted into owner revisions.

`read` requires `id` and accepts no other action fields. It returns the exact retained task as JSON in model-facing text and `details.task`. This includes `description` and `waitReason` when present, status, dependency IDs, and numeric `createdAt`/`updatedAt` timestamps in Unix milliseconds. Done tasks remain readable by ID. A read does not create an owner commit or change timestamps. It reads the selected branch's current record, not an earlier revision.

Generated IDs use a high-water counter. `replace`, including an empty replacement, does not reset it. Explicit IDs supplied to `add` or replacement rows remain unchanged. IDs must be nonempty, unique strings within the limits below. Supplied `T<number>` IDs raise the counter. A replacement reserves all supplied IDs before it generates missing IDs, so a later explicit row cannot collide with an earlier generated row. Retain an ID for the same task. Use a new explicit ID or omit the ID for a new task.

Starting a task returns any other in-progress task to pending. Completing a dependency can release blocked tasks to pending. Updating blockers or waits can change the target's status. Replacement rows default to pending when status is omitted, then receive dependency/wait normalization. Reports include implicit status changes to retained tasks and normalized supplied statuses. Mutation text and `details.statusChanges` report these automatic transitions with IDs and old/new statuses. The changed tasks receive the same operation timestamp, including tasks changed indirectly. Replacement preserves a retained task's `createdAt` and preserves `updatedAt` when its fields are unchanged. More than one requested in-progress task or a blocked requested start is refused intact.

Todo is current actionable work, not an append-only log. Revise and reorder tasks when direction changes. `list` defaults to `view:"current"`, which hides done tasks without removing their IDs or satisfied dependency edges. Model-facing list rows are compact summaries, not exact task fields. Use `read` for those fields. `view:"all"` includes the complete retained task set.

For a long-lived agent, preserve unfinished obligations and recovery in a paused Workplan or an archived Note before an approved goal transition. Keep continuing tasks under their existing IDs. Mark only completed work done. Done tasks leave the current view without deletion. `remove`, `clear_done`, and rows omitted from `replace` leave the retained set. They are explicit removals, not an archive or undo system. Earlier immutable roots remain historical evidence, but native `read` cannot read a task removed from the current branch.

`/todo-add` and the native tool use one serialized owner transaction. Glance reads Todo summaries and does not perform task actions. `/todos [full|compact|plan]`, its scrolling view, and `ctrl+shift+u` retain the existing display behavior. Display preferences remain global in `grounded-tasks.json` under Pi's agent directory. They do not modify task state or task revisions.

Admission limits apply before commit or import:

| Limit | Maximum |
| --- | --- |
| Retained tasks | 256 |
| Complete canonical native state | 1 MiB |
| Task text | 4 KiB UTF-8 |
| Description | 8 KiB UTF-8 |
| Wait reason | 4 KiB UTF-8 |
| ID or dependency ID | 128 bytes UTF-8 |
| Dependencies per task | 64 |
| Complete tool result | 32 KiB |

Over-limit state is refused intact. State is never shortened. Retained done tasks count toward the 256-task and state-byte limits. Mutation results contain a small owner identity, automatic transitions, and bounded display rows, not the full store. If the complete mutation result is too large, a private `result.json` preserves its message and transitions, and `details.omittedStatusChanges` reports the omitted count.

The default current list returns visible tasks in `details.tasks`, plus `view` and `retainedDone`. It is not complete native state. `list` with `view:"all"` returns complete native state in `details.state` when the result fits. Otherwise either view supplies a private `state.json` file for that selected view and whole summary rows that fit. Only the all-view file is complete native state, including descriptions, IDs, counters, dependencies, and timestamps.

If a complete `read` result exceeds 32 KiB, `details.task` is omitted and `details.fullOutputPath` points to a private `task.json` with every exact selected-task field. The model-facing notice gives the same path. Read that file with the file reader rather than treat the notice as the task body. Each full-output file has mode `0600` in a task-specific private directory. These files are output recovery, not persistent task identity or transfer checkpoints. Complete transfer always uses the unfiltered store. Display clipping is not a transfer mechanism.

## Persistence and lifecycle

The default private root is `$XDG_STATE_HOME/pi-context-kit/todo`, or `~/.local/state/pi-context-kit/todo`. `TodoOptions.storeRoot` selects an exact private fixture directory. Each extension instance owns its own backend and operation queue.

The owner publishes immutable root objects and a prepared receipt before appending a small Pi custom anchor. It verifies the exact live anchor, verifies its on-disk append, syncs the session file, and publishes a durable binding before reporting success. `message_end` is not a durability acknowledgment and has no persistence handler here.

An ephemeral session or a deferred session file refuses mutations with `state-store-unpersisted`. This includes `/todo-add` before Pi has persisted a new session. No volatile success is enabled. An unbound object is an orphan, not visible state. An uncertain append remains pending until the backend reconciles the exact operation. Missing or corrupt objects are not replaced with empty state.

Session start and tree navigation use direct bindings or one bounded ancestry-resolution page. They never call `getBranch()` or replay all history. Native tools resolve routine pending pages internally, with cancellation, at most 32 pages, and a two-second deadline. A timeout retains saved progress rather than resetting state or requesting migration. `agent_settled` can resolve one further page. Context queries read only an already resolved state and never restore it. Forked anchors retain their original provenance and new writes create a new source-bound commit.

An already owned branch that reports `state-store-source-recovery-required` needs the [state-store identity recovery procedure](../state-store/API.md#explicit-recovery-of-old-disk-commits), not `/todo-import`. It requires an independently established complete source-prefix hash. New Linux Btrfs commits have reboot-stable identity checks. Unsupported filesystems keep strict device checks. Recovery preserves old immutable state and does not make previous code versions compatible with new commits.

## Legacy import

Disable the old Todo writer before selecting this extension. Run `/todo-import` on an unimported legacy branch. Each invocation collects or replays at most 128 whole source entries within an 8 MiB page budget. Repeat while the command reports pending. There is no lifetime entry-count cap or hidden startup import loop.

Each step stores an immutable cursor object and a small exact-session/leaf progress pointer. Imports resume after restart. A linked list retains complete detached source entries and old snapshots. The receipt names the source file, source session/leaf, coverage, and `normalized-native-entry-pages/v1` digest chain. These are normalized native entries, not copies of original JSONL line bytes. The original JSONL remains unchanged. Repeating import on an owned branch does not reapply events or create another commit.

An oversized entry, invalid reducer state, changed source cut, or corrupt progress refuses the step. Prior progress and original source remain available. No failed import authorizes an empty state.

## Complete transfer and rollback

The async V2 transfer provider returns a complete `grounded-state-checkpoint-v1` and a separate `context-kit:owner-binding:v1`. It does not register the old synchronous checkpoint listener. Pending or corrupt state refuses transfer. The shared transport applies the complete 8 MiB provider budget.

A fresh checkpoint-only bootstrap is recognized within 32 native ancestry entries, only after reaching the root. It requires one Todo checkpoint, no ordinary Todo events, and at most one matching owner binding. The native state is authoritative. Metadata must match its digest and every task ID. Owner and task revision counters are preserved independently of native timestamps. Missing or mismatched metadata is not silently accepted when a binding exists. The bootstrap commits through the same durable owner and retains its source receipt.

For rollback after new writes, export the current complete native checkpoint into a fresh replacement session before selecting the legacy writer. Do not return to a stale pre-import session or append a checkpoint after old Todo state. Keep the owned objects and original sessions.

`TodoStore.captureNative()`, `ownerMetadata()`, `checkpoint()`, and `restoreNative()` expose native integration boundaries. `restoreNative()` is for a proven empty replacement, not replacement of unimported history. Current-state Context cards use owner commit/task revision identities and retain native read-only recovery routes. Glance and Context failures do not change a committed state.

## Verification boundary

Private synthetic checks exercise persisted sessions and registered callbacks. Installed-provider selection, complete multi-provider rollover, and legacy rollback are integration checks owned by the parent delivery workflow. This package does not claim those checks from a build alone.

For a fixture outside the workspace, load Pi's ES module entry from the selected checkout. Pi 0.85.1 exposes an import-only root. `createRequire().resolve("@earendil-works/pi-coding-agent")` fails before a fixture starts because that export has no CommonJS resolution condition.
