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

The [session-agent compaction contract](session-agent-compaction.md) supersedes the no-required-summary and state-first V4 design below. The correction is in isolated development. This page records the retained implementation until the replacement is exercised and its actual output is approved.

## Public Pi integration

Pi requests compaction through `session_before_compact`. Chrono returns custom context through that public hook. It does not patch private AgentSession methods or create a second compactor.

Pi still owns context-pressure and overflow handling. A separate Chrono proactive threshold can request earlier compaction. `request_compaction` schedules a request at the end of the current turn. It is not a synchronous completed compaction. Save useful project state before requesting it, then stop starting new operations.

## Selected paths

| Path | Inputs and result |
| --- | --- |
| V3 programmatic memory | Bounded compatible historical selection, a small adaptive raw tail, and optionally an independent regular Pi summary. |
| V4, selected by `contextCompiler: "v4"` | Frozen current native cards plus compatible historical selection or bounded fallback, whole-record fitting, complete estimated request charges, and a persisted receipt. |
| Compatibility replay | Retained older candidate reconstruction, separate replay limits, and optional value advice. It is not a hidden V3/V4 failure fallback. |

V3 remains the compiled default. The local integration intends explicit V4 selection. Check [evidence and selection](../design/evidence-and-roadmap.md), not the package version alone.

## V4 capture and compilation

1. Capture the full current native session/leaf, the historical prefix cut, the first retained entry, model metadata, system prompt, active schemas, response reserve, settings, and lifecycle identity.
2. Select an adaptive recent tail without splitting a tool call from its result. The historical prefix ends before that tail. Native state is captured at the full leaf, not artificially rewound to the historical prefix cut.
3. Collect bounded pages through the same pure collector used by Recall. The compiler does not invoke native tools or read provider stores directly. Its capture allows up to 16 cards and 128 scanned records per provider, 16 KiB provider replies, a 32 KiB combined collection, and a 150 ms common wait.
4. Select existing compatible historical state. Missing optional history can use a bounded loaded-prefix fallback. Identity mismatches and corrupt source do not authorize that fallback.
5. Detach and freeze the admitted inputs. Fit whole admitted records, retain explicit omissions and recovery, then render historical items in source order.
6. Charge the complete rendered result. Revalidate scope, settings, model, active schemas, cancellation, and source boundary before returning.
7. Persist `details.contextReceipt` with the actual Pi compaction entry. Correlate `session_compact` or `session_compact_failed` with the pending attempt.

Whole-record fitting means a selected card or already-admitted historical representation is not cut again arbitrarily by the compiler. Providers and historical projectors can already have supplied bounded excerpts. Omitted fields remain unknown.

Selection gives unresolved task states and categories such as constraints, blockers, decisions, and knowledge preference. That is a deterministic priority, not a truth score or a guarantee that every important fact fits.

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

The recent tail normally aims for 3,000–6,000 estimated tokens. It examines at most 256 suffix entries, respects the prepared boundary, and can retain less than the minimum when safe boundaries require it. An indivisible suffix that cannot fit the maximum refuses. Fixed or Pi-tail compatibility options do not replace the V3/V4 dynamic-tail rule.

Separate finite bounds remain: V4 input is at most 1 MiB and its receipt at most 768 KiB. Historical composition retains its own row, byte, and source-read limits. Raising a token setting does not raise worker memory, transfer size, database limits, or deadlines.

## Fallback and omission

The programmatic fallback reads already-loaded recent prefix entries, not the archive. Its limits include 128 entries, 16 blocks per entry, 8,192 UTF-16 units per entry, and 128 Ki units total. A bounded previous summary can be retained as explicitly historical text.

Fallback reports omitted history, unavailable retrieval, and possible stale memory. Incomplete historical coverage is an honest selection result, not a promise that every old restriction remains verbatim. Unsafe tool structure, incompatible identity, cancellation, or an unusable budget still prevents replacement.

V4 does not require a summary-model call, even when the legacy optional Pi-summary setting is enabled. The optional value worker does not rewrite this frozen plan.

## Receipt and recovery

The V4 receipt records:

- Input, selection, and summary hashes and its receipt ID.
- Native scope, historical cut, retained boundary, and captured Memory owner.
- Admitted provider pages and individual record revisions.
- Selected and omitted card references, unresolved relations, historical selections, exclusions, and recovery descriptors.
- Estimated charges and explicit validation qualifications.

It is not a transaction across providers. A later native read can return a newer record, except where an exact revision selector is supported. Provider exclusions before capture are counts, not invented omitted IDs.

After a successful commit, `history_status.composition.committedReceipt` provides a locator. Its lookup is bounded, so a missing locator does not prove that no older receipt exists. Recover the entry with raw `history_get`, initially without `startByte`. Continue at the returned absolute `nextByte`. After rollover, retain the explicit predecessor shard route. Raw recovery needs a validated catalog, not a completed derived search index.

## Preview and failure

The programmatic V4 preview and active hook call the same pure compiler on frozen input. Compare them only at the same source cut, native capture, model, and preparation. JSON-normalize preview receipts before comparing persisted JSON. The transport `native.requestId` is diagnostic, not part of deterministic input identity.

The `/Chrono` **Preview a compaction** action is a separate retrospective stored-compaction comparison that writes a private artifact. It does not compact or activate V4. A preview is not evidence that the running agent successfully continued after actual replacement.

A Chrono-owned refusal preserves the current context. For its own failed request, Chrono can resume unresolved work once at safe idle with a truthful failure notice and pause further automatic retries until new user input. User cancellation does not resume work. Do not add a loop around an unchanged failure.

[Context index](README.md) · [Retention](retention-and-projections.md) · [Practical evidence](../design/evidence-and-roadmap.md)
