# Chrono compaction reference

Approved implementation baseline; implementation in progress · October 8, 2026

This reference specifies the proposed next Chrono compaction design. It explains the restart packet, source ranges, model calls, advance preparation, early summarization, parallel work, recovery, and integration with Context Kit. It is written for users, agents, and maintainers.

**Status:** The user approved this design for implementation and retained this reference as the official Chrono starting document. Implementation is in progress. Requirements describe the intended behavior, not a completed or activated runtime. Proposed mechanisms and open implementation choices remain labeled. No model-quality or latency experiment supports a performance claim here.

[Markdown](reference.md) is canonical. The matching [standalone HTML](reference.html) presents the same reference with section navigation and six diagrams. Both are maintained Chrono documentation in this repository. They are not official upstream Pi documentation. See the [maintenance instructions](README.md) for offline rendering.

## Overview

Chrono should reduce the context needed to continue work without replacing current intent with a historical reconstruction. The current conversational agent writes the task handoff and immediate continuation. Separate helpers describe bounded original history. Deterministic code owns source selection, order, budgets, and commit validation.

The design separates three concerns:

| Concern | Owner | Result |
| --- | --- | --- |
| What the agent is doing and what it should do next | Current conversational agent, supported by current Context Kit records | Fresh task handoff and continuation message |
| What happened in the current work interval | Original source events, deterministic reducers, and selected history helpers | Older-prefix synopsis, recent compressed history, and small exact tail |
| How to recover older evidence | Preserved source history and its recovery tools | Source-linked retrieval, optionally aided by independent full-interval archive summaries |

Compaction is a context replacement, not a new task, a task-completion signal, or permission to act. A successful replacement should lead to the next already-authorized useful action, not another round of avoidable project discovery.

### Confirmed design requirements

1. The main agent writes its own task handoff and continuation message.
2. History helpers receive only original work from the current compaction-to-compaction interval. They do not receive previous compaction packets or previous intervals as historical input.
3. The active interval synopsis covers only the older prefix before compressed history. The historical ranges do not overlap.
4. An optional full-interval archive summary uses the entire original A+B+C interval independently. It never blocks compaction.
5. Deterministic history reduction remains the baseline. A selected LLM may improve eligible individual event text, without deciding authorization or task completion.
6. One product-owned automatic policy replaces operational tuning menus. It adapts to actual model capabilities. User model/provider selection remains explicit.
7. Context Kit state changes may suggest coherent cuts. Early summarization and parallel execution should remove avoidable waiting.
8. Source history, unresolved work, resource identities, and user restrictions survive. Compaction does not authorize deletion or automatic rewind.

