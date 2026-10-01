---
title: Local activation and rollback
audience: [operators, agents, maintainers]
status: repository procedure with historical product receipts
purpose: Preserve supported registration, loaded-use, and scoped rollback procedures across products.
related:
  - chrono/operations/activation-and-migration.md
  - chrono/operations/troubleshooting-and-rollback.md
---

# Local activation and rollback

For Chrono and Context Kit, start with [activation and explicit state migration](chrono/operations/activation-and-migration.md) and [data-preserving rollback](chrono/operations/troubleshooting-and-rollback.md). Current Chrono uses one `/Chrono` menu. Product counts and observed identities below belong to their recorded milestones, not a universal current loader inventory.

## Ownership

Context Kit's independent native providers own Todo, Notes, and Workplan in the Chrono context-state stack. Chrono consumes their evidence and requests complete rollover checkpoints. It does not own provider persistence. Progressive Tools owns catalog visibility and schema exposure only. Context Kit supplies the only supported current Todo, Notes, and Workplan registrations. Older retained Grounded writers are historical installations, not current alternatives. Select one writer per native tool and preserve unrelated registrations.

The repository supplies Project Glance presentation and Pi orchestration as separate products. Project Glance reads bounded Todo and Workplan summaries; it does not own their state or depend on the orchestration broker. Standalone Files UI and blocking Ask User remain independent.

A build, a link, an active session, and user acceptance are different checks:

- **Built:** locked dependencies, typecheck, tests, generated entrypoints and package checks pass.
- **Linked:** Pi resource settings and Herdr plugin registration resolve to the intended package roots.
- **Activated:** a new Pi process or `/reload` has loaded those roots.
- **User-confirmed:** the final local interaction checklist passes. A doctor or loader check cannot establish this.

Do not upgrade global software as part of linking. Check `pi --version`, the installed `@earendil-works/pi-tui/package.json`, and `herdr --version`. Project Glance requires Pi/TUI `>=0.85.1 <0.86.0` and Herdr 0.8.2 or compatible later behavior. Both Pi and TUI were verified at 0.85.1 with Herdr 0.8.2 for this milestone.

## Inspect and preserve before changes

1. Inspect `git status --short`, `git worktree list`, and the baseline tag. Preserve unrelated edits, staged changes, and all user/session data. Use an isolated worktree for implementation. Do not reset, clean, stash, or switch a live activation checkout for convenience.
2. Inspect `herdr plugin list --json`, each affected plugin's manifest, Pi's resource settings, and package/extension symlink targets. Never print credentials or raw runtime descriptors.
3. Back up affected settings, link metadata and replaced package bytes in an owner-only directory outside the repository. Record old/new tree identities and file hashes. Keep the backup until activation and user acceptance are complete.
4. The `pi.herdr.orchestrator` manifest has no startup hook or managed pane. Direct workers do not depend on a broker. Preserve existing agents and retained broker installations. Stop an older broker only through its retained supported CLI after an authorized, verified quiescent maintenance window.
5. Preserve unrelated package order, registrations, external browser products, and auto-discovered extensions. Remove a predecessor registration only after its package identity and exact ownership are confirmed. Historical session entries are not package registrations and must not be deleted.

## Build and registration checks

From an isolated candidate checkout, prepare dependencies from committed locks with `npm ci --ignore-scripts --no-audit --no-fund` in each package that needs them. Grounded Tools uses the repository-root workspace lock: run `npm ci --ignore-scripts --no-audit --no-fund` at the repository root, not under `packages/grounded-tools` or its subpackages.

Run root `npm run verify` against indexed candidate inputs. This checks the supported architecture and disposable builds; historical checks are separate. New source and manifests must be indexed before this check. Never copy private settings, logs, credentials, session files, sockets or dependency trees into the index.

The installed Pi resource loader can check the complete local registration set without starting a session or sending a model prompt:

```sh
node scripts/local-activation-check.mjs
node scripts/local-activation-check.mjs --candidate "$PWD" --expect-v1
```

The candidate check substitutes only the affected product roots and removes the retired product registration in an isolated settings directory. It preserves other resource settings and uses the installed SDK. Remote package sources must already have a reviewed local resolution; this script does not install them. Use `--sdk-root` if Pi is not installed below `npm root -g`.

A successful candidate check is not activation. After the planned link change, run the same check without `--candidate` and with `--expect-v1`. Confirm exactly one `/project-glance`, one `orchestrate`, no `/agent-settings`, and no predecessor commands or tools. Project Glance must register no model tools or shortcuts. Its source and live checks must also show no large editor widget.

