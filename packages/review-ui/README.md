# pi-review-ui

`pi-review-ui` is a Pi package that intercepts Pi's built-in `edit` and `write` tool calls before execution, constructs the exact proposed file content, displays a unified diff, and requires an explicit decision.

> **This is an approval user interface, not a sandbox.** Approval allows Pi's original built-in tool to run normally. Pi and the approved tool still run with the user's operating-system permissions.

Version one approves or rejects the entire tool call. It does not apply individual hunks.

## Requirements

- Node.js 22.19.0 or later
- Pi with the asynchronous `tool_call` extension event and custom overlay UI (Pi 0.83.0 or later)

## Install

```bash
pi install npm:pi-review-ui
```

For a project-local installation:

```bash
pi install -l npm:pi-review-ui
```

To test a local checkout without installing it permanently:

```bash
pi -e /absolute/path/to/pi-review-ui
```

## Behavior

By default, every built-in `edit` and `write` call follows this sequence:

1. Resolve and normalize the requested path against `ctx.cwd`.
2. Resolve existing symbolic-link components and determine the effective target.
3. Read the current file when it exists.
4. Construct the exact proposed content using the built-in tool's semantics.
5. Generate a unified diff, or bounded metadata when text rendering is unsafe or too large.
6. Present one serialized review dialog.
7. Return no block result after approval, allowing the original Pi tool to execute.
8. Return `{ block: true, reason: "Rejected by user" }` after rejection.

The extension never writes the target file. It also does not mutate the tool arguments. Control-character escaping is display-only and does not alter the arguments or the content used to construct the preview. The preview of an `edit` call invokes Pi's built-in edit implementation with in-memory read/write operations and captures the content that implementation would write. A `write` preview uses the proposed `content` string exactly as supplied.

### Review dialog

A typical review is rendered as a custom modal overlay:

```text
┌────────────────────────────────────────────────────────────────────┐
│ Review EDIT src/config.ts  [1/3]                                  │
│ No additional path/content warnings                               │
├────────────────────────────────────────────────────────────────────┤
│ --- src/config.ts                                                  │
│ +++ src/config.ts                                                  │
│ @@ -8,5 +8,5 @@                                                    │
│ -const enabled = false;                                            │
│ +const enabled = true;                                             │
│                                                                    │
│  1-6 of 6                                                          │
├────────────────────────────────────────────────────────────────────┤
│ [ Approve once ]  [ Reject ]                                       │
│ ↑/↓ PgUp/PgDn scroll · Tab/Shift+Tab focus · Enter activate       │
│ y approve · n/Esc reject                                           │
└────────────────────────────────────────────────────────────────────┘
```

The action area remains pinned while the diff scrolls. Focus starts on **Reject**. Pressing Space is deliberately inert and never approves a call.

When `allowApproveAllForTurn` is enabled, a third action appears:

```text
[ Approve all edit/write calls for this turn ]
```

That state is limited to the active Pi turn and is cleared at `turn_end` and every session boundary. It does not suppress mandatory per-call outside-cwd or oversized-preview confirmations.

### Keyboard controls

| Input | Result |
| --- | --- |
| Up / Down | Scroll one line |
| PageUp / PageDown | Scroll one page |
| Tab / Shift+Tab | Move action focus |
| Enter | Activate only the focused action |
| `y` | Approve once, or confirm the current warning dialog |
| `n` | Reject |
| Escape | Reject |
| Space | No approval action |

### Mouse behavior

Stock Pi remains keyboard-first. `pi-review-ui` does not enable raw terminal mouse reporting and does not depend on private overlay geometry.

The dialog exposes a first-class component mouse hook for Pi versions that dispatch local mouse events to custom overlay components. On such versions:

- terminal escape, C0/C1, and bidirectional-control characters from paths or content are rendered visibly rather than executed;
- the wheel scrolls the diff;
- only explicit button hit regions are clickable;
- a left-button press and release must occur on the same button;
- pointer movement or dragging cancels activation;
- header, warning, body, and outside-modal clicks never approve;
- handled modal pointer events are consumed rather than passed through.

## Path and content safety behavior

### Outside `ctx.cwd`

Containment is checked twice:

- **Lexical containment** checks the normalized requested path against normalized `ctx.cwd`.
- **Effective containment** resolves existing symbolic-link components and checks the effective target against the real path of `ctx.cwd`.

A target is treated as outside the working directory when either check is outside. The review displays both the requested and effective target. With the default `outsideCwd: "double-confirm"`, normal diff approval is followed by a separate warning dialog:

```text
┌──────────────────────────────────────────────────────────────┐
│ Outside-cwd confirmation                                     │
│ ! The original Pi tool will run with the user's OS           │
│   permissions outside the project directory.                 │
├──────────────────────────────────────────────────────────────┤
│ ctx.cwd:          /work/project                              │
│ requested target: /work/project/link/file.txt                │
│ effective target: /work/shared/file.txt                      │
│                                                              │
│ This confirmation is separate from the diff approval.        │
├──────────────────────────────────────────────────────────────┤
│ [ Continue outside cwd ]  [ Reject ]                         │
└──────────────────────────────────────────────────────────────┘
```

Set `outsideCwd` to `"block"` to reject these calls unconditionally.

Symbolic links are always disclosed in the warning banner. A link that causes the effective target to leave `ctx.cwd` cannot pass on ordinary approval alone. This is still subject to filesystem race conditions: a path or link can change after review and before the original tool executes.

### Missing write parents

