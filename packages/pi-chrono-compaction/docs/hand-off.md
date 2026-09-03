# Hand-off: ChronoCompact for Pi

> V2 implementation note: This document remains the authoritative product definition for retrospective chronological compaction. ChronoCompact 2.0.0 adds bounded pinned working memory, resource evolution, hot/warm/cold retention, local ranked search, staged recall, editable ordinary memory, token telemetry, and periodic regular-summary rebase. These layers support the chronological replay. They do not replace immutable JSONL or grant derived memory system authority. Correction 016 restricts protected memory creation to independently loaded configured project or skill files and uses live-writer-safe nonce/inode/PID-start lock ownership with recoverable dead guards. Correction 018 bounds complete search and recall text with priority-aware rendering. Correction 020 makes the long-identity search fallback executable: it repeats the same query and applicable filters at the larger budget with no cursor. Ordinary cursors remain bound to unchanged search options. The renderer preserves complete recovery fields, returns bounded cues instead of silently omitting oversized matches, and keeps repeated cache-hit text byte-identical. See [`architecture.md`](architecture.md).

## Purpose

Design a context-compaction system for the Pi coding agent that supports extremely long-running sessions—days, weeks, or longer—without forcing the primary model to operate indefinitely on a noisy 100k–125k-token transcript.

The system must let the primary model see new information at full fidelity when it first appears. Later, after that information has aged or become less immediately useful, the active-context copy may be compressed.

The permanent Pi JSONL session remains unchanged and contains the authoritative history.

This is not primarily an agent-memory system. It is a **progressively compressed chronological replay of the original session**.

---

## The core mental model

Pi’s JSONL session is the immutable event history:

```text
User message
Assistant reasoning or thinking block, when available
Assistant preamble or explanatory text
Tool call
Tool result
Assistant reasoning
Another tool call
Another tool result
Assistant final response
Next user message
...
```

The active model context is a rendered version of that history.

Initially, recent events are rendered exactly as they occurred. As the context grows, individual historical sections can be replaced with smaller representations:

```text
User message — exact
Assistant reasoning — compressed
Assistant preamble — exact, compressed, or omitted
Tool call — usually exact
Tool result — programmatically reduced
Assistant reasoning — semantically compressed
Tool call — exact
Tool result — heavily reduced
Assistant final response — lightly compressed
```

The order remains intact.

The active context should continue to communicate the causal sequence:

```text
The user requested something.
The model formed a plan.
It called a tool.
The tool produced evidence.
The model changed its interpretation.
It called another tool.
The task reached a result.
```

The system must not replace this structure with a single generic “summary of the conversation.”

---

# Authoritative requirements

## 1. New information reaches the primary model unmodified

Tool outputs, user messages, assistant content, and other session events must first be shown to the primary model in their normal full form.

The compactor acts retrospectively.

The desired sequence is:

```text
Tool returns full output
        ↓
Primary model sees full output
        ↓
Full output is stored in Pi JSONL
        ↓
The session continues normally
        ↓
Later, when the output is historical,
its active-context representation is compressed
```

This differs fundamentally from tool extensions that truncate, summarize, filter, or rewrite results before the model sees them.

Those existing token-saving techniques may still be useful, but they should be reused as **after-the-fact compressors**, not necessarily as real-time interceptors.

---

## 2. The raw JSONL is never rewritten

The Pi session JSONL is the source of truth.

Compaction changes only the version of history rendered into the current model context. It must not destructively alter:

* Original user messages
* Original assistant messages
* Available thinking or reasoning blocks
* Tool-call arguments
* Tool results
* Event IDs
* Parent relationships
* Historical ordering

Any compression metadata, indexes, or cached representations are secondary data. They may be rebuilt from the original JSONL.

---

## 3. Each historical section is independently compressible

The atomic unit is not necessarily a whole turn or whole conversation.

The compactor should recognize distinct blocks such as:

