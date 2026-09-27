---
title: Retention and stable tool-result projections
audience: [agents, maintainers]
status: current reference
purpose: Distinguish active-context selection, advisory retention, optional shortening, and source preservation.
related:
  - compaction-and-budgets.md
  - ../history/chronology-episodes-resources.md
  - ../operations/workers-and-caches.md
---

# Retention and stable tool-result projections

## Retention is not deletion

Chrono intentionally leaves some history out of active context. Important events can retain detailed evidence. Routine events can use a cue, a reduced representation, or no in-context text. Exact source remains recoverable while its files and valid routes are retained.

This is selective working context, not a growing checklist of every past obligation. Excerpts must preserve their qualifications and identify missing detail. Chronology remains meaningful even when only a subset fits.

The older compatibility path has hot/warm/cold source bands, candidate reducers, and a separate replay cap. Those settings do not imply that the indexed compiler loads whole lifetime history. See [configuration](../operations/menu-and-configuration.md) for applicability.

## Advisory hints

`history_retention_hint` accepts:

- `currentUnresolvedWork`
- `preserveExact`
- `olderEvidenceLikelyNeeded`
- `completedRangesSafeToCompress`
- `abandonedApproaches`

The tool appends advisory metadata for a future generation. A hint does not guarantee retention, establish a task's completion, grant authority, or replace source history. Keep durable project state in Workplan and use Todo/Notes/Memory for their own purposes.

A useful hint identifies specific unresolved work or exact evidence. A generic request to remember everything cannot overcome context or source bounds.

## Tool-result projection

A projection is a shorter request-local representation of an existing tool result. It does not rewrite the stored result or the JSONL source. This feature is separate from historical compaction and is off by default.

The modes are `off`, `safe`, and `aggressive`. Both enabled modes validate tool-call/result pairing and source bindings. Safe excludes marker-only representations. Aggressive allows more reduction, including eligible exact-repeat handling. Neither mode permits arbitrary deletion of protected evidence.

Eligibility preserves recent results, first-consumption results, failures or uncertain terminal outcomes, images, unsupported content, pinned results, restriction/unresolved language, and later exact user citations as implemented. Candidates also need enough size reduction after adding their recovery information. These checks are conservative heuristics, not proof that all semantic importance is detected.

## Why text is frozen between compactions

Earlier request-local shortening could reselect a representation as a result aged or new results arrived. That changed text already sent in the request prefix and could interfere with provider prompt-cache reuse.

The current path selects replacements only at a compaction boundary and reuses the exact snapshot afterward:

1. Successful compaction permits a fresh projection selection for the next context request.
2. Validated eligible old results can receive shorter replacements with exact recovery references.
3. Later turns reuse the same replacements. New results stay exact until another boundary.
4. Settings changes apply to a later compaction boundary, not by rewriting an already-sent prefix.
5. Lifecycle changes invalidate the relevant process-local state rather than reuse a snapshot for an unrelated branch or session.

If bindings, fingerprints, or tool structure no longer validate, the projector leaves the request unchanged and reports a refusal metric. Source identity is more important than preserving a cache-friendly replacement.

Each shortened result identifies the tool and call, successful outcome, reducer, estimated original size, content hash, and `history_get` route. The recovery route still depends on normal historical readiness and branch validation.

## Cache and evidence limits

Stable text can support prefix reuse. It does not control the provider's cache, model routing, other extensions, or token accounting. No general cache-hit rate, price reduction, or speed improvement is claimed.

The intended local selection keeps projection mode off. Its implementation remains documented because the menu can explicitly enable it. The private cache trace is a separate local diagnostic. It is not bundled here and is not a quality measurement.

Memory retention is a different concept. Independent Memory does not silently demote accepted heads as conversation turns pass. Its explicit promotion boost lasts eight Memory commits for ranking. That does not make a fact valid forever. See [Memory](../state/memory.md).

[Context index](README.md) · [Compaction](compaction-and-budgets.md) · [Configuration](../operations/menu-and-configuration.md)
