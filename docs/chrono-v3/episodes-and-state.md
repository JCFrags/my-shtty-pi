# Episodes, resource observations, and state

The indexed state layer supports chronological memory. It does not replace the timeline or act as a general truth engine. See [A-0004](amendments/A-0004-v3-timeline-and-catalog-scope.md) and the [candidate boundary](README.md#current-documentation-boundary).

## Episode construction

The current materializer uses `state-v4.sqlite` within the search generation. Only `materializeState` creates it. Status, recall, composition selection, and rollup input are existing-store reads.

The implemented source-local episode boundary is the first body/block of an original user request. It closes the previous open episode and starts a new one. Later members retain event/descriptor order and source references. Closure records the next episode boundary, not successful task completion. The reducer also classifies compaction-continuation metadata, but this is not a general time-gap, resource-change, or model-selected boundary engine.

## Bounded clause continuation

`materializeState` retains at most 32 recognized states per job and transaction. This is a batch size, not an envelope limit. Whole bodies and large-body decoded windows use the same continuation. The existing 32,768-unit window, overlap, source-read, native-memory, and response limits remain unchanged.

A pending batch uses the existing `large_bodies` table in `state-v4.sqlite`. Its `state-clause-batch-v1` payload binds the exact envelope, source view, decoded window, window hash, and ordered stable-key prefix. The next job rereads that bounded window and validates the prefix before continuing. Only a drained window advances decoded progress. Only a drained envelope publishes its body cut and coverage. State rows, checkpoint, generation, and body head commit together. Metadata stays behind the pending envelope. `materializeState` and `stateStatus` expose scalar `bodyCheckpoint` progress, not a caller-controlled completion flag.

Batches follow source order. New span keys use source-relative decoded offsets, so repeated text at different positions stays distinct and overlapping windows can reuse the same exact span. Whole-body and first-window identities retain the existing hash inputs. Checkpoint serialization preserves the source-object order used by those hash inputs across restart. Existing state rows, old pins, and supersession records are not rewritten.

A valid legacy checkpoint resumes from its stored decoded frontier without a clause cursor. Its prior gap flags remain set. An already processed legacy prefix also remains qualified because old window-relative keys may have collapsed distinct spans, even without a recorded gap. Continuation does not reread that prefix or recover clauses already dropped before its frontier. Old later-window rows can have window-relative span keys. Those rows remain unchanged and may coexist with a newly extracted source-relative key for the same evidence. Continuation does not infer a replacement identity, merge lifecycle records, or repair that legacy duplication.

Older materializers cannot resume a new checkpoint. The versioned payload is not a bare reducer envelope, so an older writer refuses before it can advance or erase the checkpoint. Preserve the pending store and resume it with a compatible writer. Do not remove the checkpoint to make a rollback proceed. Read-only historical pins remain separate from writer compatibility. See [migration](migration.md).

## Explicit historical state-gap repair

Ordinary continuation refuses to revisit a published source marker. The explicit `repairState` worker operation instead binds one original-user body descriptor to a completed current view. It does not accept a text query or perform a lifetime scan.

1. Call `status` with the normal catalog/capsule/search identity and routes, exact `view`, scoped `source`, and a `repairId`. For an unstaged descriptor, the result supplies `expectedGeneration` and `priorCoverage: { generation, hash }`. The hash covers the canonical original coverage row. The source carries its exact body hash.
2. Call `start` with those same fields and returned bindings. The view's cut is the explicit later effective cut and must follow the source event. Body and metadata heads must be complete at exactly that view. Start preserves the old coverage and cut, adds repair/accounting tables in `state-v4.sqlite`, and reserves the next generation without publishing it.
3. Repeat `step` with the identical binding. Each job first pages at most 32 legacy state rows through the existing kind/source index, or reads one existing bounded decoded window and handles at most 32 recognized clauses. The persisted window hash, prefix cursor, and source view support restart. Normal state writers remain blocked while this one repair is pending.
4. Call `publish` only when the stage is `ready`. Publication requires every legacy row to have an exact recovered counterpart and every decoded window and clause batch to be complete and unqualified. It adds a later cut marker and publishes the repair receipt in one transaction. The original coverage row and cut remain unchanged. Exact repeat publication returns the same generation.

Legacy matching uses the exact source, decoded span, text, normalized proposition, and ordinary state labels, not a legacy span key alone. Matching rows keep their original identity and lifecycle evidence, including supersession. Missing rows are staged at the reserved future generation and remain invisible until publication. Ambiguous duplicate evidence, incompatible labels, new lifecycle transitions, or potentially applicable later transitions refuse. Repair does not invent a task resolution or broaden an exact supersession target.

Only a published receipt visible at both the requested generation and later effective cut can discharge its exact prior coverage row. Old coverage and state remain readable under their original cuts and generations. Existing historical rollup handles retain their original ruleset, generation, cut, and immutable store. Other gaps, non-target rows, resources, chronology, and the maintained body/metadata head positions remain unchanged. Aggregate head partial counts stay conservative.

Repair opts the store into `episode-state-exact-v4-gap-repair-v1`. The repair-aware reader still accepts ordinary v4 stores and valid historical pins. Older binaries that require the exact `episode-state-exact-v4` storage marker, including 2.0.32, refuse both reads and writes on an opted-in store. This refusal is a compatibility boundary, not rollback qualification. There is no automatic stage discard or downgrade. Preserve a pending stage and use a compatible writer. See [migration](migration.md).

A repaired descriptor is not global coverage. Recheck all remaining gaps and mandatory selection. Repair does not increase scan, representation, response, source, native-memory, or combined-context limits.

## State and authority

State items retain an exact evidence span, proposition identity, source-span identity, category, revision when known, authority, confidence, and effective cut. Categories distinguish restrictions, goals, open work, blockers, decisions, approvals, implementation reports, verification/deployment information, and advisory metadata.

The current lifecycle is deliberately narrower than the charter's proposed general state machine:

- New supported items are `current` or `unresolved`.
- Explicit supported restriction revocation/replacement can supersede the matching proposition under the same authority. The old item and transition evidence remain available at older pins.
- Tool failure or cancellation can create a blocker. Execution without a reported error is not task verification and does not automatically resolve another failure.
- Assistant implementation or deployment text remains an assistant report. Quoted or generated content cannot grant approval.
- Memory events and retention hints retain advisory provenance. A valid memory hash chain does not make its writer a user or project authority.

Resource recall presents observations and declared revisions. A later mention or a complete tool-result body is not proof of the current resource bytes. Unknown current revisions remain unknown. The candidate does not provide universal task-resolution or resource-version inference.

## Explicit user supersession

The bounded `supersedeState` worker operation can retire an inspected list of prior user repository or Chrono restrictions and approval holds. It is not a text query or automatic inference. Each of 1–12 targets must identify its exact stable key, proposition, span, generation, stored evidence hash, user authority, scope, and category.

The operation verifies an original user message through its catalog descriptor, decoded span, and exact raw-event hash. Quotes, retrieval output, and ordinary memory cannot provide this authority. The operator must confirm the instruction's meaning and each target's scope. Goals, future directions, unrelated duties, and higher-priority safeguards are not targets.

Application requires the current exact view with complete body and metadata progress and a matching state generation. All targets must precede the authorizing event. One transaction records the exact decision and supersession generation only after every target validates. Exact replay is idempotent. Stale, conflicting, missing, foreign, or oversized requests refuse without partial changes.

Sources, state rows, coverage records, old cut markers, and published rollup handles remain intact. Earlier cuts and generations retain their prior state. Supersession is effective at the application cut, not retroactively at an older authorization or compaction cut. It does not mark a task complete or certify mandatory coverage. Recheck ordinary composition selection after application.

## Readiness and mandatory selection

Body progress, metadata progress, and `knownThroughCut` are separate. A ready store can still fail selection for a later or more demanding cut. Mandatory selection has bounded category scans and output limits. Restrictions and open work have distinct completeness and omission flags.

The small committed delta keeps its 64-event sequence-range limit. It reads catalog metadata in at most four pages of 16 events, advances by actual sequence numbers within the pinned branch view, and requires the exact requested cut. Missing metadata progress cannot certify the delta. Memory events or retention hints on any page require maintained metadata materialization before the delta can be verified. A pending clause batch also returns an unverified empty delta until the maintained materializer drains it.

One exact context representation can cover multiple propositions only when the representation and each proposition are validated. Count propositions, not packed rows. Cut/category readiness means that the implemented extraction and selection completed within those bounds. It is not semantic certification that every obligation was recognized.

The original large-session mandatory overflow remains unresolved. Do not infer usable composition from state readiness alone. See [context composition](context-composer.md).

## Owners

[ADR-007](adr/ADR-007-episode-boundary-rules.md) owns boundary decisions. [ADR-008](adr/ADR-008-current-state-lifecycle.md) owns lifecycle and authority decisions. The binding [contract](../../packages/pi-chrono-compaction/src/episode-state-contract.ts), [reducer](../../packages/pi-chrono-compaction/src/episode-state-reducer.ts), and [store](../../packages/pi-chrono-compaction/src/episode-state-store.ts) define the implemented rules and bounded reads.
