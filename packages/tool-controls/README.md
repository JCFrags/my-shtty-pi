# pi-tool-controls

`pi-tool-controls` is a standalone Pi package that adds mouse-first bulk controls for tool-output expansion. It installs a compact, single-line strip below the editor and a scroll-safe detailed overlay with keyboard and mouse parity.

The package does not render individual tool cards, inspect transcript text, synthesize keyboard shortcuts, parse terminal mouse escape sequences, or modify Pi core.

## Requirements

- Node.js **22.19.0 or newer**.
- Pi running in interactive TUI mode.
- A patched Pi build exposing the following capabilities on the extension UI/component surface:
  - first-class `Component.handleMouse` dispatch with a positive `supportsComponentMouse` advertisement;
  - `getToolExpansionStates()`;
  - `setToolExpanded()`;
  - `setToolGroupExpanded()`;
  - `onToolExpansionChange()`.
- The per-tool state returned by `getToolExpansionStates()` must expose `toolCallId`, `toolName`, `turnIndex`, `status`, and `expanded`. Current-turn queries must support `{ scope: "currentTurn" }`.

Pi core packages are peer dependencies and are not bundled:

```json
{
  "@earendil-works/pi-coding-agent": "*",
  "@earendil-works/pi-tui": "*"
}
```

### Older Pi compatibility

Capability checks are structural and occur at runtime. Mouse dispatch must be advertised positively. An absent or false advertisement keeps the package in compatibility mode. An older Pi can load the package without importing or copying Pi internals. When the patched API is incomplete, the package names the missing capability and retains a keyboard-accessible compatibility overlay using `getToolsExpanded()` and `setToolsExpanded()`.

Compatibility mode is intentionally global: it cannot show per-card counts, groups, status filters, or multi-selection.

## Installation

### Local path

```sh
cd /absolute/path/to/pi-tool-controls
npm ci
npm run check
pi install "$PWD"
```

A project-local Pi install can use:

```sh
pi install -l "$PWD"
```

### Git package

Replace the owner and ref with the repository location you publish:

```sh
pi install git:github.com/OWNER/pi-tool-controls@REF
```

A protocol URL is also valid:

```sh
pi install https://github.com/OWNER/pi-tool-controls@REF
```

For a one-run manual check without writing package settings:

```sh
pi -e "$PWD"
```

The owned Pi 0.84.1 patch is in `integration/pi-0.84.1/`. Its manager verifies exact stock or patched hashes and keeps reversible installed bytes:

```sh
export PI_ROOT=/absolute/path/to/pi-coding-agent-0.84.1
./integration/pi-0.84.1/manage-patch.sh verify
./integration/pi-0.84.1/manage-patch.sh install
# Restore stock bytes when needed:
./integration/pi-0.84.1/manage-patch.sh rollback
```

## Usage

The extension installs this compact strip with `placement: "belowEditor"`:

```text
Wide   [Tools 3/11] [Expand turn] [Collapse turn] [More…]
Medium [Tools 3/11] [Expand] [Collapse]
Narrow [Tools 3/11]
```

The strip never intentionally wraps. At terminal widths smaller than the tools-count label itself, the label is clipped to the available columns rather than creating a second line.

- `Tools x/y` and `More…` open the detailed overlay.
- `Expand turn` expands tool cards from the current turn.
- `Collapse turn` collapses tool cards from the current turn.
- Disabled controls are dimmed and have no active hit region.
- Mouse actions require a left-button press and release inside the same control. Any drag motion cancels activation. Right and middle clicks are ignored.

Open the same overlay without a mouse:

```text
/tool-controls
```

### Detailed overlay

```text
Tool controls — 3/11 expanded
Current turn    [Expand] [Collapse]  1/4 expanded
Failed tools    [Expand] [Collapse]  0/2 expanded
Running tools   [Expand] [Collapse]  1/1 expanded
Entire session  [Expand] [Collapse]  3/11 expanded
Tools
> ▸ read               call…91ad  turn 4  success  [x]
  ▾ bash               call…7c20  turn 4  error    [ ]
  ▸ web                call…0e32  turn 3  running  [x]
  …
Selected 2  [Expand selected] [Collapse selected]
↑/↓ focus  Space select  a select visible  n clear  PgUp/PgDn scroll  Esc close
```

