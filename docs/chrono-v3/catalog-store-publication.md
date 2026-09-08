# M04 physical catalog publication

`catalog-store-contract.ts` is the pure IPC protocol. Importing it does not load
SQLite. `catalog-store.ts` is contained-worker code and exports the asynchronous
`executeCatalogStoreRequest(unknown)` entry. Pi must not import that entry directly.
It uses the synchronous catalog engine only inside the contained worker.

## Logical and physical identity

The request's `catalogDirectory` is a logical root, not an engine directory:

```text
logical-root/                         0700
  publication.lock                   0600, kernel flock
  active.json                        0600, current session/store UUID
  refs/<store-UUID>.json              0600, immutable session/folder mapping
  stages/recovery-<SHA256>.json        0600, immutable recovery intent
  stores/initial-<SHA256>/            0700, deterministic initial DB directory
  stores/recovery-<SHA256>/           0700, deterministic recovery DB directory
    catalog-<session-hash>.sqlite     engine-owned DB, WAL and SHM together
```

The initial folder is derived from the logical session key. A recovery folder is
derived from the session key and rebuild token with an unambiguous separator.
Folder names do not depend on source content or paths. The engine assigns the
physical store UUID. Immutable refs bind that UUID to one folder and session.
There are no lifetime in-memory maps and no directory scans.

Ordinary ingestion and status resolve `active.json`. `targetStoreKey` explicitly
selects an immutable ref for staged ingestion, status, pinning, or engine actions.
Pages, blocks, and raw reads always resolve `view.storeKey`; they never fall back
to the current store. A target/view mismatch or view/session mismatch is refused.
The wrapper checks the engine's store identity before routing the operation.
Old refs, DBs, WALs, and SHMs are never deleted or moved by publication. Old healthy
pinned views remain readable when a new physical store becomes active.

## Initial creation and recovery

Only ingestion and explicit `recoverStart` create a logical root. Initial ingestion
prepares one deterministic physical directory, commits an engine-created blank
store, then commits its immutable ref and active pointer. Source ingestion follows
publication. An interruption may therefore leave a valid active blank store; the
next ingestion resumes it. Competing initializers cannot overwrite another active
pointer. Native writer contention may produce a controlled refusal; retry the
bounded request rather than allocate another physical store.

Recovery is explicit and does not open the active DB:

1. Send `recoverStart` with a bounded `rebuildKey`.
2. The wrapper commits immutable recovery intent with the observed active UUID
   (or `null`) before starting a rebuild generation in a new physical DB.
3. The response includes `targetStoreKey`, `generation`, `expectedActiveStoreKey`,
   and `rebuildKey`. Save those values. Repeating the same token reuses its intent
   and physical folder; it does not adopt a newer active owner.
4. Send bounded `ingestStep` requests with that `targetStoreKey` and `generation`,
   declaring all expected shards through the ordinary engine protocol.
5. Send `recoverPublish` with `targetStoreKey`, `generation`, `expectedShards`, and
   the saved `expectedActiveStoreKey`.
6. The engine must accept `rebuildStep: publish` for the staged generation. An
   unfinished shard set is refused. This SQLite work is outside the pointer lock.
7. Under the kernel mutex, compare the active UUID with the saved expectation.
   On a match, atomically replace the active pointer. If the target is already
   active, the request is an idempotent success. Any other owner produces
   `catalog-publication-conflict`; the replacement and all its state stay intact.

A source append after the engine's observed complete cut is honest catalog lag.
Publication does not claim that future writes cannot occur. Ordinary incremental
ingestion catches up the new active store. Same-DB `rebuildStep` remains an engine
operation, not a corruption-recovery mechanism.

## Bounded metadata and failure behavior

Pointer records are at most 4096 bytes. Reads use a 4097-byte fixed buffer, no-follow
opens, regular-file/owner/exact-0600/single-link checks, and pre/open/post identity
checks. Logical and private child directories must be owner-only 0700. Ancestor
checks reject symlinks, untrusted ownership, and writable non-sticky ancestors;
root-owned sticky temporary parents are permitted. Path preparation is bounded to
64 components and eight new directories per call. Existing permissions are never
broadened or repaired automatically. These checks do not claim protection against
an adversarial process with the same UID racing ancestor replacement.

Metadata writes occur under M03 `withRuntimeMutex`, using its fixed 15-second kernel
lock wait. The parent worker controller supplies the final 30-second process bound.
The lock protects only short pointer work, never engine ingestion or source reads.
There are no PID-age or stale-lock heuristics.

Each record is written fully to one random, exclusive owner-only temporary, fsynced,
and renamed under the mutex; the parent directory is then fsynced. Immutable records
are checked for equality and never overwritten. A process interruption can leave an
unreferenced temporary, but readers never discover or use it. The wrapper only
removes its own exact temporary during normal unwinding. It never sweeps old files.
A storage error can occur after a rename committed; callers must retry the same
request/token instead of assuming rollback. Reuse of a committed ref or stage intent,
idempotent publication, and resumed ingestion complete the relevant directory sync
before reporting success. Physical directories are prepared before engine creation;
the directory containing the committed SQLite files is synced before its ref is
published. A partially written or unsafe pointer
is a controlled refusal, not permission to guess a store or scan for a replacement.

Corrupt SQLite is recoverable when independent active metadata remains valid.
Corrupt active metadata is deliberately refused; automatic reconstruction from
untrusted directory contents is outside M04. Eventual garbage collection, arbitrary
cleanup, production activation, and M05 decoded chunk storage are out of scope.
Errors use bounded `catalog-*` codes, never paths or source content.

## Focused verification

`test/catalog-store.test.ts` uses disposable synthetic sources. It covers native
store routing and corruption recovery, old healthy pins, initial competing
processes, publication CAS, unsafe and oversized metadata, fixed-buffer/no-scan
routing, actual process death at commit/ref/publication boundaries, and synthetic
EIO/ENOSPC metadata seams. Seams are constructor-injected for tests; IPC and
environment variables cannot select them. Source bytes and old DB retention are
checked. Process-death tests are not a claim of storage-device power-loss testing.

Focused verification passed on Node 24.18.0: package build, pinned native probe,
test compilation, and **28/28 store tests**, with a 128 MiB V8 heap. The probe verified
SQLite 3.53.0, WAL/FULL, the pinned corrected native binary, and actual allocation
refusal. This used the finalized native and engine dependencies; it is not M04
acceptance, a full repository gate, or cross-runtime store verification.

From `packages/pi-chrono-compaction`, after preparing the native dependency through
[ADR-002](adr/ADR-002-sqlite-catalog.md):

```sh
npm run build
npm run catalog:sqlite:probe
./node_modules/.bin/tsc -p tsconfig.test-build.json
node --max-old-space-size=128 --test --test-concurrency=1 dist-test/test/catalog-store.test.js
```

Build must complete before dist-consuming probes or tests. Do not substitute an
unverified native prebuild. The parent owns repository-wide gates and Pi lifecycle
integration. Remaining limits: no device power-loss testing, no adversarial same-UID
race guarantee, no automatic repair of corrupt pointer metadata, no old-store
cleanup, and no production activation.