| Block type           | Examples                                                     |
| -------------------- | ------------------------------------------------------------ |
| User content         | Request, correction, follow-up, approval                     |
| Assistant reasoning  | Thinking or reasoning block exposed by the provider          |
| Assistant text       | Plan, preamble, explanation, final response                  |
| Tool call            | Tool name and arguments                                      |
| Tool result          | Terminal output, file contents, search results, API response |
| Compound interaction | Tool call paired with its result                             |
| Turn                 | All blocks associated with one assistant turn                |
| Task episode         | Multiple turns that form one completed investigation or task |

Each block can receive its own treatment and token budget.

For example, the user’s instruction may remain exact, a reasoning block may become a 150-token summary, a tool call may remain exact, and an 8,000-line terminal result may become a 300-token structured reduction.

---

## 4. Historical and causal ordering must be preserved

Compacted events remain in the chronological position occupied by their original source events.

The compactor must not extract all constraints into one detached section, all tool failures into another section, and all decisions into another unless that is an additional view rather than the main historical replay.

The primary representation should retain chronology:

```text
[e120 user]
...

[e121 assistant reasoning — compressed]
...

[e121 tool call]
...

[e122 tool result — compressed]
...

[e123 assistant reasoning — compressed]
...
```

This allows the model to understand not only what happened, but why later actions followed earlier evidence.

---

## 5. Lossy compression must be visible

The primary model should never unknowingly depend on a result that was silently truncated.

Every lossy representation should identify itself as compressed and provide a way to recover the source.

For example:

```text
[e122 TOOL RESULT — programmatically compacted 8,040→460 tokens]

Exit code: 1
Tests: 8 passed, 1 failed

Failure:
  timeout.test.ts
  expected activeRequests=1
  received activeRequests=3

Repeated framework output and passing-test logs omitted.

Full source: history_get("e122")
```

The marker tells the model:

1. This is not the complete original.
2. What kind of transformation occurred.
3. How much was removed.
4. Where the exact source can be retrieved.

Compression should not create the false impression that the retained text was everything the tool returned.

---

## 6. Exact recovery remains available

The system should expose raw-history retrieval, such as:

```text
history_get(entryId)
history_get(entryId, blockIndex)
history_search(query)
history_range(startEntryId, endEntryId)
```

Retrieval should return exact content from the immutable JSONL, with enough neighboring context to interpret it.

Search and retrieval are safety mechanisms, not replacements for the compacted chronological context.

The compactor should preserve awareness that relevant omitted information exists. It should not expect the model to search for something it has no reason to know was removed.

---

# What this system is not

## It is not a `memory.md` system

The central output is not a separate durable memory document containing goals, constraints, decisions, and open tasks.

Internal indexes or metadata may exist, but they are implementation details. They should not redefine the product as a memory-ledger architecture.

An optional memory-like note may be generated immediately before compaction to help identify important content, but it is advisory input to the compactor. It is not the primary context representation or the authoritative history.

---

## It is not a single conversation summary

The output should not primarily look like:

```text
The user asked for X. The agent tried Y. It encountered Z.
The current task is...
```

That may be appropriate for very old completed episodes, but it is not the default representation of the entire compacted history.

The primary representation remains an ordered event stream.

Each compaction should include Pi's regular compaction summary as an orientation layer.
Pi's summary must be generated through Pi's regular compaction logic.
On repeated compaction, it can update the previous Pi-only summary with Pi's newly prepared messages.
It must never use the ChronoCompact replay or prior combined output as summary input.
The model-facing order must be:

```text
Regular Pi compaction summary
ChronoCompact chronological event replay
Retained raw tail
```

This same pipeline must handle manual `/compact`, Pi context pressure, and a configured proactive threshold.
The regular summary is advisory.
Later replay events or the retained raw tail can supersede it.
If Pi's regular summary generation is unavailable, ChronoCompact uses a replay-only degraded fallback and reports the degraded state. This is an operational failure path, not a user-disable mode. It must not create local text and label it as Pi's regular summary.
The chronological replay and immutable JSONL remain the evidence and recovery path.

---

## It is not pre-model tool truncation

The design does not assume that a terminal result should be shortened before the primary model sees it.

The primary model should normally receive the full result first. The same truncation logic can later be applied to the historical active-context copy.

---

