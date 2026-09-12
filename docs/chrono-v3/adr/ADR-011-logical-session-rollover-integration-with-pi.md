# ADR-011 — Logical-session rollover integration with Pi

Status: implemented through package 2.0.28. Installed-Pi qualification established both the continuation-only source durability requirement and a post-rollback runtime rebind requirement. A focused rollback lifecycle correction is prepared for the next package. Consolidated approval and deployment verification remain pending. Automatic rollover remains disabled.
Scope: owner-only logical manifests, existing-session adoption, continuation validation, manual session replacement, logical forks, recovery, rollback, threshold status, and ancestor routing.

## Context

A physical Pi JSONL file cannot remain the lifetime container for V3. M10 must preserve each old file while a logical branch continues in a new physical session. The initial 2.0.22 package pinned Pi 0.84.2. The main-promotion candidate targets the actually installed Pi 0.85.1 and declares peers `>=0.85.1 <0.86.0`.

Pi 0.85.1 exposes session replacement only on `ExtensionCommandContext`. `newSession()` accepts `parentSession`, `setup(SessionManager)`, and `withSession(ReplacedSessionContext)`. `switchSession()` accepts `withSession`. Replacement context also exposes `reload()`. These calls are not available in ordinary event handlers because replacement can deadlock there. The installed `agent-session-runtime.js` creates the replacement manager, shuts down the old runtime, applies the new runtime and emits its `session_start`, then runs `setup`, rebinds the host UI and runs `withSession`. Thus replacement extensions start before continuation metadata exists and switched extensions start before `withSession` can commit a corresponding manifest transition. Captured old session objects are stale after replacement.

Pi 0.85.1's public `SessionManager` has no flush method. It assigns a new source path immediately but defers file creation until the first normal assistant message. A continuation-only replacement therefore remained memory-only while the logical manifest retained its source. Adding a fabricated assistant message would violate continuation-only rollback and source semantics.

## Decision

M10 starts with an explicit extension command adapter. There is no automatic rollover.

The logical-session core is separate from `pi-extension.ts` and from the existing search adapter. The command adapter supplies only:

- a settled-state snapshot with persisted-session, streaming, pending-message, compaction, session-switch, active-tool-pair, complete-tail, catalog-catch-up, and source-leaf facts;
- one source- and branch-bound M09 continuation candidate;
- the pinned `newSession()` and `switchSession()` command methods;
- the replacement `SessionManager` passed by `setup` and `withSession`.

The coordinator performs this recoverable sequence:

1. Validate that the command runs at a settled boundary and that the catalog is complete through the exact source leaf.
2. Validate that the continuation has complete protected and open-work counts, no omitted mandatory row, a safe tool-pair tail, and no combined-context overflow.
3. Require the continuation coverage list to equal every ancestor shard route in order. Each earlier shard must match its immutable final catalog cut. The current shard must match the continuation source cut. A new shard cannot hide an old missing obligation.
4. Publish a `close-prepared` manifest intent and mark the current shard `closing`.
5. Call `newSession({ parentSession })`.
6. In `setup`, verify Pi's parent header and append one source-linked continuation custom message. Before manifest binding, the Pi adapter serializes the public manager's exact version-3 header and ordered continuation-only entries with Pi's JSONL newline encoding. It bounds the entry count and bytes, publishes only the manager-generated new path through an exclusive owner-only temporary file and no-overwrite hard link, fsyncs the file and directory, then calls public `setSessionFile()` on the same path. This reload preserves the session ID, header, parent, entries, and source while synchronizing Pi's later append state. An exact existing source is accepted only after owner, mode, link-count, size, and byte equality checks. The old shard is never opened for writing. The manifest then binds the durable replacement session ID and file; the old shard becomes closed but remains untouched.
7. In `withSession`, use only the replacement context, verify its identity, and publish the active rollover receipt.
8. Reload the replacement through its supported command context, then return without using stale context. Startup can now bind the completed manifest and continuation. The provisional logical replacement must not schedule work or initialize admission before setup.

