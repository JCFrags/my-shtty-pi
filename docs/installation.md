---
title: Portable extension installation
audience: [users, operators, agents]
status: installation procedure
purpose: Prepare individual extensions from one clean checkout without another installation's source or dependencies.
related:
  - activation.md
  - chrono/operations/activation-and-migration.md
---

# Portable extension installation

Install only the extensions you need. The repository root is not a Pi package.
A local `pi install` registration does not copy source, install dependencies, or
build compiled entrypoints. Keep the full checkout at its intended permanent
location. Local file dependencies need their sibling packages.

Do not copy another computer's `node_modules`, absolute settings paths, worker
authorizations, credentials, session files, or private route configuration.
Build native dependencies on the destination computer. For an existing
installation, use [scoped activation](activation.md) instead of appending
another registration for the same tool.

## Prerequisites

- Git, npm, and Node.js 24.18.0. Independent Memory and Notify use Node's built-in
  SQLite. The repository's locked development Pi/TUI version is 0.85.1.
  Check each package's peer range before choosing the host Pi version. A
  successful check on one later Pi version is not a general compatibility claim.
- Linux x64, Python 3, GCC/G++, Make, a user systemd manager, and cgroup support
  for the current Chrono worker/native-build path. Chrono is not a documented
  macOS or Windows installation. Other extensions have their own platform limits.
- Herdr for Agent State, Sidebar, Project Glance, and direct orchestration.
  Check the package manifest's minimum version. Direct orchestration needs a
  usable Pi command in Herdr's child environment, including the child's model
  and authentication. A parent-only command-line override does not configure it.
- Optional native tools: language servers for LSP, OpenSSH and Python 3 for SSH,
  and the GNOME Wayland portal/input stack for Pixel CUA. Read the selected
  package's configuration and permission requirements before use.

Pi extensions run with your operating-system access. Review the source before
installation. Install Pi through its supported package procedure. The commands
below do not upgrade a running Pi or Herdr installation.

## Prepare a clean checkout

Choose any private, non-temporary location. These commands use only that
checkout and its committed locks:

```sh
git clone https://github.com/JCFrags/my-shtty-pi.git
cd my-shtty-pi
ROOT="$PWD"
npm ci --ignore-scripts --no-audit --no-fund
```

The root lock prepares Grounded Tools and Context Kit workspaces. Do not run
separate installs inside those workspace subpackages. `core`, `protocol`, and
`state-store` are libraries, not Pi extensions. The inactive Tool Controls
extension supplies a pure presentation dependency but must not be registered.

Source-loaded extensions need no TypeScript build. Context Kit's shared protocol
needs its local build even when providers load source. For compiled extensions,
prepare only the packages you select:

```sh
# Context Kit shared protocol.
npm --prefix "$ROOT/packages/pi-context-kit/protocol" run build

# Project Glance.
npm --prefix "$ROOT/packages/pi-project-glance" ci --ignore-scripts --no-audit --no-fund
npm --prefix "$ROOT/packages/pi-project-glance" run build

# Direct Herdr orchestration.
npm --prefix "$ROOT/packages/pi-herdr-orchestrator" ci --ignore-scripts --no-audit --no-fund
npm --prefix "$ROOT/packages/pi-herdr-orchestrator" run build

# Notify runtime dependencies. There is no compilation step.
npm --prefix "$ROOT/packages/pi-notify" ci --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund
```

### Chrono native build

Prepare matching Node headers explicitly. This is separate from the controlled
build. Do not enable dependency install scripts or use another machine's binary
as a shortcut.

```sh
cd "$ROOT/packages/pi-chrono-compaction"
npm ci --ignore-scripts --no-audit --no-fund
HEADERS="$HOME/.cache/node-gyp/24.18.0"
node node_modules/node-gyp/bin/node-gyp.js install --target=24.18.0 --devdir="$HOME/.cache/node-gyp" --ensure
npm run build
npm run catalog:sqlite:build-record -- "$PWD/node_modules/node-gyp/bin/node-gyp.js" "$HEADERS" 24.18.0
npm run catalog:sqlite:probe-record
cd "$ROOT"
```

