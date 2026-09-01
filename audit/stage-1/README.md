# Stage 1: deployed Pi extensions and repository state

> **DO NOT MERGE — inspection artifact for consolidation planning.**

This directory preserves the exact deployed runtime bytes identified for the Pi environment on 2026-09-01. No live configuration, deployed extension, package, branch, tag, stash, or worktree was changed. Private bundles, patches, status records, and worktree archives remain only in the owner-only local backup and were not uploaded.

## Method

Pi 0.84.2's installed resource-loader and package-manager code was used as the authority. Resolution ran offline and did not execute extensions. The closure follows static local imports and conservative runtime-read/helper paths; `node_modules`, tests, logs, sessions, caches, and unrelated material are excluded. Every copied regular file was dereferenced, mode-preserved, and SHA-256 compared with its deployed source. The manifest records symlink provenance.

## Effective extensions (22)

- `codex-usage-footer` — global auto-discovery; `$HOME/.pi/agent/extensions/codex-usage-footer.ts`; TypeScript source; `audit/stage-1/live-deployed/codex-usage-footer`; exact copy: `true`
- `files-ui` — global settings local-path package; `$HOME/Projects/my-shtty-pi/packages/files-ui/extensions/files/index.ts`; TypeScript source; `audit/stage-1/live-deployed/files-ui`; exact copy: `true`
- `grounded-dialog` — global settings local-path package; `$HOME/.pi/agent/deployments/pi-grounded-tools/0.1.0/afa7977ae759947d3fbc905e0b2beef3d4f0b51c663365614b7ab368aef62c66/packages/dialog/index.ts`; TypeScript source; `audit/stage-1/live-deployed/grounded-dialog`; exact copy: `true`
- `grounded-files` — global settings local-path package; `$HOME/.pi/agent/deployments/pi-grounded-tools/0.1.0/afa7977ae759947d3fbc905e0b2beef3d4f0b51c663365614b7ab368aef62c66/packages/files/index.ts`; TypeScript source; `audit/stage-1/live-deployed/grounded-files`; exact copy: `true`
- `grounded-lsp` — global settings local-path package; `$HOME/.pi/agent/deployments/pi-grounded-tools/0.1.0/afa7977ae759947d3fbc905e0b2beef3d4f0b51c663365614b7ab368aef62c66/packages/lsp/index.ts`; TypeScript source; `audit/stage-1/live-deployed/grounded-lsp`; exact copy: `true`
- `grounded-notes` — global settings local-path package; `$HOME/.pi/agent/deployments/pi-grounded-tools/0.1.0/afa7977ae759947d3fbc905e0b2beef3d4f0b51c663365614b7ab368aef62c66/packages/notes/index.ts`; TypeScript source; `audit/stage-1/live-deployed/grounded-notes`; exact copy: `true`
- `grounded-process` — global settings local-path package; `$HOME/.pi/agent/deployments/pi-grounded-tools/0.1.0/afa7977ae759947d3fbc905e0b2beef3d4f0b51c663365614b7ab368aef62c66/packages/process/index.ts`; TypeScript source; `audit/stage-1/live-deployed/grounded-process`; exact copy: `true`
- `grounded-tasks` — global settings local-path package; `$HOME/.pi/agent/deployments/pi-grounded-tools/0.1.0/afa7977ae759947d3fbc905e0b2beef3d4f0b51c663365614b7ab368aef62c66/packages/tasks/index.ts`; TypeScript source; `audit/stage-1/live-deployed/grounded-tasks`; exact copy: `true`
- `grounded-workplan` — global settings local-path package; `$HOME/.pi/agent/deployments/pi-grounded-tools/0.1.0/afa7977ae759947d3fbc905e0b2beef3d4f0b51c663365614b7ab368aef62c66/packages/workplan/index.ts`; TypeScript source; `audit/stage-1/live-deployed/grounded-workplan`; exact copy: `true`
- `herdr-agent-state` — global auto-discovery; `$HOME/.pi/agent/extensions/herdr-agent-state.ts`; TypeScript source; `audit/stage-1/live-deployed/herdr-agent-state`; exact copy: `true`
- `herdr-blocked-bridge` — global auto-discovery; `$HOME/.pi/agent/extensions/herdr-blocked-bridge.ts`; TypeScript source; `audit/stage-1/live-deployed/herdr-blocked-bridge`; exact copy: `true`
- `herdr-status` — global settings local-path package; `$HOME/Projects/my-shtty-pi/packages/herdr-status/extensions/herdr-status.ts`; TypeScript source; `audit/stage-1/live-deployed/herdr-status`; exact copy: `true`
- `pi-agent-context` — global settings local-path package; `$HOME/Projects/my-shtty-pi/packages/pi-agent-context/extensions/index.ts`; TypeScript source; `audit/stage-1/live-deployed/pi-agent-context`; exact copy: `true`
- `pi-chrono-compaction` — global settings local-path package; `$HOME/.agents/projects/pi-chrono-compaction/implementation/chrono-v2-infinite-memory-005-correction-020/active-project/dist/src/pi-extension.js`; compiled JavaScript; `audit/stage-1/live-deployed/pi-chrono-compaction`; exact copy: `true`
- `pi-herdr-orchestrator` — global settings local-path package; `$HOME/.pi/agent/deployments/pi-herdr-orchestrator/0.1.0/cc04bfe9a978e12f5b3f0e54e3cebd30d4555f99f5e9fda25cbb1f18ffbaf764/dist/extensions/pi-herdr-orchestrator.js`; compiled JavaScript; `audit/stage-1/live-deployed/pi-herdr-orchestrator`; exact copy: `true`
- `pi-native-ssh` — global settings local-path package; `$HOME/.pi/agent/deployments/pi-native-ssh/1.0.0/edadf023051a5b349e6884fc911fa8b02105c1cd8dde58d15f7c17c20229bf2a/src/index.ts`; TypeScript source; `audit/stage-1/live-deployed/pi-native-ssh`; exact copy: `true`
- `pi-pixel-cua` — global settings local-path package; `$HOME/PI_PROJECT_STAGING/projects/pi-pixel-cua/wayland-redesign/product/src/index.ts`; TypeScript source; `audit/stage-1/live-deployed/pi-pixel-cua`; exact copy: `true`
- `pi-progressive-tools` — global settings local-path package; `$HOME/.pi/agent/packages/pi-progressive-tools/extensions/index.ts`; TypeScript source; `audit/stage-1/live-deployed/pi-progressive-tools`; exact copy: `true`
- `pi-signal-board` — global settings local-path package; `$HOME/.pi/agent/deployments/pi-signal-board/0.1.0/e599df249d8c5514fc24e2ec3b614b6315ac46cb6f5585594f34d17dd5b2d32f/dist/index.js`; compiled JavaScript; `audit/stage-1/live-deployed/pi-signal-board`; exact copy: `true`
- `pi-web` — global auto-discovery; `$HOME/.local/lib/pi-web-tools-releases/7f986081b4e8a03729620777248ba1484c9bc4d7/apps/pi-webx/src/index.ts`; TypeScript source; `audit/stage-1/live-deployed/pi-web`; exact copy: `true`
- `temporary-orchestrator-cancel-isolation` — global auto-discovery; `$HOME/.pi/agent/extensions/temporary-orchestrator-cancel-isolation.ts`; TypeScript source; `audit/stage-1/live-deployed/temporary-orchestrator-cancel-isolation`; exact copy: `true`
- `titlebar-spinner` — global auto-discovery; `$HOME/.pi/agent/extensions/titlebar-spinner.ts`; TypeScript source; `audit/stage-1/live-deployed/titlebar-spinner`; exact copy: `true`

