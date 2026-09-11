# Local activation and rollback

## Ownership

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
4. The `pi.herdr.orchestrator` plugin identity owns broker startup. Do not unlink, disable or replace its startup infrastructure merely to remove its old pane. Do not terminate a broker or existing agents. If the running broker needs a restart to load new routes, report that separately and leave it running until the user authorizes a safe restart.
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

A successful candidate check is not activation. After the planned link change, run the same check without `--candidate` and with `--expect-v1`. Confirm exactly one `/project-glance`, one `/agent-settings`, one `orchestrate`, and no predecessor commands or tools. Project Glance must register no model tools or shortcuts. Its source and live checks must also show no large editor widget.

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

For orchestration, install locked dependencies and run typecheck, build, test and pack in `packages/pi-herdr-orchestrator`. Run `node scripts/local-orchestration-smoke.mjs "$ACTIVATION"` against that built root. It uses real Herdr 0.8.2 and installed Pi metadata under private HOME/XDG directories, validates authenticated broker startup/status/doctor/policy and the no-pane manifest, then removes its own registrations, broker, server and sandbox. It sends no model prompts and does not prove existing-session activation or a model-backed child lifecycle. Real Herdr snapshots are under `result.snapshot`; use `herdr plugin link PATH --enabled` with this CLI.

After an owner-only registration backup and successful candidate loader check:

1. Retarget only the existing Pi orchestration alias to `$ACTIVATION/packages/pi-herdr-orchestrator`, using a same-directory temporary symlink and atomic rename. Set its Pi package-list source to that exact absolute retained path, preserving its position. Keep the alias for convenience, but do not use its unchanged path as the hot-reload source.
2. Run `herdr plugin link "$ACTIVATION/packages/pi-herdr-orchestrator" --enabled`. Keep the identity `pi.herdr.orchestrator`; its tracked manifest has broker startup and no presentation pane.
3. Remove only the confirmed predecessor package entry and archive its exact alias in the backup. Replace the existing Glance entry at its original position, rather than appending a duplicate. Relink its same-ID Herdr plugin to the retained root, then run `dev:link` to verify the complete registration.
4. Compare unrelated settings, aliases and plugin registrations before and after, then run the real loader, doctor and pane smoke checks.

Herdr 0.8.2 same-ID relinking updates plugin metadata without restarting the existing broker or closing its panes. The new startup manifest is used on a future server startup. A running old broker still has its old routes until a separately authorized safe restart; linking alone must not be reported as new broker activation. `/agent-settings` uses authenticated broker policy/configuration requests. The unchanged direct-Herdr `orchestrate` spawn path is separate and does not acquire broker model selection semantics.

Historical event logs can contain a retired actor identity. The narrow historical decoder accepts that exact value only during replay and disk verification. New append and live authentication reject it. Never delete historical data or broaden live validation to make replay pass.

## Activate and confirm

Pi 0.85.1 can retain a compiled JavaScript ES module after its stable symlink is retargeted: `/reload` clears Pi's factory cache but not Node's native module cache for the unchanged import path. A fresh loader process does not test this case. A synthetic test with the same existing SettingsManager and DefaultResourceLoader reproduced the old commands across repeated reloads, then loaded the replacement after only the package-list source changed to the new absolute root. Use that source change before `/reload`; no process restart or global cache deletion is required. Do not switch the same process back to its stale alias source.

Request `/reload` in each existing session that must use the changed extensions. Do not send it into a user's unsent editor draft. Keep running agents on their current code until they can reload safely.

Reuse accepted visual checks. For changed V1 behavior, ask the user to check ordinary updates, CURRENT after refocus, unread/oldest-unread positioning, mouse expansion and dismissal, persistence after reload, close/reopen, settings, and absence of old commands. Never request private card contents.

