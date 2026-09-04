# Chrono Memory Engine

This directory contains the authoritative ChronoCompact V3 charter and milestone records.

- [`master-goal-and-work-plan.md`](./master-goal-and-work-plan.md) is the byte-preserved north-star charter.
- [`baseline.md`](./baseline.md) records the M00 repository and deployment baseline.
- [`baseline-evidence.json`](./baseline-evidence.json) records the sanitized machine-readable evidence projection.
- [`privacy-policy.md`](./privacy-policy.md) defines the repository, publication, and evidence boundary.
- [`evidence.md`](./evidence.md) lists the sanitized evidence classes and checks.
- [`containment-timeline.md`](./containment-timeline.md) records the containment and public-review sequence.
- [`decisions.md`](./decisions.md) records M00 decisions and the R1 visibility correction.
- [`milestone-ledger.md`](./milestone-ledger.md) records milestone status and gates.
- [`historical-test-inventory.md`](./historical-test-inventory.md) records the complete restored-test inventory.
- [`known-incidents.md`](./known-incidents.md) records bounded incident classifications.
- [`independent-review.md`](./independent-review.md) is a compatibility index to the canonical review records.
- [`reviews/`](./reviews/) contains the directing-assistant project-lead review records.
- [`decision-and-update-protocol.md`](./decision-and-update-protocol.md) defines decision authority, status vocabulary, and update gates.
- [`rollback.md`](./rollback.md) records the M00 rollback point and non-deployment rule.
- [`test-recovery.md`](./test-recovery.md) records the historical test restoration boundary.
- [`amendments/`](./amendments/) records accepted or proposed amendments to the charter.

M00 and M01 are accepted. M01 merged only into `rebuild/chrono-memory-v3` as `0a1ca2ff16d8b79db3fda88f156ea5b9c6864427`; no integration branch was merged to `main`. M02 is active on `work/chrono-v3-m02-test-foundation`, and M03 has not started. The repository is public under the separately recorded A-0003 visibility correction; public visibility is not a release or package publication.

Current runtime status: `Live version: 2.0.1`; `Deployed source: 24c6f13f1f6ac9468dfbeba4cad8021b44ecae7f`; `Isolated worker: enabled after canaries`; `I-0001: contained by the deployed pre-read guard and ledger-only oversized retrieval`; `I-0002: resolved for the controlled reproduction`. M02 has reproduced two memory-safety limitations and is validating a narrow `2.0.2` hotfix candidate; no M02 deployment has occurred yet.
