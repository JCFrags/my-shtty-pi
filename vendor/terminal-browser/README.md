# terminal-browser

A Chromium browser displayed in a terminal, with a native CLI for human users,
Pi, and other agents. Agent input uses the pinned AgentCursor driver. Pi tools and
Herdr pane management are optional adapters. Neither is required for CLI use.

This is the maintained browser copy in `JCFrags/my-shtty-pi`, not the upstream
terminal-browser distribution. Do not use an upstream curl installer, Homebrew
package, or `upgrade` to update this installation.

## Install

Use a reviewed complete artifact and its matching outer manifest from this
repository. The default installation selects only the CLI. It does not edit Pi
settings, register a Herdr plugin, install a skill, or start a browser.

Download the installer archive, Linux x64 runtime archive, platform manifest, and
`SHA256SUMS` from the same trusted release. No checkout or pnpm is required. The
example uses version `0.2.3`:

```sh
sha256sum -c SHA256SUMS
tar -xzf terminal-browser-installer-0.2.3.tar.gz
MANAGER="$PWD/terminal-browser-installer/install.sh"
INSTALL="$HOME/.local/share/terminal-browser-managed"
"$MANAGER" init "$INSTALL"
"$MANAGER" stage "$PWD/terminal-browser-0.2.3-linux-x64.tar.gz" "$PWD/manifest-linux-x64.json" "$INSTALL"
# Use the artifact ID returned by stage after reviewing the selection.
"$MANAGER" activate "$INSTALL" ARTIFACT_ID
terminal-browser doctor --json
```

Checksums verify transfer integrity, not publisher authenticity. First installation
needs Node and Python 3.11+. Obtain those assets from this repository's reviewed
release, not a third-party installer.

See [installation, updates, and rollback](docs/installation.md) for prerequisites,
optional skills/Pi/Herdr, adoption, retained managers, and safe process replacement.
Staging does not activate anything. Activation changes next-launch selections,
not running processes. A successful build or changed link does not prove that the
running browser uses the change.

## Use the native CLI

Open an owned browser in a visible terminal:

```sh
terminal-browser open https://example.com --session task-a --project /absolute/project
```

This occupies that terminal. Run agent commands from another terminal or pane.
Add `--split right` only when the terminal's adapter supports it. Do not launch
an interactive browser over the agent's own piped input/output.

```sh
terminal-browser session tabs --session task-a --project /absolute/project --action list
terminal-browser agent observe --session task-a --project /absolute/project --max-elements 120
```

Use the returned target, `contextId`, `observationId`, and `controlEpoch` for one
action. The epoch is a counter that changes when control changes.

```sh
# Replace all sample target/state values with the latest observation.
terminal-browser agent click e1 --session task-a --project /absolute/project \
  --tab 7 --observation OBSERVATION_ID --control-epoch EPOCH
```

Observe again after a page change or interruption. Do not automatically repeat an
uncertain side effect or resume after human takeover. Use the same stable session
ID and launch project for every command. Do not route to another owner's browser
when lookup fails.

The [agent control guide](docs/agent-control.md) covers errors, images, frames,
locators, dialogs, cancellation, uploads, downloads, and migration from legacy
`action`. The generated [source skill](skill/terminal-browser/SKILL.template.md)
uses this CLI workflow for Pi and other agents. Launch no longer runs setup.

## User controls and recovery

The native three-dot menu and optional Pi `/browser` menu provide Agent, Human,
and cooperative Shared modes, explicit page delivery, settings, and scoped close.
The control indicator opens only control modes. The Ads indicator opens only
blocking options. Escape or Dismiss closes either quick menu without opening
full options or changing control. The three-dot button opens full options.
In native menus, clicks on inactive rows or menu padding keep the menu open.
Shared gives brief priority to active human input and can send coalesced page
images without requesting a reply. Human never returns control automatically.

An ordinary URL-less owned launch offers explicit paused Restore/Fresh recovery
from bounded private root-tab routes. An explicit URL wins. Recovery does not
restore cookies, page memory, forms, or sessionStorage. The route filter is a
heuristic, not complete secret detection.

