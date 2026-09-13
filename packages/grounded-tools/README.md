# Grounded Tools

- Purpose: Provide evidence-first file, process, LSP, dialog, task, note, and workplan tools with one shared core.
- Status: active canonical
- Pi entrypoint(s): `files/index.ts`, `process/index.ts`, `lsp/index.ts`, `dialog/index.ts`, `tasks/index.ts`, `notes/index.ts`, `workplan/index.ts`
- Load form: source-loaded
- Current check command, from the repository root: `npm run verify -- --product grounded-tools`
- Historical deployment check, from the repository root: `npm run verify:history`
- Additive current-state boundary: Todo publishes its existing version-1 summary with a bounded branch identity, and its existing `pi-todo:summary-changed-v1` envelope may carry the bounded snapshot used by the provider. That changed event is an invalidation for consumers, not an authoritative current-state payload. Workplan publishes `pi-workplan:request-summary-v1`, `pi-workplan:summary-v1`, `pi-workplan:summary-changed-v1`, and post-persistence `pi-workplan:activity-v1` (`checkpoint_recorded`, `milestone_completed`, and `plan_completed`). Workplan request IDs are echoed exactly; branch IDs are bounded opaque identifiers and are not whitespace-normalized. Project Glance consumes these events without importing grounded-tools implementation internals or mutating provider state.

## Session rollover

Notes, Todo, and Workplan can export their complete current native state at a settled session boundary. Chrono V3 carries that state into a new physical session through `grounded-state-checkpoint-v1` custom entries. IDs, counters, archived records, and Workplan revision and checkpoint history remain intact. Later ordinary events replay from that checkpoint on the selected branch.

Export reads in-memory provider state, not old session archives. Each provider limits a checkpoint to 8 MiB, 200,000 visited values, and 32 nesting levels. Chrono limits the combined checkpoints to 16 MiB. Invalid, pending, or over-budget state prevents rollover. The system does not shorten tool state to make it fit.

Install these providers and their matching `core` with Chrono V3. Older providers do not understand the checkpoint format. Keep checkpoint-aware providers after rollover, or use a verified logical rollback before restoring old code. See [Chrono recovery](../../docs/chrono-v3/recovery.md#native-state-after-rollover).

Grounded Process cancels session switches while managed processes are running or persistent sessions are open. Settle jobs and close sessions normally before switching. Reload still shuts down managed resources, so an empty editor alone does not make reload safe.
