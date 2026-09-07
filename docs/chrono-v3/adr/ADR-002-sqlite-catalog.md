# ADR-002 — Worker-only SQLite catalog binding

Status: implemented and focused-tested binding candidate. Not M04 acceptance.
Scope: binding foundation only; no catalog schema, ingestion, production activation, or M05.

## Dependency and compatibility

Pin MIT-licensed `better-sqlite3` **12.9.0**, npm/source commit `4058d24f05e21ccfc63f65fbb5c53960fc9b071e` (annotated tag object `341ef1b6291caa71b5bcaf1ef2dda69e627b2675`). Bundled SQLite is **3.53.0**. This is separate from Node 24.18.0's built-in SQLite 3.51.2.

The initially proposed 12.9.1 exists on GitHub but is absent from npm: install/view and a refreshed public-registry read returned ETARGET/E404. The parent authorized the nearest published compatible 12.x version. Npm metadata, Git source, and release assets confirm that 12.9.0 retains Node 20 support. Existing dependency versions/integrities and Pi 0.84.2 peers are unchanged.

Package engines remain `>=20`. Upstream binding engines are `20.x || 22.x || 23.x || 24.x || 25.x`; tests cover Linux x64 Node **20.0.0**, **22.0.0**, and **24.18.0**. Literal Node 21, future Node releases, and other platforms are **not verified or promised by this binding decision**. This gap was escalated to the parent, not hidden by narrowing package engines. Built-in-only SQLite cannot cover Node 20/early 22. No whole-file or memory-catalog fallback is permitted.

## Reproduced upstream heap defect and correction

The release prebuilds use `SQLITE_DEFAULT_MEMSTATUS=0`. SQLite therefore does not enforce the apparent hard heap limit. On Node 24.18.0, `PRAGMA hard_heap_limit` returned `67108864`, while `SELECT length(randomblob(80*1024*1024))` successfully returned `83886080`. The short disposable probe exited normally. Readback alone was false assurance.

The parent approved a controlled project-local source build. The adapter rejects `DEFAULT_MEMSTATUS=0` as `catalog-sqlite-capability`; the build changes only this option to **1**. All three runtime lanes now pass a real allocation-refusal test, not just a pragma readback. Upstream release prebuilds remain unsuitable and must not silently replace this build. The SQLite allocator limit covers this binding’s SQLite allocations, not V8, every native allocation, or the OS page cache; M03 containment remains mandatory.

## API and limits

`CatalogSqlite.open(absolutePath)` returns `prepare(sql).get/run/iterate(maxRows, ...values)`, `transaction(fn)`, `checkpoint()`, `capabilities()`, and `close()`. Values are positional SQL bindings. Errors contain fixed codes, never SQL, DB paths, source text, or native messages. Busy/locked errors use `catalog-sqlite-busy`. No persistent schema or `all` API exists.

- Only call this synchronous adapter inside a later M03-contained worker. Native memory is outside V8. The controller is the final memory, deadline, and process-tree boundary.
- WAL and FULL synchronous writes are read back. Commit durability is separate from checkpoint maintenance.
- Busy timeout: 50 ms. This bounds normal lock waiting, not I/O stalls or arbitrary query execution.
- Cache target: 2 MiB per connection. Mmap: disabled. Temporary storage: memory-only. Requested process-global SQLite hard heap limit: 64 MiB; a stricter prior limit stays in force. The cache target is not a total memory limit.
- Automatic checkpoint: 256 pages. Retained WAL target: 1 MiB. Neither is a hard disk/WAL quota. Passive maintenance does not wait for readers. The integrating worker must bound transaction size, keep readers short, and decide idle truncation/rebuild policy.
- SQL text: 64 KiB. Total input values/one returned row: 2 MiB, allowing a bounded approximately 1 MiB parser checkpoint. Iteration: explicit limit of at most 1024 rows. These are adapter checks, **not** SQLite `sqlite3_limit` configuration; output is checked after allocation. The public binding has no generic SQLite limit setter. Trusted queries and M03 containment are required.
- Source streaming limits are separate from metadata/SQL limits. JavaScript filesystem source-read wrappers do not meter native SQLite reads, writes, checkpoints, or recovery.
- Queries are trusted implementation code. Bind source values; never interpolate them as SQL. Do not expose arbitrary SQL as a public service.
- Consume/close iterators in one synchronous worker turn. Breaking a loop releases the reader. Async transactions refuse; side effects already scheduled by a caller cannot be undone. Callers must not schedule them.

## Storage boundary

