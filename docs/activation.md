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

From an isolated candidate checkout, prepare dependencies from committed locks with `npm ci --ignore-scripts --no-audit --no-fund` in each package that needs them. Grounded Tools is a workspace: prepare its root, not separate ad hoc copies of its subpackages.

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

## Rollback

Restore only the exact settings entries and links changed by this activation from the owner-only backup. Verify their pre-change hashes and realpaths first. Do not restore a complete old settings file over subsequent unrelated edits. Relink the previous package root with its matching built output, run the loader and doctor checks, then request a safe `/reload`.

Keep the old broker deployment and historical data until no running process or registration needs them. A code rollback does not authorize stopping a running broker, deleting state, moving Git tags, or rewriting history.