Unread zero immediately after explicitly opening/focusing Glance is expected: that command marks the displayed feed read. Passive updates must remain unread until an explicit reading action. Cards start collapsed with the first two wrapped body lines. The second preview line ends in `…` only when more body lines are hidden; expanded cards show the full text. Click anywhere in an update card—including text, padding, and borders—to expand or collapse it. Only the triangle indicates its state; there are no Expand/Collapse text labels. The bold `[×]` button sits inside the upper-right header, below the uninterrupted border. The full button dismisses the card without toggling it. Gaps between cards remain inactive. An empty feed has no controls. Do not treat unread zero alone as evidence of a broken feed.

Pi persists a message only after all `message_end` handlers complete. A one-shot timer can run before a later asynchronous handler finishes. Glance uses that timer only as an early attempt and awaits reliable rebuilds at `tool_execution_start`, `turn_end`, and `agent_end`. The registered-handler regression covers delayed persistence, unread status, branch changes and shutdown without UI-state writes.

After a pane-renderer change, close the existing Glance side pane in Herdr and reopen it with `/project-glance`; `/reload` replaces the Pi extension but does not replace the already-running pane process.

Herdr owns the pane title and border. Project Glance intentionally starts with one blue CURRENT card, followed by separate dark update cards collapsed to two preview lines by default. Its mouse controls use component-owned row/column targets in Pi/TUI 0.85.1, not live OSC 8 links. CURRENT remains outside the feed scroll region.

## V1.1 deferred questions

The existing Grounded Dialog facade owns the only `ask_user` tool. Its normal blocking provider remains unchanged. Glance provides deferred questions through the public `pi-ask-user:deferred-request-v1` and `pi-ask-user:deferred-response-v1` events; it imports no Grounded implementation and registers no question tools.

Require `askUserV1: true` in the existing Pi agent directory's `grounded-dialog.json`. Preserve other settings. With this flag enabled, Dialog registers `ask_user` instead of the legacy `ask_user_question`. Prepare the Grounded workspace dependencies with `npm ci --ignore-scripts --no-audit --no-fund` at the retained repository root, which owns `package-lock.json`. Replace only the Dialog package-list source with `$ACTIVATION/packages/grounded-tools/dialog`, preserving its position. Leave Todo, Workplan, shared core and other provider links unchanged. Do not edit the canonical checkout to activate the facade.

Use `node scripts/local-activation-check.mjs --candidate "$ACTIVATION" --expect-v1-1`, then the same command without `--candidate` after linking. This checks explicit enablement, exactly one facade, blocking and deferred schema variants, restricted classes/timing, and the candidate Dialog owner. Build orchestration as well before a candidate-wide registration check: a missing compiled entry can produce no registration without a loader error. The V1.1 check does not prove activation in an existing session.

Deferred questions support preference, information and reversible decisions, never authorization. Explicit `deliveryMode` supports only `nextTurn`; omission has the same safe-idle behavior. `escalationPolicy` supports only `never`. Existing broader public wire values are rejected, not silently reinterpreted. Recommendations and temporary defaults are display information, not selected answers or permission to act.

The provider saves branch-aware question, answer, cancellation, expiry and delivery records as Pi custom entries. It allows four unresolved outbox slots, an 8 KiB normalized question and a 4 KiB answer. A queued UI cancellation notice retains a slot until delivery. Records are acknowledged only after their exact current-session file bytes can be read. The bounded receipt scan permits a 64 MiB session file and a 2 MiB JSONL line; an unreadable, malformed, unflushed or oversized file fails visibly. It never writes raw session bytes or creates a second history.

Answers submitted while Pi is busy remain saved. At safe idle, the provider uses `pi.sendMessage(..., { triggerTurn: false })` to insert the answer into session history without starting a turn. The answer is available to the next naturally initiated model request. It does **not** use Pi's memory-only native `nextTurn`, steering or follow-up queues. Those queues have no per-message durable receipt or branch-bound cancellation in Pi 0.85.1. A historical message marker prevents duplicate insertion after reload or an interrupted acknowledgement. This is not a power-loss `fsync` guarantee or a promise of exactly-once model processing.

