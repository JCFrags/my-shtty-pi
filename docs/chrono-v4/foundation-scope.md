# V4 foundation scope

## Mission

Improve what an LLM agent can do with a fixed context window as its lifetime history grows. Programmatic ingestion, selection, state recovery and compaction do the required work. Optional model workers may improve a bounded event or group, but cannot become a dependency for correctness or forward progress.

"Near infinite" is a design goal for incremental work and recoverable storage, not a measured capacity or a promise of unlimited hardware. Source archives grow. Per-operation work, active memory, model context and derived caches need explicit bounds.

## First implementation

The first slice adds a Context Kit with separately loadable Recall and Telemetry extensions. A small protocol library has no startup side effects or owned state. Native adapters in the existing Todo, Notes and Workplan providers expose bounded current-state records. The adapters are a migration boundary, not the completed greenfield replacements.

- Recall discovers useful current records by query and category, then gives the agent native recovery instructions.
- Each provider remains usable without Recall, Telemetry, Chrono or another provider. A missing provider gives an explicit partial result.
- Telemetry observes Pi lifecycle events independently. It never changes context or drives a model turn.
- Current-state references identify provider, native ID, revision and session view. They are not immutable historical handles. A later native read can return a newer revision. Historical exact recovery remains Chrono's responsibility.
- No replacement compactor is enabled in this slice. Existing V3 compaction stays selected while the V4 design and benefit checks develop.

The product group is `packages/pi-context-kit`. Its `protocol`, `recall` and `telemetry` subpackages are separate dependency or installation units. A library dependency does not require that another extension be loaded. The grouping root is not an all-in-one Pi registration.

## Connector requirements

Use versioned request and response messages on Pi's native event bus. Request identity, provider identity and an exact session/leaf view must match. Consumers validate and copy bounded plain data. They do not import provider state stores or invoke mutating tools. Late responses are ignored.

Each query needs finite query, category, record, scan, response-byte and wait limits. Whole-record output selection must include metadata and recovery instructions in the response budget. Report incomplete fields, excluded records and unavailable providers. Do not call a bounded result exhaustive when the provider did not scan all eligible state.

A provider publishes only persisted, healthy state for the selected view. Pending mutation, corrupt state and lifecycle changes produce explicit refusal. Providers must not read the source archive to answer a current-state query.

Recall may query only a provider whose native read tool is currently active. It must not enable hidden tools or bypass tool exclusions or Progressive Tools policy. If needed, the agent can use the ordinary tool-help route before another query.

Use explicit categories and source-backed typed relations. A common category means related material, not proof that two claims agree. Do not deduplicate repeated statements across time by text hash or promote scratchpad text into authoritative memory.

The first native transport provides cooperative failure isolation: exceptions, malformed replies, missing providers and asynchronous timeouts do not invalidate healthy provider results. Pi extensions share a JavaScript process. This transport cannot contain an infinite synchronous loop or an operating-system process crash. Heavy indexing and optional enrichment need bounded workers outside the interactive process.

## Telemetry requirements

Keep two independent evidence channels:

1. Runtime: bounded counts, duration, token usage, process memory, tool success/failure and paired compaction outcomes.
2. Quality: explicit source-known retrieval cases and agent task outcomes, including missing evidence, stale conclusions and unsupported claims.

Runtime observations are not accuracy scores. A lower token count or faster query does not alone establish agent benefit. Absence of quality observations means unknown, not success.

Telemetry is local and content-free by default. Do not collect prompt or result bodies, arguments, headers, environment values, credentials, raw session IDs, file paths or raw exception text. Use a bounded allowlist of numbers and codes, pseudonymous run identity and capped storage. Writes are best-effort and cannot block or fail the agent's tool. No network exporter or external collection service is included.

## Delivery and next steps

The architecture must describe new independent Memory, Todo, Notes and Workplan implementations, migration without overwriting legacy state, deterministic context packets and replacement compaction. Implement them in useful stages rather than create empty wrappers for all four at once.

Use a small source-known Pi scenario for this slice. Exercise providers alone, together and with a missing or failed peer. Compare actual agent use of supplied records with a baseline. Report both a benefit and a failure if observed. Larger model campaigns need a separate bounded proposal.

Keep the V3 readiness repair independent of V4 work. Do not change live process ownership or source stores to make a readiness check pass. Integrate intended changes through protected main, then verify selected and loaded behavior separately. Update the root README after implementation and evidence are settled.
