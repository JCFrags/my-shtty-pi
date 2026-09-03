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

Run these commands from this package directory:

```text
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm pack --dry-run
npm run dev:doctor
npm run dev:link
npm run dev:unlink
npm run dev:fixture -- --open
```

`dev:link` and `dev:unlink` use Pi's supported local package commands and Herdr's supported local plugin commands. They only manage this package's registrations. `dev:doctor` checks the built entrypoints, both links, and a disposable authenticated relay. Run the link and doctor commands from a Herdr-managed pane. `dev:fixture` starts a disposable static fixture relay (fixture code is not used by production) and accepts `--open` to open the pane in the current Herdr workspace; `--restart-after-ms=500` exercises generation reconnect. Stop it with Ctrl-C after closing the disposable pane.

The build output in `dist/` and local dependencies are development artifacts and are not committed. Add `--long-feed` to `dev:fixture` when testing the feed viewport and terminal-width wrapping.
