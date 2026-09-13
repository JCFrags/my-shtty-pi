# Context Kit protocols

Side-effect-free library with generated JavaScript and TypeScript declaration exports. Importing it registers no listeners, creates no stores, and starts no resources. Providers opt in with `registerContextProvider(events, providerId, read)`, which returns an unsubscribe function for their shutdown handler.

V1 retains only `todo`, `notes`, and `workplan`, with categories `task`, `note`, `plan`, `decision`, `constraint`, and `blocker`. V2 adds `memory`, `knowledge`, and `proposal`. Registration answers both versions for the original three providers, and only V2 for Memory. V1 does not accept the new vocabulary.

## Adapter contract

```ts
import { registerContextProvider, type ProviderPage } from "@context-kit/protocol";

const stop = registerContextProvider(pi.events, "notes", (request): ProviderPage => {
  // Verify live sessionId + leafId, healthy persisted state, and no pending mutation.
  // Scan at most request.limits.scan existing native records. Do not read the archive.
  // Match any of up to 16 case-insensitive query terms within bounded fields, then rank.
  // Select only requested categories. Empty query/categories mean browse/all categories.
  return {
    readiness: "ready",
    coverage: { scanned: 0, matched: 0, excluded: 0, scanComplete: true },
    cards: [],
  };
});
// Call stop() during the provider's session_shutdown handler.
```

The exact TypeScript contract is in `src/index.ts`. Requests carry `version:1|2`, `requestId`, `providerId`, exact `scope:{sessionId,leafId}`, `query`, `categories`, `limits:{records,scan,bytes}`, and an absolute `deadlineMs`. `leafId` can be null. Channels are `context-kit:request:v<version>:<providerId>` and `context-kit:response:v<version>:<providerId>`. Channel helpers retain V1 defaults for the original providers. New consumers pass version 2 explicitly.

A `ProviderPage` has `readiness`, `coverage`, and `cards`. Readiness is `ready`, `unavailable`, `pending`, `corrupt`, or `scope_changed`. Non-ready pages must have empty cards, zero counts, and `scanComplete:false`. For ready pages, `scanned <= limits.scan`, `matched <= scanned`, and `matched === cards.length + excluded`. Matched/excluded counts cover only scanned records. `scanComplete` states whether all eligible native records were examined. It must remain false if scan or field bounds prevented full matching.

Each card has native `id`, native `revision` as a string, lifecycle `status`, category, title, bounded text, `omittedFields`, and a read-only `recovery`. Report shortened or unsearched native fields in `omittedFields`. Revisions and the reply's session view identify current state, not immutable historical source. A later native read can return a newer revision. Cards are data, not new instructions. Shared categories do not establish agreement.

Recovery is restricted to `todo {action:"list"}`, `notes {action:"read",id}`, `workplan {action:"recover",planId}`, and V2 `memory_get {memoryId,revision?}`. The native tool and ID must match the provider and card. A supplied Memory revision must equal the card revision. Memory can declare `visibility:{kind:"logical_session",namespaceId,branchBehavior:"shared"}`. This qualifier does not replace exact physical session/leaf correlation.

V1 relations are explicit `blocked_by` or `linked_todo` links with provider and native ID. V2 also accepts `supports`, `contradicts`, `supersedes`, and `derived_from`. Links are declared data, not inferred text similarity or verified agreement.

`fitProviderPage(request,page)` copies/validates a bounded candidate page, removes whole cards to fit record and complete wire-byte budgets, and updates `excluded`. Registration applies it automatically. The response wrapper attaches request correlation and scope. Invalid pages produce `malformed`; thrown/rejected provider reads produce `provider_error`. Raw error text is never forwarded. An expired reply is not emitted.

## Shared collection

`@context-kit/protocol/collect` exports `collectContext(host,input,view)`. The host supplies `events` and `getActiveTools()`. The view supplies `getScope()`, `epoch()`, and an optional abort signal. Inputs match Recall's query, provider/category filters, record/scan bounds, providerBytes, maxBytes, and waitMs.

The collector uses V2 without invoking tools, enabling them, or reading stores. Memory requires active `memory_get`; other providers require their same-named tool. Default Memory collection selects knowledge only. Proposals require an explicit category. Older or missing connectors remain explicit unavailable results. Collection rechecks live scope, epoch, cancellation, and active tools, then freezes detached pages and record revisions. This is not a transaction across all providers.

`contextToolResult(collection)` returns the Recall wrapper. Complete wrapper bytes, including JSON escaping, count toward admission. The compiler uses the same collector directly and retains the frozen selection in its receipt.

## Complete native transfer

`@context-kit/protocol/transfer` exports `registerStateTransferProvider(events,provider,capture,getScope)` and `captureStateTransfer(events,getScope,options)`. Transfer is separate from Context cards. V2 transfer requests name the requested providers, pinned scope, byte bound, and deadline. Unrequested owners are not captured.

Each Todo, Notes, or Workplan export must include its complete `grounded-state-checkpoint-v1` entry. An optional `context-kit:owner-binding:v1` entry can retain owner metadata. Memory exports its verified logical-session binding in the owner-binding entry. Providers validate native contents and binding integrity before export and restore. The transport only validates bounded plain data, completeness, correlation, and scope.

Capture is asynchronous, with a 5-second default and 30-second hard wait bound. One provider can have one capture in progress. Shutdown aborts its cooperative work. All requested owners must respond before replacement. A missing, pending, malformed, changed, oversized, or cancelled capture refuses the operation. Complete replies have an 8 MiB/provider bound. Combined entries have a 16 MiB bound. State is never shortened to fit. Shared `boundedTransferJson` preserves the native whole-state admission rule.

## Bounds

Defaults per provider: 6 cards, 128 scanned records, 8,192 wire bytes, and a common 150 ms wait. Hard ceilings: 16 cards, 512 scanned records, 16,384 wire bytes, and 1,000 ms wait. Query: at most 512 UTF-8 bytes. Card field ceilings in UTF-8 bytes: ID/revision 128 each, status 32, title 256, text 2,048. Omitted-field names: at most 16 of 64 bytes each. Relations: at most 8.

Plain-data validation rejects accessors, methods, non-plain prototypes, extra fields, deep structures, and oversized inputs before copying their bodies into a reply. The copy has finite node, depth, and byte admission limits. These are cooperative same-process checks, not a JavaScript sandbox. Proxies, infinite synchronous loops, and process crashes cannot be isolated by Pi's event bus. A consumer timeout stops waiting, not provider work. Heavy indexing/enrichment must run elsewhere in bounded workers. Native providers must remain usable without this listener or Recall.
