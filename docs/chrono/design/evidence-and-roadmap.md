---
title: Implementation, evidence, and future choices
audience: [users, agents, maintainers, evaluators]
status: local integration with process-specific activation checks
purpose: Identify the implemented version and keep practical evidence, selection, activation, and planned work separate.
related:
  - evolution-and-decisions.md
  - ../operations/activation-and-migration.md
  - ../../chrono-v4/completion-evidence.md
---

# Implementation, evidence, and future choices

## Current source boundary

The local runtime integration is `1f4b170`, version `4.0.1-local.20260919`. It combines the V4 completion at `788efc2` with main's Chrono 3.0.5 unified menu and stable tool-result projections, plus the local report-scroll correction at `8761d86`.

This is a local integration, not a published GitHub release. Documentation does not establish live selection or loaded activation.

| Concern | Boundary |
| --- | --- |
| Previously selected/main Chrono | 3.0.5, one `/Chrono` menu, presets/model picker, reports, and projection snapshots. |
| Implemented V4 | Independent provider stores, V2 collection, complete asynchronous transfer, and opt-in compiler. |
| Compiled defaults | `contextCompiler: "v3"`, `memoryOwner: "chrono"`, normal memory engine on. |
| Intended local selection | `contextCompiler: "v4"`, `memoryOwner: "context-kit"`. Preserve `valueWorkerMode: "off"` and `toolResultProjectionMode: "off"`. |
| Loaded activation | This documentation commit does not prove selection or adoption. Check the private activation receipt and the loaded identity of each target process. |
| Existing legacy state | Explicit paged imports are still required. Code selection is not migration. |
| Background LLM | Compatibility subsystem, paused while the normal engine is enabled. Presets do not enrich V4. |

The retained release is immutable. Record actual selection and adoption privately and in the owning local activation reference, not by treating this source document as a live deployment report. Operators must check that receipt and each target process. Keep private roots, receipts, session IDs, and diagnostic traces outside the repository. Do not infer all-session adoption from a fresh loader.

## Evidence that can be reused

### V3 and narrow corrections

Focused V3 work exercised model-free composition, source-linked recall, native state preservation, and physical Pi replacement with restart. Later corrections addressed refusal continuation, branch targeting, catalog-only raw recovery, startup recheck, retrieval cues, and menu/projection behavior.

These checks have revision boundaries. The retained [release compatibility record](../../chrono-release-compatibility.md) and [V3 records](../../chrono-v3/README.md) identify them. The retained scale campaign did not complete its matrix. Its [settled correction](../../chrono-v3/reviews/M11-report-correction.md#actual-settled-campaign) is not a billion-token pass.

### V4 foundation

The [foundation evidence](../../chrono-v4/foundation-evidence.md) used a small source-known native scenario and two controlled model calls. Current cards supported four scored facts. An old excerpt alone supported none of those missing facts and the model safely requested evidence.

The inputs differed in available evidence. That result does not establish general accuracy, token savings, faster performance, or a full comparison with V3's retrieval tools.

### V4 implementation scenario

The [completion evidence](../../chrono-v4/completion-evidence.md) used installed Pi 0.85.1, Node 24.18.0, private source-known state, and a scripted model stream. It made no network model request or summary-model call.

It exercised explicit import, new writes, reopen, branch-local Todo/Notes/Workplan, logical-session Memory, Recall/native recovery, complete transfer refusal and success, and post-write compatible rollback.

Exactly one actual compaction matched its JSON-normalized preview hashes and receipt using the loaded-prefix fallback. The request charges were estimates, not exact tokenizer or provider-payload measurements.

An affected recovery check read two exact raw pages, 16,384 bytes total, from the original compaction entry while the derived index was still pending. Further continuation remained. This is not complete receipt-tool recovery or whole-receipt JSON decoding. Some receipt-card follow-up calls did not run after an earlier refusal. Separate native-state checks passed.

Original failures and narrow corrections remain documented. Successful setup and compaction were not repeatedly rerun merely to replace failed evidence.

### Local integration check

The integration owner reported a successful compiled build and two existing short conflict-focused checks for `1f4b170`. Prior V4 practical evidence is reused. It was not repeated as a new quality or lifetime-scale campaign.

This documentation change uses only short local link/front-matter and factual consistency checks. It adds no runtime tests, model calls, live changes, or publication.

## What the system does not establish

- Perfect recall, complete natural-language obligation extraction, or infinite storage.
- General model-based quality improvement from all components or any LLM preset.
- Whole-archive global ranking, embeddings, or a universal resource-version graph.
- An atomic distributed snapshot across providers.
- Exact model token counts or full control over later provider payload changes.
- A hard cap on all disk growth, total host memory, or the initial load of an old huge Pi file.
- Safe automatic migration of arbitrary third-party extension state.
- Data-preserving rollback merely by selecting an older package.
- Automatic cleanup of source shards, canonical revisions, or old pinned stores.

## Useful future choices

| Possible work | Why it may help | Evidence needed before expanding |
| --- | --- | --- |
| Source-backed action/result/correction relations in the existing history path | Connect historical evidence more precisely. | Better recovery on a bounded real case without stale or invented relations. Do not create a second all-history graph by default. |
| Broader provider discovery | Reduce the fixed registry's integration limit. | Preserve native-tool exclusions, identity, versioning, and failure isolation. |
| Optional indexed-pipeline model assistance | Improve bounded event/group representations. | An off/on comparison with fixed source cut and budget after the deterministic baseline works. No required model dependency. |
| More accurate request accounting | Reduce uncertainty around provider framing and tokens. | Match the installed provider path and retain explicit estimator qualifications. |
| Long-run scheduling and recovery improvements | Keep actual sessions usable under sustained growth. | Measured bounded scenarios and observed bottlenecks, not architecture-only scale claims. |
| Quality evaluation across useful tasks | Determine whether evidence improves safe next actions. | Source-known expectations, omissions and failures in the denominator, and separately labeled self-reports. |
| Storage lifecycle tooling | Manage retained disk data without breaking recovery. | Explicit ownership, pinned-reference preservation, backup, and approval for destructive changes. |

Choose a small improvement when actual use demonstrates the need. More tests or reviews are not a substitute for a useful result, and no roadmap item authorizes extra model spending, publication, or deployment.

[Design index](README.md) · [Evolution and decisions](evolution-and-decisions.md) · [User guide](../USER-GUIDE.md)
