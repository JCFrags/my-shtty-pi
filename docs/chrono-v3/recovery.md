# Chrono Memory Engine recovery

## Recovery rules

Pi session JSONL is authoritative. Preserve every old shard and failed derived generation. Recovery can change a derived store, routing manifest, feature selection, or deployed package. It must not edit or delete source history.

Before any recovery action:

1. Stop new Chrono background work at a settled session boundary.
2. Preserve the current package identity, Chrono-owned configuration, rollout records, logical manifests, source files, and derived stores.
3. Run `history_status`, `/chrono-worker-status`, and `/chrono-doctor` where available.
4. Record the public safe error without copying source text or private paths into Git.
5. Select the narrow recovery below.

## Catch-up and store refusal

For ordinary lag, keep the existing store and restart the same lifecycle. The catalog, capsule, search, `state-v4`, and `rollup-v3` checkpoints own progress. Do not reset a catalog or create a separate migration cursor.

If a derived store is missing, the scheduler can create it through its materialization operation. If a store exists but is corrupt, incompatible, unsafe, or bound to another source view, the read path refuses. Do not delete that store merely to force creation. Preserve it for diagnosis, then use a reviewed rebuild or quarantine procedure outside the interactive query path.

A ready older prefix can remain searchable while a newer requested cut catches up, but only after prefix compatibility is validated. Status fields must distinguish `requestedCut`, `indexedCut`, `processedCut`, and `knownThroughCut`.

## Interrupted logical rollover

Use:

```text
/chrono-logical-session recover <logical-session-id> [branch-id]
```

The command supports these current states:

- If the manifest is `close-prepared` and Pi is still on the exact old source, recovery aborts the preparation and reopens the old shard.
- If Pi created an empty replacement that contains only bounded bootstrap records, recovery switches back to the exact old source.
- If the replacement contains the exact recorded continuation binding, recovery completes binding and activation.

Recovery refuses when the current source, session identity, branch, operation ID, continuation hash, or bootstrap shape does not match the pending manifest. Do not fabricate a source, append a normal assistant message, or bypass the bootstrap-only check.

The `30668f7` correction persists the exact continuation-only replacement source because Pi `0.85.1` can defer that file until a normal assistant message. The writer validates all public SessionManager bytes and uses no-overwrite publication. If the target already exists, only exact byte, owner, mode, link, and identity equality is accepted.

## Immediate logical rollback

Use only from the continuation-only replacement at a settled boundary:

```text
/chrono-logical-session rollback <logical-session-id> [branch-id]
```

The current branch must contain the matching logical binding and only the allowed continuation/bootstrap records. The command switches to the exact old source. It preserves the replacement shard on an isolated `rollback.<operation-id>` branch so that later rollover cannot silently include that abandoned sibling.

Rollback does not delete a shard or derived store. It does not prove that an installed package rollback works.

## Search and exact-recovery problems

- If a search handle refuses with a scope or version error, rerun `history_search` against the current ready generation. Do not alter the handle.
- If logical search returns no hit and a `nextCursor`, continue. One call checks at most eight shard routes.
- If decoded exact recovery is partial, continue with `startChar=nextChar`.
- If raw event recovery returns base64 bytes and `nextByte`, continue with `startByte=nextByte`.
- If an exact range is partial, continue with its pinned `nextCursor`. Ranges do not cross shards.
- If a logical route is unavailable, verify that its source file still exists and its recorded catalog cut remains compatible. Do not repoint the route by path alone.

A missing derived artifact reduces capability. It does not invalidate the exact source. A source replacement, truncation, prefix change, or missing pinned cut is different: stop and investigate the source identity mismatch.

## Native state after rollover

V3 transfers complete Notes, Todo, and Workplan state as native `grounded-state-checkpoint-v1` custom entries. This includes archived records, IDs, counters, and Workplan revision and checkpoint history. The transfer does not replace tool state with prose or replay old shards into the new active file. Invalid, pending, or over-budget state prevents rollover rather than being shortened or discarded.

Install the checkpoint-aware Grounded providers with V3. A provider from before this change cannot restore these entries. After rollover, retain the new providers when changing Chrono code. To return to old provider code, first use a verified logical rollback to the preserved original source. Immediate logical rollback is unavailable after ordinary work begins in the replacement. Do not reopen an older source as if it included later work, or restore old providers over a checkpoint-bearing session.

## Deployment rollback

An installed-package rollback requires a previously verified Chrono package and a safe process boundary:

1. Disable new Chrono feature flags and stop new background work.
2. Confirm all target Pi sessions are settled and editors are empty.
3. Restore the prior Chrono package source slot or alias atomically.
4. Restore only the compatible Chrono-owned configuration and startup authorization for that package.
5. Preserve logical manifests, old source shards, catalogs, and derived stores. Require the prior package to support the active source and bootstrap format. Retain checkpoint-aware Grounded providers after V3 rollover. An unsupported generation is a compatibility limit, not permission to discard it.
6. Reload each target session safely.
7. Verify loaded entrypoint and deployment-manifest hashes in each process.
8. Run a small status and bounded exact-recovery check. If compaction is in scope, verify one safe compaction separately.
9. Record success, failures, and sessions not reloaded.

Do not restore an entire settings snapshot. It can overwrite unrelated package selections. Do not report rollback as exercised unless the prior package was loaded by the intended processes and the practical checks passed.

## Rollback triggers

Stop activation and use the scoped rollback procedure for:

- Pi startup or extension-load failure;
- repeated worker failure or unavailable containment;
- source identity mismatch;
- invalid source references;
- missing mandatory restrictions or open work;
- false completion in composed context;
- a combined-context ceiling violation or compaction loop;
- unexplained cross-session blocking;
- an unexpected provider call;
- a migration that modifies source;
- loaded runtime hashes that do not match the intended deployment.

## Historical evidence boundary

This section records the original `2.0.25` check, not the current release status. Use the [current overview](README.md#current-documentation-boundary) for the release evidence boundary.

At that revision, a `2.0.25` installed-Pi run completed one rollover and immediate logical rollback. It then found that Pi had not persisted the retained continuation-only replacement source. The source-persistence correction is implemented and focused with the actual Pi SessionManager, but the full installed-Pi scenario has not been rerun.

Therefore:

- logical rollback behavior before the correction is partial evidence only;
- the corrected ten-shard actual retry remains pending;
- final-package deployment rollback remains unexercised;
- no default activation or N-of-N live-session recovery claim is valid.
