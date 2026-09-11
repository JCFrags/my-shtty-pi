# ADR-011 — Logical-session rollover integration with Pi

Status: implemented in the 2.0.22 M10 repository candidate. It does not authorize deployment, shared activation, or automatic rollover.
Scope: owner-only logical manifests, continuation validation, manual session replacement, recovery, rollback, and ancestor routing.

## Context

A physical Pi JSONL file cannot remain the lifetime container for V3. M10 must preserve each old file while a logical branch continues in a new physical session. The installed global Pi is 0.85.1, but this package pins `@earendil-works/pi-coding-agent` 0.84.2 and declares a peer range below 0.85.0. The decision therefore uses the actual 0.84.2 declarations and implementation.

Pi 0.84.2 exposes session replacement only on `ExtensionCommandContext`. `newSession()` accepts `parentSession`, `setup(SessionManager)`, and `withSession(ReplacedSessionContext)`. `switchSession()` accepts `withSession`. These calls are not available in ordinary event handlers because replacement can deadlock there. In the pinned implementation, Pi checks `session_before_switch`, creates the replacement manager, shuts down the old runtime, applies the new runtime, runs `setup`, rebinds extensions, and then runs `withSession`. Captured old session objects are stale after replacement.

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
6. In `setup`, verify Pi's parent header, append one source-linked continuation custom message, and bind the replacement session ID and file in the manifest. The old shard becomes closed but remains untouched.
7. In `withSession`, use only the replacement context, verify its identity, and publish the active rollover receipt.

A crash before binding leaves `close-prepared`; reopening the old session can remove that intent. If the continuation was appended before the failure, the replacement can finish binding only when its one recorded operation ID, continuation hash, summary hash, parent path, session ID, and source path match the pending manifest. A crash after binding leaves `new-shard-bound`; the replacement identity can finish activation. No step deletes or rewrites an old shard.

Exact rollback uses `switchSession(oldPath, { withSession })`, verifies the reopened Pi session ID and file, and changes the logical active pointer only after the supported switch succeeds. Rollback is allowed only while the replacement contains its injected continuation and no user work. The replacement shard remains closed and intact.

The manifest is schema-versioned, integrity-hashed, revision-checked, atomically replaced, and stored in owner-only directories and files. It contains private source routes and is never a public diagnostic payload.

Search integration receives ordered `LogicalShardRoute` values from the logical core. Routes include only the selected branch and its ancestors through each fork point. `scheduleLogical(grant)` is available only after the active session ID, source path, continuation hash, and manifest active shard match. It reuses the existing per-shard lifecycle and contained stores for each immutable final cut. Search runs newest-to-oldest in pages of at most eight shard routes. Recall routes by its pinned view. Exact entry and range calls require an explicit shard ID when they target an ancestor. Logical pagination binds the cursor to the logical session, manifest revision and hash, branch, route index, and existing store cursor. Sibling branches and stale manifests refuse.

## Implemented candidate and verification

The 2.0.22 candidate implements the versioned manifest, owner-only store, strict continuation validator, recoverable manual rollover coordinator, exact rollback, logical activation grant, startup reconciliation, and existing-store ancestor routing. The `/chrono-logical-session` command supports adoption, status, rollover, recovery, and rollback. A valid logical grant enables only the exact replacement session. It does not inherit the M09 composer canary. Startup for both logical replacements and requested disposable canaries is read-only and requires an already admitted worker host.

State-v4 packed representations are counted at proposition granularity. The candidate expands the primary item and all `coveredPropositions`, validates their shared `representationKey`, deduplicates by proposition `stableKey`, and credits the group only when the exact shared representation appears in the rendered mandatory artifact. Incomplete scans, exhausted restriction or open-work selection, omissions, response-budget loss, rendered overflow, source mismatch, or unsafe tool pairing refuse rollover.

The initial focused core fixture passed once. It exercised owner-only files, exact manifest revisions, coverage refusal, recoverable phases, rollback rules, and ancestor route isolation. A separate disposable check used the real pinned Pi 0.84.2 SDK. It exercised `newSession()` setup, runtime rebind before `withSession`, and `switchSession()` without a provider call. Package typecheck passed after both M09 merges. No further local runtime invocation ran during 2.0.22 packaging. The routine workflow selects these two existing M10 fixtures and the corrected M09 producer fixture. Its result belongs to the pushed candidate receipt.

## Limitations

Rollover remains an explicit owner command. Automatic rollover, fork creation, shared-session switching, inherited canary activation, provider handoff, broker restart, and Pi core replacement are not implemented or authorized. Ancestor routing requires every old store and immutable final cut to exist and validate; it refuses missing history instead of ingesting or reconstructing it. Old physical shards remain immutable. The candidate is packaged for review only and is not installed or active.

## Alternatives considered

- Use the current global 0.85.1 API. Rejected because the package runtime is pinned to 0.84.2.
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

Fork integration creates a branch with an explicit parent branch and ancestor cutoff shard. No sibling route is inherited. It remains unimplemented. The manual command and startup reconciliation are wired for owned disposable sessions only; shared activation remains unapproved.

## Reversal path

Do not register the manual command, or remove its integration while retaining the owner-only manifest and every source shard. A pending pre-bind intent can reopen the old shard. An unused bound replacement can roll back through pinned `switchSession()`. A disposable SDK check against pinned Pi 0.84.2 exercises real `newSession()` setup, runtime rebind before `withSession`, and `switchSession()` without a provider request. Existing single-shard search and compaction paths remain unchanged. Packaging and a draft review request do not authorize deployment, provider calls, automatic rollover, Pi core changes, shared activation, or old-shard deletion.
