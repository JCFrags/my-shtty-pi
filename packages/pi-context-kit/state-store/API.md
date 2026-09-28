---
title: Owned state store API
audience: [maintainers]
status: implemented contract
purpose: Specify provider-owned immutable state, source anchors, bounded resolution, and import boundaries.
related:
  - ../../../docs/chrono/state/persistence-and-transfer.md
  - ../README.md
---

# Owned state store API

Read the [persistence and complete-transfer guide](../../../docs/chrono/state/persistence-and-transfer.md) for the system-level contract. This page owns the storage integration API.

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

Continuation records retain the original leaf's native signature in the optional `head` field. Completion can therefore publish that leaf's binding after several pages or an owner restart. Later ordinary messages can reach the completed binding instead of repeating the full ancestry walk. Old records without `head` remain readable. A resumed old record recovers the signature with one counted entry read. With a one-entry page, that call saves the signature and the next call advances ancestry.

A changing leaf can also reuse incomplete progress. After the normal anchor, legacy, and completed-binding checks, the bounded walk may load a cursor for an ancestor it actually reached. The provider store, session, source key, and ancestor scope must match. A reusable cursor must have recorded progress and a `head` matching that native entry's signature. Headless candidates are not shortcuts. The current cursor keeps its own original head and key, adopts the saved next position, and combines both legacy flags with logical OR. A completed empty/legacy cursor can finish that ancestry scan, but it cannot supply a ready owned root. An unvisited sibling cursor is never eligible.

Each candidate lookup requires a counted native entry visit. There are at most `ancestryPageEntries` additional cursor lookups, each bounded to 64 KiB. No native read exceeds the existing page budget. `coverage.scanned` counts reads charged to this original view, including head recovery. It does not add reused cursors' counters or count unique ancestry edges. The shortcut trusts the saved interval under the existing stable-native-ancestry and private-derived-index assumptions. The head signature covers ID, parent, type, and custom type, not the complete skipped payloads or source prefix. Normal snapshot and source-anchor validation still govern readiness.

Existing headed cursors need no migration. If an old cursor origin is too far away, a new bounded call establishes a current cursor that a later short continuation can reach. This prevents loss of pending progress, not new lag during inactivity. A distant anchor can still require several calls, including across cold owners. When newly appended entries consume the page budget, completion is not guaranteed. Explicit source recovery and legacy import retain their separate pinned-view requirements.

Code-rollback limit: ancestor-cursor reuse does not change the version-1 cursor or binding formats. Head-aware predecessor owners can resume these saved positions at the same view, but lose moving-leaf reuse. Older owners, including the local 4.0.4 selection, reject resolution records that contain `head` because they validate exact keys. Old-cursor admission, immutable objects, committed receipts, and source bytes remain unchanged. Keep compatible owner code and rollback evidence. Do not clear indexes or rewrite canonical state to force a rollback.

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

## Source identity across reboot

Disk records keep the observed device number for strict live-operation checks. On Linux Btrfs, new records also contain `identity:{scheme:"linux-btrfs-statfs-v1",filesystemId,birthtimeNs}`. Durable matching requires this identity plus the same absolute path, session ID, inode, and complete-header SHA-256. Resolution verifies the exact committed anchor line at its recorded offset, length, and SHA-256. It does not accept matching metadata in place of that proof. Source growth is allowed. Truncation below the required proof is not.