## It is not “keep the latest N tokens raw and summarize everything else” as a hard rule

A large recent raw region is useful, but it is a policy preference rather than the defining architecture.

The compactor may evaluate the entire active context, including recent events. Recency should strongly favor exact or light compression, but a recent 40,000-token repetitive log may still be an obvious compaction candidate.

Similarly, an old critical user instruction may remain exact indefinitely.

Age affects compression eligibility; it does not determine importance by itself.

---

## It is not summary-of-summary recursion

A section should preferably be recompressed from its original raw JSONL source, not from its previous compressed representation.

Avoid:

```text
Raw event
  → summary
  → summary of that summary
  → smaller summary of the prior summary
```

Prefer:

```text
Raw event
  → compression level 1

Later:

Raw event
  → compression level 2

Later:

Raw event and related neighboring events
  → task episode
```

Previous compacted forms may be used as hints or caches, but they should not become the only available source.

---

## It does not depend on hidden chain-of-thought

The system preserves reasoning or thinking blocks only when they are actually present in Pi’s session data.

Reasoning that a closed API never exposes cannot be recovered or compacted.

The system must not claim to reconstruct unavailable private reasoning. It can preserve visible conclusions, explanations, tool choices, and evidence.

If a provider uses signed or provider-specific reasoning blocks, a modified retrospective summary must not masquerade as the original signed block. It should be labeled as retrospectively compressed assistant reasoning.

---

# The representation ladder

Every event or event group may have several candidate forms.

| Level          | Meaning                                                             |
| -------------- | ------------------------------------------------------------------- |
| **Raw**        | Original content exactly as stored                                  |
| **Normalized** | Lossless cleanup such as ANSI removal or canonical whitespace       |
| **Reduced**    | Programmatic structure-aware compaction                             |
| **Semantic**   | LLM-compressed representation of one section                        |
| **Merged**     | Multiple contiguous sections represented as one turn or episode     |
| **Marker**     | Small historical note plus source references                        |
| **Absent**     | Not included in active context; still available in JSONL and search |

A historical section can become progressively smaller over time:

```text
Raw tool output
    ↓
Losslessly cleaned output
    ↓
Structured tool-specific reduction
    ↓
Small result summary
    ↓
Merged completed-task episode
    ↓
Searchable historical marker
    ↓
Absent from active context
```

This progression is not required to happen on a fixed schedule. It occurs when context pressure, task state, or expected usefulness justifies it.

---

# Programmatic compression comes first

The system should not send every old section to an LLM.

Most high-volume coding-agent content has enough structure to support deterministic compression.

## Terminal output

Possible programmatic transformations include:

* Remove ANSI escape sequences
* Collapse carriage-return progress animation
* Deduplicate repeated lines
* Replace repeated adjacent lines with a count
* Preserve command, working directory, exit code, and duration
* Preserve warnings and errors
* Preserve the first useful stack trace
* Preserve pass/fail totals
* Preserve explicitly requested sections
* Keep the beginning and end when structure is unknown
* Identify output truncated by the original command
* Record omitted line and byte counts

An 8,000-line result might become:

```text
Command: npm test -- timeout.test.ts
Exit code: 1
Tests: 8 passed, 1 failed

Failure:
timeout.test.ts
expected activeRequests=1
received activeRequests=3

First relevant stack trace:
...

2,184 repeated status lines omitted.
7 passing-test sections omitted.
Full source: history_get("e122")
```

No LLM is required for that transformation.

---

## Test output

A test reducer should prioritize:

* Exact command
* Exit status
* Test framework
* Passed, failed, skipped, and total counts
* Failing test names
* Exact assertion differences
* Relevant stack frames
* Snapshot differences
* Warnings that materially affect the result
* Whether the same failure occurred repeatedly

Routine passing-test logs can be collapsed aggressively.

---

## File reads

A file-read reducer may preserve:

* File path
* Revision, hash, or historical timestamp when available
* Requested line range
* Function, class, or symbol boundaries
* Imports and definitions referenced later
* Exact relevant lines
* An indication that the current repository file may have changed

