# pi-herdr-status

`pi-herdr-status` is a standalone Pi package that adds concise, short-lived presentation metadata to Herdr panes. It reports activity details such as the current tool, model, context usage, changed-file count, and turn index without taking ownership of semantic lifecycle state or Pi session identity.

## Integration boundary

Install Herdr's official Pi integration separately. It remains the authority for semantic state (`idle`, `working`, and `blocked`) and session identity:

```bash
herdr integration install pi
```

This package only calls Herdr's metadata interface, using source ID `user:pi-rich-status`. It never calls `pane report-agent`, restores sessions, injects terminal input, or replaces Herdr's official Pi integration.

## Requirements

- Node.js 22.19 or later
- Pi with package/extension support
- Herdr with `pane report-metadata`, metadata tokens, token clearing, and TTL support
- A Pi process launched by Herdr with `HERDR_ENV`, `HERDR_PANE_ID`, and `HERDR_BIN_PATH`

The extension probes the exact binary supplied in `HERDR_BIN_PATH` with:

```text
herdr api schema --json
herdr pane report-metadata --help
```

It only uses options advertised by both the installed schema and CLI help. Sequence numbers are enabled only when the installed Herdr interface supports them.

## Install

From npm after the package is published:

```bash
pi install npm:pi-herdr-status
```

From a local checkout:

```bash
npm install
npm run validate
pi install ./
```

Pi discovers the TypeScript extension through the package's `pi.extensions` manifest. The build output is also included in npm packages for validation and inspection.

## Reported metadata

All values are normalized before reporting. The activity summary targets at most 60 visible characters; every other token remains within Herdr's documented token-value limit.

| Token | Value |
| --- | --- |
| `summary` | Concise activity such as `reading src/auth/session.ts`, `running npm test`, `waiting for model`, or `idle · 3 files changed` |
| `model` | `provider/model` when both are available, otherwise a concise model name |
| `context` | Rounded integer percentage such as `42%`; omitted when Pi cannot determine usage |
| `tool` | Current Pi tool name; omitted when no tool is active |
| `changed_files` | Count of unique normalized paths successfully touched by Pi edit/write events in the current session |
| `turn` | Current Pi turn index |

### Pi event mapping

| Pi event | Metadata behavior |
| --- | --- |
| `session_start` | Reset session-local state and report initial model, context, changed-file count, turn, and `waiting for model` |
| `turn_start` | Update `turn`, refresh model/context, and mark the turn active |
| `tool_execution_start` | Set `tool` and derive a sanitized summary from structured tool input |
| `tool_execution_update` | Refresh the metadata TTL at a throttled cadence; tool output chunks are never reported |
| `tool_execution_end` | Deduplicate successful edit/write paths and clear the active tool after a short debounce |
| `model_select` | Update `model` and current context percentage |
| `thinking_level_select` | Refresh model/context only; no separate thinking-level token is created |
| `agent_settled` | Clear `tool` and report `idle` or `idle · N files changed` |
| `session_shutdown` | Cancel timers and clear all six tokens owned by `user:pi-rich-status` when possible |

## Sidebar configuration

Herdr metadata tokens can be referenced with `$name` in the Agent sidebar rows. One compact example is:

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "agent", "$model", "$context"],
  ["$summary"],
  ["$tool", "$changed_files", "$turn"],
  ["workspace", "tab"],
]
```

The semantic state icon and agent/session label in this example still come from Herdr's official Pi integration. The values beginning with `$` come from this package.

## Activation and no-op behavior

Reporting activates only when all of the following are true:

- `HERDR_ENV=1`
- `HERDR_PANE_ID` is non-empty
- `HERDR_BIN_PATH` is non-empty and executable

When any condition fails, the extension loads silently and registers only `/herdr-status`. It does not guess a Herdr executable or socket path. Herdr-provided environment values are passed through to the supplied CLI binary, so a configured socket remains under Herdr's control.

## Rate limiting, ordering, and failure handling

- Updates coalesce for 150 ms.
- Reports are dispatched no more frequently than once every 250 ms (at most 4 Hz).
- Activity-sensitive metadata uses a 15-second TTL and refreshes every 5 seconds while a turn/tool is active.
- Tool update events can request a refresh at most once every 3 seconds before coalescing/rate limiting.
- Reports are serialized so an older asynchronous command cannot overtake newer state.
- Monotonically increasing `seq` values are used only when the installed Herdr schema and help advertise support. They are wall-clock anchored so a restarted extension does not fall behind the prior process's sequence for the same pane/source.
- Herdr subprocesses use direct argv arrays, have bounded output, and time out after 1.5 seconds.
- Failures never propagate into Pi. After three consecutive failures, reporting backs off exponentially (bounded at 30 seconds) and emits one concise Pi warning for the failure streak.

## Privacy

The package does not report prompt text, tool output, command output, full environment data, credentials, or absolute home-directory prefixes.

For Bash-like tools, only the first command line from structured input is used. Control characters and newlines are removed, common credential forms are redacted, absolute home-directory prefixes become `~`, and the command is treated as display text only—it is never executed, parsed as a shell program, or reinterpreted.

Paths are normalized lexically. Paths under the current working directory are shown relative to that directory. Paths elsewhere under the home directory use a `~/` prefix instead of the absolute home path; unrelated absolute paths fall back to a basename.

## `/herdr-status`

Run:

```text
/herdr-status
```

The command shows:

- active/inactive state and an inactive reason when applicable
- target pane ID
- metadata source ID
- last successful report time
- last concise error
- current token snapshot
- a note that semantic lifecycle state and session identity remain owned by Herdr's official Pi integration

It does not display the Herdr socket path, binary path, credentials, or unrelated environment data.

## Development and validation

```bash
npm run typecheck
npm test
npm run build
npm run smoke
npm run validate
```

Tests use an executable fake Herdr CLI. They do not require a Herdr server or socket.

## Troubleshooting

**`/herdr-status` says inactive**

Check the reported reason. Start Pi through Herdr so the official integration supplies `HERDR_ENV=1`, `HERDR_PANE_ID`, and an executable `HERDR_BIN_PATH`.

**The official Pi integration is missing or unhealthy**

```bash
herdr integration status
herdr integration install pi
```

This package does not substitute for that integration.

**Reports fail after Herdr is upgraded or downgraded**

Inspect the installed interface directly:

```bash
"$HERDR_BIN_PATH" api schema --json
"$HERDR_BIN_PATH" pane report-metadata --help
```

The extension requires metadata tokens, TTL, `--source`, `--token`, and the documented token-clear mechanism. `/herdr-status` shows the most recent concise error without exposing socket paths or command output.

**Sidebar values do not appear**

Confirm the sidebar rows reference the exact token names (`$summary`, `$model`, `$context`, `$tool`, `$changed_files`, and `$turn`). Activity metadata expires after 15 seconds unless an active turn refreshes it.

## Uninstall

For an npm installation:

```bash
pi remove npm:pi-herdr-status
```

For a local installation, run this from the checkout used during installation:

```bash
pi remove ./
```

The extension clears its tokens during normal session shutdown; otherwise Herdr's 15-second TTL removes stale metadata.

## License

MIT
