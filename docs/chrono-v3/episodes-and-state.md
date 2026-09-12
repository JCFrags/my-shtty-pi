# Episodes, resource observations, and state

The indexed state layer supports chronological memory. It does not replace the timeline or act as a general truth engine. See [A-0004](amendments/A-0004-v3-timeline-and-catalog-scope.md) and the [candidate boundary](README.md#current-documentation-boundary).

## Episode construction

The current materializer uses `state-v4.sqlite` within the search generation. Only `materializeState` creates it. Status, recall, composition selection, and rollup input are existing-store reads.

The implemented source-local episode boundary is the first body/block of an original user request. It closes the previous open episode and starts a new one. Later members retain event/descriptor order and source references. Closure records the next episode boundary, not successful task completion. The reducer also classifies compaction-continuation metadata, but this is not a general time-gap, resource-change, or model-selected boundary engine.

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

One exact context representation can cover multiple propositions only when the representation and each proposition are validated. Count propositions, not packed rows. Cut/category readiness means that the implemented extraction and selection completed within those bounds. It is not semantic certification that every obligation was recognized.

The original large-session mandatory overflow remains unresolved. Do not infer usable composition from state readiness alone. See [context composition](context-composer.md).

## Owners

[ADR-007](adr/ADR-007-episode-boundary-rules.md) owns boundary decisions. [ADR-008](adr/ADR-008-current-state-lifecycle.md) owns lifecycle and authority decisions. The binding [contract](../../packages/pi-chrono-compaction/src/episode-state-contract.ts), [reducer](../../packages/pi-chrono-compaction/src/episode-state-reducer.ts), and [store](../../packages/pi-chrono-compaction/src/episode-state-store.ts) define the implemented rules and bounded reads.
