# Context Kit Recall

Separately source-loaded Pi extension, `src/index.ts`. Its only tool is `context_recall`. It reads one bounded page of useful **current** Todo, Notes, and Workplan cards, then returns native read-only recovery instructions. It does not replace Chrono's exact historical recall.

Example: `context_recall({query:"rollover", providers:["todo","notes","workplan"]})`. Empty query means browse. Native adapters use up to 16 case-insensitive terms formed from Unicode letters, numbers, underscores, and hyphens. They match any term and rank results, not literal phrases. Categories are optional. A provider's native tool must already be active. Recall never calls `setActiveTools`, invokes tools, bypasses Progressive Tools, or enables missing tools. Use the ordinary tool-help route before a later query if needed.

## Result and bounds

Each requested provider receives its own status and, for a valid reply, readiness, scan coverage, exclusions, and whole cards. Failures, malformed data, and missing/late responses do not discard a healthy peer. Missing listeners and asynchronous timeouts are indistinguishable and are reported as `missing_or_timeout`. If the session/leaf changes, results refuse that stale view. A provider that becomes inactive loses its cards before return.

`complete` is true only when every requested provider is ready, reports complete scanning, excludes no matching records, and reports no incomplete card fields. This is the provider's bounded current-state claim, not an independent proof of historical or semantic completeness. Native revisions are current-state markers. Recovery can return a newer revision. Re-query with a narrower query/category/provider or use the supplied native recovery instead of assuming a global cursor exists.

| Control | Default | Accepted range |
| --- | ---: | ---: |
| `records` per provider | 6 | 1–16 |
| `scan` per provider | 128 | 1–512 |
| `providerBytes` complete wire reply | 8,192 | 2,048–16,384 |
| `maxBytes` complete serialized tool result | 16,384 | 4,096–32,768 |
| `waitMs` common deadline | 150 | 10–1,000 |

Only three providers and six categories are supported in V1. The fixed registry is a limited first slice. Additive provider descriptors belong in the later design. Query text is at most 512 UTF-8 bytes. See `../protocol/README.md` for field and transport bounds.

The final budget includes every provider's metadata, request scope, limits, exclusions, recovery instructions, JSON escaping, and Pi's content/details wrapper. Whole cards are removed when needed. Card bodies are not duplicated in `details`. The extension does not write files, scan archives, use models or networks, inject context implicitly, or create a central database.

Providers share Pi's JavaScript process. This supports cooperative exception/timeout isolation, not protection from synchronous hangs or process crashes. A timeout does not cancel arbitrary provider work. Native read tools and state stores remain independent of Recall.

## Focused check

From the repository root after locked workspace dependencies are present:

```sh
node --experimental-transform-types --test packages/pi-context-kit/recall/test/recall.test.ts
```

The two factory checks use Pi's real event bus with small source-known providers. They exercise healthy plus missing/malformed/late/throwing peers, inactive-tool gating, full-result budgeting, whole-card recovery, and changed-view refusal. They are not a live-Pi activation or LLM-benefit measurement.
