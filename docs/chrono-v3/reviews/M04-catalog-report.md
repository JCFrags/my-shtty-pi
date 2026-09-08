# M04 source catalog — implementation report

Status: code/storage review passed at `9e82228eb2389b5fef47c4995de0d008711d2f5a`; guarded deployment verification pending, milestone not yet accepted. Draft-review target: `rebuild/chrono-memory-v3`. No production activation or M05. The accepted M03 integration merge is `afb5f81b9eb6931cbf6f08d90413b3766829f192`.

## Guarded shadow deployment decision

The project lead approved code/storage at `9e82228eb2389b5fef47c4995de0d008711d2f5a`, closed F001/F002/F003, and accepted the lifecycle synchronization and many-record corrections. This is code approval, not final M04 acceptance or broad live activation. PR #36 remains draft/unmerged. M05, main merge and new model functionality remain unauthorized.

A distinct private patch identity, 2.0.5, is being prepared from the approved runtime. Changes are limited to release metadata, exact verifier expectations, deployment tests and documentation. Runtime source/distribution bytes, dependencies, peers and toolchain must remain unchanged. Existing scale measurements remain applicable; deployment tests use fresh small synthetic fixtures rather than repeating the expensive campaigns.

Before the activation-target change, require a clean pushed candidate with normal/fixed-heap/typecheck/reproducible-build/privacy/root gates and both exact-head CI events. Prepare an owner-only complete 2.0.4 rollback and controlled native SQLite build for the actual deployment Node/ABI. Keep persistent isolated workers enabled and catalog shadow globally off. Enable shadow only in selected fresh synthetic Pi processes, with private new storage and no external provider calls. Report an offline summary as such, not as a provider-produced summary. Preserve old agents and distinguish installed versus demonstrably loaded identity.

