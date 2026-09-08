# M04 source catalog — implementation report

Status: project-lead changes requested; corrections in progress, not accepted. Draft-review target: `rebuild/chrono-memory-v3`. No production activation or M05. The accepted M03 integration merge is `afb5f81b9eb6931cbf6f08d90413b3766829f192`.

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

## Measured synthetic evidence

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

## Repository verification

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

Final integrated static/frozen/privacy and exact-head CI are the remaining publication gates. The draft PR records their final status. Project lead owns code/storage review and acceptance; implementation agents performed no independent code review. Production remains on accepted 2.0.4 with its alias, settings, policy, gate, inhibitors and rollback intact.
