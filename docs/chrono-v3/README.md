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
- [`architecture.md`](./architecture.md) describes current startup, indexed derivation, state-v4, rollup-v3, composition, and logical-session behavior.
- [`configuration.md`](./configuration.md) records current configuration precedence, defaults, and session exclusions.
- [`operations.md`](./operations.md) gives current startup, migration, bounded retrieval, sharding, and deployment procedures.
- [`recovery.md`](./recovery.md) gives current derived-store, logical-session, exact-retrieval, and deployment rollback procedures.
- [`amendments/`](./amendments/) records accepted or proposed amendments to the charter, including [A-0004](./amendments/A-0004-v3-timeline-and-catalog-scope.md) for the approved timeline-first scope and M04 boundary.

## Current documentation boundary

The operational documents describe source revision `30668f7586781410e9958fc56d8f677d08bc7d4e`, packaged as ChronoCompact `2.0.25` for Pi `0.85.1`. They supplement the frozen charter and accepted reports. They do not alter milestone acceptance.

The candidate includes startup adoption, checkpoint-derived migration status, bounded indexed search and exact recovery, state-v4 and rollup-v3 derivation, guarded composition, manual logical rollover and fork, and continuation-only shard persistence. `memoryEngineEnabled` remains off by default pending qualification.

The corrected installed-Pi ten-shard retry, original state-v4 catch-up, and exact final-candidate M11 core campaign remain independent pending evidence. No default activation, scale pass, all-session adoption, N-of-N live reload, exercised final deployment rollback, remote `main` integration, or deployed SHA match is claimed. Later package or integration work outside the documented revision is not evidence for this snapshot.

The repository is public under A-0003. Public visibility is not a release, package publication, deployment, or permission to commit private runtime data.
