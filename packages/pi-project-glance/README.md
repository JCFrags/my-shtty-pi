# Pi Project Glance

Pi Project Glance is a persistent Herdr side pane with read-only progress/current-state views and a deferred-question response area. The package contains the Pi extension relay and the standalone `glance` pane.

## Fixed identity

- Product: Pi Project Glance
- Pi command: `/project-glance`
- Herdr pane: `glance`
- Pane title: `Project Glance`
- Feed section: `Progress Feed`

## Foundation behavior

The Pi extension starts one private local relay for the current session. The pane receives authenticated, versioned, bounded snapshots and renders `CURRENT` and `PROGRESS FEED`. `CURRENT` stays pinned. Pending questions occupy their own bounded box above the independently scrolling feed. The relay begins empty, then consumes only public Todo summaries, versioned Workplan summaries, persisted assistant entries, and bounded persisted Workplan activities. `Step`, `Toward`, and `Focus` remain provider-owned. Project Glance never mutates Todo, Workplan, or orchestration state.

Current-state requests are branch-correlated. Only Pi's `session_tree` event changes the runtime branch epoch; ordinary leaf appends and a second `/project-glance` only resynchronize the active branch. A real tree transition clears abandoned-branch current state and rebuilds from the destination ancestry. Relay restart preserves that branch identity and rejects delayed responses from an older epoch. Values use exactly two ASCII spaces between an ID and its text, for example `T1  Do the bounded work` and `WP1-M1  Milestone`.

After a finalized assistant message is persisted, the feed rebuilds from `SessionManager.getBranch()` only. It inspects at most the newest 500 non-UI branch entries in reverse and keeps the newest 50 useful, non-dismissed cards. Glance UI records do not consume that source-history budget. Dismissals are applied before the card limit, so older useful cards backfill the feed. UI state is restored from the full active ancestry, not a 500-record UI tail; long sessions do not silently resurrect dismissed or seen cards. Card order follows branch entry order; timestamps are display-only. A valid persisted entry ID is the assistant card ID. The extractor never hashes a whole assistant message or its tool, thinking, or diagnostic content. When trustworthy phase metadata is present, all commentary blocks in that message become one paragraph-preserving card and `final_answer` blocks never override them. Without trustworthy phase metadata, only text before a successful tool call can qualify. Generic providers need no phase marker: absent, undefined, opaque, or valid unphased signatures use this fallback. Malformed structured signatures still fail closed. Malformed phase data, thinking, tool payloads and results, ordinary final answers, and failed or incomplete assistant responses are excluded. Persisted Workplan checkpoint cards include only bounded summary, focus, and next-action fields. Duplicate IDs and adjacent normalized retries are removed.

Feed projection strips terminal escapes, preserves paragraphs, replaces home-directory paths with `$HOME`, rejects unsafe absolute paths, and rejects credential and private-key patterns. Each card shows a compact local timestamp. The pane anchors the reading position to a retained card and row offset, so arrivals, dismissal backfill, and reconnect do not force a scroll. Selection and expansion survive while their cards remain in the bounded window. A card outside the 500-source/50-card or wire-size window cannot remain selected; selection then falls back to the oldest retained unread card.

Seen and dismissed item IDs are stored as `pi-project-glance/ui-state-v1` custom entries. Pi excludes these entries from model context, and active ancestry makes them branch-aware across reload, reconnect, close/reopen, and tree navigation. Rendering alone never marks a card seen. An explicit successful open or focus positions the feed at the oldest unread card and then records only newly seen IDs. Repeated focus, seen, and dismissal actions append no duplicate UI records. With no unread cards, refocus preserves the reading position. Each connection first accepts a passive focus baseline; reconnect never replays a past focus. A successful open waits up to two seconds for a connected pane before sending a live focus request. If connection takes longer, the feed stays unread until another explicit focus or seen action. The visible `×` dismisses one card without modifying its source entry. Card labels toggle expansion with the mouse; expansion is pane-local. Pi displays compact attention status while unread visible cards or unresolved question outbox slots exist.

The relay uses protocol version 1 with a 64 KiB **wire-frame** limit. Snapshot payloads must fit both initial and correlated response envelopes. The reconnecting client is generation-aware. Its owner-only Unix socket and descriptor stay under an owner-only runtime directory, and the descriptor reaches the pane only through `PI_PROJECT_GLANCE_DESCRIPTOR`; authentication material is never printed or placed in process arguments. Seen, dismissal, and focus use correlated action frames bound to session key, relay generation, branch, and base revision. The server validates payloads, rejects stale, replayed, unknown, or unauthenticated actions, caps replay memory, and returns bounded acknowledgements. Runtime actions share the lifecycle queue; branch and shutdown epochs reject delayed actions and open completions. The client sends one action at a time and advances queued item actions only across its own accepted mutation, never across unrelated revisions. Stale focus is never retried against newly arrived cards. Pending actions are discarded on reconnect. Compact attention status is cleared when both unread and unresolved-question counts are zero, and at disposal.

