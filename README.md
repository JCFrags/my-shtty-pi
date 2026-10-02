---
title: My Pi extensions
audience: [users, agents, maintainers]
status: repository orientation
purpose: Introduce the maintained products and route readers to setup, detailed documentation, and verification.
related:
  - docs/chrono/README.md
  - docs/activation.md
---

# My Pi extensions

Extensions for [Pi](https://pi.dev): precise coding tools, task and project state, chronological memory, Herdr integration, and terminal interface controls. This repository also maintains a separately built terminal-browser source copy with AgentCursor integration.

The root package is private and is not an all-in-one Pi package or a published npm distribution. Install the individual packages you need. Use the [portable installation guide](docs/installation.md) for prerequisites, locked builds, registration order, configuration, startup, and clean-checkout checks.

## Get started

Pi extensions run with your system access. Review the source before installation. Keep the checkout available because a local Pi registration points to it without copying it.

```sh
git clone https://github.com/JCFrags/my-shtty-pi.git
cd my-shtty-pi
npm ci --ignore-scripts --no-audit --no-fund
pi install "$PWD/packages/files-ui"
pi
# In Pi, open /files.
```

Use Node.js 24.18.0, npm, Git, and Python 3 for the repository verification workflow. Root tooling pins Pi/TUI 0.85.1. Package peer ranges and platform requirements vary, so check the selected manifest rather than assume universal compatibility.

The root lock prepares Grounded Tools, Context Kit, and root development dependencies. Other products have package-local locks. ChronoCompact, Pi Herdr Orchestrator, and Pi Project Glance use compiled entrypoints: install their locked dependencies and run their declared build steps before registration. Chrono also needs the explicit native SQLite build described under [verification](#verification).

Grounded Tools has four separately loadable subpackages. Register selected paths such as `packages/grounded-tools/files`, not the grouping directory. Context Kit has six separate registrations: `memory`, `todo`, `notes`, `workplan`, `recall`, and `telemetry`. Its `protocol` and `state-store` libraries have no Pi entrypoint. Do not install dependencies separately inside these workspace subpackages. Replace a legacy state provider rather than load both writers.

For an existing installation, preserve package order and replace only the intended registration. Do not append duplicates. Follow [activation and rollback](docs/activation.md) for loader checks, retained package roots, safe reloads, and scoped rollback. A build or link does not update an existing process. Reload only when work is settled and the editor has no unsent draft, then verify the loaded identity. Reload can terminate managed jobs.

## Products

The [registry](package.json) contains 17 owned products: 15 active and two inactive. These are source-maintenance groups, not a count of loaded extensions. The browser copy has its own workspace and is not another registered product.

### Active products

| Product | Purpose | Tools and commands |
| --- | --- | --- |
| [Codex Usage Footer](packages/codex-usage-footer/README.md) | Shared Standard Codex and Spark quota, banked reset details, and an optional unofficial forecast. | `/codex-usage` |
| [Files UI](packages/files-ui/README.md) | Browse files, preview content, and insert selected paths or bounded content into the editor. | `/files` |
| [Grounded Tools](packages/grounded-tools/README.md) | Exact coding tools, questions, and shared native-state primitives. | [Four tool groups below](#grounded-tools) |
| [Herdr Agent State](packages/herdr-agent-state/README.md) | Report Pi session identity and working, blocked, or idle state to Herdr. | Automatic lifecycle integration. No tool or command. |
| [Herdr Sidebar](packages/herdr-status/README.md) | Configure additive model/context fields and terminal title activity. Preserve native lifecycle reporting. | `/herdr-sidebar-settings` |
| [Pi Agent Context](packages/pi-agent-context/README.md) | Maintain stable date/environment snapshots and inspect prompt, context, and tool costs. | `/context-refresh`, `/context-audit` |
| [ChronoCompact](packages/pi-chrono-compaction/README.md) | Select chronological memory and recover source-linked history. | [History, memory, and operator interfaces below](#chronocompact) |
| [Context Kit](packages/pi-context-kit/README.md) | Independent Memory, Todo, Notes, Workplan, current-state recall, and local runtime/quality observations. | `memory_*`, `todo`, `notes`, `workplan`, `context_recall`, `telemetry_status`, native import commands, `/context-telemetry` |
| [Pi Herdr Orchestrator](packages/pi-herdr-orchestrator/README.md) | Run and manage direct-Herdr Pi agents. | Root `orchestrate`, child-only `subagent_channel` |
| [Pi-Notify](packages/pi-notify/README.md) | Standalone durable events and timers, software consumers, resource notes, and an optional exact-target Pi receiver. | `pi-notify` CLI, HTTP API, `/notify`, `notify`, `notify_complete`. |
| [Pi Native SSH](packages/pi-native-ssh/README.md) | Use configured OpenSSH routes, persistent sessions, and bounded file transfers with remote-write rollback. | `ssh_transfer`, Grounded `session`, `/remote`. Route mode also binds `read`, `ls`, `write`, `edit`, and `bash`. |
| [Pi Pixel CUA Portal](packages/pi-pixel-cua/README.md) | Observe and control one explicitly granted native GNOME Wayland window through pixels. | `cua_portal_start`, `cua_portal_observe`, `cua_portal_act`, `cua_portal_stop`, `/pixel-cua-status`, `/pixel-cua-stop` |
| [Pi Progressive Tools](packages/pi-progressive-tools/README.md) | Keep a short tool catalog visible and enable permitted tools through exact-name help. | `list_tools`, `tool_help`, `/tool-audit`, `/tool-reset` |
| [Pi Project Glance](packages/pi-project-glance/README.md) | Show current task state, 10 rolling recent updates, complete History, and deferred questions in a Herdr pane. | `/project-glance`. No model-facing tool. |
| [Pi-SelfReload](packages/pi-self-reload/README.md) | Let the agent reload its own interactive Pi session after work settles, with draft and managed-job checks. Requires Pi 0.99.1 or compatible later behavior. | `self_reload`, `/self-reload` |

### Inactive products

These packages retain source for compatibility work. Their presence does not imply activation or current host compatibility.

| Product | Retained interface |
| --- | --- |
| [Pi Review UI](packages/pi-review-ui/README.md) | Pre-execution review of `edit` and `write`. No separate tool or command. |
| [Pi Tool Controls](packages/pi-tool-controls/README.md) | Mouse-first bulk expansion controls for tool output, opened with `/tool-controls` when explicitly loaded. |

## Grounded Tools

One product supplies four Pi entrypoints. The internal `core` subpackage supplies shared primitives and has no Pi entrypoint.

| Subpackage | Tools | Use |
| --- | --- | --- |
| `files` | `read`, `edit`, `write`, `local_search` | Verbatim reads, optional outline/symbol/anchor views, strict edits, atomic replacement where supported, and explicit text/file/fuzzy search. |
| `process` | `bash`, `process`, `session` | Exact command output, complete logs, managed background processes, and explicit persistent local or SSH sessions. |
| `lsp` | `lsp` | Language Server Protocol diagnostics and navigation, including a rename preview that does not edit files. |
| `dialog` | `ask_user` when enabled, otherwise legacy `ask_user_question` | Structured blocking questions with Herdr state reporting and a provider-based deferred question interface. |

[Context Kit's independent providers](packages/pi-context-kit/README.md) are the only supported current registrations for Todo, Notes, and Workplan. Grounded core supplies their shared primitives, not another writer. The [pre-retirement source](https://github.com/JCFrags/my-shtty-pi/tree/84bbb994ddda237f5df7a98cca30b1ed1f5ec2ed/packages/grounded-tools) remains in Git history. Preserve legacy sessions, import readers, and compatible retained installations. Select exactly one writer per native tool.

`/grounded-files`, `/grounded-lsp`, and `/grounded-processes` report policy or status. Context Kit Todo supplies `/todos` and `/todo-add` for manual task controls. `GROUNDED_TRIAL_MODE=1` prefixes `read`, `edit`, `write`, `bash`, and `process` with `grounded_`; the other tool names stay unchanged.

[Grounded Dialog](packages/grounded-tools/dialog/README.md) owns the single question facade and reports its own blocking waits to Herdr Agent State. The standalone Herdr Blocked Bridge is retired. Remove its old registration when updating Dialog, as described in [activation guidance](docs/activation.md#dialog-herdr-blocking-state).

Set `askUserV1: true` in the Pi agent directory's `grounded-dialog.json` to select `ask_user`. Project Glance supplies the deferred provider. Deferred questions support preferences, information, and reversible choices, never authorization. Saved answers enter history at safe idle for the next natural turn. They do not steer busy work, start an automatic response, or escalate to blocking mode.

## Find and use tools

Progressive Tools appends names and short usage hints to the model's existing system prompt. It uses the loaded tool registry, not a package search or web catalog. It controls discovery and schema exposure, not tool implementations or provider persistence. Context Kit owns Todo, Notes, and Workplan in the Chrono context-state stack. Chrono consumes provider evidence and requests complete rollover checkpoints. It does not own those stores.

1. Use the visible catalog, or call `list_tools({})` to see permitted names and hints again.
2. Call `tool_help({"names":["history_recall"]})` with exact, case-sensitive names. Help returns guidance and enables matching managed tools. It does not execute them or return their schemas.
3. On the next model response, Pi supplies the enabled definitions. Call the native tool separately.

`/tool-audit` explains tool policy and schema costs. `/tool-reset` clears managed activations. Blocked tools remain blocked. Help does not grant permission for an operation or install missing capabilities.

## Agent feedback

The [pi-feedback skill](skills/pi-feedback/SKILL.md) uses GitHub Issues for agent-reported bugs, improvements, and missing capabilities. It checks existing reports before creating an issue or adding evidence. Reports do not authorize implementation.

From this checkout's root, link the skill into Pi's user skill directory. Keep the checkout available. Do not replace an existing skill without checking its owner.

```sh
mkdir -p "$HOME/.agents/skills"
ln -s "$PWD/skills/pi-feedback" "$HOME/.agents/skills/pi-feedback"
```

Start a new Pi session, or use `/reload` only when existing work and managed jobs are settled. Ask for feedback review or use `/skill:pi-feedback review`. No extension, package installation, or model background service is required.

An operator must separately configure the approved repository and private evidence location using the skill's [local setup guidance](skills/pi-feedback/references/private-evidence.md). Without that approval, agents prepare drafts only. Public reports contain a useful sanitized summary and, when needed, an opaque reference to a specific private local note. Private notes and configuration stay outside Git. An opaque ID is a reference, not encryption or access control.

The former `message-board.md` is retired. Use relevant issue or PR comments and direct agent messaging for coordination. Its history remains in Git.

## ChronoCompact

Chrono keeps useful selective chronological context and source-linked recovery. Context Kit adds independent current-state providers. Original history remains recoverable when detail leaves active context. Neither system promises perfect recall or unlimited capacity.

Start with the [non-technical user guide](docs/chrono/USER-GUIDE.md) or the [subject documentation index](docs/chrono/README.md). Agents should read the [system overview](docs/chrono/architecture/system-overview.md), [contracts](docs/chrono/architecture/contracts-and-trust.md), and relevant [source map](docs/chrono/architecture/source-map.md).

Open `/Chrono` for Settings, Status and diagnostics, Maintenance, and About. Background LLM presets, model selection, and optional boundary-stable tool-result shortening live there. Background value advice is a compatibility feature paused while the normal memory engine is enabled. It does not enrich V4 indexed compaction.

| Need | Documentation |
| --- | --- |
| Historical discovery, exact entries/ranges, and readiness | [History tools](docs/chrono/history/indexing-and-exact-recovery.md) |
| Episodes, resources, and rollups | [Chronology](docs/chrono/history/chronology-episodes-resources.md) |
| V3/V4 compaction, budgets, and receipts | [Context compiler](docs/chrono/context/compaction-and-budgets.md) |
| Logical sessions and complete state continuation | [Rollover](docs/chrono/history/logical-sessions.md) |
| Menu, settings, workers, caches, and Telemetry | [Operations](docs/chrono/operations/README.md) |
| Architecture changes, implemented versus selected features, and measured limits | [Design and evidence](docs/chrono/design/README.md) |

The [current status](docs/chrono/design/evidence-and-roadmap.md) identifies the `4.0.5-local.20260926` source and separates publication, code selection, and loaded activation. Package version, effective configuration, ready indexes, and actual use are separate facts. Historical [V3](docs/chrono-v3/README.md) and [V4](docs/chrono-v4/README.md) records remain available for their exact revisions.

## Context Kit and V4

[Context Kit](packages/pi-context-kit/README.md) has six independent extensions: Memory, Todo, Notes, Workplan, Recall, and Telemetry. Each state provider owns its store. Shared libraries provide contracts and storage primitives, not one database.

- [Memory](docs/chrono/state/memory.md) holds source-linked accepted knowledge and separate proposals in one logical session.
- [Todo, Notes, and Workplan](docs/chrono/state/todo-notes-workplan.md) hold branch-local tasks, scratchpad notes, and durable project state.
- [Recall](docs/chrono/context/recall.md) returns bounded current cards from active native providers, not historical search or complete transfer snapshots.
- [Telemetry](docs/chrono/operations/telemetry.md) separates local runtime counters from caller-reported quality. No quality observations means unknown.

V4 compiler selection is explicit. Independent Memory also needs the startup ownership handoff. Select one native writer per provider. Existing legacy branches need explicit import. Code selection does not migrate data. After new writes, rollback requires complete current native state and, for Memory, verified reverse export. Follow [activation and migration](docs/chrono/operations/activation-and-migration.md) and [rollback](docs/chrono/operations/troubleshooting-and-rollback.md).

## Integration boundaries

- Todo and Workplan own their state. Project Glance reads their public event contracts and presents progress without importing their implementations or mutating their plans. After a pane-renderer update, close and reopen the Glance pane as well as reloading Pi.
- Root agents use `orchestrate` to run, inspect, wait for, message, cancel, and collect direct-Herdr agents. Children use `subagent_channel` with the exact run ID and assignment generation. The package has no broker, settings command, or automatic workflow scheduler. Direct spawning uses the existing Pi/Herdr defaults.
- Native SSH needs configured routes and OpenSSH/Python helpers. Inspect `session` capabilities before selecting a backend. `/remote` changes the native tool route; user `!` commands remain local. Preserve registration order when combining native-tool overrides.
- Pixel CUA needs Python 3.10 or later and the GNOME Wayland portal stack. The user must select one window and grant pointer/keyboard access. Clicks and keyboard actions also require Pi confirmation.
- Codex Usage Footer uses Pi's built-in `openai-codex` OAuth login, not ordinary OpenAI API-key sessions. Its requests are read-only and never spend reset credits. The Tibo Button forecast is unofficial and uncalibrated.

Files UI remains separate from Grounded Files and orchestration. Signal Board, predecessor orchestration presentation surfaces, and the temporary cancellation-isolation product are retired.

## Terminal-browser and AgentCursor

[`vendor/terminal-browser`](vendor/terminal-browser/README.md) is a maintained terminal browser with a native CLI for Pi and other agents. Pi tools and Herdr pane management are optional adapters to the same AgentCursor backend. The default CLI-only installation does not configure either host. Use this repository's reviewed release artifacts, not an upstream installer.

Launch an owned browser in a visible terminal, then use another terminal or pane for agent commands:

```sh
terminal-browser open https://example.com --session task-a --project /absolute/project
terminal-browser agent observe --session task-a --project /absolute/project
```

Use the returned observation ID, context, and control epoch for each native action. Observe again after page changes or interruption. Never automatically replay an uncertain side effect or resume control taken by a human. The legacy `action` route is retired. See [CLI use and migration](vendor/terminal-browser/docs/agent-control.md).

The [optional Pi package](vendor/terminal-browser/pi-extension/README.md) keeps five tools: `browser_open`, `browser_observe`, `browser_act`, `browser_tabs`, and `browser_control`. These manage observation/epoch bookkeeping, not another browser backend. Blocking uses Ghostery's core engine and a bundled, SHA-pinned EasyList snapshot. Network blocking is enabled by default, with explicit profile-wide controls and bounded context diagnostics. There are no runtime list downloads, cosmetics, or scriptlets.

The copy originated from [`JCFrags/my-shtty-pi-web`](https://github.com/JCFrags/my-shtty-pi-web) at `19c33769a33edddd066b3bac291ce371d2c1aba9`. [Copy provenance](vendor/terminal-browser/copy-provenance.json) records the import and maintained changes; [upstream pins](vendor/terminal-browser/upstreams.lock.json) record external inputs. The browser includes Electron, AgentCursor, the Rust renderer, CLI, optional adapters, assets, build tooling, and tests. It does not include WebX search/read or unrelated research services.

Use the [installation and rollback guide](vendor/terminal-browser/docs/installation.md) for complete artifacts and the [development guide](vendor/terminal-browser/docs/development.md) for the separate pnpm workspace, native prerequisites, and verification. Product tags use `terminal-browser-vVERSION`. Builds, managed selections, and running-process activation are separate evidence. Copying source or changing a link does not prove that a running daemon or Pi session loaded the change.

## Verification

Stage only intended changes first. The verifier copies Git index blobs into a private disposable directory. Unstaged edits, untracked files, ignored dependencies, and local build output are not its inputs.

Full verification requires Node.js 24.18.0, a compiler toolchain, and a verified matching Node header tree for Chrono's native SQLite build. See the [native-build procedure](docs/chrono-release-compatibility.md#dependencies-and-checks) and [current CI workflow](.github/workflows/verify.yml). Use those prerequisites without repeating historical scale campaigns.

```sh
# Set this to an already prepared, verified Node 24.18.0 header tree.
export CHRONO_CATALOG_NODE_HEADERS="$HOME/.cache/node-gyp/24.18.0"
npm test
npm run verify:static
npm run verify
# Optional: narrow product execution, not repository-wide static checks.
npm run verify -- --product pi-project-glance
npm run verify -- --product pi-context-kit
```

Use focused checks for a small correction. Required CI remains the merge gate.

Static checks cover registry, locks, imports, package boundaries, retired interfaces, privacy, and browser-copy provenance. Full verification also runs declared package checks, explicit native build/probe steps, compiled-output checks, Grounded Dialog/Workplan tests, and package archive checks. A separate CI job builds, typechecks, and tests the browser copy. Verification does not activate packages or establish live usability or unmeasured Chrono scale.

Some retained package READMEs contain historical verifier commands. Use this root workflow for current source. The `deployed-baseline-2026-09-01` tag preserves the earlier deployment; its counts and hashes do not constrain current products or establish activation.

```sh
npm run verify:history
# Optional historical tag or commit:
npm run verify:history -- deployed-baseline-2026-09-01
```

This checks historical Git objects only. Keep session files, credentials, runtime state, and private deployment receipts outside the repository.

## Further reading and license

- [Capability vision](docs/capability-vision.md): roles of native tools, CLIs, skills, and progressive disclosure.
- [Portable installation](docs/installation.md): prepare one clean checkout on another computer without predecessor source or dependency roots.
- [Activation and rollback](docs/activation.md): registration ownership and loaded-process checks.
- [Project Glance archive operations](packages/pi-project-glance/docs/archive.md): import, backup, restore, and compatible rollback.
- [Chrono user guide](docs/chrono/USER-GUIDE.md): functions, practical controls, connections, and limitations.
- [Chrono subject documentation](docs/chrono/README.md): architecture, exact history, state ownership, compaction, operation, and evidence.
- [Historical V4 records](docs/chrono-v4/README.md): source-pinned research, design, and revision-bound practical evidence.
- [Browser documentation](vendor/terminal-browser/README.md): the separately managed browser workflow.

The root [MIT license](LICENSE) applies with retained package notices. Imported code keeps its attribution. The [browser license](vendor/terminal-browser/LICENSE), [font license](vendor/terminal-browser/assets/fonts/LICENSE.txt), and [bundled dependency notices](vendor/terminal-browser/assets/licenses/) retain their separate terms and are not replaced by the root license.
