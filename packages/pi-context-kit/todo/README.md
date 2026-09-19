# Owned Todo

`@context-kit/todo` is a separately loadable Pi extension. It owns Todo persistence and branch recovery. It uses the validated Grounded task operations, not the legacy extension factory. It does not require Notes, Memory, Workplan, Recall, or Chrono.

## Native interface

The `todo` tool retains `list`, `add`, `update`, `start`, `done`, `block`, `remove`, `reorder`, `clear_done`, and `replace`. Dependencies, external waits, and the single in-progress task rule use the native reducers. `replace` retains the native ID-counter reset behavior. Existing source timestamps are not converted into owner revisions.

`/todo-add`, the native tool, and Glance `start`, `done`, and `clear_wait` all use one serialized owner transaction. `/todos [full|compact|plan]`, its scrolling view, and `ctrl+shift+u` retain the existing display behavior. Display preferences remain global in `grounded-tasks.json` under Pi's agent directory. They do not modify task state or task revisions.

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

Over-limit state is refused intact. State is never shortened. Mutation results contain a small owner identity and bounded display rows, not the full store. `list` returns complete native state in `details.state` when the complete result fits. Otherwise it supplies a private `state.json` recovery file and whole display rows that fit. The file includes descriptions, IDs, counters, dependencies, and timestamps. Display clipping is not a transfer mechanism.

## Persistence and lifecycle

The default private root is `$XDG_STATE_HOME/pi-context-kit/todo`, or `~/.local/state/pi-context-kit/todo`. `TodoOptions.storeRoot` selects an exact private fixture directory. Each extension instance owns its own backend and operation queue.

The owner publishes immutable root objects and a prepared receipt before appending a small Pi custom anchor. It verifies the exact live anchor, verifies its on-disk append, syncs the session file, and publishes a durable binding before reporting success. `message_end` is not a durability acknowledgment and has no persistence handler here.

An ephemeral session or a deferred session file refuses mutations with `state-store-unpersisted`. This includes `/todo-add` before Pi has persisted a new session. No volatile success is enabled. An unbound object is an orphan, not visible state. An uncertain append remains pending until the backend reconciles the exact operation. Missing or corrupt objects are not replaced with empty state.

Session start and tree navigation use direct bindings or one bounded ancestry-resolution page. They never call `getBranch()` or replay all history. Native tools can advance a pending resolution one page per call. `agent_settled` can resolve one further page. Context queries read only an already resolved state and never restore it. Forked anchors retain their original provenance and new writes create a new source-bound commit.

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
