# ADR-003 — Immutable segment format and manifest publication

Status: proposed M05 contract candidate. Not M05 acceptance or activation.
Scope: the separate derived store, immutable capsule/chunk segments, canonical manifests, publication receipts, and recovery.

## Context

M04 intentionally has a strict source-catalog schema and stores no searchable bodies or M05 data. M05 needs exact decoded chunks and reusable capsule alternatives without making SQLite blobs or a full manifest chain the new lifetime-size bottleneck. A process can stop after any raw page, segment write, rename, manifest write, or database transaction. Batch size and restart timing must not change canonical content bytes. Existing M04 physical generations and pinned views must remain readable and unchanged.

## Decision

### Physical store and routing

M05 uses a separate owner-only physical store:

```text
derived-root/                                      0700
  derived.sqlite                                   0600, WAL/FULL
  segments/capsules/<sha256>                       0600, immutable
  segments/chunks/<sha256>                         0600, immutable
  manifests/<sha256>                               0600, immutable canonical content manifest
  receipts/<sha256>                                0600, immutable publication receipt
```

The integrating publication wrapper can place this physical directory under a logical pointer/ref layout, but no request infers a directory from a UUID and no reader scans directories to discover ownership. Every worker request supplies both `derivedDirectory` and the authoritative M04 logical `catalogDirectory`. Store creation persists their bound route with the `DerivedStoreIdentity`. Every later open compares the supplied routes, physical derived UUID, catalog physical UUID/generation, logical session, schema versions, reducer-set version, and configuration hash. A mismatch refuses. Source paths remain opaque to the M05 protocol; authoritative reads route through bounded M04 store requests.

`derived.sqlite` indexes identities, source coordinates, content-manifest hashes, immutable segment offsets, per-view readiness, publication receipts, and private resumable decoder/checkpoint state. It does not modify M04 tables and does not store a lifetime manifest, lifetime map, or a searchable full decoded body.

### Deterministic segment bytes

Capsule and chunk records have a versioned canonical encoding. Capsule metadata uses canonical JSON: UTF-8, object keys in ordinal order, no insignificant whitespace, JSON escaping for every lone surrogate, and one terminal LF. Each record is framed by an eight-lowercase-hex-digit byte length, LF, exactly that many canonical bytes, and LF. Chunk payload records use the same canonical descriptor frame followed by an eight-lowercase-hex-digit payload length, LF, exact UTF-16LE payload bytes, and LF. The encoded chunk descriptor omits `segmentHash` and `segmentOffset`: these are lookup locators added after encoding, not part of the bytes they locate. This avoids a self-referential segment hash. Integer fields are safe nonnegative decimal integers. Unknown schema versions refuse.

A segment starts with the ASCII magic and LF `CHRONO-M05-CAPSULE-SEGMENT-V1` or `CHRONO-M05-CHUNK-SEGMENT-V1`. Version 1 uses one complete capsule envelope or one complete fixed decoded chunk per segment. The catalog indexes order these records by event sequence, normalized descriptor, and alternative or chunk index. The fixed source record is the partition boundary, independent of page, timeout, response, or process job boundaries. The 8 MiB segment limit is a refusal ceiling, not a target buffer size. A single record that cannot fit the fixed segment bound is unsupported and gets an honest marker; the bound is not enlarged.

The segment filename is lower-case SHA-256 of the complete exact segment bytes. Capsule source identity and reducer budgets are frozen before encoding. Chunk content is exact UTF-16LE with fixed 32,768-code-unit boundaries. Therefore one batch, many batches, and restart recovery produce byte-identical closed segments.

### Canonical content manifests and receipts

A `DerivedManifest` is one bounded canonical content object for one immutable segment. It contains physical input identity, layer, exact segment descriptor, hash algorithm, and content hash. It contains **no** pin, event cut, predecessor, worker cursor, page size, job number, temporary path, or publication time. Its canonical JSON bytes and content-addressed filename are deterministic for the same source/reducer/configuration. The manifest hash is SHA-256 of canonical bytes with the `hash` field omitted; the stored canonical object includes that resulting hash. Its filename uses this self-hash, not the hash of the complete stored file. Existing-file reuse verifies the self-hash and exact complete canonical bytes and length. Receipt filenames follow the same rule for their `receiptHash` field; segment filenames remain hashes of complete exact segment bytes.

A `DerivedPublicationReceipt` is separate checkpoint metadata. It binds one pinned view, a bounded list of already durable content-manifest hashes, the branch-lineage derive cursor, optional predecessor receipt hash, and receipt hash. Receipt bytes can differ with legal job partitioning and are not claimed as canonical content bytes. A receipt is bounded to 16 manifest hashes. SQLite can publish several receipts for progress while all referenced content objects remain identical.

Neither read nor derive accepts a full-manifest-chain request. Normal lookup is an indexed bounded SQLite selection followed by one selected range read. A receipt predecessor is audit/recovery metadata, not a read plan and not permission to walk lifetime history.

### Durable publication order

For every closed segment batch, the worker performs this order:

