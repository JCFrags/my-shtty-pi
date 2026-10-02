# Pi-SelfReload

A model-callable `self_reload` tool for the agent's own interactive Pi session. It uses the same native reload handler as `/reload`. It does not type into the terminal, restart Pi, or control another pane.

## Install

Requires Pi 0.99.1 or a later compatible release, in TUI mode. Pi supplies the host modules. No build or package-local dependency installation is needed.

From this repository:

```sh
pi install "$PWD/packages/pi-self-reload"
```

An existing session needs one manual `/reload` to load this new tool. First wait for work and managed jobs to settle and preserve any editor draft. New Pi sessions load it at startup.

## Use

Ask the agent to reload itself, or call:

```json
{"action":"reload"}
```

The tool name is `self_reload`. Omitting `action` also requests reload. Use `{"action":"status"}` to read the loaded version, instance ID, source SHA-256, and pending state without reloading.

The operator command `/self-reload` uses the same safety checks. `/self-reload status` shows the loaded identity. The built-in `/reload` remains unchanged.

1. Save task state and check background jobs before requesting reload.
2. Call the tool alone as the final action in the run.
3. Wait for Pi's native `Reloaded keybindings, extensions, skills, prompts, themes, and context files` notification. A queued tool result is not proof of completion.
4. On the next user turn, use `self_reload` with `action: "status"`. A new instance ID proves a fresh factory loaded. The SHA-256 identifies the loaded source bytes.

The tool requests termination of the current run. Pi honors this after all tools in the batch agree to terminate. If other calls share the batch, reload still waits for the whole run, including automatic continuations, to become idle. There is no automatic model request after reload. Send the next instruction to continue work.

## Safety and limits

- Refuses an unsent editor draft or queued input. It never clears or replaces either.
- Checks the optional public `grounded:session-transition-readiness:v1` protocol before scheduling and again at idle. Running managed processes or open shell sessions block reload. If a `process` or `grounded_process` tool exists without a readiness reply, it fails closed.
- Cancels a pending request on session shutdown, tree navigation, session identity change, or an aborted caller signal. Requests exist only in memory and are not replayed after restart.
- Other extensions can stop their own resources during `session_shutdown`. The Grounded check is not a universal process detector. Inspect other session-owned jobs before use. The extension does not kill jobs to make a check pass.
- Print, JSON, RPC, and unbound SDK modes cannot request reload. Status remains available. Custom SDK hosts must explicitly bind TUI-equivalent idle and reload handlers for testing.
- Reload rereads configured resources. It does not install dependencies, build packages, update Git, migrate state, or guarantee every reloaded extension is healthy. Read native diagnostics. Stable compiled-module paths can retain cached code; follow the repository's [activation procedure](../../docs/activation.md).

## Implementation and checks

Pi's `ExtensionCommandContext` exposes `waitForIdle()` and `reload()`. A tool cannot use these methods directly. The tool dispatches the registered command with `sendUserMessage(..., { expandPromptTemplates: true })`, returns its result, and leaves the command waiting for idle. It never waits inside `execute()` and never uses the old context after reload.

The explicit expansion flag matters in Pi 0.99.1: extension-origin user messages are literal by default. `deliverAs: "followUp"` alone would send command text to the model instead of executing the command.

After repository-root locked dependencies are installed:

```sh
npm --prefix packages/pi-self-reload run syntax
npm --prefix packages/pi-self-reload test
```

The focused checks cover the tool-to-command handoff, idle wait, stale-context boundary, duplicate requests, and safety refusals. An installed-Pi lifecycle check is also needed before local activation. Factory inventory alone does not prove reload behavior.

See Pi's [extension documentation](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/docs/extensions.md) and [reload example](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/examples/extensions/reload-runtime.ts). The native `/reload` notification, not the example's queued message, is the completion signal.
