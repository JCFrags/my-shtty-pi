# User controls and tab recovery

[Product guide](../README.md) · [Native agent control](agent-control.md) · [Optional Pi menu](../pi-extension/README.md)

## Select a control mode

The native three-dot button opens full options. The control indicator opens only
control modes. The Ads indicator opens only blocking options. Escape or Dismiss
closes either quick menu without opening full options or changing control. Click
the same indicator to close its menu, or a different indicator to replace it.
The optional Pi package adds `/browser`, even when its model tools are not selected.
Both full menus provide Open/focus, Return control to agent, control modes, Send current page,
settings, and Close owned browser. Opening or canceling a menu does not select
Human. A menu holds focus while it is open.

| Mode | Behavior |
| --- | --- |
| Agent | Agent input is permitted. Active human input selects Human. |
| Human | Agent input and automatic page captures stop. Only an explicit choice returns control. |
| Shared | Both can use the browser. Active human input has brief priority. |
| Paused | Legacy explicit stop. Resume selects Agent. |

Shared reservations do not change the control epoch or erase observations.
Harmless pointer motion does not reserve input or cancel an agent operation.
Typing, clicks, drags, scrolling, and chrome editing reserve the affected input
resources. Known held keys and buttons stay reserved until release. Initial idle
windows are 350 ms for typing, 250 ms after pointer release, and 180 ms for wheel
input. Uncommitted agent input can wait up to two seconds within its deadline.

After waiting, the agent rechecks the target, document, frame, focus, and geometry.
A conflict can stop an operation that already delivered input. Held agent input
is released on its original route. The operation is not replayed. Inspect the
actual result before another action.

Terminal IME preedit is not reported. Native Kitty keyboard capability supplies
key-release reporting where available. Other terminals use a short typing-burst
fallback and cannot provide the same held-key guarantee.

```sh
terminal-browser agent status --session task-a --project /absolute/project
terminal-browser agent control --mode shared --control-epoch EPOCH \
  --session task-a --project /absolute/project
```

Use the current returned epoch, not the sample `EPOCH`. A real mode transition
invalidates earlier action state. Observe again before input. Never select Agent
or Shared automatically after Human takeover.

## Associate a receiver

One browser session can have one receiver. Association uses the exact owner,
browser session key, runtime instance, receiver session, and fresh generation.
A conflict refuses unless the user confirms replacement of the exact old binding.
A missing owner never falls back to a neighboring or latest browser. Owner IDs
route same-user processes. They are not authentication credentials.

The Pi menu stores an explicit association in the active Pi branch. A native CLI
owner can override pane-based Herdr ownership. Branch or session changes invalidate
the live receiver before cleanup. An inherited association is inert when the Pi
session does not match. Loading the package factory does not start a browser,
receiver wait, or model turn.

CLI consumers can use `session receiver status|bind|unbind`, `session updates`,
and `session events wait`. Read `session --help` for the exact flags. Pin
`--browser` and `--runtime-instance` for long-lived association. Bind returns the
binding ID and receiver generation used by later calls. Event waits last at most
30 seconds and do not hold the input queue. A metadata-only result does not create
a PNG file. Image output creates a new private file and refuses overwrite.

## Page updates and Send

Shared page updates are on by default but remain dormant outside Shared or
without an associated receiver. The settings menu shows the preference and its
active state. Human and Paused purge pending automatic pixels. Disconnect stops
the wait and discards pending data. Previously delivered pixels cannot be recalled.

Automatic updates are informational page captures, not observations or action
authority. The detector coalesces navigation, net scroll of at least 25% of the
visible viewport, and substantial paint changes. It uses settling windows and a
coarse pixel comparison. It keeps one latest automatic image and one in-flight
capture. It does not capture on a fixed interval. Continuous paint bursts are
suppressed until quiet. No waiting consumer means dirty state, not repeated PNGs.

The detector is heuristic. Unsupported frame geometry, closed shadow roots,
continuous canvas changes, and host occlusion can limit coverage. An internal
page PNG does not prove that the terminal displayed the same pixels.

Screenshots can contain private page data. The Pi receiver treats page data as
untrusted. Automatic updates do not edit the draft, paste into a terminal, or
start a reply. Pi appends bounded latest-only information at supported turn
boundaries. Models without image support receive a change notice and a stated
limit.

Send current page is a separate explicit user operation:

1. Choose link/title or viewport screenshot.
2. Review the current page and exact receiver.
3. Confirm Send and request reply.

