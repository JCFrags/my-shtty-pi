# ChronoCompact

An installable Pi extension and standalone TypeScript library for **bounded long-run memory, resource-aware chronological compaction, and staged exact recall**. It acts retrospectively on history only after the primary model has seen the original information.

The implementation follows the hand-off in [`docs/hand-off.md`](docs/hand-off.md): new information reaches the primary model normally; only historical active-context representations are compacted. Pi's JSONL is never rewritten and remains the authoritative record.

This tree is an isolated **2.0.0 correction 020 candidate**. It is not accepted, installed, activated, reaudited, or production-ready. External semantic processing, the experimental history classifier, incremental preprocessing, isolated local worker processes, and request-local projection remain default-off.

## Implemented behavior

- Parses Pi's tree-structured JSONL and reconstructs a selected parent-chain branch.
- Decomposes messages into user content, visible assistant reasoning, assistant text, tool calls, tool results, bash executions, branch summaries, and control metadata.
- Generates independent candidate representations for each block: raw, normalized, reduced, semantic, merged episode, marker, or absent.
- Detects a conservative discovery-to-execution phase transition and retains the boundary result while reducing older discovery detail.
- Preserves chronological placement and tool call/result pairing.
- Rejects raw-tail cuts that retain an orphan tool result. This can occur when a running tool finishes after its assistant call was lost during an abort or compaction.
- Runs deterministic reducers before one optional experimental V1.1 LLM classification job. The classifier is off by default. The model returns typed per-item importance and treatment advice. Deterministic code selects and renders only prebuilt local candidates.
- Uses source-token retention bands: approximately 10,000 hot tokens, the preceding 75,000 warm tokens, and cold cue capsules. Authority, unresolved work, causality, novelty, reuse, and reproducibility override age.
- Tracks file and evidence paths as versioned observations. Normal Pi reads without a synthetic revision union when overlapping bytes agree. Conflicting overlaps and writes start a new inferred version. Structured URLs, commands, tests, services, settings, packages, processes, and agents have narrower observed identities; they do not share full file-style lifecycle behavior.
- Renders plain source text without repeated JSON envelopes, ANSI, protocol fields, IDs, path prefixes, or decorative boilerplate.
- Builds a local dependency-free BM25 index over parsed blocks. It adds exact and regex modes, fuzzy path matching, connected filters, current-version preference, diversity, compact snippets, bounded neighbors, and staged episode, resource, and block recall. Priority-aware rendering reserves complete paging and exact-recovery fields before optional headers, generation, metadata, bodies, and instructions. It never truncates a cursor, source identity, or retrieval command. An oversized item becomes a usable recovery cue. If a complete search recovery command cannot fit, the response instructs the same query and applicable filters at the 2,000-token budget with no cursor. This starts a valid larger-budget first page while ordinary cursors remain bound to all original options.
- Stores editable ordinary working knowledge as owner-only serialized append-only memory events. Concurrent successful writes preserve one hash chain. Ordinary tools cannot create or mutate protected memory. Protected creation independently loads one configured project or skill regular file, verifies stable path identity and complete SHA-256, and uses those loaded bytes. Caller-supplied text, hash, authority, or path cannot mint protected memory.
- Materializes a source-linked current-state register before chronological history. It keeps conflicts, negative knowledge, command outcomes, failure families, metric rollups, causal edges, and proof-carrying completion certificates.
- Merges sufficiently old, completed, contiguous turns into chronological task episodes when individual units are no longer economical.
- Collapses oversized unfinished routine reasoning/tool sequences into bounded activity segments with failure excerpts and exact recovery ranges.
- Enforces an absolute 25,000-token replay cap and a hard 30,000-token combined cap across the regular Pi summary, Chrono history, and raw tail.
- Labels every lossy representation, reports omissions and token reduction, and emits exact recovery references.
- Rebuilds each generation from original branch entries, ignoring prior compaction control entries, to prevent summary-of-summary drift.
- Caches byte-stable compaction generations in a sidecar file.
- Optionally preprocesses source-local and verified tool-pair candidates in a source-ledger-backed immutable segment store. Appends read only new source plus bounded pair context and do not rewrite old segments. Future-sensitive candidates remain live computations. Missing, stale, busy, or corrupt data causes a cold per-block recomputation without delaying compaction.
- Optionally projects old tool results only in a model-request copy. Modes are `off`, `safe`, and `aggressive`. The feature keeps first consumption and recent results exact. It also keeps failures, unknown terminal outcomes, images, restrictions, unresolved work, and later user-cited evidence exact.
- Rejects unsafe semantic candidates that introduce unsupported identifiers, quotations, numeric facts, success states, or outcomes.

