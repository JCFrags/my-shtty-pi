# V4 completion scope

## Delivery target

Complete the independent state owners and connect their bounded native records to the existing deterministic compaction path. Preserve working interfaces, immutable source, branch boundaries, and rollback. This document specifies the next implementation. It is not acceptance evidence.

Do not add a second compactor, graph database, global worker queue, or required summary model. Reuse the current strict state reducers, public compaction hook, source-cut validation, chronological rendering, adaptive tail, exact history recovery, and complete rollover contract where they are sufficient.

## Native read contract

The protocol library owns bounded request validation and collection, not provider persistence. The next protocol adds Memory through version 2. Providers also retain the existing version-1 listener for Todo, Notes, and Workplan clients. Version 1 does not gain new provider IDs or categories. New consumers use version 2 and require matching providers. Missing or older providers remain explicit unavailable results rather than hidden activation or guessed data.

Version 2 keeps the existing session/leaf scope, correlated requests, deadlines, record and byte bounds, readiness, coverage, record revisions, and omissions. It adds provider `memory`, categories `knowledge` and `proposal`, and read-only `memory_get` recovery. Memory requires the active native `memory_get` tool. Other providers require their same-named native tool. Knowledge and proposals are separate categories. A category never gives text instruction authority.

The shared collector exports this interface from `@context-kit/protocol/collect`:

```ts
collectContext(
  host: { events: ContextEventBus; getActiveTools(): string[] },
  input: ContextQuery,
  view: { getScope(): ContextScope; epoch(): number; signal?: AbortSignal },
): Promise<ContextCollection>
```

`ContextQuery` uses the existing Recall query, providers, categories, records, scan, providerBytes, maxBytes, and waitMs fields. `ContextCollection` retains the current Recall result shape. The complete tool-result wrapper remains included in byte admission. The Recall tool delegates to this collector. Compaction uses the collector directly without invoking tools or importing provider stores.

Freeze the copied reply and exact record revisions in the compaction receipt. Do not describe record revisions as a provider-wide revision or a transaction across all providers. Recheck scope and cancellation. Current-state recovery can return a later record unless the receiving tool supports the supplied exact revision.

## State owners

Each provider has separate storage and lifecycle. Shared code may supply validation or storage primitives, but no store instance, lock, database, or mutable singleton is shared between providers.

Todo, Notes, and Workplan retain branch-local visibility. Reuse their existing operations, IDs, revision rules, display behavior, and Glance contracts. New persistence must resolve the selected branch without normal all-history replay. Admission must bound complete operations, not only rendered text. Workplan must not hydrate or clone every retained plan to update one plan.

Memory uses an explicit logical-session namespace. Accepted ordinary knowledge survives a tree move, as distinct from branch-local tasks and scratchpad state. It is not a global cross-project store. Preserve source session/leaf, source identity, event time, recording/revision time, and validity. Unknown event time or validity remains unknown. Proposals are not accepted knowledge. No confidence score certifies a claim.

A state write must have a real persistence boundary. In installed Pi 0.85.1, `message_end` occurs before Pi persists the message. It is not a durable acknowledgment. Publish owned data durably before binding a Pi custom anchor, and define the orphan, failed-anchor, branch-change, and restart outcomes. Do not expose an unbound prepared revision as committed state.

## Migration and rollback

Import legacy state into separate stores. Preserve the original source files and bytes without rewriting them. Retain IDs, revisions, counters, provenance, and an import receipt. State-provider import pages contain detached native entries and explicitly named normalized-native-entry digests, not copied JSONL whitespace bytes. Never replace failed import with empty state. Preserve legacy Memory hash formats exactly rather than upgrading historical hashes.

Select one writer for each provider. The Memory handoff must stop legacy tool registration, automatic promotion writes, and pinned legacy reads together. Disabling mutations alone is not a complete handoff.

A rollback must preserve writes made after migration. Returning to a pre-import session is not sufficient. Existing native loaders reject a transfer checkpoint after earlier provider state. A return through their checkpoint contract therefore requires a fresh replacement with complete native checkpoints before continuation. Keep that distinct from a code-selection rollback.

Complete native transfer remains mandatory for rollover. Bounded Recall cards are not transfer snapshots. If complete state does not fit or is unavailable, refuse safely rather than shorten it.

## Verification and completion

Use one or two focused checks per changed path and a small source-known installed-Pi scenario. Exercise standalone providers, source-preserving import, new writes, reopen, branch visibility, native recovery, and complete transfer. Validate the frozen context in preview before actual public-hook compaction and resumed use. Preserve original failure evidence and retry only an affected correction.

Required CI and protected-main integration remain mandatory. Keep runtime counts, coverage, recall quality, and agent usefulness separate. Do not repeat the accepted foundation model comparison or claim lifetime-scale qualification.

Prepare a scoped retained installation and rollback. Compare the complete loader with unrelated registrations preserved, then exercise actual loaded tools. Update the root README after implementation and evidence. Retire only verified task-owned temporary resources. Preserve retained installations, source history, and required recovery assets.