The confirmation pins the preview's context ID and document generation. A changed
page or receiver refuses the share before or after capture. Human mode permits
this explicit capture without borrowing Agent mode, focus, frame selection, or
an observation token. The native service keeps one pending share separate from
automatic images. `queued` means pending in that service, not proof that a model
received it. The Pi adapter records each submission attempt before its message
API call. It does not retry an uncertain submission. A busy Pi receiver can queue
the confirmed request as a follow-up with prompt-template expansion disabled.

## Close one owned browser

The menu previews exact context IDs, titles, and active transfers. Confirm only
that scope. A changed preview requires another explicit choice. The close
coordinator selects Human, stops automatic captures, releases agent input, and
closes leaf popups before root tabs through native beforeunload-aware methods.

A refused close, pending dialog, new context, or unknown result stops the remaining
closes. Native dialogs remain separate explicit decisions. A partial close leaves
Human selected. It does not replay closes or resume agent control. Teardown occurs
only after the approved contexts actually close. Do not use daemon-wide shutdown
to close one owner.

```sh
terminal-browser session human close --preview \
  --session task-a --project /absolute/project
terminal-browser session human close --confirm REVISION \
  --session task-a --project /absolute/project
```

Use the revision from the exact preview. Unsaved page work can be lost.

Ad-blocking settings are profile-wide, not owner-local. The human settings path
can change them without resuming Agent. Read the displayed scope before a change.

## Recover root-tab routes

An explicit launch URL wins. An ordinary URL-less owned launch loads only its
exact recovery metadata and offers an inert Restore/Fresh choice in Paused mode.
It does not navigate to saved URLs or overwrite them before the choice. It never
uses another owner's snapshot or the global last URL.

```sh
terminal-browser session recovery status --session task-a --project /absolute/project
terminal-browser session recovery restore --confirm REVISION \
  --session task-a --project /absolute/project
# Or choose fresh from that same current preview:
terminal-browser session recovery fresh --confirm REVISION \
  --session task-a --project /absolute/project
```

Restore creates fresh context IDs. It loads the selected retained page and keeps
other safe URLs dormant until selected. Excluded entries remain `about:blank`
placeholders. Fresh discards only this exact owner's prior snapshot and opens
the ordinary default. Neither choice resumes agent control.

Recovery stores at most 32 ordered ordinary root-tab URLs, their active index,
and schema/key/time metadata. The key includes the exact owner, canonical project,
physical profile, and effective persistent partition. The private file is bounded
to 96 KiB, each URL to 2048 characters, and retention to 30 days. Files use mode
0600 in a physical mode-0700 directory. Invalid, expired, or mismatched data does
not fall back to another key.

Ordinary HTTP(S) paths remain useful. Every query is removed. Only bounded hash
routes beginning `/` can remain. Known authentication/callback markers,
userinfo, malformed encoding, sensitive routes, and long token-shaped path
segments become fixed inert placeholders. These filters are conservative
heuristics, not complete secret detection or a guarantee of read-only navigation.
Private routes can still identify content. Review retained routes before Restore.

Recovery does not store titles, popups, forms, cookies, credentials, page memory,
sessionStorage, observations, actions, dialogs, or download state. App, SSH,
SOCKS-proxy, and custom preload/main-script sessions are outside this version.
Non-web root URLs become inert placeholders rather than restorable routes.
Committed root-tab URLs and order are saved with a short debounce. Confirmed
individual deletion saves promptly, including an empty set after the last tab.
Whole-browser or terminal teardown freezes the current set so teardown removals
do not replace it with empty. A partial or refused close records the actual
remainder after the close guard settles. Abrupt death can lose the debounce window.

## Authentication is separate

A synthetic HTTP loopback check on the patched Electron 43.3.0 artifact observed
persistent cookies and localStorage across an orderly same-profile daemon restart.
Session cookies were shared across independent owners and a companion reopen
while that daemon stayed alive, but ended with daemon exit. sessionStorage survived
only the original tab's reload. A short-expiry cookie expired without reseeding.
Closing the last companion caused natural exits well before the source's
15-second idle timer. That timer is not a reliable session-cookie grace period.

These observations do not diagnose a site's MFA or server-side login lifetime.
They do not establish HTTPS/cross-site behavior, crash durability, or an immediate
write/exit race. URL recovery does not restore a login or extend a session cookie.
No authentication, credential, or cookie-persistence policy changes follow from
these findings.
