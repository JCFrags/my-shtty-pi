# Native CLI agent control

[Product guide](../README.md) · [Optional Pi adapter](../pi-extension/README.md)

The native CLI is the default for Pi and other agents. It uses one AgentCursor
backend for observations and input. Optional native Pi tools translate calls to
this CLI and do not change its safety boundary.

## Ownership and launch

Choose a stable, non-secret session ID and an absolute project directory. Launch
in a visible terminal, not in a piped agent tool call:

```sh
terminal-browser open https://example.com --session task-a --project /absolute/project
```

Use the same `--session task-a --project /absolute/project` with every `agent`
and `session tabs` command. Session IDs separate concurrent owners, including
owners in one project. They are routing identities, not remote authentication
credentials. Do not reuse another task's ID or change ownership to bypass refusal.
The launch project stays fixed. Changing cwd does not adopt a different project.

`open` occupies its terminal. `--split right|down|left|up` needs support from the
selected terminal adapter. Herdr's `companion open` and `companion tabs` retain
pane-based ownership for its optional adapter. Do not alternate those owners with
a neutral `--session` owner and assume they refer to the same browser.

Launch does not install skills or run setup. If the environment cannot create a
visible pane safely, ask the human to launch in a separate terminal. A browser
without an explicit owner is not a fallback for project transfers.

## JSON, observations, and epochs

```sh
terminal-browser agent observe --session task-a --project /absolute/project \
  --max-elements 120 --view semantic
```

Native agent and session-management successes return JSON. CLI failures use
stderr and a nonzero status. The error envelope has `ok: false` and
`error: {code, message}`. Startup failures retain their diagnostic fields. Read
the reported error; do not classify an empty response as success.

An observation returns `contextId`, `observationId`, `controlEpoch`, semantic
page state, and available frame summaries. The epoch changes when browser control
changes. Input requires the exact current observation and epoch:

```sh
# Replace e1, 7, OBSERVATION_ID, and EPOCH with returned values.
terminal-browser agent click e1 --session task-a --project /absolute/project \
  --tab 7 --observation OBSERVATION_ID --control-epoch EPOCH
```

Use one action, inspect its result, and observe again after page changes.
Navigation, context/frame changes, human input, and geometry changes can invalidate
state. A refusal or cancellation does not establish whether an earlier side
effect occurred. Never replay an uncertain click, edit, upload, or download.

`agent navigate URL` and `get-url` act on a context, not a selected child frame.
They require the current control epoch. `wait-for` accepts a current ref, locator,
or text, a condition, and a bounded timeout. Conditions are `exists`, `visible`,
`text`, and `actionable`.

For private text, pass `--stdin` rather than `--text` in process arguments. Use
`--replace` when one native edit should replace the field. Do not place credentials
in examples, logs, or reusable scripts.

## Semantic and visual targets

Click, type, upload, and hover accept a ref or `--locator-json` with AgentCursor
steps. Drag accepts `--from-locator-json` / `--to-locator-json`, refs, or supported
visual coordinates. Observe supports `--filter-json` to narrow the element list.

```sh
terminal-browser agent click --locator-json '[{"kind":"role","value":"button","name":"Save"}]' \
  --session task-a --project /absolute/project --tab 7 \
  --observation OBSERVATION_ID --control-epoch EPOCH
```

Steps support `css`, `role` with optional `name`/`exact`, `label`, `text`,
`placeholder`, `testid`, `filter` with `hasText`, and `nth` with an index. Query
steps scope later queries. Arrays have 1–16 steps, each query string is at most
1024 characters, and a scope is bounded to 20000 elements. Actions require one
match. Ambiguity returns bounded candidate summaries, not a guessed target.
Role/name matching uses DOM roles and accessible labels, not a complete browser
accessibility-tree query. Open shadow roots are included; closed roots are not.

Input preparation checks attachment, visibility, enablement, editability where
needed, stable geometry, and pointer obstruction. Pointer motion uses slow-natural
AgentCursor. The actual point is checked again before input. A locator can resolve
a replacement node before button-down. A ref never changes identity. These checks
are not atomic with native input and do not authorize a retry after dispatch.

For a PNG artifact:

