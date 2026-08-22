# Architecture — ChronoCompact V2

## Scope

This package implements a retrospective context renderer over Pi's immutable event history. The extension changes only the historical prefix supplied during compaction. It does not intercept live user messages, assistant content, tool calls, or tool results.

The canonical input is a parent-linked Pi JSONL branch. The canonical output is an ordered model-facing replay whose units can have different representation levels.

## Core data flow

```text
immutable session JSONL
  └─ jsonl.ts + blocks.ts: validate and parse one parent-linked branch
       ├─ resource-lineage.ts: versions, read unions, deltas, and current state
       ├─ causal-memory.ts: episodes, outcomes, failures, corrections, certificates
       ├─ search-index.ts: one generation-bound local BM25 and exact index
       └─ candidates.ts + reducers/*: deterministic representation ladder
            └─ retention-gradient.ts: hot, warm, and cold eligibility
                 └─ validate.ts: reject unsafe or unbound representations
                      └─ repeated-observations.ts: exact repeats and proven deltas
                           └─ episodes.ts: old task and activity grouping
                                └─ planner.ts: useful information per token
                                     └─ plain-renderer.ts + render.ts: pinned state and chronological replay
```

`compactor.ts` builds every generation from original branch entries. It never uses a prior replay as evidence. The optional history classifier remains default-off and can select only prebuilt local candidates.

`compactor.ts` coordinates the pipeline and always starts from supplied raw entries. It does not accept a previous rendered replay as source. It can inspect the retained future raw tail for cross-event importance and activity-phase analysis, but it renders only the selected historical prefix.

## Canonical and secondary state

### Canonical

- Pi session header and JSONL records
- entry IDs and parent relationships
- original messages and content blocks
- tool-call arguments and tool results
- chronological parent-chain order

### Secondary and rebuildable

- typed blocks
- candidate representations
- task-boundary groupings
- token estimates
- generation hashes
- reducer metadata
- cached replay and plan details
- advisory retention hints

The cache sidecar is never read as authoritative event history. A cache entry is reusable only when both the raw-source generation hash and configuration hash match. The generation hash excludes unrelated runtime metadata entries that do not affect the replay, retained-tail analysis, or regular summary.

## V2 long-run hierarchy

`retention-gradient.ts` assigns approximately the newest 10,000 source tokens to the hot band and the preceding 75,000 to the warm band. Older history is cold. Protected and unresolved blocks override age. Hot history permits lossless cleanup and known structured waste removal. Warm history uses normal reducers. Cold routine history can become a one-to-two-line cue with an exact source reference.

`resource-lineage.ts` gives full version behavior to file and evidence paths. A declared revision is authoritative. Normal Pi reads infer one version while overlapping line hashes agree; a conflict or write starts a new observed version. The index keeps ranges, rolling chunks, symbol fingerprints, relation labels, current state, supersession, and volatility. A later covering read can replace an old overlapping snapshot with a source-linked marker. Failures and protected evidence do not use that shortcut. Structured URLs, commands, test or service command patterns, settings, packages, and process or agent tool observations have narrower identities. Moves, renames, net edit squashing, reverse deltas, settings or package lifecycles, independent symbol retention, and cached symbol summaries are not implemented.

`causal-memory.ts` derives task episodes, causal edges, correction-aware state cells, command outcomes, failure families, negative knowledge, observations, and completion certificates. Its bounded current-state register appears before the chronological replay. This register is derived memory, not system authority.

`memory-store.ts` keeps ordinary editable working knowledge as an owner-only serialized append-only hash chain. An exclusive lock covers read, event creation, synced temporary write, atomic rename, and directory sync. The lock is published only after its complete owner record is synced. Ownership binds a random nonce, inode, PID, and Linux process-start identity. Age never proves owner death. A live owner retains the lock. Malformed or unverifiable ownership fails closed. A verifiably dead main lock or recovery guard can be reclaimed with the same race-safe checks. Release removes only the same nonce and inode. Concurrent successful calls therefore preserve every accepted event. Hard-link publication briefly gives the candidate inode two names. A concurrent contender can reject that transient state and require caller retry; it does not report that rejected append as accepted.

Ordinary tools cannot create protected memory from a source label and cannot update, touch, promote, demote, forget, or supersede protected memory. Protected creation accepts only a configured `project:` or `skill:` identity from an owner-only manifest. It independently opens the configured regular file without following symlinks, verifies stable path identity and complete SHA-256, and uses the loaded bytes. Caller text, hash, path, or authority cannot mint protected state. Other authoritative source types are not implemented and fail closed. Corruption refuses writes and causes compaction to omit the derived memory rather than trust it.

