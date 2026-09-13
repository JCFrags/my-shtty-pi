# Chrono Memory Engine operations

## Current operating boundary

These procedures describe the default-on V3 source behavior. They do not prove that an existing process loaded the accepted build. Use the runtime identity and practical checks below. The baseline needs no language-model call. Explicit search, session, and engine exclusions remain effective.

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

`awaiting-cut-validation` is not a compaction pass. Source compatibility and the effective token budget are checked against each selected cut only when the composer or continuation builder runs. Restriction/work completeness is reported, not required as a global verbatim inventory.

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

## Automatic logical-session rollover

Normal V3 startup adopts the persisted physical session as logical shard zero unless an explicit exclusion or unsafe binding prevents it. At `agent_settled`, automatic rollover checks for 8 MiB of source growth by default. It defers for an editor draft, pending messages, active compaction or switch, unsafe tool structure, or Grounded processes and persistent shells. When Process is installed, an absent readiness responder also defers. The final Process before-switch guard rechecks live resources.

The finite readiness wait is 60 seconds. The exact source leaf must be catalog-pinned, but optional state and rollup lag can use bounded programmatic continuation. Deferred work can be retried at a later natural boundary. A source threshold is a safe-idle trigger, not a byte-perfect cap during an active turn.

Dispatch uses Pi 0.85.1's supported `pi.sendUserMessage(command, { expandPromptTemplates: true })` route. Pi resolves the one-shot registered command before model preflight. The handler receives a real `ExtensionCommandContext` and calls `ctx.newSession`. It does not write editor text, fabricate a context method, or place slash text in model history.

Before replacement, installed Notes, Tasks (`todo`), and Workplan providers export exact active-state checkpoints through `grounded-state:checkpoint-request-v1`. Missing, duplicate, pending, corrupt, out-of-scope, or oversized responses refuse the switch. The detached checkpoints become non-model `grounded-state-checkpoint-v1` custom entries before the continuation. Each provider is limited to 8 MiB and the total to 16 MiB. No checkpoint is silently shortened. The bootstrap still permits at most eight entries. Its total byte limit is 16 MiB plus the existing 512 KiB bootstrap allowance. The separate model-visible continuation limit remains 256 KiB.

New shards require the configured source growth beyond their serialized bootstrap size. This prevents a large checkpoint from causing immediate repeated rollover. Restart reconstructs that baseline from at most eight bootstrap entries. Pi startup still loads the active physical file, and logical binding discovery reads its current branch once. An already oversized legacy physical file therefore still has a one-time load cost. Normal V3 compaction and automatic rollover do not rebuild or traverse lifetime history.

To disable automatic switching, use `/chrono-compact-settings automatic-rollover off`. Check `automaticRollover` in `history_status` for the threshold, bootstrap bytes, and last deferral.

## Manual logical-session operations

Physical Pi `/fork` is not a logical fork.

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
- the exact source cut is catalog-pinned;
- installed state providers support bounded checkpoints;
- the source identity and branch leaf are stable.

The command independently pins the cut, selects useful existing memory or bounded fallback, validates the continuation, and captures exact provider checkpoints. It creates a replacement session, writes the checkpoints and continuation, persists that finite bootstrap, binds the manifest, and activates the new shard. Source or structural failures refuse. Budget-driven omissions produce selective history with recovery cues, not a false completeness claim.

Pi can emit replacement `session_start` after setup but before `withSession`. Startup recovery can therefore activate the operation first. Repeated activation succeeds only for that exact committed operation, continuation hash, active shard, session ID, and source path. Do not use a captured command context after successful replacement or reload.

### Fork

Use:

```text
/chrono-logical-session fork <logical-session-id> <source-branch-id> <new-branch-id>
```

The fork uses the same cut and continuation gates as rollover. It creates an empty child physical shard with explicit parent catalog ancestry. Searches include ancestors by default and exclude siblings. Do not use Pi's physical `/fork` as a substitute.

### Recover or roll back

Use the procedures in [`recovery.md`](./recovery.md). Do not guess from the presence of a replacement file. The manifest phase and recorded binding decide the legal action.

After a checkpoint-bearing rollover, keep checkpoint-aware Grounded providers installed. Older providers cannot restore the new native checkpoints. To use those older providers, explicitly reopen the preserved original source instead of treating a package downgrade as state restoration.

## Composition behavior

When the memory engine is selected, Pi first prepares a cut and retained tail. ChronoCompact chooses a small dynamic tail and composes chronological history from compatible stored memory or bounded active-branch fallback. An independent Pi summary is optional and disabled by default. The model-validated `targetContextTokens` limit covers the returned summary and raw tail. See [context composition](context-composer.md) for finite bounds and refusal rules.

Source incompatibility, unsafe tool structure, cancellation, or unusable budgets leave current context unchanged. Missing optional memory, provider summary, or diagnostic artifact storage does not require refusal. Details identify `chrono-v3-composed-context`, the composition envelope or fallback receipt, optional `piSummary`, and `retainedTail`. No normal fallback uses legacy lifetime replay.

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

Do not reload a session with an editor draft, active tool, streaming response, compaction, session switch, or managed job. A synthetic ready status alone does not prove local activation or practical behavior.

## Focused practical check

After building the source, run `node packages/pi-chrono-compaction/scripts/v3-core-pi-check.mjs <absolute-built-extension.js> <new-private-root>`. The check needs installed Pi 0.85.1 and the package's locked dependencies, including native SQLite. It uses an isolated agent directory and synthetic state. It selects installed model metadata for context-capacity validation without authentication. It retains its sources and does not alter live settings or call a model.

The check exercises default adoption, guarded registered-command dispatch, a real physical-file switch, exact fixture checkpoint persistence, restart, and the large-bootstrap growth threshold. Its `agent_settled` boundary and provider states are synthetic. Verify actual Grounded Notes, Tasks, and Workplan restore separately in the integrated installation.

Keep remote integration, loaded local identity, practical compaction, physical switching, and original large-session behavior separate. This procedure is not a lifetime-scale campaign or proof that every live process has reloaded.