For a new-file `write`, missing parent paths identified from the requested and effective targets are listed in creation order in the warning banner. The extension does not create those directories; approval leaves that work to Pi's original `write` tool.

### Binary-like and NUL-containing data

Current or proposed data is treated as binary-like when it contains NUL bytes, invalid UTF-8, or a material density of non-text control bytes. In that case the UI suppresses the text diff and shows bounded metadata instead:

- existence state;
- byte count;
- line count where meaningful;
- SHA-256 digest;
- whether the bytes changed.

### Oversized previews

`maxPreviewBytes` defaults to 1 MiB per side. If either the current or proposed content exceeds that limit, the full diff is not rendered. The UI shows a bounded summary with sizes, line counts, SHA-256 digests, common prefix/suffix sizes, an approximate first differing line, and short sanitized excerpts.

Approval of the summary is followed by a second explicit oversized-preview confirmation. An approve-all-for-turn decision never bypasses this confirmation.

### Line endings

The proposed content preserves the built-in tool's line-ending behavior. In particular, `edit` previews preserve the existing file's CRLF line endings and UTF-8 BOM in the same way as Pi's built-in edit implementation. `write` previews preserve the supplied content exactly.

## Configuration

Configuration is project-local at:

```text
.pi/review-ui.json
```

The file is optional. These are the defaults:

```json
{
  "reviewEdit": true,
  "reviewWrite": true,
  "reviewBash": "off",
  "allowApproveAllForTurn": false,
  "maxPreviewBytes": 1048576,
  "nonInteractive": "block",
  "outsideCwd": "double-confirm"
}
```

| Key | Accepted values | Effect |
| --- | --- | --- |
| `reviewEdit` | boolean | Review built-in `edit` calls. |
| `reviewWrite` | boolean | Review built-in `write` calls. |
| `reviewBash` | `"off"` only | Bash review is not implemented in version one. |
| `allowApproveAllForTurn` | boolean | Show the optional per-turn approval action. Disabled by default. |
| `maxPreviewBytes` | integer, 1 through 67,108,864 | Maximum full-preview size for each side. |
| `nonInteractive` | `"block"` or `"allow"` | Policy for print, JSON, and RPC modes. |
| `outsideCwd` | `"double-confirm"` or `"block"` | Additional outside-cwd policy. |

Unknown keys, malformed JSON, wrong types, unsupported values, and unsafe preview limits are reported and fail closed. The extension never substitutes a permissive fallback for an invalid value.

## Non-interactive modes

The default `nonInteractive: "block"` rejects reviewed `edit` and `write` calls in print, JSON, and RPC modes because the TUI approval dialog is unavailable. The block reason identifies the active mode and the configuration setting.

Setting `nonInteractive` to `"allow"` is an explicit opt-in to allow ordinary in-cwd calls without UI review. Calls that require a mandatory confirmation remain blocked because no confirmation can be collected:

- outside-cwd calls remain blocked, including when `outsideCwd` is `"double-confirm"`;
- oversized previews remain blocked;
- `outsideCwd: "block"` remains authoritative.

## Parallel calls and lifecycle

Pi may issue tool calls in parallel. `pi-review-ui` inserts calls into a FIFO queue before asynchronous config, filesystem, diff, or dialog work begins. Only one review overlay is active at a time, and every call receives its own decision.

Active and queued reviews are aborted on:

- the relevant Pi tool-call abort signal;
- session shutdown;
- session replacement or switch;
- extension/resource reload;
- a new session start.

Aborts return deterministic block reasons. Dialog and diff failures fail closed. Overlay state, abort listeners, queue-position listeners, and pointer state are disposed idempotently so a failure cannot leave the agent loop waiting on a leaked dialog.

## Safety limitations

`pi-review-ui` reduces accidental file changes by adding a review gate. It does not establish a security boundary.

- Approval runs Pi's original tool with the user's OS permissions.
- The extension does not restrict what other Pi extensions, processes, or the user can do.
- Files and symbolic links can change between preview and execution.
- Hard-link aliases, mount behavior, and other filesystem topology are not sandbox boundaries.
- Existing non-regular targets such as directories, devices, and sockets fail closed instead of being previewed.
- A later `tool_call` handler may alter or block a call after this extension has reviewed it; extension ordering remains relevant.
- Binary metadata and oversized summaries are less informative than a complete textual diff.
- Approval is whole-call only. There is no partial-hunk application.
- Rejection does not revert unrelated changes already made by another process.
- Bash review is off. This package is not a shell sandbox and does not claim to classify destructive commands.

## Non-goals

Version one intentionally does not implement:

- partial hunks;
- post-hoc revert;
- Git staging;
- a general Bash sandbox;
- Herdr integration;
- tool-card rendering;
- changes to Pi core.

## Disable or remove

Disable review without uninstalling by setting both tool policies to `false`:

```json
{
  "reviewEdit": false,
  "reviewWrite": false
}
```

You can also disable the extension resource through `pi config` or remove the package:

```bash
pi remove npm:pi-review-ui
```

For a project-local installation:

```bash
pi remove -l npm:pi-review-ui
```

## Development and validation

```bash
npm run typecheck
npm test
npm run build
npm run smoke
```

Run all checks in sequence with:

```bash
npm run validate
```

Tests use temporary directories and in-memory Pi operation adapters. They do not touch real user files. The local-package smoke test packs the package, extracts the tarball into a temporary directory, loads the extension through the packaged `pi.extensions` manifest entry, and verifies lifecycle and `tool_call` registration.