`search-index.ts` and `recall.ts` provide dependency-free BM25, exact, regular-expression, and fuzzy path retrieval over the selected active branch. The requested budget is part of each result and bounds the complete model-facing search or recall text. Priority-aware rendering reserves complete cursor and exact-recovery fields before optional headers, generation data, metadata, bodies, and instructions. Oversized items become bounded recovery cues. If a complete search recovery command cannot fit, the renderer instructs the same query and applicable filters with `tokenBudget=2000` and no cursor. This starts a valid first page under the larger budget. Recall keeps its existing complete larger-budget retry. Ordinary search cursors remain bound to all original options, including the budget, and stale-cursor rejection is unchanged. It never emits a partial cursor, source identity, or retrieval command. Every implemented recall level returns at least one useful cue for a matching hit at the 120-token minimum when one can fit. Reported token use measures final rendered text. Cache state remains in result details and does not alter repeated model-facing text. Results are generation-bound, current-version aware, and diverse. Connected filters cover block kind, tool, error, unresolved, protected, time, resource kind, resource key, and current or superseded file state. Recall expands from cue to episode, resource, or source block. It has no separate task object. Cross-branch search, abandoned-branch summarization, branch/task/episode filters, and separate failed/unresolved/protected hit-state labels are not implemented. Extension search and recall record misses, repeated queries, block use, and resource use. Recall also appends an eight-turn promotion or touch for matched ordinary memory. Exact recovery still reads immutable JSONL.

`summary-rebase.ts` decides when the periodic or recursive-summary threshold fires. On that generation, `pi-extension.ts` calls the deterministic builder on normalized original history and does not call the regular provider-summary path. Chronological replay always rebuilds from original source on every generation.

The ranked search index is in-memory and rebuilds from parsed JSONL. It has no persisted ranked-index schema. Memory and cache integrity checks fail closed on an unsupported schema. Automatic schema migration is not implemented. The 220-generation simulation rebuilds the in-memory search index but does not simulate a schema migration.

## Segmented candidate preprocessing

`candidate-segment-store.ts` provides the default-off deterministic preprocessing path. It uses the source ledger to process only appended entries plus bounded verified tool-pair context. It publishes an owner-only manifest over immutable content-hashed segment files. An append creates new segments without rewriting old segments. Readers use the last complete manifest without taking the writer lock.

Persistent records are explicitly source-local or pairing-dependent. They omit runtime blocks, raw candidates, normalized candidates, semantic candidates, future-sensitive reductions, and all candidates for protected exact blocks. File-read and search reductions remain live because later history can change them. Semantic assistant candidates also remain live and are never persisted.

Official compaction validates the persistent key, dependency class, candidate shape, token count, source references, reducer version, and integrity immediately before use. A failed record causes deterministic cold computation for that block. Warm and cold paths produce the same model-facing replay, plan, validation, generation hash, rendered token count, and current-state text for the same authoritative input. Full branch parsing, resource lineage, causal analysis, planning, and final validation remain non-incremental. See [candidate-segment-store.md](candidate-segment-store.md).

The unkeyed integrity hash is corruption detection. It is not cryptographic authentication against a same-owner actor who can rewrite content and hash.

## Isolated deterministic worker

`compaction-worker-client.ts` and `compaction-worker-entry.ts` provide the default-off child-process boundary. One child reads one persisted JSONL source, reconstructs the exact requested leaf and cut, performs deterministic replay work, returns a strict bounded response, and exits. It has no model or network client. Provider-backed regular summary creation remains in the extension process. On success, the extension does not run `compactEntries` or calculate the complete replay generation hash.

`host-worker-scheduler.ts` limits replay and candidate-update CPU jobs across local Pi processes. It uses owner-only temporary tickets and slots. Replay has priority over waiting candidate updates. Linux stale recovery binds the PID to `/proc` process-start identity. The files contain no session or project identity. See [compaction-worker.md](compaction-worker.md).

## Retained V1.2 tool-result projection

`context-projection.ts` provides `off`, `safe`, and `aggressive` modes. The default is `off`. The `context` hook creates a request-local message array. It does not write the source messages or session JSONL.

Projection requires one preceding call, one result, an authoritative entry ID, the matching call ID, and the matching source fingerprint. It keeps first consumption, recent results, failures, unknown terminal outcomes, images, unsupported content, restrictions, unresolved work, pinned results, and later user-cited evidence exact. Each replacement states that it is a request-local projection and gives an exact `history_get` recovery reference. Pair ambiguity, a binding mismatch, or any exception returns unchanged messages.