## Project Glance link workflow

From `packages/pi-project-glance` in the intended retained root:

```sh
npm run typecheck
npm test
npm run build
npm pack --dry-run --json --ignore-scripts
npm run dev:link
npm run dev:doctor
npm run dev:smoke
```

`dev:smoke` uses a disposable relay and a real Herdr pane; it closes its own pane. It does not inspect another session. Do not use a package link to a temporary verification directory that will be removed.

Run `node scripts/local-activation-smoke.mjs` from the repository to copy only Git-indexed inputs, install the locked Project Glance dependencies, build, and exercise link/open/close/unlink/relink in a disposable Pi directory and isolated real Herdr server. The harness removes its registrations and stops only its own server. This workflow passed on Pi/TUI 0.85.1 and Herdr 0.8.2. Rerun it after candidate changes; earlier success does not validate later bytes. Never unlink the live package just to prove a disposable workflow.

```sh
npm run dev:unlink
npm run dev:link
npm run dev:doctor
npm run dev:smoke
```

Run these four commands only in that isolated environment, or as an explicitly planned live removal/restoration with a backup. Check installed CLI help before creating an isolated Herdr session. Do not assume a missing pane means the plugin is unregistered.

## Retained roots and orchestration

A retained activation does not need to be the live Git worktree. Copy indexed source into a new owner-only directory with `git checkout-index --all --prefix="$ACTIVATION/"`; record `git write-tree` beside it, outside the source. Build there from the locks. Do not link a disposable verifier directory. Keep the old root until no running process needs it.

When Todo and Workplan remain linked to another repository root, use `PI_PROJECT_GLANCE_PROVIDER_ROOT="$PROVIDER_REPOSITORY" npm run dev:doctor` from the retained Glance package. This checks exact provider realpaths against the explicitly selected root; it does not change provider links or runtime imports. An invalid explicit root fails the check. The package test's live doctor check is opt-in with `PI_PROJECT_GLANCE_LIVE_DOCTOR=1`; ordinary package tests do not claim live deployment health. Root verifier tests own indexed-input and generated-output checks.

For orchestration, install the repository-root dependencies and package-local locked dependencies. Run typecheck, build, test and pack in `packages/pi-herdr-orchestrator`. Run `node scripts/local-orchestration-smoke.mjs "$ACTIVATION"` against that built root. It checks direct-only plugin registration with a private real Herdr server, then removes only its own registration, server, and sandbox. It sends no model prompts and does not prove existing-session activation or a model-backed child lifecycle. Use `node scripts/local-activation-check.mjs --orchestrator-candidate "$ACTIVATION"` for an orchestration-only candidate loader check. This preserves all unrelated selected product roots.

After an owner-only registration backup and successful candidate loader check:

1. Retarget only the existing Pi orchestration alias to `$ACTIVATION/packages/pi-herdr-orchestrator`, using a same-directory temporary symlink and atomic rename. Set its Pi package-list source to that exact absolute retained path, preserving its position. Keep the alias for convenience, but do not use its unchanged path as the hot-reload source.
2. Run `herdr plugin link "$ACTIVATION/packages/pi-herdr-orchestrator" --enabled`. Keep the identity `pi.herdr.orchestrator`. Its tracked manifest has no startup hook or presentation pane.
3. Remove only the confirmed predecessor package entry and archive its exact alias in the backup. Replace the existing Glance entry at its original position, rather than appending a duplicate. Relink its same-ID Herdr plugin to the retained root, then run `dev:link` to verify the complete registration.
4. Compare unrelated settings, aliases and plugin registrations before and after. Run the real loader and direct worker lifecycle checks. For an orchestration-only update, do not change Glance or Dialog.

Same-ID relinking updates plugin metadata without closing existing panes. Confirm this with the installed Herdr version. The direct-only manifest prevents future broker startup but does not stop a broker that already runs. `/agent-settings` and broker policy are removed. Direct spawn routing, registry migrations, child binding, cancellation, and recovery remain unchanged.

Preserve all historical broker data and its compatible retained installation for recovery. The current direct package neither reads nor migrates that data. Never delete state as part of code selection.

## Activate and confirm