An old full-file read does not always need to remain in context because the current file can be read again. However, an old historical version may be important if subsequent edits changed it.

---

## Git diffs

A diff reducer may retain:

* Files changed
* Additions and deletions
* Function or symbol names
* Exact small critical hunks
* Deleted public interfaces
* Schema changes
* Test changes
* Binary or generated-file changes
* Commit or working-tree state

Large mechanical changes can be collapsed while preserving their effect.

---

## Grep and search output

A search reducer may preserve:

* Query
* Search scope
* Number of matches
* Files containing matches
* Exact lines that influenced later reasoning
* Representative examples
* Whether results were exhaustive or truncated

Repeated or irrelevant matches can be omitted.

---

## Structured API and JSON results

A reducer may preserve:

* Status and error objects
* IDs
* Cursors
* Timestamps
* Counts
* Fields referenced in later tool calls
* Changed values
* Outliers
* Relevant records

Large arrays can be summarized by count and selected exact entries.

---

## Assistant text and reasoning

Programmatic cleanup may remove:

* Repeated restatements
* Boilerplate acknowledgments
* Duplicate plans
* Superseded intermediate plans
* Preambles that add no information
* Repeated explanations already captured elsewhere

When semantic compression is necessary, a small LLM can reduce the individual block while preserving its role in the event sequence.

---

# The role of an LLM

LLM use is selective.

There are potentially three different jobs, and they should not be conflated.

## 1. Compression planning or classification

A small model may inspect the candidate context and assign a treatment and maximum length to each section.

For example:

```json
[
  {
    "source": "e120",
    "treatment": "exact",
    "maxTokens": 300
  },
  {
    "source": "e121:thinking:0",
    "treatment": "semantic",
    "maxTokens": 180
  },
  {
    "source": "e122",
    "treatment": "tool-reducer",
    "level": 2,
    "maxTokens": 500
  },
  {
    "from": "e130",
    "through": "e158",
    "treatment": "merge-episode",
    "maxTokens": 350
  }
]
```

The classifier is producing a **compression plan**, not a memory ledger.

Its classifications can be simple:

```text
EXACT
LIGHT
MEDIUM
HEAVY
MERGE
DROP
```

Additional flags can protect important details:

```text
preserve exact numbers
preserve exact command
preserve exact error
contains current unresolved work
contains user restriction
contains external resource identifier
safe because later evidence supersedes it
safe because result is reproducible
```

---

## 2. Semantic compression

A small model may summarize a specific reasoning or prose block when programmatic methods cannot reduce it adequately.

Its scope should be narrow:

```text
Compress this one reasoning block to at most 150 tokens.
Preserve the hypotheses considered, the conclusion reached, why the next
tool was selected, and any unresolved uncertainty.
Do not add facts.
```

This is safer and easier to validate than asking a model to rewrite an entire 120k-token session as one summary.

---

## 3. Optional retention hints from the primary model

Immediately before a major compaction, the primary model may be asked to identify what it is currently relying on.

For example:

```text
Before historical context is compacted, identify:
- Current unresolved work
- Older evidence you expect to need again
- Exact values or instructions that must survive
- Completed ranges that can be compressed aggressively
- Abandoned approaches that only need a brief historical record
```

This output is not the compacted context itself. It is advisory data used by the compression planner.

The feature may also be exposed as a tool the primary model can invoke when it recognizes a task boundary.

This is optional. Automatic compaction must still work when the model does not provide hints.

---

# Applying a global token budget

The compactor should be able to evaluate a large portion of the active context—or the entire active context—and assign different budgets to different sections.

The target may be something like:

```text
Current active context: 120k tokens
Desired post-compaction context: 20k–40k tokens
```

That does not imply compressing every section by the same ratio.

An illustrative allocation might be:

| Content                      |   Before |   After |
| ---------------------------- | -------: | ------: |
| User messages                |       7k |      5k |
| Assistant reasoning and text |      38k |      6k |
| Tool calls                   |       8k |      3k |
| Tool results                 |      64k |      4k |
| Other metadata               |       3k |      2k |
| **Total**                    | **120k** | **20k** |

