---
name: terminal-browser
description: Use when an agent must inspect or interact with a website or local HTML in a visible terminal browser, manage browser tabs or downloads, or recover from stale observations or human takeover. Covers the native CLI for Pi and other agents, plus optional Pi tool adapters.
---

# Terminal browser

Use the native `terminal-browser` CLI by default, including from Pi. Pi native
browser tools and Herdr pane management are optional adapters to the same backend.
Do not use legacy `terminal-browser action` or a separate CDP client to bypass
ownership, observations, human control, or file restrictions.

## Start or reuse an owned browser

1. Choose one stable, non-secret session ID for this agent task. Use a different
   ID for each concurrent owner. Record the ID and the absolute project path.
2. In a visible terminal, run:

   ```sh
   terminal-browser open https://example.com --session task-a --project /absolute/project
   ```

   This occupies that terminal. Use another pane for the agent. Add
   `--split right` only when the terminal adapter supports splits. Do not run a
   foreground browser in a piped tool call or take over the agent's terminal.
3. Use the same `--session` and `--project` on each native command. Never select
   an arbitrary browser from `ls --all` as a fallback for missing ownership.
4. Read `terminal-browser agent --help` and `terminal-browser session --help` for
   the installed command contract. Launch does not run setup or install skills.

## Observe, act, and inspect the result

```sh
terminal-browser agent observe --session task-a --project /absolute/project --max-elements 120
```

The JSON result supplies `contextId`, `observationId`, and `controlEpoch`. A control
epoch is a counter that invalidates commands when control changes. Do not invent
or reuse old values. Use a returned element ref or a unique native locator:

```sh
terminal-browser agent click e1 --session task-a --project /absolute/project \
  --tab 7 --observation OBSERVATION_ID --control-epoch EPOCH
```

Replace every sample target and state value with the current observation. Use
one action per call. Observe again after page changes, navigation, context/frame
changes, resize, or an interrupted action. Inspect whether the requested effect
already occurred before choosing another action. Never automatically replay an
uncertain click, edit, upload, or download.

- Use `--locator-json` with bounded AgentCursor steps when a ref is unsuitable.
  Ambiguous targets fail. Narrow the query rather than choosing a hidden match.
- Select a reported frame with `agent observe --frame f2`. Use `--frame main` to
  return. Drag stays inside one selected frame. Closed shadow roots and transformed
  frame owners are not general-purpose fallbacks.
- For text, prefer `agent type ... --stdin` over putting private text in process
  arguments. `--replace` performs one native edit.
- Visual observation uses `--view visual` or `--view both` and
  `--image-output /absolute/new-file.png`. Load the PNG through the agent's image
  reader. JSON geometry is not a substitute for seeing the image. The CLI creates
  a new private file and refuses overwrite. Captures can contain private content.
- Native input uses slow-natural AgentCursor motion. Preparation can wait for a
  target, but it does not authorize a repeated side effect.

## Human control and cancellation

Read `agent status` before diagnosing a blocked action. Agent mode permits agent
input. Human mode stops agent input and automatic page updates. Shared mode permits
both and gives brief priority to active human typing, clicks, drags, or scrolls.
Pointer motion alone does not change control. Reservations do not change the epoch.
Terminal IME preedit is not available. Known held inputs remain reserved until
release. Terminals without key-release reporting use a short typing-burst fallback.

Use the returned epoch for `agent control --mode agent|human|shared --control-epoch EPOCH`,
`agent pause --control-epoch EPOCH`, or an explicitly requested `agent resume`.
Resume explicitly selects Agent. Never return from Human automatically. Observe
again after a real mode change. A Shared wait or an input error does not authorize
replay of a possibly delivered action.

Cancellation or CLI disconnection stops later input and releases held keys and
buttons. It does not undo input already delivered. Errors are not instructions
to retry. Preserve startup diagnostics and use `terminal-browser doctor --json`
for read-only diagnosis. Do not delete sockets or profile locks to force recovery.

## Contexts, dialogs, and files

Use `session tabs --action list` with the same owner flags to read context IDs.
Use `open`, `activate`, or `close` deliberately. `wait --after-id ID` is bounded
and does not hold the input queue. Popups keep their opener relationship.

Dialogs never auto-accept. Use the exact dialog ID, context ID, and epoch from
observe or an interrupted action, then give an explicit `--accept` or `--dismiss`
to `agent dialog`. A prompt response can use `--stdin`. A timeout dismisses the
dialog. Observe again after responding.