`safe` uses useful deterministic reductions but excludes marker-only forms. `aggressive` can select an exact-repeat marker after one canonical copy remains exact. Both modes are deterministic.

## Typed blocks

`blocks.ts` maps Pi records into these block kinds:

- `user`
- `assistant_reasoning`
- `assistant_text`
- `tool_call`
- `tool_result`
- `bash_execution`
- `branch_summary`
- `custom_message`
- optional metadata/control kinds

Assistant content arrays are split by block index. Tool calls retain name, ID, and arguments. Tool results are paired back to their calls by `toolCallId` so reducers can retain commands, paths, and other decisive arguments even when the result entry does not repeat them.

Existing `compaction` control entries are excluded from normal source parsing. This is the primary no-summary-drift guarantee.

## Candidate ladder

Each `CandidateUnit` contains one or more `RepresentationCandidate` values:

| Level | Meaning in this implementation |
| --- | --- |
| `raw` | Exact textual block representation. Direct protected text is exact. |
| `normalized` | Lossless terminal/control-sequence cleanup. |
| `reduced` | Deterministic tool- or structure-specific reduction. |
| `semantic` | Extractive assistant reducer or validated optional LLM output. |
| `merged` | Multiple contiguous completed turns represented as an episode. |
| `marker` | Minimal source-aware historical note. |
| `absent` | Omitted low-information block with a global explicit absence notice. |

Candidates include raw and rendered token estimates, utility, reducer/version, source references, omission notices, and metadata.

A conservative user-reference candidate can remove one clearly delimited long quotation. It keeps the surrounding direct user text exact. A long quoted specification stays raw when no reference cue or explicit reference delimiter is present.

## Repeated observations

`repeated-observations.ts` adds local candidates after the normal typed reducers. It does not change source order. It uses no model, dependency, network request, or mutable index.

For an eligible exact duplicate, the first unit stays canonical. Its marker and absent candidates are removed so that the planner keeps one substantive selected copy. A later exact copy can use a small marker that includes its own exact recovery reference, the canonical source reference, and a content-hash prefix. Protected, unresolved, small, or structurally complex units are not eligible.

A repeated successful tool observation can use a delta only when both events have the same resource key, a large exact common line prefix and suffix, and a small exact changed region. Failed or unresolved observations cannot use this path. The changed lines remain exact. Both source references remain available. The candidate is rejected when marker overhead or the changed region would give weak savings.

All repeat and delta candidates pass the normal unsupported-fact and structural validator before planning. The repeated-observation reducer version is part of the generation hash.

## Importance and planning

The importance score is intentionally operational rather than purely semantic. It increases for:

- user content;
- protected restrictions or corrections;
- unresolved work;
- failures and exact evidence;
- identifiers likely to be needed again;
- recent blocks; and
- terms mentioned in retention hints.

It decreases for reproducible routine results, boilerplate preambles, generated artifacts, repeated old resource access, and very large non-error output.

Cross-event analysis gives more value to the latest repeated file read and to command outcome transitions. It gives less value to older repeated access. If later user or assistant text cites evidence before the next resource access, the older evidence receives a dependency increase. Failure and unresolved-language scoring applies only to block types that can provide that evidence. Error words inside successful source-map output do not become execution failures.

Activity-phase analysis uses conservative direct-request patterns. It detects a research or planning phase followed by implementation, verification, or documentation. Older discovery detail receives less importance. The last assistant result before execution receives a boundary increase so the causal handoff remains visible.

The planner constructs a Pareto frontier for each unit. It begins at the smallest safe candidate and applies upgrades with the greatest weighted utility gain per token. The token target is a maximum. The planner stops when every remaining upgrade is below the minimum marginal-value threshold. Recent units receive an additional upgrade bias. Protected exact content can cause a target overrun; this is surfaced as a warning rather than silently compressed.

## Episode grouping

Episode grouping is a second-stage pressure mechanism, not the default representation.

A range is eligible only when it is:

- contiguous and chronological;
- older than the configured merge boundary;
- composed of completed turns;
- free of protected-exact units; and
- sufficiently large in raw tokens and block count.

The merged body retains the request, sequence of reasoning/tool evidence, failures, and final assistant state. Its recovery pointer is an exact `history_range` over the source IDs.

## Semantic compression

