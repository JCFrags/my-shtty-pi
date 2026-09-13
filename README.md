# My Pi extensions

Extensions for [Pi](https://pi.dev): precise coding tools, task and project state, chronological memory, Herdr integration, and terminal interface controls. This repository also maintains a separately built terminal-browser source copy with AgentCursor integration.

The root package is private and is not an all-in-one Pi package or a published npm distribution. Install the individual packages you need.

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

The root lock prepares Grounded Tools and root development dependencies. Other products have package-local locks. ChronoCompact, Pi Herdr Orchestrator, and Pi Project Glance use compiled entrypoints: install their locked dependencies and run their declared build steps before registration. Chrono also needs the explicit native SQLite build described under [verification](#verification).

Grounded Tools has seven separately loadable subpackages. Register selected paths such as `packages/grounded-tools/files`, not the grouping directory. Do not install dependencies separately inside Grounded subpackages.

For an existing installation, preserve package order and replace only the intended registration. Do not append duplicates. Follow [activation and rollback](docs/activation.md) for loader checks, retained package roots, safe reloads, and scoped rollback. A build or link does not update an existing process. Reload only when work is settled and the editor has no unsent draft, then verify the loaded identity. Reload can terminate managed jobs.

## Products

The [registry](package.json) contains 16 owned products: 14 active and two inactive. These are source-maintenance groups, not a count of loaded extensions. The browser copy has its own workspace and is not another registered product.

### Active products

| Product | Purpose | Tools and commands |
| --- | --- | --- |
| [Codex Usage Footer](packages/codex-usage-footer/README.md) | Shared Standard Codex and Spark quota, banked reset details, and an optional unofficial forecast. | `/codex-usage` |
| [Files UI](packages/files-ui/README.md) | Browse files, preview content, and insert selected paths or bounded content into the editor. | `/files` |
| [Grounded Tools](packages/grounded-tools/README.md) | Exact coding tools, questions, tasks, notes, and workplans. | [Seven tool groups below](#grounded-tools) |
| [Herdr Agent State](packages/herdr-agent-state/README.md) | Report Pi session identity and working, blocked, or idle state to Herdr. | Automatic lifecycle integration. No tool or command. |
| [Herdr Blocked Bridge](packages/herdr-blocked-bridge/README.md) | Report legacy `ask_user_question` waits as Herdr blocked state. | Automatic event bridge. No tool or command. |
| [Herdr Status](packages/herdr-status/README.md) | Publish display-only model and activity metadata without replacing lifecycle integration. | `/herdr-status` |
| [Pi Agent Context](packages/pi-agent-context/README.md) | Maintain stable date/environment snapshots and inspect prompt, context, and tool costs. | `/context-refresh`, `/context-audit` |
| [ChronoCompact](packages/pi-chrono-compaction/README.md) | Select chronological memory and recover source-linked history. | [History, memory, and operator interfaces below](#chronocompact) |
| [Pi Herdr Orchestrator](packages/pi-herdr-orchestrator/README.md) | Run direct-Herdr agents and retain authenticated broker configuration. | Root `orchestrate`, child-only `subagent_channel`, `/agent-settings` |
| [Pi Native SSH](packages/pi-native-ssh/README.md) | Use configured OpenSSH routes, persistent sessions, and bounded file transfers with remote-write rollback. | `ssh_transfer`, Grounded `session`, `/remote`. Route mode also binds `read`, `ls`, `write`, `edit`, and `bash`. |
| [Pi Pixel CUA Portal](packages/pi-pixel-cua/README.md) | Observe and control one explicitly granted native GNOME Wayland window through pixels. | `cua_portal_start`, `cua_portal_observe`, `cua_portal_act`, `cua_portal_stop`, `/pixel-cua-status`, `/pixel-cua-stop` |
| [Pi Progressive Tools](packages/pi-progressive-tools/README.md) | Keep a short tool catalog visible and enable permitted tools through exact-name help. | `list_tools`, `tool_help`, `/tool-audit`, `/tool-reset` |
| [Pi Project Glance](packages/pi-project-glance/README.md) | Show current task state, a durable progress inbox and History, and deferred questions in a Herdr pane. | `/project-glance`. No model-facing tool. |
| [Titlebar Spinner](packages/titlebar-spinner/README.md) | Show activity through selectable terminal title animations. | `/title-animation` |

### Inactive products

These packages retain source for compatibility work. Their presence does not imply activation or current host compatibility.

| Product | Retained interface |
| --- | --- |
| [Pi Review UI](packages/pi-review-ui/README.md) | Pre-execution review of `edit` and `write`. No separate tool or command. |
| [Pi Tool Controls](packages/pi-tool-controls/README.md) | Mouse-first bulk expansion controls for tool output, opened with `/tool-controls` when explicitly loaded. |

## Grounded Tools

One product supplies seven Pi entrypoints. The internal `core` subpackage supplies shared primitives and has no Pi entrypoint.

| Subpackage | Tools | Use |
| --- | --- | --- |
| `files` | `read`, `edit`, `write`, `local_search` | Verbatim reads, optional outline/symbol/anchor views, strict edits, atomic replacement where supported, and explicit text/file/fuzzy search. |
| `process` | `bash`, `process`, `session` | Exact command output, complete logs, managed background processes, and explicit persistent local or SSH sessions. |
| `lsp` | `lsp` | Language Server Protocol diagnostics and navigation, including a rename preview that does not edit files. |
| `dialog` | `ask_user` when enabled, otherwise legacy `ask_user_question` | Structured blocking questions and a provider-based deferred question interface. |
| `tasks` | `todo` | Branch-aware immediate task plans with dependencies, blocking, and one in-progress task. |
| `notes` | `notes` | Explicit branch-aware scratchpad notes, separate from remembered knowledge. |
| `workplan` | `workplan` | Durable goals, constraints, milestones, decisions, checkpoints, and recovery after context loss. |

`/grounded-files`, `/grounded-lsp`, and `/grounded-processes` report policy or status. `/todos` and `/todo-add` provide manual task controls. `GROUNDED_TRIAL_MODE=1` prefixes `read`, `edit`, `write`, `bash`, and `process` with `grounded_`; the other tool names stay unchanged.

[Grounded Dialog](packages/grounded-tools/dialog/README.md) owns the single question facade. Set `askUserV1: true` in the Pi agent directory's `grounded-dialog.json` to select `ask_user`. Project Glance supplies the deferred provider. Deferred questions support preferences, information, and reversible choices, never authorization. Saved answers enter history at safe idle for the next natural turn. They do not steer busy work, start an automatic response, or escalate to blocking mode.

## Find and use tools

Progressive Tools appends names and short usage hints to the model's existing system prompt. It uses the loaded tool registry, not a package search or web catalog.

1. Use the visible catalog, or call `list_tools({})` to see permitted names and hints again.
2. Call `tool_help({"names":["history_recall"]})` with exact, case-sensitive names. Help returns guidance and enables matching managed tools. It does not execute them or return their schemas.
3. On the next model response, Pi supplies the enabled definitions. Call the native tool separately.

`/tool-audit` explains tool policy and schema costs. `/tool-reset` clears managed activations. Blocked tools remain blocked. Help does not grant permission for an operation or install missing capabilities.

## ChronoCompact

ChronoCompact 3.0.0 provides selective chronological memory and source-linked recall. Important events retain more detail. Routine history can leave active context while the original source remains recoverable. This is useful incomplete memory, not an attempt to fit a lifetime of history into one context window.

Programmatic V3 memory is enabled by default. The default combined context target is 32,000 estimated tokens, adjusted to the selected model's capacity, with a small adaptive raw tail. Incremental catalogs, event capsules, episodes, current state, and hierarchical rollups support bounded selection and recovery. Optional language-model advice can improve individual events or bounded groups. The programmatic pipeline does the main work and does not require model calls. Derived memory never gains instruction authority.

At safe idle, automatic rollover starts a smaller physical session after 8 MiB of new source growth beyond its bootstrap data. It preserves the old JSONL and transfers Notes, Tasks, and Workplan state through bounded native checkpoints. Running managed processes or open shell sessions block the switch. Arbitrary third-party extension state is not automatically migrated. Use checkpoint-aware providers when resuming a replacement session.

Focused checks exercised model-free composition, bounded recall, native state preservation, and actual Pi physical replacement with restart. These checks do not establish perfect recall or billion-token normal-use qualification. Search ranks a bounded lexical candidate window, not the entire archive at once. Loading a pre-existing large Pi session can still incur its initial memory cost. See the [release and evidence boundary](docs/chrono-v3/README.md#release-and-evidence-boundary) and [settled scale results](docs/chrono-v3/reviews/M11-report-correction.md#actual-settled-campaign).

### Agent tools

| Tools | Purpose |
| --- | --- |
| `history_status` | Inspect indexed readiness, cuts, lag, and safe errors without triggering ingestion or reading the archive. |
| `history_search`, `history_recall` | Find likely events and expand selected cues, episodes, resource history, state, rollups, or bounded exact blocks. Inspect coverage and continuation fields. |
| `history_get`, `history_range` | Recover exact source entries, blocks, or chronological ranges. |
| `history_retention_hint`, `request_compaction` | Record advisory retention priorities and request compaction at a safe work boundary. |
| `memory_remember`, `memory_update` | Save or revise ordinary source-linked working knowledge without rewriting its event history. |
| `memory_forget`, `memory_promote` | Remove ordinary knowledge from active working memory or return it to working use. Source history is not deleted. |
| `memory_list`, `memory_get`, `memory_search` | Inspect current or archived remembered knowledge and its provenance. |

### Operator commands

| Commands | Purpose |
| --- | --- |
| `/chrono-compact-settings` | Open configuration. |
| `/chrono-search-status`, `/chrono-worker-status`, `/chrono-doctor` | Inspect bounded readiness, worker state, and read-only safety checks. |
| `/chrono-search on\|off` | Change persistent indexed-history selection for the current session only. |
| `/chrono-logical-session` | Guarded manual adoption, status, rollover, fork, recovery, and rollback alongside safe-idle automatic rollover. |
| `/chrono-composition-preview`, `/chrono-rollup-repair` | Save a private shadow comparison or perform an explicit bounded rollup repair transition. |
| `/chrono-capsules-status`, `/chrono-catalog-status`, `/chrono-rollup-shadow-status` | Inspect the retained capsule, catalog, and rollup diagnostic paths. These are not release or composition-eligibility certificates. |
| `/chrono-value-worker-status`, `/chrono-value-worker-reset` | Inspect optional value-model work or cancel pending work and reset its persisted circuit without deleting stored advice or source. |

The extension dispatches `/chrono-auto-rollover` internally with a one-use binding. Use `/chrono-logical-session` for operator controls.

Start with the [Chrono overview](docs/chrono-v3/README.md), [configuration](docs/chrono-v3/configuration.md), [operations](docs/chrono-v3/operations.md), and [recovery](docs/chrono-v3/recovery.md). Old plans and reports are historical guides, not the current release checklist.

## Integration boundaries

- Todo and Workplan own their state. Project Glance reads their public event contracts and presents progress without importing their implementations or mutating their plans. After a pane-renderer update, close and reopen the Glance pane as well as reloading Pi.
- Root agents use `orchestrate` to run, inspect, wait for, message, cancel, and collect direct-Herdr agents. Children use `subagent_channel` with the exact run ID and assignment generation. `/agent-settings` edits authenticated broker policy, not direct spawn routing. Relinking a Herdr plugin does not replace a running broker.
- Native SSH needs configured routes and OpenSSH/Python helpers. Inspect `session` capabilities before selecting a backend. `/remote` changes the native tool route; user `!` commands remain local. Preserve registration order when combining native-tool overrides.
- Pixel CUA needs Python 3.10 or later and the GNOME Wayland portal stack. The user must select one window and grant pointer/keyboard access. Clicks and keyboard actions also require Pi confirmation.
- Codex Usage Footer uses Pi's built-in `openai-codex` OAuth login, not ordinary OpenAI API-key sessions. Its requests are read-only and never spend reset credits. The Tibo Button forecast is unofficial and uncalibrated.

Files UI remains separate from Grounded Files and orchestration. Signal Board, predecessor orchestration presentation surfaces, and the temporary cancellation-isolation product are retired.

## Terminal-browser and AgentCursor

[`vendor/terminal-browser`](vendor/terminal-browser/README.md) is the browser-only copy from [`JCFrags/my-shtty-pi-web`](https://github.com/JCFrags/my-shtty-pi-web) at `19c33769a33edddd066b3bac291ce371d2c1aba9`. It includes the Electron browser, pinned AgentCursor dependency, Rust rendering engine, CLI, Pi extension, Herdr plugin, assets, build tooling, and browser tests. [Copy provenance](vendor/terminal-browser/copy-provenance.json) and [upstream pins](vendor/terminal-browser/upstreams.lock.json) record its inputs and adaptations.

When the separate browser integration is installed, Pi exposes five tools:

| Tool | Purpose |
| --- | --- |
| `browser_open` | Open or reuse this Pi pane's companion browser. |
| `browser_observe` | Read bounded semantic or visual state, including supported frame selection. |
| `browser_act` | Perform one AgentCursor action, navigation, dialog response, or project-confined upload. |
| `browser_tabs` | Manage tabs/popups and inspect, wait for, or cancel owner-scoped downloads. |
| `browser_control` | Inspect, pause, or resume agent control. |

Observe before acting and after page changes. Do not automatically repeat a possibly delivered action or resume control taken by a human. Use these tools in Pi, not the upstream CLI as an alternative control route.

WebX search/read, its optional loader and research services, retirement scripts, and external publishing automation are not included. This source copy does not activate another Pi package or replace an installed browser. Build it in its separate workspace:

```sh
cd vendor/terminal-browser
pnpm install --frozen-lockfile
pnpm build
```

Use pnpm 10.13.1, Rust/Cargo, and the [documented native prerequisites](vendor/terminal-browser/README.md). Distribution, managed activation, and recovery remain separate from the root npm workspace. A browser build does not prove that a running daemon or Pi process loaded it.

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
```

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
- [Activation and rollback](docs/activation.md): registration ownership and loaded-process checks.
- [Project Glance archive operations](packages/pi-project-glance/docs/archive.md): import, backup, restore, and compatible rollback.
- [Chrono documentation](docs/chrono-v3/README.md): memory architecture, configuration, recovery, and revision-bound evidence.
- [Browser documentation](vendor/terminal-browser/README.md): the separately managed browser workflow.

The root [MIT license](LICENSE) applies with retained package notices. Imported code keeps its attribution. The [browser license](vendor/terminal-browser/LICENSE), [font license](vendor/terminal-browser/assets/fonts/LICENSE.txt), and [bundled dependency notices](vendor/terminal-browser/assets/licenses/) retain their separate terms and are not replaced by the root license.