1. Write each complete segment to a random exclusive owner-only temporary in its final directory.
2. `fsync` the complete file, calculate and verify its exact hash and bounds, rename it to the content-addressed name without replacing another byte sequence, then `fsync` the segment directory.
3. Canonically encode each content manifest only after its segment is durable. Write, `fsync`, verify, rename without overwrite, and `fsync` the manifest directory.
4. Encode the bounded publication receipt only after all referenced manifests are durable. Write, `fsync`, verify, rename without overwrite, and `fsync` the receipt directory.
5. Only then begin the `derived.sqlite` transaction that inserts segment/range lookups, manifest references, readiness changes, and the checkpoint/receipt hash together. Commit under WAL/FULL.

Thus segment, content manifest, and receipt are durable before any SQLite lookup or checkpoint can reference them. A failure after rename can have committed filesystem state even when the caller saw an error; retry the same deterministic work. If a content-addressed destination already exists, verify its complete bytes and reuse it only on equality. Missing, unsafe, wrong-size, or corrupt existing bytes cause a controlled refusal and are never overwritten.

Temporary files and durable orphans are not discovered by readers. Normal unwind can remove only its own exact temporary. There is no directory sweep, automatic garbage collection, corrupt-byte replacement, or old-pin deletion.

### Incremental cursors and private carry

The SQLite checkpoint is keyed by complete derived identity plus branch lineage, not one global last event. It records event sequence, descriptor, body raw/decoded offsets, and an optional hash of private `ChunkDecodeCursor` state. The private state retains actual partial JSON escape/UTF-8 state, actual body-hash pending bytes (at most 2,046), and exact unfinished UTF-16LE chunk bytes (strictly less than 65,536). It is not returned over IPC, logged, indexed for search, or copied into the canonical manifest. This allows a job to stop at any bounded raw page without reconstructing unknown carry.

A cursor can advance into a view only when physical identity and branch key match, the old segment lineage is an unchanged prefix, every old cut is no greater than the new cut, and the new event cut is monotonic. A sibling or changed ancestry gets an independent cursor. Append and no-op work read bounded M04 pages and touch only new descriptors. Source-local duplicate inserts and already committed receipt publication are idempotent.

### Bounded read, failure, and recovery

A decoded read selects one source reference through the actual M04 `CatalogView`, uses an indexed SQLite range lookup, reads at most the requested 32,768 units from the identified immutable chunk segment, and verifies segment/content/body identities as applicable. It does not decode a prefix or load a full manifest.

If SQLite references a missing or corrupt segment/manifest, the worker does not guess another path. When authoritative M04 source remains available and within the bounded job, it regenerates the exact deterministic object and verifies the expected hash before a new durable publication. Otherwise it returns a resumable explicit degradation marker. Unsupported, failed, excluded, or degraded objects never count as ready.

Physical derived-database corruption is recovered into a new derived UUID and directory using explicit routes and caller-declared catalog views. The old store is not opened for writes, moved, deleted, or auto-repaired. Old healthy stores, manifests, segments, receipts, and pins remain independently readable. Pointer publication, if added by integration, uses compare-and-swap and retains old UUID-to-directory refs.

## Alternatives considered

- Add M05 tables to the M04 catalog. Rejected because it couples independent schema/readiness/rebuild lifecycles and weakens the accepted strict catalog boundary.
- Store complete bodies or segments as SQLite blobs. Rejected because selected reads, native allocation, WAL growth, and recovery would scale poorly and durability ordering would be less explicit.
- Put every prior segment in one growing manifest. Rejected because reads and publication would become lifetime-sized.
- Put cursors and predecessor receipts in canonical content manifests. Rejected because job and batch boundaries would change bytes for identical source content.
- Close segments at every worker job. Rejected because batch size and restarts would change segment and manifest hashes.
- Rebuild by scanning content-addressed directories. Rejected because routing and ownership would become inferred from untrusted contents.
- Replace corrupt bytes at the same hash path. Rejected because it silently violates immutable pins and hides corruption.

## Consequences

Publication has more small durable objects and directory synchronization than a SQLite-only design. In exchange, payload bytes are immutable, selected reads are bounded, canonical content is independent of job partition, and SQLite checkpoints cannot point to unpublished bytes. Private partial carry remains bounded but can approach one decoded chunk; this is deliberate and is distinct from an IPC response or searchable content cache.

The configured 64 MiB SQLite native limit is reported as `sqliteNativeLimitBytes`; it is not a measurement of actual allocation, JavaScript heap, total RSS, page cache, or native I/O. M03 still supplies 128 MiB V8, 256 MiB OS/RSS, 30-second containment, shared queue admission, and low priority.

## Migration

No legacy derived store is imported. Create a new explicit physical derived directory and identity from a caller-selected M04 store/generation. Rebuild from bounded pinned catalog views, publish deterministic segments/manifests, and compare shadow readiness/output before any later activation decision. Schema, canonical encoding, reducer-set, or configuration changes create another physical identity. Existing M04 databases and source JSONL are untouched.

## Reversal path

Disable default-off M05 scheduling and stop resolving its derived pointer. Continue using the accepted M04 catalog and current compactor path. Retain old derived stores for pins and review. Any later deletion or garbage collection is a separate explicit approval and must never be inferred from rollback. This ADR does not authorize production settings/policy changes, private archive access, deployment, M06 behavior, provider/model calls, or package publication.