A crash before durable source creation leaves `close-prepared`; reopening the empty replacement can switch to the exact parent and remove that intent after the reopened identity matches. A crash after durable creation but before manifest binding leaves an exact continuation-only source. Reopening that source can finish binding only when its one recorded operation ID, continuation hash, summary hash, parent path, session ID, and source path match the pending manifest. A crash after binding leaves `new-shard-bound`; the replacement identity can finish activation. Recovery does not delete an orphan source, and no step deletes or rewrites an old shard.

Exact rollback uses `switchSession(oldPath, { withSession })`, verifies the reopened Pi session ID and file, and changes the logical active pointer only after the supported switch succeeds. Pi starts the resumed runtime before `withSession`, so the callback commits the rollback manifest and then calls the replacement context's supported `reload()`. The reloaded startup validates the committed old-shard activation instead of retaining the safe disabled state from the pre-commit startup. Prepared-rollover recovery uses the same commit-then-reload order after it removes the prepared intent. A canceled switch does not run the callback and leaves the manifest unchanged. A reload failure leaves the committed manifest and every source available for a later normal reopen. Rollback is allowed only while the replacement contains its injected continuation and no user work. The replacement shard remains intact on an isolated rollback branch, so later continuation of the restored branch does not route through an unpinned abandoned shard.

An existing persisted session can be adopted as shard 0. Adoption writes one non-model `chrono-logical-adoption` custom entry containing only the manifest, branch, and shard identifiers. Startup must match that marker to the exact manifest session ID and source path before it grants logical tools. Adoption does not grant the composer canary.

A manual logical fork uses the same empty-session replacement and validated continuation path as rollover. The parent branch remains active. The child branch records the exact immutable parent catalog cut and owns a new shard at ordinal 0. Child routing includes ancestors only through that cut and excludes siblings. This deliberately does not use Pi's physical `/fork`, which copies the old physical branch and would duplicate ancestor source in the child shard.

The manifest is schema-versioned, integrity-hashed, revision-checked, atomically replaced, and stored in owner-only directories and files. It contains private source routes and is never a public diagnostic payload.

Search integration receives ordered `LogicalShardRoute` values from the logical core. Routes include only the selected branch and its ancestors through each fork point. `scheduleLogical(grant)` is available only after the active session ID, source path, binding, and manifest active shard match. It reuses the existing per-shard lifecycle and contained stores for each immutable final cut. Search runs newest-to-oldest in pages of at most eight shard routes. Recall routes by its pinned view. Exact entry and range calls require an explicit shard ID when they target an ancestor. Logical pagination binds the cursor to the logical session, manifest revision and hash, branch, route index, and existing store cursor. Sibling branches and stale manifests refuse.

Threshold evaluation is read-only. It reports reached and remaining configured source-byte, record, compaction, and estimated-token thresholds. It never starts a rollover. M10 keeps `rolloverMode` manual until a later sustained canary proves automatic operation.

## Implemented candidate and verification

The 2.0.22 candidate implements the versioned manifest, owner-only store, strict continuation validator, recoverable manual rollover coordinator, exact rollback, logical activation grant, startup reconciliation, and existing-store ancestor routing. The `/chrono-logical-session` command supports adoption, status, rollover, recovery, and rollback. A valid logical grant enables only the exact replacement session. It does not inherit the M09 composer canary. Startup for both logical replacements and requested disposable canaries is read-only and requires an already admitted worker host.

State-v4 packed representations are counted at proposition granularity. The candidate expands the primary item and all `coveredPropositions`, validates their shared `representationKey`, deduplicates by proposition `stableKey`, and credits the group only when the exact shared representation appears in the rendered mandatory artifact. Incomplete scans, exhausted restriction or open-work selection, omissions, response-budget loss, rendered overflow, source mismatch, or unsafe tool pairing refuse rollover.

