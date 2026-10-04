---
title: Compaction and context budgets
audience: [agents, maintainers]
status: current reference
purpose: Explain the selected compaction paths, frozen V4 input, receipts, estimation, and safe refusal.
related:
  - retention-and-projections.md
  - recall.md
  - ../operations/menu-and-configuration.md
---

# Compaction and context budgets

V4 follows the implemented [session-agent compaction contract](session-agent-compaction.md): a required same-session continuation summary, compressed chronological evidence, and only the necessary exact tail. Native cards remain in the receipt, not a second model-facing state dump. Source implementation, preview evidence, and loaded activation are separate claims.

## Public Pi integration

Pi requests compaction through `session_before_compact`. Chrono returns custom context through that public hook. It does not patch private AgentSession methods or create a second compactor.

Pi still owns context-pressure and overflow handling. A separate Chrono proactive threshold can request earlier compaction. In V4, `request_compaction({})` returns a same-session summary request. Submit its request ID and summary as the sole tool call, then stop starting new operations. Acceptance is not a completed compaction; source validation and safe-idle settlement must still succeed. Save useful project state before requesting it. Use the [checkpoint-first transition policy](session-agent-compaction.md#meaningful-task-transitions) for meaningful direction changes, not every milestone or checkpoint.

## Selected paths

| Path | Inputs and result |
| --- | --- |
| V3 programmatic memory | Bounded compatible historical selection, a small adaptive raw tail, and optionally an independent regular Pi summary. |
| V4, selected by `contextCompiler: "v4"` | Required same-session summary plus bounded chronological replay and the necessary exact tail, complete estimated request charges, and a persisted receipt. Native cards are receipt-only evidence. |
| Compatibility replay | Retained older candidate reconstruction, separate replay limits, and optional value advice. It is not a hidden V3/V4 failure fallback. |

V3 remains the compiled default. The local integration intends explicit V4 selection. Check [evidence and selection](../design/evidence-and-roadmap.md), not the package version alone.

## V4 capture and compilation

1. Obtain the session agent's summary through its normal request path. Bind the request and sole submission to the session, consumed source boundary, model, epoch, and expiry. Do not use a separate summarizer or stale summary fallback.
2. At safe idle, settle the persisted submission result and verify the minimal retained boundary. Keep only content not consumed by the summary-producing request and any messages required for valid tool pairs. Capture the full native session/leaf, replay cut, model metadata, system prompt, active schemas, response reserve, settings, and lifecycle identity.
3. Collect bounded native pages through the same pure collector used by Recall. The compiler does not invoke native tools or read provider stores directly. Capture allows up to 16 cards and 128 scanned records per provider, 16 KiB provider replies, a 32 KiB combined collection, and a 150 ms common wait. These pages remain in the receipt and do not automatically supply facts to the summary writer.
4. Capture bounded chronological events from the loaded branch with applicable Pi context edits and saved relevance hints. Keep original roles, source order, omission notices, and exact recovery IDs.
5. Detach and freeze admitted inputs. Charge the continuation summary and exact tail first, then fit replay within its adaptive allowance and hard ceiling. The current compiler requires both the summary and event replay; old stored/fallback input forms do not substitute for them.
6. Charge the complete rendered result. Revalidate scope, settings, model, active schemas, cancellation, and source boundary before returning.
7. Persist `details.contextReceipt` with the actual Pi compaction entry. Correlate `session_compact` or `session_compact_failed` with the pending attempt.

Replay reduces optional detail before omitting useful events. It does not promise whole-record retention or semantic completeness. Native rendered tokens remain zero. Saved state, summaries, and relevance hints are fallible context, not new permission. See the [adaptive replay policy](session-agent-compaction.md#adaptive-replay-selection) for selection and omission rules.

## Budgets

The default `targetContextTokens` is 32,000. The configurable range is 8,000–250,000. The effective ceiling is lower when model headroom requires it.

For V4, the estimated request includes:

- System text and the complete active tool-schema JSON.
- Message and transport framing allowances.
- The rendered compaction summary, including notices and recovery references.
- Complete raw-tail messages, including images and tool-result bodies as estimated by Pi.
- The response reserve supplied by Pi's preparation.

The estimator is named `pi-message-estimator-and-utf16-ceil-div4-v1`. It combines Pi message estimates with text-length estimates. It is not the selected model's exact tokenizer. Later payload extensions and provider serialization can change the final request.

V3 accounts for its combined summary/tail ceiling with system text, a Chrono reserve, and response reserve. V4 adds explicit active-schema and request-framing accounting. Do not apply the V4 receipt's accounting claim retroactively to older compositions.

V3's adaptive recent tail normally aims for 3,000–6,000 estimated tokens and examines at most 256 suffix entries. V4 instead retains the verified necessary suffix after the summary exchange; it does not reserve thousands of tokens merely to meet an old tail preset. Both paths must preserve valid tool structure and refuse an unsafe or over-budget boundary.

Separate finite bounds remain: V4 input is at most 1 MiB and its receipt at most 768 KiB. Historical composition retains its own row, byte, and source-read limits. Raising a token setting does not raise worker memory, transfer size, database limits, or deadlines.

## Fallback and omission

The retained V3/compatibility programmatic fallback reads already-loaded recent prefix entries, not the archive. Its limits include 128 entries, 16 blocks per entry, 8,192 UTF-16 units per entry, and 128 Ki units total. A bounded previous summary can be retained as explicitly historical text.

Fallback reports omitted history, unavailable retrieval, and possible stale memory. Incomplete historical coverage is an honest selection result, not a promise that every old restriction remains verbatim. Unsafe tool structure, incompatible identity, cancellation, or an unusable budget still prevents replacement.

V4 requires the current session agent's summary turn regardless of the legacy optional Pi-summary setting. It does not call a separate summary model. The optional value worker does not rewrite this frozen input or replace a missing summary.

## Receipt and recovery

The V4 receipt records:

- Input, selection, and summary hashes and its receipt ID.
- Native scope, historical cut, retained boundary, and captured Memory owner.
- Admitted provider pages and individual record revisions.
- Receipt-only native cards, chronological selections and omissions, and exact recovery descriptors.
- The source-bound session summary and its relevance hints.
- Estimated charges and explicit validation qualifications.

It is not a transaction across providers. A later native read can return a newer record, except where an exact revision selector is supported. Provider exclusions before capture are counts, not invented omitted IDs.

After a successful commit, `history_status.composition.committedReceipt` provides a locator. Its lookup is bounded, so a missing locator does not prove that no older receipt exists. Recover the entry with raw `history_get`, initially without `startByte`. Continue at the returned absolute `nextByte`. After rollover, retain the explicit predecessor shard route. Raw recovery needs a validated catalog, not a completed derived search index.

## Preview and failure

The programmatic V4 preview and active hook call the same pure compiler on frozen input. Compare them only at the same source cut, native capture, model, and preparation. JSON-normalize preview receipts before comparing persisted JSON. The transport `native.requestId` is diagnostic, not part of deterministic input identity.

The `/Chrono` **Preview a compaction** action is a separate retrospective stored-compaction comparison that writes a private artifact. It does not compact or activate V4. A preview is not evidence that the running agent successfully continued after actual replacement.

A Chrono-owned refusal preserves the current context and native source. In V4, a failed, interrupted, stale, oversized, or over-budget summary exchange pauses ordinary model requests. Submission, a new agent turn, and later index readiness do not release this barrier. `history_status.composition.providerBarrier` distinguishes `open`, `summary-only`, and `paused`. Only a correlated native commit releases a failed barrier.

Direct user input or explicit `/compact` can request one fresh, summary-only recovery. A fresh `request_compaction({})` also requires current tool readiness, scope, and strict headroom. A refused tool result terminates the turn and aborts active work. Do not resend the failed ticket automatically. If the current branch cannot fit a summary, preserve the source and report the blocker. A deliberate native tree move keeps the abandoned suffix in source. Chrono never selects another branch or merges sibling state to recover.

The early `context` hook stops known paused or unsafe requests before provider setup. It estimates the current projection, system text, native system/tool deltas, and active schemas, and uses the larger native observation when available. Null usage on the first valid post-commit request is not zero. Chrono estimates the compacted projection instead. Automatic suspension creates only a scoped intent before abort. A fresh summary ticket is created after the run settles and its native ancestry is checked.

The final `before_provider_request` hook keeps the early projection estimate separate from the admitted native/projection floor. It adds positive final-payload growth above that early estimate to the floor, so a large native observation cannot hide late conversation, system, or schema growth. For `openai-codex-responses`, a valid positive public native observation supplies the floor for opaque `input` reasoning `encrypted_content`. The accounting view does not price those encrypted transport characters as visible text. It still charges visible reasoning summaries and other fields. This is an estimated floor, not proof of exact provider tokenization or zero-cost reasoning. Null usage and unknown APIs retain the full serialized-payload estimate. Invalid observations and malformed opaque fields refuse. The original payload remains unchanged.

The hook calls public `ctx.abort()` on refusal. This check is best effort. On installed Pi 0.99.1, cached Codex can invoke `send()` before checking the aborted signal. An earlier context-hook abort stopped the second send in the offline native fixture. A late-only abort still invoked one send. These results do not prove real network delivery, all-provider behavior, or a cache hit. The 16,384-token summary planning reservation is not a provider output cap and cannot guarantee headroom after an uncapped response.

V3 retains its prior retry-pause policy. For its own failed request, it can resume unresolved work once at safe idle with a truthful failure notice. User cancellation does not resume work. Neither path loops around an unchanged failure.

[Context index](README.md) · [Retention](retention-and-projections.md) · [Practical evidence](../design/evidence-and-roadmap.md)
