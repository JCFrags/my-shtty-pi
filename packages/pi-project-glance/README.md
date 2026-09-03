# Pi Project Glance

Pi Project Glance is a persistent, read-only Herdr side pane. The package contains the Pi extension relay and the standalone `glance` pane.

## Fixed identity

- Product: Pi Project Glance
- Pi command: `/project-glance`
- Herdr pane: `glance`
- Pane title: `Project Glance`
- Feed section: `Progress Feed`

## Foundation behavior

The Pi extension starts one private local relay for the current session. The pane receives an authenticated, versioned, bounded snapshot and renders the `CURRENT` and `PROGRESS FEED` sections. `CURRENT` is pinned while only `PROGRESS FEED` scrolls. The live relay begins with an empty current projection and an empty feed, then consumes only the public Todo summary and versioned Workplan summary event contracts. `Step` comes from a correlated Todo summary response, `Toward` comes from the Workplan summary's deterministic milestone selection, and `Focus` comes from its latest checkpoint. Todo changed events are invalidations even when the existing v1 envelope carries a snapshot; Project Glance never trusts that changed-event snapshot as current state and always issues a new correlated request. Current-state requests are branch-correlated. Session-tree navigation, relay restart, and command-context reconciliation use one serialized lifecycle path. Values use exactly two ASCII spaces between an ID and its text, for example `T1  Do the bounded work` and `WP1-M1  Milestone`. Projection prose replaces every occurrence of the current home-directory prefix with `$HOME`; an unsafe individual current row is omitted without suppressing safe rows. Provider request and branch identifiers are bounded opaque values and are compared exactly, without whitespace normalization. Project Glance never mutates either provider, the orchestration broker, or session state. No Project Glance content is persisted; only the pane registration needed for focus-existing is retained.

The relay uses protocol version 1 with a 64 KiB **wire-frame** limit. The accepted snapshot payload budget is smaller because the snapshot must fit inside both the initial snapshot envelope and a correlated `snapshot_request` response envelope. Every accepted snapshot is checked against both envelopes, in addition to bounded text and feed limits. The reconnecting client is generation-aware. Its owner-only Unix socket and connection descriptor are kept under an owner-only runtime directory and the descriptor is passed to the pane through `PI_PROJECT_GLANCE_DESCRIPTOR`; authentication material is never printed or placed in process arguments. The live Progress Feed remains empty in this slice; assistant-message extraction and activity rendering are later work.

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

The Pi command and Herdr opener report stable actionable diagnostics such as `PROJECT_GLANCE_RELOAD_REQUIRED`, `PROJECT_GLANCE_PLUGIN_NOT_LINKED`, `PROJECT_GLANCE_RUNTIME_START_FAILED`, and `PROJECT_GLANCE_OPEN_RESPONSE_INVALID`. No Progress Feed extraction, history, paging, unread, dismissal, expansion, or compact status is implemented in this slice.
