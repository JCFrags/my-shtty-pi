# M00 review records

This directory is the canonical index for M00 review provenance.

- [`M00-project-lead-review-1.md`](./M00-project-lead-review-1.md) records the directing-assistant project-lead review that identified the R1 correction set.
- [`M00-project-lead-review-2.md`](./M00-project-lead-review-2.md) records the directing-assistant project-lead review that identified R2-F001 through R2-F010.
- [`M00-project-lead-acceptance.md`](./M00-project-lead-acceptance.md) records explicit M00 acceptance at reviewed head `9a2dbe13a15e9d4418d8a843ffa28ceb272cbff2` and M01 authorization.
- [`M01-safety-report.md`](./M01-safety-report.md) records the exact M01 implementation, activation, rollback, smoke, and incident evidence at accepted head `aa079f87d5bb4e8756e4392a521108430551308a`.
- [`M01-project-lead-acceptance.md`](./M01-project-lead-acceptance.md) records explicit M01 acceptance at that evidence head, deployed runtime source `24c6f13f1f6ac9468dfbeba4cad8021b44ecae7f`, and M02 authorization.
- [`M02-test-foundation-report.md`](./M02-test-foundation-report.md) records the deterministic generator, unified commands, fault and fixed-heap matrix, deployed-worker soak, memory findings, and narrow `2.0.2` candidate.

## Latest advisory audit

A fresh local secondary read-only audit inspected exact pushed head `74c2e45ecf4faf65c73db3ddd3d4b8a7628bf5b9` after its push and pull-request CI runs passed. It reproduced no blocking defect; the final diff from `fd596f6` is limited to four sanitized documentation/evidence files, and the validation-target and CI attestations are present. This result is advisory, distinct from directing-assistant project-lead review, and does not accept M00 or authorize M01.

## Terminology

- **Local secondary review:** advisory review performed by a local Pi worker or local read-only reviewer. It is not project-lead acceptance.
- **Directing-assistant project-lead review:** the governing review performed by the directing assistant against the pushed GitHub state and required evidence.
- **Acceptance:** an explicit directing-assistant decision. A test pass, local secondary review, or correction completion does not grant it.

The directing assistant accepted M00 at reviewed head `9a2dbe13a15e9d4418d8a843ffa28ceb272cbff2`, then accepted M01 at evidence head `aa079f87d5bb4e8756e4392a521108430551308a` and authorized M02. M01 merged only into `rebuild/chrono-memory-v3` as `0a1ca2ff16d8b79db3fda88f156ea5b9c6864427`. The live package remains ChronoCompact `2.0.1` from source commit `24c6f13f1f6ac9468dfbeba4cad8021b44ecae7f` while the verified `2.0.2` M02 candidate completes its gates.
