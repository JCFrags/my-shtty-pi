# Chrono Memory Engine documentation

This directory separates the frozen goal, reusable subject documentation, architecture decisions, and revision-bound evidence.

## Current documentation boundary

This documentation map was completed while the delivery owner prepared candidate `2.0.30` from `2.0.29`. It describes implemented source behavior, not a shipped V3 release. `memoryEngineEnabled` remains false by default. The actual original large-session mandatory-content overflow is unresolved.

Runtime qualification, final defaults, remote integration, local activation, and exercised deployment rollback are separate evidence streams. This documentation supplies none of those results and claims no M11 or M12 acceptance. Partial logical-session progress is not a complete qualification pass.

The existing `architecture.md`, `operations.md`, `recovery.md`, and older ADRs retain revision-specific history. Read their recorded versions as historical evidence boundaries, not current candidate or deployment status. The subject pages below describe the implemented mechanisms without turning earlier pending work or partial results into present acceptance claims.

[A-0004](amendments/A-0004-v3-timeline-and-catalog-scope.md) defines the accepted timeline-first scope. Current state supports the timeline. Cut readiness and category coverage are not semantic certification. Rollover remains manual and guarded. No new provider, model authority, or provider-call permission is introduced.

## Subject map

Use this map for the charter's section 27 documentation subjects. Existing authoritative owners are linked rather than copied into filename aliases.

| Subject | Start here | Purpose |
| --- | --- | --- |
| Goal and work plan | [Master charter](master-goal-and-work-plan.md) | Byte-frozen governing plan. This is the owner of the proposed `goal-and-work-plan.md` subject; no duplicate is created. |
| Architecture | [Architecture](architecture.md) | Pipeline and startup overview with its original revision boundary. |
| Data model | [Data model](data-model.md) | Store ownership, cuts, generations, source references, and authority. |
| Source catalog | [Source catalog](source-catalog.md) | Exact coordinates and ingestion/read boundaries; links the detailed engine and publication contracts. |
| Event capsules | [Event capsules](event-capsules.md) | Lossy alternatives versus exact decoded chunks; links existing encoding/reducer ADRs. |
| Search and recall | [Search and recall](search-and-recall.md) | Supported lexical discovery, staged expansion, exact recovery, and limits. |
| Episodes and state | [Episodes and state](episodes-and-state.md) | Implemented boundaries, conservative lifecycle, provenance, and category readiness. |
| Rollups | [Rollups](rollups.md) | Closed intervals, fanout, omitted detail, staged recall, and explicit bounded repair. |
| Context composer | [Context composer](context-composer.md) | Prepared cuts, retained Pi summary, mandatory coverage, rendered limits, and refusal. |
| Logical sessions | [Logical sessions](logical-sessions.md) | Shard/branch model, manual continuation, Pi lifecycle, and recovery routing. |
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

This table covers all 14 topics in charter section 25. New records describe implemented choices, alternatives, consequences, migration, and reversal. They do not grant acceptance or activation. Existing records retain their original milestone status language.

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

- [Decision and update protocol](decision-and-update-protocol.md) defines authority, status vocabulary, and gates. [Decisions](decisions.md) and [amendments](amendments/) record changes to scope.
- [Milestone ledger](milestone-ledger.md), [review records](reviews/), and the [independent-review compatibility index](independent-review.md) own milestone status. A documentation change is not acceptance.
- [Baseline](baseline.md), [machine-readable baseline](baseline-evidence.json), and [evidence classes](evidence.md) retain sanitized provenance.
- [Containment timeline](containment-timeline.md), [known incidents](known-incidents.md), and [baseline rollback](rollback.md) retain incident and rollback history.
- [Historical test inventory](historical-test-inventory.md) and [test recovery](test-recovery.md) retain the restoration boundary. [M11 qualification plan](reviews/M11-qualification-plan.md) owns the existing large-scale campaign plan, not a pass.

The repository is public under [A-0003](amendments/A-0003-m00-r1-corrections.md). Public visibility is not package publication, deployment, or permission to commit private runtime data. Follow the existing privacy policy for every outgoing change.
