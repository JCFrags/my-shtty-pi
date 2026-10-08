---
title: Logical sessions and safe-idle rollover
audience: [agents, operators, maintainers]
status: current reference
purpose: Explain preserved shard routing, branches, replacement safety, and complete continuation requirements.
related:
  - indexing-and-exact-recovery.md
  - ../state/persistence-and-transfer.md
  - ../operations/troubleshooting-and-rollback.md
---

# Logical sessions and safe-idle rollover

## Compaction is not rollover

Compaction reduces the model's active context. It does not make an old Pi session file smaller. A physical session can still become expensive for Pi to load.

A logical session connects several preserved physical files, called shards. Rollover closes the current shard at a validated cut and starts a smaller replacement containing continuation data and complete required native state. Old files are not rewritten or deleted.

A versioned owner-only manifest records branch ancestry, source routes, final catalog cuts, the active shard, and pending transition identity. This routing data is not a disposable cache. Do not discover replacement routes by directory scanning or similar file names.

## Startup and automatic switching

The normal memory engine can adopt an eligible persisted source as shard zero. Explicit global search disable, exact per-session exclusion, unsafe storage, invalid binding, or unavailable required worker startup can prevent that path.

Automatic rollover defaults on after 8 MiB of new source growth. The configured range is 1–64 MiB. A new shard's bootstrap bytes do not count toward this growth, so a large complete checkpoint does not immediately cause another rollover.

The threshold is checked at safe idle. It is not a byte-perfect cap during an active turn. The switch requires:

- A persisted source, stable leaf, and exact catalog pin.
- No active agent work, compaction, session switch, pending message, or unsent editor draft.
- Safe tool-call/result structure.
- No blocking managed process or persistent shell. If Grounded Process is installed, missing readiness also defers replacement.
- Complete required native provider transfer within its bounds.
- A valid bounded continuation. Optional historical detail can be incomplete, but source identity cannot be guessed.

The readiness wait is finite. Deferred work can try again at a later natural boundary. Internal automatic dispatch has a one-use binding and is not an operator command to copy manually.

## What crosses the boundary

| Data | Transfer |
| --- | --- |
| Historical evidence | Validated manifest routes and a bounded model-visible continuation. Original source stays in old shards. |
| Todo, Notes, Workplan | Complete native checkpoints, including archived records and native history required by the provider. |
| Independent Memory | Verified logical namespace/store binding. It still needs its retained store bytes. |
| Arbitrary third-party extension state | Not automatically migrated. The extension needs an appropriate transfer contract. |

Native transfer allows 8 MiB per provider and 16 MiB aggregate. It does not shorten complete state to fit. A provider can accept a native object that later exceeds transfer admission, especially a large Workplan. Such a session can continue normal operations but cannot safely roll over through this contract until complete transfer is possible.

The finite bootstrap allows at most 12 entries, with a 16 MiB state allowance plus 512 KiB bootstrap allowance. The separate model-visible continuation limit is 256 KiB. These limits do not expand because a larger context token target was selected.

## Operator routes

Use `/Chrono`, then **Maintenance**, then **Logical session**. The same public command accepts action arguments:

```text
/Chrono logical-session adopt [branch-id]
/Chrono logical-session status <logical-session-id> [branch-id]
/Chrono logical-session rollover <logical-session-id> <branch-id>
/Chrono logical-session fork <logical-session-id> <source-branch-id> <new-branch-id>
/Chrono logical-session recover <logical-session-id> [branch-id]
/Chrono logical-session rollback <logical-session-id> [branch-id]
```

Adoption binds the existing file. It does not split it or certify compaction. Status validates the current binding and uses bounded metadata rather than parsing archived shards.

A logical fork creates an empty child physical shard with explicit ancestor cuts. It is not Pi's physical `/fork`, which can copy an existing branch. Normal logical search includes permitted ancestors and excludes siblings. Exact ranges remain shard-local.

## Transition and recovery

The transition records preparation, replacement creation, durable bootstrap, binding, and activation. Pi can emit replacement lifecycle events before the caller finishes. Repeated activation is allowed only for the same recorded operation and exact identities.

Recovery follows manifest state. It can abort an unused preparation, return from an empty replacement, or complete activation of the exact recorded continuation. It refuses unknown replacement contents or mismatched sources.

Immediate logical rollback is restricted to a continuation-only replacement before ordinary new work. It preserves that replacement on an isolated rollback branch. After new work, reopening an old source is not a data-preserving rollback. Use the provider-aware [rollback procedure](../operations/troubleshooting-and-rollback.md).

Existing oversized files can still incur their initial Pi load. Indexing and rollover do not remove that already-incurred cost. Bounded architecture and a successful small replacement check are not billion-token qualification.

[History index](README.md) · [Complete transfer](../state/persistence-and-transfer.md) · [Activation](../operations/activation-and-migration.md)