This is not a `memory.md` authority file and not only one conversation summary. Each eligible compaction produces pinned source-linked memory, a chronological replay, and Pi's retained raw tail. At the configured interval, the extension uses the deterministic local rebase builder on normalized original messages instead of carrying or calling the prior-summary path. It never uses the ChronoCompact replay as rebase input.

### V2 scope limits

- Search uses the selected active branch. Cross-branch and abandoned-branch search or summarization are not implemented.
- Search filters cover block kind, tool, error, unresolved, protected, time, resource kind, resource key, and current or superseded file state. Branch, task, and episode filters are not implemented.
- Recall expands to an episode, resource, or exact source block. It has no separate task-level recall object.
- Hit state labels cover current, superseded, and unversioned resource observations. Error, unresolved, and protected values are filters, not separate hit-state labels.
- File evolution does not track move or rename identity, reduce a partial overlap to only its novel suffix, create independent symbol units, compute net patches, verify current disk bytes, or cache file and symbol summaries.
- The ranked index is in-memory and rebuilds from parsed JSONL. It has generation-bound stale-cursor refusal, but no persisted ranked-index schema or corruption-recovery file.
- Memory and cache integrity checks reject unsupported schemas. Automatic schema migration is not implemented. The 220-generation test rebuilds an in-memory index but does not simulate schema migration.
- The product does not deduplicate a historical AGENTS.md against Pi's active instruction injection because source identity equivalence is not proved.
- Protected ingestion supports configured `project:` and `skill:` regular files only. It does not discover scope applicability or verify other authority types.
- Lock owner-death verification uses Linux `/proc/<pid>/stat` process-start identity. On a platform where ownership cannot be verified, recovery fails closed.
- Lock publication briefly gives the candidate inode two links before the unique candidate name is removed. A concurrent contender retries this transient state within the existing lock limits. A persistent multi-link lock still fails closed; this does not claim that all lock races are impossible.

## Installation

Requirements: Node.js 20 or later and a current Pi installation.

```bash
npm install
npm test
npm run build
pi install .
```

For direct development loading:

```bash
pi -e ./dist/src/pi-extension.js
```

The package manifest declares `dist/src/pi-extension.js` as its Pi extension entry point. Pi-provided core modules are declared as `"*"` peer dependencies rather than bundled runtime dependencies. Prebuilt JavaScript and declarations are included in the distribution archive.

## Pi integration

The extension listens to `session_before_compact`. The same pipeline runs for manual `/compact`, Pi context pressure, and an optional user-configured proactive threshold.

For an ordinary eligible generation, the extension invokes Pi's regular compaction summarizer with raw messages ending at the final ChronoCompact tail boundary and the previous Pi-only summary. At a configured rebase generation, it uses the deterministic local rebase over normalized original messages and does not call the regular provider-summary path. It independently rebuilds the ChronoCompact event replay from immutable raw branch entries ending at the same boundary. It combines the regular-memory layer and replay into Pi's one replacement compaction message. The retained raw tail follows normally.

The regular Pi summary never receives the ChronoCompact replay. The replay never uses a prior compacted replay as source. New user messages and first-consumption tool results remain unchanged. Optional projection can replace only an older tool result in one request-local message copy. It never changes the stored message or JSONL.

Malformed top-level V1.1 model output uses the complete deterministic replay fallback. Invalid or missing per-item decisions keep those items unchanged. Protected exact text, required exact evidence, chronology, recovery references, final validation, and token limits stay under deterministic control. If final replay validation fails, Pi's default compactor remains the safety fallback.

### Registered tools

