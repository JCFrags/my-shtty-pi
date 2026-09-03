# Pi extension monorepo

This repository has two distinct layers: a captured deployed baseline and a separate additive development product. They are verified independently so development work does not change the historical deployment record.

## Captured deployed baseline

The September 1, 2026 baseline contains 17 original products: 15 active families, 21 active entrypoints, 272 runtime records, and 261 deployed hashes. The existing baseline-verification phase preserves that inventory and its product table below. Review UI and Tool Controls remain inactive.

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

## Additive development product

`packages/pi-project-glance` is a separate additive development product. It is not part of the captured deployed-hash inventory and contains both the Pi extension and the Herdr `glance` pane. Its private local IPC and read-only relay now project bounded Step, Toward, and Focus values from public Todo and Workplan event contracts while keeping the live Progress Feed empty. Workplan activity is contracted for later feed work but is not rendered in this slice. Assistant-message extraction, unread state, and other feed behavior remain intentionally out of scope. This is not a claim that V1 is complete.

Run `npm run verify` to validate the captured baseline and the isolated Project Glance development product. `pi-web` is external and excluded from this repository.
