# Catalog source identity and explicit legacy promotion

`catalog-source.ts` separates one-open file identity from persisted identity.
The source remains read-only. Each open checks the exact path and pinned descriptor
with raw device/inode, regular-file, owner, mode, and single-link requirements.
Capture checks path/descriptor size, nanosecond modification time, and change time
before and after the filesystem probe. Normal in-job raw identity checks remain
strict, including on Btrfs.

## Persisted identity

New snapshots use `schemaVersion: 2`. On Linux Btrfs, the durable tuple is the
filesystem type, statfs filesystem ID, inode, and nonzero nanosecond birth time.
A fixed `/usr/bin/stat --file-system --format=%t %i -- /proc/self/fd/3` probe inherits
the already-open source descriptor as fd 3. It has a one-second timeout and a
128-byte output cap. It does not reopen the source pathname or load a provider.
Probe failure refuses with `catalog-source-identity-unavailable`.

This contract is Btrfs-specific. Linux Btrfs derives its statfs ID from the disk
filesystem ID and subvolume root ID. Inode alone cannot distinguish subvolumes or
snapshots. The Btrfs temporary-filesystem-ID clone mode can also mix the runtime
device number into statfs ID. A changed statfs ID refuses. There is no fallback
from a missing or changed Btrfs tuple to path, anchors, or raw device acceptance.
Other filesystems keep strict device/inode identity. This is not a universal
filesystem UUID or a guarantee against deliberately cloned filesystem metadata.

Legacy `schemaVersion: 1` snapshots retain strict device/inode comparison, including
through healthy appends. Ordinary ingestion, status, and reads do not promote them.
Both versions retain canonical first/tail anchors. Exact reads still verify every
complete stored raw span that intersects the requested range. Durable identity
does not replace those content checks or prove unsampled bytes unchanged.

Sources: [Btrfs subvolume identity](https://btrfs.readthedocs.io/en/latest/Subvolumes.html),
[Linux `btrfs_statfs`](https://github.com/torvalds/linux/blob/master/fs/btrfs/super.c),
and [GNU stat](https://www.gnu.org/software/coreutils/manual/html_node/stat-invocation.html).

## In-place legacy promotion

Use this only for an explicitly approved device-identity recovery on an intact
catalog. Preserve a coherent backup and keep the source unchanged throughout the
proof. This is not physical catalog corruption recovery, a rebuild, or an evidence
bypass. Use a compatible installed build and the contained public entrypoint
`runCatalogWorker` from `dist/src/catalog-worker-client.js`. Do not import
`executeCatalogRequest` or `executeCatalogStoreRequest` into the Pi process.

Every request has exactly these fields:

```ts
const recovery = {
  v: 1,
  op: "sourceIdentity",
  catalogDirectory,       // Existing logical catalog root, not stores/<folder>.
  sessionKey,
  targetStoreKey,          // Exact existing physical UUID. Required.
  generation,
  shardKey,
  recoveryKey,             // A fresh bounded explicit token for this proof.
  expectedSnapshotHash,    // SHA-256 of exact stored legacy snapshot JSON UTF-8.
  expectedCheckpointHash,  // Exact stored checkpoint hash, independently checked.
} as const;

const call = async (action: "start" | "step" | "status" | "publish") => {
  const response = await runCatalogWorker({ ...recovery, action });
  if (!response.ok) throw new Error(response.code);
  return response.result;
};
```

1. Identify the exact store/generation/shard from preserved metadata. Hash the raw
   stored snapshot string, not parsed and reserialized JSON. Verify the checkpoint
   hash before submitting these expectations. Do not guess from path similarity.
2. Send `start`. It freezes the legacy snapshot, shard declaration, checkpoint
   hash, cuts/counts, current Btrfs tuple, and source size/mtime/ctime observation.
3. Send `step` until `complete` is true. Each step checks at most 96 contiguous
   stored spans from the beginning, each at most 64 KiB. The private progress record
   supplies the next offset. The caller cannot supply a cursor, force flag, or
   claimed proof. Each step reads less than 8 MiB, including anchor checks.
4. Send `publish`. It requires complete coverage of `[0, snapshot.size)`, no extra
   spans, the frozen database binding, unchanged source observation, and verified
   path, descriptor, durable identity, and old anchors. Publication changes only
   `shards.snapshot` in one SQLite writer transaction.
5. Exercise an existing pinned raw read and normal bounded ingestion. Check their
   results separately from publication status.

The checkpoint byte offset must equal the old snapshot size. Coverage includes
any provisional parser bytes within that cut, not later unindexed bytes. A source
may be longer than the cut when the proof starts, but its complete observed size
and timestamps must remain unchanged until publication. Append, replacement,
truncation, content mismatch, missing/overlapping/extra spans, or changed binding
refuses. Investigate and settle the source before starting a fresh explicit token.
Do not rewrite the old token's observation or partially publish it.

Progress is one bounded owner-only file under the exact physical store's
`source-identities/` directory. There are no directory scans. SQLite writer
acquisition serializes progress with catalog writers. Prepared progress never
allows ordinary reads to skip the legacy identity guard. A crash can leave an
unreferenced temporary or a fully saved proof page. Retry the same request/token
only while its frozen binding and source observation remain valid.

The promoted snapshot retains a receipt with the exact old snapshot JSON, old
snapshot/checkpoint/binding hashes, target identity, frozen observation, verified
cut, span count, and chained span digest. The digest records span order and hashes;
it is not a whole-prefix byte hash. Later ordinary appends retain this receipt.
Store UUID, generation, events, raw spans, parser checkpoint/hash, active/ref
pointers, and derived identities do not change. Existing pinned handles still name
the same catalog. A matching publication retry remains idempotent after append.
`status` reports saved proof/publication state, not current source readiness.

## Compatibility and rollback

Old code that accepts only snapshot v1 refuses snapshot v2 source operations.
Do not strip the new fields or downgrade the snapshot in place. Preserve the old
catalog backup, sources, progress, receipts, and both compatible package versions.
A code-only downgrade is not a complete rollback after promotion or new v2 stores.
Stop dependent source operations until a compatible reader is selected. Restoring
an old backup requires a separate approved procedure that preserves any later
writes and derived progress. No automatic reverse migration is provided.

## Focused checks

`test/catalog-source-identity.test.ts` uses disposable files on the checkout's
filesystem. The promotion fixture requires Linux Btrfs and explicitly skips that
part on other filesystems. It exercises real inherited-FD probes and cold process
reopens, more than one proof page, retained identities/rows/handles, device-only
observation drift, carried receipts, changed spans, page-boundary overlaps,
mid-proof append, changed filesystem identity, and same-path replacement.
Separate comparisons cover strict fallback. Existing source/handoff checks still
cover sampled-anchor limits and transactional anchor retention.

[Catalog contract](catalog-contract.md) · [Physical catalog publication](catalog-store-publication.md)
