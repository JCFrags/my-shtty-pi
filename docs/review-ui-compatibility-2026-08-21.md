# Review UI Pi 0.84.1 and Grounded Tools acceptance

Date: 2026-08-21

## Result

Review UI is a candidate. Clean packaging, exact active-owner preview, keyboard safety, owned Pi mouse dispatch, and the requested real-TUI cases passed.

The requested `docs/ui-products-real-baseline-2026-08-21.md` file was not present. The merged PRs #10 through #13, the installed Pi 0.84.1 runtime, and the active Grounded Tools source were used as the observed baseline.

## Runtime boundary

- Pi: 0.84.1.
- TUI: fullscreen.
- Mouse: decoded component-local events from the installed owned Tool Controls patch from PR #13.
- Review UI does not enable or parse raw mouse input.
- Active file-tool owner before activation: `<home>/pi-grounded-tools/packages/files/index.ts`.
- The observed Pi `sourceInfo.path` for both `edit` and `write` matched that exact entry.

## Implemented correction

Grounded Tools now registers `pi-grounded-tools/files-v1` through the shared extension event bus. The registration contains its exact source entry and versioned edit/write semantics. The Grounded execution path and preview adapter use the same pure content-construction functions.

Review UI resolves the current owner through `pi.getAllTools()` for every call. It accepts only exact built-in provenance or an exact registered adapter source path. Missing, duplicate, forged, and unsupported owners fail closed.

The package manifest now points to clean-loadable TypeScript source. `prepack` builds the exported `dist` library. The packed smoke test verifies the source manifest entry and loads the compiled package output.

The owned Pi patch sends `localRow` and `localCol`. Review UI now uses those fields before global coordinates. This correction made real SGR input dispatch through Pi's patch reach the explicit button regions.

## Automated checks

- `packages/review-ui`: `npm run validate` passed with 71 tests, typecheck, build, and packed smoke.
- `packages/grounded-tools`: `npm run check` passed with 101 tests, typecheck, exact artifact checks, and pack checks.
- Repository: `npm run check` passed.
- Repository: `npm run test:repo` passed with 86 tests.

## Real TUI acceptance

A disposable `PI_CODING_AGENT_DIR`, temporary working directory, Pi `--no-session`, the real Pi 0.84.1 TUI, the corrected Grounded files extension, and a bounded acceptance command were used. No model call was needed.

These cases passed:

- keyboard approve and reject;
- outside-cwd approval plus the separate path confirmation;
- oversized summary approval plus the separate summary confirmation;
- UTF-8 BOM and CRLF edit preservation;
- two parallel reviews in FIFO order;
- active and queued abort/reload cleanup;
- exact base64 bytes shown as proposed versus bytes written;
- real SGR mouse press and release on **Approve once**, decoded and dispatched only by the installed Pi patch.

Evidence was written under disposable `/tmp/review-tui-*` directories. Consolidated evidence was `/tmp/review-tui-acceptance-results.json` and `/tmp/review-tui-mouse-result.json` during acceptance.

## Activation and rollback

Activation uses the merged main checkout as the clean package source:

- Grounded Tools: `<repo>/packages/grounded-tools`
- Review UI: `<repo>/packages/review-ui`

Before activation, copy `~/.pi/agent/settings.json` to a mode-0600 timestamped file under `~/.pi/agent/activation-backups/`. Record its SHA-256. Replace the old `../../pi-grounded-tools` package entry with the merged Grounded package path. Add the merged Review UI package path once. Keep the installed Pi patch backup unchanged.

Rollback:

1. Stop or reload Pi sessions that use the packages.
2. Restore the recorded settings file bytes atomically.
3. Run `pi list` and confirm that Review UI is absent and the prior Grounded source is active.
4. Reload Pi.
5. Do not run `pi update`. The installed Tool Controls patch has its separate `.tool-controls-patch-backup-0.84.1` rollback.
