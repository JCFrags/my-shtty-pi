# ChronoCompact V3 milestone ledger

| Milestone | State | Evidence | Boundary |
| --- | --- | --- | --- |
| M00 — baseline, containment, and test recovery | accepted by directing assistant at reviewed head `9a2dbe13a15e9d4418d8a843ffa28ceb272cbff2` | original commit `1887c77b39c42fb0b5d35b38baac94aff13465e9`; baseline hashes, restored tests, privacy evidence, rollback record, R1/R2 corrections, and project-lead acceptance record | no runtime deployment occurred during M00 |
| M00-R1 — correction and public-review hardening | completed as part of accepted M00 | A-0003, fail-closed scanner v2, hardened baseline verifier, root allowlists, CI workflow, correction tests, and R1 history through `370cbf1522c8ec7acfe49907a969e633e829b6bb` | no deployment occurred |
| M00-R2 — close the remaining independent-review gaps | completed and accepted as part of M00 | R2-F001 through R2-F010, schema-3 publication scanner, event-scoped workflow, baseline/root gates, typed evidence, review records, complete inventory, test-only timing corrections, and final reviewed head `9a2dbe13a15e9d4418d8a843ffa28ceb272cbff2` | no deployment occurred |
| M01 — runtime safety work | accepted by directing assistant at evidence head `aa079f87d5bb4e8756e4392a521108430551308a` | deployed commit `24c6f13f1f6ac9468dfbeba4cad8021b44ecae7f`, [M01 safety report](./reviews/M01-safety-report.md), [project-lead acceptance](./reviews/M01-project-lead-acceptance.md), 307/307 package tests, fixed-heap guard, root/privacy gates, passing CI, verified rollback, and live smokes | merged only into `rebuild/chrono-memory-v3` as `0a1ca2ff16d8b79db3fda88f156ea5b9c6864427`; no `main` merge; M02 authorized |
| M02 — deterministic test foundation | accepted by directing assistant at evidence head `2bd0195a6d84f20fad016ba7eba61786393edeeb` | branch `work/chrono-v3-m02-test-foundation`, PR #34, [M02 test-foundation report](./reviews/M02-test-foundation-report.md), 329/329 package tests, unified commands, 512 MiB/1 GiB lanes, deployed-worker soaks, exact-head push/PR CI, and live `2.0.2` smokes | merged only into `rebuild/chrono-memory-v3` as `ea977dbb09ccea5265a435ce831303282622f97a`; deployed source `0c7173ff03ed010747ab9b5d7be6f8f84d423819`; accepted accounting limitation: measured retained memory about 24.7 MB exceeded the 8.7 MB admission charge and the M02 regression did not enforce that discrepancy; M03 authorized to correct admission first; no `main` merge |
| M03 — transactional runtime and scheduler | in progress on `work/chrono-v3-m03-runtime` | [M03 runtime report](./reviews/M03-runtime-report.md); `2.0.3` memory-admission candidate reserves before load/parse and its fixed-heap regression requires the 32-times envelope to cover measured retained heap; 333/333 package tests and repository/root gates pass locally | live remains `2.0.2` from `0c7173ff03ed010747ab9b5d7be6f8f84d423819` until exact-head CI and guarded activation complete; scheduler/job-contract work remains; no `main` merge and no M04 work |

## R2 acceptance gates

1. Preserve the north-star bytes and frozen runtime hashes.
2. Keep the correction diff within the exact allowlist and exclude Project Glance paths.
3. Pass independent identity and content gates: worktree, index, historical range, all refs, and event-scoped public-review scans.
4. Pass baseline, deployed-root, package, test, build, and noninterference checks with a clean repository by default.
5. Pass the complete historical inventory and sanitized schema-2-or-higher evidence checks.
6. Pass the serialized 294/294 ChronoCompact characterization suite and the meaningful correction-test suites.
7. Push only after the public content gate and identity check pass; do not rewrite history.
8. Verify PR #30 remains open, draft, unmerged, and based on `rebuild/chrono-memory-v3`.
9. Record local secondary reviews as advisory only and require a fresh directing-assistant project-lead review of the pushed R2 head.
10. Keep runtime source/dist, live files, settings, scheduler, sessions, releases, and M01 untouched.

The R2 gates were accepted by the directing assistant at reviewed head `9a2dbe13a15e9d4418d8a843ffa28ceb272cbff2`. M01 was accepted at evidence head `aa079f87d5bb4e8756e4392a521108430551308a` and merged only into `rebuild/chrono-memory-v3` as `0a1ca2ff16d8b79db3fda88f156ea5b9c6864427`. M02 was accepted at evidence head `2bd0195a6d84f20fad016ba7eba61786393edeeb`; its deployed ChronoCompact `2.0.2` source remains `0c7173ff03ed010747ab9b5d7be6f8f84d423819`. M03 is authorized, beginning with correction of the accepted memory-accounting limitation. `main` remains outside this boundary.
