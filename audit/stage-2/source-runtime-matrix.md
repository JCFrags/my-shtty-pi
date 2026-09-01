# Compiled source/runtime matrix

Stage 1 deployed bytes remain authoritative. These builds ran in new owner-only analysis copies with existing dependency trees, direct `tsc` invocations, no install, no package lifecycle hook, and no extension execution. Extra compiler outputs were not substituted for the Stage 1 snapshots.

| Product | Pi-loaded runtime | Best source | Isolated result | Classification |
|---|---|---|---|---|
| ChronoCompact | `audit/stage-1/live-deployed/pi-chrono-compaction/dist/src/pi-extension.js` and 64 local runtime modules | `JCFrags/my-shtty-pi` commit `9a4d25a46f329bd91828a22a925e5de81c71eee4`, `packages/chrono-compact` | TypeScript 5.9.3 build succeeded; all 65 deployed JavaScript files were byte-exact; 58 CLI/test or otherwise non-closure JavaScript outputs were extra | `EXACT_REPRODUCIBLE` |
| Pi Herdr Orchestrator / Agent Board | `audit/stage-1/live-deployed/pi-herdr-orchestrator/dist/extensions/pi-herdr-orchestrator.js` and 29 local runtime modules | `JCFrags/my-shtty-pi-herdr-deck` `deploy/adopted-root-rebind-recovery` at `79046614e870088b832f9dd1d98495e16cfd9345` | TypeScript 5.8.3 build succeeded; all 30 deployed JavaScript files were byte-exact | `EXACT_REPRODUCIBLE` |
| Pi Signal Board | `audit/stage-1/live-deployed/pi-signal-board/dist/index.js` and 56 local runtime modules | `JCFrags/pi-signal-board` `agent/ask-user-signals-deploy-fix-20260827` at `047ab0e767a7655eb854647e09487a188952516a` | TypeScript 5.9.3 build succeeded; all 57 deployed JavaScript files were byte-exact; four type/support JavaScript outputs were extra | `EXACT_REPRODUCIBLE` |

## Interpretation

- Exact reproducibility is limited to the Stage 1 runtime closure. It does not authorize replacement of deployed files.
- The best historical source trees are the future canonical source baselines for these compiled products.
- Generated files outside each deployed closure are not retained by default.
- The orchestrator source/build confirms that `temporary-orchestrator-cancel-isolation` is not already present in the deployed orchestrator. The temporary extension therefore remains a separate `ACTIVE_TEMPORARY` baseline item.
- ChronoCompact remains its own product. The orchestrator's pinned vendored ChronoCompact package is build provenance, not a reason to merge product ownership.
