# Architecture

Pi Herdr Orchestrator controls direct Herdr workers. It does not schedule broker jobs or choose child model policy. Project Glance, Files UI, native task providers, and question providers are separate products and are not runtime prerequisites.

## Source map

| Path | Responsibility |
| --- | --- |
| `extensions/pi-herdr-orchestrator.ts` | Select the root or child role and register its tool. |
| `src/orchestrator/tool.ts` | Root actions, owned topology, assignment delivery, cancellation, reuse, and collection. |
| `src/orchestrator/herdr-cli.ts` | Bounded CLI responses and Herdr's `pi` agent start command. |
| `src/orchestrator/store.ts` | Domain registry and direct legacy migrations. |
| `src/orchestrator/capacity.ts` | Validated user-local capacity preferences. |
| `src/orchestrator/capacity-command.ts` | Root-only `/subagents` draft, Save, and Cancel flow. |
| `src/orchestrator/channel-store.ts` | Ordered progress/messages, terminal records, and complete results. |
| `src/orchestrator/child-binding.ts` | Exact registry, Herdr coordinates, and native Pi session validation. |
| `src/orchestrator/child-tool.ts` | Child channel, assignment checks, and safe startup diagnostics. |
| `src/orchestrator/wait-scope.ts` | One finite monotonic wait budget. |
| `src/orchestrator/presentation.ts` | Bounded human display without payload changes. |

The compiled Pi entrypoint is `dist/extensions/pi-herdr-orchestrator.js`. Runtime imports use Node built-ins, relative direct modules, and the sibling `pi-tool-controls/presentation` library. That library imports Pi TUI. The full checkout and root lock prepare its dependency route. The Tool Controls extension remains inactive. Do not substitute a helper from another installation merely because the entrypoint matches.

## Roles and identity

Normal roots outside Herdr register `orchestrate` immediately, but execution still needs live Herdr context. Inside Herdr, role selection waits for `session_start`. A managed child registers only `subagent_channel`. Failed role resolution never grants root access.

Each child call validates the exact registry domain, agent identity and generation, current assignment, live Herdr name and coordinates, and native Pi session ID/file. Herdr Agent State reports that native identity in TUI mode with source `herdr:pi`. Its later startup report can permit a subsequent real channel call to validate. No timer or root fallback bypasses validation.

A validated child appends one versioned `pi-herdr-orchestrator:child-binding` native custom entry. This locator contains only domain, agent identity/generation, and native session ID/file. It is excluded from model context and contains no assignment or credential. It is a locator, not authorization or a disk-persistence receipt. Cold restore needs the persisted session and locator, plus matching live Herdr and registry identities. Malformed/conflicting locators, copied or forked sessions, and unmarked legacy children do not gain automatic recovery.

## State and ownership

State lives under absolute `XDG_STATE_HOME/pi-herdr-orchestrator-v2`, or `$HOME/.local/state/pi-herdr-orchestrator-v2` when the override is absent or relative. This directory name remains a compatibility boundary. Domain IDs hash the absolute project root and parent workspace/tab/pane IDs. Registries track agents and runs. Per-domain channels store ordered events and explicit results.

The root owns its recorded `subagents` tabs and worker panes. The default limit is eight live workers, with four workers per tab. `/subagents` changes these preferences for each parent/project domain. Present workers with completed assignments still count against total capacity. Reducing a limit does not terminate or move them. Reuse creates a new run and assignment generation on the same worker. Each child call must use the latest assigned pair. Explicit completion and worker process state are separate. Collection retrieves the saved full result. Close acts on an exact owned settled worker, not arbitrary terminal panes.

Portable setup means a fresh installation from the full checkout at another path. Copying historical state is not a cross-machine migration: native locators and domains bind absolute paths and live identities. Preserve state during code replacement. Current direct code neither reads nor migrates retired broker state.

The initial six direct modules and M10 reliability check came from production commit `3c87f445f788d460554999a5b5d01a627d7c0bcc`. Subsequent direct changes retain the registry/channel/result boundaries. Git history preserves retired broker sources. They are not fresh-install requirements.
