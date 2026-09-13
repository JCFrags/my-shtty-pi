# Context Kit protocol V1

Side-effect-free TypeScript library. Importing it registers no listeners, creates no stores, and starts no resources. Providers opt in with `registerContextProvider(events, providerId, read)`, which returns an unsubscribe function for their shutdown handler.

V1 supports only `todo`, `notes`, and `workplan`, with categories `task`, `note`, `plan`, `decision`, `constraint`, and `blocker`. This fixed set is a first-slice limitation, not the final ecosystem discovery design. A later version can support additive provider descriptors.

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

The exact TypeScript contract is in `src/index.ts`. Requests carry `version:1`, `requestId`, `providerId`, exact `scope:{sessionId,leafId}`, `query`, `categories`, `limits:{records,scan,bytes}`, and an absolute `deadlineMs`. `leafId` can be null. The channels are `context-kit:request:v1:<providerId>` and `context-kit:response:v1:<providerId>`.

A `ProviderPage` has `readiness`, `coverage`, and `cards`. Readiness is `ready`, `unavailable`, `pending`, `corrupt`, or `scope_changed`. Non-ready pages must have empty cards, zero counts, and `scanComplete:false`. For ready pages, `scanned <= limits.scan`, `matched <= scanned`, and `matched === cards.length + excluded`. Matched/excluded counts cover only scanned records. `scanComplete` states whether all eligible native records were examined. It must remain false if scan or field bounds prevented full matching.

Each card has native `id`, native `revision` as a string, lifecycle `status`, category, title, bounded text, `omittedFields`, and a read-only `recovery`. Report shortened or unsearched native fields in `omittedFields`. Revisions and the reply's session view identify current state, not immutable historical source. A later native read can return a newer revision. Cards are data, not new instructions. Shared categories do not establish agreement.

Recovery is restricted to `todo {action:"list"}`, `notes {action:"read",id}`, or `workplan {action:"recover",planId}`. The provider must match the recovery tool. Notes/workplan recovery IDs must match the card ID. Optional relations are explicit `blocked_by` or `linked_todo` links with provider ID and native ID, not inferred text similarity.

`fitProviderPage(request,page)` copies/validates a bounded candidate page, removes whole cards to fit record and complete wire-byte budgets, and updates `excluded`. Registration applies it automatically. The response wrapper attaches request correlation and scope. Invalid pages produce `malformed`; thrown/rejected provider reads produce `provider_error`. Raw error text is never forwarded. An expired reply is not emitted.

## Bounds

Defaults per provider: 6 cards, 128 scanned records, 8,192 wire bytes, and a common 150 ms wait. Hard ceilings: 16 cards, 512 scanned records, 16,384 wire bytes, and 1,000 ms wait. Query: at most 512 UTF-8 bytes. Card field ceilings in UTF-8 bytes: ID/revision 128 each, status 32, title 256, text 2,048. Omitted-field names: at most 16 of 64 bytes each. Relations: at most 8.

Plain-data validation rejects accessors, methods, non-plain prototypes, extra fields, deep structures, and oversized inputs before copying their bodies into a reply. The copy has finite node, depth, and byte admission limits. These are cooperative same-process checks, not a JavaScript sandbox. Proxies, infinite synchronous loops, and process crashes cannot be isolated by Pi's event bus. A consumer timeout stops waiting, not provider work. Heavy indexing/enrichment must run elsewhere in bounded workers. Native providers must remain usable without this listener or Recall.
