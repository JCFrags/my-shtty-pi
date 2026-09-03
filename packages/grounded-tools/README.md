# Grounded Tools

- Purpose: Provide evidence-first file, process, LSP, dialog, task, note, and workplan tools with one shared core.
- Status: active canonical
- Pi entrypoint(s): `files/index.ts`, `process/index.ts`, `lsp/index.ts`, `dialog/index.ts`, `tasks/index.ts`, `notes/index.ts`, `workplan/index.ts`
- Load form: source-loaded
- Build/check command: `node ../../scripts/verify-deployed-baseline.mjs --product grounded-tools`
- Deployment hash verification command: `node ../../scripts/verify-deployed-baseline.mjs --product grounded-tools`
- Additive current-state boundary: Todo publishes its existing version-1 summary with a bounded branch identity, and its existing `pi-todo:summary-changed-v1` envelope may carry the bounded snapshot used by the provider. That changed event is an invalidation for consumers, not an authoritative current-state payload. Workplan publishes `pi-workplan:request-summary-v1`, `pi-workplan:summary-v1`, `pi-workplan:summary-changed-v1`, and post-persistence `pi-workplan:activity-v1` (`checkpoint_recorded`, `milestone_completed`, and `plan_completed`). Project Glance consumes these events without importing grounded-tools implementation internals or mutating provider state.
