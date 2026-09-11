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

### Inbox and permanent History

`Progress Feed` is an inbox. Unread means not explicitly dismissed. New eligible persisted updates are saved before preview or wire clipping. Opening, focusing, scrolling, and expanding do not mark cards seen, archive them, or reduce the count. Click the interior `×` to move an update durably to History. The source entry and saved body remain intact. Compact attention counts the complete outstanding inbox plus unresolved question attention, not just the visible page. It disappears only when both counts are zero.

Inbox cards follow source order, oldest first. Cards have two-line previews, ellipsis, triangle indicators, and whole-card expansion. History appears below the inbox, collapsed each time the pane opens. Expansion loads the newest 25 archived cards. Scrolling near the older boundary prefetches the next 25. History uses a subdued background and has no dismissal or deletion control. Bounded page/body caches permit backward and forward navigation without retaining the entire archive in memory. Keyboard controls include `h` for History, `[` and `]` for page navigation, `j` and `k` for selection, Space or Enter for expansion, and `d` for inbox dismissal. Reading anchors use card identity and row offset across updates, page loads, expansion, resize, and reconnect.

The store has no age, row-count, or body-size retention cap. Each page reads metadata and previews of at most 1 KiB per card. Expanded bodies load separately in UTF-8-safe frames of at most 24 KiB, with previous/next chunk navigation. Collapsed History does not fetch card bodies. Stable cursor watermarks keep concurrent arrivals and archive actions from inserting duplicates into an existing traversal.

### Capture and privacy

Capture reads the newly persisted entry suffix after a saved checkpoint. Startup and actual tree changes reconcile the selected ancestry. Ordinary unchanged refresh/focus does not re-extract the session. Stable source identities make replay idempotent. Branch membership keeps abandoned-branch records on disk without exposing them in another branch view.

When trustworthy phase metadata is present, commentary blocks become one paragraph-preserving update. `final_answer` blocks are excluded. Without trustworthy phase metadata, only text before a successful tool call can qualify. Generic providers need no phase marker: absent, undefined, opaque, or valid unphased signatures use this fallback. Malformed structured signatures fail closed. Thinking, tool arguments/results, ordinary final answers, and failed or incomplete assistant responses are excluded. Workplan cards use only their intended public activity fields.

Sanitization removes terminal escapes, preserves paragraphs, replaces home-directory paths with `$HOME`, rejects unsafe absolute paths, and rejects credential and private-key patterns. Only sanitized update bodies and source/provenance metadata enter the archive, not raw transcripts. Source identity and body digest detect conflicting replay without overwriting saved content. See [archive operations](docs/archive.md) for location, import, backup, restore, and compatible rollback.

The relay uses protocol version 1 with a 64 KiB **wire-frame** limit. Snapshot payloads must fit both initial and correlated response envelopes. The reconnecting client is generation-aware. Its owner-only Unix socket and descriptor stay under an owner-only runtime directory, and the descriptor reaches the pane only through `PI_PROJECT_GLANCE_DESCRIPTOR`; authentication material is never printed or placed in process arguments. Dismissal, focus, page/body reads, and question actions use correlated frames bound to session key, relay generation, branch, and base revision. The server validates payloads, rejects stale, replayed, unknown, or unauthenticated actions, caps replay memory, and returns bounded acknowledgements. Runtime actions share the lifecycle queue; branch and shutdown epochs reject delayed actions and open completions. The client sends one action at a time and advances queued item actions only across its own accepted mutation, never across unrelated revisions. Stale focus is never retried against newly arrived cards. Pending actions are discarded on reconnect. Compact attention status is cleared when both unread and unresolved-question counts are zero, and at disposal.

Pane registrations use one owner-only record and one short-lived acquisition lock per hashed session key. A lock records a bounded PID/process-start identity and nonce, so a dead or mismatched owner can be recovered without treating elapsed time alone as stale. Live locks remain busy until released, and an owner removes only the lock instance it acquired. Registration records are atomically replaced and contain only the protocol version, hashed session key, pane ID, and update time; they never contain relay credentials or filesystem paths.

## Deferred questions

The existing Grounded Dialog `ask_user` facade supports unchanged blocking mode and deferred preference, information and reversible questions. Enable its existing `askUserV1` setting; Glance adds no model-facing tools and communicates only through the public deferred-provider events. Deferred questions cannot authorize actions or escalate based on elapsed time.

The bordered question region uses canonical Pi input, explicit Submit, Dismiss without answering, and Retry delivery controls, with isolated keyboard/mouse handling. Unanswered dismissal requires neither text nor a selection. Hiding a submitted answer does not recall it or stop delivery. Pending, stale, and failed-delivery records remain distinguishable. Failed delivery can be retried without submitting a second answer. Recommendations are not selected automatically. At most four unresolved questions/outbox slots are admitted; normalized questions are bounded at 8 KiB and answers at 4 KiB. Records and answers are branch-aware, revision-checked, and persisted before acknowledgement. Queued answers survive reload.

Answers submitted while busy remain saved. At safe idle they enter session history with `triggerTurn: false`, becoming context for the next natural turn; they never start an automatic response. Explicit `deliveryMode` supports only `nextTurn` and `escalationPolicy` only `never`. Native steering/follow-up queues are not used. Saved delivery markers prevent duplicate insertion during reconciliation. The service confirms persisted receipts and synchronizes the current session file before acknowledging durable question transitions. This does not guarantee exactly-once model processing. Readable-file receipts are bounded at 64 MiB per session file and 2 MiB per JSONL line. A persistence or receipt failure is shown rather than acknowledged as success.

### Conservative unanswered expiry

Automatic expiry requires both **30 minutes of observed eligible active-tool time** and **three meaningful completed agent runs** after the question on the same branch. A meaningful run has a successful edit/write or Todo/Workplan mutation, or at least three eligible successful read/search/navigation operations. Eligible read tools are `read`, query-mode `local_search`, navigation/diagnostic `lsp`, and public web read/search tools. Only normally settled runs count. Runs settled while that question is actively edited earn no expiry credit. Each tool contributes at most five minutes, overlapping tool intervals count once, and at most 64 unique tool spans per run are accounted. Persisted run and source-call identities prevent recounting after reload.

Bash/process/session polling, orchestration, render events, token streaming, idle/AFK time, shutdown, unknown operations, failed runs, automatic retry chains, and runs interrupted by a UI prompt do not count. Tools started before the question do not count. Expiry is evaluated at safe idle. Submitted answers, blocking questions, authorization requests, and questions actively edited in a connected pane do not expire. Wall-clock `expiresAt` does not bypass this policy and new deferred requests cannot specify it. Explicit agent cancellation remains available for obsolete questions.

Manual unanswered dismissal queues one durable dismissal notice. Automatic expiry queues the distinct notice "expired unanswered after continued work." Both use the same safe-idle, next-natural-turn path as answers. Neither selects a default, resolves a decision, grants approval, or starts a response. Expiry is a conservative heuristic, not proof that an answer is unnecessary.

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