| Tool | Purpose |
| --- | --- |
| `history_get` | Return an exact JSONL entry or one exact content block, with neighboring records. |
| `history_search` | Use ranked BM25, exact, or regex search with fuzzy paths, filters, diversity, complete cursor paging, exact recovery cues, and a complete rendered-response budget. |
| `history_recall` | Expand a cue into an episode, resource evolution, or source block with priority-aware exact recovery within a complete rendered-response budget. |
| `history_range` | Return an exact chronological range, preferring the parent-chain path. |
| `memory_remember`, `memory_update` | Append ordinary source-linked working knowledge and updates. |
| `memory_forget`, `memory_promote` | Demote without deletion or temporarily promote memory after use. |
| `memory_list`, `memory_get`, `memory_search` | Inspect current and archived memory with provenance. |
| `history_retention_hint` | Record advisory pre-compaction priorities. It is metadata, not authoritative memory. |
| `request_compaction` | Let the model request compaction at a natural work boundary. |

The extension registers one user command: `/chrono-compact-settings`. It opens a real TUI settings screen with selection dialogs, numeric inputs, Save, and Cancel.

## Configuration

Run `/chrono-compact-settings` in Pi to configure:

- compaction timing: Pi pressure only or a proactive token threshold;
- raw-tail mode: Pi, dynamic, short, medium, long, or a fixed token amount;
- minimum and maximum bounds for dynamic raw-tail selection;
- target active-context size;
- automatic or fixed chronological replay maximum; and
- regular Pi summary enablement and token target; and
- the separate, default-off `Experimental LLM history classifier` setting;
- default-off deterministic incremental preprocessing;
- a default-off one-job local child process for replay and candidate updates, with a host-wide priority scheduler; and
- default-off request-local tool-result projection with `off`, `safe`, and `aggressive` modes;
- ranked local search and editable working memory enablement;
- hot and warm source-token retention bands; and
- the regular-summary rebase interval.

Settings are validated before they are saved to `~/.pi/agent/chrono-compact.json`. TUI changes take effect immediately and survive restart. Pi's built-in context-pressure trigger remains the final safeguard. Pi must still find an eligible historical prefix before any manual or proactive request can compact.

