# M10 logical-session completion report

Status: source candidate. Publication, merge, installation, activation, and shared-session adoption are pending parent integration.

## Identity

- Base: main `d9c5f1f`.
- Package version remains `2.0.23`.
- Installed Pi API inspected: `@earendil-works/pi-coding-agent` 0.85.1.
- Scope: `logical-session*.ts`, the focused logical-session fixture, and ADR-011.

## Implemented behavior

- `adoptExistingSessionAsShardZero` is a startup-safe, idempotent adoption API. It creates only the requested logical store or returns the exact existing owner, branch, Pi session ID, and source path. Conflicting retries refuse.
- A non-model adoption binding can activate shard 0 after exact manifest and live-session identity validation. It does not grant or inherit a composer canary.
- Manual same-branch continuation is proven through ten physical shards. Every closed route remains pinned to its immutable catalog cut.
- Manual logical fork creates an empty child shard through Pi `newSession`, retains an exact parent catalog cut, preserves the parent branch, includes ancestors by default, and excludes siblings. It intentionally does not use Pi physical `/fork`, which copies ancestor records into the child file.
- Exact route selection remains explicit by shard ID. The ten-shard fixture checks each closed route and newest-to-oldest bounded continuation.
- Recovery can reopen the exact old session after Pi creates an empty replacement but fails before setup. The replacement must contain only bounded Pi bootstrap metadata and have the exact old parent header.
- Rollback preserves the replacement shard on an isolated rollback branch. A later rollover on the restored branch cannot accidentally include an unpinned abandoned shard.
- Threshold evaluation reports reached and remaining configured byte, record, compaction, and estimated-token thresholds. It is read-only. Rollover remains manual.
- Manifest validation now checks shard ordinal order, one active shard per branch, explicit fork cuts, parent ownership, and branch cycles.

## Safety properties retained

- Source JSONL is not rewritten or deleted.
- Continuation still requires exact source cut, complete protected and open-work coverage, no omitted mandatory proposition, a safe tail, and the combined context ceiling.
- Forks and rollovers use the existing proposition-complete continuation gate.
- Ancestor routes use existing pinned catalogs and stores. Missing or mismatched routes refuse.
- No provider call, live source read, shared configuration change, worker pool, reload, installation, or automatic rollover was used.

## Focused verification

Passed on Node 24.18.0:

```text
npm run typecheck
rm -rf dist-test && npx tsc -p tsconfig.test-build.json && node --test --test-concurrency=1 dist-test/test/logical-session-rollover.test.js
```

The focused fixture passed 2/2 tests. No broad scale or multi-agent campaign belongs to this change. M11 owns that qualification.

## Required parent hook integration

1. During restartable existing-session migration, construct the known `LogicalSessionStore` and call `adoptExistingSessionAsShardZero` with the exact current `getSessionId()` and `getSessionFile()`. Persist `logicalAdoptionBinding(manifest, branchId)` once as a `chrono-logical-adoption` custom entry. Do not require a slash activation.
2. On `session_start`, parse `recordedLogicalAdoptionBinding(getBranch())`. Resolve it with `resolveAdoptedLogicalActivation`. Treat the returned grant as routing authority only. Keep deployment authorization and per-cut V3 readiness separate.
3. Add a manual logical-fork command action only if the parent integrates M10 fork UI now. Build the same source-pinned continuation candidate used by rollover, then call `ManualLogicalRollover.fork({ sourceBranchId, targetBranchId }, candidate, eligibility, commandPort)`.
4. In manual recovery, if `close-prepared` is observed from an empty replacement with the exact parent header, call `reopenPreparedFromEmptyReplacement(commandPort, replacementContainsOnlyBootstrap(entries))`.
5. Use `logicalSessionStatus` for safe status output. Supply measurements from already known bounded lifecycle state. Do not scan source to populate status.

## Unverified criteria

- End-to-end search, recall, and exact reads across ten real on-disk per-shard stores were not rerun. Existing per-shard store behavior and logical routing are composed in the focused fixture; M11 must run the consolidated scale campaign.
- Physical `/fork` interception is not implemented. The supported initial path is an explicit manual logical fork that creates an empty child shard.
- Automatic rollover remains disabled.
- Shared-session migration, restart reconciliation, merge, deployment, and live activation are parent-owned and pending.