The record route verifies pinned source, node-gyp, matching header bytes, local
build provenance, ABI, and the native allocation-refusal probe. It permits a
local compiler's output hash rather than requiring a Fedora reference binary.
The non-record route is the stricter recorded-binary reproduction check. Both
routes currently require Linux x64. Keep generated provenance with the local
installation, outside the Git index. See [native build details](chrono-release-compatibility.md#dependencies-and-checks).

A build is not worker startup permission. First verify that the checkout HEAD
is accepted and the Chrono package is clean. Use the package's
[prepare-only authorization command](../packages/pi-chrono-compaction/README.md#exact-root-startup-authorization):

```sh
node "$ROOT/packages/pi-chrono-compaction/scripts/prepare-startup-authorization.mjs" \
  --checkout "$ROOT" --commit "$ACCEPTED_COMMIT" \
  --config "$CHRONO_CONFIG" --output "$PRIVATE_OUTPUT/startup-authorization.candidate.json"
```

Use absolute real paths and a new private output directory outside the checkout.
The configuration must contain the four explicit worker-policy fields documented
in the package README. Preparation verifies runtime bytes and configuration. It
does not start workers, register packages, or change admission state. Install the
new exclusive authorization at the reported exact-root path only during the
authorized selection. Follow the [Chrono startup procedure](chrono/operations/activation-and-migration.md)
before relying on indexing or compaction. Keep the existing worker policy and
state when replacing source. A healthy code-only update must report startup
`ready` with `changed: false`. Do not initialize or repair an existing worker
gate merely to make a code-selection check pass.

## Register selected packages

Pass absolute paths from this checkout. Pi can store a relative local declaration
resolved from its settings directory. Check its resolved path, not only the
literal string. Each command is optional. Preserve this relative order when
selecting the corresponding products:

```sh
pi install "$ROOT/packages/pi-progressive-tools"
pi install "$ROOT/packages/pi-agent-context"
pi install "$ROOT/packages/grounded-tools/files"
pi install "$ROOT/packages/grounded-tools/process"
pi install "$ROOT/packages/grounded-tools/lsp"
pi install "$ROOT/packages/grounded-tools/dialog"
pi install "$ROOT/packages/pi-context-kit/todo"
pi install "$ROOT/packages/pi-context-kit/notes"
pi install "$ROOT/packages/pi-context-kit/workplan"
pi install "$ROOT/packages/pi-context-kit/telemetry"
pi install "$ROOT/packages/pi-context-kit/memory"
pi install "$ROOT/packages/pi-chrono-compaction"
pi install "$ROOT/packages/herdr-agent-state"
pi install "$ROOT/packages/pi-herdr-orchestrator"
pi install "$ROOT/packages/pi-native-ssh"
pi install "$ROOT/packages/herdr-status"
pi install "$ROOT/packages/files-ui"
pi install "$ROOT/packages/pi-pixel-cua"
pi install "$ROOT/packages/pi-project-glance"
pi install "$ROOT/packages/pi-context-kit/recall"
pi install "$ROOT/packages/pi-notify"
pi install "$ROOT/packages/codex-usage-footer"
```

Load Herdr Agent State exactly once before using direct orchestration. Do not
also retain its automatic single-file registration. Register the Codex package
rather than a lone symlink to its entrypoint: its relative helper imports need
the full source directory. Do not also load its old automatic directory.

Do not register `packages/grounded-tools`, `packages/pi-context-kit`, legacy
Grounded Tasks/Notes/Workplan, inactive Review UI, or inactive Tool Controls.
Those grouping directories are not current provider registrations.

For Herdr products, link the same source used by Pi:

```sh
herdr plugin link "$ROOT/packages/pi-herdr-orchestrator" --enabled
herdr plugin link "$ROOT/packages/pi-project-glance" --enabled
```

This does not start a broker or replace an already running Glance pane. Browser
and WebX research have separate source owners, installers, and services. Follow
[the browser guide](../vendor/terminal-browser/README.md) for a new browser
installation. Preserve their registrations during repository extension updates.

## Configuration and startup

Configuration is user-local, not part of a source checkout. Read the selected
package's README before enabling its optional integrations:

| Extension | Required setup or startup check |
| --- | --- |
| Progressive Tools | Review `progressive-tools.json` policy. `/tool-audit` shows allowed names and schema exposure. |
| Grounded Tools | Configure language servers/presets in `grounded-tools/lsp.json` and optional Pyright CLI/Ruff/Vale/ShellCheck executables in `grounded-tools/checks.json`. See [checks](../packages/grounded-tools/lsp/CHECKS.md) and [server prerequisites](../packages/grounded-tools/lsp/SERVERS.md). Stateless file/process tools need no SSH route. |
| Dialog and Glance | Set `askUserV1: true` in `grounded-dialog.json` for the `ask_user` facade. Deferred questions require Glance. Do not load a retired blocking bridge. |
| Context Kit and Chrono | Use one writer per provider. Set `contextCompiler: "v4"` and `memoryOwner: "context-kit"` before loading independent Memory. Existing branches need explicit native imports. Code selection does not migrate state. |
| Native SSH | Configure approved OpenSSH routes privately. Start with `session` capabilities and `/remote`; do not copy another user's routes or keys. |
| Sidebar | `/herdr-sidebar-settings` changes presentation only. Do not restore the retired standalone Spinner alongside it. |
| Codex | Use Pi's `openai-codex` OAuth login. Keep auth and quota/forecast caches out of source control. `/codex-usage` inspects display settings. |
| Notify | The adapter needs its protected user-local config, scoped token reference, and reachable service. Bind only the intended saved logical context, not the latest session. See [adapter setup](../packages/pi-notify/docs/pi-adapter.md). |
| Pixel CUA | Start the portal tool only when the user will select a native window and grant access. Never grant access automatically as an install check. |

Start a new Pi process after registration. A factory loader check sends no model
request and starts no session resources. It cannot prove worker authorization,
receiver binding, live quota polling, or portal access.

Use a harmless file read and a finite shell command to check Grounded Tools.
Open `/files` and return without inserting content. Open `/project-glance` when
selected. For Chrono, require `history_status` or `/Chrono search-status` to show
the intended loaded hashes and startup readiness. Use the package's direct-agent
lifecycle check for orchestration. Report selected source, loaded use, state
migration, and practical behavior separately.

Never force-reload a working session. Before `/reload`, check settled work,
managed jobs, persistent resources, compaction, and an empty editor. Reload can
terminate jobs. A Glance pane-renderer change also needs a safe close/reopen of
that pane. Preserve sessions, provider stores, native state, credentials, and
useful extension data during all source changes.

## Verify and retire predecessors

For development delivery, stage intended files and use the root
[verification workflow](../README.md#verification). Required GitHub CI remains
the merge gate. Do not repeat large historical campaigns for a small change.

For portable-install verification, use a fresh checkout at another path with
an isolated Pi agent directory. Install from its own locks. Do not link to an
old installation's source or dependency tree. Check real dependency paths and
the complete tool/command inventory, then exercise the selected native interface
without a model request when practical. A load-only check is not complete
runtime acceptance.

Delete predecessors only after useful changes have repository custody, the
replacement works, loaded sessions no longer need their code, and registrations,
plugins, symlinks, workers, and dependency closures no longer reference them.
Check dirty work, stash, branch ownership, and running use before removing a
Git worktree or branch. Squash or equivalent acceptance can require a content
comparison, not only an ancestry check. Keep uncertain resources and state with
an exact reason and next action. Do not create renamed backups or source
archives merely to avoid a retirement decision.