Pi 0.85.1 can retain a compiled JavaScript ES module after its stable symlink is retargeted: `/reload` clears Pi's factory cache but not Node's native module cache for the unchanged import path. A fresh loader process does not test this case. A synthetic test with the same existing SettingsManager and DefaultResourceLoader reproduced the old commands across repeated reloads, then loaded the replacement after only the package-list source changed to the new absolute root. Use that source change before `/reload`; no process restart or global cache deletion is required. Do not switch the same process back to its stale alias source.

Request `/reload` in each existing session that must use the changed extensions. Do not send it into a user's unsent editor draft. Keep running agents on their current code until they can reload safely.

Reuse accepted visual checks. For changed feed behavior, check ordinary updates, the pinned summary after refocus, the 10-slot recent window, mouse expansion, individual close, Clear recent, complete History, persistence after reload, and close/reopen. Never request private card contents.

Every eligible update enters History immediately. Recent updates shows at most the latest 10 branch-local arrival slots, oldest to newest. A new arrival replaces the oldest slot. Individual close and Clear recent hide only the selected recent cards. Neither action deletes saved content, changes questions, or refills closed slots from older History. The hidden state survives reopening. The count means recent updates, not unread messages. Clear submits exact displayed IDs in one transaction, leaving later arrivals untouched. Opening, focusing, scrolling, and expanding do not change visibility. Cards start collapsed with the first two wrapped body lines. The second preview line ends in `…` only when more body lines are hidden; expanded cards show the full text. Click anywhere in an update card—including text, padding, and borders—to expand or collapse it. Only the triangle indicates its state; there are no Expand/Collapse text labels. The bold `[×]` button sits inside the upper-right header, below the uninterrupted border. The full button dismisses the card without toggling it. History uses soft off-white text on a dark slate-blue background with a bold muted-blue heading. It uses the same expansion controls but has no dismissal or deletion button. Expanded cards in both sections omit byte counters, while loading/error notices and body navigation remain available. Gaps between cards remain inactive. An empty feed has no controls.

History starts collapsed on pane opening. Expansion fetches the newest 25 saved cards, including those still visible in Recent updates. Scrolling loads adjacent 25-card pages automatically, with a bounded 75-card render window and five-page cache. Older evicted pages remain accessible by cursor. Complete saved bodies use separate bounded frames. Before activation, back up the permanent archive and import only explicitly selected sessions. Follow [archive operations](../packages/pi-project-glance/docs/archive.md) for location, resumable migration, gaps, backup, restore, storage failures, and compatible rollback. Never remove the archive during code rollback.

Pi persists a message only after all `message_end` handlers complete. A one-shot timer can run before a later asynchronous handler finishes. Glance uses that timer only as an early attempt and awaits reliable rebuilds at `tool_execution_start`, `turn_end`, and `agent_end`. The registered-handler regression covers delayed persistence, update counts, branch changes and shutdown without UI-state writes.

After a pane-renderer change, close the existing Glance side pane in Herdr and reopen it with `/project-glance`; `/reload` replaces the Pi extension but does not replace the already-running pane process.

Herdr owns the pane title and border. Project Glance starts with one untitled blue summary card, followed by separate dark update cards collapsed to two preview lines by default. `Todo task` shows the selected Todo task. `Plan milestone` shows the current Workplan milestone. `Checkpoint note` shows the focus note saved in the latest Workplan checkpoint, not a live activity indicator. Provider contracts and internal field names remain unchanged. Its mouse controls use component-owned row/column targets in Pi/TUI 0.85.1, not live OSC 8 links. The summary card remains outside the feed scroll region.

## Herdr sidebar presentation

`packages/herdr-status` owns the additive sidebar and terminal title animation.
Its only command is `/herdr-sidebar-settings`, including diagnostics. The former
`/herdr-status` and `/title-animation` registrations are removed. Herdr Agent State
still owns lifecycle/session reporting, and Dialog still owns blocking question
signals. Do not replace either with metadata or title updates.

1. Back up the selected Status source, exact standalone Spinner alias or package
   registration, Pi settings, animation preference, and Herdr configuration.
2. Prepare the accepted unified package in a retained source root. Remove only the
   confirmed standalone Spinner registration. Keep package order and all unrelated
   selections unchanged. Preserve the old source and preference for rollback.
3. Check the complete installed loader in an isolated agent directory. Expect one
   fewer extension, unchanged tools, and one new command in place of the two old
   commands. Compare unrelated identities and order, not only aggregate counts.
4. Select the accepted package source and archive the old Spinner alias. Start a
   fresh Pi process, open `/herdr-sidebar-settings`, and save the compact layout.
   This patches only the Pi override in Herdr's sidebar configuration and requests
   a live config reload, not a server restart.