Environment variables remain available for advanced deployment. They take precedence over TUI values:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PI_CHRONO_TARGET_CONTEXT` | `32000` | Desired total active context after compaction, including the raw tail. |
| `PI_CHRONO_REPLAY_TARGET` | unset | Optional fixed maximum replay target, from 256 to 25,000 tokens. |
| `PI_CHRONO_TRIGGER_TOKENS` | unset | Optional proactive threshold after an agent settles. |
| `PI_CHRONO_TRIGGER_MIN_GROWTH` | `4000` | Growth required before retrying an unhelpful threshold request. |
| `PI_CHRONO_MIN_SUMMARY` | `4000` | Minimum historical output budget. |
| `PI_CHRONO_MAX_SUMMARY` | `20000` | Maximum historical output budget. |
| `PI_CHRONO_CONTEXT_RESERVE` | `1500` | Reserve for prompt overhead. |
| `PI_CHRONO_RAW_TAIL` | `dynamic` | `pi`, `short`, `medium`, `long`, `dynamic`, or fixed tokens. |
| `PI_CHRONO_RAW_TAIL_MIN` | `3000` | Dynamic-tail minimum. |
| `PI_CHRONO_RAW_TAIL_MAX` | `6000` | Dynamic-tail maximum. |
| `PI_CHRONO_PI_SUMMARY` | `true` | Include Pi's regular compaction summary before the replay. |
| `PI_CHRONO_PI_SUMMARY_TOKENS` | `2500` | Regular Pi summary target. |
| `PI_CHRONO_RECENT_EXACT_FRACTION` | `0.2` | Newest-unit exact/light-compression preference. |
| `PI_CHRONO_MIN_MARGINAL_UTILITY` | `0.06` | Minimum value per token for more replay detail. |
| `PI_CHRONO_MERGE_EPISODES` | `true` | Enable completed-task episode grouping. |
| `PI_CHRONO_MERGE_BEFORE_FRACTION` | `0.55` | Old range eligible for episode grouping. |
| `PI_CHRONO_MAX_UNITS` | `600` | Unit-count pressure limit. |
| `PI_CHRONO_MIN_EPISODE_TOKENS` | `1200` | Minimum source size for an episode. |
| `PI_CHRONO_MAX_EPISODE_TOKENS` | `420` | Maximum episode body size. |
| `PI_CHRONO_HISTORY_EDITOR` | `false` | Enable the experimental one-job V1.1 importance and treatment classifier. It uses Pi's current provider and model. This environment value overrides the persistent setting. |
| `PI_CHRONO_HISTORY_EDITOR_MAX_INPUT` | `50000` | Maximum estimated editor input. Larger generations use deterministic compaction without a model job. |
| `PI_CHRONO_HISTORY_EDITOR_MAX_OUTPUT` | `16000` | Adaptive upper bound. Normal generations stay at or below 8,000 tokens. High-value ultra-long history can use more. |
| `PI_CHRONO_INCREMENTAL_PRECOMPUTE` | `false` | Enable segmented deterministic background candidate preprocessing. The owner-only store is `<session.jsonl>.chrono-candidate-segments-v1`. Old `.chrono-incremental-v2.json` files are ignored. |
| `PI_CHRONO_ISOLATED_WORKER` | `false` | Move deterministic replay and enabled candidate updates to one-job local child processes. See [`docs/compaction-worker.md`](docs/compaction-worker.md). |
| `PI_CHRONO_HOST_WORKER_SLOTS` | `1` | Limit host-wide ChronoCompact CPU jobs to 1–4. Waiting replay has priority over waiting updates. |
| `PI_CHRONO_WORKER_TIMEOUT_SECONDS` | `900` | Bound scheduler and child work from 30 through 3,600 seconds. |
| `PI_CHRONO_WORKER_NICE` | `10` | Set child nice level from 0 through 19. A permission failure is nonfatal. |
| `PI_CHRONO_TOOL_RESULT_PROJECTION` | `off` | Select `off`, `safe`, or `aggressive` request-local projection. Uncertainty keeps all messages unchanged. |
| `PI_CHRONO_RANKED_SEARCH` | `true` | Use normalized BM25 as the normal `history_search` path. Exact and regex remain available. |
| `PI_CHRONO_EDITABLE_MEMORY` | `true` | Enable owner-only append-only ordinary working memory. |
| `PI_CHRONO_HOT_SOURCE_TOKENS` | `10000` | Approximate newest source-token band with least semantic compression. |
| `PI_CHRONO_WARM_SOURCE_TOKENS` | `75000` | Approximate preceding source-token band with normal structured compression. |
| `PI_CHRONO_COLD_CUE_TOKENS` | `56` | Maximum generic cold cue size. |
| `PI_CHRONO_SUMMARY_REBASE_INTERVAL` | `8` | Rebuild the regular summary from original normalized messages after this many generations. |
| `PI_CHRONO_CACHE` | `true` | Enable generation caching. |
| `PI_CHRONO_CONFIG_PATH` | `~/.pi/agent/chrono-compact.json` | Override the TUI settings path. |

The trigger threshold, raw-tail size, active-context target, replay maximum, and Pi-summary target are independent. A target is a maximum, not a requirement to spend tokens. The planner can stop early when more detail has weak value. Regardless of planner minimums, the final chronological replay cannot exceed 25,000 estimated tokens.

During a long autonomous run, ChronoCompact sends one hidden model-visible advisory at 75% and one urgent advisory at 85%. The model can call `request_compaction` at a natural boundary. At 95%, a turn-boundary circuit breaker aborts further autonomous turns and compacts after the agent settles. Model-requested and circuit-breaker compactions automatically start a continuation turn afterward. This cannot stop a single response or indivisible tool result from jumping across the limit before Pi reports usage.

### Interaction with Pi pressure settings

Pi's built-in auto-compaction remains enabled unless `compaction.enabled` is set to `false` in Pi settings. Pi triggers after a completed agent run when `contextTokens > contextWindow - reserveTokens`. Its defaults are a 16,384-token reserve and a 20,000-token recent tail.

ChronoCompact's proactive threshold is an additional earlier request. It cannot postpone or disable Pi pressure compaction. The effective trigger is whichever becomes eligible first. If the ChronoCompact threshold is above Pi's pressure threshold, Pi pressure wins. Active-context and replay targets affect output size, not trigger timing.

Pi's `keepRecentTokens` is also the preparation gate and the default tail when raw-tail mode is `pi`: Pi must find an older prefix before the extension hook runs. Once the hook runs, another ChronoCompact raw-tail mode may select a smaller or larger final safe tail. The final cut is used by both the regular Pi summary and the replay, and only one raw tail is retained. A very low proactive threshold can therefore request compaction before Pi has anything eligible to compact.

The footer can temporarily exceed 100% during a long agent run. Pi checks threshold compaction after the run completes, so one response or tool-heavy turn can cross the threshold before compaction begins. Summary generation can then take additional time. Check for the footer's `(auto)` marker and the next saved compaction entry rather than assuming that crossing 100% means auto-compaction is disabled.

Pi's regular summary is generated first through Pi's normal summary implementation. On ordinary later generations, its update input is the previous Pi-only summary plus original messages newly entering the final compacted prefix. At the configured interval, V2 omits the prior generated summary and supplies normalized original messages from the full compacted range. The combined ChronoCompact output is never fed back into that stream. The event replay is always regenerated from immutable raw JSONL and ignores prior compaction control entries.

The raw-tail presets are 8,000, 16,000, and 24,000 tokens. Dynamic mode is the default. It uses the estimated current-turn size plus a 1,500-token continuity margin and applies the 3,000–6,000-token default bounds. A valid Pi boundary or one crossing tool call/result pair can change the actual size.

V1.1 records whether the experimental classifier was applied, skipped, disabled, or rejected. It also records the model identity, one-job count, input items, accepted, rejected, and missing decisions, changed items, and layer token estimates in compaction details. The classifier setting is independent of the regular Pi summary setting. The environment value has precedence over the persistent setting. New cache files use owner-only mode `0600`.

## Standalone CLI

The CLI operates directly on immutable session JSONL and is useful for inspection, offline evaluation, and reducer development.

```bash
# Compact the active branch inferred from the last JSONL entry
pi-chrono-compact compact session.jsonl --target 12000

