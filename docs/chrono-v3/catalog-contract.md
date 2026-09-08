# M04 catalog protocol and engine

Draft implementation boundary, not M04 acceptance. Shadow scheduling stays off by default. No production source access or migration is implicit.

## Entry and storage

`packages/pi-chrono-compaction/src/catalog-contract.ts` is pure and does not import the native binding. `executeCatalogRequest(unknown)` in `src/catalog-engine.ts` is synchronous and must run only inside M03 containment. The engine does not create workers or relax M03 limits. The caller supplies an explicit owner-only `0700` catalog directory. On ingestStep or rebuildStep start only, the contained engine can create at most eight missing directory components, each `0700`, after bounded owner/mode/no-symlink checks. Read/status requests do not create missing directories. The adapter checks storage paths and creates `0600` SQLite files. Each logical session uses `catalog-<SHA256(sessionKey UTF-8)>.sqlite` in that directory. Source files are never written.

`v: 1`, `catalogDirectory`, and `sessionKey` are required. Keys use `[A-Za-z0-9_.:-]`, 1–128 characters. Source event IDs remain exact strings, at most 1024 UTF-16 units. SQLite identity columns contain JSON-string encodings, not lossy UTF-8 bindings, so lone-surrogate event and tool-call IDs cannot collapse. Filesystem paths containing lone surrogates refuse. Source paths are explicit, absolute, and at most 4096 units. No directory enumeration, private parent-session path following, or inferred logical-session grouping occurs.

Responses are `{v:1,ok:true,result,sourceBytes}` or `{v:1,ok:false,code,sourceBytes}`. Diagnostics do not return source paths, `cwd`, or private parent-session paths. `sourceBytes` counts source helper reads, not native SQLite I/O. Native cache/heap/busy limits are the adapter's separate contract. Wire responses have a final 256 KiB byte check. Request validation is deliberately stricter than that ceiling.

## Requests and cursors

- `ingestStep`: `shardKey`, `sourcePath`, `branchKey`, nonnegative `shardOrdinal`, optional `generation`, optional `parent:{shardKey,eventId}`. Returns generation, records added this step, provisional offset, committed LF offset, caughtUp, and optional incompleteTail/error. Retry uses the saved checkpoint, not caller offsets.
- `status`: optional generation/shardKey. With a shard, records is the committed total. Without one, returns only the selected generation. Status does not scan or certify the source.
- `pin`: branchKey and exact `leaf:{shardKey,eventId}` or `leaf:{shardKey,ordinal}` (1-based source-record ordinal), optional generation. Supplying both selectors refuses. Returns `view:{storeKey,sessionKey,generation,eventCut,branchKey,segments}`. Keep the complete view unchanged.
- `page`: view, optional exclusive `after` sequence (default 0), limit 1–16. Returns events and the next exclusive after. Empty events means end of this pinned view. Pages can be shorter than limit due to the byte budget.
- `blocks`: view, eventSeq, optional inclusive `after` normalized descriptor index (default 0), limit 1–16. Returns descriptors and the next inclusive after. Block headers and each body descriptor are separate rows. Body descriptors identify their original blockIndex when applicable.
- `raw`: view, eventSeq, absolute source offset and length 0–65536. Range must be within that event's `[rawStart,endByte)`. Returns base64 data with offset/length. Decoding recovers exact bytes, including LF if selected. The caller reconstructs a large record with multiple bounded requests; no whole-record fallback exists.
- `integrityStep`: shardKey, optional generation and after offset (default 0). Returns next after, verified span count, and complete. Continue from the exact returned after. Each call verifies at most 96 stored spans. This is a resumable range scan, not an authenticated certification token; a caller that starts in the middle has not checked the preceding prefix.
- `rebuildStep` start: `action:"start",rebuildKey`. Returns an idempotent new generation. Explicitly ingest declared shards into that generation through normal ingestStep calls.
- `rebuildStep` publish: `action:"publish",generation,expectedShards` (1–1024). Requires exactly that many declared shards, each at a complete committed LF checkpoint. Publication atomically changes the active generation. It does not promise the source cannot append after that checkpoint.

## Identity and chronology

Identity is `(sessionKey,generation,shardKey,event ID or ordinal)`. Duplicate IDs in different shards or sessions are valid. Same-shard duplicate IDs are stored, but references resolving to multiple events refuse with `catalog-reference-ambiguous`; they never select the first candidate. An exact shard-local ordinal leaf can pin an id-less root or disambiguate duplicate IDs. No synthetic source ID is invented. Missing parents refuse without skipping the record. Cross-shard ancestry requires the explicit parent declaration and exact matching parent ID. Tool results missing toolName resolve their toolCallId through indexed tool-call source metadata within the same bounded ancestor segments. A unique match supplies effective toolName, generated provenance when applicable, and an explicit toolCallSource shard/ordinal/block reference. Missing or ambiguous calls refuse; no lifetime RAM map or inferred cross-branch link is used. Source record metadata preserves its parentId; the index also stores resolved parent sequence.

The initial conservative shard contract permits at most 1024 shards per generation. Declare them in strictly increasing shardOrdinal order. The previous shard must have a complete checkpoint before adding a new shard; only the latest shard can subsequently append. This prevents ingestion scheduling from silently changing source order. No automatic shard discovery or rollover exists.

Linear descendants share an indexed segment. A fork creates a segment with one parent-event cut. Pinning and validating a view inspect at most 64 segments, not the full parent chain. Deeper ancestry explicitly refuses. Page queries use `(generation,segment,sequence)` keyset indexes and SQLite LIMIT, without full-history sorting or recursive history queries. Appends cannot change the event cut or the ancestor cuts of a pinned view. A source header with no parent is a separate root; it is not silently inserted into another root's ancestry.

