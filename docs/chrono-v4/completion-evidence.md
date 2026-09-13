# V4 implementation evidence

## Scope

This increment adds independent Memory, Todo, Notes, and Workplan stores, version-2 native collection, complete asynchronous transfer, and the opt-in Chrono 4.0.0 context compiler. It reuses Pi's public compaction hook. The default compiler remains `v3` until `contextCompiler: "v4"` is selected. Independent Memory also requires the startup choice `memoryOwner: "context-kit"`.

Implementation, practical use, remote integration, and loaded local activation are separate checks. These results do not establish lifetime scale or general agent benefit.

## Focused component checks

The source-known checks used Node 24.18.0 and private synthetic state. They made no model requests.

- State-store checks used installed Pi 0.85.1 persistence. They exercised verified disk anchors, uncertain-append recovery, reopen, sibling exclusion, native fork, bounded ancestry continuation, and resumable import. Native-entry normalization preserves Pi's omitted optional fields while owned-state validation stays strict.
- Todo and Notes checks preserved a 149,572-byte legacy source prefix across bounded import, reopen, branch changes, and complete transfer. A 1,050-entry gap required resumable pages. Native commands, all Todo Glance actions, independent task revisions, and stale Notes revision refusal were exercised. Not every native action was individually invoked.
- Workplan checks preserved two plans, archived state, IDs, counters, decisions, evidence, and complete revision history. A selected-plan mutation did not read an unrelated 3,146,600-byte plan body. Its cached context projection remained available. This is one bounded fixture, not a constant-time or maximum-size performance result.
- Memory checks compared exact imported V2 bytes and mixed hash formats with the legacy materializer. They exercised revision/time reads, accepted versus proposed knowledge, logical visibility across tree moves, failed-anchor invisibility, and binding transfer.
- One reverse-Memory component scenario compared 14 native revisions, five accepted heads, and two proposal heads with a 13-event V2 export. The export preserved the original prefix and a complete companion. Accepted-head comparison, counters, artifact hashes, explicit target-turn handling, and refusal checks passed. The exporter made no writer switch.
- Compiler checks exercised whole-record fitting, preserved conditions, explicit omissions and recovery, frozen-input hashes, estimated request charges, preview/hook agreement, commit correlation, ownership suppression, and stale-schema cancellation.

## Installed Pi scenario

The scenario used installed Pi 0.85.1 and Node 24.18.0 with private source-known sessions and a scripted model stream. It invoked actual registered tools through Pi's agent loop. It sent no network model request or summary-model request.

The native paths passed: explicit source-preserving import, new writes, standalone Notes reopening, whole-transfer refusal with a missing provider, branch-local Todo/Notes/Workplan, logical-session Memory, Recall, native recovery, and complete state after fresh post-compaction reopening. Recall reported partial Workplan coverage rather than claiming complete state.

Exactly one `session.compact()` ran, using the loaded-prefix fallback with indexed history disabled for that phase. The actual summary, receipt ID, input hash, selection hash, and summary hash matched the preview. The persisted receipt contained 93,987 bytes. The summary contained 75,954 bytes. Rebuilt context preserved tool-call/result pairs and charged the system, active schemas, framing, raw tail, and response reserve.

The estimated context was 22,859 tokens. The estimated request was 29,947 tokens, or 34,043 with response reserve, against the synthetic model's 131,072-token capacity. These are estimates, not tokenizer or final provider-payload measurements.

Complete transfer bootstrapped fresh V4 owners with equal full native state and the same Memory binding. One planned post-transfer Notes write survived the latest complete V1 rollback and another fresh legacy reopen.

Memory reverse export produced five V2 events and compared five complete native revisions. It retained a 1,837-byte actual target sidecar and an 11,060-byte companion. Actual old `memory_get` and `memory_list` read the expected correction from that fresh target. The independent export cut remained revision 2, recorded sequence 5, with no pending operation immediately before old-writer selection. Both source generations and the independent store remain preserved.

## Preserved failures and affected corrections

The original attempt and each failure remain preserved privately. Continuations did not repeat successful setup writes, native phases, or compaction.

1. The first setup attempt omitted the required top-level `rationale` from `record_decision`. Its continuation supplied that argument only for the failed operation.
2. An in-memory optional receipt property was `undefined`, while persisted JSON omitted it. The continuation compared JSON-normalized receipt data and excluded only diagnostic `native.requestId`. It retained every substantive receipt field and hash.
3. The first receipt-history read refused after separate completed agent runs invalidated the earlier catalog readiness observation. Inspection also found an incorrect initial `startByte: 0` in the new locator. Raw byte offsets are absolute. The narrow runtime correction omits that continuation field and preserves existing byte pagination, branch validation, and worker policy.

The affected installed recovery continuation passed with the corrected runtime. Within one actual agent prompt, four status calls observed a validated catalog after about 3.01 seconds. The returned initial locator contained only `entryId`. Two raw calls recovered 16,384 exact bytes from the original 173,705-byte compaction entry. Both pages matched the immutable source. The second page returned further continuation, so this check does not claim complete receipt-tool recovery or whole-receipt JSON decoding.

Capsules and the derived search index were still pending. Raw recovery did not require their catch-up. The original source prefix and the single compaction remained unchanged. No additional compaction, native provider write, import, transfer, or network model call occurred.

Receipt-card recovery calls after the original history refusal were not executed. Separate native recovery and complete post-compaction state checks passed. The corrected 374-file runtime freeze matched before and after the affected recovery check. The locator correction changed only one compiled runtime module and its supporting source, assertion, and hashes.

## Build and delivery boundary

Chrono's source typecheck, compiled build, strict native SQLite build, and allocation-refusal probe passed. Its corrected package has 138 compiled JavaScript files and 139 startup pins. Exact package/index checks passed. The supported helper removed only verified generated source maps. The shared protocol's six tracked JavaScript/declaration outputs matched a clean build. The locator correction passed the existing affected hook check without another native build or full local test campaign.

Repository static verification passed all 18 existing checks for the implementation. Required GitHub CI remains the integration gate and checks the complete indexed release, including package inventory. A successful build or CI result does not establish local activation. Follow [activation and rollback](../activation.md#context-kit-owned-providers-and-v4-compilation) and verify actual loaded tools separately.

## Interpretation

Runtime counts and exact source comparisons establish only the paths exercised. No new model-based quality comparison ran. The earlier [foundation comparison](foundation-evidence.md) remains a small two-call result with different available evidence, not general accuracy or performance evidence.

The compiler uses an explicit estimator. Native current-state recovery can return a later record unless the tool supports an exact revision. Complete native transfer is not a Recall page. Memory's rollover binding needs its retained store. Reverse V2 export needs a fresh target, actual old native reads, and an unchanged export cut before writer selection. Keep original sessions, sidecars, owned stores, and rollback assets.
