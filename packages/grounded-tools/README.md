# Grounded Tools

- Purpose: Provide evidence-first file, process, LSP, dialog, task, note, and workplan tools with one shared core.
- Status: active canonical
- Pi entrypoint(s): `files/index.ts`, `process/index.ts`, `lsp/index.ts`, `dialog/index.ts`, `tasks/index.ts`, `notes/index.ts`, `workplan/index.ts`
- Load form: source-loaded
- Current check command, from the repository root: `npm run verify -- --product grounded-tools`
- Historical deployment check, from the repository root: `npm run verify:history`
- Additive current-state boundary: Todo publishes its existing version-1 summary with a bounded branch identity, and its existing `pi-todo:summary-changed-v1` envelope may carry the bounded snapshot used by the provider. That changed event is an invalidation for consumers, not an authoritative current-state payload. Workplan publishes `pi-workplan:request-summary-v1`, `pi-workplan:summary-v1`, `pi-workplan:summary-changed-v1`, and post-persistence `pi-workplan:activity-v1` (`checkpoint_recorded`, `milestone_completed`, and `plan_completed`). Workplan request IDs are echoed exactly; branch IDs are bounded opaque identifiers and are not whitespace-normalized. Project Glance consumes these events without importing grounded-tools implementation internals or mutating provider state.

## Compact human tool display

Files and Process use the pure `pi-tool-controls/presentation` library for `read`, `edit`, `write`, `local_search`, `bash`, `process`, and `session`. This changes only terminal presentation. Tool schemas, model instructions, arguments, execution, and saved result content/details are unchanged. The inactive Tool Controls extension is not loaded.

Collapsed cards use at most six text rows, including the call. An ordinary successful read uses one row. Expanded cards use at most ten text rows. Pi adds its own separator, and images remain separate. Width limits apply after wrapping. Known warnings, errors, partial output, running/cancelled states, and search qualifications take priority over excerpts. An explicit count identifies omitted notices when these do not all fit. A compact view cannot classify every warning in arbitrary shell output.

Read expansion uses saved text. A requested line limit remains visible even when a native read has no structured details. The display does not interpret arbitrary file prose as authoritative continuation metadata. A `SKILL.md` filename selects its returned description, path, and headings when available. This does not verify skill registration. Edit and write show saved diffs, not a new filesystem preview or the complete call content. Syntax and LSP notices remain visible. LSP information is the saved hook result, not proof of remote validation. Shell cards identify the command without displaying scripts or input. They show exit/status information, suppress ordinary successful stdout, and expose explicit diagnostics or a short failure tail. Process lists count supplied failed, cancelled, and unknown states before the ordered item excerpt, so a late failure is not hidden. Missing older details remain unknown.

Use `Ctrl+O` to expand or collapse tools. In Pi fullscreen mode, a left-click on a completed card toggles that card. Normal terminal mode does not provide this mouse behavior. Expansion is still a bounded preview, not full output.

### Inspect original saved evidence

`raw: /export NEW.jsonl` is a short cue, not a safe literal destination. `…` means that the preview omits evidence. Every expanded view and clipped result preview has this cue.

1. Choose a **new private path outside Git**. The export command can overwrite an existing file. Saved arguments/results can contain secrets or other sensitive data.
2. Enter `/export /new/private/path/evidence.jsonl` in Pi. Use a `.jsonl` suffix, not HTML.
3. Inspect the saved tool-call arguments and tool-result content/details in that file. The export covers the active branch and preserves payloads, but rewrites export headers and parent links. It is not a byte-for-byte session backup.

HTML export uses the same compact renderers, so it is not the raw route. An export preserves returned evidence, not source bytes omitted during execution. Follow a returned complete-output path when needed and still available. Process/session logs can expire, normally after 24 hours. Do not publish exports or private log paths.

## Legacy state-provider compatibility

The `tasks`, `notes`, and `workplan` entrypoints remain compatibility alternatives. The independent [Context Kit providers](../pi-context-kit/README.md) own Todo, Notes, and Workplan in the Chrono context-state stack. Replace the corresponding Grounded registration when selecting Context Kit. Never load both writers for one native tool. Progressive Tools controls catalog visibility and schema exposure. It does not own either provider implementation or store.

## LSP document languages

Grounded LSP selects a server by its `extensions` list. When it first opens a document, an optional `languageIds` map selects the language by the lowercase file extension. An unmapped extension uses the required scalar `languageId`. Different document languages share the same server/root client.

The default TypeScript server uses these language fields:

```json
{
  "languageId": "typescript",
  "languageIds": {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript"
  }
}
```

Global server configuration is the `servers` array in `grounded-tools/lsp.json` under Pi's agent directory. A custom server replaces the complete default entry with the same `id`. Existing custom entries without `languageIds` keep their scalar language for all routed extensions. To use the mapping above, add it to the existing TypeScript server entry and preserve its other settings. Explicit map values take precedence over the scalar fallback, including intentional nonstandard language choices.

## Session rollover

This section describes the retained legacy V3 path. Notes, Todo, and Workplan can export their complete current native state at a settled session boundary. Chrono V3 carries that state into a new physical session through `grounded-state-checkpoint-v1` custom entries. IDs, counters, archived records, and Workplan revision and checkpoint history remain intact. Later ordinary events replay from that checkpoint on the selected branch.

Export reads in-memory provider state, not old session archives. Each provider limits a checkpoint to 8 MiB, 200,000 visited values, and 32 nesting levels. Chrono limits the combined checkpoints to 16 MiB. Invalid, pending, or over-budget state prevents rollover. The system does not shorten tool state to make it fit.

Install these providers and their matching `core` with Chrono V3. Older providers do not understand the checkpoint format. Keep checkpoint-aware providers after rollover, or use a verified logical rollback before restoring old code. See [Chrono recovery](../../docs/chrono-v3/recovery.md#native-state-after-rollover).

Grounded Process cancels session switches while managed processes are running or persistent sessions are open. Settle jobs and close sessions normally before switching. Reload still shuts down managed resources, so an empty editor alone does not make reload safe.
