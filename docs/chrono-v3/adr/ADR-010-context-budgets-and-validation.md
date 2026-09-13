# ADR-010: Context budgets and validation

Status: records the implemented default-on composer, not proof of local activation or semantic certification.

## Context

Compaction must retain useful chronological memory and a safe raw tail without requiring a language-model summary or returning an oversized context. Selected rows can fit an intermediate budget but overflow after wrappers and recovery references are rendered.

## Decision

Use one bounded deterministic composer over a pinned state selection, compatible historical memory, and any explicitly verified bounded delta. Keep a separately produced regular Pi summary when it is explicitly enabled and available. It is not a prerequisite. Render one source-ordered history, including goals, restrictions, decisions, blockers, and unfinished work. Selection indexes may remain separate. Importance can reduce or omit optional detail, not reorder retained experience.

Use bounded row/input limits and the existing `targetContextTokens` setting as a model-validated combined summary-and-tail cap. The default is 32,000 tokens. Use the existing dynamic tail defaults of 3,000 through 6,000 tokens, not Pi's unchanged prepared tail. An optional independently generated Pi summary must cover the same chosen cut. Skip it when bounded preparation cannot provide that input. The charter's section-floor table is not the implemented settings interface. Important history receives graded detail. Excerpts and omissions are normal and must be identified, with retrieval cues and exact recovery links. In-context completeness is a disclosure, not an admission requirement.

Validate again after rendering. The live return requires safe tool pairing, compatible cuts, unchanged runtime identity, and the hard ceiling. Source or safety failures cancel compaction. Missing optional memory or summary detail uses compatible last-good state or bounded current-branch fallback with explicit coverage limits. Selective history is allowed on the live path. It never authorizes legacy lifetime reconstruction. [Context composition](../context-composer.md) owns the detailed path and limits.

## Alternatives

- Requiring the Pi summary would add a provider prerequisite to the programmatic baseline.
- Raising a token setting does not repair extraction gaps or justify presenting an excerpt as complete wording. Model headroom and finite byte/resource limits still apply.
- Checking only pre-render row counts misses wrapper and representation loss.
- Rebuilding old history on failure defeats the bounded architecture.
- Optional model advice must remain separate from the baseline and must not replace whole-history memory.

## Consequences

The owner superseded the global verbatim inventory requirement with useful approximate chronological memory and retrieval. The original large session still needs practical verification. Cut/category coverage describes implemented extraction and selection, not proof that every obligation was understood. The current context remains intact on refusal.

## Migration

Normal startup selects V3 by default and retains explicit global or session exclusions. Keep prior source and derived stores. Persist a minimal envelope or fallback receipt in Pi. Private diagnostic artifact storage is optional for normal composition. No package version alone proves that the running process loaded the change.

## Reversal path

Disable the selected path or restore the previously validated package through [recovery](../recovery.md). Do not rewrite old compaction records, delete obligations, or infer a provider-call authorization from a preview result.
