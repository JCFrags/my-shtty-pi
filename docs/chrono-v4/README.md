# Chrono V4: an independent agent memory ecosystem

## Mission and current position

V4 should make an LLM agent more effective inside Pi as its lifetime history grows, while the active context stays small. Code must perform the required ingestion, selection, recovery and compaction. A language model may improve a bounded event or group, but it must not drive whole-history processing or become necessary for continued operation.

The implementation now includes independently owned Memory, Todo, Notes, and Workplan, the shared V2 collector, complete asynchronous state transfer, Recall, and Telemetry. Chrono 4.0.0 adds an explicit `contextCompiler: "v4"` path through its existing public compaction hook. The default remains `v3` until selected. Implementation, installed use, remote integration, and local activation are separate claims. See [implementation evidence](completion-evidence.md), [completion scope](completion-scope.md), [foundation scope](foundation-scope.md), [research findings](research.md), and the earlier [foundation evidence](foundation-evidence.md).

The new state providers own their persistence and lifecycle. They reuse sufficient pure native reducers and projectors rather than wrap the old extension factories. The original Grounded providers remain available for compatible fresh-checkpoint rollback. A historical relation index beyond existing source-linked state remains future work. No lifetime-scale or general agent-benefit result follows from these implementations.

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

[Context Kit](../../packages/pi-context-kit/README.md) groups six separately loadable extensions under `packages/pi-context-kit`. The `protocol` and `state-store` libraries register no Pi extensions. Shared code does not create a shared mutable store. Legacy Grounded providers retain their interfaces, but each native tool must have exactly one selected writer.

## Native connectors

Connectors use versioned native messages with request correlation, provider identity, exact session view, revision, coverage, and bounded records. Consumers request fresh pages after persistence rather than treat a notification as a replacement snapshot. A captured page is not a transaction across providers.

A useful record keeps these fields distinct:

- Native identity and revision.
- Source role and derivation, where available.
- Lifecycle status such as active, paused, completed, archived or superseded.
- Explicit category or source-backed relationship.
- A precise relevant excerpt, any omitted fields and a route to fuller evidence.
- The view for which the result was validated.

A category does not establish agreement, truth or authority. Preserve directed relations and multiple predicates. Start with native task dependencies and explicit milestone-to-task links. Later add supported action/result and correction relations to the active indexed history path. Do not construct a second all-history graph or collapse repeated events by text hash.

Protocol V2 supports Memory, Todo, Notes, and Workplan with eight categories. Proposals are explicit opt-in and remain separate from accepted knowledge. The library retains the three-provider V1 listener for older clients. Dynamic provider discovery remains future work. Unsupported versions are reported, not silently interpreted.

Queries cannot bypass native tool exclusions. Recall only asks providers whose native read tools are active. It does not enable tools or invoke recovery commands. Memory cards have exact revision-bound recovery. Other native reads can return a newer current record. Chrono's verified historical handles serve original conversation source, not current tool state.

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

The V4 path uses this sequence:

1. Freeze an exact source cut, current provider revisions, selected model capacity and output reserve.
2. Read bounded source/index pages and current native records. Missing optional providers remain explicitly unavailable.
3. Produce a selection plan that names retained records, recovery references, omissions, source coverage and resource charges.
4. Render whole records in chronological order where time matters. Keep the current goal and unresolved work distinguishable from historical instructions. Give important events more detail and retain a small adaptive raw tail.
5. Estimate the whole result, including source references, notices, system/tool overhead, and output reserve. Label the estimator rather than claim exact model token counts. Preserve tool-call/result pairing. Do not add uncounted headers after fitting.
6. Return the custom compaction through the public hook. Persist the selection receipt with the compaction entry. Keep immutable source and compatible fallback data.
7. Correlate the attempt with `session_compact` or `session_compact_failed`, then observe whether the agent actually resumes useful work.

The public preparation helper and preview use the same pure compiler as the active hook. Compare preview and active output with the same source route, frozen native state, model metadata, and real Pi preparation. For a persisted receipt comparison, first serialize the preview to JSON so optional `undefined` object fields are omitted as Pi omits them. Exclude only the diagnostic `native.requestId` from deterministic receipt equality. A loaded-prefix fallback and an indexed selection are different inputs, not a deterministic mismatch. Select the V4 compiler only after exercising its actual Pi path. Refusal must preserve context, state and cancellation intent. Do not add an automatic retry loop around an unchanged failure. Overflow needs an explicit safe outcome, not repeated attempts to publish a still-oversized context.

For the first raw receipt read, pass its `entryId` without `startByte`. Later pages use the returned absolute `nextByte`. Raw recovery needs a validated catalog view, not a completed derived search index. `history_status` describes one cached observation. A completed agent turn can select a newer leaf and invalidate that view before the next call. Keep a bounded readiness check and its recovery call within the same agent run when verifying this path. Do not weaken branch validation or add an unbounded retry.

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
| Independent Memory | Source-linked knowledge, separate proposals, temporal reads, owned persistence, and explicit legacy import. | Implemented with finite admission and separate logical visibility. |
| First-class state tools | Owned Notes, Todo, and Workplan with branch-local state and explicit migration. | Implemented. Native reducers, interfaces, and complete transfer remain compatible. |
| Context compiler | Frozen selection receipts, whole-record fitting, and exact omission recovery. | Implemented. Charges are estimates, not exact tokenizer measurements. |
| Replacement compaction | Existing public-hook path with explicit V4 selection. | Implemented opt-in. No required summary model. Selection and loaded-use evidence remain separate. |
| Long-run operation | Incremental rollover, fault recovery and bounded worker scheduling under actual use. | Continue V3 work and extend only where needed. |

Change the plan when evidence requires it:

- If a new connector duplicates a sufficient existing contract, reuse or extend that contract.
- If a category or graph expansion increases stale or irrelevant context, disable it and retain lexical exact-source recall.
- If fewer tokens worsen task outcomes, preserve more useful evidence instead of optimizing the token count.
- If a component needs all other components to work, remove that dependency before expanding it.
- If optional model work becomes necessary for correctness or progress, restore the programmatic path first.
- If a scale claim depends on whole-history materialization, replace that operation with bounded incremental work or state the unsupported limit.

Each stage should deliver useful behavior and retain rollback. This roadmap is a guide for iteration, not a fixed sequence that prevents a smaller, evidence-supported correction.
