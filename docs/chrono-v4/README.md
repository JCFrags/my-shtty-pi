# Chrono V4: an independent agent memory ecosystem

## Mission and current position

V4 should make an LLM agent more effective inside Pi as its lifetime history grows, while the active context stays small. Code must perform the required ingestion, selection, recovery and compaction. A language model may improve a bounded event or group, but it must not drive whole-history processing or become necessary for continued operation.

This is an evolving design and initial implementation, not a completed V4 release. Chrono 3.0.2 remains the compaction baseline. The first slice is a separately loadable Recall extension, an independent Telemetry extension, and native read-only adapters for the existing Todo, Notes and Workplan. See [foundation scope](foundation-scope.md), [research findings](research.md), and [practical evidence](foundation-evidence.md).

The new native adapters are a migration boundary. They are not renamed wrappers presented as completed greenfield replacements. New Memory, Todo, Notes and Workplan implementations, a historical relation index and the replacement compactor remain planned work.

## What success means

The important result is correct agent action with useful evidence, not a small prompt by itself. Measure whether the agent can recover a forgotten fact, distinguish an old decision from its correction, resume the current task and avoid unsupported conclusions. Compare these results with the existing system at the same source cut and comparable context budget.

Long lifetime histories require incremental work, not a promise of infinite capacity. Immutable archives can grow on disk. Active memory, query work, worker concurrency, response size, derived caches and optional model cost must have separate finite limits. Report measured scale and coverage instead of inferring them from architecture.

## Independent components

| Component | Owns | Does not own |
| --- | --- | --- |
| Chronicle history | Source routes, immutable event identity, bounded indexes and exact historical recovery. | Tool state or user intent inferred from prose. |
| Memory | Source-linked ordinary knowledge, revisions, explicit corrections, archive state and validity. | Scratchpad notes, active tasks or instruction authority. |
| Notes | Explicit scratchpad records, categories and native revisions. | Automatically accepted durable knowledge. |
| Todo | Immediate actions, dependencies, blocking and completion state. | Project acceptance or silent changes to Workplan. |
| Workplan | Goals, scope, decisions, milestones, evidence and recovery checkpoints. | Automatically synchronized Todo state. |
| Recall | Bounded queries across available providers and useful source references. | Provider persistence or mutation. |
| Context engine | A deterministic selection plan and its bounded rendering for Pi. | Canonical facts or original history. |
| Runtime telemetry | Content-free operational observations from participating Pi processes. | Accuracy or success judgments inferred from usage. |
| Quality evaluation | Explicit retrieval cases and observed agent task outcomes. | Production control or automatic promotion of self-reported success. |

Each state provider must start, read, write and recover without the others. It owns a separate store and lifecycle. A common pure library may define schemas and validation, but there is no required shared database, daemon or mutable singleton. Consumers can discard and rebuild their derived views without changing provider state.

The first Context Kit groups separately installable subpackages under `packages/pi-context-kit`. The `protocol` library has no Pi startup behavior. `recall` and `telemetry` have independent Pi entrypoints. Existing Grounded providers keep their current persistence and standalone interfaces.

## Native connectors

Connectors use versioned native messages with request correlation, provider identity, exact session view, revision, coverage and bounded records. A change event invalidates a consumer's view. It is not an authoritative replacement snapshot. Consumers request a fresh view after persistence.

A useful record keeps these fields distinct:

- Native identity and revision.
- Source role and derivation, where available.
- Lifecycle status such as active, paused, completed, archived or superseded.
- Explicit category or source-backed relationship.
- A precise relevant excerpt, any omitted fields and a route to fuller evidence.
- The view for which the result was validated.

A category does not establish agreement, truth or authority. Preserve directed relations and multiple predicates. Start with native task dependencies and explicit milestone-to-task links. Later add supported action/result and correction relations to the active indexed history path. Do not construct a second all-history graph or collapse repeated events by text hash.

The first protocol supports only Todo, Notes and Workplan with a small fixed category vocabulary. Later versions can add provider descriptors and categories without forcing existing providers to adopt another component. Unsupported versions must be reported, not silently interpreted.

Queries cannot bypass native tool exclusions. The first Recall extension only asks providers whose native read tools are active. It does not enable tools or invoke recovery commands. A native read can return a newer revision than an earlier card. These current-state references are not immutable historical handles. Chrono's verified handles remain necessary for exact old content.

## Failure isolation

Missing, pending, corrupt, slow or malformed providers must not erase healthy results. Show unavailable components and incomplete coverage. Never silently replace unavailable canonical state with an LLM guess. A query failure must not invalidate the provider's own store.

Native event handlers run in Pi's JavaScript process. Validation and deadlines contain cooperative errors and asynchronous delays, not an infinite synchronous loop or a process crash. Keep handlers small. Run heavy indexing and optional enrichment in separately bounded workers. Worker ownership, generation and cancellation must remain valid across process suspension and restart.

Avoid a global worker reservation that makes every independent provider wait behind one unavailable component. Host resource limits still matter, but per-component admission and explicit unavailable status must prevent circular waits. Do not reclaim a valid live owner's resources without a fencing protocol that prevents that owner from later executing stale work.

Physical session rollover has a different safety requirement from recall. Optional enrichment can be omitted. Complete native state needed for the new session cannot be shortened to fit. Preserve existing checkpoint-aware rollover and refusal behavior until each new provider has a verified transfer contract.