The exact budget constants, helper-failure policy, and emergency-recovery implementation remain open implementation choices within this baseline. See [Open decisions](#open-decisions).

## Terms and source boundaries

A **work interval** is the original work performed after one committed compaction and before the next. The initial interval begins with the first original work in the session. The user's session 1 and session 2 are work intervals in this reference. A physical Pi session file can contain several such intervals.

A **restart packet** is the derived context installed by compaction. A **cut** is a position in an ordered, identified source range. A **projection** is the effective view after applicable context omissions or replacements. A **closed prefix** is an already-written range with a pinned end, not a completed task.

For the current interval, define four positions:

| Position | Meaning |
| --- | --- |
| `S` | Start of eligible original work after the preceding committed compaction, or initial session origin |
| `H` | Start of recent compressed history |
| `R` | Start of the small exact raw tail |
| `E` | End position immediately after the last original event admitted to this compaction |

Use half-open ranges: `[S,H)` includes `S` and excludes `H`. On the selected source projection:

```text
A = [S,H)   older original work for the active interval synopsis
B = [H,R)   recent original work for compressed history
C = [R,E)   newest original work retained exactly

S <= H <= R <= E
A + B + C = the eligible original work in this interval
```

These are coverage ranges, not a promise that every event receives a sentence in a lossy synopsis or compressed rendering. Omission and unsupported-content notices remain explicit.

![Two work intervals, with earlier history excluded from the new interval helpers. The current interval is partitioned into A, B, and C. Its archive job independently reads original A+B+C.](assets/intervals.svg)

### No recursive previous-summary input

At the second compaction, an interval helper summarizes only the relevant original part of interval 2. It does not receive interval 1, the interval-1 synopsis, its compressed replay, its retained tail, or the previous task handoff as historical context.

The optional archive helper receives all original work in interval 2, including the original events whose other renderings appear in A, B, and C. It does not receive `synopsis(A) + compressed(B) + C` as a substitute.

The main agent is different. Its current context includes the previous restart packet, so it can preserve a still-valid task goal, restriction, decision, or unresolved obligation in its new handoff. That is current-state continuity, not recursive historical summarization.

This is a source-origin rule, not a ban on a new user message referring to earlier work. A new instruction is still a new instruction. Importing an older transcript or generated summary through a retrieval tool does not make that imported body new original work.

### Eligible input and exclusions

Input selection operates on source records and provenance, not on the position of text in an assembled prompt.

| Source material | Treatment |
| --- | --- |
| Current-interval user messages, assistant work, tool calls, and tool results | Eligible original evidence, subject to projection, privacy, modality, and complete-interaction rules |
| Normal system prompt, tool definitions, and applicable project instructions | Rebuilt as normal instructions, not summarized as interval history |
| Previous compaction packets and generated historical summaries | Excluded from helper history inputs |
| Compaction request, preparation instruction, summary submission, and commit bookkeeping | Retained for operation recovery, excluded from the original work interval |
| Retrieved prior transcript or prior generated-summary bodies | Preserve the retrieval action and source reference where useful. Do not import the older body into the interval helper |
| Context Kit full-state readbacks | Use typed identity, revision, and current-interval transitions for cut selection and A. The independent archive uses the eligible original readback as a snapshot observed in this interval, not as proof that every described action occurred in it |
| Failed or canceled ordinary work | Remains evidence of an attempt, with its outcome. Failure does not close the interval |
| Hidden or provider-internal reasoning, credentials, and unsupported private payloads | Not ordinary helper input. Keep disclosure and provider-specific replay rules separate |

"Original" means source content before Chrono's lossy compression. It does not mean ignoring a user's context edit, disclosure boundary, or applicable privacy restriction. An unavailable or excluded source part must be recorded, not silently replaced with an old summary.

## Restart packet

The proposed model-facing order is:

1. Normal system instructions, tool definitions, and applicable project instructions.
2. Current task handoff, written by the current agent.
3. Active interval synopsis of A.
4. Recent compressed history from B.
5. Small exact raw tail C.
6. Immediate continuation message, written by the current agent.
7. New work, including admitted new user or resource events.

![The restart packet presents normal instructions, current-agent handoff, A synopsis, B compressed history, exact C tail, and current-agent continuation before new authorized work.](assets/restart-packet.svg)

The handoff and continuation have different jobs. The handoff supplies durable working context. The continuation identifies the immediate next action and why it is next. They can be produced in one preparation response without two independent summaries.

The history layers carry source labels and coverage. They are evidence, not system instructions. The handoff is also fallible derived state. It does not override a newer user instruction, current native state, or the actual instruction hierarchy.

The ranges A, B, and C are disjoint. The handoff may mention a decisive event that also appears in history because the fact is necessary to continue. Avoiding historical range overlap does not require removing that useful explanation from current task state.

## Current-agent handoff and continuation

The normal writer is the current conversational agent with its currently available working context. A helper that receives older history must not reconstruct or invent the main agent's present intent.

Before the summary-only exchange, the agent should make necessary state updates and collect any essential fresh evidence. Preparation should stay short. It should not turn into a new research task, a broad cleanup, or a requirement to finish every outstanding job.

A handoff should contain only what the next useful action needs:

```markdown
## Task and purpose
Current goal, requested outcome, and why the selected approach fits.

## Constraints and authority
User restrictions, approval gates, and work that is not authorized.

## Current position
What is verified, what is in progress, and what is still uncertain.

## Decisions and useful locations
Relevant decisions, exact files, revisions, and source references.

## Outstanding work and resources
Task IDs, worker/run IDs, process/session identities, blockers, and waits.

## Next actions
The short sequence that continues the authorized task.
```

The separate continuation message is more immediate:

```text
Continue the existing task by collecting run <run-id>, then compare its
result with <artifact>. Do not restart the job. If the result is not ready,
continue <independent approved action>. Publication remains blocked.
```

Examples are descriptive templates, not live commands or approval. Do not include secrets in either field.

After the summary exchange starts, the current agent submits the handoff and continuation through the supported sole-submission protocol. It does not make unrelated tool calls, perform retrieval, or delegate more work between request and submission. Runtime-owned helper jobs can proceed independently without requiring the agent to violate that protocol.

## Choosing cuts

Legal source boundaries and token fit are separate questions. Code first identifies complete interaction units. It then selects a partition that fits the real request and preserves a useful recent window.

### Complete interaction units

The minimum tool unit is an assistant message containing tool calls plus all matching results. A parallel tool-call batch stays together. A result must not be selected without its call, and an exact-tail boundary must not split the batch.

A subsequent assistant interpretation can be associated with the unit when that improves coherence. The entire lifetime of a task or process is not one indivisible unit. A yielded process ID completes that invocation, not the process. Later polls are separate units linked to the same resource.

An incomplete batch cannot be labeled complete because a timeout elapsed. Its identity and incomplete state remain explicit. A required exact unit that does not fit needs the overflow contract, not silent truncation.

### Selection policy

The proposed selection order is:

1. Pin the current branch, interval origin, effective source projection, and admitted end `E`.
2. Determine legal complete-interaction cuts.
3. Select the newest required complete units for C within its exact-tail allowance.
4. Evaluate H candidates before or at R. Prefer coherent phase boundaries that preserve a useful B and fit the compressed rendering allowance.
5. Assign all remaining eligible older work to A.
6. Check the complete rebuilt request, not only the three history bodies.

When no useful phase signal exists, choose a legal token-fitting boundary. Turn counts and elapsed time can bound bookkeeping, but they are not the primary measure of content size. A context percentage indicates pressure. It does not identify a source cut.

A and B can be empty. An empty A needs no synopsis-model call. The exact-tail requirement is a product policy constrained by safe pairing and the full request budget, not a user-selected preset.

![Token fit and complete interaction units determine legal cuts. A successful Context Kit milestone transition can suggest H, but H must remain before or at the exact-tail start R.](assets/cuts.svg)

### Context Kit as a boundary signal

Context Kit helps the agent maintain explicit current state. It also supplies useful candidates for coherent cuts:

| Signal | How Chrono can use it | What it does not prove |
| --- | --- | --- |
| Workplan milestone completed, followed by another milestone starting | Prefer a cut after the successful transition when it is inside this interval and fits | That every external action or test succeeded independently of the recorded evidence |
| Todo completed, followed by a distinct next task | Suggest an action boundary | That the whole project is complete |
| Workplan checkpoint | Suggest a saved-position boundary | That a milestone or task completed |
| Notes update | Supply a weak contextual hint | Completion, permission, or a durable project decision |
| Workplan pause, blocker, or external wait | Suggest a coherent stopping point and preserve the wait | Permission to abandon or restart the work |

A Workplan checkpoint is a saved position. It does not have a completed-to-started lifecycle. Milestones and Todo tasks have status transitions. The cut selector should use successful typed transitions with their record IDs and revisions, not search arbitrary prose for the word "complete."

The successful tool result must exist before the transition becomes a candidate. A failed state mutation is not a cut signal. The candidate should normally sit after the complete mutation interaction and before the first action of the next phase.

A candidate inside the required exact tail cannot automatically become H. The partition must still satisfy `H <= R`. The selector can wait for more complete work to follow, choose another candidate, or choose a different permitted tail partition. It must not discard a required exact unit merely to honor a milestone marker.

State snapshots can contain facts from earlier intervals. Do not append those snapshots to A. Keep current state available to the main agent and use source-bound current-interval transitions as history metadata. This A-specific projection must not replace the eligible original readback in the independent full-interval archive input. In all helper inputs, exclude identifiable imported prior-compaction bodies and report the exclusion. Context Kit availability is helpful, not a mandatory dependency for basic compaction.

A typed, source-bound boundary adapter is proposed integration work. This reference does not claim that the current tools already expose every required event binding to Chrono.

## Early interval summarization

**The cut can be selected before compaction begins.** The future end E is not needed to summarize an already-closed prefix `[S,H)`.

The proposed normal path keeps one useful candidate prefix ready while the main agent continues work after H. This is a finite helper job over a pinned range, not a continuously running summary that rewrites itself after every event.

### Preparation and reuse

1. Observe a useful safe boundary, such as a successful milestone transition.
2. Pin H, the ordered original sources in `[S,H)`, their effective projection, and the helper derivation identity.
3. Start the active-prefix synopsis request using only those original sources.
4. Let the main agent append ordinary work after H. Event reducers may work on eligible recent units independently.
5. At compaction, choose E and R and revalidate H against source identity, branch ancestry, projection, model/prompt policy, and final fit.
6. Reuse the prepared synopsis only when its exact coverage and derivation remain compatible.

![A closed prefix S to H is summarized before compaction while the main agent works after H. Final validation accepts the same-range result or chooses an explicit replacement or degraded path.](assets/precompute.svg)

Appending after H does not change the source bytes of A. That alone does not invalidate its historical synopsis. A later correction in B or C remains later evidence. Label A as an account through H, preserve the correction in recent history, and have the handoff state the current conclusion. Do not silently rewrite A with later events or present its old conclusion as current truth.

A context edit inside A, changed ancestry, a removed source, or a changed permitted input projection invalidates the prepared derivation. A helper-model or prompt-policy change creates a new derivation identity. A main-model change requires new request fitting even if the history helper's source-local output remains compatible.

If H must advance to H2, generate the new synopsis from original `[S,H2)`. Do not feed `old synopsis + new delta` to the helper. The previous result may remain a valid candidate for its old range, but it cannot be relabeled as covering the larger range.

### Avoiding speculative work

Use bounded concurrency, coalesce superseded requests, and start a job only when a useful boundary has become stable enough to justify it. Do not launch a new full-prefix summary after every tool result. Schedule background work within explicit account, disclosure, and compute budgets.

During final preparation, prefer an already-ready candidate that fits and remains useful. If no ready candidate fits, choose a new legal cut and use the bounded foreground or degraded path. Do not keep an obsolete H merely to claim a cache hit.

Precomputation reduces possible waiting. It does not guarantee a ready result: the helper can be slow, unavailable, canceled, or invalidated by a source change. Exact scheduling constants and admission limits remain implementation decisions to verify later.

## Parallel execution and dependencies

Independent work should overlap. Dependent steps must still join before commit.

![Parallel lanes show main work, closed-prefix summarization, and optional event reduction before final preparation. At the frozen end E, handoff writing and history assembly overlap. Validation joins required products. The raw full-interval archive job is outside the commit path.](assets/parallel.svg)

| Work | Earliest valid start | Must wait for |
| --- | --- | --- |
| Closed-prefix A synopsis | H and its original source snapshot are pinned | Exact A inputs and helper admission, not the final E |
| Optional event rewrites | A selected original interaction is complete and eligible | Its source and minimum interpretation context |
| Main-agent handoff and continuation | Final preparation has admitted the current agent's request | Necessary state preparation and the correlated source cut |
| B rendering and C selection | Final E is pinned | Source projection, complete interactions, and policy budgets |
| Packet assembly and validation | Required products are available, or approved degraded substitutes are selected | Handoff, coverage, source bindings, and whole-request fit |
| Commit | Validation succeeds and the operation is still current | No stale branch/model/request boundary or canceled operation |
| Optional archive summary | The full interval source range is pinned | Original A+B+C and separate helper admission, never commit waiting on it |

For the simplest first implementation, queue the optional archive after the interval has a confirmed commit identity. It can also prepare from an immutable final snapshot if its result remains tied to a successful correlated commit. Either way, it must not consume a required compaction slot or delay the main agent's continuation.

The final pause is determined by unfinished dependent work, not the sum of every job's duration. A ready A synopsis and ready event alternatives should not be regenerated in sequence after the handoff. Conversely, parallel calls do not remove shared provider rate limits or local resource contention.

Helper concurrency is finite. Cancellation means requested cancellation until the provider or worker settles. Do not free a resource slot or start replacement work merely because cancellation was signaled.

## When compaction starts

The product owns one automatic policy. It should consider actual request headroom, recent growth, preparation needs, and a useful agent-selected boundary. It should not expose a menu of token targets, trigger percentages, tail presets, and worker-timing knobs as the normal user interface.

There are three entry conditions:

- **Agent request:** The current agent selects a safe point during already-authorized work.
- **Automatic pressure:** The system gives advance notice while enough room remains for short preparation and the handoff exchange.
- **Recovery:** An admitted request cannot proceed safely or the provider reports a relevant size failure. Use the bounded recovery contract, not another arbitrary percentage increase.

A phase boundary can prepare H without starting compaction. A completed milestone is not itself an instruction to compact. The policy can reuse its prepared prefix later.

Advance notice should state that compaction is approaching, what short preparation is needed, and whether jobs can remain outstanding. Do not ask the agent to finish the entire task. Long-running jobs can remain when exact resource identities, state, and next actions survive the handoff.

Preparation cannot continue indefinitely. A final freeze sets E and protects the summary exchange. New user messages and resource events follow the normal queue and freshness rules. They must not be silently inserted into a frozen helper range or lost between preparation and continuation.

## Request budgets and media

Every model call has its own real input and output constraints. A large main-model window does not make a smaller helper capable of reading the same interval. Advertised provider capacity, local registry declarations, and the effective selected connection can differ.

The complete restart request includes:

```text
normal system and applicable instructions
+ active tool schemas and provider framing
+ task handoff and continuation
+ A synopsis, B rendering, and exact C
+ output and reasoning allowance where applicable
+ safety allowance
```

The preparation request also needs room for its control text and summary response. The early-warning policy needs an allowance for plausible intervening growth. A single global "context percentage" cannot replace these checks.

Use output caps accepted by the selected provider API. An output reserve is an accounting allowance, not proof that a provider enforces the same limit. Invalid or missing capability data needs a specific diagnostic, not a misleading "almost full" claim.

### Separate tokens from transport bytes

JSON bytes, base64 characters, text tokens, and image-token charges are different measurements. A screenshot can have a large encoded body without consuming the same number of model tokens as that many text characters.

Use known provider/media accounting for validated supported fields. Charge each new image or other modality conservatively. Do not treat it as free because an earlier text request had a usage receipt. Keep transport-size limits separate from context-token limits. Preserve charges for text, tools, framing, unknown fields, and late request transformations.

Do not change or remove an outgoing image merely to make an estimate fit. Unsupported media or unknown capabilities can require an explicit refusal. A fixed native image estimate is not independent proof of the remote backend's actual cost.

A read-only investigation of a reported low-percentage refusal found a source-supported mismatch between a native image estimate and raw serialized base64 accounting. The exact live refusal phase and loaded closure were not measured. This motivates the accounting requirement; it is not a repaired or universally diagnosed failure. See [Evidence and references](#evidence-and-references).

### Adaptive internal policy

Allocate layer budgets from the usable request capacity after required overhead and reserves. Prefer a small useful exact suffix and a recent coherent compressed window. Fit the handoff and historical synopsis within the remaining allowance without silently dropping current restrictions.

Do not establish numerical defaults by copying existing settings or the examples in Pi's documentation. Select and verify internal constants against the required behavior. Expose the resulting budget breakdown as read-only diagnostics.

## Active interval synopsis

The active synopsis answers: **What happened in the older part of this work interval?** It does not answer: **What is the main agent's entire current task?**

Its only historical input is original A. Supply speaker roles, source references, tool relationships, observed outcomes, and coverage limits. Present history as quoted data, not as instructions for the helper to execute. The helper has no action-taking tools.

The output should be concise and source-bound:

```markdown
## Interval coverage
Original current-interval work from <S> up to, but not including, <H>.
Excluded or unavailable material: <explicit coverage notice>.

## Changes and results
Actions, observations, artifacts, and results supported within this range.

## Decisions and corrections in this range
Source-bound decisions, reversals, and remaining disagreements.

## Unresolved at the end of this range
Open items as of H, not a claim about their status after H.

## Source references
Useful exact recovery anchors.
```

Code validates the coverage and references. The model must distinguish an assistant's report from an observed tool result and distinguish an attempted action from a confirmed outcome. Structural validity does not prove semantic fidelity.

The synopsis is restart-only. Do not index it as a complete-interval memory entry. Retaining it in the native compaction record for operation recovery is different from publishing it into a historical-summary retrieval collection.

If A is too large for the selected helper, do not silently head-truncate it or substitute prior summaries. Options include another user-selected capable route or bounded disjoint original-source parts with explicit coverage. A parts-based implementation must label the composite output and avoid a hidden recursive summary chain. Its exact format remains an open implementation choice.

## Compressed history and event helpers

B preserves recent chronology at lower cost than exact messages. Keep speaker identity, action/result relationships, exact useful identifiers, errors and qualifications, omission notices, and source recovery links. Code owns ordering and source selection.

Apply deterministic reducers first. Tool-specific reduction often preserves useful structure better than a generic rewrite. Do not ask an LLM to rewrite every event merely because a helper model is available.

### Optional selective rewriting

A helper can produce an alternative text for an eligible noisy or unstructured event. Its input is that original event plus the minimum related call/outcome context needed to interpret it. Context supplied only for interpretation is not permission to summarize a different source range in the event's output.

Several events may be batched into one request. Each result remains individually mapped to its original event. The helper is a text reducer, not a judge of whether evidence can be deleted, whether a task is complete, or whether permission exists.

Keep user directives, protected exact evidence, and the raw tail outside optional rewriting. Code supplies IDs, ordering, outcome metadata, and recovery routes. Protected spans and output-size checks can reject malformed candidates. They cannot prove that every meaning was retained.

Cache compatible accepted alternatives by source, projection, model, prompt, and reducer identity. Do not rewrite a model rewrite. At final assembly, use a ready compatible alternative or the deterministic version. Slow, failed, stale, or unavailable optional work must not block compaction or trigger a silent paid-provider substitution.

Once committed, the packet's rendered bytes stay fixed. A late event result can become available for a later eligible use. It must not rewrite the already-installed context prefix.

## Exact raw tail

C preserves a small newest suffix without semantic rewriting. Its purpose is to retain recent wording and complete interactions that the agent is about to use.

"Exact" refers to the effective source content and supported message conversion, not an assertion that provider JSON serialization equals the stored source bytes. Source recovery remains available for the original record.

Do not truncate a tool result and still call that result exact. Do not split a tool batch to fit a nominal tail size. A required unit that exceeds the available request capacity must enter the explicit oversized-unit or recovery path.

The original source interval ends before generated compaction/control exchanges. Native Pi may still need a technical retained boundary to correlate the summary submission and commit. That adapter detail must remain outside the original A/B/C history model and must not reintroduce an old packet as new work.

## Optional full-interval archive summary

The archive feature is separate from the active synopsis. If included, it provides a source-linked account of one complete work interval for later retrieval.

Its input is original `[S,E)`: all original A, all original B, and all original C. Do not feed it the active A synopsis, compressed B alternatives, previous handoffs, or previous interval summaries. Do not include system/tool definitions or generated compaction packets and control exchanges.

The job is independent and non-blocking. It may be queued, running, ready, incomplete, failed, or unavailable while the main agent continues normally. None of those states changes whether the compaction commit succeeded.

"Full interval" means full eligible input coverage. It does not mean lossless output or completed work. If a model or extraction limit prevents coverage, label the result partial. Do not advertise an ordinary head-truncated input as a full-interval summary.

For large intervals, stream source selection and use bounded original-source parts if needed. Do not solve size pressure by substituting previously generated summaries. Unsupported multimodal content needs explicit source references and coverage notices or a separately approved capable model route. Base64 text is not an image interpretation.

Preserve source links and interval identity. Keep retrieval summaries distinct from accepted Memory knowledge. They do not acquire current authority by being indexed. The existing source archive remains the recovery basis when a summary is missing, incomplete, or wrong.

This document does not introduce source deletion, a new global archive-retention policy, or mandatory model calls for every interval. Those decisions remain separate.

## Models and connection choices

The design is connection-neutral. A user may select a local model, a hosted API model, or a cheaper model available through an existing supported subscription.

| Logical role | Default responsibility | Call pattern |
| --- | --- | --- |
| Current-agent writer | Current conversational model | One preparation response containing handoff and continuation |
| Active-prefix writer | Selected capable history helper | One request per chosen prefix when it fits, with bounded retry or explicit parts if required |
| Optional event writer | Selected economical helper, possibly the same one | Finite selected-event batches, not one mandatory call for every event |
| Optional archive writer | Selected capable helper, possibly the same one | Independent job over the entire original interval |

Four roles do not require four models or services. There is no mandatory frontier-model final verifier. Code performs source, schema, pairing, and budget checks. A stronger model cannot certify completeness, recover unseen evidence, or create authorization.

### Candidate families, not selected models

Official provider documentation inspected on October 8, 2026 describes the following text-generation candidates:

| Candidate | Documented API capacity | Proposed use and limit |
| --- | --- | --- |
| `gemini-3.5-flash-lite` | 1,048,576 input tokens and 65,536 output tokens | Low-cost event/interval candidate. Actual Pi route and task quality unverified |
| `claude-haiku-5-5` | 1M context and 128K synchronous output tokens | High-volume helper candidate. Usable input capacity and account route need verification |
| `gpt-6-luna` | 1,050,000 context, 922,000 maximum input, 128,000 maximum output | Economical generative API candidate. Do not confuse it with Pi's classifier-only Decisions route |

These are documented provider limits, not benchmark results, local availability, or recommended request sizes. A more capable selected helper can be used when fidelity requires it. No named local model or hardware fit was evaluated in this study.

Keep these checks separate:

1. The model can generate the needed text and accept the actual input type.
2. The installed Pi provider adapter exposes the required API and output controls.
3. The selected account is authenticated and entitled to use that model on that route.
4. The user permits that source material to reach the selected inference destination.
5. A later bounded evaluation establishes acceptable fidelity, latency, and failure behavior.

Subscription login does not automatically grant API entitlement. A helper process running locally can still send data to a remote provider. A local model avoids some provider billing but still uses memory, compute, and time.

Do not silently change provider or model after failure. Structured outputs help constrain shape, not truth. Privacy, retention terms, quotas, and actual effective capacity must be checked before a new route is used.

## Commit, cancellation, and continuation

Treat preparation, validation, source replacement, and resumed work as distinct states. A returned summary is not proof that compaction committed.

![The lifecycle moves from prepared products through validation to a correlated commit and authorized continuation. Stale, failed, or canceled work preserves the old context and enters bounded recovery rather than automatic rewind or an unbounded retry loop.](assets/commit.svg)

The proposed normal sequence is:

1. Save necessary current state and retain exact outstanding resource identities.
2. Freeze the operation's branch, source end, model, relevant policy, and preparation ticket.
3. Obtain the main-agent handoff and continuation while independent history work finishes or uses ready results.
4. Assemble the packet with its coverage and provenance manifest.
5. Validate source identity, projection, non-overlap, tool pairing, required content, output bounds, and the whole request.
6. Recheck cancellation, branch/model changes, relevant new input, and operation freshness.
7. Commit one correlated replacement and record the resulting source identity.
8. Schedule only the continuation of work that is still authorized and unfinished.
9. Admit subsequent user/resource events under the normal queue order. Start optional archive work separately.

A stale result is not repaired by attaching it to the current branch. A failed or canceled attempt preserves the last valid context and source. Do not automatically rewind or repeat side-effecting operations.

The continuation record should identify the commit and intended next action. It should suppress duplicate local scheduling. Across a crash or uncertain delivery, reconcile the saved commit and current resource state before retrying. Do not claim that a written record proves exactly-once execution.

A user cancellation, completed task, changed branch, or new blocking instruction can prevent automatic continuation. Waiting on a real external condition is also valid. Merely saving a continuation sentence and then going idle while authorized work is ready is not successful recovery.

## Failure and emergency recovery

Ordinary context growth should not remove every path to a smaller working context. Early warning helps, but it cannot guarantee fit after an arbitrarily large result or a provider failure.

The following are proposed failure behaviors, not implemented promises:

| Condition | Proposed behavior |
| --- | --- |
| Optional event helper is missing, slow, or invalid | Use deterministic B text |
| Optional archive job fails | Keep source recovery available and report archive unavailability. Do not delay the main agent |
| Prepared A synopsis has the wrong range or derivation | Reject reuse. Select a valid candidate or use a bounded replacement/degraded path |
| Active synopsis helper is unavailable | Use an explicit, labeled deterministic A fallback under a finite policy, rather than wait indefinitely |
| Source, branch, model, or relevant projection changes before commit | Revalidate or abandon the stale attempt. Preserve the last valid context |
| Normal current-agent handoff cannot be admitted | Enter the separately bounded emergency path. Do not merely lower guards |
| Required exact unit or required state cannot fit | Report the specific bound and use the explicit oversized-input recovery contract |
| Provider, storage, or capability information is unavailable | Stop the dependent unsafe action with a precise reason. Do not infer permission to change providers or delete data |

### Proposed emergency contract

The normal path remains same-agent authorship. Emergency recovery needs a separately admitted, bounded input that does not depend on sending the already-unadmittable full ordinary context again.

A candidate design uses the latest valid current-state checkpoint, identified unresolved tasks/resources, protected recent user constraints, and exact source recovery routes. If a fresh main-agent handoff is unavailable, the result must say so. A deterministic recovery header or a separately generated recovery account must not pretend that the main agent just wrote its intended continuation.

Recovered state has an as-of boundary. The resumed main agent verifies necessary freshness before consequential work. A stale checkpoint cannot erase a newer restriction or authorize a task that is no longer active.

The recovery input format, handling of oversized protected material, and exact permitted model role remain open decisions. Their acceptance must preserve source correlation, cancellation, expiry, one operation's commit, and authorized-only continuation. This document does not approve weaker guards, automatic rewind, unbounded retries, or a silent frontier-model fallback.

No software design can guarantee successful provider calls, storage writes, or safe continuation during every outage. The requirement is to avoid preventable dead ends from ordinary context growth and to give a precise recoverable state when a dependency is genuinely unavailable.

## Persistence and source identity

Reuse must be based on exact inputs, not a title such as "session summary." Bind every prepared or committed artifact to its sources and derivation.

The following is a conceptual record shape, not an implemented TypeScript API:

```typescript
interface CompactionDraft {
  operationId: string;
  source: {
    logicalSession: string;
    branch: string;
    previousCommit: string | null;
    start: SourcePosition;             // S
    compressedStart: SourcePosition;   // H
    rawStart: SourcePosition;          // R
    endExclusive: SourcePosition;      // E
    orderedInputHash: string;
    projectionHash: string;
  };
  handoff: ArtifactRef;
  continuation: ArtifactRef;
  activeSynopsis: ArtifactRef | null;
  compressedHistory: ArtifactRef;
  exactTail: SourceRange;
  policyIdentity: string;
  modelIdentities: ModelBinding[];
  nativeStateReferences: StateReference[];
  coverage: CoverageNotice[];
  requestBudget: BudgetBreakdown;
  state: "prepared" | "validated" | "committed" | "abandoned";
}
```

`SourcePosition`, `ArtifactRef`, and other names stand for source-bound records to be defined during implementation. They are not new tools or settings. A source position needs session/shard/branch association and stable entry or span identity. A timestamp or prompt-array index alone is insufficient.

| Artifact | Reuse conditions |
| --- | --- |
| Deterministic event reduction | Original source and projection, reducer version, schema, and output policy match |
| Model-written event alternative | Event reduction bindings plus helper model, prompt, generation settings, and disclosure projection match |
| Early A synopsis | Exact S/H range, ancestry, ordered input hash, projection, helper derivation, and coverage match |
| Current-agent handoff | Bound to its own preparation operation and state cut. Do not use it as an arbitrary generic history cache |
| Committed restart packet | Source cut, compiler policy, handoff identity, and whole-request validation are recorded. Rendered bytes remain fixed |
| Optional archive summary | Exact full interval, complete/partial coverage, original-source bindings, helper derivation, and committed interval association match |

Source edits invalidate affected derivations. Appending unrelated later work need not invalidate an immutable source-local result. Native state changes can alter relevance or current task state without rewriting historical source facts.

Keep the original archive and required source maps. Compaction does not shrink or delete the transcript. Context size, per-job memory, total archive storage, and model-server memory are separate limits.

## Branches, restoration, and native state

A branch change requires a new source-selection validation. Do not take the most recent compaction from a different branch or physical file merely because its timestamp is newer. Reuse only artifacts whose ancestry and source association match.

A restored branch can recover its own interval origin and committed packet. A branch summary, if present, remains a distinct generated artifact. It must not silently become original current-interval evidence. Physical rollover needs explicit links to retained source shards, not a reset that loses the logical interval.

Workplan, Todo, and Notes remain their own current-state owners. Chrono does not mirror all their bodies into a second store or infer authority from them. It records useful IDs and revisions and lets the current agent recover the necessary records.

A fresh handoff should usually avoid forcing the agent to rediscover everything through those tools. Native recovery remains available when the handoff is incomplete, the task changed, or a freshness check is necessary. Required verification is not a compaction failure.

## User interface and diagnostics

The ordinary interface should expose behavior and status, not require budget tuning.

Proposed user-facing controls are the supported compaction action, automatic status, and explicit model-role selection where needed. Optional feature inclusion and privacy/cost consent must be settled before implementation. They should not become a hidden permission to make new provider calls.

Useful read-only status includes:

- Active source interval and the reasons for candidate H and R.
- Whether A is absent, queued, running, ready, stale, or using a degraded substitute.
- Which original source range a synopsis actually covers.
- Readiness of optional event alternatives and archive work.
- Main-model and helper-model identities, with unavailable capability data marked unknown.
- System, schemas, history layers, media, framing, preparation, and output budget charges.
- The refusal phase and specific reason, not only "no headroom."
- Whether a summary was submitted, validated, committed, and followed by authorized continuation.

Diagnostics should be content-free by default. Do not log raw prompts, image bodies, credentials, or private task prose merely to explain token accounting.

Existing legacy settings need an explicit migration map. Inactive V3/compatibility controls must not appear to govern the proposed path. Preserve unrelated settings and rollback assets. Do not use a broad reset to install the new policy or silently enable an old compactor as a fallback.

## Relationship to Pi and current Chrono

This is a new design, not a description of every currently installed path.

| Subject | Documented or inspected baseline | Proposed design |
| --- | --- | --- |
| Native Pi summary input | Native Pi can pass the previous summary as iterative context and summarize from its prior kept boundary | History helpers receive only current-interval originals. The main agent alone carries current task state forward |
| Native Pi split span | Pi can summarize a split user-message prefix separately and merge summaries | Explicit A/B/C coverage and complete interaction units. No implicit old-summary merge |
| Normal Chrono V4 writer | Inspected V4 asks the same session agent for a continuation summary | Preserve same-agent authorship, separate task handoff from immediate continuation, add explicit history roles |
| Chrono recent replay | Inspected V4 has bounded deterministic source excerpts and a minimal native exact boundary | Coherent compressed B plus a deliberately selected small exact C |
| Active A synopsis | No separate active A-only synopsis contract found in the inspected V4 path | New original-prefix helper, eligible for early preparation |
| Existing optional value advice | Compatibility-oriented typed advice, not V4 event prose | Optional source-linked event text alternatives with a separate contract |
| Full-interval archive summary | Not established by merely saving the current compaction record | Separate optional original A+B+C job, never a compaction dependency |
| Native Context Kit state | Independent current-state providers | Preserve ownership and use typed current-interval transitions as cut hints |

Pi's extension compaction hooks and persisted entries are integration points, not permission to assume that every required behavior can be added through one hook. The implementation must verify the actual installed SDK, provider adapter, context projection, submission protocol, and commit lifecycle together.

In particular, do not reuse a convenience serialization function that silently head-truncates tool results while claiming the archive helper received full raw input. The inspected Pi reference documents a 2,000-character tool-result serialization limit. This design needs explicit coverage instead.

The source studies inspected Chrono revision `07f36c7d` and scoped selected 4.0.16 files. The installed Pi documentation was version 1.1.0. Selected files, a loaded process, and exercised behavior are separate evidence. No current source observation proves that this proposal is active.

## Acceptance and practical verification

The goal is correct useful continuation, not the shortest or most fluent summary.

A later approved evaluation should measure time, actions, and tokens from commit to the first correct task-advancing action. Measure compaction waiting separately. Distinguish necessary resource/freshness checks from avoidable project rediscovery. Check whether the intended next action continued or changed for a valid new reason.

Focused acceptance scenarios should cover:

| Scenario | Required result |
| --- | --- |
| Two successive work intervals | Interval-2 helper inputs contain no interval-1 source or prior packet |
| Main task spans both intervals | Fresh handoff preserves valid older restrictions and unresolved work |
| Complete milestone transition | It can suggest H without splitting the mutation's call/result interaction |
| Checkpoint without completed work | It is treated as a position hint, not completion |
| Ready early synopsis, later appended work | Same-range A can be reused. B/C contain later work without overlap |
| Source edit or branch change | Incompatible prepared results are rejected, not relabeled |
| Failed optional event or archive helper | Main compaction continues through its defined fallback and original recovery remains available |
| Large image or other supported media | Transport bytes and model-context charges are separate, nonzero, and provider-aware |
| Oversized required interaction | No fake exactness or split pair. Enter the defined recovery path |
| Outstanding process or subagent | Exact identity and next action survive. The resource is not restarted because of compaction |
| Commit succeeds with ready authorized work | The agent actually continues. A saved continuation sentence alone is insufficient |
| New cancellation or restriction | It prevents conflicting continuation even if preparation was already complete |

These are acceptance requirements, not a test suite already written or run. Use a small representative practical exercise first. Additional model evaluation or extensive coded testing requires its own bounded approval. Do not claim semantic fidelity from schema checks alone.

## Open decisions

The following choices remain visible for review rather than being hidden behind a supposedly final specification:

1. **Emergency recovery:** Select the bounded recovery input, authorship label, freshness rules, and oversized protected-content behavior. The normal same-agent writer is already settled.
2. **Active synopsis failure:** Confirm the proposed labeled deterministic A fallback, its minimum useful evidence, and the finite waiting policy.
3. **Large helper inputs:** Define the disjoint-original-part output format, if needed. Do not introduce recursive prior-summary merging to make inputs fit.
4. **Optional features:** Decide whether selective event rewriting and full-interval archival summarization ship initially or remain later additions. Their input and non-blocking contracts are already defined.
5. **Concrete model selection:** Choose available authorized provider/model routes and a small later fidelity check. The candidate table is not an account entitlement check.
6. **Internal budgets and scheduling:** Verify layer allocation, advance-notice lead, coalescing, call limits, and resource admission against real capabilities. Do not expose provisional constants as permanent user tuning controls.
7. **Native integration:** Define typed Context Kit boundary bindings, branch/rollover association, immutable source snapshots, adapter behavior, and a correlated continuation record against the supported SDK.

Implementation proceeds from this approved baseline. Resolve the open choices without changing its source, authority, and recovery requirements. Additional model evaluation or extensive coded testing still needs its own bounded approval. Design approval and documentation promotion do not establish publication, loaded activation, or practical verification.

## Evidence and references

The design requirements come from the approved user discussion. Proposed mechanisms and open implementation choices are labeled throughout. The sources below support baseline behavior and model facts, not the fidelity, latency, or activation of the new design.

### Pi reference and repository baseline

- [Pi compaction reference](https://pi.dev/docs/latest/compaction): reference structure, native summary reuse, cuts, hooks, persisted entries, and serialization behavior. The baseline study read the Pi 1.1.0 documentation. The latest public page can change.
- [Existing session-agent compaction contract](../context/session-agent-compaction.md): revision-bound same-agent summary, replay, recovery, and continuation behavior. This is the retained runtime baseline, not the new A/B/C design.
- [Existing compaction and budget reference](../context/compaction-and-budgets.md): compiler limits and estimated request accounting.
- [History indexing and exact recovery](../history/indexing-and-exact-recovery.md): preserved source and retrieval boundaries, not a full-interval archive-summary implementation.
- [Existing menu and configuration](../operations/menu-and-configuration.md): retained settings and mode-specific controls. These controls do not all govern V4 or the approved new path.
- [Implementation and evidence boundary](../design/evidence-and-roadmap.md): revision-bound checks, selection, activation, and quality limits.
- [Chrono request accounting source](../../../packages/pi-chrono-compaction/src/context-budget.ts) and [extension integration source](../../../packages/pi-chrono-compaction/src/pi-extension.ts): inspect the checked-out revision before making a current behavior claim.

The private source studies and incident evidence are not bundled. These repository routes identify baseline contracts and source, not replacements for private incident receipts. The media-accounting investigation did not measure the final live request or target-loaded closure and established no repair. Earlier cross-compaction-window alternatives are superseded by this baseline's current-interval rule. Earlier helper-role alternatives are not additional requirements.

Other source locations include `packages/pi-chrono-compaction/src/{session-agent-summary,context-compiler,chronological-replay,tail-selection}.ts`. Context Kit owns its native tool contracts separately. Consult the actual selected source and nearest project instructions before implementation.

### Official model documentation

- [Gemini 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite).
- [Claude Haiku 5.5](https://platform.claude.com/docs/en/models/haiku-5-5/overview).
- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna).

Provider documentation was inspected on October 8, 2026, America/Los_Angeles. No model calls, benchmarks, credential reads, or account selection were performed for that study. Private candidate notes are not bundled. The table preserves that dated documentation evidence and its Pi-route, subscription, and quality limits. It does not attest current availability or account entitlement.
