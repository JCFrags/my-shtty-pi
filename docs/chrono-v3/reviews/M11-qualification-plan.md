# M11 qualification evidence plan

Status: harness prepared at the M11 branch based on `d9c5f1fd8bfdba8dc17ef9c6509db28e6a0fd9a3`. The full campaign has not run. Its result is not a pass.

## Run boundary

Run the full campaign only after the project lead supplies the final integrated commit and confirms that no duplicate M11 campaign is active. The script refuses a candidate SHA that differs from checkout `HEAD`.

The campaign uses synthetic data only. It does not discover private histories, load provider configuration, call a model, change shared policy, or create an independent live-host capacity pool. All catalog, capsule, and search workers in one lane use one campaign-owned scheduler namespace and the requested 1–4 slot limit.

Reference host inspection before implementation found 2.1 TiB free under `/home`, 31 GiB RAM with 19 GiB available, and 24 logical CPUs. This observation is not a reservation or a later launch check.

## Bounded execution plan

1. Build the exact integrated candidate through the repository's accepted native/build procedure.
2. Confirm the candidate SHA and exclusive campaign ownership.
3. Put the campaign root on `/home`, not the 16 GiB `/tmp` filesystem.
4. Launch the parent in an owner-only systemd user scope with these ceilings:
   - wall time: 36 hours;
   - campaign disk: 48 GiB, enforced again by the harness;
   - parent V8 heap: 512 MiB;
   - parent operating-system memory: 1 GiB;
   - swap: disabled for the campaign scope;
   - tasks: 512;
   - workers: existing 128 MiB V8 and 256 MiB operating-system limits;
   - admitted workers: at most four.
5. Retain a failed synthetic root for diagnosis. Copy and hash the safe aggregate report before removing a successful root.
6. For process-restart evidence, stop only the campaign parent after a completed checkpoint and invoke `resume` against the same owner-only root. A real system reboot is a separate operator step and must be recorded directly. Process resume is not system-restart evidence.

Estimated resources, based on the prior M05 136 MiB campaign duration and the current 32 KiB decoded chunk route:

- source generation: approximately 4–8 GiB of real JSONL bytes;
- derived stores and bounded evidence: approximately 12–30 GiB;
- hard disk stop: 48 GiB;
- expected wall time: 18–30 hours;
- hard wall stop: 36 hours.

These are planning estimates, not tested results.

```sh
cd packages/pi-chrono-compaction
SHA=$(git rev-parse HEAD)
node scripts/m11-scale-campaign.mjs plan --profile full --candidate-sha "$SHA"

# Only after final integrated-candidate and exclusive-run confirmation:
systemd-run --user --wait --pipe --collect \
  --unit="chrono-m11-${SHA:0:12}" \
  --property=MemoryMax=1073741824 \
  --property=MemorySwapMax=0 \
  --property=TasksMax=512 \
  --property=RuntimeMaxSec=129600 \
  node --max-old-space-size=512 scripts/m11-scale-campaign.mjs run \
    --profile full \
    --candidate-sha "$SHA" \
    --campaign-root "$HOME/.local/state/chrono-m11/$SHA" \
    --output "$HOME/.local/state/chrono-m11-results/$SHA.json"
```

## Actual scale represented by the full profile

The generator writes real decoded text into real JSONL files. It does not create sparse files or multiply a smaller output into a scale claim.

- 16 logical synthetic sessions.
- 4,000,000,000 generated decoded UTF-16 units before JSON encoding.
- At least 1,000,000,000 estimated tokens under the runtime rule `ceil(text.length / 4)`.
- One 400,000,000-unit session, exactly 100,000,000 estimated tokens before small metadata additions.
- Remaining sessions contain 240,000,000 units each.
- Physical shards hold at most 64 MiB of generated decoded bodies.
- Real source bytes, events, shards, and token estimates are counted from generation results.
- 128 real deterministic `composeShadowContext` generations run twice and must have equal payload hashes.

The current harness runs session/slot endpoints as 4 sessions with one slot, 8 with two slots, and 16 with four slots. It does not claim the nine-row Cartesian product. Add that matrix only if the project lead requires all nine combinations and approves the extra time and derived disk.

## Revision-bound prior evidence mapping

Prior evidence is supporting evidence only. Later runtime changes mean it cannot establish a final-candidate M11 pass by itself.

