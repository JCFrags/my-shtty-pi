# Pi extension monorepo

This repository contains the canonical Pi extension deployment. The 14 active families reproduce 20 active entrypoints. Review UI and Tool Controls remain inactive.

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
| `pi-herdr-orchestrator` | active; canonical direct-Herdr runtime retained |
| `pi-native-ssh` | active |
| `pi-pixel-cua` | active |
| `pi-progressive-tools` | active |
| `pi-review-ui` | inactive |
| `pi-signal-board` | active; compiled runtime retained |
| `pi-tool-controls` | inactive |
| `titlebar-spinner` | active |

Run `npm run verify` to validate deployed hashes, entrypoints, manifests, product boundaries, privacy, and isolated compiled reproducibility. `pi-web` is external and excluded from this repository.