# Select a branch leaf and compact only the prefix before an entry
pi-chrono-compact compact session.jsonl --leaf ENTRY_ID --before FIRST_KEPT_ID

# Write replay and machine-readable plan separately
pi-chrono-compact compact session.jsonl --target 20000 \
  --out replay.md --details replay-plan.json

# Exact recovery
pi-chrono-compact get session.jsonl ENTRY_ID --block 0
pi-chrono-compact search session.jsonl 'activeRequests=3'
pi-chrono-compact range session.jsonl START_ID END_ID
```

Run the included fixture:

```bash
npm run demo
```

The checked-in example at [`examples/fixture-replay.md`](examples/fixture-replay.md) reduces 14,907 estimated raw tokens to 2,106 tokens while preserving the exact public-API restrictions and failing assertion. Its machine-readable selection plan is in [`examples/fixture-plan.json`](examples/fixture-plan.json).

## Compression pipeline

```text
Raw active-branch entries
        ↓
Typed historical blocks
        ↓
Raw + lossless normalized candidates
        ↓
Tool-specific deterministic reductions
        ↓
Canonical exact-repeat and conservative observation-delta candidates
        ↓
Optional narrow semantic candidates
        ↓
Validation and unsafe-candidate pruning
        ↓
Optional contiguous completed-task episodes
        ↓
Global budget planner
        ↓