## Repository branch summary

- `my-shtty-pi` — local branches: 20 (7 ref/SHA pairs not merged); remote branches: 10 (0 not merged)
- `my-shtty-pi-herdr-deck` — local branches: 102 (36 ref/SHA pairs not merged); remote branches: 26 (0 not merged)
- `pi-signal-board` — local branches: 43 (39 ref/SHA pairs not merged); remote branches: 7 (5 not merged)

Dirty worktrees found: **8**. Stashes found: **2**. Their exact patches and full worktree archives are private local safety backups, not GitHub artifacts.

## Files

- `environment.md` — sanitized environment and resource-resolution details.
- `effective-extensions.json` — activation, entrypoint, provenance, closure, per-file mode/hash, and exact-copy result.
- `repositories.json` — sanitized clone/worktree/ref inventory and loss-risk counts.
- `branch-status.tsv` — each local and remote branch ref with SHA, ahead/behind main, merged state, date, and subject.
- `live-deployed/` — exact dereferenced runtime closure bytes.
- `FILES.sha256` — SHA-256 for every uploaded audit file except the checksum file itself.

## Limits

The runtime closure is a conservative static snapshot. External bare imports are supplied by Node, Pi, system packages, or installed dependencies and are not vendored. Dynamic behavior can make a closure uncertain; possible runtime-read files were included rather than omitted. Activation is the effective configured set for `$HOME`; no current-process CLI extension argument was present.