5. Check the loaded source hash in Diagnostics. Verify working model/context and
   activity, idle `Ready`, and continued activity after compaction. Check both old
   commands are absent. Existing Pi sessions require a safe idle reload with an
   empty editor and no managed jobs that reload would terminate.

Herdr natively supplies agent identity, state, location, and a terminal-title row.
The extension supplies only model/context, optional observed counters, and the title
content. Do not add `$summary` or `$tool` rows alongside the same activity title.
The package README defines field ownership, preference scope, and profile migration.

For rollback, restore the previous Status source and its matching standalone
Spinner alias together. Restore only the owned Pi sidebar value and the matching
presentation preference, after checking that no newer change would be lost. Do not
restore whole Pi settings or Herdr config snapshots over later unrelated changes.
Keep the accepted and previous source roots until no running session needs them.

## Dialog Herdr blocking state

Grounded Dialog reports both modern `ask_user` and legacy `ask_user_question`
blocking waits through `herdr:blocked`. The standalone Herdr Blocked Bridge is
retired. Keep Herdr Agent State, which consumes these events. This change does
not require a change to `askUserV1` or the question UI.

1. Back up the existing Dialog selection and the exact standalone bridge package
   registration or auto-discovered extension alias. Confirm their owners before
   changing either.
2. Select the accepted Dialog source and remove only the confirmed standalone
   bridge registration or alias. Do not leave both active: legacy questions would
   report each wait twice. Preserve unrelated registrations and their order.
3. Use the installed resource loader to confirm that the standalone bridge is
   absent, exactly one question tool remains, and unrelated owners are unchanged.
   A loader check alone does not update a running session.
4. After managed work settles and the editor has no unsent draft, reload safely.
   Ask a harmless blocking question and confirm that Herdr shows blocked while
   waiting, then working or idle after an answer or cancellation.

If rollback restores a legacy Dialog source that depended on the bridge, restore
its matching bridge registration as well. Do not restore the bridge alongside
this self-contained Dialog. Preserve settings and session data during rollback.

## V1.1 deferred questions

The existing Grounded Dialog facade owns the only `ask_user` tool. Its normal blocking provider remains unchanged. Glance provides deferred questions through the public `pi-ask-user:deferred-request-v1` and `pi-ask-user:deferred-response-v1` events; it imports no Grounded implementation and registers no question tools.

Require `askUserV1: true` in the existing Pi agent directory's `grounded-dialog.json`. Preserve other settings. With this flag enabled, Dialog registers `ask_user` instead of the legacy `ask_user_question`. Prepare the Grounded workspace dependencies with `npm ci --ignore-scripts --no-audit --no-fund` at the retained repository root, which owns `package-lock.json`. Replace only the Dialog package-list source with `$ACTIVATION/packages/grounded-tools/dialog`, preserving its position. Leave Todo, Workplan, shared core and other provider links unchanged. Do not edit the canonical checkout to activate the facade.

Use `node scripts/local-activation-check.mjs --candidate "$ACTIVATION" --expect-v1-1`, then the same command without `--candidate` after linking. This checks explicit enablement, exactly one facade, blocking and deferred schema variants, restricted classes/timing, and the candidate Dialog owner. Build orchestration as well before a candidate-wide registration check: a missing compiled entry can produce no registration without a loader error. The V1.1 check does not prove activation in an existing session.

Deferred questions support preference, information and reversible decisions, never authorization. Explicit `deliveryMode` supports only `nextTurn`; omission has the same safe-idle behavior. `escalationPolicy` supports only `never`. Existing broader public wire values are rejected, not silently reinterpreted. Recommendations and temporary defaults are display information, not selected answers or permission to act.

The provider saves branch-aware question, answer, cancellation, expiry and delivery records as Pi custom entries. It allows four unresolved outbox slots, an 8 KiB normalized question and a 4 KiB answer. Dismiss without answering requires no answer or selection and sends one durable dismissal notice. Automatic expiry sends a distinct notice. Neither means resolution, approval, or default selection. Hidden notice delivery remains tracked without trapping a visible slot. Hiding a submitted answer preserves its accepted delivery and cannot recall it. New lifecycle records are acknowledged only after the current session file and its directory are flushed and the exact entry bytes can be read. The receipt scan uses 64 KiB chunks and a 2 MiB line bound, retaining only selected branch receipts. It does not cap the entire session file. Oversized ordinary lines do not block later receipts, but oversized or missing required receipts, an unreadable or malformed file, and incomplete appends fail visibly. It never writes raw session bytes or creates a second history.