Each group has separate `Expand` and `Collapse` actions:

- **Current turn** uses `getToolExpansionStates({ scope: "currentTurn" })` and `setToolGroupExpanded({ scope: "currentTurn" }, expanded)`.
- **Failed tools** includes exactly `status === "error"`.
- **Running tools** includes exactly `status === "pending" || status === "running"`.
- **Entire session** includes every state returned by the unscoped query.

Selection remains local to the overlay until `Expand selected` or `Collapse selected` is activated.

### Keyboard controls

| Input | Action |
| --- | --- |
| Up / Down | Move focus through group buttons, rows, and selected-action buttons |
| Space | Select or unselect the focused tool row |
| Enter | Activate the focused button |
| `a` | Select all currently visible tool rows |
| `n` | Clear selection |
| Escape | Close the overlay |
| PageUp / PageDown | Scroll the tool list |
| Shared configured selection/editor/alternate-screen page keys | Scroll the tool list |

### Mouse controls

- Click a tool row to select or unselect it.
- Use the wheel over the tool-list viewport to scroll only that list.
- Click explicit group or selected-action buttons to operate expansion.
- The modal overlay captures focus; the compact transcript widget is inert while the overlay is open.

## State updates and lifecycle

The widget refreshes when:

- a turn starts;
- a tool starts or finishes;
- Pi reports a per-card expansion change;
- a bulk operation completes;
- a session starts, reloads, or switches.

`session_shutdown` removes the widget, closes the overlay, and disposes the Pi expansion-state subscription. Starting a replacement session also cleans the prior runtime first.

If Pi rejects a stale or unknown tool ID, the package notifies once for that operation and refreshes state instead of throwing into Pi. A component render or event failure disables and removes the widget, closes the overlay, disposes subscriptions, and emits one error notification.

## TUI mode limitation

The owned Pi 0.84.1 integration patch advertises component mouse dispatch only in fullscreen mode. The package disables mouse reporting in regular mode, so terminal scrollback and ordinary text selection remain native. It enables mouse capture only while the fullscreen controls overlay is open, then disables it on every close, reload, and failure path. The package does not create or manage an alternate-screen transcript.

## Troubleshooting

### “Missing patched Pi capability”

Update or switch to a Pi build that exposes every capability listed under [Requirements](#requirements). The notification names each missing API. Until then, run `/tool-controls` and use the compatibility-mode global `Expand all` / `Collapse all` controls when `getToolsExpanded()` and `setToolsExpanded()` are available.

### The strip renders but mouse clicks do not arrive

The per-tool methods may exist while the Pi build does not route first-class `Component.handleMouse` events. Use `/tool-controls` with the keyboard, then verify the Pi patch includes component-local press, release, move, and wheel delivery. This package deliberately does not fall back to raw terminal escape parsing.

### Counts or statuses appear stale

Verify the patched `onToolExpansionChange()` fires after individual card changes and that `getToolExpansionStates()` returns the active session rather than a cached transcript projection. Tool state is never inferred from transcript text.

### Build fails before Pi starts

Check the runtime first:

```sh
node --version
```

It must report `v22.19.0` or newer. Then run:

```sh
npm ci
npm run check
```

## Development and validation

```sh
npm run typecheck
npm test
npm run build
npm run smoke
npm run pack:check
```

`npm test` uses Node's built-in test runner. The smoke script creates a structural mock of `ExtensionUIContext`, installs the extension, renders the widget, executes a press/release current-turn action, opens the overlay, and validates shutdown cleanup.

For an interactive manual test:

```sh
npm run smoke
pi -e "$PWD"
```

In Pi, trigger at least one tool call, click the compact controls, open `/tool-controls`, select multiple rows, test PageUp/PageDown and wheel scrolling, then reload extensions and confirm the widget is installed only once.

## Uninstall

Use the same package source form that was installed. Confirm it with `pi list`, then remove it, for example:

```sh
pi remove /absolute/path/to/pi-tool-controls
```

or:

```sh
pi remove git:github.com/OWNER/pi-tool-controls@REF
```

Restart Pi or reload extensions after removal if the current session is still open.
