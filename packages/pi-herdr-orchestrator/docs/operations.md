# Operations

Start with [fresh setup](../README.md#fresh-setup) and the [architecture](architecture.md). Build success, package registration, loaded activation, and a practical child lifecycle are separate checks.

## Update and rollback

1. Inspect the selected Pi source, convenience alias, enabled Herdr plugin, and imported helper. Back up owned registrations outside Git. Preserve unrelated settings, package order, sessions, and running workers.
2. Prepare a new full retained checkout from accepted source. Install its root and orchestration locks, then typecheck, build, and test. Use its own sibling helper, not an older deployment's dependency tree. Do not install or build in a root used by running sessions.
3. Run `node scripts/local-activation-check.mjs --orchestrator-candidate "$CHECKOUT"`. This substitutes an existing orchestration registration only and requires its exact built entrypoint and root tool. Missing registration fails. For a fresh registered installation, use `--expect-orchestrator` without the candidate flag. Both checks preserve unrelated roots and do not require Glance.
4. Follow [scoped activation](../../../docs/activation.md#retained-roots-and-orchestration). Set only the orchestration package source to its new absolute path, preserve its list position, and relink the same Herdr plugin ID. Compare unrelated registrations and exact helper resolution afterward.
5. Start a fresh Herdr Pi TUI and exercise health, progress, messaging, completion, wait, collection, reuse, and owned close. Verify native session reporting. Existing sessions need a separate safe reload and loaded-use check.

Before `/reload`, require settled agent work, no managed jobs that reload would terminate, and an empty editor. Never overwrite a draft or interrupt active workers to complete activation. A retargeted stable symlink alone can leave compiled JavaScript cached under its old import path. Select the new absolute package source before reload.

Rollback restores only the owned source/link/plugin values from the backup after checking that no later unrelated change would be lost. Retain the old compatible build and helper until no registration or running process needs them. Keep session, registry, channel, and result state. Do not restore whole settings or delete state as a code rollback.

Multi-tab registries use version 6. The current code migrates older direct registries, preserving workers and runs. Version 5 readers cannot read version 6. Before reloading a parent into this version, finish and close its old-code workers, or coordinate their upgrade while preserving exact native identities. Do not let old and new code write one domain. After migration, a code rollback requires a version-6-compatible reader. Restoring a stale registry backup would lose later events and assignments.

An old broker is not a prerequisite. Relinking the current manifest prevents future broker startup, but does not stop an existing broker. Stopping or retiring an old installation needs separate authority, exact process ownership, and verified quiescence. Use that retained version's supported shutdown procedure.

## Actions and completion

Roots use `health`, `run`/`spawn`, `list`, `inspect`, `send`, `wait`, `collect`, `reuse`, `cancel`, `close`, and `recover`. Use returned agent and run IDs. A child uses `progress`, `send`, `acknowledge_cancel`, and `complete`, always with the current `runId` and `assignmentGeneration`.

A successful spawn means the assignment was delivered, not completed. An idle pane is not a final result. Wait returns bounded event and terminal summaries. Call `collect` for the full saved result, then inspect it against the task. Completion does not close the worker. Reuse or close only the exact owned worker when settled. Cancellation requests an acknowledgement. A timeout does not prove failure, completion, or permission to take over.

## Capacity preferences

Root sessions provide `/subagents`. The menu saves both preferences to `pi-herdr-orchestrator.json` in Pi's agent directory, normally `$HOME/.pi/agent`. Set `PI_CODING_AGENT_DIR` for a different directory. SDK hosts must align this environment variable with their `agentDir` option because Pi does not expose that option through the extension context.

```json
{"version":1,"total":8,"perTab":4}
```

Each value must be an integer from 1 to 32. The values are independent, but a per-tab limit above the total does not add capacity. The range bounds supported configuration, not measured machine or provider limits. Start with the defaults and increase deliberately.

Opening or canceling the menu does not write. Save checks that the file has not changed since the menu opened. If another session saved newer preferences, reopen the menu before saving. A missing file uses defaults without creating it. Malformed or unreadable settings refuse new worker admission rather than silently raising capacity. Existing worker management remains available.

New admissions read the preferences without a reload. The total applies separately to each parent/project domain. A worker with an explicitly completed assignment still occupies capacity until closed. Lowering a limit does not terminate, move, or hide workers. Reuse does not need a new slot. An existing tab above its new per-tab limit cannot accept another worker.

## Finite waits

The `wait` run count follows total capacity, up to the supported pool of 32. Existing current assignments remain watchable together after a decrease. Batch older run history when it exceeds the current watch limit. Wait shares a 24-item limit across events and terminal notices, with a 64 KiB JSON reply limit and fair delivery across watched runs. Summaries use at most 2048 characters. `collect` still returns the full result. `timeoutMs` defaults to 30000 and has a maximum of 600000. One monotonic budget includes validation, context commands, lock admission, channel work, and event watching. Activity does not reset it. The domain lock is released during watcher sleep, and each later scan loads fresh registry state.

`timeoutMs: 0` polls once without event-watch sleep, with a fixed 5000 ms work allowance. It does not promise zero elapsed time. Expiry before context and run validation returns `WAIT_DEADLINE_EXCEEDED`. After validation, an empty `timedOut: true` result means no batch was delivered, not that a worker stopped.

The deadline stops admission of new work. Started filesystem operations, helper shutdown, watcher cleanup, and an admitted bounded delivery commit must settle before return. These operations or a host stall can exceed the requested time. Host abort stops the wait, not the child. An admitted delivery commit can finish after abort.

Saved delivery cursors and Pi tool-result persistence still have a window between them. This is not an exactly-once receipt protocol. UI notifications use separate cursors and do not resume the model. Longer waits do not infer progress from terminal text or wake cold sessions.

## Startup refusals

If root role resolution fails, `orchestrate` remains unavailable. A child with unavailable binding retains only `subagent_channel`. Tool help and its native description expose safe historical startup guidance. Each real child call revalidates its binding, but does not retry root role selection.

Check live Herdr coordinates, the exact native Pi session report, current assignment, registered resources, and the Herdr `pi` command's defaults. Do not clear child environment values, invent an assignment, copy a locator, or force root registration. A normal parent needs an operator-controlled safe reload or new session to rerun startup. Static catalog presence alone is not validated child access.

## Display and private evidence

Collapsed tool cards use at most six text rows. Expanded cards use at most ten, plus Pi's separator. Expansion is a bounded preview, not the full result. Warnings and source limits precede excerpts. Inspect separates the requested run from the current agent/pane. List/recover can omit tracked agents and shorten progress. Inspect can omit older runs and supplies only a bounded current-pane excerpt. Display clipping does not change original arguments, content, or details.

For original saved evidence, use Pi's `/export NEW_PRIVATE_PATH.jsonl` in an owner-only directory and check permissions. Export can overwrite an existing path and can contain tasks, messages, results, paths, or secrets. JSONL preserves active-branch payloads but rewrites its header and parent links. HTML uses the display renderer and is not a raw fallback. Export cannot recover evidence omitted by the tool itself. Keep private exports and runtime state outside Git.
