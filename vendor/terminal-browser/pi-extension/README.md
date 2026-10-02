# Pi browser menu and optional tools

The native `terminal-browser` CLI is the default for Pi and other agents. This
package adds the human `/browser` menu and an exact-session page receiver. The
existing five model tools are optional. Every browser operation uses the same
artifact's native CLI. There is no second input backend, terminal paste, or Pi
editor replacement.

Read the [product guide](../README.md), [installation guide](../docs/installation.md),
and [native control guide](../docs/agent-control.md) for the backend contract.

## Select package resources

The package declares two resources, in this order:

1. `dist/menu.js`: `/browser`, receiver lifecycle, and one loaded-identity receipt.
   It registers no model tools.
2. `dist/extension.js`: the existing five model tools only. It registers no
   command, receiver, or lifecycle receipt.

The supported package source is the exact retained versioned directory:

```text
/absolute/install/releases/ARTIFACT_ID/terminal-browser/pi-extension
```

Use Pi's package filters to select command-only operation:

```json
{
  "source": "/absolute/install/releases/ARTIFACT_ID/terminal-browser/pi-extension",
  "extensions": ["dist/menu.js"]
}
```

The plain pattern is an allowlist. `+dist/menu.js` alone force-includes the menu
but also leaves the other declared resources enabled. It is not command-only.

For the menu and all five tools, omit `extensions` or select both resources:

```json
{
  "source": "/absolute/install/releases/ARTIFACT_ID/terminal-browser/pi-extension",
  "extensions": ["+dist/menu.js", "+dist/extension.js"]
}
```

Merge the selection into the existing `packages` entry. Do not add a duplicate
package or replace unrelated settings. `extensions: []` disables both resources.
A tools-only filter does not load the menu. Direct tools-entrypoint loading is not
the supported complete profile. See the installation guide for managed filter
migration.

"Command-only" means no browser model tools, not no Pi extension. A skill cannot
register `/browser`. Loading a CLI skill alone does not load this package.
`--no-extensions` or an explicit resource exclusion also removes the command.
Pure CLI installation must not change Pi settings automatically.

The package has no declared skills, prompts, or Pi host. Resource changes need a
fresh Pi process or an approved reload of an idle session with a safe draft state.
Selection alone does not prove loaded activation. The menu's receipt reports the
menu entrypoint, compiled closure, and registered tool inventory separately.

## Associate an exact owner

An arbitrary native CLI session name need not match Pi's session ID. A Herdr pane
also does not identify a live Pi conversation. The adapter does not infer either
association.

1. Run `/browser`, then choose Settings and Owner association.
2. Choose This Herdr pane only when its complete coordinates are available, or
   choose Native CLI session and enter its exact launch session ID and project.
3. Check the owner, fixed launch project, browser-session key, and runtime shown
   before attaching. A native association overrides Herdr routing.

A missing owner can be saved for a later explicit launch, but is not attached by
fallback. Outside Herdr, launch the selected owner in a separate visible terminal:

```sh
terminal-browser open https://example.com --session browser-demo --project /absolute/project
```

Then choose Open/focus or Reconnect receiver in `/browser`. Pi never launches a
foreground browser into its own piped terminal. Focus the browser terminal
manually outside Herdr. Herdr uses its exact-owner companion launch/focus route.
Changing Pi's cwd does not change the browser's fixed launch project.

Only the explicit versioned association is saved as branch state. The saved Pi
session ID and storage file must match. Forked or copied history does not attach
a receiver to another conversation. Ordinary transcript appends do not rotate a
receiver. Session start and actual tree navigation create a fresh generation.
Switch, fork, tree, reload, shutdown, and disconnect invalidate locally before
asynchronous cleanup. A canceled transition can leave the link paused. Choose
Reconnect receiver instead of guessing that the old association remains live.

A conflicting receiver requires confirmation of that exact binding before
replacement. Disconnect this Pi receiver leaves the browser open. Routing IDs
are not authentication against other same-user processes.

## Human menu

| Item | Behavior |
| --- | --- |
| Open/focus browser | Open or reuse only the selected owner, without implicit navigation. |
| Reconnect receiver | Bind the exact current Pi session and browser runtime. Confirm any conflicting binding. |
| Return control to agent | Explicitly select Agent with the current control epoch. No reply or action replay. |
| Control mode | Agent, Human, or Shared. Legacy Paused remains visible until changed. |
| Send current page | Preview link/title, choose link or screenshot, then confirm a reply request. |
| Settings | Owner association, Shared page updates, and profile-wide network blocking. |
| Close owned browser | Confirm every context ID/title and the transfer scope, then request orderly close. |

Opening or canceling the menu does not select Human. Agent and Shared allow agent
operations. Human and Paused do not. Shared input arbitration can wait for human
input without changing the mode. Return control does not edit the Pi draft, paste
terminal text, send Enter, or start a model turn.

Shared page updates are On by default but dormant outside Shared. The menu labels
this choice: screenshots go to this Pi conversation and do not start a reply.
Turn updates Off or select Human to stop automatic delivery. Blocking enable/disable
and site exceptions affect the shared browser profile, including other owners.
The human settings path does not resume Agent control.

Close uses the native exact-scope preview revision. It closes only the owned
session through beforeunload-aware methods, not daemon shutdown or force destroy.
Native beforeunload decisions remain in the browser. A refusal, unknown outcome,
or new context stops the remainder. Already closed pages cannot be restored by
this operation. Partial close leaves control with Human. There is no automatic
retry or resume.

## Passive updates and explicit Send

The receiver uses one bounded native long-poll wait, not a screenshot timer. It
pins owner, browser-session key, runtime instance, binding, Pi storage identity,
and a fresh receiver generation. PNG files are private, limited to 2 MiB, read
only when visual metadata is present, and removed after reading.

