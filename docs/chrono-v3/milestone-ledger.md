# ChronoCompact V3 milestone ledger

| Milestone | State | Evidence | Boundary |
| --- | --- | --- | --- |
| M00 — baseline, containment, and test recovery | accepted by directing assistant at reviewed head `9a2dbe13a15e9d4418d8a843ffa28ceb272cbff2` | original commit `1887c77b39c42fb0b5d35b38baac94aff13465e9`; baseline hashes, restored tests, privacy evidence, rollback record, R1/R2 corrections, and project-lead acceptance record | no runtime deployment occurred during M00 |
| M00-R1 — correction and public-review hardening | completed as part of accepted M00 | A-0003, fail-closed scanner v2, hardened baseline verifier, root allowlists, CI workflow, correction tests, and R1 history through `370cbf1522c8ec7acfe49907a969e633e829b6bb` | no deployment occurred |
| M00-R2 — close the remaining independent-review gaps | completed and accepted as part of M00 | R2-F001 through R2-F010, schema-3 publication scanner, event-scoped workflow, baseline/root gates, typed evidence, review records, complete inventory, test-only timing corrections, and final reviewed head `9a2dbe13a15e9d4418d8a843ffa28ceb272cbff2` | no deployment occurred |
| M01 — runtime safety work | authorized | project-lead acceptance record authorizes M01 | implementation, release, and deployment remain subject to M01 gates |

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

The R2 gates were accepted by the directing assistant at reviewed head `9a2dbe13a15e9d4418d8a843ffa28ceb272cbff2`. M01 is authorized; its implementation and deployment remain separately gated.
