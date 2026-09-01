# Clean Pi extension monorepo candidate

This branch consolidates extension source and the September 1, 2026 deployed baseline without changing extension behavior. The 15 active families reproduce 21 active entrypoints. Review UI and Tool Controls remain inactive.

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