## Greenfield state providers and migration

The replacement providers should share contracts, not storage or one large implementation:

1. Define each provider's operations, state machine, revision rules and standalone recovery.
2. Use bounded transactions and provider-owned checkpoints. Keep per-operation work independent of total lifetime history.
3. Add explicit categories and source references at the owner. Cross-provider references never cause automatic writes to the target.
4. Import legacy state into a separate new store. Retain original IDs, source identity, revision history and an import receipt.
5. Compare reads before changing selection. Switch one provider at a time without dual writers.
6. Keep the old store and a verified return path. Do not delete or rewrite legacy session entries.

Memory needs separate event time and recording/revision time. Preserve what was known then and what is known now. Unknown validity is not perpetual validity. Optional extraction proposals remain separate from accepted knowledge. A confidence score cannot replace provenance or an explicit state transition.

Notes remain scratchpad state even when a category matches Memory. Todo completion does not complete a Workplan milestone. A Workplan recovery checkpoint describes project state, not fresh user authorization. A future promotion operation must be explicit, source-linked and owned by the receiving provider.

## Replacing regular Pi compaction

Use Pi's public `session_before_compact` contract rather than patch private AgentSession methods. Pi already supports between-turn compaction and bounded overflow recovery. A deterministic replacement does not require a new harness fork or another mandatory summary model.

The proposed sequence is:

1. Freeze an exact source cut, current provider revisions, selected model capacity and output reserve.
2. Read bounded source/index pages and current native records. Missing optional providers remain explicitly unavailable.
3. Produce a selection plan that names retained records, recovery references, omissions, source coverage and resource charges.
4. Render whole records in chronological order where time matters. Keep the current goal and unresolved work distinguishable from historical instructions. Give important events more detail and retain a small adaptive raw tail.
5. Count the whole result, including source references, notices, system/tool overhead and output reserve. Preserve tool-call/result pairing. Do not add uncounted headers after fitting.
6. Return the custom compaction through the public hook. Persist the selection receipt with the compaction entry. Keep immutable source and compatible fallback data.
7. Correlate the attempt with `session_compact` or `session_compact_failed`, then observe whether the agent actually resumes useful work.

Start with preview-only selection. Compare candidate context against V3 using a frozen input and source-known questions. Enable replacement only after the selected path is useful in actual Pi runs. Refusal must preserve context, state and cancellation intent. Do not add an automatic retry loop around an unchanged failure. Overflow needs an explicit safe outcome, not repeated attempts to publish a still-oversized context.

Optional model workers receive one admitted event or bounded group with fixed input, output, concurrency and cost limits. Code attaches and validates provenance. Late or failed results cannot alter the frozen plan or claim unprocessed coverage. Compare assistance off and on only after the programmatic baseline works.

## Evidence and telemetry

Keep runtime and quality observations separate. Runtime telemetry can measure tool failures, compaction outcomes, token usage, latency and process memory. It cannot infer that a smaller context helped the agent.

Quality evaluation needs a source-known case and a task result. Track correct recovery, missed evidence, stale conclusions, unsupported claims and additional tool use. Keep unknowns and failures in the denominator. Separate caller-declared or model-self-reported feedback from independently checked outcomes. No observations means unknown.

Telemetry stays local and content-free by default. Use pseudonymous run identity and explicit size limits. Do not collect arguments, raw prompt/result bodies, paths, credentials, headers or raw exception strings. Write failure or full storage disables collection rather than agent work. No network exporter is part of this design.

The first practical comparison is small and synthetic. It must disclose the model, candidate, source fixture, available tools, budget, scoring rule and observed outcome. It cannot establish general benefit across all tasks or lifetime-scale qualification. Larger experiments require a separate bounded plan.

## Stages and change-course rules

| Stage | Deliverable | Current state |
| --- | --- | --- |
| Foundation | Native read-only provider records, Recall, independent Telemetry and a practical scenario. | Implemented. The small installed-Pi scenario and two-call evidence comparison passed. Live activation is a separate check. |
| Independent Memory | Revisable source-linked knowledge with standalone storage and legacy import. | Planned. |
| First-class state tools | New Notes, Todo and Workplan, migrated individually through the connector boundary. | Planned. |
| Context compiler | Frozen deterministic selection plans, model-aware fitting and exact omission recovery. | Planned. Reuse V3 mechanisms. |
| Replacement compaction | Public-hook activation after source-known and real-agent comparisons. | Planned. Not enabled. |
| Long-run operation | Incremental rollover, fault recovery and bounded worker scheduling under actual use. | Continue V3 work and extend only where needed. |

Change the plan when evidence requires it:

- If a new connector duplicates a sufficient existing contract, reuse or extend that contract.
- If a category or graph expansion increases stale or irrelevant context, disable it and retain lexical exact-source recall.
- If fewer tokens worsen task outcomes, preserve more useful evidence instead of optimizing the token count.
- If a component needs all other components to work, remove that dependency before expanding it.
- If optional model work becomes necessary for correctness or progress, restore the programmatic path first.
- If a scale claim depends on whole-history materialization, replace that operation with bounded incremental work or state the unsupported limit.

Each stage should deliver useful behavior and retain rollback. This roadmap is a guide for iteration, not a fixed sequence that prevents a smaller, evidence-supported correction.