Answers submitted while Pi is busy remain saved. At safe idle, the provider uses `pi.sendMessage(..., { triggerTurn: false })` to insert the answer into session history without starting a turn. The answer is available to the next naturally initiated model request. It does **not** use Pi's memory-only native `nextTurn`, steering or follow-up queues. Those queues have no per-message durable receipt or branch-bound cancellation in Pi 0.85.1. A historical message marker prevents duplicate insertion after reload or an interrupted acknowledgement. The provider flushes the file and directory at its durability boundary. This is not a promise of exactly-once model processing.

Automatic expiry requires both 30 minutes of eligible observed active-tool time and three meaningful normally settled runs by the same agent on the same branch. A meaningful run has a successful write/edit or Todo/Workplan mutation, or at least three eligible successful read/search/navigation calls. Overlapping time counts once, with at most five minutes per tool and 64 unique spans per run. Idle time, shutdown, polling, unknown tools, failed work, other agents, and work completed while the question is being edited earn no credit. Submitted answers and blocking/authorization questions never expire through this heuristic. Progress persists across reload without duplicate accounting.

After mechanical checks, request `/reload` and close/reopen Glance. Check harmless option and text answers, unanswered dismissal, continued independent work, pending restoration without duplicate answers, and the unchanged blocking modal. Preserve the accepted V1 feed controls. Do not commit or push until the user accepts the complete deferred workflow.

## Codex usage footer activation

`codex-usage-footer` is a multi-file source extension. Its entrypoint imports `./quota-history.ts`, so the old single-file symlink at `~/.pi/agent/extensions/codex-usage-footer.ts` is not a valid loader route. Pi resolves a symlinked entrypoint's relative imports beside the alias, not beside the symlink target.

The selected local activation uses Pi's documented `*/index.ts` auto-discovery form. `~/.pi/agent/extensions/codex-usage-footer.ts` is an owner-only directory containing only these links:

- `index.ts` targets the retained `extensions/codex-usage-footer.ts` entrypoint.
- `quota-history.ts` targets the retained quota helper beside that entrypoint.
- `tibo-forecast.ts` targets the retained public-forecast helper beside that entrypoint.

Do not link `quota-history.test.ts` or `tibo-forecast.test.ts` into the auto-discovery directory. Before a swap, reproduce the complete production extension registration in an isolated agent directory and use the installed `DefaultResourceLoader`. Require the same extension identities, tools, commands, and Ask User owner, with only `/codex-usage` added. A factory-only loader check sends no model prompt and does not start the quota watcher.

Create each activation under an owner-only retained root, for example `$HOME/.local/state/pi-codex-usage-activations/<activation-id>`. Keep the previous accepted activation until the replacement is active and accepted. The live directory must contain only `index.ts`, `quota-history.ts`, and `tibo-forecast.ts` links to the selected retained checkout. Existing Pi processes do not prove active use of the new version until they reload safely.

