# Pi Herdr Orchestrator

Direct Herdr orchestration for Pi.

- Pi entry point: `dist/extensions/pi-herdr-orchestrator.js` (compiled-loaded).
- Root tool: `orchestrate`. Managed-child tool: `subagent_channel`.
- The package has no broker, CLI, authentication service, model-policy settings, scheduler, or workflow engine. `/agent-settings` is not registered.
- Direct Herdr spawning retains its existing policy and capacity.
- The Herdr manifest keeps plugin ID `pi.herdr.orchestrator`. It declares no startup hook or managed panes.

## Build and test

Requires Linux, Node.js >=22.19.0, npm, and the locked Pi peer (for the model-free lifecycle and startup checks).

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
```

Install root dependencies first with `npm ci --ignore-scripts` from the repository root, then run the package commands above. The runtime `pi-tool-controls/presentation` file dependency needs the sibling `pi-tool-controls` package and the root dependency tree in the retained checkout. An orchestrator tarball alone is not a standalone deployment. Use the checkout's lockfiles; `npm pack` omits `package-lock.json` from the tarball. Importing this pure library does not activate the inactive bulk-controls extension.

Pi supplies its canonical peer packages at extension load time. No alternate TUI package is bundled. `dist/` is generated and is not a deployed-byte contract. Build compiles only the extension and direct `src/orchestrator/` modules.

Tests cover a model-free Pi lifecycle with exact child restore and explicit result collection, root and child tool catalogs, absence of `/agent-settings`, compact presentation, startup diagnostics, and M10 channel ordering, direct legacy migration, cancellation recovery, and bounded waits. The fake Herdr lifecycle fixture is retained. These checks do not prove live Herdr acceptance or deploy anything.

The lifecycle check uses the locked Pi peer by default. To run that same check with an installed SDK, set `ORCHESTRATOR_TEST_SDK_ROOT` to its package directory:

```sh
ORCHESTRATOR_TEST_SDK_ROOT=/path/to/pi-coding-agent node --test --test-name-pattern='managed child lifecycle' checks/lifecycle.test.mjs
```

## Finite event waits

`orchestrate` with `action: "wait"` returns queued events or terminal notices for 1–8 registered runs. `timeoutMs` defaults to 30000 and accepts up to 600000. One monotonic budget starts at tool execution entry and includes validation, context commands, lock admission, channel work, and event watching. Activity does not reset it. The domain lock is released during watcher sleep. Each later scan loads fresh registry state under the lock.

`timeoutMs: 0` polls once without event-watch sleep. It has a fixed 5000 ms work allowance for setup, the scan, and delivery bookkeeping. Zero does not mean zero elapsed execution time. If the budget expires before context and run validation finish, the tool reports `WAIT_DEADLINE_EXCEEDED`. After validation, an empty `timedOut: true` result means no batch was delivered. It does not mean the child failed or stopped.

The deadline stops admission of new work. Started filesystem operations, exact read-helper shutdown, watcher cleanup, and an admitted bounded delivery commit must settle before return. These operations or an event-loop/kernel stall can exceed the requested time. Host abort stops the wait, not the child. An abort during an admitted delivery commit lets that bookkeeping finish. The existing window between saved delivery cursors and Pi recording the tool result remains; this is not an exactly-once receipt protocol.

Event order, output caps, exact assignment checks, and separate UI notification cursors are unchanged. A UI notification does not resume the model. The final tool return supplies the model-visible batch. Full results still require explicit `collect`. Longer waits do not add activity snapshots, infer progress from terminal text, or provide cold-session wakeups.

## Compact human tool display

`orchestrate` and `subagent_channel` use saved inputs only for their human display. Collapsed cards use at most six text rows, and expanded cards use at most ten, plus Pi's separator. Expansion shows a bounded preview, not the full result. Errors, partial display, cancellation, identity warnings, and source limits precede excerpts. Labels appear only when supplied. A successful tool call is not completed work. Inspect keeps the requested run separate from the current agent and pane.

Wait returns bounded event and terminal summaries, not collected final results. List/recover can omit tracked agents and shorten progress. Inspect can omit older runs and returns only a bounded current-pane excerpt. Preview clipping does not change these source limits or the original arguments, content, or details. Notifications and execution are unchanged.

For original saved evidence, use Pi's `/export NEW_PRIVATE_PATH.jsonl`. Choose a new path in an owner-only directory and check file permissions. The export can overwrite an existing path and can contain tasks, messages, results, paths, and secrets. JSONL export preserves active-branch payloads but rewrites its header and parent links. HTML export uses the display renderers and is not a raw fallback. Export cannot recover evidence omitted by the tool itself.

## Managed-child restore

A validated child saves one versioned `pi-herdr-orchestrator:child-binding` custom entry in its native Pi session. The entry contains only the exact registry domain, agent identity/generation, and native session ID/file. It is a locator, not authorization, and is excluded from model context. It contains no assignment, environment snapshot, or credential.

Inside Herdr, role selection waits for `session_start`. A child registers only `subagent_channel`. Every call checks the exact registry, supplied current assignment, live Herdr name and coordinates, and native session identity. Stale assignments and mismatches fail closed. No registry scan or transcript-text fallback is used. Normal roots outside Herdr still register immediately.

Herdr Agent State can publish native identity later in startup. The child retains its channel and retries validation and marker creation on the next actual call, without a timer or root fallback. `appendEntry` is not a disk-persistence receipt. Cold recovery is available only after Pi persists the native session and locator.

If startup role resolution fails, root tools remain unavailable. One warning distinguishes that failure from detected child context with an unavailable binding. `tool_help({"names":["subagent_channel"]})` and the native tool description expose safe historical startup guidance without requiring an invented assignment. Binding refusals report their current safe reason. The child-only surface does not prove a validated binding, and child calls do not retry root role selection. A normal parent needs a safe operator-controlled reload or new session to rerun startup. This improves diagnostics, not automatic recovery. The original reported startup trigger remains unknown.

Malformed or conflicting locators, closed/failed agents, copied or forked native sessions, and unmarked legacy managed children do not gain root access or automatic recovery. A complete fresh environment can seed an unmarked native session after validation. Environmentless transfer to another native session is not supported.

## Source provenance

- The initial six `src/orchestrator/*.ts` modules and `checks/m10-reliability.mjs` were imported from production commit `3c87f445f788d460554999a5b5d01a627d7c0bcc`. The child-binding change adds exact native-session role recovery to the direct channel; the original result and assignment checks remain.
- Existing MIT attribution is preserved in `LICENSE`.

The complete direct `src/orchestrator/` path is retained, including its registry, channel, result collection, and legacy migrations. Separate broker state/result stores and their historical replay checks are removed. The direct path does not import the retired broker helpers.

## Activation boundary

Herdr 0.8.2 source at `9eb521456ac0d19d3ab3d9d7cea3cca10baa8a4c` updates the registry entry when `plugin link` uses an existing ID. It does not close existing panes. Recheck this behavior when Herdr changes.

Relinking this direct-only manifest removes the future broker startup hook. It does not stop an already running broker or remove persisted data. Those actions require a separate maintenance decision. Keep the previous package root and plugin registration available for rollback. Build and test commands do not activate, stop, or roll back a live installation.