After mechanical checks, request `/reload` and close/reopen Glance. Check harmless option and text answers, continued independent work, pending restoration without duplicate answers, and the unchanged blocking modal. Preserve the accepted V1 feed controls. Do not commit or push until the user accepts the complete deferred workflow.

## Codex usage footer activation

`codex-usage-footer` is a multi-file source extension. Its entrypoint imports `./quota-history.ts`, so the old single-file symlink at `~/.pi/agent/extensions/codex-usage-footer.ts` is not a valid loader route. Pi resolves a symlinked entrypoint's relative imports beside the alias, not beside the symlink target.

The selected local activation uses Pi's documented `*/index.ts` auto-discovery form. `~/.pi/agent/extensions/codex-usage-footer.ts` is an owner-only directory containing only these links:

- `index.ts` targets the retained `extensions/codex-usage-footer.ts` entrypoint.
- `quota-history.ts` targets the retained quota helper beside that entrypoint.
- `tibo-forecast.ts` targets the retained public-forecast helper beside that entrypoint.

Do not link `quota-history.test.ts` or `tibo-forecast.test.ts` into the auto-discovery directory. Before a swap, reproduce the complete production extension registration in an isolated agent directory and use the installed `DefaultResourceLoader`. Require the same extension identities, tools, commands, and Ask User owner, with only `/codex-usage` added. A factory-only loader check sends no model prompt and does not start the quota watcher.

Create each activation under an owner-only retained root, for example `$HOME/.local/state/pi-codex-usage-activations/<activation-id>`. Keep the previous accepted activation until the replacement is active and accepted. The live directory must contain only `index.ts`, `quota-history.ts`, and `tibo-forecast.ts` links to the selected retained checkout. Existing Pi processes do not prove active use of the new version until they reload safely.

`/codex-usage` is a nested keyboard menu for Usage details, Banked resets, Recent history, Display settings, Tibo Button Forecast, and Shared settings. Banked resets reads the optional count from the normal usage summary and coordinates one separate read-only details GET at the same selected account poll cadence. The details route has an account-scoped companion cache and lock because a usage-only client can continuously refresh the main usage gate and rewrite the main cache without preserving newer fields. The upgraded coordinator migrates valid banked fields and their gate timestamps from the main cache without an early request. Later usage-only rewrites cannot reserve the details route or erase its companion state. Each request gate is persisted before I/O, and authenticated requests reject redirects. Summary and details retain independent last-good values, observation times, and failure times. Missing summary data never clears a known count. A returned usage account ID is validated before quota or summary acceptance. The newest valid summary or details count is authoritative, with the usage summary winning an equal-time tie. Credit IDs are discarded before cache publication; terminal text is sanitized and bounded. The extension has no consume endpoint, POST action, or reserve opt-in. The public forecast cache is shared across accounts for the same OS user and is independent of Codex authentication and the 180-second quota poll. It runs only while a visible Codex footer has both the overall footer and forecast enabled. Its fixed unauthenticated HTTPS request refuses redirects, omits credentials, has a 10-second timeout and 128 KiB body limit, actively cancels rejected or aborted response streams, and stores only validated forecast fields and scheduling timestamps. The shared lock persists an attempt reservation before network I/O, so abort, disable, crash, and restart paths retain the gate. Checks are never eligible faster than 30 minutes. Scheduling aims for 15 minutes after the source-reported cycle in 30-minute phases but cannot guarantee a 15-minute maximum lag. Invalid or future timestamps, failures, restarts, and concurrent clients preserve the disk rate gate and last valid forecast. Display settings contains Display scope, Show footer, Standard Codex, Spark, Banked resets, Tibo Button Forecast, Usage format, and Reset format. Banked count and next known expiry controls default on and follow the existing shared or session display scope. A null or invalid expiry is Unknown, not unlimited. The footer uses `next known/listed expiry` unless details match the newest authoritative count and every available credit has a known future expiry. The forecast defaults on, follows the selected shared or session scope, and can display by itself when all quota fields are off. Shared-scope participation waits until the persisted account display preference resolves, so a saved off choice cannot transiently render or fetch. Its unofficial uncalibrated 48-hour message never updates actual quota counters, reset times, or history. Standard Codex and Spark open independent Weekly usage/reset and 5-hour usage/reset submenus. Standard weekly fields default on. Standard 5-hour and all Spark fields default off. Missing duration classes show `Not reported`, not zero or unlimited.

