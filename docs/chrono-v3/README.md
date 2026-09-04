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

M00, M01, and M02 are accepted. M01 merged only into `rebuild/chrono-memory-v3` as `0a1ca2ff16d8b79db3fda88f156ea5b9c6864427`; no integration branch was merged to `main`. M02 is accepted at `2bd0195a6d84f20fad016ba7eba61786393edeeb`, and M03 is authorized. The repository is public under the separately recorded A-0003 visibility correction; public visibility is not a release or package publication.

Current runtime status: `Live version: 2.0.2`; `Deployed source: 0c7173ff03ed010747ab9b5d7be6f8f84d423819`; `Isolated worker: enabled after repeated success, append, and controlled-failure canaries`; `I-0001: contained by bounded pre-parse loading and ledger-only oversized retrieval`; `I-0002: resolved for the controlled reproduction`. M03 begins by correcting the accepted search-memory accounting limitation: measured retained memory was about 24.7 MB while the admission charge was about 8.7 MB, and the M02 regression did not enforce that discrepancy.
