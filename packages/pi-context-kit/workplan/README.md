# Independent Workplan

This package registers the native `workplan` tool. It owns branch-local persistence independently of Todo, Notes, Memory, Recall, and Chrono. It does not import the old Workplan extension factory or use a live tool to recover source state.

Use one writer. Do not load this entrypoint together with `packages/grounded-tools/workplan/index.ts`.

## Native behavior

The package uses Grounded's pure Workplan reducers and renderers. It preserves native plan revisions and SHA-256 revision records, child IDs and counters, decisions, evidence, checkpoints, lifecycle gates, and `expectedRevision`. It retains argument aliases, bounded `recover`, recovery markers, and the version-1 Glance summary/activity contracts. Restore sends summary invalidation, not replayed activities.

Supply a nonempty top-level `rationale` for `revise`, `record_decision`, `pause`, `resume`, `complete`, and `archive`. The shared schema marks this field optional because other actions do not accept it. `record_decision` uses `content: { decision }` and keeps the reason in `rationale`, not inside `content`.

Milestone status uses `pending`, `in_progress`, `blocked`, and `completed`, not Todo's `done`. Start a pending milestone before completing it. Completion requires evidence and completed dependencies.

A checkpoint records project state. It does not grant new authorization. Linked Todo IDs are unverified external references, not synchronized tasks.

## Storage and bounds

The default private directory is `$XDG_STATE_HOME/pi-context-kit/workplan/`, or `~/.local/state/pi-context-kit/workplan/` when that variable is unset. `@context-kit/state-store` supplies immutable publication, source-scoped binding indexes, and Pi anchor verification. Each Workplan extension has its own owner instance and transaction queue.

- The root manifest has a 1 MiB canonical limit. It contains native global counters, at most 256 plan references, bounded metadata, and one active Glance summary.
- Each native plan is a separate immutable object. The 64 MiB canonical-plan limit includes its complete native revision history. The storage envelope has a separate 512-byte allowance.
- At most 64 plans can remain open, and at most one plan can be active. Manifest checks enforce these rules when a selected plan changes.
- A separate per-plan projection object has a 64 KiB limit. It contains query-independent Context fields and a status preview. The projection cache retains at most 128 objects.
- Startup and one-plan operations never hydrate unrelated native plans. Complete transfer is the explicit exception.
- Input admission checks bytes, depth, JSON properties, and nodes before native traversal. Selected-object reads and writes use bounded asynchronous file I/O. CPU validation, native rendering, cloning, and digest work still depend on the admitted selected plan and its collections. This is not constant-cost processing. No worker framework is included.

`list` reads manifest metadata. Titles have a 512-byte preview and objectives have a 1024-byte preview. Omissions name the complete `read` route. `status` returns exact cached aggregate counts with a status preview of at most 32 KiB. It does not load the native plan. `read` and `recover` load exactly one native object and use the native renderers. Large complete output uses Grounded's private full-output file and exact truncation notice.

Context requests load only bounded projection objects, scan at most 128 records, and retain native plan revisions in cards. The provider answers both protocol versions 1 and 2. Native-tool exclusions still apply. Context queries never start legacy import or create canonical state.

## Commit and branch lifecycle

A mutation stages the selected immutable plan, bounded projection, native event, and root before the owner appends a small Pi anchor. The owner verifies the live anchor and its bounded on-disk append, syncs the source, and publishes the binding before Workplan exposes the new state or emits activity. `message_end` is not a durability acknowledgment.

Each owned commit ID is separate from `WorkplanState.stateRevision` and the selected plan's native revision. Exact native events remain reachable through the anchored root's `event` reference. Tool results include the normal event when it is at most 32 KiB. Larger events use `eventRef`. The `ownerProtocol` marker identifies these results as projections of an owned commit, not legacy writes.

An object without a verified anchor is an orphan, not selected state. A failed or uncertain append is reconciled before another write. The default policy requires an existing persisted Pi session file. Ephemeral or deferred sessions do not receive a false durable success. Objects and source JSONL remain intact after failures.

Branch lookup uses direct owned bindings or one bounded indexed ancestry page. A pending lookup advances on a later call. It never calls `getBranch()` or guesses empty state. Empty state is valid only after complete ancestry proves that this provider has no state. Native fork/clone inherits a verified owned anchor, and subsequent writes create a separate source-bound commit.

## Legacy import

For an old branch, run `/workplan-import` until it reports a complete durable binding. Each command advances either one 32-entry source page or at most four native events. The owner stores a small progress pointer for the exact source session and leaf. Reopen that same cut and repeat the command to resume after restart. An explicit JSON object reference can also be supplied as the command argument.

The importer retains normalized native provider entries, source-page digests, IDs, counters, revisions, and a complete import receipt. It leaves the original source JSONL unchanged. These normalized evidence objects are not claimed as byte-for-byte copies of original JSONL lines. Unrelated conversation bodies are not copied into a second history store.

Legacy checkpoints retain their native 8 MiB admission gate. A checkpoint after earlier Workplan state is corrupt. Ordinary legacy native events can use the selected-plan limit plus envelope space. Failed or oversized imports do not select a shortened or empty root.

A fresh rollover session can bootstrap automatically in one bounded lifecycle call. Its complete ancestry must fit one 32-entry page and contain exactly one native Workplan checkpoint with no Workplan events before or after it. Longer or ordinary legacy branches use the explicit resumable importer.

## Complete transfer and rollback

Only the asynchronous version-2 transfer provider is registered. `WorkplanStore.capture(host, maxBytes, signal)` returns:

```ts
{
  state: WorkplanState,
  owner?: {
    version: 1,
    providerId: "workplan",
    commitId: string,
    parentCommitId: string | null,
    rootRef: ObjectRef,
    anchorId: string,
    origin: { sessionId: string, leafId: string | null },
    durability: "disk" | "ephemeral" | "deferred",
    importReceipt?: ObjectRef
  }
}
```

Capture refuses pending, corrupt, unbound, changed-scope, or oversized state. It checks complete native byte admission before loading plan objects and rechecks the source cut, owner commit, and lifecycle after loading. Complete transfer retains the existing 8 MiB/provider, 200,000-node, depth-32 gates. The shared transfer collector also checks the complete response and the 16 MiB aggregate limit.

The transfer entrypoint returns the mandatory `grounded-state-checkpoint-v1` containing all native plans and counters. It can also return `context-kit:owner-binding:v1` with the owner metadata above. This second entry preserves provenance, not a trusted direct root binding. Bootstrap validates the complete native checkpoint and does not use an unvalidated metadata root as state.

After new writes, rollback requires a fresh replacement session with the latest complete V1 checkpoint before any legacy provider state. Returning to the pre-import session loses those writes. Appending a checkpoint after old Workplan events fails the native loader. Keep the owned objects, receipts, and original sessions for the return path. Refuse before switching writers if complete capture cannot fit.

## Integration API

`createWorkplanExtension(pi, { storeRoot?, ancestryPageEntries? })` returns the owner-backed `WorkplanStore`, which permits isolated private fixtures. Public package exports also include the schema, store, `importWorkplanStep`, `finishWorkplanImport`, and `bootstrapWorkplanCheckpoint`.

An import step returns an immutable cursor reference and progress. A completed cursor still needs `finishWorkplanImport` to create its verified Pi binding. `stagePlan` and `stageNativeState` only prepare objects. They do not make those objects visible as committed state.

Use Node 24 and the installed Pi extension API. This package performs no model calls, selection changes, cleanup, or deployment. Whole installed-Pi rollover and rollback acceptance belongs to the integrating application.
