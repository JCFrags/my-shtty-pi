# ChronoCompact V3 milestone ledger

| Milestone | State | Evidence | Boundary |
| --- | --- | --- | --- |
| M00 — baseline, containment, and test recovery | published baseline; acceptance pending | commit `1887c77b39c42fb0b5d35b38baac94aff13465e9`; baseline hashes, restored tests, privacy evidence, and rollback record | no runtime deployment, reload, settings change, scheduler change, or session change |
| M00-R1 — correction and public-review hardening | changes requested in directing-assistant project-lead review 1; R1 corrections recorded | A-0003, fail-closed scanner v2, hardened baseline verifier, root allowlists, CI workflow, correction tests, R1 history through `370cbf1522c8ec7acfe49907a969e633e829b6bb`, and advisory local secondary reviews | explicit directing-assistant project-lead review remains required; no deployment or M01 authorization |
| M00-R2 — close the remaining independent-review gaps | changes requested in directing-assistant project-lead review 2; corrections implemented locally; CI pending | R2-F001 through R2-F010, schema-3 publication scanner, event-scoped workflow, baseline/root gates, typed evidence, review records, complete inventory, and test-only timing corrections | no runtime deployment; M00 remains unaccepted and M01 remains unauthorized |
| M01 — runtime safety work | blocked | no M01 implementation started | cannot begin until M00 acceptance and M01 authorization are explicitly recorded |

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

The expected post-CI wording is `M00-R2 corrections complete; ready for directing-assistant project-lead re-review`. It is not an acceptance claim.