The actual output should depend on what happened in the session.

A critical old instruction may remain exact. A recent but repetitive terminal result may shrink heavily.

The objective is not uniform compression. It is maximizing retained operational value within the target budget.

---

# Progressive grouping over very long sessions

Per-section compression is the first stage.

For sessions lasting days or weeks, even thousands of individually compressed events will eventually consume too much context. Older contiguous events may then be combined into larger chronological episodes.

The progression can be:

```text
Individual raw events
    ↓
Individually compressed events
    ↓
Compressed assistant turn
    ↓
Completed-task episode
    ↓
Historical marker
```

A task episode might look like:

```text
[TASK EPISODE e400–e447 — retrospectively merged]

Diagnosed refresh-token rotation. The first implementation invalidated the
old token too early and failed compatibility testing. Reordered rotation
so the replacement is persisted before invalidation. The authentication
suite then passed 42/42.

Files changed:
- src/auth/refresh.ts
- tests/auth/refresh.test.ts

Important evidence:
- Initial failure: “expected 200, received 401” [e418]
- Passing test run: [e444]

Full chronological sequence:
history_range("e400", "e447")
```

The episode remains in the chronological location occupied by entries `e400–e447`.

It is not moved into a separate memory document.

---

# Triggering compaction

Compaction should be batched rather than performed after every tool call.

Possible triggers include:

| Trigger                   | Intended effect                                                                  |
| ------------------------- | -------------------------------------------------------------------------------- |
| Context pressure          | Keep the active context below the operating target                               |
| Large compressible result | Reclaim substantial tokens from noisy historical output                          |
| Task completion           | Merge a completed sequence into an episode                                       |
| Task change               | Reduce the prior task before beginning a new one                                 |
| Major phase boundary      | Compact investigation before implementation, or implementation before validation |
| Primary-model request     | The model identifies a safe boundary                                             |
| Manual command            | User or operator explicitly requests compaction                                  |

Task-boundary detection can be heuristic or model-assisted. It does not need to be perfectly reliable.

A detected task change should be treated as permission to consider stronger compression, not permission to erase prior history.

The user should have independent controls for:

- the proactive compaction threshold;
- the retained raw-tail mode or size;
- the bounded dynamic-tail range;
- the active-context target;
- the replay target; and
- the regular Pi-summary target.

These controls should be persistent and validated. One `/chrono-compact-settings` command should open a real TUI settings screen with selection and numeric-input dialogs, Save, and Cancel. The user should not need to remember slash-command arguments. Changes should take effect without a Pi restart. Pi's built-in context-pressure trigger remains the final safeguard and cannot be disabled by the extension.

---

# Cache-aware operation

Compaction changes old prompt content and may invalidate provider prompt caches after the changed point.

Therefore, the system should compact in generations.

```text
Generation 1:
Frozen compacted prefix
Growing recent event stream

Generation 2:
One substantial batch compaction
New frozen compacted prefix
Growing recent event stream

Generation 3:
Another substantial batch compaction
New frozen compacted prefix
```

Between compactions, the rendered historical prefix should be byte-stable:

* Stable ordering
* Stable whitespace
* Stable labels
* Stable metadata order
* No dynamically changing timestamps
* No repeated reclassification on every request
* No opportunistic tiny edits to old compressed sections

The purpose is to incur one cache disruption, then reuse a smaller stable prefix across many primary-model calls.

The system should prefer a compaction that saves tens of thousands of tokens over frequent small rewrites that save little.

---

# Tool-call and message integrity

## Tool calls and results must remain logically paired

An old native tool call should not remain without an intelligible corresponding result.

Valid treatments include:

```text
Exact tool call + compressed tool result
```

or:

```text
One merged historical interaction representing both call and result
```

Do not preserve one side while making the other disappear without explanation.

---

## References between events must remain understandable

A compressed reasoning block may refer to evidence in an earlier tool result. The relevant part of that result must either remain visible or be explicitly referenced.

Avoid compacted text such as:

```text
This confirmed the earlier hypothesis.
```

when the earlier hypothesis and confirming evidence have both been removed.

Prefer:

```text
The output showed three simultaneous active requests, confirming that retry
attempts overlapped. Exact assertion: e124.
```

---

## Superseded information should remain historically accurate

Old information should not be rewritten to match what is known now.

If an early hypothesis was wrong, preserve that sequence:

```text
Initially suspected client timeout configuration.
Later tool output showed the server retry loop was responsible.
```

Do not retroactively alter the earlier event to make the model appear to have known the answer all along.

Historical compaction should reduce verbosity without falsifying the development of the investigation.

---

# Example of the intended transformation

## Raw event sequence

```text
[e120 USER]
Fix the timeout problem without changing the public API.

[e121 ASSISTANT REASONING]
1,240 tokens considering the request handler, client timeout settings,
reverse proxy configuration, retries, cancellation, and three test cases.

[e121 ASSISTANT TEXT]
I’ll inspect the request handler first.

[e121 TOOL CALL]
read(path="src/server/request-handler.ts")

[e122 TOOL RESULT]
8,040 tokens containing the entire file, dependency output, repeated lines,
and relevant retry-loop code.

[e123 ASSISTANT REASONING]
680 tokens analyzing the output and deciding to run a focused test.

[e123 TOOL CALL]
bash(command="npm test -- timeout.test.ts")

[e124 TOOL RESULT]
1,730 tokens of test framework output, eight passing tests, one failure,
warnings, and stack traces.
```

## Compacted chronological replay

```text
[e120 USER — exact]
Fix the timeout problem without changing the public API.

[e121 ASSISTANT REASONING — semantic compression, 1,240→170 tokens]
Considered the request handler, client timeout configuration, reverse proxy,
and retry behavior. Chose to inspect the handler first because the failure
occurred after the request reached the server. The main unresolved question
was whether retries overlapped or merely extended the total timeout.
Full source: history_get("e121", block=0)

[e121 ASSISTANT TEXT — exact]
I’ll inspect the request handler first.

[e121 TOOL CALL — exact]
read(path="src/server/request-handler.ts")

[e122 TOOL RESULT — programmatic reduction, 8,040→460 tokens]
File: src/server/request-handler.ts

Relevant functions:
- handleRequest(), lines 88–171
- retryRequest(), lines 203–279

Observed:
- Request timeout: 30 seconds
- Retry count: 3
- Each retry starts a new 30-second timeout
- Previous attempt is not cancelled before another begins

2,184 routine or repeated lines omitted.
Full source: history_get("e122")

[e123 ASSISTANT REASONING — semantic compression, 680→95 tokens]
Concluded that retry attempts may overlap because prior requests are not
cancelled. Selected the focused timeout test to verify whether multiple
requests remain active simultaneously.
Full source: history_get("e123", block=0)

[e123 TOOL CALL — exact]
bash(command="npm test -- timeout.test.ts")

[e124 TOOL RESULT — test reducer, 1,730→190 tokens]
Exit code: 1
Tests: 8 passed, 1 failed

Failure:
  timeout.test.ts
  expected activeRequests=1
  received activeRequests=3

Passing-test logs, routine framework output, and duplicate stack frames omitted.
Full source: history_get("e124")
```

This is the target behavior.

---

# Pi integration expectations

The implementation should treat Pi’s branch JSONL entries as the canonical source.

The compaction pipeline should conceptually perform:

```text
Load active branch entries
        ↓
Parse entries into typed blocks
        ↓
Generate candidate representations
        ↓
Assign treatment and token budgets
        ↓
Use deterministic reducers first
        ↓
Use small LLM calls only for semantic blocks that need them
        ↓
Optionally merge old contiguous events into episodes
        ↓
Validate chronology, references, and tool pairing
        ↓
Render stable compacted event replay
        ↓
Append newer raw events normally
```

An extension-only prototype may need to place the ordered replay inside one custom compaction message because of Pi’s existing compaction interface.

That is an implementation compromise, not the conceptual target.

The semantic target remains:

```text
ordered historical events with individual compression treatments
```

A deeper Pi integration could eventually represent compacted history as distinct reconstructed messages or typed compacted events.

---