Pane registrations use one owner-only record and one short-lived acquisition lock per hashed session key. A lock records a bounded PID/process-start identity and nonce, so a dead or mismatched owner can be recovered without treating elapsed time alone as stale. Live locks remain busy until released, and an owner removes only the lock instance it acquired. Registration records are atomically replaced and contain only the protocol version, hashed session key, pane ID, and update time; they never contain relay credentials or filesystem paths.

## Deferred questions (V1.1)

The existing Grounded Dialog `ask_user` facade supports unchanged blocking mode and deferred preference, information and reversible questions. Enable its existing `askUserV1` setting; Glance adds no model-facing tools and communicates only through the public deferred-provider events. Deferred questions cannot authorize actions or escalate based on elapsed time.

The bordered question region uses canonical Pi input, explicit Submit/Cancel/Retry controls, and isolated keyboard/mouse handling. Recommendations are not selected automatically. At most four unresolved questions/outbox slots are admitted; normalized questions are bounded at 8 KiB and answers at 4 KiB. Records and answers are branch-aware, revision-checked, and persisted before acknowledgement. Queued answers survive reload.

Answers submitted while busy remain saved. At safe idle they enter session history with `triggerTurn: false`, becoming context for the next natural turn; they never start an automatic response. Explicit `deliveryMode` supports only `nextTurn` and `escalationPolicy` only `never`. Native steering/follow-up queues are not used. Saved delivery markers prevent duplicate insertion during reconciliation. This does not guarantee power-loss durability or exactly-once model processing. Readable-file receipts are bounded at 64 MiB per session file and 2 MiB per JSONL line.

Feed rendering uses linear link-span hit targets and an actual-input cache to avoid rebuilding the feed during question typing and unchanged scrolling. The optional `GLANCE_BENCH_LEGACY=1 node --test test/pane-render-performance.test.mjs` benchmark reproduces the previous wide-pane slowdown. See `docs/activation.md` at the repository root for activation and rollback; after changing pane code, close/reopen the pane as well as reloading Pi.

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

`dev:link` and `dev:unlink` preflight Pi and Herdr ownership before registration changes, reject conflicting roots, and use supported local package/plugin commands. Linking rolls back newly added registrations on later failure where ownership remains safe. Unlinking removes the Herdr link first and restores its prior enabled state if Pi removal fails. Errors report incomplete rollback; inspect both registrations before retrying after a command or verification failure. These external CLIs are not an atomic transaction, and rollback must not overwrite a new owner or unrelated settings. Clean build/link/unlink/relink and failure paths have disposable mocked-command regression tests; these do not claim live activation. `dev:link` prints `BUILD + LINK COMPLETE`, but linking cannot activate an already-running Pi process. Run `/reload` in that active Pi session, then run `/project-glance`; the link and doctor output deliberately remain `reload-required` until that user checkpoint. `dev:doctor` checks the built entrypoints, both links, a disposable authenticated relay, and an isolated real Pi loader. It does not claim that the current interactive Pi process has loaded the package.

`dev:smoke` opens the real Herdr `pi.project-glance` pane from a disposable static relay, waits for the pane process and authenticated relay connection, checks the rendered `Project Glance`, `CURRENT`, and `PROGRESS FEED` sections, then closes the pane and removes its temporary runtime. It never reads or mutates real Todo, Workplan, session, or user state. Its stable failure output includes a `PROJECT_GLANCE_*` diagnostic code and never prints command stderr, descriptor paths, or credentials.

`dev:fixture` remains available for manual static-fixture inspection. It accepts `--open`, `--restart-after-ms=500`, and `--long-feed`; stop it with Ctrl-C after closing the disposable pane. The build output in `dist/` and local dependencies are development artifacts and are not committed.

The Pi command and Herdr opener report stable actionable diagnostics such as `PROJECT_GLANCE_RELOAD_REQUIRED`, `PROJECT_GLANCE_PLUGIN_NOT_LINKED`, `PROJECT_GLANCE_RUNTIME_START_FAILED`, and `PROJECT_GLANCE_OPEN_RESPONSE_INVALID`. `/project-glance` remains the only Project Glance command. Glance adds no model-facing tool, shortcut, settings surface, or Todo/Workplan mutation. V1.1 deferred responses use the existing Dialog facade and public provider events.
