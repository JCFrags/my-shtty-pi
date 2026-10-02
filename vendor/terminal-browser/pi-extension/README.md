# Optional Pi adapter

The native `terminal-browser` CLI is the default for Pi and other agents.
This package is an opt-in adapter for five model-callable Pi tools. It spawns the
same artifact's native CLI and adds observation/epoch bookkeeping and Pi image
results. It does not connect directly to CDP, inject a second browser backend,
or install/start Pi or Herdr.

Read the [product guide](../README.md), [installation guide](../docs/installation.md),
and [native control guide](../docs/agent-control.md) for the backend contract.

## Select or omit the package

The managed installer's default receipt is CLI-only. Add `--pi-settings` during
fresh initialization only if the user wants these native tools. A separate
`--skill` selection installs CLI-first instructions without loading this package.
Neither launch nor this package auto-installs skills.

The selected package source is the exact retained versioned directory:

```text
/absolute/install/releases/ARTIFACT_ID/terminal-browser/pi-extension
```

For one invocation, Pi supports an explicit package path:

```sh
pi -e /absolute/install/releases/ARTIFACT_ID/terminal-browser/pi-extension
```

Do not add an additional path if the same package is already selected. A second
version can cause duplicate tool registrations. Pi settings can narrow the existing
package entry through supported resource filters:

```json
{
  "packages": [
    {
      "source": "/absolute/install/releases/ARTIFACT_ID/terminal-browser/pi-extension",
      "extensions": []
    }
  ]
}
```

This example disables the adapter but preserves the managed source entry. To opt
in, select `"extensions": ["+dist/extension.js"]` or omit the filter. Merge the
change into the existing settings entry, preserving other packages and filters.
The managed installer preserves these filters during version changes. The package
contains no declared skills, prompts, or Pi host. Do not rewrite all settings to
match this minimal example.

Resource changes take effect in a fresh Pi process or an explicitly approved
reload of an idle session with a safe draft state. Selection alone does not prove
that a currently running Pi process loaded that artifact. Doctor's loaded receipts
and a real tool call provide separate evidence.

## Launch and ownership

With a complete Herdr pane identity, `browser_open` uses `companion open` and
`browser_tabs` uses `companion tabs`. Other operations call `agent`. The existing
pane owner and fixed launch project restrictions remain in force. Incomplete
Herdr identity is a refusal, not a fallback to another owner's browser.

Without Herdr, the adapter uses the current Pi session ID and cwd as explicit
`--session`/`--project` arguments. It only attaches to an already launched owned
browser. It never tries to take over Pi's piped terminal. For a predictable setup,
start a browser in one visible terminal:

```sh
cd /absolute/project
terminal-browser open https://example.com --session browser-demo --project /absolute/project
```

Then start Pi from the same project in another terminal:

```sh
cd /absolute/project
pi --session-id browser-demo -e /absolute/install/releases/ARTIFACT_ID/terminal-browser/pi-extension
```

Do not use that session ID for another concurrent owner. If no owned browser
exists, `browser_open` reports the exact visible-terminal launch command for its
Pi session and project. It can then reuse the browser, navigate a supplied URL,
or open a requested new tab. Focus the browser terminal manually outside Herdr;
the `focus` option controls only Herdr pane focus. A supported CLI split is
available separately, not an automatic non-Herdr adapter fallback.

Changing the Pi session or cwd discards cached adapter observations. It does not
transfer a launched browser to a new owner or project. The native backend still
checks ownership independently. Reopen deliberately when a different launch
project is needed.

## Five tools, one native backend

| Tool | Native CLI operation |
| --- | --- |
| `browser_open` | Herdr `companion open`, or exact native-session attachment through `session tabs` and explicit navigation |
| `browser_observe` | `agent observe`, including bounded locators, frames, semantic state, and private PNG capture |
| `browser_act` | One native input, navigation, wait, dialog decision, or project-confined upload |
| `browser_tabs` | Owned context and download list/open/activate/close/wait/cancel commands |
| `browser_control` | Control status/pause/explicit resume and `agent blocking` commands |

The tools use Pi's sequential execution mode because they share a current
observation cache. Native browser waits still use the backend's separate wait
mechanism. Human takeover remains a backend control event, not a queued Pi tool.

Observe before input and after changes. Pi keeps observation IDs and epochs out
of the model-facing schemas but passes them to the CLI. Coordinate actions map
from the latest returned image into the current capture geometry. Typed/prompt
text goes through stdin, not CLI arguments. Visual results contain native Pi image
content; image bytes are omitted from text/details, and temporary capture files
are removed after reading.

Cancellation stops the child CLI, which disconnects from native input. A signal
already aborted before dispatch prevents child startup. Cancellation cannot undo
a side effect already delivered. State-change errors require a new observation,
not replay. New structured CLI errors preserve their code and actionable message;
startup errors preserve the full bounded startup report.

Use `browser_control` with `action: "resume"` only when the user explicitly asks.
Resume refreshes the adapter observation. It never follows a failure automatically.
Dialogs require an exact cached dialog ID and an explicit `accept` decision.
Uploads and downloads retain the native project and owner restrictions.

For blocking:

```json
{"action":"blocking","blocking_action":"status"}
```

`blocking_action` can also be `enable`, `disable`, `allow-site`, `block-site`,
`clear-diagnostics`, or `reload`. Site actions require `site`, an exact hostname
or HTTP(S) URL. Optional `context_id` selects diagnostics. Mutations obtain the
current epoch, require agent control, and discard the adapter observation.
Enable/disable and exceptions change the shared profile. They are not tab-only
preferences. `block-site` removes an exception; `reload` rebuilds the bundled
cache without fetching lists or reloading the page.

Do not mix direct CLI mutations with a cached adapter observation. Observe again
through the adapter after external changes. Neither route may bypass a human
pause, ownership refusal, stale state, or file/network guard.

## Compatibility and development

`package.json` uses `peerDependencies: "*"` for Pi host packages, as Pi 0.99.1's
package contract requires. Host modules are not bundled or installed as runtime
dependencies. This wildcard is not a claim that every Pi version was tested.
The development dependency pins remain at Pi 0.84.2.

Focused checks for this change passed:

- Build/typecheck and the adapter/client suite with the pinned 0.84.2 development
  host. The command runner is substituted in most behavior tests.
- The existing offline A/B/A package loader and lifecycle receipt fixture with
  the installed Pi 0.99.1 host, including fresh processes and one reused
  SettingsManager/ResourceLoader.

Those checks do not establish a visible production browser, non-Herdr terminal
rendering, or all-version compatibility. Full artifact/runtime acceptance is a
separate gate. The [development guide](../docs/development.md) lists those checks.

The source entrypoint is `src/extension.ts`, compiled to `dist/extension.js`.
The source launch mode calls the built source CLI. The release build generates
bundle mode, which calls the retained artifact's own launcher. Run source checks
from the browser workspace:

```sh
pnpm --filter pi-terminal-browser typecheck
pnpm --filter pi-terminal-browser test
TERMINAL_BROWSER_PI_ROOT=/absolute/pi-coding-agent node --test scripts/test/pi-reload.test.mjs
```

Read the installed Pi SDK/extensions/packages/skills docs for the actual host
before changing these boundaries. Keep runtime work out of the extension factory.
Loaded-identity receipts begin at `session_start` and have idempotent
`session_shutdown` cleanup. No source build, settings edit, or symlink change
alone proves activation.
