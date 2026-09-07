# Pi Project Glance

Pi Project Glance is a persistent, read-only Herdr side pane. The package contains the Pi extension relay and the standalone `glance` pane.

## Fixed identity

- Product: Pi Project Glance
- Pi command: `/project-glance`
- Herdr pane: `glance`
- Pane title: `Project Glance`
- Feed section: `Progress Feed`

## Foundation behavior

The Pi extension starts one private local relay for the current session. The pane receives authenticated, versioned, bounded snapshots and renders `CURRENT` and `PROGRESS FEED`. `CURRENT` stays pinned while only the feed scrolls. The relay begins empty, then consumes only public Todo summaries, versioned Workplan summaries, persisted assistant entries, and bounded persisted Workplan activities. `Step`, `Toward`, and `Focus` remain provider-owned. Project Glance never mutates Todo, Workplan, or orchestration state.

Current-state requests are branch-correlated. Only Pi's `session_tree` event changes the runtime branch epoch; ordinary leaf appends and a second `/project-glance` only resynchronize the active branch. A real tree transition clears abandoned-branch current state and rebuilds from the destination ancestry. Relay restart preserves that branch identity and rejects delayed responses from an older epoch. Values use exactly two ASCII spaces between an ID and its text, for example `T1  Do the bounded work` and `WP1-M1  Milestone`.

After a finalized assistant message is persisted, the feed rebuilds from `SessionManager.getBranch()` only. It scans at most the newest 500 branch entries in reverse and stops after backfilling 50 cards. Card order follows branch entry order; timestamps are display-only. A valid persisted entry ID is the assistant card ID. The extractor never hashes a whole assistant message or its tool, thinking, or diagnostic content. When trustworthy phase metadata is present, all commentary blocks in that message become one paragraph-preserving card and `final_answer` blocks never override them. Without trustworthy phase metadata, only unsigned text before a successful tool call can qualify. Malformed phase data, thinking, tool payloads and results, ordinary final answers, and failed or incomplete assistant responses are excluded. Persisted Workplan checkpoint cards include only bounded summary, focus, and next-action fields. Duplicate IDs and adjacent normalized retries are removed.

Feed projection strips terminal escapes, preserves paragraphs, replaces home-directory paths with `$HOME`, rejects unsafe absolute paths, and rejects credential and private-key patterns. Each card shows a compact local timestamp. The pane keeps new arrivals from forcing a scroll while the user reads older cards.

Seen and dismissed item IDs are stored as `pi-project-glance/ui-state-v1` custom entries. Pi excludes these entries from model context, and active ancestry makes them branch-aware across reload, reconnect, close/reopen, and tree navigation. Rendering alone never marks a card seen. An explicit successful open or focus positions the feed at the oldest unread card and then records seen events. The visible `×` dismisses one card without modifying its source entry. Card labels toggle expansion with the mouse; expansion is pane-local. Pi displays `● Glance N` only while unread visible cards exist.

The relay uses protocol version 1 with a 64 KiB **wire-frame** limit. Snapshot payloads must fit both initial and correlated response envelopes. The reconnecting client is generation-aware. Its owner-only Unix socket and descriptor stay under an owner-only runtime directory, and the descriptor reaches the pane only through `PI_PROJECT_GLANCE_DESCRIPTOR`; authentication material is never printed or placed in process arguments. Seen, dismissal, and focus use correlated action frames bound to session key, relay generation, branch, and base revision. The server validates payloads, rejects stale, replayed, unknown, or unauthenticated actions, caps replay memory, and returns bounded acknowledgements.

Pane registrations use one owner-only record and one short-lived acquisition lock per hashed session key. A lock records a bounded PID/process-start identity and nonce, so a dead or mismatched owner can be recovered without treating elapsed time alone as stale. Live locks remain busy until released, and an owner removes only the lock instance it acquired. Registration records are atomically replaced and contain only the protocol version, hashed session key, pane ID, and update time; they never contain relay credentials or filesystem paths.

## Development commands

Run these commands from this package directory and from a Herdr-managed pane:

```text
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm pack --dry-run
npm run dev:link
npm run dev:doctor
npm run dev:smoke
```

`dev:link` uses Pi's supported local package command and Herdr's supported local plugin commands. It prints `BUILD + LINK COMPLETE`, but linking cannot activate an already-running Pi process. Run `/reload` in that active Pi session, then run `/project-glance`; the link and doctor output deliberately remain `reload-required` until that user checkpoint. `dev:doctor` checks the built entrypoints, both links, a disposable authenticated relay, and an isolated real Pi loader. It does not claim that the current interactive Pi process has loaded the package.

`dev:smoke` opens the real Herdr `pi.project-glance` pane from a disposable static relay, waits for the pane process and authenticated relay connection, checks the rendered `Project Glance`, `CURRENT`, and `PROGRESS FEED` sections, then closes the pane and removes its temporary runtime. It never reads or mutates real Todo, Workplan, session, or user state. Its stable failure output includes a `PROJECT_GLANCE_*` diagnostic code and never prints command stderr, descriptor paths, or credentials.

`dev:fixture` remains available for manual static-fixture inspection. It accepts `--open`, `--restart-after-ms=500`, and `--long-feed`; stop it with Ctrl-C after closing the disposable pane. The build output in `dist/` and local dependencies are development artifacts and are not committed.

The Pi command and Herdr opener report stable actionable diagnostics such as `PROJECT_GLANCE_RELOAD_REQUIRED`, `PROJECT_GLANCE_PLUGIN_NOT_LINKED`, `PROJECT_GLANCE_RUNTIME_START_FAILED`, and `PROJECT_GLANCE_OPEN_RESPONSE_INVALID`. `/project-glance` remains the only Project Glance command. The V1 slice adds no model-facing tool, shortcut, editor widget, settings surface, provider mutation, or deferred-question behavior.