The approved-head push CI [34182622418](https://github.com/JCFrags/my-shtty-pi/actions/runs/34182622418) passed on attempt 1. PR CI [34182625456](https://github.com/JCFrags/my-shtty-pi/actions/runs/34182625456) attempt 1 was cancelled at the unchanged 25-minute root-job limit after both 535-test suites, replay and heap checks passed and the final root report was printed. The annotation confirmed the job execution limit. One unchanged targeted root rerun passed on attempt 2; this does not reclassify attempt 1 as passed. No deadline or gate changed.

Deployment preparation found the accepted 2.0.4 package and earlier rollback intact, with persistent isolated workers enabled and shadow disabled. Both documented default admission directories were absent. Live deployment is held pending explicit verified boot-recovery authorization; no policy, gate, inhibitor or scheduler state was implicitly created. The asynchronous question provider refused to queue the authorization request; it was asked directly in chat while independent candidate work continued. Referenced general activation documentation was absent from both this branch and the canonical checkout, so the existing Chrono activation reference and retained rollback scripts are the available deployment references. These inspection failures did not mutate production. The accepted 2.0.4 read-only gate API also returned false without creating state.

Rollback preparation copied the complete retained 2.0.4 package and dependencies, configuration, settings, activation pointer and repository bundle into a new owner-only private activation root. A byte/ownership/permission check passed for 24,331 files and 13 internal symlinks; package-tree SHA-256 is `9a654d6b2b9dd56a654b264886eb662354c2a4ef6e74608eaa727c7f7041f341`. The rollback script passed syntax and `--check`; it has **not been applied**. It does not stop unrelated agents, rewrite configuration, migrate policy or remove inhibitors. Existing older recovery points remain retained. Deployment Node is 24.18.0, ABI 137; the fresh candidate's native build remains a required pre-install check.

Deployment metadata is committed as `4e37a5b`: 2.0.5 package SHA-256 `6082b36dac835779ce35ea29a6ebc05e40bf9fcb5bcec3d4f49e68be7d150260`, lock SHA-256 `9f0d9218009cae48b2116edce63b99363defa90ed2aa064e91da0a0f22c56571`. The 96-row manifest and exact verifiers were updated together; source/dist remain byte-identical to the approved head. Isolated typecheck/build, all manifest rows, both existing-addon allocation probes, clean frozen verification and 29 verifier tests passed. The metadata worker's first ad hoc file-count check counted only 85 top-level files; the corrected recursive check found the expected 95 without output changes. Its first static-root scan exceeded a 120-second command lifetime; an unchanged 600-second invocation passed. This was a caller bound, not a verifier assertion or runtime-cap change. The deployment harness is integrated as `9eadeee`; full deployment-candidate gates remain pending.

The harness's final exact bytes passed disposable runs with locked Pi 0.84.2 and unchanged global Pi 0.85.1. These are development checks, not installed-production evidence or expanded peer support. They cover the actual manifest entry, six full persisted tool results at the offline provider boundary, Pi's regular summarizer using a fixed offline fixture, contained replay, history, off restart without catalog writes, two independent catalog clients and fresh restarts, pinned chronology and exact sampled raw recovery. No external provider was called. Earlier attempts failed on import-only dependency resolution and two regular-summary checks caused by separate nested Pi-AI compatibility registries. The harness now registers the same synthetic API in each resolved registry; runtime files remain unchanged. Final runs sampled private WAL/SHM/temp permissions and confirmed task admissions settled. Evidence is retained, not securely erased. Production mode remains untested and refuses absent admission state. It leaves the scheduler option undefined to preserve the default per-start gate, and preserves the original temporary-directory route because that route determines the legacy namespace.

## Project-lead review R1

PR #36 was reviewed at `6ad9f19f9df85c03e66276ca4a0d868d1d017108`, against integration `afb5f81b9eb6931cbf6f08d90413b3766829f192`. M03 remains accepted; M04 is not accepted. The current architecture, charter and A-0004 scope are retained.

- **F001:** Preserve established sampled source evidence across checkpoint handoff. Bind new anchors to accepted processing bytes, recheck prior evidence before commit, and prove transactional rollback under deterministic mutation, overlap and giant-continuation tests.
- **F002:** Classify every registered history tool and explicit compatibility alias structurally. Preserve recall chronology and mixed-block provenance without treating recalled payloads as new independent evidence.
- **F003:** Separate explicit creation/bootstrap from existing-store lookup. Missing, empty and wrong-identity referenced databases must refuse without replacement creation or metadata/source changes; valid WAL recovery and explicit fresh-store recovery remain supported.
- **Coverage:** Add at least 50,000 high-cardinality records under fixed memory and shared M03 limits, including independent clients, append/no-op, late pins, forks and exact recovery. Retain the large-body campaign. Complete all local and exact-head CI gates before re-review.

### Lifecycle readiness investigation

The original push CI attempt at the reviewed head passed 490/491 tests but timed out in the existing 10-second incremental readiness assertion. Its unchanged retry and the PR run passed; this was disclosed in PR #36.

The test polled readiness by invoking `session_before_compact`, which intentionally cancels pending incremental work. Manifest publication occurs before writer release. If the first poll arrives in that interval, it cancels the generation before `ready` is published; subsequent compaction calls cannot make that cancelled generation ready. This is a synchronization defect in the test, not evidence that a larger deadline is needed.

The regression now holds the real writer release after manifest publication, reproduces the cancellation deterministically, then schedules healthy work and observes completion through the existing read-only status command before invoking compaction. The deadline is unchanged and timeout diagnostics include completion state. No runtime source change is needed. The focused build-and-test run passed on its first corrected invocation.

### R1 implementation and verification

The focused corrections are `b830977` (F001), `ef09cf1` (F002), `0e0908c` (F003), and `a171fe7` (many-record harness). Parent integration `58e3d93` preserves reproducible source/dist and the 96-entry deployment manifest. No dependency, production version, charter or runtime-cap change occurred.

- **F001:** At most 32 KiB of first/tail evidence advances only with parser-consumed buffers. Candidate verification and prior-anchor recheck occur inside the transaction before checkpoint publication; total verification overhead is at most 96 KiB. Six deterministic native-engine mutation tests prove complete ingestion-state rollback, including capture races, overlapping windows and giant continuations. All six fail against the original implementation because it accepts the mutation. Pure append remains valid; the helper reaches the exact 7 MiB + 96 KiB bound without exceeding the unchanged 8 MiB source budget. Sampled evidence still cannot certify unsampled bytes or writes after the final relevant read.
- **F002:** Exact registered retrieval names and the `history_read` alias are generated-copy provenance. Twelve tests cover registry drift, mixed prose, explicit/indexed results, parser and process restart, sibling/session isolation, immutable pins and exact UTF-8 raw bytes. `history_retention_hint` is explicitly non-retrieval. Existing indexed provenance requires an explicit derived rebuild; it is not silently rewritten.
- **F003:** Explicit creation is separate from existing lookup. UUID-bound initial/recovery intents prevent identity adoption on restart. Missing/empty referenced stores refuse without bootstrap, and ambiguous missing/zero reservations require a fresh recovery key. Twenty-two new tests cover actual native and physical routes, valid committed WAL recovery, refusal, restart/publication and healthy old pins. **Native limitation:** nonempty read-only identity/schema validation can create an empty WAL and a 32,768-byte SHM or rebuild transient SHM bookkeeping. Main DB and existing committed WAL bytes remain unchanged with no checkpoint/delete/schema writes. Missing/empty lookup preserves all orphan artifacts without native open. This is not an all-artifact preservation guarantee for nonempty preflight.
- Parent build, typecheck, strict native allocation-refusal probe, **138/138 focused catalog/extension/configuration tests**, and **535/535 complete package tests** passed. Normal deterministic replay and both 512/1,024 MiB fixed-heap lanes passed with the retained small/medium output and generation hashes. No package-suite or lifecycle-readiness retry was required in these corrected parent runs. Locked Pi 0.84.2 and global 0.85.1 disposable off/on canaries passed: unchanged 79,563-byte summaries/source prefixes, zero extension errors and external provider calls. The global lane does not expand the peer range.

### R1 fixed-memory high-cardinality campaign

Run `node scripts/catalog-many-records.mjs` after native preparation and distribution build. `--small` selects a 1,024-record development fixture. The final integrated campaign passed with **50,000 initial unique records**, 13,588,883 source bytes and 167 contained calls in 100,132 ms. Initial ingestion used 98 jobs plus one status request. Three continuations and two sibling-fork appends are the only permitted source changes.

| Measurement | R1 integrated result |
| --- | ---: |
| Initial / total source-reader bytes | 28,730,624 / 29,643,664 |
| Maximum job source reads / response | 294,912 / 5,693 bytes |
| Generator / parent peak RSS | 63,287,296 / 82,886,656 bytes |
| Parent plus independent clients cgroup peak / limit | 111,235,072 / 268,435,456 bytes |
| Maximum worker RSS / observed cgroup peak | 75,206,656 / 48,701,440 bytes |
| First / middle / late page maximum call latency | 503.149 / 489.036 / 524.956 ms |
| Initial kernel read / write characters | 121,428,536 / 103,707,512 |
| Initial kernel storage read / write bytes | 0 / 0 (cached/tmpfs) |

Each parent/client uses a 128 MiB V8 heap; their combined OS cgroup is 256 MiB. Workers retain 256 MiB OS/128 MiB V8 limits. Two independent client PIDs ran in each disposable slots=1 and slots=2 lane, with observed occupancy one and two. All admissions, task sockets and units settled before namespace removal. No global limits changed.

First/middle/late cursor windows (including 49,968 through 50,000 and an empty next page), six no-ops, append/fork isolation, sampled exact raw recovery, and full deterministic pre/final source hashes passed. Metadata paging read zero source bytes. This is not a full 50,000-page walk or all-record raw recovery. Latencies include process launch; kernel I/O includes native SQLite and startup, not SQLite-only query cost. RSS is observation, not native allocation enforcement; the separate allocation-refusal probe establishes that bound.

The retained large-body campaign also passed after updating its accounting assertion: 289,678,089 source bytes (276.3 MiB), 1,025 records, 1,016 timeline events, 40 ingestion/173 total jobs. Initial reads were 293,544,713 bytes; total 293,675,934; maximum job 7,438,336; no-op 32,768; append 98,453. Maximum response was 6,049 bytes, process RSS 95,490,048 and cgroup peak 65,228,800. Kernel read/write characters were 354,789,485/10,991,834 with storage counters 0/0. Wall time was 96,152 ms. Exact source/pinned timeline checks passed. These R1 figures supersede the original campaign figures below for the corrected implementation.

### R1 failed attempts and corrections

- F001's first new regressions reached rollback correctly but six final healthy-read assertions used incorrect response field names. Corrected `seq`/`rawStart`; worker 33/33 and parent integrated checks passed. The six baseline-negative failures are expected regression evidence, not failed corrected runs.
- F002's first run passed 11/12; registration drift exposed the advisory `history_retention_hint` tool. Its actual non-retrieval contract was added explicitly rather than using a broad name-prefix rule.
- F003's earlier broader run passed 68/69: an existing cross-session fixture used status to bootstrap. The parent now explicitly ingests the other session and asserts missing-status refusal; integrated tests pass.
- The many-record development harness initially omitted bounded discarded read-ahead in its accounting expectation, then tried to change slots policy on an existing namespace. Corrected the proof and used separate disposable namespaces per policy. Both failed namespaces were retained after confirming settlement; no runtime limits changed.
- The first read-only production check assumed the activation root itself was the Git checkout. Its path assertion refused; a diagnostic Git call confirmed the path error. Using the actual `checkout/` child passed: clean accepted `ad23f0b`/2.0.4 alias and verified 2.0.3 rollback readiness. No production mutation occurred; the local activation reference now records that route.
- The verifier worker's first frozen check refused 95 untracked build-generated source maps. The exact task-generated maps were moved into ignored private build output; frozen verification then passed without weakening clean-worktree enforcement.
- The first integrated large-body rerun failed its old 64 KiB anchor-overhead expectation after F001 added a prior-anchor recheck. Both campaign assertions now account for at most 64 KiB discarded read-ahead plus 96 KiB verification, and at most 96 KiB verification for a small append. This changes measurement expectations, not the enforced 8 MiB source cap. The failed disposable namespace was retained; the corrected large-body rerun passed.

## Delivered boundary

The new catalog is a disposable SQLite/WAL index of explicitly supplied synthetic/session JSONL sources. It stores structural metadata, byte ranges, raw-span hashes, decoded body hash descriptors, branch links, and resumable parser checkpoints. It does not become model memory, replace history tools, or change compaction, first tool-result consumption, the required Pi summary, retrieval authority, or source files.

`catalogShadowEnabled` defaults to false. `PI_CHRONO_CATALOG_SHADOW` and the `catalog-shadow` configuration command are explicit opt-ins. Session start and agent settlement only schedule work; they do not read the catalog or source on the scheduling stack. Switch/fork/shutdown cancel or disable scheduling. Incomplete tails wait for another append signal; errors do not cause an automatic retry or rebuild. `/chrono-catalog-status` reports bounded in-memory state without scanning a database or archive. No production opt-in was performed.

The client uses the existing M03 scheduler, cancellation, containment and settlement boundaries. Each job has a 30-second deadline, 256 MiB OS memory limit, 128 MiB V8 heap, 64 KiB request, and 256 KiB response. Global host limits are unchanged. Source reads have a separate 8 MiB cap, with a 7 MiB ingestion delta and bounded anchor overhead. The JavaScript filesystem wrapper allowance also covers trusted startup reads; it does **not** measure native SQLite I/O.

## Storage and exact access

See [catalog contract](../catalog-contract.md), [physical publication](../catalog-store-publication.md), and [ADR-002](../adr/ADR-002-sqlite-catalog.md).

- LF alone commits a complete record. Giant records resume from serialized parser state; incomplete and malformed tails are not skipped.
- Record/block/hash/checkpoint updates are transactional. Scope-qualified IDs preserve lone surrogates. Ordinal references support id-less roots without invented source IDs.
- Pinned views bind session, physical store, generation, event cut, branch and bounded ancestry segments. Chronological pages use keyset cursors; no lifetime event map is built in RAM.
- Raw access verifies each complete selected hashed source span before returning a bounded subrange. Prefix/tail anchors are samples, not proof that every historical byte is unchanged. An explicit resumable integrity scan is available.
- Physical recovery creates a new store, ingests in bounded steps, and publishes through an owner-only, synced pointer with a kernel-mutex compare-and-swap. Old healthy pinned stores remain addressable. The old database, WAL, SHM and references are not deleted or individually renamed.
- Directories are 0700; database and pointer artifacts are 0600 with observed owner/type/link/identity checks. Same-UID replacement races are not eliminated by a native pathname API.

## Native foundation

Exact published `better-sqlite3@12.9.0`, SQLite 3.53.0, MIT. The proposed 12.9.1 returned npm 404; it was not used. The stock prebuild has `DEFAULT_MEMSTATUS=0`: an 80 MiB native allocation succeeded despite a reported 64 MiB hard heap limit. The adapter rejects that build.

The controlled project-local build verifies locked source and exact headers and changes only MEMSTATUS to 1. There is no compiler-step prebuild or header-network fallback. Actual allocation-refusal probes and seven focused binding tests passed on Node 20.0.0, 22.0.0 and 24.18.0. Node 24 native SHA-256: `baac38739b5e4c5137ea0514c451df58423c2e626f43cddcfb4542206f93d013`. ADR-002 records all runtime, source, header and toolchain identities. Ubuntu CI uses an explicit local-build provenance record, not a claim of identical Fedora compiler output.

## Original draft measured synthetic evidence

Parent reruns, after dependency integration:

| Check | Result |
| --- | --- |
| Parser + initial source/shadow tests | 22 passed; includes 67,158,156-byte escaped-Unicode input under a 32 MiB V8 heap |
| Native binding | 7 passed; exact Node 24 binary hash and actual allocation refusal |
| Engine + updated shadow/config/extension checks | 39 passed, including 18 engine cases |
| Physical publication | 28 passed; real process kill, concurrent initialization, corruption recovery, old pins, stale-owner refusal, EIO/ENOSPC seams |
| Default-off and opt-in lifecycle | 2 passed; synthetic source, disposable scheduler namespace, no whole-session/branch read |
| Package typecheck/build/native probe/test compilation | Passed before integration tests |
| Complete package suite | 491 passed, zero failures/skips; preserves the 412-test baseline |
| Deterministic replay and fixed heaps | Normal, 512 MiB and 1,024 MiB lanes passed; small/medium output and generation hashes remain equal |
| Fresh disposable Pi processes | Pi 0.84.2 and 0.85.1, each with catalog off/on: loader, doctor, worker/catalog status, history and contained compaction passed |

The medium harness uses the M02 deterministic metadata/fork fixture and emits one synthetic body at a time. It retains no archive-sized body array. It ran 173 contained jobs, including ingestion, pinned paging, no-op and append checks:

| Measurement | Result |
| --- | ---: |
| Source size | 289,678,089 bytes (276.3 MiB) |
| Source records / selected chronological events | 1,025 / 1,016 |
| Initial ingestion jobs | 40 |
| Initial source reads, including anchors | 292,266,761 bytes |
| Maximum source reads in one job | 7,405,568 bytes |
| No-op source reads | 32,768 bytes |
| Append source reads | 65,685 bytes |
| Maximum response | 6,049 bytes |
| Maximum reported process peak RSS | 93,310,976 bytes |
| Maximum observed cgroup memory peak | 63,315,968 bytes |
| Observed per-job cgroup memory limit | 268,435,456 bytes |
| Worker process read/write characters | 347,346,298 / 10,988,766 |
| Worker storage read/write bytes | 0 / 0 (cached/tmpfs workload) |
| Wall time, including generation and verification | 83,953 ms |

Process I/O totals include native SQLite, JavaScript, startup and measurement reads; they are not SQLite-only attribution. Kernel storage counters exclude cache hits. Independent source-hash verification is outside the catalog source-read budget. RSS and cgroup accounting are different measurements. An independent source hash was unchanged before the intentional append. The old pinned chronological digest remained identical after append.

Reproduce after the controlled native preparation and distribution build:

```sh
node --max-old-space-size=128 scripts/catalog-benchmark.mjs --small
node --max-old-space-size=128 scripts/catalog-benchmark.mjs
```

### Disposable Pi procedure

From the package directory, after the controlled native build:

```sh
node scripts/catalog-pi-canary.mjs "$PWD"
# Optional: supply an explicitly selected installed Pi dist/cli.js as the second argument.
```

The harness creates only synthetic sessions and private temporary agent/config/scheduler directories. It loads the candidate through a wrapper that supplies the disposable scheduler namespace. A synthetic provider throws on any model call, and network fetch is disabled. No credentials are inherited and no production settings are read or changed. Both states produced the same 79,563-byte compaction summary, preserved the original source prefix, and reported no extension errors. The harness retains its synthetic directories rather than deleting possibly unconfirmed worker admissions. Pi 0.85.1 is an extra observed compatibility lane, not an expansion of the declared peer range.

## Original draft repository verification

Full root `npm run verify` passed on the verifier integration branch at `1408de1577d4dd6f291c0c322147d12f24e4ddcf`: 15 baseline scripts, 17 pack dry-runs, exact isolated builds, two 491-test runs, normal replay and both fixed-heap lanes. The controlled native build ran after the last isolated reinstall and reproduced the recorded Fedora binary; the post-build probe refused the real oversized allocation. Runtime was 14 minutes 37.90 seconds, with peak RSS 864,164 KiB. The later canary-path allowance changes no runtime behavior. Frozen baseline and privacy self-tests passed 69/69 at `08bd8f6ad59df38f2df441629377bab70f9d2cf8` before parent integration. Final integrated and public CI results are recorded in the draft PR.

## Disclosed failed runs and corrections

- The stock native prebuild failed effective heap enforcement; replaced by the explicitly verified source build, not a larger global memory limit.
- A focused test invocation used repository-root rather than package working directory and could not find synthetic fixtures. The retry used package cwd. Two added expectations also needed correction: the new status command belongs in the command list; existing configuration syntax accepts explicit boolean strings. The corrected 39-test run passed.
- The first medium fixture generator exhausted its 512 MiB heap while retaining all bodies. It was changed to materialize one body at a time, without increasing that heap or catalog limits. The medium retry passed.
- The publication worker attempted its native probe before distribution existed; the successful post-build probe supersedes that failed attempt.
- Root verification initially rejected the changed user-config test against the retained M00 snapshot. Only that exact test path was added to the existing historical-snapshot exception; historical rows and totals remain unchanged.
- Strict script-map comparison exposed a declaration-order mismatch. The expected native commands were placed in the frozen package order without relaxing command validation.
- All-ref privacy scanning flagged a noncredential dummy in the synthetic canary. The user authorized amendment of only unpublished commit `bfac2ad` to shorten that literal, yielding `1909351`. No real credential was present, no earlier history was rewritten, and the privacy scanner was not changed.

## Explicit limits and remaining gates

The engine supports at most 64 ancestry segments and 1,024 ordered declared shards. Earlier shards cannot append after a later shard is declared. The parser's general checkpoint bound is 5 MiB; the engine deliberately refuses checkpoints above 1.5 MiB rather than truncating metadata. The worst escaped-metadata fixture reaches 4,941,048 bytes and can therefore be outside the engine-supported subset. A 67 MiB giant body needed only 7,347 checkpoint bytes.

The decoded hash checkpoint can retain at most 2,046 decoded carry bytes, privately and only until the string completes. This is not searchable text or whole-body retention, but it remains a storage/privacy review point. Raw-span SHA-256 and the versioned decoded UTF-16 hash chain are distinct contracts.

Process-kill tests are not device power-loss testing. Corrupt pointer metadata refuses rather than reconstructing by scanning directories. Old-store cleanup is outside this change. Literal Node 21, future majors, other native platforms, and full store execution on the early runtime lanes remain unverified. The workstation Pi 0.85.1 remains outside the unchanged locked peer range, although its disposable off/on canaries passed.

R1 frozen metadata pins 96 source files at `fdb6df74fc937e46ed46f680affdf3e5426c01724e04f16cab88a0576c1225cc` and 95 distribution files at `d8f5892cfe89c89b2e7edb8e3ae99e96768f5d068f88d29a9cf64a1c50f780c0`. Entry, package, lock and charter hashes remain unchanged. Only the three new test paths and one many-record script were added to the finite correction lists. Full root, final integrated static/frozen/privacy and exact-head push/PR CI remain required delivery gates; draft PR #36 records their exact final results and attempts. Project lead owns code/storage review and acceptance; implementation agents performed no independent code review. Production remains on accepted 2.0.4 with its alias, settings, policy, gate, inhibitors and rollback intact.
