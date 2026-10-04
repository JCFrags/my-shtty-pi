# Pi Reload

One extension, one model-callable `self_reload` tool, and one safety engine for the current interactive Pi session or local Pi agents. `/self-reload` and `/reload-all` use that same engine. Reload uses Pi's native handler, not terminal input or a process restart. The package name remains `pi-self-reload` for installation compatibility.

## Install

Requires Pi 0.99.1 or compatible later behavior, in TUI mode. Pi supplies the host modules. No build or package-local dependency installation is needed.

```sh
pi install "$PWD/packages/pi-self-reload"
```

Select only this package's entrypoint. When replacing a separate SelfReload package and explicit `extensions/reload-all.ts` registration, replace the package source and remove that exact explicit registration. Do not load both entrypoints. Preserve unrelated package order and settings. Follow the [activation procedure](../../docs/activation.md).

Existing sessions need one safe initial reload to load the unified extension. New sessions load it at startup. A loaded local SelfReload 0.2.0 tool can perform that bootstrap. The new factory consumes its same-session handoff once and continues only an active, noncancelled requesting run after the native handler returns. An idle legacy operator request does not gain a continuation.

## Model tool

The tool name remains `self_reload`. Defaults are `action: "reload"`, `scope: "self"`, and `resume: true`.

```json
{"action":"reload"}
{"action":"reload","scope":"all"}
{"action":"reload","resume":false}
{"action":"status"}
{"action":"status","scope":"all"}
```

Use the default single-session scope when loaded extensions, tools, or other reloadable resources are stale or inconsistent after a correction. Use `scope: "all"` for an approved local Pi extension rollout after the updated resources are installed. Pushing source alone does not install it. Reload does not build packages, install dependencies, repair arbitrary environment faults, migrate state, or certify resource health.

1. Save task state and finish useful background jobs.
2. Call reload alone as the last action. Mixed or nested tool batches are refused.
3. The tool returns a queued result with `terminate: true`. The native command waits for that exact successful terminating result and for the run to become idle. It does not abort its own executing tool or lose the result.
4. The shared engine reloads peers first for `scope: "all"`, then the caller. The fresh runtime can continue the requesting run once, only after the native reload handler returns. `resume: false` keeps the caller idle and does not disable a confirmed interrupted peer's continuation.
5. Check the loaded status and Pi's native reload diagnostics after the wake. A queued result is not completion. A fresh instance proves a new factory, not that every extension is healthy. Do not repeat an uncertain reload.

Status returns the loaded version, instance ID, engine source SHA-256, pending state, and mode. Fleet status also lists participating local processes. Status does not reload or start a model request.

## Operator commands

- `/self-reload` reloads only this session through the shared engine. An active run can resume once if this operation interrupted it. An idle or completed session stays idle.
- `/self-reload --no-resume` disables the caller's continuation.
- `/self-reload status` shows the loaded identity.
- `/reload-all` reloads participating local Pi agents and the caller last.
- `/reload-all status` lists participants. The built-in `/reload` remains unchanged.

The private same-user Unix sockets work without Herdr, including for Pi sessions outside Herdr. They do not cross machines or OS users. Unloaded, exited, RPC, JSON, and print sessions do not participate. Participant count is not total Pi process count. The extension never types into an old session to bootstrap it.

For a peer or operator-command request, the engine checks the current native state. It captures a live nonaborted agent signal immediately before native abort and confirms that this operation changed that signal to aborted. A run that already ended or was already cancelling gets no wake. A model-tool request instead proves ownership through its exact successful terminating tool result. These are separate stop mechanisms in the same engine.

## Safety and limits

- Drafts, queued input, reported questions or approvals, other executing tools, managed jobs, and open shell sessions block or skip reload. The engine checks again at idle. It does not clear input, answer questions, force-kill tools, or relaunch jobs.
- The optional `grounded:session-transition-readiness:v1` event reports managed process and shell-session counts. A loaded `process` or `grounded_process` tool without a valid response fails closed. This protocol and extension prompt events do not cover every third-party resource or core dialog. Inspect other session-owned work before use. Other extensions can stop resources during `session_shutdown`.
- New input, tree navigation, cancellation, expiry, or a session change suppresses continuation. The process-local handoff is claimed once and never replays after restart or an unrelated reload. Idle/completed peers never receive a broadcast continuation.
- The caller tool run and each native stop have 15 seconds to settle. Peer connections have a 30-second deadline. A timeout or missing fresh-runtime acknowledgement is unconfirmed, not permission to retry. Fleet `last-result.json` stores local identities and outcomes, never prompts.
- Reload requires interactive TUI bindings. Status remains available in other modes. An SDK test host must explicitly bind TUI-equivalent idle and reload operations.
- Stable compiled-module paths can retain cached code. Use the repository's scoped activation procedure and check native diagnostics. Native Pi can catch late reload errors without rethrowing them.

The default private socket directory is `pi-reload-all-<uid>` below the OS temporary directory. It has mode `0700`, and sockets have mode `0600`. Set an absolute `PI_RELOAD_ALL_DIR` before startup to isolate a test or separate fleet. Each member must use that same directory. A private lock prevents competing fleet operations. After a coordinator crashes, prove its recorded process is gone before removing only its stale `fleet.lock`. Never remove another live owner's lock.

## Implementation and checks

`extensions/index.ts` only re-exports the unified `reload-all.ts` factory. There is no separate single-session engine. That factory owns the model tool, both commands, readiness checks, peer sockets, and one-shot handoff.

The tool dispatches a native command with `sendUserMessage(..., { expandPromptTemplates: true })`. Explicit expansion is required in Pi 0.99.1. The tool never waits for its own command. Only command contexts expose `waitForIdle()` and `reload()`. After reload invalidates the old runtime, the old code uses only plain completion and receipt data, never its old `pi` or `ctx`.

After repository-root locked dependency preparation:

```sh
npm --prefix packages/pi-self-reload run syntax
npm --prefix packages/pi-self-reload test
```

Focused checks cover tool dispatch and termination, idle waits, stale-context boundaries, duplicate requests, fleet interruption ownership, and safety refusals. An installed-Pi tool-driven lifecycle check is needed before activation. Factory inventory alone does not prove reload behavior.

See Pi's [extension documentation](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/docs/extensions.md). Require its native `Reloaded keybindings, extensions, skills, prompts, themes, and context files` notification and available diagnostics rather than treating a queued tool message as completion.
