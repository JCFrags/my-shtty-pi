# Chrono Memory Engine

This directory contains the authoritative ChronoCompact V3 charter and milestone records.

- [`master-goal-and-work-plan.md`](./master-goal-and-work-plan.md) is the byte-preserved north-star charter.
- [`baseline.md`](./baseline.md) records the M00 repository and deployment baseline.
- [`baseline-evidence.json`](./baseline-evidence.json) records the sanitized machine-readable evidence projection.
- [`privacy-policy.md`](./privacy-policy.md) defines the repository, publication, and evidence boundary.
- [`evidence.md`](./evidence.md) lists the sanitized evidence classes and checks.
- [`containment-timeline.md`](./containment-timeline.md) records the containment and public-review sequence.
- [`decisions.md`](./decisions.md) records milestone decisions and links the approved V3 scope amendment.
- [`milestone-ledger.md`](./milestone-ledger.md) records milestone status and gates.
- [`historical-test-inventory.md`](./historical-test-inventory.md) records the complete restored-test inventory.
- [`known-incidents.md`](./known-incidents.md) records bounded incident classifications.
- [`independent-review.md`](./independent-review.md) is a compatibility index to the canonical review records.
- [`reviews/`](./reviews/) contains the directing-assistant project-lead review records.
- [`decision-and-update-protocol.md`](./decision-and-update-protocol.md) defines decision authority, status vocabulary, and update gates.
- [`rollback.md`](./rollback.md) records the M00 rollback point and non-deployment rule.
- [`test-recovery.md`](./test-recovery.md) records the historical test restoration boundary.
- [`amendments/`](./amendments/) records accepted or proposed amendments to the charter, including [A-0004](./amendments/A-0004-v3-timeline-and-catalog-scope.md) for the approved timeline-first scope and M04 boundary.

M00, M01, M02, and M03 are accepted. M01 merged only into `rebuild/chrono-memory-v3` as `0a1ca2ff16d8b79db3fda88f156ea5b9c6864427`; no integration branch was merged to `main`. M02 is accepted at `2bd0195a6d84f20fad016ba7eba61786393edeeb`, and M03 is accepted at `afec7d3ac48ef369b27c6609347666af2f8c289b`. PR #35 metadata-only closeout merged into integration as `afb5f81b9eb6931cbf6f08d90413b3766829f192`. M04 implementation is authorized under A-0004; M05 and production catalog activation are not authorized. The repository is public under the separately recorded A-0003 visibility correction; public visibility is not a release or package publication.

Current runtime status: `Live version: 2.0.4`; `Deployed source: ad23f0b71ee473d33aff26d367459e76d208c631`; `Isolated worker: enabled`; `Rollback: verified 2.0.3 backup ready`. M03 corrected memory admission and transactional runtime behavior; F001/F002 are closed by project-lead acceptance. The accepted review head is distinct from deployed source. See the M03 report for exact CI, canaries, fixed limits, and remaining limitations. M04 must preserve this production installation unchanged.
