# Chrono Memory Engine operations

## Current operating boundary

These procedures apply to the candidate at `30668f7586781410e9958fc56d8f677d08bc7d4e`. They do not authorize activation, deployment, reload, a provider call, or a qualification campaign.

The packaged version is `2.0.25`. `memoryEngineEnabled` defaults to off. The continuation-only shard persistence correction is present, but its installed-Pi ten-shard retry has not run. Treat status output as local process evidence only.

## Startup check

After a safe session start or reload:

1. Run `history_status` or `/chrono-search-status`.
2. Check `loaded.state`, version, entrypoint hash, and deployment-manifest hash. A captured identity proves loaded bytes, not a Git commit or coverage.
3. Check `startup.state`. Indexed work is unavailable until startup is `ready`.
4. Check `migration.phase`, each derived layer, `requestedCut`, `indexedCut`, and `lag`.
5. Check `lastSafeError`, the exact session rollout state, and logical route count.
6. Run `/chrono-worker-status` if startup or catch-up is blocked.
7. Run `/chrono-doctor` for bounded read-only source, ledger, scheduler, containment, and memory-admission checks.

`history_status` does not ingest, scan source, or query the databases. A value can become stale until a lifecycle event schedules more work.

## Migration phases

The read-only migration status is derived from existing checkpoints:

- `disabled`: the memory engine is off.
- `unavailable`: search is disabled, startup is unavailable, a safe error exists, or the rollout is unsafe.
- `startup`: worker startup is not ready.
- `catalog`, `capsules`, or `index`: that indexed layer has not reached its requested cut.
- `memory`: `state-v4` is absent or behind.
- `rollup`: `rollup-v3` is absent or behind the materialized state cut.
- `awaiting-cut-validation`: all checkpoint layers report ready.

`awaiting-cut-validation` is not a compaction pass. Mandatory restrictions and open work are checked against each selected cut only when the composer or continuation builder runs.

If catch-up stops, preserve all stores and inspect the safe error. Restart resumes catalog, capsule, index, state, and rollup checkpoints. Do not create a second migration cursor, reset source identity, or delete a store to make status appear ready.

## Search and recall

Use this bounded sequence:

1. Call `history_search` with a specific query and a token budget.
2. Follow `nextCursor` until the required logical routes or index pages have been checked.
3. Pass a hit handle to `history_recall` for a bounded expansion.
4. Pass the returned recovery handle to `history_get` for exact evidence.
5. Continue exact decoded text with `startChar` or raw JSONL bytes with `startByte=nextByte`.

Indexed search supports ranked, exact literal, and supported regular-expression modes. Use `scan: true` only for an explicit bounded lexical or regular-expression scan. Inspect partial and coverage fields. Do not treat an empty first page as proof that no later logical shard contains a match.

`history_recall` levels have different meanings:

- `cue` returns compact search cues.
- `episode`, `resource`, and `state` read source-backed `state-v4` records.
- `rollup` reads closed historical intervals from `rollup-v3`.
- `block` or a recovery handle expands bounded exact content.

Rollup closure is chronological interval closure, not task completion. State and rollup output is derived memory, not current authority. Use `history_get` before relying on exact wording or a decisive historical claim.

`history_range` requires start and end entry IDs. In indexed logical mode, specify `shardId` when the entry is outside the active shard. A range cannot cross physical shards. Follow `nextCursor` for bounded exact pages.

## Manual logical-session operations

Automatic rollover is disabled. Physical Pi `/fork` is not a logical fork.

### Adopt

Use:

```text
/chrono-logical-session adopt [branch-id]
```

Adoption binds the current persisted source as shard zero. It does not roll over or grant composer eligibility. A conflicting prior binding refuses.

### Inspect

Use:

```text
/chrono-logical-session status <logical-session-id> [branch-id]
```

Status is valid only when the current Pi session and source match an active branch shard. Source bytes come from file metadata. Record and compaction counts come from Pi's already loaded physical branch. Status does not parse archived source.

### Roll over

Use only at an agent-settled boundary:

```text
/chrono-logical-session rollover <logical-session-id> <branch-id>
```

Before the command, confirm:

- the editor contains no draft;
- Pi is idle and no message is pending;
- no tool call lacks its result;
- no compaction, managed job, or session switch is active;
- search, `state-v4`, and the exact source cut are caught up;
- a regular Pi summary already exists;
- the source identity and branch leaf are stable.

The command independently pins the cut, selects mandatory state, validates the continuation, creates an empty replacement session, writes the logical continuation, persists the continuation-only source, binds the manifest, and activates the new shard. Any failed gate refuses without weakening coverage.

### Fork

Use:

```text
/chrono-logical-session fork <logical-session-id> <source-branch-id> <new-branch-id>
```

The fork uses the same cut and continuation gates as rollover. It creates an empty child physical shard with explicit parent catalog ancestry. Searches include ancestors by default and exclude siblings. Do not use Pi's physical `/fork` as a substitute.

### Recover or roll back

Use the procedures in [`recovery.md`](./recovery.md). Do not guess from the presence of a replacement file. The manifest phase and recorded binding decide the legal action.

## Composition behavior

When the memory engine is selected, Pi first prepares a cut and retained tail. ChronoCompact validates that cut before it calls the regular Pi summary. It then composes from the pinned `state-v4` selection and compatible rollup material, retains the Pi summary and raw tail, and checks the 30,000-token combined ceiling.

A failure cancels compaction and leaves current context unchanged. It does not silently use the legacy lifetime replay. The minimal Pi compaction details identify `chrono-v3-composed-context` and carry the bounded composition envelope. Detailed artifacts stay in owner-only local storage.

`/chrono-composition-preview [compaction-entry-id]` is read-only with respect to source and activation. It resolves a recorded compaction through the catalog, saves a bounded private comparison artifact, and shows a receipt. It does not replace context.

## Deployment and reload safeguards

A deployment is separate from configuration and migration:

1. Use an exact accepted committed source revision and its locked dependencies.
2. Build and verify the complete package and native SQLite binding together.
3. Verify package metadata, `dist`, deployment manifest, compiled entrypoint, and configuration projection.
4. Preserve the current Chrono package source slot, package alias, Chrono-owned settings, startup authorization, and rollback assets.
5. Change only Chrono-owned registration values. Do not restore a complete settings snapshot over another package's newer selection.
6. Refresh the complete live Pi process roster. A changed package source or symlink does not prove that a process loaded new bytes.
7. Reload one settled session at a time. Pi reload emits shutdown events and can cancel managed jobs.
8. After reload, verify loaded runtime identity, automatic tools, migration progress, actual cut gates, and bounded search-to-recall-to-exact recovery.
9. Record blocked coverage and sessions not yet reloaded separately.

Do not reload a session with an editor draft, active tool, streaming response, compaction, session switch, or managed job. Do not enable the memory engine globally merely because one synthetic session reaches `awaiting-cut-validation`.

## Evidence still required

This documentation does not supply these results:

- a corrected installed-Pi ten-rollover, fork, restart, ancestor recovery, and source-preservation pass;
- the original `state-v4` catch-up result;
- the exact final-candidate M11 core scale campaign;
- default-on behavior or all-session adoption;
- N-of-N live process reload and activation evidence;
- an exercised deployment rollback at the final candidate;
- remote `main` integration or a deployed SHA match.

Keep those evidence streams separate. A core campaign does not prove Pi switching. A logical-session scenario does not prove billion-token scale. A rollback check is not an exercised rollback.
