# Logical sessions and physical shards

A logical session joins a branch's bounded physical Pi files through validated routes. It does not concatenate, rewrite, or delete old JSONL. The [candidate boundary](README.md#current-documentation-boundary) still applies: implementation is not ten-shard qualification or M11/M12 acceptance.

## Implemented model

The owner-only manifest records branches, ordered shard IDs, one active shard per branch, source identities, immutable final catalog cuts, and recoverable transition phases. A fork records its exact parent cutoff. Search includes the selected branch and its ancestors through those cuts, not siblings.

Existing-session adoption binds the persisted source as shard zero and appends a non-model adoption marker. It neither reduces that file nor makes a large physical branch small. Automatic adoption requires the configured memory-engine path and valid startup/exclusion checks. See [migration](migration.md).

The logical-store parent must belong to the current user and must not allow group or other users to write. A readable parent such as mode `0755` is valid. The Chrono store root and session directories still require mode `0700`, and manifests require mode `0600`. Symbolic links and unsafe ancestors refuse. Adoption does not change shared parent permissions.

Rollover and logical fork are manual guarded commands. Threshold status only reports reached or remaining limits. It does not schedule automatic switching. Pi's physical `/fork` copies a physical branch and is not a substitute for logical fork.

## Continuation boundary

The operator must use the settled-session checks and exact syntax in [operations](operations.md#manual-logical-session-operations). A rollover or fork requires an empty editor, no pending messages or tool pairs, no active compaction/job/switch, a stable persisted leaf, caught-up source and state, and an existing regular Pi summary.

The continuation must cover each ancestor route at its recorded cut, retain every selected mandatory proposition, and fit the combined ceiling. Adoption, search readiness, and category readiness alone do not satisfy this gate. The original large-session mandatory overflow remains unresolved, so manual rollover is not an escape from that gate.

The command records `close-prepared`, creates an empty replacement through Pi's command API, persists the exact continuation-only source, binds the new shard, and activates it. Pi 0.85.1 can defer a new file until a normal assistant message. The adapter instead persists the bounded public SessionManager bytes without inventing a message, then reloads that same file. Old source is never opened for writing.

Pi emits replacement startup before post-switch callbacks can finish manifest changes. The adapter commits the relevant activation or rollback state, then uses the replacement context's reload. Captured old runtime objects must not be reused.

## Recovery and reversal

[Recovery](recovery.md#interrupted-logical-rollover) owns phase-specific retry and immediate rollback. Recovery uses the exact operation, source, session, continuation, and manifest identities. It does not infer a legal action from a file's presence. Immediate rollback is limited to a continuation-only replacement with no user work. The replacement survives on an isolated rollback branch.

[ADR-001](adr/ADR-001-logical-sessions-and-bounded-shards.md) records the data-model choice. [ADR-011](adr/ADR-011-logical-session-rollover-integration-with-pi.md) records Pi integration and revision-bound findings. Some older paragraphs in ADR-011 describe pending integration at earlier candidates; the current command includes logical fork. The binding owners are the [logical contract](../../packages/pi-chrono-compaction/src/logical-session-contract.ts), [coordinator](../../packages/pi-chrono-compaction/src/logical-session-rollover.ts), [integration](../../packages/pi-chrono-compaction/src/logical-session-integration.ts), and [source persistence adapter](../../packages/pi-chrono-compaction/src/logical-session-persistence.ts).
