# ADR-008: Source-scoped current-state lifecycle

Status: records implemented state-v4 behavior, not semantic certification. See the [documentation boundary](../README.md#current-documentation-boundary).

## Context

Chronological cues alone cannot distinguish a restriction from an assistant report or a tool failure from a completed task. Naive latest-text or same-path matching can erase unresolved obligations.

## Decision

Store exact evidence spans with proposition/span identities, category, authority, confidence, revision when known, and effective cut. New supported propositions are `current` or `unresolved`. Explicit supported restriction revocation/replacement targets the matching proposition under the same authority and retains transition evidence.

An explicit operator action can also supersede 1–12 exact prior user restrictions or approval holds under a verified original-user instruction. It pins the full current view and generation, verifies exact target evidence, records the decision atomically, and preserves earlier cuts and generations. The operator owns the scope and meaning assessment. The API does not infer revocation, grant authority to quoted or generated text, alter extraction coverage, or mark a task complete. See [the operation contract](../episodes-and-state.md#explicit-user-supersession).

Tool failure/cancellation can create a blocker. Unrelated success, quoted completion, or another revision does not resolve it. Assistant reports stay reports. Memory events and retention hints remain advisory. Resource observations do not imply known current resource bytes.

This is a targeted deterministic lifecycle, not the charter's complete proposed general-purpose state machine. [Episodes and state](../episodes-and-state.md) owns implemented categories, readiness, and source links.

## Alternatives

- A last-write-wins item keyed only by path collapses distinct obligations and revisions.
- Treating execution success as task verification can produce false completion.
- Promoting ordinary memory metadata to user authority bypasses provenance.
- A general semantic-claim or model-authored truth store is deferred by [A-0004](../amendments/A-0004-v3-timeline-and-catalog-scope.md).

## Consequences

The conservative model can retain unresolved work rather than infer resolution. Extraction and selection remain bounded and can report category gaps or overflow. Complete cut/category flags prove only the implemented source-selection checks. They do not prove that every semantic obligation was recognized. The original large-session mandatory overflow remains unresolved.

## Migration

State-v4 keeps body and metadata checkpoints separately. Ruleset/schema mismatch refuses rather than relabeling a previous database. Reconstruct incompatible derived state explicitly and preserve old pins, memory metadata, and source.

## Reversal path

Disable the affected state consumer or restore a compatible route/package. Do not delete restrictions, mark work resolved, or weaken the composer gate to make rollback appear usable. Follow [migration](../migration.md) and [recovery](../recovery.md).