Uploads require a visible chooser trigger and 1–16 regular files under the fixed
launch project, at most 32 MiB each and 64 MiB total. Project escapes, symlink
escapes, and conventional secret paths fail. This is not a file-content secret
scanner. Review files before sending them. Changing cwd does not change the
launch project. Reopen with the intended owner/project instead.

Use `session tabs --action downloads` to inspect transfers, and
`download_wait` or `download_cancel` with an exact `--download-id`. Downloads
stay under `.terminal-browser-downloads` in the launch project, do not overwrite
existing files, and are never opened or executed automatically. A click can be
interrupted while its transfer still starts. Check the download list first.

## Network blocking

`agent blocking status` uses the same session/project owner and optional `--tab`.
Blocking is enabled by default and uses a bundled, SHA-pinned EasyList snapshot
with Ghostery's core engine. It does not download lists at runtime, send telemetry,
inject cosmetics/scriptlets, or block the main document. This is not a complete
tracker, malware, or anonymity boundary.

`enable`, `disable`, `allow-site`, `block-site`, `clear-diagnostics`, and `reload`
require the current `--control-epoch`. Site actions also need `--site HOST`.
Enable/disable and exact-host exceptions are profile-wide. Change them only for
the requested scope. Diagnostics are bounded to the selected context and omit
full request URLs. `reload` rebuilds the bundled filter cache; it does not fetch
updates or reload the page. Check `effective` and `warning`, not just `enabled`.
Use a reviewed release to update lists. For a site failure, inspect status and
make an explicitly requested site exception instead of disabling every safeguard.

## User menus and page delivery

The native three-dot menu and optional Pi `/browser` menu provide explicit control
choices, Send current page, settings, and exact owned-browser close. The control
indicator opens only control modes. The Ads indicator opens only blocking options.
Escape or Dismiss closes either quick menu without changing control or opening
full options. Pi's command-only package profile uses the plain
`extensions: ["dist/menu.js"]` allowlist. It keeps `/browser` and registers no
browser model tools. A bare package source or
`+dist/menu.js` alone also loads the tools resource. Do not change package settings
unless the user requests that change.

Opening or canceling a menu does not select Human. Send previews the current page
and receiver and asks for confirmation. It can request a reply. Do not use terminal paste or
another agent's draft to deliver a page.

Shared page updates send coalesced informational screenshots to one explicitly
associated receiver. They do not start a reply or provide action tokens. Human
and Paused stop automatic capture. Screenshots can contain private data. Explicit
human capture remains separate from agent observation.

Use `session receiver`, `session updates`, `session events`, and `session human`
only with the exact owner, browser key, runtime, binding, and generation from fresh
status. A stale association refuses instead of choosing a neighbor. Read the
installed `session --help` for the full flag contract. Close requires the exact
preview revision. Native dialogs remain explicit decisions. Do not use daemon
shutdown to close one owner.

## Owner-private tab recovery

An ordinary URL-less owned launch can offer Restore or Fresh and starts Paused.
An explicit launch URL wins. Recovery retains bounded sanitized root-tab routes,
not cookies, forms, page memory, dialogs, downloads, or sessionStorage. All queries
are removed. Sensitive-looking routes become inert placeholders. The heuristic
is not a complete secret detector. Private routes can still identify content.

Preview with `session recovery status`. Use `session recovery restore|fresh
--confirm REVISION` only after choosing from that exact preview. Restore loads the
selected retained page and keeps other tabs dormant until selected. Neither choice
resumes agent control. Use the usual explicit control command only when authorized.
Never recover a different owner's snapshot or a global last URL.

## Optional Pi tools

Only an explicit tools-enabled profile loads `dist/extension.js` and the five
tools: `browser_open`, `browser_observe`, `browser_act`, `browser_tabs`, and
`browser_control`. The command-only menu does not require them. These tools
translate to the same native CLI. Pi caches observations and epochs and returns
visual observations as image content. `browser_control` with `action: "blocking"`
uses `blocking_action` for the same blocker commands. All ownership, takeover,
cancellation, and file restrictions still apply. Do not mix CLI mutations with a cached Pi tool
observation. Observe again through the adapter after changing browser state.

Loading this skill does not enable those tools. Do not install an extension or
change Pi settings merely because the tools are absent. Use the CLI default.

## Command reference
