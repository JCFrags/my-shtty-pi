# Owned Pi 0.84.1 Tool Controls integration patch

This bounded patch supplies the five public APIs that `pi-tool-controls` needs. It targets only the installed Pi `0.84.1` package and its bundled `@earendil-works/pi-tui`.

## Provenance

- Installed Pi root: the exact `pi-coding-agent-0.84.1` package directory selected with `PI_ROOT`
- Pi version: `0.84.1`
- Patch date: `2026-08-21`
- Original bytes: `original-sha256.txt`
- Accepted patched bytes: `patched-sha256.txt`
- Exact byte changes: `pi-0.84.1-tool-controls.patch`

The installed JavaScript source maps identify the owning upstream TypeScript files:

- `packages/tui/src/tui.ts`
- `packages/tui/src/tui-alt-screen.ts`
- `packages/coding-agent/src/core/extensions/types.ts`
- `packages/coding-agent/src/core/extensions/runner.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

The installed package does not include the editable TypeScript source tree. This integration therefore patches the matching compiled JavaScript and declarations. It does not change source maps. A future upstream patch must apply the same behavior in the five source files above and rebuild both packages.

## Public behavior

The patch adds:

- decoded `Component.handleMouse(event)` delivery;
- `supportsComponentMouse` on the extension UI context;
- `getToolExpansionStates()`;
- `setToolExpanded()`;
- `setToolGroupExpanded()`;
- `onToolExpansionChange()`.

Pi owns SGR mouse parsing and component-local coordinate conversion. The extension does not parse raw terminal input or transcript text.

Mouse dispatch is advertised only in fullscreen mode. The extension explicitly disables mouse capture in regular mode and enables it only while its fullscreen overlay is active. The capture is released on Escape, Ctrl+C, reload, normal close, and error cleanup. Fullscreen has a retained layout frame that supports stable component hit testing. Regular mode keeps native terminal scrollback and ordinary text selection.

Per-tool state comes from live `ToolExecutionComponent` instances. A rebuilt session assigns increasing assistant-turn indexes. A stale tool call ID throws `UNKNOWN_TOOL`. Group changes emit one expansion notification.

## Install, verify, and rollback

```sh
chmod +x manage-patch.sh
export PI_ROOT=/absolute/path/to/pi-coding-agent-0.84.1
./manage-patch.sh verify
./manage-patch.sh install
./manage-patch.sh rollback
```

`PI_ROOT` is required. Installation refuses bytes that do not match the recorded stock manifest. It creates `$PI_ROOT/.tool-controls-patch-backup-0.84.1` before the first write. Rollback verifies both active patched bytes and backup stock bytes before it restores files.

A Pi update replaces this patch. Rebase the bounded source changes against the new Pi version. Do not force this patch onto a different hash set.

## Real acceptance record

The accepted host used the installed Pi 0.84.1 executable in fullscreen mode.

- Stock Pi compatibility was proved first with `/tool-controls`, global `Expand all`, and global `Collapse all`.
- Patched Pi rendered exactly one below-editor widget.
- One real `read` tool card reported `turn 1` and `success`.
- Keyboard current-turn expand and collapse changed that one card.
- A decoded mouse press and release activated overlay `Expand`.
- A decoded mouse click on compact `More…` opened the overlay.
- `/reload` removed the old runtime and returned exactly one widget.
