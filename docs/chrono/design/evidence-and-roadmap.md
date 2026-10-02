---
title: Implementation, evidence, and future choices
audience: [users, agents, maintainers, evaluators]
status: accepted source with revision-bound activation evidence
purpose: Identify the implemented version and keep practical evidence, selection, activation, and planned work separate.
related:
  - evolution-and-decisions.md
  - ../operations/activation-and-migration.md
  - ../../chrono-v4/completion-evidence.md
---

# Implementation, evidence, and future choices

## Current source boundary

Use `packages/pi-chrono-compaction/package.json` for this checkout's exact version and `scripts/verify-chrono-v3-baseline.mjs` for its pinned package tree. Accepted source includes the 4.0.6 system-update continuation correction, the native ancestry corrections, unified menu, stable projections, same-session summary, context-edit handling, and adaptive chronological replay described in the [compaction contract](../context/session-agent-compaction.md).

GitHub acceptance, local code selection, and loaded activation are separate checks. This source record does not establish remote integration or the code currently loaded in an installation.

| Concern | Boundary |
| --- | --- |
| Retained interface | One `/Chrono` menu, presets/model picker, reports, and projection snapshots from the earlier 3.0.5 interface. |
| Implemented V4 | Independent Context Kit providers, V2 evidence collection, complete asynchronous transfer, and an opt-in same-session summary/replay compiler. |
| Compiled defaults | `contextCompiler: "v3"`, `memoryOwner: "chrono"`, normal memory engine on. |
| Intended local selection | `contextCompiler: "v4"`, `memoryOwner: "context-kit"`. Preserve `valueWorkerMode: "off"` and `toolResultProjectionMode: "off"`. |
| Loaded activation | The retained 4.0.5 check verified its coordinating process only. It is not evidence for newer source or fleet adoption. Check the current private activation receipt and each target process's loaded identity. |
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

The [completion evidence](../../chrono-v4/completion-evidence.md) used installed Pi 0.85.1, Node 24.18.0, private source-known state, and a scripted model stream. It made no network model request or summary-model call. That earlier compiler differs from the current same-session summary path. Its result does not establish that current V4 needs no summary.

It exercised explicit import, new writes, reopen, branch-local Todo/Notes/Workplan, logical-session Memory, Recall/native recovery, complete transfer refusal and success, and post-write compatible rollback.

Exactly one actual compaction matched its JSON-normalized preview hashes and receipt using the loaded-prefix fallback. The request charges were estimates, not exact tokenizer or provider-payload measurements.

An affected recovery check read two exact raw pages, 16,384 bytes total, from the original compaction entry while the derived index was still pending. Further continuation remained. This is not complete receipt-tool recovery or whole-receipt JSON decoding. Some receipt-card follow-up calls did not run after an earlier refusal. Separate native-state checks passed.

Original failures and narrow corrections remain documented. Successful setup and compaction were not repeatedly rerun merely to replace failed evidence.

### Local integration checks

The earlier integration owner reported a successful compiled build and two existing short conflict-focused checks for `1f4b170`. Those results retain that source boundary. Prior V4 practical evidence was not repeated as a new quality or lifetime-scale campaign.

The local Chrono 4.0.5 verifier reported 704 passed, zero failed, and two skipped. Loaded activation was verified only in the coordinating process before publication. These checks do not establish fleet activation, complete indexing, or a new committed compaction.

For the context-edit and adaptive replay source at `be67e0ec`, a fixed real prefix reused its saved summary without a model call. Estimated replay decreased from 17,833 to 6,971 tokens, selecting 46 of 156 events. Complete compiled context was 9,833 tokens under the unchanged 40,000-token ceiling. The source and saved summary were preserved. Practical continuation review found no blocking gap in that prefix. This is not semantic completeness, a corrected live high-context summary exchange, or a prompt-cache improvement. See the [verification limits](../context/session-agent-compaction.md#verification-status).

The earlier documentation reconciliation used local link, source-hash, and factual consistency checks. It added no runtime tests, model calls, or live changes. Those results belong to that revision. Current GitHub acceptance and installation checks remain separate.

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