Automatic events contain capture provenance and pixels, not URLs, titles, page
text, refs, or observation tokens. Page information is untrusted data, not action
authority. The Pi side retains only the newest pending automatic event:

- While idle, append at most one passive custom message between ordinary requests.
- On the next ordinary `before_agent_start`, attach the newest pending image to
  the request that the user already started.
- While busy, append the newest pending image at `turn_end`, after tool results.
  The boundary entry does not request continuation.
- A context filter retains only the latest automatic image for the live capture
  context. It preserves explicit shares, other messages, and raw session history.

No automatic event calls `sendUserMessage`, changes the editor, or starts a turn.
Human/Paused, context changes, and receiver changes drop unsent automatic data.
The selected model must declare image support. Otherwise, Pi receives a bounded
change notice that explains that no pixels were supplied to the model.

Explicit Send is different. Both menus capture a bounded link/title preview,
then ask for confirmation. The share request pins that preview's context and
document generation. If the page changes, start a new explicit Send. The extension
does not retry the old one.

A confirmed native `human-share` event calls
`sendUserMessage(..., {deliverAs: "followUp", expandPromptTemplates: false})`.
The fixed human reply request and serialized untrusted site data use separate
content blocks. A busy Pi queues the reply after its current work. The draft is
unchanged. The extension records the attempt before the void API call and does
not retry an uncertain submission. "Queued in the browser" and "Submitted to Pi;
reply may be queued" are different states. Neither proves model receipt or a
completed reply. Already submitted pixels can remain in requests, history, and
exports. They cannot be recalled.

Native capture/change detection has heuristic and host-visibility limits. The
receiver does not establish that every visual change was captured, that hidden
windows are fully detectable, or that terminal IME preedit is available.

## Five tools, one native backend

| Tool | Native CLI operation |
| --- | --- |
| `browser_open` | Exact Herdr `companion open`, or attachment to the explicitly selected native owner |
| `browser_observe` | `agent observe`, including bounded locators, frames, semantic state, and private PNG capture |
| `browser_act` | One native input, navigation, wait, dialog decision, or project-confined upload |
| `browser_tabs` | Owned context/download list, open, activate, close, wait, or cancel |
| `browser_control` | Status, pause, explicit resume/mode selection, or network blocking |

The tools read the same explicit active-branch association as the menu. They use
Pi's sequential execution mode because they share an observation cache. Native
waits still use the backend's separate wait mechanism. Owner, storage, and branch
changes discard cached observations.

Use `browser_control` with `action: "mode"` and `mode: "agent"`, `"human"`, or
`"shared"` only for an explicit user choice. Mode selection clears cached
observations. Legacy `action: "resume"` means Agent and refreshes the observation.
Neither follows a failure automatically. All five tools treat Shared as eligible
for agent operations while retaining native input arbitration and epoch checks.

Observe before input and after page changes. Visual coordinates map through the
latest capture geometry. Scroll accepts deltas, not `ref`, `locator`, `x`, or `y`
target fields. Hover over the intended scroller first. Scroll uses the selected
frame and current native pointer position, or viewport center if no pointer
position exists. Its completion means input dispatch, not measured movement.

Typed/prompt text uses stdin, not process arguments. Visual tool results contain
Pi image blocks, without image bytes in text/details. Dialogs require an exact
cached dialog ID and explicit decision. Uploads/downloads retain fixed-project,
owner, and file restrictions. Cancellation stops the child CLI and later native
input, but does not undo a delivered side effect. Never replay an uncertain action.

For blocking, use `browser_control` with `action: "blocking"`. `blocking_action`
is `status`, `enable`, `disable`, `allow-site`, `block-site`, `clear-diagnostics`, or
`reload`. Site actions require an exact hostname or HTTP(S) URL. Mutations require
Agent or Shared and clear the observation cache. Enable/disable and exceptions
are profile-wide. `block-site` removes an exception. `reload` rebuilds the bundled
filter cache without fetching lists or reloading the page.

Do not mix direct CLI mutations with cached tool observations. Observe again
through the adapter after external changes. Neither route bypasses ownership,
human control, stale state, or file/network guards.

## Compatibility and development

The implemented host contract and development pins are Pi 0.99.1. Host packages
remain wildcard peer dependencies, as Pi's package contract requires. They are
not bundled runtime dependencies. Wildcards do not establish compatibility with
other Pi versions.

Read the installed Pi extension, TUI, package, session, message, and SDK docs before
changing lifecycle or message delivery. Pi 0.99.1 supports context-only boundary
entries. Its `sendMessage` with `triggerTurn: false` appends after tool results
when busy. `sendUserMessage` always starts or queues a turn and returns void at
the extension API. Do not replace those distinctions with editor/terminal input.

Source files compile to the eight-file JavaScript closure declared in
`src/identity.ts`. Artifact schema 3 verifies the ordered resources and this
closure. Schema 1/2 identity reads retain the old single-resource interpretation.
The menu owns one startup receipt and idempotent shutdown cleanup. Factory loading
starts no processes, waits, timers, or receipts. Without an explicit association
or dialog-capable UI, session startup starts no receiver.

From the browser workspace:

```sh
pnpm --filter pi-terminal-browser build
pnpm --filter pi-terminal-browser typecheck
pnpm --filter pi-terminal-browser test
```

The focused adapter/client checks use a substituted CLI and synthetic page data.
They cover tool registration, routing, Shared eligibility, passive coalescing,
explicit Send pins, and exact close confirmation. They do not establish a visible
browser, installed activation, beforeunload behavior, or full runtime acceptance.
The parent package-loader and distribution fixtures remain separate checks. See
[development](../docs/development.md) for those boundaries.