Display scope defaults to All local sessions when the session has no explicit choice, so ordinary edits update account-scoped shared preferences and synchronize to upgraded clients. This session copies shared display settings once and persists branch-local overrides. Scope switches preserve both sets. Version-1 positional preferences retain Show footer and formats, but their primary/secondary toggles are not mapped to duration classes or Spark.

Shared settings use lock-coordinated bounded choices: polling is 60, 180, 300, or 600 seconds with a 180-second default; history is 16, 32, 64, or 128 entries with a 64-entry default. Menu writes wait for bounded retries and report failure. Display edits patch one field against the current locked value, so concurrent independent edits do not overwrite each other. Invalid files do not replace last-good in-memory state. The version-1 cache remains readable. Old snapshots without duration render as unknown and never acquire an inferred class.

Classification uses only the exact returned duration: exactly 604,800 seconds is Weekly, exactly 18,000 seconds is 5-hour, and all other or missing durations are unknown. Header minutes convert to seconds without rounding. Primary/secondary position, plan, countdown, and reset distance never classify a window. Records preserve family, server limit identity/name, raw position, exact duration, usage, reset, and per-field observation times. Partial headers merge by family ID and source window. Carried fields retain prior freshness, display as stale, and do not defer full polling. The compact footer shows configured Standard or Spark known-duration windows. Details/history also retain unknown and other additional families.

Official `openai/codex` source at `ddea03ad049142943bdbf13e937b1d67e8c1ba0c` defines standard `rate_limit` plus `additional_rate_limits` entries with `limit_name`, `metered_feature`, and nested `rate_limit`; each family has primary/secondary windows with `limit_window_seconds`. Spark is recognized only from an additional entry whose returned `limit_name` equals Spark case-insensitively.

After review and authorized deployment, require retained-candidate and installed offline loader parity at 22 extensions, 29 commands, 42 tools, one Ask User owner, and one `/codex-usage`. The retained and installed auto-discovery directory must contain exactly `index.ts`, `quota-history.ts`, and `tibo-forecast.ts`. The scoped rollback must change only this extension directory. Do not accept an isolated cache as the live banked-reset check. On the normal shared account cache, first record only sanitized field presence and request ages. Without removing locks or stopping older clients, confirm that an upgraded coordinator leaves a fresh usage gate untouched, creates or reuses the private companion banked gate, performs at most the eligible details GET, and renders the returned count and expiry after a normal reload. Never print cache-key file names, account or credit IDs, authentication, or response bodies. Use the selected activation's owner-only registration backup for rollback:

```sh
$ACTIVATION/registration-backup/rollback.sh --check
$ACTIVATION/registration-backup/rollback.sh --apply
```

Rollback exchanges only the Codex alias and preserves settings and unrelated extensions. Existing Pi processes need a safe `/reload` or restart after activation or rollback. Do not send `/reload` into an editor that contains an unsent draft.

## Rollback

Restore only the exact settings entries and links changed by this activation from the owner-only backup. Verify their pre-change hashes and realpaths first. Do not restore a complete old settings file over subsequent unrelated edits. Relink the previous package root with its matching built output, run the loader and doctor checks, then request a safe `/reload`.

Keep the old broker deployment and historical data until no running process or registration needs them. A code rollback does not authorize stopping a running broker, deleting state, moving Git tags, or rewriting history.