# Internal metadata is allowed, but it is not the product

The implementation may maintain:

* A search index over the JSONL
* Compression versions
* Source entry ranges
* Original and compressed token counts
* Reducer names and versions
* Source hashes
* Cached candidate representations
* Classifier output
* Task-boundary annotations
* Retrieval references

This metadata may live in custom entries, a sidecar database, or another internal store.

It should not be confused with an agent-facing memory ledger.

The primary model-facing output is still the compacted chronological event stream.

---

# Validation requirements

A compaction should be rejected or repaired when it violates structural or factual guarantees.

At minimum, validation should check:

1. Every compressed event references valid source entries.
2. Event ordering matches the original branch.
3. Tool-call/result relationships remain valid.
4. Exact quotations attributed to a source actually occur in that source.
5. A programmatic reducer reports what it omitted.
6. A semantic summary does not introduce unsupported file names, IDs, commands, errors, or outcomes.
7. Current unresolved work is not described as completed.
8. Failed or abandoned attempts are not rewritten as successful.
9. User restrictions are not weakened through paraphrasing.
10. The final rendered context fits the target token budget.

The system should fall back to a less aggressive representation when validation is uncertain.

---

# Desired compression behavior by content type

| Content                                       | Default historical treatment                       |
| --------------------------------------------- | -------------------------------------------------- |
| User request                                  | Exact or light compression                         |
| User prohibition or correction                | Exact                                              |
| Small tool call                               | Exact                                              |
| Large tool-call arguments                     | Exact critical fields plus source reference        |
| Routine successful tool result                | Strong programmatic compression                    |
| Failure output                                | Preserve exact error and relevant evidence         |
| Assistant preamble                            | Light compression or omission                      |
| Assistant reasoning                           | Semantic compression when useful                   |
| Final response                                | Light compression                                  |
| Repeated file reads                           | Merge or retain only relevant observations         |
| Repeated test runs                            | Keep state transitions and significant differences |
| Completed task                                | Eventually merge into a chronological episode      |
| Abandoned exploration                         | Brief historical marker                            |
| Reproducible repository information           | Compress more aggressively                         |
| Irrecoverable external identifiers or outputs | Preserve exactly                                   |
| Very recent content                           | Strong bias toward raw or light compression        |

These are defaults, not rigid rules.

---

# Success criteria

A successful implementation should satisfy all of the following.

### Full-fidelity first exposure

The primary model sees new user and tool information in its original form before retrospective compaction changes the active-context copy.

### Immutable authoritative history

The raw JSONL remains complete and recoverable.

### Chronological continuity

The compacted context still communicates the order and causal development of the session.

### Per-section control

Different blocks in the same turn can receive different compression levels.

### Programmatic efficiency

Large structured outputs are usually compressed without an LLM call.

### Selective semantic compression

LLM calls are reserved for material that cannot be reduced adequately through deterministic logic.

### Progressive aging

Old events can move from raw, to reduced, to semantic, to merged episode, to searchable marker.

### Explicit loss

The model is told when information was omitted or transformed.

### Exact retrieval

The model can recover original entries by ID or search.

### Cache stability

Compactions occur in substantial batches, and the resulting prefix remains stable between compactions.

### No summary drift

Repeated compaction can return to raw source entries rather than indefinitely summarizing previous summaries.

### Large practical savings

A context containing approximately 100k–125k tokens of accumulated noisy history can often be reduced to approximately 20k–40k useful tokens, depending on the actual session, while preserving the information most likely to affect future work.

---

# Final definition

This project is a **retrospective, progressive, per-event context compactor for Pi**.

It lets the primary model operate on full-fidelity information while that information is new. Later, it replaces the active-context copy of each historical event with the smallest safe representation appropriate to its type, age, relevance, reproducibility, and role in the ongoing task.

It preserves the original JSONL, chronological order, causal structure, and exact recoverability. It uses deterministic tool-specific reducers wherever possible, selective LLM assistance where semantic judgment is necessary, and progressively stronger compression for older completed work.

The output is not a memory file and not one global summary. It is a **compressed replay of the session itself**.
