# Stage 3 private-state resolution

This file records sanitized conclusions only. Raw worktree archives, patches, stash bytes, logs, settings, sessions, and machine paths remain in owner-only local backup storage and were not uploaded.

## Counts

- Dirty worktrees: 8 total — 7 `REJECTED_NONCORE`, 1 `DUPLICATE_OR_SUPERSEDED`.
- Stashes: 2 total — 1 `REJECTED_NONCORE`, 1 `PRESERVED_TARGET_BRANCH`.
- Combined: 8 `REJECTED_NONCORE`, 1 `DUPLICATE_OR_SUPERSEDED`, 1 `PRESERVED_TARGET_BRANCH`, 0 `BLOCKED`.

## Sanitized item decisions

| Item | Kind | Repository | Sanitized source | Source HEAD | Disposition | Target | Conclusion |
|---|---|---|---|---|---|---|---|
| `private-D01` | dirty worktree | `my-shtty-pi-herdr-deck` | `agent/final-gate-agents-activity` | `5f43d9ce3698949315db07cbafb7ce315aafa816` | `REJECTED_NONCORE` | `-` | Only untracked node_modules generated dependency content. |
| `private-D02` | dirty worktree | `my-shtty-pi-herdr-deck` | `agent/final-gate-board` | `d14a0da0fc12a83210048966ecc03b7a47be6656` | `REJECTED_NONCORE` | `-` | Only untracked node_modules generated dependency content. |
| `private-D03` | dirty worktree | `my-shtty-pi-herdr-deck` | `agent/final-gate-files` | `782f7f036468b4be851dba02fb2d88f39e5dd470` | `REJECTED_NONCORE` | `-` | Only untracked node_modules generated dependency content. |
| `private-D04` | dirty worktree | `my-shtty-pi-herdr-deck` | `agent/final-gate-render` | `765b0afa1f1731bc0caae21d25b37a8261ce50fd` | `REJECTED_NONCORE` | `-` | Only untracked node_modules generated dependency content. |
| `private-D05` | dirty worktree | `my-shtty-pi-herdr-deck` | `agent/final-gate-signals` | `c0dc6cc909b5d9a6eeec866d4a2c91accb63d506` | `REJECTED_NONCORE` | `-` | Only untracked node_modules generated dependency content. |
| `private-D06` | dirty worktree | `my-shtty-pi-herdr-deck` | `managed canary worktree` | `8345439198f230684f31f4bcf7ea541e75459c82` | `REJECTED_NONCORE` | `-` | Only one untracked canary output text file. |
| `private-D07` | dirty worktree | `my-shtty-pi-herdr-deck` | `managed canary result worktree` | `b5f53d927a94a414e4d1a358a070ab40e59282c2` | `REJECTED_NONCORE` | `-` | Only one untracked canary result text file. |
| `private-D08` | dirty worktree | `my-shtty-pi` | `feat/files-side-panel-state` | `cc2561b389752227e7849e47fcb318e0ec102dc4` | `DUPLICATE_OR_SUPERSEDED` | `-` | Runtime-relevant changed blobs are present in current main, the selected Chrono source lineage, or exact Stage 1 closures; remaining untracked content is docs, benchmarks, workflows, and broad tests. |
| `private-S01` | stash | `my-shtty-pi` | `private Stage 1 stash backup` | `b9fbfab9bd4a0c162f5099c1fc2acef169fc91a7` | `REJECTED_NONCORE` | `-` | The stash has no tracked changes and contains only one untracked historical UI-baseline report. |
| `private-S02` | stash | `my-shtty-pi-herdr-deck` | `private Stage 1 stash backup` | `5df55fdb7aae6a54a9b339f433c91831861cd2ad` | `PRESERVED_TARGET_BRANCH` | `preserved/pi-herdr-orchestrator/pre-reliability-integration-20260825` | Against the final canonical candidate, one reliability source blob and five directly related integration tests remain different; a second source change is already canonical and an unrelated README change was omitted. |

## Publication privacy gate

One provisional local-only preservation candidate contained non-build provenance metadata that crossed the private-path boundary. It was not pushed. A code-only candidate based directly on the final canonical commit passed the privacy gate and was published. The rejected provisional local ref remains only in private control storage because the no-deletion rule remains in force.
