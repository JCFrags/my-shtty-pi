---
title: Troubleshooting and rollback
audience: [operators, agents, maintainers]
status: current procedure
purpose: Diagnose bounded failures and preserve source and later native writes during recovery.
related:
  - activation-and-migration.md
  - workers-and-caches.md
  - ../history/indexing-and-exact-recovery.md
---

# Troubleshooting and rollback

## Start read-only

1. Preserve the exact loaded version and safe failure code. Do not publish source text, private paths, or raw diagnostics.
2. Read `history_status` or `/Chrono search-status`.
3. If admission or execution is involved, read `/Chrono worker-status` and `/Chrono doctor`.
4. Identify whether the problem is selection, ordinary lag, an unavailable component, incompatible data, or changed source.
5. Apply only the relevant supported recovery. Preserve source, stores, routing metadata, and the previous installation.

Do not delete stores, remove reservations, stop another session's worker, raise limits, or repeatedly force compaction to make a report look healthy.

## Symptoms and next actions

| Symptom | Meaning to check | Safe next action |
| --- | --- | --- |
| Old `/chrono-*` command missing | Current interface uses one `/Chrono`. | Open the menu or use its documented action argument. Do not reinstall to restore retired names. |
| Page keys scroll chat | Older report UI may be loaded. | Check the loaded identity and whether the focused-overlay correction is present. Use a safe reload only when permitted. |
| Saved setting has no effect | Environment override or startup-captured owner. | Compare effective settings and captured/configured Memory owner. Do not start a second writer. |
| Indexing disabled | Global false setting or exact session exclusion. | Confirm intended selection before changing it. Status does not override policy. |
| `catalog`, `capsules`, `index`, `memory`, or `rollup` phase | That derived checkpoint is behind the requested view. | Preserve progress and allow normal lifecycle work. Queries do not ingest. |
| `awaiting-cut-validation` | Layers report ready at their checkpoints. | Actual composition still validates source, tool structure, budget, and the chosen cut. |
| Worker unit inactive but admission waiting | A stopped live owner may retain a reservation. | Inspect owner identity and bounded diagnostics. Do not reclaim by service state alone. |
| `worker-legacy-transition-required` after replacement | Existing gate was unavailable at startup. | Normal eligible scheduling can recheck that gate. This is not automatic admission repair. |
| Empty search page with `nextCursor` | Bounded postings/routes can be filtered out. | Continue unchanged if the next window is relevant. Do not report global absence. |
| Exact raw read works while search is pending | Catalog route is valid independently of derived search. | Use its bounded continuation. Do not infer that decoded/ranked/range paths are ready. |
| Raw receipt read refuses or returns a partial page | New entry may not be cataloged, scope changed, or offset is wrong. | Initial request uses only the entry locator and needed shard. Continue with returned absolute `nextByte`, never invented zero. |
| Stale or foreign handle | Scope, generation, route, or source differs. | Obtain a fresh compatible handle. Never edit the handle. |
| Source mismatch or truncation | Immutable source assumption no longer holds. | Stop dependent operations and preserve evidence. Do not repoint by path similarity. |
| Recall missing a provider | Native tool hidden, missing listener, pending state, or timeout. | Check active native tools and provider status. Use permitted tool help, then re-query. Do not assume empty state. |
| `state-store-unpersisted` | Pi has no durable session file yet. | Use a persisted session before native writes. Do not report volatile success. |
| Owned provider says legacy/pending | Explicit import or bounded resolution is incomplete. | Follow its native import/resolution procedure at the same view. Do not initialize over it. |
| Memory unavailable after rollover | Same-store binding still needs the preserved store. | Verify the original store and binding. The bootstrap is not a database backup. |
| Rollover deferred | Draft, work, process, shell, unstable cut, or incomplete/oversized state. | Settle the blocking condition safely. Never shorten canonical state. |
| Compaction refused | Unsafe source/tail, changed input, or unusable budget. | Current context remains. Address the exact cause rather than retrying unchanged. |
| Background LLM enabled but idle | Compatibility preprocessing is paused under the normal engine, or budgets/circuit/model are unavailable. | Read status. Do not disable V3/V4 merely to force model activity. |
| Telemetry quality unknown | No caller quality observations. | Report unknown. Tool success and token totals are not quality scores. |
| Telemetry storage full | Fixed slot cap reached, possibly before byte capacity. | Agent work can continue. Stop writers and obtain approval before manual archival/cleanup. |