Require an existing private 0700 directory. DB, WAL, SHM, and rollback journal files must be regular, owner-only 0600, single-link files. Refuse symlink ancestors and unsafe writable ancestors. Reserve a new DB with exclusive creation and `O_NOFOLLOW`, without truncating existing data. Recheck visible paths before native calls.

This is observed-path validation, not protection from another process with the same UID. The native API accepts a pathname, not a caller-owned file descriptor, and has no `O_NOFOLLOW` DB/WAL/SHM open option. **Same-UID path replacement races remain.** No source-filesystem-wrapper accounting or race-elimination claim is made.

## Verified release provenance (rejected for heap enforcement)

Npm 11.16.0 installed exact 12.9.0 with `--ignore-scripts --no-audit --no-fund`. `prebuild-install` 7.1.3 then downloaded the matching native release asset with no source-build fallback. Its normal install validation can load the addon before a later hash probe; do not describe npm integrity as native-artifact verification. During initial research, the separate release tarball SHA-256 and its exact `build/Release/better_sqlite3.node` member were compared against the installed binary. The final probe instead pins the corrected source-built binaries below.

| Node / ABI | release tarball SHA-256 | installed native SHA-256 |
| --- | --- | --- |
| 20.0.0 / 115 | `3944803d604b1583a581485e7a9410a449cf26a23c680e4148bbacb1af8d170d` | `db622d37af96dce851d361573aeaec69013c242c2c7c3b1f3785fee8a03dbc2d` |
| 22.0.0 / 127 | `e654eda528127d576ded4fbec7473f63fd91d2f5487e2c309ee65f22394fbd80` | `cdc21ea975a7b7a2c9cab78a930b71ed61ff6a426a394ca8d18adc939b45d04d` |
| 24.18.0 / 137 | `3a3084e0405b9521c9c5228e0f8efabc8290b6cbca62838c0aa4f2162b45d975` | `ec599358a4c58d528278fccd189357975d33debc587bc1e2b6cd8fb3904e25b1` |

GitHub API digests and downloaded bytes matched. Upstream workflow builds the legacy Linux x64 Node 20.0.0/22.0.0/23.0.0/24.0.0 targets in `node:20-bullseye`; the Node 24 prebuild ELF records `GCC: (Debian 10.2.1-6) 10.2.1 20210110`. The container tag is not a pinned image digest, so this is artifact provenance, **not** a demonstrated bit-identical upstream toolchain rebuild.

Disposable runtimes came from `npm pack node-linux-x64@20.0.0` and `@22.0.0`, extracted only in synthetic temporary directories; no workstation runtime changed. Node binary SHA-256: 20.0.0 `2dc70820110a1110b146df0e723c22e65ff889492acfe7b0fcf235384e688948`; 22.0.0 `0570891fc6e07540b25f18b753445fc16d4428b8a894cca5cf9805c2feee230f`. Runtime package tarball SHA-256: 20.0.0 `df064cc70caa6ca465ec011eabe81c49ebdb85f6e83aa41cf3c0a825a75c9fe1`; 22.0.0 `1c2c155862df223c28f1c8937030e760413e87a284438e6db03d2fa4a78794de`.

## Controlled source build and final native identity

Npm source integrity is pinned in `package-lock.json`: `sha512-wqUv4Gm3toFpHDQmaKD4QhZm3g1DjUBI0yzS4UBl6lElUmXFYdTQmmEDpAFa5o8FiFiymURypEnfVHzILKaxqQ==`. The controlled build additionally verifies the exact **48-file** source tree (`package.json`, `binding.gyp`, `LICENSE`, `lib`, `src`, `deps`) as SHA-256 `7c76d8e2733fd21d379c87a1e6d6f75eba49e30488944b62c8e68b19e3769d38`. The hash format is sorted relative POSIX path, NUL, bytes, NUL per file. Only the one approved MEMSTATUS change is normalized when checking a previously prepared tree. Original `deps/defines.gypi` SHA-256: `1ffa84b8af99780a293dcb7a9031c2dccc8b0d013aef434a35c283cc6c984f2e`; corrected: `27e5cb5ffe37d25185f3d48ea700c6294c20611c951135ede47686ace8d76045`.

All builds ran sequentially on Fedora Linux x64 using existing **Node 24.18.0**, **node-gyp 12.3.0** (initially the npm 11.16.0 bundled copy, then an exact lockfile-pinned development dependency), **GCC/G++ 16.2.1 20260819 (Red Hat 16.2.1-2)**, **Python 3.14.7**, and **GNU Make 4.4.1**. No toolchain was globally installed or upgraded. The helper checks node-gyp version and exact target-header tree, sets `CC=gcc`, `CXX=g++`, clears inherited C/C++/preprocessor/linker flags, and invokes `rebuild --release --jobs=1 --nodedir=<explicit-root> --target=<exact-version>`. It uses the locked package’s release flags (including `-O3`, `-DNDEBUG`, and `-fPIC`) and SQLite options, except `SQLITE_DEFAULT_MEMSTATUS=1`. There is **no prebuild or header-network fallback** in this build command. Build peak RSS was at most **440,012 KiB**.

