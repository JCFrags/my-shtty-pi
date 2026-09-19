---
title: Current-state Recall
audience: [agents, maintainers]
status: current reference
purpose: Explain bounded cross-provider current-state queries and the route to complete native evidence.
related:
  - ../state/README.md
  - ../history/indexing-and-exact-recovery.md
  - ../../../packages/pi-context-kit/recall/README.md
---

# Current-state Recall

`context_recall` finds bounded current-state cards from available Memory, Todo, Notes, and Workplan providers. It is not a historical search, a central database, or an automatic prompt injector.

Example:

```json
{"query":"release blocker","providers":["memory","todo","notes","workplan"],"records":6,"maxBytes":16384}
```

Empty query means browse. Up to 16 case-insensitive terms match any term in admitted fields and are ranked. This is not semantic similarity or literal phrase matching.

## Active tools and independent providers

Memory requires active `memory_get`. The other providers require their same-named native tool. Recall never enables tools, bypasses Progressive Tools, invokes recovery commands, initializes a store, imports legacy state, or scans the archive.

If a required native read tool is hidden but permitted, use normal exact-name `tool_help` and call Recall again on a later response. Do not treat a hidden provider as an empty store.

Providers can be absent or fail independently. A healthy page survives another provider's missing listener, malformed reply, exception, or timeout. Missing listeners and late asynchronous replies both appear as `missing_or_timeout`. Changed scope or newly inactive tools invalidate affected results.

## What a card means

A card preserves native ID and revision, lifecycle, category, bounded text, omitted fields, declared relations, and read-only recovery. Categories are `task`, `note`, `plan`, `decision`, `constraint`, `blocker`, `knowledge`, and `proposal`. Proposals require explicit category selection and remain separate from accepted knowledge.

Todo dependencies and Workplan-to-Todo links are references, not synchronized state. A missing relation target does not mean the dependency is complete. Cards do not grant authority.

Memory recovery pins the exact captured revision. Todo, Notes, and Workplan recovery can return a newer current record. Compare revisions rather than treating later native state as a byte-identical snapshot of the card.

## Bounds and completeness

| Control | Default | Allowed range |
| --- | ---: | ---: |
| Cards per provider, `records` | 6 | 1–16 |
| Examined records per provider, `scan` | 128 | 1–512 |
| Complete provider reply, `providerBytes` | 8,192 bytes | 2,048–16,384 |
| Complete tool result, `maxBytes` | 16,384 bytes | 4,096–32,768 |
| Common wait, `waitMs` | 150 ms | 10–1,000 |

Provider-specific bounds can be lower. The final budget includes metadata, scope, coverage, recovery, JSON escaping, and the tool wrapper. Whole cards are removed to fit. An excerpt is not silently presented as a complete native record.

`complete` requires every requested provider to be ready, complete scanning, no excluded matches, and no incomplete card fields. Even then, it describes bounded current-state coverage, not semantic truth or all historical evidence.

There is no global Recall continuation cursor. Narrow the query, provider, or category. Follow native recovery for complete state or historical tools for original conversation evidence.

## Connection to compaction

Recall and the V4 compiler use the same pure `collectContext` library. Recall returns a query result when called. The compiler captures cards at its own frozen boundary and can select some into a compaction receipt.

Neither operation creates a transaction across providers. Native revisions and scope are evidence of the captured records, not proof that all providers were read at the same instant.

Providers share Pi's JavaScript process. Cooperative deadlines contain waiting, not arbitrary synchronous hangs or process crashes. Read the [protocol contract](../../../packages/pi-context-kit/protocol/README.md) before adding a connector.

[Context index](README.md) · [Native state](../state/README.md) · [Historical recovery](../history/indexing-and-exact-recovery.md)