```sh
terminal-browser agent observe --session task-a --project /absolute/project \
  --view both --image-output /absolute/new-observation.png
```

The CLI creates a new file with mode `0600` and refuses overwrite. The JSON result
contains capture geometry; the file contains pixels. Open the file with the
agent's image-reading facility before relying on what it shows. Captures can
contain private data. Save them only where authorized and do not publish them
without review. Use `--scope element --ref REF` for a supported element capture.
CLI coordinates use the returned browser geometry. Pi's adapter instead accepts
image coordinates and maps them through that geometry.

## Frames and popups

Observe returns at most 24 friendly frame summaries with `ref`, `parent`, `name`,
`url`, and `selected`. Use `--frame f2` for a reported frame and `--frame main` to
return. Omission keeps selection. Refs belong to the current context, frame, and
document. Observe `main` after a selected frame disappears; there is no implicit
parent fallback.

Root, popup, same-origin, and cross-origin frames support native observations,
input, captures, uploads, and same-frame drag. Both drag endpoints must remain in
one selected frame. Ordinary axis-aligned frame owners and browser page zoom are
supported. Frame-owner transforms, perspective, and CSS `zoom` refuse input.
Navigation, detach, process swaps, scrolling, or changed frame geometry can make
old coordinates invalid. Frame ancestry is limited to 32 levels.

```sh
terminal-browser session tabs --session task-a --project /absolute/project --action list
terminal-browser session tabs --session task-a --project /absolute/project --action activate --tab 9
terminal-browser session tabs --session task-a --project /absolute/project --action wait --after-id 9 --timeout-ms 10000
```

Use actual context IDs. `open`, `activate`, and `close` are deliberate mutations.
`wait` returns contexts newer than the supplied ID and does not hold the input
queue. Native popups retain `window.opener`, so opener messages and window closure
work. Switching/closing a context invalidates old observations.

## Dialog decisions

Observe or an interrupted action can return a pending native dialog without page
JavaScript. Reply using the exact dialog ID, context, and current epoch:

```sh
terminal-browser agent dialog --session task-a --project /absolute/project \
  --tab 9 --dialog-id DIALOG_ID --control-epoch EPOCH --dismiss
```

Use `--accept` only for an explicit decision. Prompt text can use `--stdin`.
A dialog response can run while the initiating action is blocked. Dialogs dismiss
after 60 seconds; they never auto-accept. Human users can use the terminal dialog
card, Enter, or Escape. Messages/defaults are bounded to 4096 characters and
response text to 32768. Beforeunload first cancels. It replays only a known
navigation, reload, history, or close request after explicit acceptance. Unknown
requests can only be dismissed.

## Human control and cancellation

`agent status`, `pause`, and `resume` are browser-wide, not per-tab. Pause/resume
require the current epoch from status. Never resume automatically after human
control or a failed action. When the user explicitly asks to resume, do so and
then observe before input. A changed epoch invalidates previous commands.

Cancellation or socket disconnection stops later input and releases held keys
and buttons. It cannot undo delivered side effects. Timeouts, output-limit
failures, and interrupted waits must not trigger automatic replay. Inspect actual
page or download state first. Keep the original startup report and use
`terminal-browser doctor --json` for read-only diagnostics. Recovery that affects
profiles, sockets, panes, or shared daemons is a separate approved operation.

## Uploads and downloads

Uploads click a visible file input or chooser button through AgentCursor. Direct
inputs, button-triggered choosers, multiple files, popups, and supported frames
are handled by the same path. The browser independently canonicalizes files under
the fixed launch project before the click and again before assignment.

```sh
terminal-browser agent upload e3 --files-json '["data/report.txt"]' \
  --session task-a --project /absolute/project --tab 7 \
  --observation OBSERVATION_ID --control-epoch EPOCH
```

Use 1–16 regular files, at most 32 MiB each and 64 MiB total. Relative paths resolve
from CLI cwd, but must still remain under the launch root. Directories, special
files, symlink/project escapes, and conventional secret paths such as `.env`,
`.ssh`, credentials, and private-key paths are rejected. This is a path policy,
not a content secret scanner. Review the actual files before sending them. No
file contents are logged or returned. Chooser interception ends on completion,
failure, a 15-second timeout, navigation, takeover, or closure.