Headers for Node 20/22 came from their already pinned disposable npm runtime packages. Node 24 headers were prepared separately and explicitly with node-gyp `install --target=24.18.0 --ensure`, which downloaded the official headers and checked the official SHASUMS256 list. The helper then verifies the exact local header tree before any compilation. Header-tree hashes use the same path/NUL/bytes/NUL format relative to the header root, over `include/node`.

| Target / ABI | header-tree SHA-256 | corrected native SHA-256 |
| --- | --- | --- |
| 20.0.0 / 115 | `5507c41f3ef9b3b9b442db2011df5cfbde00c13aa20362c238a60f3a799e6fac` | `fbec82d69dbfacd218cc74282230dc7284c084877e94cac20cef2630738a7725` |
| 22.0.0 / 127 | `acf42a40923151680e8fa664504b73a002fcad2386266363fd7e309d3002234d` | `5f591c496eab00b6fd562e7929e93230804315ccac1bd87f922a3db842af1a35` |
| 24.18.0 / 137 | `3586827feee78d3d4ad791406d5f6d8a9021a8f495dfbeb38085423299742fdf` | `baac38739b5e4c5137ea0514c451df58423c2e626f43cddcfb4542206f93d013` |

The strict `catalog:sqlite:build` / `catalog:sqlite:probe` route refuses unknown source, headers, node-gyp version, or resulting native bytes. A repeated Node 24 source build reproduced the exact native hash. The explicit CI record route below allows another compiler result only as a fresh controlled source build, records that identity, and requires an allocation-refusal probe. Neither route selects a prebuild or another header version. Fedora is tested locally; Ubuntu runner execution remains the parent’s CI gate, not a claimed local result. Ordinary `npm ci` can install the unsuitable upstream prebuild; use **`--ignore-scripts`**, then the controlled build. The adapter itself fails closed on the unsuitable prebuild.

## Focused evidence and reproduction

Final source: typecheck, completed distribution build, focused test compilation, **7/7 tests on each of Node 20.0.0, 22.0.0, and 24.18.0**, and each pinned native probe passed. Every lane reported SQLite 3.53.0, WAL, synchronous 2/FULL, busy timeout 50, cache -2048, mmap 0, hard heap 67,108,864, temp store 2/MEMORY, and FTS5. An isolated process lowers the heap limit to 1 MiB, then requests a 2 MiB SQLite random blob and requires a sanitized allocation refusal. This avoids a large pressure test while proving effective enforcement. Test peak RSS: **61,836 / 68,448 / 68,664 KiB** for Node 20/22/24. Each run used one test file and a 128 MiB V8 heap; its heap-refusal child used 32 MiB. No full baseline/root suite was run. The record-mode build/probe also passed locally using the locked node-gyp dependency and reproduced the reference Node 24 binary. Deliberately changed native provenance and changed source both refused; original local bytes were restored.

Tests also cover bound FTS5 MATCH; rollback/commit/checkpoint; reader snapshots and bounded writer lock waiting; checkpoint blockage/recovery around a short reader; subprocess commit then SIGKILL and recovery of only committed rows; sanitized corruption/schema/capability errors; bounded approximately 1 MiB checkpoint storage; 2 MiB input refusal; iterator limits/early return; unsafe modes, symlinks and hardlinks; and persisted DB reads with JS `readSync` forbidden. No power-loss campaign, hostile same-UID race elimination, or production canary is claimed.

Package-local reproduction (build must finish before dist-consuming tests):

```sh
npm ci --ignore-scripts --no-audit --no-fund
# Prepare the exact local headers separately; no download occurs in the next command.
npm run catalog:sqlite:build -- <node-gyp-12.3.0/bin/node-gyp.js> <headers-root> <target-version>
npm run typecheck
npm run build
./node_modules/.bin/tsc -p tsconfig.test-build.json
node --max-old-space-size=128 --test dist-test/test/catalog-sqlite.test.js
npm run catalog:sqlite:probe
```

