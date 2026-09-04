# M02 test-foundation report

## Milestone identity

- Branch: `work/chrono-v3-m02-test-foundation`
- Base and M01 merge commit: `0a1ca2ff16d8b79db3fda88f156ea5b9c6864427`
- Package candidate: ChronoCompact `2.0.2`
- Implementation commit: `77cf5dd08486fd9ea6352a474aaac8a5e484f33a`
- Draft pull request: #34 into `rebuild/chrono-memory-v3`

M02 remains unmerged. It does not request or authorize a merge to `main`, and M03 has not started.

## Generator and unified commands

`scripts/synthetic-session.mjs` produces deterministic synthetic JSONL workloads without using private sessions. The profiles are `small`, `medium`, `large`, `adversarial`, and `multi-agent`. Bounds cover configurable event and tool-result sizes, giant records, branches and forks, repeated compactions, malformed or incomplete tails, append, replacement, truncation, prefix mutation, and future shard-rollover plans.

The supported commands are:

```sh
npm run test:normal
npm run test:fixed-heap
```

The normal command runs the complete serialized package suite and the bounded small/medium benchmark profiles. The fixed-heap command builds the test runtime and runs the scale, fault, and memory-characterization lanes at 512 MiB and 1 GiB. A bounded 2 GiB lane is optional for local use.

Both commands emit schema-versioned JSON. Deterministic fields include workload configuration, generation hashes, output hashes, byte counts, result codes, and determinism checks. Advisory fields separately report wall time, CPU, peak RSS, heap, and derived-store growth. Reports omit source text, source paths, session identifiers, and diagnostic content.

## Fault and benchmark coverage

The shared fault controller covers deterministic EIO, ENOSPC, short writes, transaction abort, process death, corrupt and truncated data, source mutation, concurrent-writer seams, malformed ownership, and PID-reuse fixtures. Existing worker tests continue to cover crash, timeout, abort, and resource termination. OOM is always a failing result, never evidence of a bounded refusal.

The consolidated harness reports wall time, CPU, peak RSS, heap, bytes read and written, generation and output hashes, determinism, worker codes, and derived-store growth. Giant and adversarial profiles stay local and bounded; generated sessions and raw diagnostics are not committed.

## Fixed-heap and soak evidence

The required 512 MiB and 1 GiB fixed-heap lanes passed. The threshold-race characterization admitted and read exactly `67,108,864` bytes, appended two bytes during the read, returned `history-source-changed`, and did not enter parsing.

A bounded soak against the then-deployed `2.0.1` package used six independent synthetic sessions, two host slots, and forty tasks. All tasks completed, at most two workers held slots, no cross-session leakage occurred, and no scheduler or temporary residue remained. A controlled missing-entrypoint case returned `worker-entrypoint-unavailable`; its diagnostic remained bounded and owner-only. Parent peak RSS was `190,864 KiB`.

The same six-session, two-slot, forty-task soak passed after `2.0.2` activation. It again reported six `ok` results, `worker-entrypoint-unavailable`, maximum two slots, no leakage, zero ticket/slot residue, safe diagnostics, and parent peak RSS `163,628 KiB`.

## M01 limitation findings and 2.0.2 correction

Both temporary M01 limitations were real safety gaps:

1. The legacy loader performed a pre-stat, then an unbounded whole-file read, then a post-stat. Growth could therefore allocate beyond the 64 MiB admission limit before rejection.
2. Search-index accounting omitted major retained structures. The bounded characterization measured an old estimate of `6,626,032` bytes against about `24,735,000` retained bytes, approximately `3.73×` understatement.

The narrow `2.0.2` candidate opens the source without following symlinks, admits its size before allocation, reads no more than the admitted byte count, and revalidates handle and path identity before parsing. Search indexing now admits sources only through a 16 MiB source cap, charges eight times source bytes with a 1 MiB minimum against the existing 128 MiB aggregate budget, serializes differing builds, uses generation-specific keys, evicts least-recently-used indexes, and limits each index to 64 cached query results.

Repository source, generated distribution, and deployment manifest currently resolve to:

- Source tree: `a3f5047d1358394e2e44807dc331f5ca28392a76c2ee1334cbd24448e6835a18` (66 files).
- Dist tree: `47e8d6b54d1e8e0cf2b0f6d493d6ce99e8fdfcf097636d4f2e2e25d8c993830a` (65 files).
- Entrypoint: `256f9003455b66d40c0445dbf0e7d4a5584785e295513354542927295c7181f2`.
- Package metadata: `85c2c4f6134be5ff671987c41c3aec8c69540293e7faf48d4b4aefe5ce49cf36`.
- Lock metadata: `314fac7de5ea1e8facc56fcc3a549c6d57f95a98a8b3dd23b92a8b62d71600f6`.

## Verification and activation status

The pre-push candidate passed:

- Complete serialized package suite: 329/329.
- `npm run test:normal`, including the complete suite and deterministic small/medium report. Repeated generation and output hashes matched.
- `npm run test:fixed-heap`: 512 MiB and 1 GiB lanes passed; OOM remained non-passing.
- Package typecheck, generated-dist comparison, and deployment-manifest verification.
- Baseline and privacy verifier tests: 69/69.
- Schema-3 worktree, index, and all-ref privacy scan: 175 commits, 82,593 path contexts, 1,794 blobs, 666 worktree/index files, zero findings.
- Complete repository root verification: 17/17 manifests, 261/261 deployed hashes, 15/15 safe scripts, 17/17 package dry runs, and zero unexplained dependency-graph files.

CI is split into publication, typecheck, unit/integration, determinism, 512/1024 MiB fixed-heap, build-consistency, and dependent root-verification jobs. All seven push lanes passed at source and deployment commit `0c7173ff03ed010747ab9b5d7be6f8f84d423819`. Final evidence-head push and pull-request CI remain required.

## Guarded 2.0.2 activation

The exact pushed commit `0c7173ff03ed010747ab9b5d7be6f8f84d423819` was cloned into a new clean detached owner-only activation root. The package was dependency-prepared, rebuilt, compared with committed dist, stripped only of generated maps, and verified against `DEPLOYED.sha256`. An isolated offline loader check passed before the stable package alias was replaced atomically. The effective ChronoCompact configuration was byte-preserved.

Fresh backup identity: `m02-20260904T212634Z-0c7173ff`. Its live `2.0.1` package copy and effective configuration match their pre-activation inputs. The rollback script passed its check mode and restores the prior alias target, configuration, and activation pointer atomically. The earlier M01 backup also remains retained.

Live `2.0.2` checks passed:

- Explicit main-process ordinary compaction succeeded and regular fallback remained available.
- Search and recall over a synthetic source one byte above 64 MiB returned `legacy-history-size-limit` under a 128 MiB heap.
- `/chrono-doctor` and `/chrono-worker-status` loaded without private paths.
- Three repeated isolated-worker compactions and verified append during execution succeeded.
- Controlled failures returned `worker-internal-error`, `worker-crashed`, and `worker-resource-limit`; the parent survived and diagnostics remained mode `0600`, bounded, and text-safe.
- Persistent `isolatedWorkerEnabled` remained enabled without a configuration rewrite. Fresh production discovery had zero extension errors, and an ordinary compaction used the worker successfully.

## Current disposition

User input is not required. M02 is complete locally and deployed; draft PR #34 remains unmerged. The final gate is green push and pull-request CI on the deployment-evidence head, after which the milestone is ready for project-lead review.
