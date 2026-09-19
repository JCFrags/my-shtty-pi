# Owned state store API

Runtime target: Node 24.18.0 and Pi 0.85.1. No runtime dependency on another provider, Chrono, or a Pi extension factory. No global store, queue, or mutable singleton.

## Provider integration

```ts
import { BranchStateOwner } from "@context-kit/state-store";

const owner = new BranchStateOwner<NativeRoot>({
  providerId: "notes", // or todo/workplan
  storeRoot, // optional exact private fixture directory
  validateRoot,
  isLegacyEntry, // classify this provider's old state events/checkpoints
  rootMaxBytes: 2 * 1024 * 1024,
});
const host = { sessionManager: ctx.sessionManager,
  appendEntry: (type: string, data: unknown) => pi.appendEntry(type, data) };
const resolved = await owner.resolve(host);
// pending: call resolve again later. Each call advances one bounded ancestry page.
// legacy: run the provider's explicit bounded importer. Never substitute empty state.
// empty: the complete ancestry contained neither an owned anchor nor legacy state.
// ready: resolved.snapshot.root is detached and recursively frozen.
const committed = await owner.commit(host, nextRoot, {
  expectedCommitId: resolved.status === "ready" ? resolved.snapshot.commitId : null,
});
```

`resolve(host, {signal?})` returns `OwnerResolution<Root>`. It uses direct bindings or at most `ancestryPageEntries` native `getEntry()` calls. Continuation state is persisted per exact source view. No `getBranch()` call or unlimited replay exists. `status()` is synchronous. `invalidate()` increments this instance's epoch and clears its selected view. Call it before a session-tree transition/rebind. `close()` prevents further work. Neither method deletes objects.

Providers must serialize their full `resolve`/compute/`commit` transaction across every tool, command, and Glance mutation route. The owner refuses concurrent commit work and detects stale roots, but does not queue the provider's computation.

`commit(host, root, options)` returns `OwnedSnapshot<Root>`. It requires the exact resolved view and `expectedCommitId`. The provider computes its native mutation, including native revision checks. The store verifies the scope again after asynchronous work. An immutable root/object and prepared receipt precede a small `context-kit:state-anchor:v1` custom entry. The exact live entry and bounded disk append are verified and synced before disk success. A thrown append can leave a live or partial anchor. Such an operation becomes uncertain, and `resolve` reconciles it before another mutation.

Default commit policy is `require-disk`. A missing session path is `ephemeral`; an assigned path with no persisted file is `deferred`. These cases fail before an anchor unless `durability:"allow-volatile"` is explicit. Volatile success reports its actual durability and must not be advertised as a persisted provider checkpoint. Owned objects can be durable while their Pi binding is not. If Pi later materializes a deferred anchor, the root remains readable but retains its original non-disk durability report. A new verified disk commit establishes the new boundary.

## Per-plan objects

`owner.objects` is an `OwnedObjectStore` with lazy initialization:

```ts
const planRef = await owner.objects.publish(plan, { maxBytes, validate: validatePlan, signal });
const plan = await owner.objects.read<Plan>(planRef, { maxBytes, validate: validatePlan, signal });
const location = await owner.objects.location();
```

Workplan keeps references and bounded metadata in its root manifest. It can read/publish one plan and commit a new manifest without reading any other plan body. The store does not inspect provider fields or traverse child-object references.

Stateless exports: `openObjectLocation(options)`, `publishObject(location,value,options?)`, `readObject(location,ref,options?)`, and `readAncestryPage(manager,options)`. Public interfaces are in `src/types.ts`, re-exported by `src/index.ts`.

Objects use exclusive publication, SHA-256 and exact byte verification, no-follow private paths, and file/directory sync. New owned directories are mode `0700` and files are mode `0600`. Existing Pi source files must be regular, owned, single-link, and not writable by other users. The source check does not change existing permissions. The anchor boundary syncs the Pi file and its directory chain. Existing corrupt/missing objects fail. The store never creates empty state to replace a failed read/import. Objects and committed receipts are immutable. Bounded binding/resolution records are derived indexes. The implementation keeps only a finite binding cache and one selected root.

## Legacy import boundary

Small durable progress pointers use `await owner.readProgress<T>(host, key)` and `await owner.writeProgress(host, key, value)`. Keys are nonempty opaque strings up to 128 UTF-8 bytes. Values are bounded plain JSON. Each record includes exact session/leaf and source identity, with a 64 KiB total record cap. The owner rechecks its epoch, source, and live scope after I/O. Different views have different keys on disk. Store bulk pages/staged roots as immutable objects and keep only their references in progress. Providers serialize progress calls with their other transaction work. These methods do not add a lock or commit/anchor state.

`readAncestryPage(manager,{fromEntryId,maxEntries?,maxBytes?,signal?})` returns detached native entries newest first, a canonical page digest, and `nextEntryId`. Pi keeps absent optional fields as `undefined` in memory. The page omits those object fields, as Pi JSONL does. This normalization applies only to source pages. Owned state still rejects `undefined`. Providers retain page references or a source-manifest object and replay their own validated events oldest first. They must handle source/checkpoint coverage explicitly. An oversized entry refuses the page; it is never shortened. Object and import-page `maxBytes` accept up to 128 MiB, so a 64 MiB canonical Workplan plus its native event envelope can be imported. Defaults remain smaller. This does not raise the 8 MiB native transfer cap. Canonical serialization uses the existing `stableJson` key ordering (`localeCompare`), with bounds before copying/traversal. Its node budget is `max(1_000_000, ceil(maxBytes / 2))`, with the existing 64-level depth guard. This finite budget permits every admitted 64 MiB plain JSON shape without reducing existing byte admission. Small roots and progress records keep the original node cap. `rootMaxBytes` bounds the root payload. The object wrapper has an additional bounded 512-byte allowance.

After proving a complete selected native state, call `commit` with `importReceipt:{importer,source,coverage,evidence?}`. Source scope must match the pinned import view. Coverage includes complete status, exact source digest, and scanned/provider counts. An immutable deterministic import receipt is retained with the root. Repeated imports use the same canonical receipt/root references. A failed import does not authorize an empty commit.

## Failure and transfer rules

An unanchored object is an orphan, not selected state. An anchor plus exact object can repair a missing derived binding. An uncertain append cannot be treated as a rollback. Do not delete a lock left by a crashed process without verifying that its owner stopped. Locks are private to one provider/source and have no timeout-based ownership theft.

Native fork/clone can preserve anchor IDs while re-chaining parents. Inherited anchors retain their original committed receipt and are selected only through the native selected ancestry. A new write creates a new source-bound commit.

This library does not implement a shortened transfer format. Complete native transfer remains 8 MiB/provider and 16 MiB aggregate. Providers must assemble their complete state or refuse. Root manifests and Recall cards are not complete transfer checkpoints.