Stable chronological replay + recovery pointers
```

### Deterministic reducers

- Terminal output: ANSI removal, carriage-return collapse, repeated-line counts, command/cwd/exit metadata, warning/error neighborhoods, generated-output markers, and head/tail fallback.
- Test output: command, framework, exit status, pass/fail/skip totals, failing names, exact assertion differences, relevant frames, warnings, and repeated-failure evidence.
- File reads: path, requested range, revision/hash when available, symbols, imports, exact selected lines, and a historical-version warning.
- Git diffs: changed files, additions/deletions, hunk headers, API/schema/test-sensitive lines, and exact selected hunks.
- Search output: query, scope, match count, files, representative exact matches, and exhaustiveness metadata.
- Structured JSON/API output: status/error/identifier/count fields, important records, boundary samples, and explicit omitted-record counts.
- Assistant text and visible reasoning: extractive retention of hypotheses, decisions, evidence, constraints, next actions, and unresolved uncertainty.
- User reference text: conservative removal of a clearly delimited long quotation while surrounding direct user text remains exact.
- Repeated observations: keep the first selected exact duplicate as the canonical copy. Replace later safe exact repeats with source-aware recovery markers. For safe repeated successful observations only, keep a bounded exact changed region when a large unchanged prefix and suffix prove a useful delta.

## Budgeting and stability

Planning starts from each unit's smallest safe representation, then upgrades candidates by marginal utility per token. Importance considers content type, errors, unresolved work, exact identifiers, reproducibility, recency, and advisory retention hints.

The token target is a maximum. The planner stops before the target when every remaining upgrade is below the configured marginal-value threshold. High importance can still justify the same upgrade for decisive evidence, unresolved work, restrictions, or retention-hint matches. The threshold therefore controls added detail. It does not remove the smallest safe chronological representation.

A generation hash covers model-facing raw source entries, retained future entries used for analysis, reducer versions, configuration, and retention hints. Unrelated runtime metadata, such as random browser-state entries, does not invalidate the generation cache. The deterministic replay contains no changing timestamps. A generated regular Pi summary can vary if its cache is deleted and the same generation is rebuilt. A cache hit reuses the exact combined bytes, preserving prompt-cache stability between substantial compactions. Sidecars are written atomically as:

```text
<session.jsonl>.chrono-compact.json
```

The sidecar is secondary data and can be deleted or rebuilt from JSONL. The source ledger and immutable candidate segment store are also secondary. The default-off isolated worker resolves the exact requested branch from ledger parent metadata and reads only verified branch ranges plus bounded gaps. Exact `history_get` and `history_range` operations reuse an existing valid current-session ledger when available and otherwise keep the parser fallback. They do not create a ledger only because an exact history tool ran. Candidate segments omit raw, normalized, semantic, future-sensitive, and protected exact candidates. Manifest publication is atomic and owner-only. See [`docs/candidate-segment-store.md`](docs/candidate-segment-store.md). The editable-memory sidecar additionally uses an owner-only exclusive lock. Lock ownership binds a random nonce, inode, PID, and Linux process-start identity. Age never proves owner death. Dead main locks and dead recovery guards use race-safe recovery. Release cannot remove a replacement owner. A synced temporary chain, atomic rename, and directory sync prevent concurrent successful appends from overwriting one another. A session, configuration, reducer, truncation, rewrite, or branch change invalidates cache reuse. Cancellation prevents replaced background work from becoming current.

The unkeyed integrity hash is corruption detection. It is not cryptographic authentication against a same-owner actor who can rewrite content and hash.

Request-local projection binds each result to its authoritative entry ID, tool call ID, and source fingerprint. A projected placeholder gives an exact `history_get` recovery reference. Duplicate or orphan pairs, binding mismatches, unsupported content, or other uncertainty keep the complete request unchanged. `safe` avoids marker-only candidates. `aggressive` can use deterministic exact-repeat markers while one canonical result remains exact.

## Validation and fallback

Before rendering, the engine checks:

1. source references exist;
2. chronological order is retained;
3. tool interactions do not disappear;
4. direct user restrictions remain exact, including when a clearly delimited long reference quotation is removed;
5. every lossy candidate declares omissions;
6. semantic candidates do not invent identifiers, exact-looking quotations, or numeric facts;
7. unresolved work is not rewritten as complete;
8. failed evidence is not rewritten as success; and
9. the plan and final rendered replay are measured against the target.

Unsafe candidates are pruned. If no valid plan remains, compaction is rejected rather than silently weakening the guarantees.

## Library API

```ts
import {
  compactEntries,
  getActiveBranch,
  historyGet,
  historyRange,
  historySearch,
  readSessionJsonl,
} from "pi-chrono-compact";

const session = await readSessionJsonl("session.jsonl");
const branch = getActiveBranch(session);
const result = await compactEntries(branch, {
  config: { targetTokens: 20_000 },
  retentionHints: "Preserve the exact migration ID and current failing assertion.",
});

