# ADR-006: Cue index and raw lexical locator

Status: records implemented candidate behavior, not scale qualification. See the [documentation boundary](../README.md#current-documentation-boundary).

## Context

Capsule cues help find relevant history but can omit exact wording. Rebuilding an in-memory index during search repeats lifetime work. Exact discovery therefore needs a separately maintained lexical route with bounded reads.

## Decision

Use disk-backed SQLite FTS5 indexes for bounded capsule cues and decoded chunk text. Lifecycle ingestion owns index construction and publication. Queries pin an existing compatible view and return compact handles. Staged recall and exact recovery are separate operations.

Ranked and literal discovery use bounded candidates. Supported regex requires an explicit bounded scan. Unsupported filters, expressions, nonselective candidate sets, and incompatible handles refuse rather than trigger a full-history fallback. [Search and recall](../search-and-recall.md) owns the current limits, supported surface, and source links.

## Alternatives

- Whole-session parsing and process-local postings maps retain history-sized memory and make query latency depend on total source.
- Cue-only search cannot recover omitted literal detail reliably.
- Implicit regex scanning hides lifetime work in an interactive call.
- Embeddings, semantic workers, and proactive recall loops add mechanisms deferred by [A-0004](../amendments/A-0004-v3-timeline-and-catalog-scope.md). No provider is added.

## Consequences

The lexical index duplicates bounded decoded text on disk. Results can be partial, stale to a compatible prefix, or refused at a query bound. An empty first page does not prove absence from later shards. Generated retrieval copies retain separate provenance and do not become independent evidence. A lexical hit does not certify current state or semantic completeness.

## Migration

Build search from a declared catalog/capsule identity in bounded ingestion turns. Do not construct it in `history_search` or import a lifetime RAM cache. Incompatible identities require a separately prepared store while old source and healthy pins remain available.

## Reversal path

Disable the selected indexed consumer or restore its previously validated route. Preserve stores and all source. A disabled index does not authorize legacy whole-file access above the existing safety gate. Follow [recovery](../recovery.md#search-and-exact-recovery-problems).