Read [user controls and tab recovery](docs/user-controls.md) for the privacy
warning, exact receiver/preview boundaries, CLI commands, storage lifetimes, and
supported limits.

## Built-in network blocking

Network blocking is enabled by default. Ghostery's core engine uses a bundled,
SHA-pinned EasyList snapshot. Lists update through reviewed releases, not runtime
downloads. There is no blocker telemetry, cosmetic injection, scriptlet execution,
or main-document blocking. Settings and exact-host exceptions are profile-wide;
diagnostics are bounded to a browser context. This is not an anonymity guarantee
or complete tracker/malware defense.

Use `terminal-browser agent blocking status` with the same owner flags. Mutations
require current agent control and its epoch. See [blocking commands and limits](docs/agent-control.md#built-in-network-blocking)
before changing shared-profile policy.

## Optional integrations

The [Pi adapter](pi-extension/README.md) provides a command-only `/browser` menu
resource and five optional tools for users who explicitly choose them: `browser_open`, `browser_observe`, `browser_act`, `browser_tabs`, and
`browser_control`. These call the artifact's native CLI. They do not introduce a
second browser backend. The adapter manages observation and epoch bookkeeping
and returns PNG captures as Pi image content.

Herdr adds companion pane creation, focus, and reuse. The legacy
`companion open` and `companion tabs` commands remain its adapter interface.
Neither Herdr nor the Pi package is installed by the default CLI-only receipt.
Use installer opt-ins only when those host integrations are wanted.

## Supported environments and limits

| Area | Scope |
| --- | --- |
| Runtime acceptance | Linux x64 is the tested artifact path. Source build branches also exist for Linux arm64 and macOS x64/arm64, but this does not establish packaged or visible acceptance on those platforms. Windows is not supported. |
| Terminal graphics | Requires a real TTY and working Kitty graphics protocol support. Rendering in a terminal must be checked on that terminal. An internal Chromium capture is not proof of visible rendering. |
| Terminal adapters | Source adapters exist for Herdr, tmux, tty7, WezTerm, Kitty, cmux, Supacode, Ghostty, and VS Code. Detection or split support is not a claim that every terminal/version renders correctly. |
| Input | Native semantic and visual actions, bounded locators, root/popup contexts, and supported frames share the AgentCursor path. Closed shadow roots, transformed frame owners, and cross-frame drag are not generally supported. |
| Display scale | Scale is selected at startup. Moving a browser between mixed-DPI monitors was not established by the fixture checks. Pause and preserve transient work before a needed restart. |
| Host dependencies | The artifact contains patched Electron, its native rendering module, and runtime assets. Linux system libraries remain required. The installer needs Node and Python. Optional Pi and Herdr are separate host applications. |

Run `terminal-browser doctor --json` for read-only identity, selection, process,
profile-lock, and graphics diagnostics. Unknown is not absent. Do not delete an
uncertain lock/socket, replay a failed mutation, or replace a shared daemon as an
automatic repair.

## Source, verification, and releases

Build and test in this directory's separate pnpm workspace, not the root npm
workspace. Read the [development and release guide](docs/development.md) for native
prerequisites, pinned inputs, complete artifacts, and test limits. Product release
tags use `terminal-browser-vVERSION`, separate from the parent repository's tags.
No claim is made that a source tag has a published artifact until that artifact
and its manifest are available.

This copy originated from `JCFrags/my-shtty-pi-web` and retains its browser,
AgentCursor integration, Rust renderer, CLI, optional adapters, assets, and tests.
[Copy provenance](copy-provenance.json) records the import and maintained changes.
[Upstream pins](upstreams.lock.json) record external runtime inputs. WebX search/read,
research loaders, and unrelated web services are not part of this browser.

Fork contributions use this repository's instructions and checks. The inherited
upstream rule requiring human-authored PR descriptions does not apply here.
Changes to terminal adapters belong in `terminals/src/terminals`; use the existing
implementations and verify the actual terminal behavior before claiming support.

The [browser license](LICENSE), [font license](assets/fonts/LICENSE.txt), and
[bundled dependency notices](assets/licenses/) retain their own terms.