console.log(result.summary);
```

`result.details` contains source ranges, selected representation levels, raw/rendered estimates, reducer versions, generation hash, and the validation report.

## Test coverage

The repository includes an end-to-end Pi-like fixture and automated tests for:

- immutable JSONL parsing, branching, missing parents, duplicates, and cycles;
- test-output and file-read evidence retention;
- deterministic replay generation and stable generation hashes;
- prior-compaction exclusion and no summary drift;
- exact retrieval/search/range behavior;
- cache generation and malformed-sidecar rejection;
- marginal-value planner stopping;
- repeated file access and command outcome transitions;
- conservative discovery-to-execution phase transitions;
- fixed, preset, and bounded dynamic raw-tail cut selection;
- exclusion of orphan function outputs from the retained raw tail;
- optional settled-agent trigger threshold and token-growth cooldown;
- generated-output failure-word rejection;
- normal-suite Pi extension hook integration;
- regular Pi summary ordering and replay-input isolation;
- completed-task episode grouping; and
- semantic candidate rejection for unsupported facts;
- exact-repeat canonical retention and conservative repeated-observation deltas; and
- experimental-classifier default, persistence, environment precedence, and zero-call disabled paths;
- segmented incremental transitions, immutable append behavior, cold-equivalent output, final-use tamper rejection, protected-data omission, cross-segment pairing, bounded runtime loading, malformed fallback, cancellation, and extension integration;
- isolated-worker protocol rejection, exact branch and cut reconstruction, source stability, replay equality, cache behavior, candidate updates, process failure, cancellation, scheduler limits and priority, stale-owner recovery, privacy, cleanup, and extension integration; and
- projection modes, first use, recency, protected evidence, source binding, pair validation, exact recovery, deterministic output, request-local immutability, and extension fail-closed behavior;
- hot, warm, and cold retention with protected-age override and bounded cold cues;
- declared and inferred file versions, normal-read overlap union, conflicting-overlap supersession, product-connected near-duplicate factoring, and marker-only repeat safety;
- local BM25, exact, regex, fuzzy path, filtering, current-version preference, diversity, complete 120-token cursor paging, all-level recall recovery cues, long-field fail-closed retry, and byte-identical cache-repeat rendering;
- editable ordinary memory create, update, list, search, promotion, decay, demotion, supersession, 40-way same-process and separate-process concurrent append, independently loaded configured authority, spoof and ordinary mutation refusal, old-live-owner protection, PID-start mismatch, dead-owner and dead-recovery-guard recovery, replacement-safe release, rebuild, and corruption refusal;
- plain terminal and structured JSON reducers with exact failure evidence and first-five/last-five unknown-output fallback;
- causal episodes, completion certificates, command outcomes, extension-path deterministic original-history summary rebase, retrieval feedback, and token telemetry; and
- a deterministic 220-generation long-run simulation with resource changes, search, memory promotion, protected restrictions, and generated-compaction exclusion.

```bash
npm test
```

## Current limitations

- Token counts use a deterministic character-based estimate. Provider tokenizer counts can differ, so the renderer replans against measured estimated output and reports budget pressure explicitly.
- Tool-specific reducers are heuristic. Unknown warm tool results use decisive evidence plus the first five and last five lines with omission counts.
- File lifecycle tracking does not infer moves or renames, compute net edit patches or reverse deltas, or cache file or symbol summaries.
- Structured settings and package commands receive distinct resource kinds. They do not have file-style versioned lifecycle parsers.
- Retrieval feedback is session-local process state. It affects later compactions in the same loaded extension session and is not authority.
- The extension-level result is one Pi compaction message rather than native reconstructed event objects; chronology and per-block labels remain explicit inside it.
- Ranked search and staged recall use only the selected active branch. At very small budgets, optional explanatory text can be absent because complete cursor and recovery fields have priority. `history_range` prefers a parent-chain path and labels file-order fallback when entries are not ancestor/descendant.
- Visible reasoning is preserved only when it exists in session data. The system does not reconstruct unavailable private reasoning.
- Historical images are represented by explicit opaque-image markers and remain exactly recoverable from JSONL; the text-only compaction message does not embed original image bytes.
- Segmented incremental reuse reduces repeated persistent candidate work. It does not avoid authoritative branch parsing, future-sensitive computation, resource and causal analysis, planning, or final validation.
- Isolated child work keeps deterministic replay CPU work off Pi's main event loop. It does not reduce total CPU work. The default one-slot scheduler limits simultaneous ChronoCompact memory and CPU pressure.
- Projection is request-local and process-local. A restart resets first-consumption tracking and therefore preserves more full results until later requests.

See [`docs/architecture.md`](docs/architecture.md) for implementation details and [`docs/hand-off.md`](docs/hand-off.md) for the authoritative product definition.
