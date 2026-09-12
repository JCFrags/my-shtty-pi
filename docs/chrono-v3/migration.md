# Adoption, migration, and schema recovery

Migration is non-destructive preparation of derived data and routing. It is not deployment or automatic approval to compose context. `memoryEngineEnabled` remains false by default; see the [documentation boundary](README.md#current-documentation-boundary).

## Startup adoption and progress

When explicitly enabled, startup validates configuration, the exact session rollout record, logical binding, and worker startup before scheduling indexed work. A persisted exclusion or unsafe route fails closed. A session without a valid binding can be adopted as shard zero only when those checks permit it. Adoption adds a routing marker; it does not truncate, split, or compact the old file.

Catalog, capsule, search, state, and rollup stores own their progress. The [migration status function](../../packages/pi-chrono-compaction/src/session-migration.ts) projects those checkpoints into `disabled`, `unavailable`, `startup`, `catalog`, `capsules`, `index`, `memory`, `rollup`, or `awaiting-cut-validation`. There is no second lifetime migration cursor to reset or reconcile.

Follow the phase meanings in [operations](operations.md#migration-phases) and exclusion precedence in [configuration](configuration.md#session-specific-search-inclusion-and-exclusion). Restart resumes existing checkpoints. Ready layers still require actual cut/category and rendered-budget validation. The original large-session mandatory overflow remains unresolved.

## Different recovery cases

| Condition | Supported boundary |
| --- | --- |
| Ordinary append lag | Resume the same lifecycle and checkpoints. Reads can use a validated compatible older prefix. |
| New catalog generation in a healthy database | Use the explicit catalog rebuild protocol. Old generations remain pinned and source remains unchanged. |
| Corrupt physical catalog | Create a separately identified store through explicit recovery, ingest declared sources, and validate before pointer publication. Do not repair the corrupt database in place. |
| Incompatible capsule/reducer identity | Derive into a new physical identity. Do not relabel old immutable bytes or import a lifetime candidate map. |
| Missing state or rollup | The materializer can create its supported store. A corrupt or incompatible existing store is not equivalent to a missing one. |
| Rollup repair | Stage and step a new store, then explicitly publish it with the expected prior active route. |
| Invalid routing or source identity | Refuse and preserve evidence. Do not discover a replacement by directory scanning or path similarity. |

The [catalog contract](catalog-contract.md), [catalog publication](catalog-store-publication.md), [capsule publication ADR](adr/ADR-003-immutable-segments-and-manifest-publication.md), and [rollup repair](rollups.md#explicit-repair-surface) own the specific protocols. No general `/chrono-repair` interface is implied by the charter's proposed command name.

## Rollback

Disable only the selected feature or restore its recorded compatible route/package through the scoped [recovery runbook](recovery.md). Preserve logical manifests, every source shard, old healthy pins, and failed derived evidence. An older package can ignore unsupported stores; it need not convert or delete them. There is no automatic shard deletion or broad garbage collection.

[ADR-014](adr/ADR-014-schema-migration-and-repair.md) records this strategy. All-session adoption, final default activation, and M12 acceptance require separate runtime and delivery evidence.
