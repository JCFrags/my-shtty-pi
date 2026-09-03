# ChronoCompact V3 milestone ledger

| Milestone | State | Evidence | Boundary |
| --- | --- | --- | --- |
| M00 — baseline, containment, and test recovery | published baseline; acceptance carried into R1 review | commit `1887c77b39c42fb0b5d35b38baac94aff13465e9`; baseline hashes, restored tests, privacy evidence, and rollback record | no runtime deployment, reload, settings change, scheduler change, or session change |
| M00-R1 — correction and public-review hardening | in progress | A-0003, fail-closed scanner v2, hardened baseline verifier, root allowlists, CI workflow, correction tests, and bounded local checkpoint | full gates, push, CI confirmation, and independent project-lead review are still required |
| M01 — runtime safety work | blocked | no M01 implementation started | cannot begin until M00 acceptance is reviewed and explicitly cleared |

## R1 acceptance gates

1. Preserve the north-star bytes and frozen runtime hashes.
2. Keep the correction diff within the exact allowlist and exclude Project Glance paths.
3. Pass privacy scans for worktree, index, history/ranges, all fetched refs, and public-review event identity.
4. Pass baseline, deployed-root, package, test, build, and noninterference checks.
5. Push only after the public content gate and identity check pass; do not rewrite history.
6. Verify PR #30 remains open, draft, unmerged, and based on `rebuild/chrono-memory-v3`.
7. Obtain an independent project-lead review before claiming M00 acceptance or starting M01.
