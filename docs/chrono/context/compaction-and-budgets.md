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
3. Collect bounded native pages through the same pure collector used by Recall, before replay selection. The compiler does not invoke native tools or read provider stores directly. Capture allows up to 16 cards and 128 scanned records per provider, 16 KiB provider replies, a 32 KiB combined collection, and a 150 ms common wait. Reuse this one collection for the receipt. Do not scan providers again. These pages do not automatically supply facts to the summary writer.
4. Combine the submitted model hints first with bounded commit and concrete path references from ready current cards. Do not add generic prose or bare native record IDs as implicit terms. Add at most 16 native terms within the existing 24-term replay limit, with at most 160 UTF-16 units per term. Completed, done, archived, unknown-status, and unaccepted proposal cards cannot supply implicit hints. Share the native allowance across available owners. Capture bounded chronological events from the loaded branch with these terms and applicable Pi context edits. Keep original roles, source order, omission notices, and exact recovery IDs.
5. Detach and freeze admitted inputs. Charge the continuation summary and exact tail first, then fit replay within its adaptive allowance and hard ceiling. The current compiler requires both the summary and event replay; old stored/fallback input forms do not substitute for them.
6. Charge the complete rendered result. Revalidate scope, settings, model, active schemas, cancellation, and source boundary before returning.
7. Persist `details.contextReceipt` with the actual Pi compaction entry. Correlate `session_compact` or `session_compact_failed` with the pending attempt.

Replay uses estimated event-body detail targets of 2,048 tokens for full verbose evidence, 768 for reduced detail, and 160 for brief detail, before headers and recovery references. Direct user wording keeps its prior 4,096-token full-detail guide. Reduction still uses the existing relevance-aware reducers. The 5,000-estimated-token replay preference, relevance-gated expansion, source order, and exact recovery routes remain unchanged.