| M11 row or metric | Existing evidence | Reuse boundary |
| --- | --- | --- |
| Shared admission, one/two slots, independent clients | M04 accepted report at `a13669b4a8a5afdf758cdfd357d01d9a68b5e5e7`: 50,000 records, slots 1/2, two independent clients, settled admissions | Scheduler behavior support. Final 4/8/16-session candidate measurements still required. |
| Worker crash and released capacity | M02 accepted report at `2bd0195a6d84f20fad016ba7eba61786393edeeb`: six sessions, two slots, controlled missing entrypoint, zero residue. Milestone ledger records M03 death/recovery evidence at `afec7d3ac48ef369b27c6609347666af2f8c289b` | M04-accepted scheduler, worker runtime, catalog worker client, and catalog worker entry paths have no source diff through starting `d9c5f1f`. This is reusable for those unchanged paths, but final 4/8/16-session measurements remain required. |
| Process kill during catalog publication and source preservation | M04 report: real process-kill publication tests, transactional mutation rollback, immutable source hashes, old pins | `catalog-store.ts` and the M04 worker/runtime paths have no source diff from accepted M04 through starting `d9c5f1f`. This is reusable process-kill evidence. It is not device power-loss evidence. |
| Large source and bounded ingestion | M04 report: 289,678,089 source bytes and 50,000-record campaign under fixed limits | Actual prior scale, but below M11 token and aggregate targets. |
| Large decoded record, chunks, exact ranges, worker RSS | M05 accepted head `6a624dd5b6fd64365a3820b6e71c1f0242a35025`: 136 MiB body and 2,048-record campaigns, exact first/late ranges, source preservation and settlement | Supports generator, chunk, and exact-recovery expectations. Capsule/catalog files changed later, so final candidate must run. |
| Search to recall to exact source | M06 accepted head `a4ad86c1fff3c28a5f27eee739a6508afb9181ed`: actual indexed prefix search, recall, exact recovery | Functional precedent. No release-scale latency distribution or final-head evidence. |
| Restart and pinned generation | M04/M05/M06 reports cover process restart, append, old pins, schema refusal, and recovery | Process-restart support only. No system reboot in the M11 scale campaign. |
| Corrupt derived data | M02 fault controller and M04/M05 publication tests cover corrupt/truncated artifacts and refusal | Final integrated M11 corrupt-segment and repair timing remain missing. |
| p50/p95/p99 and RSS | Prior reports include maxima and selected query latencies | They do not contain the full required M11 distributions or synchronized total-host RSS. |
| Context coverage | M02 reports restriction/source-reference metrics; M09 evidence in the M06 report records exact coverage flags and known failures | Final 100+ generation coverage must be measured on the integrated candidate. |
| Logical shards, forks, rollover | M04/M05 cover declared shards/forks. M10 is a separate final-candidate dependency | M10 evidence must be supplied by its owner. This harness uses actual physical files but does not invoke Pi session switching. |

All named evidence heads are ancestors of the starting `d9c5f1f` checkout. This ancestry does not make changed runtime paths equivalent.

## Measurements produced by the harness

The safe JSON report contains:

- actual generated decoded units, estimated tokens, JSONL bytes, events, physical shards, and compaction records;
- main-process baseline/final RSS and cgroup observations;
- maximum observed worker RSS and worker cgroup peak;
- event-loop delay p50/p95/p99;
- search p50/p95/p99;
- recall p50/p95;
- exact retrieval and deterministic composition distributions;
- per-operation source-reader bytes;
- combined process I/O counters;
- failure-code counts;
- scheduler settlement;
- sampled exact-reference results;
- deterministic composition count and mandatory coverage flags;
- fault status with explicit `passed`, `pending`, reused revision, or unavailable wording.

## Metrics that are not currently verifiable

The current public worker observations do not separate these values:

- synchronized total host RSS across unrelated live processes;
- immutable-segment bytes read apart from combined process I/O;
- scheduler queue wait apart from complete request wall time;
- settled-event to ingestion-ready lag;
- system restart recovery without an actual operator reboot;
- Pi model continuation quality, because providers are forbidden for this campaign.

The report must keep these fields unavailable. Do not derive them from maxima, wall time, source bytes, or process I/O.

## Preparation checks

- Syntax and revision-bound `plan` output passed. The plan reported 16 sessions, 4,000,000,000 decoded units, 1,000,000,000 minimum estimated tokens, one 100,000,000-token session, 128 composition generations, a 48 GiB disk ceiling, and a 36-hour wall ceiling.
- The focused harness contract test compiled and passed 3/3 checks. It covers revision/path binding, exact full-profile arithmetic, and observed percentile calculation.
- Smoke attempt 1 stopped in 26 ms before runtime work because this worktree had no dependencies. Safe result SHA-256: `8cda989d568ccad217880f8965625b28d15f0c9bf5a094e3f4c120e0eca3e6bf`.
- Smoke attempt 2 used the matching ignored 0.85.1 dependency tree and stopped after 926 ms with `catalog-sqlite-failed`. Diagnosis found that the borrowed tree did not contain a built native `better-sqlite3` binding. Safe result SHA-256: `0eb8a54093053150b3aa623c7c67736465fd102a271296cc7869f48958630dec`.
- No third synthetic harness run, native rebuild, broad suite, provider call, or full-scale launch occurred. The failed owner-only roots remain available for local diagnosis.

## Remaining implementation and execution gaps

- A controlled native build is required before even the small end-to-end path can pass. The two smoke attempts are failures, not M11 evidence.
- The full campaign has not run on the final integrated M08/M09/M10/M12 candidate.
- The current harness does not inject repeated worker death or kill a live transaction. Prior evidence is revision-bound and later runtime changed.
- The current harness refuses stale schema and preserves a pinned view across source append, but does not yet corrupt and repair a derived segment.
- The current harness does not perform a real system reboot.
- M10 must provide actual Pi rollover, continuation, rollback, and ancestor routing evidence. Physical synthetic shard files alone do not prove Pi session switching.
- Total host RSS, segment-only reads, queue wait, and ingestion-lag duration remain uninstrumented.
- The endpoint session/slot lanes are not a nine-row Cartesian product.
- No full-campaign pass claim is valid until the aggregate report exists, is revision-bound to the final candidate, and every required gap is either tested or accepted with a justified threshold revision.