Btrfs `statfs().f_fsid` mixes the on-disk filesystem ID with the persistent subvolume root ID. This distinction matters because snapshots can preserve inode numbers. See the [Btrfs subvolume contract](https://btrfs.readthedocs.io/en/latest/Subvolumes.html) and [`btrfs_statfs` implementation](https://github.com/torvalds/linux/blob/master/fs/btrfs/super.c). This is not a general guarantee about `f_fsid` on other filesystems. Btrfs `temp_fsid` cloned-filesystem mode also mixes a device value and can still refuse after a mount change. Filesystem clones with duplicated identities are not a supported transfer mechanism.

Node's `statfs` omits `f_fsid`. For Btrfs only, capture invokes `/usr/bin/stat --file-system --format=%t:%i -- /proc/self/fd/3` with the already checked source descriptor inherited as FD 3. It uses no shell or source-path interpolation. Output is capped at 128 bytes, and a 2-second deadline kills the child. Each capture uses one child. A Btrfs source without GNU stat, `/proc`, or a positive birth time refuses rather than falling back to a weaker identity. Other filesystems and platforms keep strict device matching. They do not receive automatic reboot continuity or this legacy recovery path.

Capture and proof verification check the held descriptor and named file before and after I/O. Device, inode, ownership, single-link status, mode, size, modification time, and change time remain live-operation guards. A durable match never relaxes these checks during a running operation. These checks are not a sandbox against a malicious process with the same user ID.

`captureSourceIdentity(manager)` captures this identity without opening an owned store, synchronizing the source, or writing an index. In contrast, `resolve`, provider status, and provider recovery can write derived indexes and are not filesystem-read-only diagnostics.

## Explicit recovery of old disk commits

Old disk records have no durable `identity`. An unchanged device/inode/path/session/header remains compatible. A device change returns `state-store-source-recovery-required`, not a claim that immutable object bytes are damaged. Normal resolve, import, and startup do not authorize or perform recovery.

Recovery requires independently established **complete source-prefix bytes and SHA-256**, not a new hash of the source being accepted. A retained pre-change snapshot or independently verified, contiguous archive spans can supply that evidence. The prefix starts at byte zero, ends with a newline, and must include the entire committed anchor. Missing proof means refusal. There is no force or evidence-gap mode.

1. Stop competing provider writes and tree moves. Preserve original source, owned store, and previous code selection privately. Do not remove locks or alter old commits.
2. Identify the selected provider anchor, exact `commitRef`, existing committed receipt, and old commit's complete `source`. Verify the independent prefix evidence and provider-owned child objects before recovery.
3. Pin the current native session and leaf. Capture the target with `captureSourceIdentity`. Recovery permits only the old inode/path/session/header with a supported current durable identity.
4. Call the provider owner's API under its transaction serialization, or in a coordinated offline operator process:

```ts
const target = await captureSourceIdentity(host.sessionManager);
if (target.durability !== "disk" || !target.identity) throw new Error("Unsupported recovery target");
const evidence = {
  authorization: "independent-prefix-sha256" as const,
  commitRef, // exact selected old anchor reference
  scope: { sessionId: host.sessionManager.getSessionId(), leafId: host.sessionManager.getLeafId() },
  source, // exact old commit source, without a durable identity
  target,
  prefix: { bytes: independentlyVerifiedBytes, sha256: independentlyVerifiedSha256 },
};
const result = await owner.recoverSourceIdentity(host, evidence, { signal });
// pending: repeat this same request at the same cut to advance one ancestry page.
// ready: the existing commit is selected. No new Pi anchor or provider revision was made.
```

5. Compare complete native state through the provider's read interface. Reopen the same selected branch before allowing new writes. Recover older selected branch commits separately when needed.

One call retains the normal ancestry-page bound. At the selected anchor, it verifies the immutable commit, root, optional import receipt, existing committed receipt, exact live/disk anchor, and the complete supplied prefix. Prefix verification streams 64 KiB chunks with cancellation checks and a fixed 128 MiB cap. Larger evidence refuses. The library does not hydrate Workplan's unrelated plan bodies. That remains a provider/operator check.

After verification and source rechecks, recovery exclusively publishes `identities/<commitId>.json`. This private immutable receipt contains the exact old commit/source, current durable identity, authorized scope, prefix proof, and original anchor proof. It does not rewrite objects, commit receipts, session JSONL, or provider state. The source lock covers recovery. A scope change after publication can leave a valid receipt but must not report ready. Preserve it and resolve again. A repeated recovery cannot replace an existing receipt with a different identity.

Later resolution checks the receipt's durable identity and original exact anchor, including after another device-only reboot. It also refuses truncation below the authorized prefix. It does not rehash the complete prefix on every read. Existing immutable hashes and provider validation still apply. Old derived indexes/import-progress pointers remain intact, but identity-specific legacy progress is not migrated by this operation.

Error boundaries:

- `state-store-source-recovery-required`: an old source needs the explicit independent-prefix proof.
- `state-store-source-changed`: durable identity, source fields, prefix, or required source length differs.
- `state-store-identity-unavailable`: supported identity capture is unavailable or the recovery target has no supported identity.
- `state-store-corrupt` or `state-store-missing`: immutable data or exact anchor proof is damaged or absent.
- `state-store-conflict` or `state-store-scope-changed`: the pinned request, session, leaf, or live source changed.

Recovery preserves rollback evidence, not old-reader compatibility. Previous state-store code does not read the new `identity` field or recovery receipts. Selecting it again can refuse both newly written commits and recovered old device-mismatched commits. After new writes, use the provider's complete native transfer into a fresh replacement before selecting a legacy writer. Keep the source, owned objects, receipts, and prior installation. Do not delete identity receipts or edit source hashes to force a rollback.

Focused regression, from the repository root on Linux Btrfs:

```sh
node --experimental-transform-types --test packages/pi-context-kit/state-store/test/reboot-identity.test.mjs
```

The fixtures use the actual registered provider tools and Pi session manager. The ancestry regression checks pending progress across ordinary user and tool-result appends, reopens a cold owner before completion, and checks native results after later appends and cold owners. It verifies per-operation read bounds and source/immutable preservation. A retained small subcase checks one-entry pages and old-headless-cursor recovery. A separate focused scenario preserves a reused legacy barrier and excludes an off-branch legacy suffix after tree selection. The identity regression simulates only the observed source device number, exercises another reboot after explicit recovery, and refuses a real same-path file replacement, including replacement during capture. Unsupported fixture filesystems skip the identity regression, not the ancestry regression. Record the resolved SDK version through the fixture's ESM import route. CommonJS `require.resolve` can refuse the SDK's import-only exports. These fixtures do not claim a full AgentSession loop, an actual machine reboot, or installed-provider activation.

## Legacy import boundary

Small durable progress pointers use `await owner.readProgress<T>(host, key)` and `await owner.writeProgress(host, key, value)`. Keys are nonempty opaque strings up to 128 UTF-8 bytes. Values are bounded plain JSON. Each record includes exact session/leaf and source identity, with a 64 KiB total record cap. The owner rechecks its epoch, source, and live scope after I/O. Different views have different keys on disk. Store bulk pages/staged roots as immutable objects and keep only their references in progress. Providers serialize progress calls with their other transaction work. These methods do not add a lock or commit/anchor state.

`readAncestryPage(manager,{fromEntryId,maxEntries?,maxBytes?,signal?})` returns detached native entries newest first, a canonical page digest, and `nextEntryId`. Pi keeps absent optional fields as `undefined` in memory. The page omits those object fields, as Pi JSONL does. This normalization applies only to source pages. Owned state still rejects `undefined`. Providers retain page references or a source-manifest object and replay their own validated events oldest first. They must handle source/checkpoint coverage explicitly. An oversized entry refuses the page; it is never shortened. Object and import-page `maxBytes` accept up to 128 MiB, so a 64 MiB canonical Workplan plus its native event envelope can be imported. Defaults remain smaller. This does not raise the 8 MiB native transfer cap. Canonical serialization uses the existing `stableJson` key ordering (`localeCompare`), with bounds before copying/traversal. Its node budget is `max(1_000_000, ceil(maxBytes / 2))`, with the existing 64-level depth guard. This finite budget permits every admitted 64 MiB plain JSON shape without reducing existing byte admission. Small roots and progress records keep the original node cap. `rootMaxBytes` bounds the root payload. The object wrapper has an additional bounded 512-byte allowance.

After proving a complete selected native state, call `commit` with `importReceipt:{importer,source,coverage,evidence?}`. Source scope must match the pinned import view. Coverage includes complete status, exact source digest, and scanned/provider counts. An immutable deterministic import receipt is retained with the root. Repeated imports use the same canonical receipt/root references. A failed import does not authorize an empty commit.

## Failure and transfer rules

An unanchored object is an orphan, not selected state. An anchor plus exact object can repair a missing derived binding. An uncertain append cannot be treated as a rollback. Do not delete a lock left by a crashed process without verifying that its owner stopped. Locks are private to one provider/source and have no timeout-based ownership theft.

Native fork/clone can preserve anchor IDs while re-chaining parents. Inherited anchors retain their original committed receipt and are selected only through the native selected ancestry. A new write creates a new source-bound commit.

This library does not implement a shortened transfer format. Complete native transfer remains 8 MiB/provider and 16 MiB aggregate. Providers must assemble their complete state or refuse. Root manifests and Recall cards are not complete transfer checkpoints.
