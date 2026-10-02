# Pi Herdr Orchestrator

Run and manage direct-Herdr Pi agents on Linux. Roots use `orchestrate`. Managed children use only `subagent_channel`, with the exact run ID and assignment generation from their assignment.

The package has no broker, CLI, authentication service, model-policy settings, scheduler, or workflow engine. `/agent-settings` is not registered. The Herdr plugin ID is `pi.herdr.orchestrator`. Its manifest has a build hook, but no startup hook or managed panes.

## Fresh setup

Use a full checkout at any local path. The private repository root is not an all-in-one Pi package. An orchestration tarball alone is not a supported installation: the runtime needs this checkout's sibling `pi-tool-controls/presentation` library and root dependency tree. Importing that library does not activate the inactive Tool Controls extension.

Prerequisites:

- Linux, Git, npm, Node.js >=22.19.0, Pi, and Herdr >=0.8.2. Repository verification uses Node.js 24.18.0 and locks Pi/TUI 0.85.1. Check the installed versions rather than infer compatibility from the open peer ranges.
- A working Herdr Pi integration. Its `pi` agent command must start the intended Pi executable in interactive terminal UI (TUI) mode.
- Herdr Agent State loaded exactly once in both parent and children. It publishes the native Pi session identity required by child validation. Print, JSON, RPC, or SDK factory checks do not provide that TUI reporting.
- Working Pi provider authentication and a default model in the settings used by Herdr's children. Authenticate through Pi's supported login or provider setup. Do not copy credentials into this checkout.

For a new installation with no existing Agent State or orchestration registration:

```sh
git clone https://github.com/JCFrags/my-shtty-pi.git
cd my-shtty-pi
npm ci --ignore-scripts --no-audit --no-fund
npm --prefix packages/pi-herdr-orchestrator ci --ignore-scripts --no-audit --no-fund
npm --prefix packages/pi-herdr-orchestrator run typecheck
npm --prefix packages/pi-herdr-orchestrator run build
npm --prefix packages/pi-herdr-orchestrator test
pi install "$PWD/packages/herdr-agent-state"
pi install "$PWD/packages/pi-herdr-orchestrator"
herdr plugin link "$PWD/packages/pi-herdr-orchestrator" --enabled
node scripts/local-activation-check.mjs --expect-orchestrator
```

If Herdr already installed an automatic Agent State extension, keep one reporting owner instead of adding a duplicate. For an existing installation, use [operations](docs/operations.md) and [scoped activation](../../docs/activation.md#retained-roots-and-orchestration), not these additive install commands.

`pi install` on a local path only registers that path. It does not copy source, install dependencies, or build `dist/extensions/pi-herdr-orchestrator.js`. Keep the full checkout and its prepared dependency trees available. Herdr plugin linking does not replace these build steps or load the Pi extension into a running process.

Start a fresh parent Pi agent through Herdr's configured `pi` command. For an existing pane, the CLI form is `herdr agent start NAME --kind pi --pane PANE_ID`. Do not force print, JSON, or RPC mode. Herdr must supply its socket, workspace, tab, and pane context.

Children start with Herdr's `pi` defaults. They do not inherit the parent's current model, CLI extension arguments, or in-session settings changes. Configure the executable, model, authentication, and resources for that command before delegation. `PI_BIN_PATH` controls only the version probe, not the child executable. A one-off `pi -e` parent does not configure children.

Keep `HOME`, `PI_CODING_AGENT_DIR` when customized, and the XDG environment consistent between the Herdr server, parent, and children. A variable set only in the parent shell need not reach a child started by the server. Use an absolute `XDG_STATE_HOME` if you override state storage. There is no `PI_HERDR_STATE_DIR` option.

## Worker capacity

Open `/subagents` in a root Pi TUI to change total workers and workers per tab. Defaults are **8 total** and **4 per tab**. Each setting accepts an integer from 1 to 32. This supported configuration range is not a hardware or provider capacity guarantee. A per-tab value above the total does not increase the total.

The preferences apply to each parent/project domain, not to the whole computer. Completed workers retained for reuse still occupy capacity. New workers use additional owned tabs when a tab is full. Lowering either setting does not move or terminate existing workers, and does not prevent their reuse, supervision, or result collection. Close an unneeded worker explicitly to release its capacity.

The menu edits a draft. Save applies both values, while Cancel or Escape leaves the saved preferences unchanged. These settings do not select child models or change Herdr's Pi command. See [operations](docs/operations.md) for persistence, wait limits, and recovery.

## Verify actual use

The loader assertion requires one root `orchestrate` and `/subagents`, no child channel, and no `/agent-settings`. It does not require Project Glance. It does not start a session, exercise native session reporting, or send a model prompt.

In the fresh Herdr parent, ask Pi to:

1. Call `orchestrate` with `action: "health"` and confirm `ok: true`.
2. Run one harmless child assignment that reports progress, sends a parent message, and explicitly completes through `subagent_channel`.
3. Wait for that run, then explicitly collect its final result. Use the returned IDs, not guessed names.
4. Reuse the settled worker for one more harmless assignment, collect it, and close only that owned worker after Herdr reports it settled.

Confirm that the child has `subagent_channel`, not `orchestrate`, and that Herdr reports its exact native Pi session. Completion does not close the worker. A successful tool call or an idle pane is not explicit completion. This practical check uses the configured model and can incur provider cost. [Operations](docs/operations.md) covers safe updates, cancellation, diagnostics, and rollback.

## Development checks

After the locked installs above:

```sh
npm --prefix packages/pi-herdr-orchestrator run typecheck
npm --prefix packages/pi-herdr-orchestrator run build
npm --prefix packages/pi-herdr-orchestrator test
```

Tests cover the model-free Pi lifecycle, child restore, exact tool catalogs, compact display, startup diagnostics, and M10 ordering, migration, cancellation recovery, and bounded waits. Their fake Herdr fixture is not live acceptance. Run the [root verification workflow](../../README.md#verification) against indexed changes for repository delivery.

To exercise the existing child lifecycle fixture with an installed SDK instead of the locked Pi peer:

```sh
cd packages/pi-herdr-orchestrator
ORCHESTRATOR_TEST_SDK_ROOT=/path/to/pi-coding-agent node --test --test-name-pattern='managed child lifecycle' checks/lifecycle.test.mjs
```

Pi supplies its canonical peers at extension load time. The helper's own dependency resolution must also work. `dist/` is generated, excluded from Git, and built from the extension and direct `src/orchestrator/` modules. Package archives do not include the lockfile despite the manifest allowlist.

## Further reading

- [Architecture and source map](docs/architecture.md): ownership, durable state, role selection, and dependency boundaries.
- [Operations](docs/operations.md): finite waits, result collection, startup refusals, display limits, activation, and recovery.
- Existing MIT attribution remains in [LICENSE](LICENSE).