`pi-semantic.ts` adapts Pi's model registry to the core `SemanticCompressor` interface. Calls are limited, per-block, and source-scoped. The model is never asked to summarize the entire session.

The semantic candidate validator rejects:

- identifiers absent from source;
- exact-looking quotations absent from source;
- numeric facts absent from source;
- completion claims for unresolved source work; and
- success-only renderings of failed source evidence.

Rejected LLM candidates are not repaired by another LLM call. The planner falls back to deterministic or raw alternatives.

## V1.1 experimental global history classification

`history-editor.ts` can run one optional model job after deterministic planning. The persistent `Experimental LLM history classifier` setting and `PI_CHRONO_HISTORY_EDITOR` environment variable control this path. The default is off. The environment value has precedence. This setting is independent of the regular Pi summary setting. The request contains ordered item metadata, full protected text, and bounded excerpts for large unprotected text. It asks only for typed importance and `keep` or `compress` advice. The provider request uses `cacheRetention: "none"`.

The model cannot write replay text. A valid `compress` action selects one prebuilt local candidate. Deterministic code keeps protected text, direct user text, decisive user-facing failure evidence, the first large duplicate copy, omitted decisions, and invalid decisions unchanged. It then validates the complete plan and enforces the adaptive output bound. A result that saves fewer than 100 estimated tokens uses the byte-identical deterministic fallback.

The response contract accepts an ordered subset. This prevents one uncertain item from rejecting useful independent decisions. Malformed top-level output, no accepted compression, failed validation, or an output-bound error uses the complete deterministic fallback. New cache sidecars use owner-only mode `0600`.

## Combined compaction context

On normal non-rebase generations, `pi-hybrid.ts` invokes Pi's regular summary implementation with raw messages ending at ChronoCompact's final tail boundary and can continue the previous Pi-only summary. On a rebase generation, `pi-extension.ts` instead uses the deterministic original-history rebase. The prior combined ChronoCompact output is never used as regular-summary input.

After Pi's summary completes, the deterministic event compactor independently rebuilds its replay from immutable raw branch entries. The regular summary's actual token count is removed from the total historical budget, and the replay planner receives the remainder. The model-facing order is:

1. Regular Pi compaction summary
2. ChronoCompact chronological event replay
3. Retained raw tail, which Pi appends after the custom compaction result

The same `session_before_compact` path handles manual `/compact`, Pi pressure, and configured proactive requests. If Pi's summary call is unavailable, the deterministic replay remains available by itself. Later replay events or the retained raw tail can supersede states in the regular summary.

## Rendering

`plain-renderer.ts` removes JSON envelopes, provider protocol fields, ANSI controls, repeated path prefixes, unchanged command metadata, and unnecessary per-block IDs. `render.ts` emits stable plain text. Exact IDs appear at lossy boundaries where recovery matters. A lossy representation includes:

- source entry ID or range;
- treatment/reducer;
- original and rendered token estimates;
- retained body;
- omission descriptions and counts; and
- exact retrieval reference.

Old information is not rewritten using later knowledge. Earlier failed hypotheses and later corrections remain in their original order. If per-event structural overhead itself exceeds the replay budget, older routine reasoning and tool interactions are grouped into chronological activity segments. Direct user text and assistant conclusions remain separate; failure excerpts and exact source ranges remain recoverable.

A final 25,000-token safety cap runs after planning. If minimum-safe representations still exceed this cap, ChronoCompact removes whole units only from the oldest replay prefix. It keeps the newest chronological suffix and emits one exact `history_range` recovery reference for the omitted prefix. The regular Pi summary still covers broad old state, and the separate raw tail remains unchanged.

## Retrieval

`search-index.ts` builds one deterministic in-memory generation over parsed source blocks. Ranked mode uses normalized BM25 with identifier, path, recency, current-version, and fuzzy-path signals. Exact and regular-expression modes remain available. Filters cover block kind, tool, error, unresolved and protected state, resource kind, resource key, version state, and time. Duplicate collapse and deterministic diversity prevent one repeated resource from filling the result.

`recall.ts` expands bounded cues through episode, resource, or block levels. Search can add bounded neighboring or paired evidence. Final rendering first reserves complete paging and recovery fields, then adds optional text while it fits. A cursor contains the index generation hash, remains complete in model-facing text, and fails closed when stale. Memory and mixed recall-result kinds are not implemented; ordinary memory promotion is a separate side effect and does not add unbudgeted recall text.

`retrieval.ts` remains the exact path. `historyGet` returns an immutable record or content block. `historyRange` follows the parent chain when possible and labels file-order fallback. Large exact values use explicit continuation bounds.

