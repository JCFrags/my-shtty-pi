# ADR-001: Logical sessions and bounded physical shards

Status: records implemented candidate behavior, not milestone acceptance. See the [documentation boundary](../README.md#current-documentation-boundary).

## Context

Pi materializes a physical session branch. Making Chrono's indexes incremental does not remove that physical-file limit. A long-lived branch therefore needs several preserved source files without losing ancestry or exact recovery.

## Decision

Represent a logical session with an owner-only, versioned manifest. Each branch has ordered physical shards and one active shard. Closed routes bind immutable final catalog cuts. Logical forks share parent routes only through an explicit cutoff and exclude siblings.

Adopt a persisted source as shard zero. Use manual guarded rollover to create an empty replacement with a validated continuation. Adoption alone does not bound an already large file. Threshold reporting is advisory, not automatic switching. [ADR-011](ADR-011-logical-session-rollover-integration-with-pi.md) owns the Pi adapter and recoverable transition sequence.

## Alternatives

- One indefinitely growing Pi file leaves Pi's own materialization cost unbounded.
- Physical `/fork` copies the branch and retains that cost.
- Rewriting or joining archived JSONL destroys the source-preservation boundary.
- Automatic rollover is deferred until the manual lifecycle is qualified. It is not implemented by threshold status.

## Consequences

Cross-shard recovery needs valid routing metadata and compatible old stores. A missing ancestor refuses instead of silently hiding history. Manual rollover requires a settled session, an existing regular Pi summary, complete mandatory continuation coverage, and the combined ceiling. The original large-session mandatory overflow remains unresolved.

## Migration

Startup or explicit adoption creates a manifest and appends a non-model binding marker without rewriting prior records. Old catalogs and source shards remain intact. See [logical sessions](../logical-sessions.md) and [migration](../migration.md).

## Reversal path

Stop further adoption/rollover. Recover a pending transition or immediately roll back an unused continuation-only replacement through the validated command. Preserve the replacement and old shards. Once the replacement has user work, immediate rollback is unavailable; retain both routes and use the [recovery runbook](../recovery.md), not source deletion.
