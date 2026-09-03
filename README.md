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

## ChronoCompact M00

The M00 baseline, privacy policy, evidence boundary, amendments, rollback record, restored-test inventory, review records, and decision/update protocol are documented in [`docs/chrono-v3/`](docs/chrono-v3/). M00-R2 corrections are ready for directing-assistant project-lead re-review; M00 remains unaccepted. M00 is containment and verification only: it does not deploy, reload, or change ChronoCompact runtime behavior. `ChronoCompact V3 runtime fixes deployed: none`; live extension behavior is unchanged; the first expected usable fix milestone is M01.