## Pi hook

An optional extension threshold runs after `agent_settled`. During autonomous runs, turn-end checks issue model-visible warnings at 75% and 85%; the model can request a natural-boundary compaction, while a 95% circuit breaker aborts further turns and compacts after settlement. Both forced paths send one hidden resume message with `triggerTurn: true` after compaction completes. `/chrono-compact-settings` opens an interactive TUI settings screen for threshold and token controls. Settings are stored in `~/.pi/agent/chrono-compact.json` by default. Environment variables have higher precedence. A pending-request guard prevents duplicate requests. A token-growth cooldown prevents repeated unhelpful attempts. Pi's normal context-pressure trigger remains active.

`tail-selection.ts` permits only retained suffixes with complete tool structure. It rejects a cut that separates a known call from its result. It also rejects every suffix that still contains a tool result with no earlier matching call. An orphan result can occur when a running tool finishes after an abort or compaction removed its assistant call. When a later valid boundary exists, the selector moves the cut after the orphan result so that the provider never receives a standalone function output.

`pi-extension.ts` performs this sequence during `session_before_compact`:

1. validate Pi's prepared `firstKeptEntryId` and `tokensBefore`;
2. use Pi's prepared cut or select a safe fixed or preset raw-tail cut;
3. derive both summary streams from raw branch entries ending at that same final cut;
4. estimate the retained raw tail;
5. derive a replay budget from the active-context target, or apply a fixed replay target;
6. collect optional retention hints;
7. reuse an exact matching combined generation cache when available;
8. generate Pi's regular summary from the newly compacted raw interval and prior Pi-only summary;
9. regenerate the ChronoCompact replay from immutable raw entries while ignoring prior compaction controls;
10. combine the two outputs in that order;
11. atomically cache the stable result; and
12. return Pi's custom compaction object.

Exceptions and validation failures return `undefined`, allowing Pi's normal compaction path to proceed.

## Source map

| File | Responsibility |
| --- | --- |
| `src/jsonl.ts` | JSONL parsing, structural validation, branch traversal |
| `src/blocks.ts` | Entry/content decomposition and tool pairing |
| `src/reducers/*` | Deterministic candidate generation |
| `src/history-analysis.ts` | Repeated-resource, artifact, citation, and command-transition analysis |
| `src/tail-selection.ts` | Safe fixed, preset, and dynamic raw-tail cut selection |
| `src/trigger.ts` | Optional threshold and token-growth cooldown decision |
| `src/user-config.ts` | Persistent validated ChronoCompact settings |
| `src/candidates.ts` | Representation ladder and importance scoring |
| `src/episodes.ts` | Completed-task range grouping |
| `src/planner.ts` | Global budget allocation |
| `src/validate.ts` | Factual and structural checks |
| `src/render.ts` | Stable chronological text replay |
| `src/retrieval.ts` | Exact history retrieval/search/range |
| `src/cache.ts` | Atomic generation sidecar |
| `src/candidate-segment-store.ts` | Default-off source-ledger-backed immutable candidate segment store |
| `src/incremental-context.ts` | Retired whole-branch checkpoint API; not used by the Pi extension |
| `src/context-projection.ts` | Default-off request-local tool-result projection and source binding |
| `src/pi-semantic.ts` | Optional Pi-backed per-block semantic compressor |
| `src/pi-hybrid.ts` | Independent regular Pi summary stream and combined rendering |
| `src/repeated-observations.ts` | Canonical exact-repeat and conservative repeated-observation delta candidates |
| `src/retention-gradient.ts` | Hot, warm, and cold source-token bands with protected overrides |
| `src/resource-lineage.ts` | Resource identity, versions, read unions, and supersession |
| `src/causal-memory.ts` | Episodes, state cells, outcome ledger, negative knowledge, and certificates |
| `src/plain-renderer.ts` | Plain model-facing text and representation-waste removal |
| `src/search-index.ts` | Local BM25, exact, regex, fuzzy path, filters, and paging |
| `src/recall.ts` | Staged cue, episode, resource, and block expansion |
| `src/memory-store.ts` | Append-only editable memory events and protected materialization |
| `src/summary-rebase.ts` | Regular-summary rebase decisions and deterministic original-history base |
| `src/telemetry.ts` | Token-category and retrieval feedback measurements |
| `src/pi-extension.ts` | Pi tools, hook, runtime settings, fallback |
| `src/cli.ts` | Standalone JSONL operator interface |
| `src/compactor.ts` | End-to-end orchestration |