`/codex-usage` is a nested keyboard menu for Usage details, Banked resets, Recent history, Display settings, Tibo Button Forecast, and Shared settings. Banked resets reads the optional count from the normal usage summary and coordinates one separate read-only details GET at the same selected account poll cadence. The details route has an account-scoped companion cache and lock because a usage-only client can continuously refresh the main usage gate and rewrite the main cache without preserving newer fields. The upgraded coordinator migrates valid banked fields and their gate timestamps from the main cache without an early request. Later usage-only rewrites cannot reserve the details route or erase its companion state. Each request gate is persisted before I/O, and authenticated requests reject redirects. Summary and details retain independent last-good values, observation times, and failure times. Missing summary data never clears a known count. A returned usage account ID is validated before quota or summary acceptance. The newest valid summary or details count is authoritative, with the usage summary winning an equal-time tie. Credit IDs are discarded before cache publication; terminal text is sanitized and bounded. The extension has no consume endpoint, POST action, or reserve opt-in. The public forecast cache is shared across accounts for the same OS user and is independent of Codex authentication and the 180-second quota poll. It runs only while a visible Codex footer has both the overall footer and forecast enabled. Its primary is the fixed `https://codexreset.org/` homepage, read through a bounded, no-evaluation scanner of the root forecast snapshot. Only a failed, invalid, or stale primary reaches the legacy `https://www.willcodexquotareset.com/api/forecast` backup. A fresh primary does not fetch backup, and scores are never blended. Each fixed unauthenticated HTTPS request refuses redirects, omits credentials and private data, has a separate 10-second timeout, and actively cancels rejected or aborted response streams. Body limits are 2 MiB for primary and 128 KiB for backup. The version-2 `tibo-button-forecast-v2.json` cache and `tibo-button-forecast-v2.lock` are separate from untouched v1 files, so old clients cannot erase source identity or starve primary polling. Mixed-version clients can still make separate legacy requests. Only validated forecast fields, source identity, and bounded failure/scheduling/freshness metadata are stored. The shared lock persists an attempt reservation before network I/O, so abort, disable, crash, and restart paths retain the gate. Checks are never eligible faster than 30 minutes. The existing 15-minute timestamp offset in 30-minute phases remains a bounded client scheduling policy, not a primary refresh guarantee. Invalid or future timestamps, failures, restarts, and concurrent clients preserve the disk rate gate and last valid forecast. If both sources are unusable, compact output keeps the last-good value with `check failed` and, when applicable, `stale`; source and fallback reasons remain visible in details. Display settings contains Display scope, Display preset, Show footer, Tibo Button Forecast, and Customize display (advanced). The advanced menu retains Standard Codex, Spark, Banked resets, Usage format, and Reset format. Banked count and next known expiry controls default on and follow the existing shared or session display scope. A null or invalid expiry is Unknown, not unlimited. The footer uses `next known/listed expiry` unless details match the newest authoritative count and every available credit has a known future expiry. The forecast defaults on, follows the selected shared or session scope, and can display by itself when all quota fields are off. Shared-scope participation waits until the persisted account display preference resolves, so a saved off choice cannot transiently render or fetch. Its primary compact text is `Tibo 24h 31%/48h 63%`; backup retains its legacy headline and `[backup]`, for example `Tibo 48h 23% Probably not today. [backup]`. Details identify the primary's unofficial experimental global-reset estimates and the backup's unofficial uncalibrated 48-hour estimate. Primary age uses root `updatedAt`, not the account-monitor heartbeat. The forecast never updates actual quota counters, reset times, or history. Standard Codex and Spark open independent Weekly usage/reset and 5-hour usage/reset submenus. Standard weekly fields default on. Standard 5-hour and all Spark fields default off. Missing duration classes show `Not reported`, not zero or unlimited.

Display scope defaults to All local sessions when the session has no explicit choice, so ordinary edits update account-scoped shared preferences and synchronize to upgraded clients. This session copies shared display settings once and persists branch-local overrides. Scope switches preserve both sets. Version-1 positional preferences retain Show footer and formats, but their primary/secondary toggles are not mapped to duration classes or Spark.

Compact, Comfortable, and Verbose are explicit bundles of existing display fields and Reset format, described in the [package README](../packages/codex-usage-footer/README.md). Comfortable matches the unchanged default field density. Preset names are derived from current values. Unmatched combinations read Custom. No preset identity is saved, and the version-4 display schema remains unchanged. Opening or canceling the selector writes nothing. Enter applies one complete bundle in the selected scope, through one locked shared transaction or one session entry. A preset preserves Show footer, forecast participation, Remaining/Used, the other scope's override, and polling/history settings. Existing saved preferences are not changed automatically. The footer omits the outer Codex label, and complete banked expiry says expires. Incomplete, unknown, and stale qualifiers remain unchanged.

Shared settings use lock-coordinated bounded choices: polling is 60, 180, 300, or 600 seconds with a 180-second default; history is 16, 32, 64, or 128 entries with a 64-entry default. Menu writes wait for bounded retries and report failure. Individual display edits patch one field against the current locked value, so concurrent independent edits do not overwrite each other. Invalid files do not replace last-good in-memory state. The version-1 cache remains readable. Old snapshots without duration render as unknown and never acquire an inferred class.

Classification uses only the exact returned duration: exactly 604,800 seconds is Weekly, exactly 18,000 seconds is 5-hour, and all other or missing durations are unknown. Header minutes convert to seconds without rounding. Primary/secondary position, plan, countdown, and reset distance never classify a window. Records preserve family, server limit identity/name, raw position, exact duration, usage, reset, and per-field observation times. Partial headers merge by family ID and source window. Carried fields retain prior freshness, display as stale, and do not defer full polling. The compact footer shows configured Standard or Spark known-duration windows. Details/history also retain unknown and other additional families.

