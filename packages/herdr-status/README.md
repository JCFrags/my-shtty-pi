# Herdr sidebar settings

This source-loaded package owns Pi's additive sidebar fields and terminal title
animation. Its package path remains `herdr-status` for installation compatibility.
Herdr Agent State remains the independent owner of lifecycle and session reporting.

## One command

Run `/herdr-sidebar-settings` for:

- Display fields and short or full model names.
- The existing Smart, Minimal, Arcade, Cosmic, Playful, Terminal, Context Pressure,
  Surprise, and Still animation profiles.
- Elapsed time, idle activity, and optional details while idle.
- A sample preview, read-only diagnostics, save, and restore of previous settings.

`/herdr-sidebar-settings preview` and `/herdr-sidebar-settings diagnostics` show
read-only reports. The former `/herdr-status` and `/title-animation` commands are
not registered. The standalone Titlebar Spinner package is retired.

Changes stay in a draft until Save. Restore previous settings loads the previous
saved preferences into the draft. Save applies them. Cancel discards the draft.

## Default display

```text
Working                 Idle
pi · working            pi · idle
Astra 76%               ✓ Ready
⠋ Reading · 4s
```

The animation follows the selected profile. Existing `title-animation.json`
preferences supply the initial profile when the new settings file is absent.
The old file is not changed or deleted. Other defaults use the compact layout.

### Native and added information

Herdr 0.9.1 natively supplies these agent-row tokens:

- `state_icon`, `agent`, and `state_text` display agent identity and lifecycle state.
- `machine`, `workspace`, `tab`, and `pane` display location.
- `terminal_title` displays the title sent by the terminal application.

This package adds one `$model_context` value and supplies the terminal title's
activity text. It does not add a second activity row or a custom lifecycle state.
Model/context and optional counters disappear while idle by default. An empty
terminal title removes the idle activity row when idle activity is hidden.

The optional file count is the number of distinct successful Pi `edit`/`write`
paths observed since the extension loaded. It is not Git status. Git branch and
status tokens belong to Herdr's workspace list, not its agent rows. Optional
location fields use Herdr's native tokens.

## Persistence and scope

Preferences use `herdr-sidebar-settings.json` in Pi's agent directory. The file
contains the current settings and, after a save, the previous settings. Loaded
instances refresh shared preferences within five seconds. An invalid file produces
a warning and cannot be overwritten through Save.

Inside Herdr, Save also changes only the `pi` value in
`[ui.sidebar.agents.rows_by_agent]`. This layout applies to all Pi entries using
that Herdr configuration, not just the current pane. The helper preserves other
TOML bytes, checks for concurrent changes, backs up the configuration, validates a
staged file with `herdr config check`, and requests `herdr server reload-config`.
It does not restart Herdr. Ambiguous inline or dotted table forms are refused
rather than rewritten. The normal configuration path honors `HERDR_CONFIG_PATH`
and `XDG_CONFIG_HOME`.

Outside Herdr, the same command controls terminal title animation without touching
Herdr configuration. The title retains session, project, and model context.

## Activity correctness

Activity starts or resumes on agent, message, and tool events. Compaction does not
end an active run merely because its reason is `manual`. `Ready` requires a settled
run and Pi's idle state. Failed or canceled compaction releases its own activity.
Reload during work reads current state rather than assuming idle. Shutdown stops
timers and clears owned metadata. Animation frames update the terminal title only;
metadata uses a separate bounded, coalesced reporter.

## Installation and verification

Use the full retained checkout described in [installation](../../docs/installation.md).
Set `REPO` to its absolute path, then register the source-loaded package once:

```sh
pi install "$REPO/packages/herdr-status"
```

No build or package-local npm installation is required for runtime use. The installed
Pi loader supplies Pi/TUI imports. Keep `extensions/` and its sibling `src/` directory
intact. Local registration does not copy source or install dependencies. The commands
below prepare development checks, not runtime activation.

Load `extensions/herdr-status.ts` through this package. Remove only the confirmed old
standalone Spinner registration or alias during a backed-up scoped replacement.
Do not load both presentation owners. Keep Herdr Agent State and Dialog selected.

Follow [the activation runbook](../../docs/activation.md#herdr-sidebar-presentation).
Verify the complete loader inventory, the menu, real title/metadata output, and the
loaded source hash in Diagnostics. A selected path does not prove an existing Pi
process has reloaded. Reload only after managed jobs settle and the editor is empty.

From the repository root:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm ci --ignore-scripts --no-audit --no-fund --prefix packages/herdr-status
npm run typecheck --prefix packages/herdr-status
```

Stage intended changes before root `npm run verify:static`. The historical
`DEPLOYED.sha256` file describes the original deployed baseline, not this version.
