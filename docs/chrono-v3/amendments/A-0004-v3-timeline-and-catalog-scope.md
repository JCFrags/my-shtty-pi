# A-0004 — V3 timeline and catalog scope

**Status:** approved by the directing assistant's M03 closeout → M04 brief, following completed external-proposal review and owner discussion
**Date:** 2026-09-07
**Applies to:** V3 scope and later acceptance boundaries; M04 implementation authority

## Core and invariants

V3's core is readable, progressively compressed chronological experience plus reliable search and recall. Importance changes retained detail, not source order. Current-state views support, rather than replace, the timeline. Preserve full first consumption of tool results, the regular Pi summary, tool-pair integrity, protected information, exact recovery, and the current combined-context ceiling.

The master charter remains byte-frozen. This amendment refines its existing milestones and quality gates; it does not replace the roadmap or authorize later layers early. Optional model failures must not disable core memory. No new model authority, provider calls, or protected-input access is authorized.

## Agreed proposal dispositions

| Proposal | Disposition and acceptance boundary |
| --- | --- |
| A | Accept source/derived provenance and scoped references. Defer a separate semantic-claim store. M04 records source identity and generated-record classification, not semantic claims. |
| B | M07 transitions must be evidence-scoped. Unrelated success, quoted completion, or success on another revision must not resolve a failure or grant approval. |
| C | Defer new semantic workers. Distinguish readiness of implemented ingestion, reduction, and search layers; do not add speculative semantic tables. |
| D | M05/M07/M08/M09 must preserve conditions, exceptions, negation, decisive outcomes, and unresolved status through targeted rules and fixtures. No universal meaning-analysis framework. |
| E | M09 has one bounded composer, chronological continuity, the retained Pi summary, post-render validation, and a minimal persisted envelope. |
| F | Defer cache-segment rendering beyond V3. |
| G | M06/M07 provide lexical and explicit-rationale discovery, scoped staged recall, chronological expansion, and exact recovery. Defer new proactive recall loops and embeddings. |

M09's existing bounded selection of relevant older memory remains in scope. It does not authorize a separate autonomous recall system. Add continuity cases to the existing later quality gates: order survives unequal importance, restrictions retain their conditions and exceptions, negation and unresolved outcomes survive reduction, and an unrelated or quoted success cannot establish resolution or approval. Use the existing M02 harness and later milestone fixtures, not a new benchmark program.

Summary replacement, broader knowledge management, and planning-tool integration are unscheduled post-V3 ideas, not release dependencies. Access to the external proposal is not a prerequisite; the approved brief supplies these decisions.

## M04 delivery boundary

M03 is accepted at `afec7d3ac48ef369b27c6609347666af2f8c289b`; F001/F002 are closed. Metadata-only closeout passed push CI `34166325148` attempt 2 and PR CI `34166327738`. The push retry was the known lifecycle readiness timeout, with no code change. PR #35 merged only into `rebuild/chrono-memory-v3` as `afb5f81b9eb6931cbf6f08d90413b3766829f192`.

M04 is authorized to implement the incremental source catalog: a tested SQLite/WAL binding, durable scoped source identity, bounded streaming append ingestion and exact access, pinned chronological views, integrity/restartable rebuild, and nonblocking shadow lifecycle scheduling. Giant-record metadata/hash extraction is M04; decoded chunk storage and capsule generation remain M05. Reuse M03 containment and fixed limits, without whole-file fallback or native-I/O accounting claims based on JavaScript wrappers.

Shadow ingestion stays **off by default** pending project-lead storage/privacy review. Disposable synthetic Pi canaries are authorized. Production remains 2.0.4 from `ad23f0b71ee473d33aff26d367459e76d208c631`; its alias, effective configuration, scheduler policy, and verified 2.0.3 rollback are unchanged. No private archive access, source rewriting, external services, publication, force-push, M05 implementation, or production catalog activation is authorized. M04 must return as an unmerged draft PR for project-lead code/storage review.
