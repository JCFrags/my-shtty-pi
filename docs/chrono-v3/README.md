# Chrono Memory Engine documentation

ChronoCompact develops source-linked chronological memory for Pi. This directory separates the current product direction, subject documentation, architecture decisions, and historical evidence.

## Current priorities

The owner's current direction takes priority over the old milestone and specification gates:

1. Provide useful fuzzy chronological memory and recall for both short tasks and extremely long lifetime tasks.
2. Keep RAM, CPU, and any optional GPU use bounded so Pi and the workstation remain responsive.

Deliver a usable V3, exercise the changed behavior, and improve it through actual use. Do not make perfection, hundreds of new tests, or completion of every historical campaign a release prerequisite. Preserve source history, privacy, safe failure, and practical rollback.

## Memory model

The programmatic core maintains selective chronological short-term memory. Important events keep more detail. Routine or repetitive events can use compact representations or leave active context. Current state supports that timeline rather than replacing it with an ever-growing checklist.

Keep the exact raw tail small and adaptive. Context budgets must use the selected model's limits and configurable policy, not a universal fixed allocation. The working context is intentionally incomplete. Omitted detail can be forgotten there while the immutable source remains recoverable through source-linked search, staged recall, and exact retrieval.

Optional language-model assistance may improve an individual event or a bounded group. It must not replace the whole history or become required processing. The deterministic path must remain useful without it. Derived memory and model advice do not gain instruction authority.

The V3 path uses incremental catalogs, event capsules, episodes, current state, and hierarchical rollups. Normal search and composition must use bounded selected data, not rebuild or materialize the complete lifetime archive. Logical sessions connect physical shards without deleting old source. See the subject pages for the implemented paths, configuration, and limits.

<a id="current-documentation-boundary"></a>

## Release and evidence boundary

