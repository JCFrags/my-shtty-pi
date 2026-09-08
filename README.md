# Pi extension monorepo

This repository consolidates extension source and the September 1, 2026 deployed baseline without changing extension behavior. The 15 active families reproduce 21 active entrypoints. Review UI and Tool Controls remain inactive.

| Product | Status |
|---|---|
| `codex-usage-footer` | active |
| `files-ui` | active |
| `grounded-tools` | active; seven entrypoints with one shared core |
| `herdr-agent-state` | active |
| `herdr-blocked-bridge` | active |
| `herdr-status` | active |
| `pi-agent-context` | active |
| `pi-chrono-compaction` | active; compiled runtime retained |
| `pi-herdr-orchestrator` | active; compiled runtime retained |
| `pi-native-ssh` | active |
| `pi-pixel-cua` | active |
| `pi-progressive-tools` | active |
| `pi-review-ui` | inactive |
| `pi-signal-board` | active; compiled runtime retained |
| `pi-tool-controls` | inactive |
| `temporary-orchestrator-cancel-isolation` | active temporary; separate from the orchestrator |
| `titlebar-spinner` | active |

Run `npm run verify` to validate deployed hashes, entrypoints, manifests, product boundaries, privacy, and isolated compiled reproducibility. `pi-web` is external and excluded from this repository.

## ChronoCompact candidate boundary

M00 through M03 are accepted; M04 is an unaccepted draft. The candidate remains version `2.0.4` (unreleased). Its retained inventory is 96 source files, 95 compiled JavaScript files, and 96 ChronoCompact manifest entries. Across the 15 active families, the current repository has 291 manifest entries; the historical Stage 1 record count remains 272. Production remains on accepted M03, not this candidate.

The frozen verifier checks this exact candidate. Use `node scripts/verify-chrono-v3-baseline.mjs --allow-missing-live --static-only` for the committed repository gate, and synthetic copied packages for candidate live-fixture tests. Do not change production to make a candidate comparison pass. The root verifier rebuilds native SQLite after its isolated reinstall using exact local Node 24.18.0 headers, then probes real allocation refusal after the distribution build. See [ADR-002](docs/chrono-v3/adr/ADR-002-sqlite-catalog.md) for explicit header preparation and the controlled build. Generated source maps belong to isolated build verification, not the tracked frozen distribution.

The [project records](docs/chrono-v3/) own milestone state, privacy, rollback, and acceptance. No M04 acceptance, production activation, or package publication is implied.