Official `openai/codex` source at `ddea03ad049142943bdbf13e937b1d67e8c1ba0c` defines standard `rate_limit` plus `additional_rate_limits` entries with `limit_name`, `metered_feature`, and nested `rate_limit`; each family has primary/secondary windows with `limit_window_seconds`. Spark is recognized only from an additional entry whose returned `limit_name` equals Spark case-insensitively.

After review and authorized deployment, require retained-candidate and installed offline loader parity at 22 extensions, 29 commands, 42 tools, one Ask User owner, and one `/codex-usage`. The retained and installed auto-discovery directory must contain exactly `index.ts`, `quota-history.ts`, and `tibo-forecast.ts`. The scoped rollback must change only this extension directory. Do not accept an isolated cache as the live banked-reset check. On the normal shared account cache, first record only sanitized field presence and request ages. Without removing locks or stopping older clients, confirm that an upgraded coordinator leaves a fresh usage gate untouched, creates or reuses the private companion banked gate, performs at most the eligible details GET, and renders the returned count and expiry after a normal reload. Never print cache-key file names, account or credit IDs, authentication, or response bodies. Use the selected activation's owner-only registration backup for rollback:

```sh
$ACTIVATION/registration-backup/rollback.sh --check
$ACTIVATION/registration-backup/rollback.sh --apply
```

Rollback exchanges only the Codex alias and preserves settings and unrelated extensions. Existing Pi processes need a safe `/reload` or restart after activation or rollback. Do not send `/reload` into an editor that contains an unsent draft.

## Context Kit owned providers and V4 compilation

The owned providers are separately loaded from `packages/pi-context-kit/{memory,todo,notes,workplan}`. Recall and Telemetry remain separate. Use Node 24.18.0, Pi 0.85.1, and the accepted repository-root lock. The pure protocol and state-store libraries are not Pi registrations. Chrono's package-local file dependency must resolve to that retained checkout's protocol. Verify each provider's actual workspace `@grounded/pi-core` resolution and source hash as well. A matching entrypoint does not establish a matching dependency set. Do not copy dependency trees or register both old and new native writers.

1. Preserve settings, the two affected Chrono configuration fields, aliases, original source, and provider stores. Prepare exact accepted retained source and complete offline loader comparisons. Keep Telemetry before Chrono, and preserve every unrelated extension and package order.
2. Replace only the intended Todo, Notes, Workplan, Recall, and Chrono sources. Add Memory when selected. Set `contextCompiler: "v4"` and `memoryOwner: "context-kit"` before loading the independent Memory owner. `memoryOwner` is captured at startup. A configuration edit alone does not stop an already loaded old writer.
3. Use a coordinated selection window with compare-before-write guards, per-file atomic replacement, and a durable rollback journal. Settings and configuration cannot be replaced by one filesystem rename. Do not claim multi-file reader atomicity. Prevent a new loader from observing a partial selection and preserve unrelated later settings during compensation.
4. Compare the complete selected loader again. Require one owner for each native name, all intended new commands, correct source and dependency hashes, and unchanged unrelated owners and Ask User state. Then exercise the actual registered tools in a fresh installed Pi process. Reload existing sessions only when their jobs, agent work, and editor drafts permit it.

When combining previously separate provider roots, check the selected shared-core behavior rather than assuming identical dependencies. The current core excludes closed records from empty-query Recall and prioritizes current work before bounded fitting. A text query still permits closed-state recovery. Check both open-work selection and native recovery when a source change also changes that core.

Code selection does not migrate data. A fresh complete checkpoint-only replacement can bootstrap through the owned providers. An existing legacy branch needs `/todo-import`, `/notes-import`, and `/workplan-import`, repeated only while each bounded step reports pending. Freeze that branch during import. The commands preserve original JSONL and retain normalized native-entry evidence. They do not rewrite raw history. Memory uses explicit `/memory-import-v2` for a chosen sidecar. Never interpret failed or incomplete import as empty state. New writes require a persisted session and an exact verified disk anchor, not a `message_end` notification.

After import, compare complete native state and source identity before making a new write. Check reopen, branch visibility, native recovery, and complete transfer. Accepted Memory survives a tree move in its logical namespace. Todo, Notes, and Workplan stay branch-local. Recall coverage and quality telemetry do not establish migration completeness.