The initial focused core fixture passed once. It exercised owner-only files, exact manifest revisions, coverage refusal, recoverable phases, rollback rules, and ancestor route isolation. A separate disposable check used the real pinned Pi 0.84.2 SDK. It exercised `newSession()` setup, runtime rebind before `withSession`, and `switchSession()` without a provider call. Package typecheck passed after both M09 merges. No further local runtime invocation ran during 2.0.22 packaging. The routine workflow selects these two existing M10 fixtures and the corrected M09 producer fixture. Its result belongs to the pushed candidate receipt.

The package 2.0.28 installed-Pi run established the missing rollback order. After exact rollback, fresh readiness waited 150 seconds and reported `search-v3-rollout-unsafe` with no requested or indexed cut. The final manifest was valid and retained both sources. Pi's pinned implementation and a focused real-Pi lifecycle fixture confirm that resumed `session_start` occurs before `withSession`, while a reload after the callback observes its committed state. The focused logical-session fixture confirms that rollback and prepared recovery commit the manifest before reload. This evidence supports the explicit rebind correction, not a readiness timeout change.

## Limitations

Rollover remains an explicit owner command. Automatic rollover, fork creation, shared-session switching, inherited canary activation, provider handoff, broker restart, and Pi core replacement are not implemented or authorized. Ancestor routing requires every old store and immutable final cut to exist and validate; it refuses missing history instead of ingesting or reconstructing it. Old physical shards remain immutable. The candidate is packaged for review only and is not installed or active.

## Alternatives considered

- Keep the initial Pi 0.84.2 pin. Superseded for main promotion because it does not match the installed Pi 0.85.1 replacement lifecycle. The earlier disposable proof remains historical evidence only.
- Call `SessionManager.newSession()` directly from an event handler. Rejected because this bypasses runtime teardown, extension rebind, switch cancellation, and fresh-context rules.
- Use an automatic `agent_settled` handler. Deferred. The first useful M10 is manual and cannot change sessions outside a command context.
- Spawn a new Pi process or use a provider handoff. Rejected because this adds another runtime and can cause an unauthorized provider call.
- Copy the complete active branch with `fork()` or `clone`. Rejected because it preserves the physical lifetime-size problem.
- Store one logical archive by rewriting or joining old JSONL. Rejected because exact shards are immutable authority.

## Consequences

Rollover has a short interval in which Pi has already applied the replacement runtime while the manifest still records a pending operation. The explicit phases and identity checks make this interval recoverable, but the future extension adapter must reconcile pending state on `session_start` and show only safe codes.

The continuation custom message participates in the new shard context. Its summary is derived memory, not exact evidence. Its metadata retains source and recovery bindings. No provider call is made solely for rollover. The command requires an existing regular Pi summary, then reads the M09 selection pinned to the current leaf. Eligible and covered mandatory counts come from those selected records and the rendered artifact. Missing source evidence, omissions, an unsafe tool-pair boundary, catalog lag, source change, or overflow refuses the switch.

Cross-shard search can issue bounded calls to more than one existing store. It remains bounded by the requested result limit and cursor. It does not scan source JSONL or build an index.

## Migration

An explicit adoption adapter creates a new logical manifest with the current persisted session as shard ordinal 0. Adoption does not ingest, compact, switch, or modify that session. The first rollover remains unavailable until the catalog and mandatory continuation requirements pass.

Fork integration creates a branch with an explicit parent branch, ancestor cutoff shard, and exact cutoff catalog view. No sibling route is inherited. The core operation is implemented, but its extension command/event adapter is pending integration. Shared activation remains unapproved.

## Reversal path

Do not register the manual command, or remove its integration while retaining the owner-only manifest and every source shard. A pending pre-bind intent can reopen the old shard. An unused bound replacement can roll back through pinned `switchSession()`. A disposable SDK check against pinned Pi 0.84.2 exercises real `newSession()` setup, runtime rebind before `withSession`, and `switchSession()` without a provider request. Existing single-shard search and compaction paths remain unchanged. Packaging and a draft review request do not authorize deployment, provider calls, automatic rollover, Pi core changes, shared activation, or old-shard deletion.