## Derived-store recovery

Ordinary lag resumes the same checkpoints. Missing derivations can be created by the owning materializer. An existing corrupt, incompatible, or unsafe store is not equivalent to missing data.

Catalog recovery uses an explicitly identified replacement store and validated publication. Capsule/reducer identity changes create a new derived identity. Do not relabel immutable bytes, discover ownership by a directory scan, or overwrite a corrupted content-addressed object.

Historical state clause checkpoints require a compatible materializer. Exact state-gap repair has its own versioned ruleset. Older binaries can refuse repaired stores even for reads. Preserve pending repair and original coverage rather than downgrade its marker.

Rollup repair is explicit and bounded:

```text
/Chrono rollup-repair start <repair-id>
/Chrono rollup-repair step <repair-id>
/Chrono rollup-repair status <repair-id>
/Chrono rollup-repair publish <repair-id> <legacy|expected-store-id>
```

Run this only for an authorized specific repair, with preserved source and a stable cut. Each invocation performs one transition. Publish requires a complete validated target and the recorded prior route. `legacy` names the original store route, not a bypass. Old stores and handles remain. There is no general public arbitrary-pointer restore command.

Detailed protocol owners: [catalog publication](../../chrono-v3/catalog-store-publication.md), [state repair](../../chrono-v3/episodes-and-state.md#explicit-historical-state-gap-repair), and [rollup repair](../../chrono-v3/rollups.md#explicit-repair-surface). Their old command spelling is superseded by `/Chrono` above.

## Three different rollbacks

### Immediate logical rollback

`/Chrono logical-session rollback <logical-session-id> [branch-id]` returns from a matching continuation-only replacement before ordinary new work. The manifest and bootstrap must match. The replacement remains preserved on an isolated rollback branch.

For an interrupted transition, use the matching `recover` action first. It can abort preparation, return from an empty replacement, or finish the exact recorded binding. Do not infer the legal action from file presence alone.

### Code-selection rollback

Restore only the affected registration/configuration values and compatible retained package root. Preserve unrelated later settings. Do not restore a whole old settings document. Verify the complete loader, then reload only safe target sessions and confirm their loaded hashes.

A code rollback does not authorize service restarts, gate changes, source deletion, or removal of provider stores. An older package must support the active checkpoint/schema. Otherwise leave the incompatible writer disabled and use a supported return path.

### Data-preserving rollback after new writes

1. Stop concurrent state mutations at a stable source cut.
2. Capture complete current Todo, Notes, and Workplan state. Refuse if pending, corrupt, changed, or over the transfer bounds.
3. Create a fresh replacement with the latest full native checkpoints before any legacy provider events. A checkpoint appended after old state is invalid.
4. For Memory, export to three new private files: the fresh target's actual V2 sidecar, the complete native companion, and the receipt. Supply the exact expected store cut and explicit target turn.
5. Verify source-prefix preservation, artifact digests, complete accepted-head semantics, proposals/metadata in the companion, and actual old native source-known reads. Check legacy pinned-retention differences separately.
6. Recheck no pending or later independent writes, then select exactly one compatible old writer.
7. Keep original source, replacement source, independent stores, companion, receipts, and both package roots.

Reverse Memory export does not activate a writer and does not create the fresh continuation. A partial artifact pair is not a valid export. If conversion cannot preserve exact accepted state, refuse instead of normalizing away a difference.

Later writes under the old V2 writer are not automatically reconciled back into the previous independent store. A future return must preserve and reconcile those writes rather than select stale heads.

## Report the result precisely

Separate restored code selection, loaded process identity, state preservation, and practical behavior. State which sessions remain on old code and which legacy branches still need import. A passing build, preview, loader, or old scenario is not proof that every current process works.

[Operations index](README.md) · [Activation and migration](activation-and-migration.md) · [Provider transfer](../state/persistence-and-transfer.md)