Version `3.0.1` enables programmatic V3 memory and safe-idle physical rollover by default. Focused checks exercise composition without model calls, useful bounded recall, complete native tool-state transfer, and real Pi physical replacement with restart. This supersedes the disabled-by-default 2.x development configuration. The [patch corrections](../chrono-release-compatibility.md#current-301-release) cover failed-compaction continuation, tree navigation, and verified common-prefix reuse.

A package version, an enabled setting, ready indexes, and a loaded working installation remain different facts. This overview describes source behavior, not an activation receipt. The retained scale campaign failed before completing its matrix, as recorded in the [settled evidence](reviews/M11-report-correction.md#actual-settled-campaign). Neither architectural limits nor prepared data establish perfect recall or billion-token normal-use qualification.

Read versioned reports and older ADRs as evidence for their recorded revisions. Earlier pending work is not automatically a current failure, and an earlier pass does not validate later code. Use [configuration](configuration.md), [operations](operations.md), and [deployment](deployment.md) for effective policy and loaded-use checks.

The [historical master plan](master-goal-and-work-plan.md), [A-0004](amendments/A-0004-v3-timeline-and-catalog-scope.md), and milestone records remain useful design and recovery guides. Their old token allocations, required summary path, review loops, and scale campaigns do not override the current priorities above. This realignment grants no new provider-call, publication, or deployment permission.

## Subject map

Use these subject owners for implementation details. The map also preserves the historical charter's section 27 references without creating duplicate filename aliases.

| Subject | Start here | Purpose |
| --- | --- | --- |
| Goal and work plan | [Historical master plan](master-goal-and-work-plan.md) | Original design and milestone guide. Current priorities above supersede its old delivery gates. |
| Architecture | [Architecture](architecture.md) | Pipeline and startup overview with its original revision boundary. |
| Data model | [Data model](data-model.md) | Store ownership, cuts, generations, source references, and authority. |
| Source catalog | [Source catalog](source-catalog.md) | Exact coordinates and ingestion/read boundaries; links the detailed engine and publication contracts. |
| Event capsules | [Event capsules](event-capsules.md) | Lossy alternatives versus exact decoded chunks; links existing encoding/reducer ADRs. |
| Search and recall | [Search and recall](search-and-recall.md) | Supported lexical discovery, staged expansion, exact recovery, and limits. |
| Episodes and state | [Episodes and state](episodes-and-state.md) | Implemented boundaries, conservative lifecycle, provenance, and category readiness. |
| Rollups | [Rollups](rollups.md) | Closed intervals, fanout, omitted detail, staged recall, and explicit bounded repair. |
| Context composer | [Context composer](context-composer.md) | Selective chronological context, source recovery, adaptive raw tail, and effective token limits. |
| Logical sessions | [Logical sessions](logical-sessions.md) and [operations](operations.md) | Shard/branch model, safe-idle automatic continuation, manual controls, and recovery routing. |
| Workers | [Workers](workers.md) | Kernel mutexes, queue metadata, fixed systemd slots, resource limits, and privacy. |
| Migration | [Migration](migration.md) | Adoption and store-owned progress; lag, incompatible schema, and corruption are separate cases. |
| Configuration | [Configuration](configuration.md) | Effective setting precedence, defaults, and session exclusions. |
| Operations | [Operations](operations.md) | Existing operator command and settled-session procedures. |
| Recovery | [Recovery](recovery.md) | Source-preserving store, logical-session, and package rollback procedures. |
| Privacy | [Privacy policy](privacy-policy.md) | Existing authority for private data and publication checks; no duplicate `privacy.md`. |
| Testing | [Testing](testing.md) | Existing check/campaign owners and limits on what each result proves. |
| Deployment | [Deployment](deployment.md) | Accepted, built, linked, loaded, usable, and rolled-back states. |
| Deployed change history | [Milestone ledger](milestone-ledger.md) and [review records](reviews/) | Existing revision-bound changes and receipts. This pass adds no duplicate changelog or deployment claim. |

The lower-level [catalog contract](catalog-contract.md) and [catalog publication contract](catalog-store-publication.md) remain authoritative for their protocols. Subject pages explain how to use those owners, not alternate schemas.

## Architecture decision map

This table covers the 14 topics in historical charter section 25. Records explain choices, alternatives, consequences, migration, and reversal. They do not grant acceptance or activation. Existing records retain their original milestone status language and must be read with the current priorities above.

| Charter topic | Decision record |
| --- | --- |
| ADR-001: logical sessions and bounded physical shards | [Logical sessions and bounded shards](adr/ADR-001-logical-sessions-and-bounded-shards.md) |
| ADR-002: transactional catalog and SQLite binding | [Worker-only SQLite catalog binding](adr/ADR-002-sqlite-catalog.md) |
| ADR-003: immutable segments and manifest publication | [Immutable segments and publication](adr/ADR-003-immutable-segments-and-manifest-publication.md) |
| ADR-004: kernel locks versus a worker broker | [Kernel locks and contained worker slots](adr/ADR-004-kernel-locks-and-contained-worker-slots.md) |
| ADR-005: capsule schema and reducer versioning | [Capsule schema and reducer versioning](adr/ADR-005-event-capsule-schema-and-reducer-versioning.md) |
| ADR-006: cue index and raw lexical locator | [Cue index and raw lexical locator](adr/ADR-006-cue-index-and-raw-lexical-locator.md) |
| ADR-007: episode-boundary rules | [Deterministic episode boundaries](adr/ADR-007-episode-boundary-rules.md) |
| ADR-008: current-state lifecycle | [Source-scoped current-state lifecycle](adr/ADR-008-current-state-lifecycle.md) |
| ADR-009: rollup fanout and propagation | [Rollup fanout and propagation](adr/ADR-009-rollup-fanout-and-propagation.md) |
| ADR-010: context budgets and validation | [Context budgets and validation](adr/ADR-010-context-budgets-and-validation.md) |
| ADR-011: rollover integration with Pi | [Rollover integration with Pi](adr/ADR-011-logical-session-rollover-integration-with-pi.md) |
| ADR-012: deployment, generated artifacts, and live SHA | [Deployment and live identity](adr/ADR-012-deployment-generated-artifacts-and-live-identity.md) |
| ADR-013: optional model advice privacy and authority | [Optional model advice boundary](adr/ADR-013-optional-model-advice-boundary.md) |
| ADR-014: schema migration and repair | [Schema migration and repair](adr/ADR-014-schema-migration-and-repair.md) |

The pre-existing [ADR-012 versioned rollup repair](adr/ADR-012-versioned-rollup-repair-publication.md) is a supplemental repair record, not the charter's deployment topic. Its filename is preserved. Use full links to distinguish the two subjects rather than renumbering historical references.

## Authority and evidence records

- [Decision and update protocol](decision-and-update-protocol.md) preserves the earlier status vocabulary and milestone process. [Decisions](decisions.md) and [amendments](amendments/) record scope history. None overrides later owner instructions.
- [Milestone ledger](milestone-ledger.md), [review records](reviews/), and the [independent-review compatibility index](independent-review.md) own milestone status. A documentation change is not acceptance.
- [Baseline](baseline.md), [machine-readable baseline](baseline-evidence.json), and [evidence classes](evidence.md) retain sanitized provenance.
- [Containment timeline](containment-timeline.md), [known incidents](known-incidents.md), and [baseline rollback](rollback.md) retain incident and rollback history.
- [Historical test inventory](historical-test-inventory.md), [test recovery](test-recovery.md), and [M11 qualification plan](reviews/M11-qualification-plan.md) retain earlier test and campaign plans. They are neither current release prerequisites nor evidence of a pass.

The repository is public under [A-0003](amendments/A-0003-m00-r1-corrections.md). Public visibility is not package publication, deployment, or permission to commit private runtime data. Follow the existing privacy policy for every outgoing change.