For the tested workstation lane, node-gyp came from `/usr/lib/node_modules_24/npm/node_modules/node-gyp/bin/node-gyp.js`, and the prepared header root was `$HOME/.cache/node-gyp/24.18.0`. For a disposable alternate lane, copy only the compiled adapter/test/probe and runtime dependencies `better-sqlite3`, `bindings`, and `file-uri-to-path` into its own ESM package tree. Build there using the explicit Node 24 build toolchain and the lane’s local `runtime/package` headers, targeting 20.0.0 or 22.0.0. Invoke the lane’s explicit Node binary for tests/probe. Never overwrite the current runtime’s addon. Node 20.0.0 lacks `--test-concurrency`; the one-file command above needs no such flag.

## GitHub Ubuntu Node 24 lane (parent-owned CI integration)

Use `actions/setup-node` with exact **24.18.0**, rather than a floating major that can change the pinned headers. `node-gyp` **12.3.0** is now a lockfile-pinned dev dependency; no global installation or separate unresolved tool dependency is needed. It requires Node `^20.17.0 || >=22.9.0` as a **build tool**. The supported earliest runtime lanes are built with Node 24 and tested with Node 20.0.0/22.0.0; this is not a claim that those earliest runtimes can run this newer development toolchain.

Run from `packages/pi-chrono-compaction`, with the runner’s existing GCC/G++, make, and Python available:

```sh
npm ci --ignore-scripts --no-audit --no-fund
# Explicit, separate network-enabled header preparation. node-gyp checks SHASUMS256.
node node_modules/node-gyp/bin/node-gyp.js install \
  --target=24.18.0 --devdir="$RUNNER_TEMP/chrono-node-headers" --ensure
# The next command verifies the pinned local header tree, then builds with --nodedir.
# It has no header download or prebuild fallback.
npm run catalog:sqlite:build-record -- \
  node_modules/node-gyp/bin/node-gyp.js \
  "$RUNNER_TEMP/chrono-node-headers/24.18.0" 24.18.0
npm run build
npm run catalog:sqlite:probe-record
./node_modules/.bin/tsc -p tsconfig.test-build.json
node --max-old-space-size=128 --test dist-test/test/catalog-sqlite.test.js
```

`build-record` explicitly permits the Ubuntu compiler’s different output hash. It writes a bounded local record at `node_modules/better-sqlite3/build/chrono-native-provenance.json` with source/defines/headers/native hashes, target, build Node, node-gyp, GCC, Python, and make versions. `probe-record` checks that record against the exact source/header pins and installed binary, then verifies WAL/FULL settings, FTS5, and **actual native allocation refusal**. This local record is not a signed upstream attestation; its authority comes from running the frozen controlled build in the trusted CI job. Keep the emitted JSON/build log as CI evidence. The immutable Fedora reference hashes above remain distinct and unchanged.

A package reinstall removes the prepared addon/record. Any root verifier that reinstalls must repeat this explicit build/probe sequence **after its last reinstall and before tests**; do not fall back to a release prebuild or disable the heap gate. The parent owns that verifier/CI wiring. A header mismatch refuses; updating Node/headers is a new explicit tested pin change, not an automatic network fallback.

## Integration ownership and rollback

Parent owns M03 worker integration, source/native-I/O budget separation, catalog schema, bounded ingestion/checkpoint policy, distribution/manifest/frozen-verifier updates, broader gates and draft PR. User/project lead owns acceptance. Shadow ingestion remains off. Production alias/configuration/scheduler/archives are untouched. Rollback is to omit this new worker-only module and revert its package dependency/source commit; no production catalog migration exists.

## Sources

- [Exact package metadata](https://github.com/WiseLibs/better-sqlite3/blob/4058d24f05e21ccfc63f65fbb5c53960fc9b071e/package.json)
- [API](https://github.com/WiseLibs/better-sqlite3/blob/4058d24f05e21ccfc63f65fbb5c53960fc9b071e/docs/api.md)
- [Build workflow](https://github.com/WiseLibs/better-sqlite3/blob/4058d24f05e21ccfc63f65fbb5c53960fc9b071e/.github/workflows/build.yml)
- [SQLite build options](https://github.com/WiseLibs/better-sqlite3/blob/4058d24f05e21ccfc63f65fbb5c53960fc9b071e/deps/defines.gypi)
- [Release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.9.0), [asset metadata](https://api.github.com/repos/WiseLibs/better-sqlite3/releases/tags/v12.9.0)
- [MIT license](https://github.com/WiseLibs/better-sqlite3/blob/4058d24f05e21ccfc63f65fbb5c53960fc9b071e/LICENSE)
- [SQLite WAL](https://sqlite.org/wal.html), [heap limits](https://sqlite.org/c3ref/hard_heap_limit64.html), [temporary store](https://sqlite.org/pragma.html#pragma_temp_store)
- [A-0004](../amendments/A-0004-v3-timeline-and-catalog-scope.md), [M03 contract](../reviews/M03-runtime-report.md)