## Atomic ingestion and hash semantics

One bounded transaction acquires the writer before loading a checkpoint. It writes completed events, normalized block/body descriptors, consumed raw-span hashes, provisional parser state and its SHA-256, and sampled source anchors together. Process death or write failure rolls back that unit. No searchable or complete source-content body is retained in SQLite. The private parser checkpoint contains unfinished metadata/hash state and can include at most 2046 decoded hash-carry bytes as the approved bounded resumable-state exception. The parser clears that carry when the body completes. It is not returned by the protocol or stored as a content chunk.

Each step reads at most 7 MiB of delta, reserving source-helper budget for old/new 2×16 KiB anchors. A read is at most 64 KiB. Additional ceilings are 512 records, 8192 statements (with reserve before starting a record), and a cooperative one-second processing target. Parser calls request one record. M03 containment supplies the hard deadline. A parser checkpoint exceeding 1.5 MiB refuses rather than increasing the wire limit. This is an explicit engine subset of the parser's 5 MiB worst-case supported checkpoint: saturated escaped block metadata can reach 4,941,048 bytes and is not supported across an engine job cut. The engine does not silently truncate that metadata. Giant body length alone does not require a large checkpoint. A maximal record is normalized before response construction; event and block pages have a 192 KiB metadata budget.

Raw spans are contiguous consumed portions of source reads, each at most 64 KiB; a job cut may make a shorter span. Their SHA-256 hashes cover exact raw bytes, with no JSON decoding or newline normalization. Selected raw retrieval first verifies each *complete* stored span that intersects the requested range, then returns only the requested subrange. Parser body hashes use the parser's separately declared decoded UTF-16 hash algorithm and coordinates. They are not raw SHA-256 hashes and cannot substitute for source verification.

The source helper pins device/inode and checks size and bounded first/tail anchors of the processed prefix. The catalog also retains the full size observed at each step, so truncation of an as-yet unparsed tail refuses on the next step. Integrity complete refers to the indexed prefix, not unprocessed source bytes. Replacing or truncating the source, or mutating a selected anchor/span, produces a controlled error. Bounded anchors do **not** prove every historical byte is unchanged. Use selected-span verification for exact reads and explicit integrityStep iteration for a complete historical scan. No implicit rebuild follows a mismatch.

Incomplete final JSONL records remain provisional across jobs and fresh engine instances until LF. Malformed records preserve earlier committed data, persist a refusal state, and never skip forward to later records. Repair requires an explicit new rebuild generation. A missing/ambiguous parent aborts that transaction; it does not invent ancestry.

## Rebuild, compatibility and rollback

Normal reindex generations coexist in one SQLite WAL database, keyed by generation. This does not recover corruption of the physical database. Rebuild publication is a short transaction; no database/WAL rename or lock-file reclamation is involved. Old pinned views continue to address retired generations. Writes to retired generations refuse. The implementation does not delete old generations or source shards. Storage reclamation is a separate approval boundary.

For physical database corruption, explicitly choose a **new** catalogDirectory and the same sessionKey, start a rebuild there, ingest the caller-declared sources, and publish the completed generation in that new store. The old corrupt store is neither opened nor deleted by this recovery flow. Each physical database has an opaque storeKey; views from another physical store refuse even if their session, generation, and event sequence happen to match. The parent integration layer must atomically publish its active-directory pointer and retain the old-directory mapping for existing views. That physical pointer publication is not implemented by this engine. A corrupt old store cannot promise working old readers; intact old stores remain independently readable.

Unknown catalog schema versions refuse. No legacy ledger import is attempted: its lifetime maps and identity assumptions are not established as compatible with this bounded schema. The explicit migration decision is to build a new derived generation from caller-declared sources. Existing source files and old stores remain available for rollback. There are no semantic, capsule, decoded-chunk, search, or other M05+ tables.

## Focused verification

Build before running emitted tests. The engine tests use disposable synthetic directories only. They cover append/noop, fork cuts, exact bytes, normalized blocks, giant records across fresh instances, malformed tails, duplicate IDs, explicit cross-shard parents, replacement/truncation and unsampled mutation, schema/checkpoint refusal, permissions, restartable rebuild, real SIGKILL within transaction/publication windows, concurrent writer busy/retry, and synthetic ENOSPC/EIO statement seams. Fault seams are not claims that real disk-full hardware behavior has been reproduced. Root/baseline and medium harness acceptance belong to the parent integration task.

Focused local reproduction from `packages/pi-chrono-compaction`, after preparing the verified native dependency described in [ADR-002](adr/ADR-002-sqlite-catalog.md):

```sh
npm run build
npm run catalog:sqlite:probe
./node_modules/.bin/tsc -p tsconfig.test-build.json
node --max-old-space-size=128 --test --test-concurrency=1 dist-test/test/catalog-engine.test.js
```

The focused engine suite passed **18/18** on Node 24.18.0 with a 128 MiB V8 heap (1.03 seconds, peak RSS 144,460 KiB). This is synthetic engine verification, not M04 acceptance. The Node 24.18.0 strict native probe passed with the approved `baac38739b5e4c5137ea0514c451df58423c2e626f43cddcfb4542206f93d013` binary and effective allocation refusal. The 9 MiB giant-record fixture measured at most 7,372,800 source bytes in one job, 87,493 wire bytes for a 64 KiB exact range, and 32,768 source bytes for the final no-op. These are engine/source metrics, not native-I/O accounting.