A code-selection rollback and a data rollback are separate. After new writes, return Todo, Notes, and Workplan through complete current native checkpoints in a fresh replacement, before loading the legacy writers. Do not append a checkpoint after earlier legacy state. Memory needs a verified reverse export to the actual fresh target's V2 sidecar, with complete proposals and unsupported metadata retained in its companion. V2 turn-based retention differs from independent Memory. Do not select an old writer while export or semantic comparison is incomplete. Preserve both source generations and the independent stores. See the [provider procedures](../packages/pi-context-kit/README.md).

The native ancestry correction retains the original leaf signature across bounded resolution pages. Older owners reject new cursors containing `head`. Selecting old code is therefore not a data rollback. Preserve compatible owner code, source, and stores instead of clearing derived indexes. See the [state-store rollback limits](../packages/pi-context-kit/state-store/API.md#provider-integration).

## Grounded compact display library

The Files and Process packages depend on the pure `pi-tool-controls/presentation` subpath through local file dependencies. Install from the retained repository-root lock. Keep the sibling `packages/pi-tool-controls/presentation` source and its manifest in that root. Do not add the inactive Tool Controls extension to Pi settings or change its status.

This display change covers seven existing owner registrations only. Before selecting a candidate, compare each selected owner's actual imported dependency closure with the accepted source. Entry-point parity alone is insufficient, especially when Files/LSP and Process use different retained roots. Preserve the selected shared-core alias, unrelated roots, native SSH registrations, and package order. Grounded must retain its intended name ownership. Prepare a new immutable root rather than patching an old activation.

Use an isolated installed-Pi loader to check owner definitions, unchanged model-facing metadata/execution, and only the intended render-hook changes. Exercise compact/expanded cards and `/export` in a fresh harmless session. Preserve all existing sessions and jobs. A test or fresh loader is not activation in those sessions. Follow the normal safe-reload gate separately because Grounded Process shuts down jobs on reload.

The [Grounded README](../packages/grounded-tools/README.md#compact-human-tool-display) defines text-row bounds, image/separator limits, and private raw JSONL export. No data migration or payload rewrite is part of this change. Rollback restores only the affected owner selections with their compatible dependency roots, not whole settings snapshots.

## Earlier Context Kit foundation

This section records the [pre-retirement source](https://github.com/JCFrags/my-shtty-pi/tree/84bbb994ddda237f5df7a98cca30b1ed1f5ec2ed). Its Grounded state-provider selections are historical, not installation choices on current main. Keep compatible retained roots and data for recovery.

Recall and Telemetry have separate source-loaded entrypoints at `packages/pi-context-kit/recall` and `packages/pi-context-kit/telemetry`. The protocol package is a pure library, not a Pi registration. Prepare their workspace dependencies from the accepted repository-root lock.

To enable native current-state recall, select the accepted Grounded Tasks, Notes, and Workplan packages with their matching shared core and protocol dependencies. Preserve their native state and checkpoint formats. No migration or archive rewrite is part of this activation. Keep unrelated Grounded, Glance, orchestration, browser, and research registrations unchanged.

Put Telemetry before Chrono or another extension that can cancel `session_before_compact`. Pi 0.85.1 stops before-event dispatch at `cancel: true`. Loading Telemetry later can leave the terminal event unpaired. Keep the relative order of existing packages, and identify scoped replacements by their verified source rather than historical numeric slots after insertion.

Before changing live selection, back up settings and affected aliases. Use the complete installed resource loader against an isolated candidate. Require the intended provider replacements, one `context_recall`, one `telemetry_status`, one `/context-telemetry`, and unchanged unrelated tool/command owners and Ask User state. Factory loading must not start Telemetry collection. Then update only the scoped selections and repeat the loader comparison.

After managed jobs and agents settle, reload safely. Invoke both new tools and follow a Recall recovery reference through its native tool. Verify a current revision without changing state. Quality remains unknown until a caller supplies observations, and supplied observations remain unverified by the collector. A fresh loader or a passing component test does not prove that an existing session uses the code.

Rollback removes only the two Context Kit registrations and returns the three providers and shared core alias to their preserved sources. Keep unrelated subsequent settings changes, all native history, and local telemetry files. A separately included Chrono patch needs its own compatible scoped rollback. Do not restore an entire old settings document.

## Rollback

Restore only the exact settings entries and links changed by this activation from the owner-only backup. Verify their pre-change hashes and realpaths first. Do not restore a complete old settings file over subsequent unrelated edits. Relink the previous package root with its matching built output, run the loader and doctor checks, then request a safe `/reload`.

Keep the old broker deployment and historical data until no running process or registration needs them. A code rollback does not authorize stopping a running broker, deleting state, moving Git tags, or rewriting history.