```sh
terminal-browser session tabs --session task-a --project /absolute/project --action downloads
terminal-browser session tabs --session task-a --project /absolute/project \
  --action download_wait --download-id DOWNLOAD_ID --timeout-ms 10000
```

`download_cancel` also needs the exact ID. `--tab` can filter downloads by context,
including closed contexts. Lists contain at most 64 retained transfers, with at
most 32 active transfers. Waits are bounded to 0–60000 ms, return current state on
timeout, and fail on takeover. Results include `projectRoot`, byte progress, state,
and project-relative `savePath`.

Files go to private unique directories under `.terminal-browser-downloads` in
the launch project. Filenames are sanitized and existing files are not overwritten.
Files are never auto-opened or executed. Closing a context or browser interrupts
active transfers. Validated owner-specific history survives reconnects and browser
restart through atomic private metadata. Unfinished transfers become `interrupted`
on restart and do not resume automatically. Invalid/unsafe history is ignored
without returning its contents. A download click can report invalidation while
a transfer still starts. Check the list before deciding on another click.

## Built-in network blocking

The browser uses Ghostery's core `@ghostery/adblocker` 2.18.2 (MPL-2.0), not its
Electron wrapper. Blocking composes with the existing browser network guard.
The bundled EasyList snapshot is SHA-pinned and retains its CC-BY-SA-3.0 notice.
It updates only through reviewed releases. There are no runtime list downloads,
telemetry, cosmetic filters, scriptlets, or main-document blocking.

Blocking is enabled by default. It is not a complete tracker/malware defense or
an anonymity guarantee. Read `effective`, engine readiness, and `warning` in
status instead of assuming that `enabled` proves filtering is active. A missing
or changed bundled list reports a warning and leaves network blocking inactive.
Unreadable saved settings do not silently re-enable a previous opt-out.

```sh
terminal-browser agent blocking status --session task-a --project /absolute/project --tab 7
terminal-browser agent blocking allow-site --site example.com \
  --session task-a --project /absolute/project --tab 7 --control-epoch EPOCH
```

Use `agent status` to obtain the current epoch. `enable`, `disable`, `allow-site`,
`block-site`, `clear-diagnostics`, and `reload` all require it. Site actions also
require `--site` with a hostname or HTTP(S) URL. `block-site` removes a saved
exception so normal list matching applies. It is not a new block-all rule.
Exceptions match the exact top-level hostname across schemes and ports, not
wildcards or every subdomain. Paths and credentials are not stored. At most 64
exceptions are retained.

Enable/disable and site exceptions persist for the shared browser profile. They
are not scoped to one agent or tab. Change them only within the user's requested
scope. Diagnostics are context-scoped: a blocked count and at most 32 recent
host/type pairs, not full URLs or request bodies. `clear-diagnostics` resets the
selected context's counters. `reload` rebuilds the filter cache from the bundled
list. It neither fetches a list nor reloads the page. A changed setting does not
undo an already blocked or delivered request.

For a site failure, inspect status before changing policy. An explicit exact-host
exception is narrower than disabling blocking for the entire profile. Do not use
blocking controls to bypass browser ownership, human takeover, or file/network
guards. Re-observe before further page input.

## Migrate from legacy action

Do not use `terminal-browser action -- ...`, agent-browser snapshots, or direct
CDP commands for this workflow. They are not equivalent to native ownership,
observations, epochs, takeover, and project-file safeguards.

| Legacy intent | Native replacement |
| --- | --- |
| `action -- snapshot` | `agent observe` with an explicit owner |
| `action -- click @e14` | Fresh native observation, then `agent click REF --observation ID --control-epoch N` |
| `action -- fill ...` | `agent type REF --stdin --replace` with current observation/epoch |
| `action -- tab ...` | `session tabs --action list|activate|open|close` |
| `action -- eval ...` | Use a supported semantic/visual operation. There is no arbitrary-evaluation replacement. |
| `action done` | No equivalent is needed. Native actions own their activity and cancellation lifecycle. |

Legacy refs are not native refs. Take a fresh native observation when migrating.
Do not use the old action route as a fallback after a native refusal.