Replay reduces optional detail before omitting useful events. It does not promise whole-record retention or semantic completeness. Native rendered tokens remain zero. Saved state, summaries, and relevance hints are fallible context, not new permission. See the [adaptive replay policy](session-agent-compaction.md#adaptive-replay-selection) for selection and omission rules.

## Budgets

The default `targetContextTokens` is 32,000 estimated retained tokens. The configurable range is 8,000–250,000. This is a ceiling, not a size to fill. The effective ceiling is lower when model headroom requires it.

V4 retains the separate `sessionSummaryTargetTokens` configuration field, default 3,000 and range 256–8,000, for compatibility. The agent-facing request does not turn this value into a desired summary length or give a numerical size goal. It asks for only the information needed to continue safely, without filler, repetition or padding, comfortably below the hard submission limits. Those limits remain 32,768 UTF-16 units and 49,152 UTF-8 bytes (48 KiB). A multibyte summary can reach the byte bound before the character bound. These are text-length bounds, not exact tokenizer measurements or provider output caps. V3's optional summary still uses `hybridSummaryTargetTokens`.

The compiler charges the complete accepted summary before fitting replay. The retained summary configuration does not reserve a fixed summary/replay ratio or change admission, trigger timing, response/planning reserves, or safety allowances. Native cards remain receipt-only evidence.

For V4, the estimated request includes:

- System text and the complete active tool-schema JSON.
- Message and transport framing allowances.
- The rendered compaction summary, including notices and recovery references.
- Complete raw-tail messages, including images and tool-result bodies as estimated by Pi.
- A planning reserve of `min(model.maxTokens, DEFAULT_COMPACTION_SETTINGS.reserveTokens)`. Pi 1.1 defaults to 16,384 tokens. This is separate from a provider output cap. See [`interval-policy.ts`](../../../packages/pi-chrono-compaction/src/interval-policy.ts).

The estimator is named `pi-message-estimator-and-utf16-ceil-div4-v1`. It combines Pi message estimates with `ceil(UTF-16 units / 4)` text estimates. It is not the selected model's exact tokenizer. Later payload extensions and provider serialization can change the final request.

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
- The source-bound session summary and its unchanged submitted relevance hints. The replay receipt also records the bounded combined terms actually used for selection.
- Estimated charges and explicit validation qualifications.

It is not a transaction across providers. A later native read can return a newer record, except where an exact revision selector is supported. Provider exclusions before capture are counts, not invented omitted IDs.

After a successful commit, `history_status.composition.committedReceipt` provides a locator. Its lookup is bounded, so a missing locator does not prove that no older receipt exists. Recover the entry with raw `history_get`, initially without `startByte`. Continue at the returned absolute `nextByte`. After rollover, retain the explicit predecessor shard route. Raw recovery needs a validated catalog, not a completed derived search index.

## Preview and failure

The programmatic V4 preview and active hook call the same pure compiler on frozen input. Compare them only at the same source cut, native capture, model, and preparation. JSON-normalize preview receipts before comparing persisted JSON. The transport `native.requestId` is diagnostic, not part of deterministic input identity.

The `/Chrono` **Preview a compaction** action is a separate retrospective stored-compaction comparison that writes a private artifact. It does not compact or activate V4. A preview is not evidence that the running agent successfully continued after actual replacement.

A Chrono-owned refusal preserves the current context and native source. In V4, a failed, interrupted, stale, oversized, or over-budget summary exchange pauses ordinary model requests. Submission, a new agent turn, and later index readiness do not release this barrier. `history_status.composition.providerBarrier` distinguishes `open`, `summary-only`, and `paused`. Only a correlated native commit releases a failed barrier.

Direct user input or explicit `/compact` can request one fresh, summary-only recovery. A fresh `request_compaction({})` still requires current tool readiness, valid estimates and model metadata, and source/lifecycle binding. In the interval candidate, estimated input thresholds force summary-only work instead of blocking the summary attempt. This also applies after a single-turn overshoot or an estimate above the advertised context window. Actual provider rejection remains possible and uses the existing correlated recovery path. The compiled restart must still fit its budget. A refused tool result terminates the turn and aborts active work. Do not resend the failed ticket automatically. If structural checks or recovery fail, preserve the source and report the blocker. A deliberate native tree move keeps the abandoned suffix in source. Chrono never selects another branch or merges sibling state to recover.

The early `context` hook stops known paused or unsafe requests before provider setup. It uses Pi's `ctx.getContextUsage()` estimate when the conversation projection is unchanged. If usage is unavailable or Chrono changes the projection, it uses Pi's `convertToLlm` and `estimateTokens`, plus the current system prompt, active schemas, and framing. A new restart never inherits the old full-prefix usage. Pi owns image estimates. Chrono does not add another image charge or require an exact-model image table. See [`context-budget.ts`](../../../packages/pi-chrono-compaction/src/context-budget.ts). At an automatic freeze, the context hook appends a source-bound summary request to the current projection instead of aborting solely for estimated headroom. Turn-boundary and idle requests use the same summary protocol. Invalid estimates and unrelated failure barriers do not permit ordinary work.

The final `before_provider_request` hook checks request scope and summary lifecycle state. It does not estimate provider JSON or repeat summary headroom checks for ordinary work. Summary requests still require the summary tool and valid budget metadata, but estimated low headroom is a trigger, not a refusal. The payload remains unchanged except for the supported `openai-completions` output cap, which remains separate from the planning reserve. See [`pi-extension.ts`](../../../packages/pi-chrono-compaction/src/pi-extension.ts). These source rules do not prove that a running session has loaded the change.

The hook calls public `ctx.abort()` on refusal. This check is best effort. On installed Pi 0.99.1, cached Codex can invoke `send()` before checking the aborted signal. An earlier context-hook abort stopped the second send in the offline native fixture. A late-only abort still invoked one send. These results do not prove real network delivery, all-provider behavior, or a cache hit. The 16,384-token summary planning reservation is not a provider output cap and cannot guarantee headroom after an uncapped response.

V3 retains its prior retry-pause policy. For its own failed request, it can resume unresolved work once at safe idle with a truthful failure notice. User cancellation does not resume work. Neither path loops around an unchanged failure.

[Context index](README.md) · [Retention](retention-and-projections.md) · [Practical evidence](../design/evidence-and-roadmap.md)
