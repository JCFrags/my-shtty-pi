# M11 qualification evidence plan

Status: the first full campaign prepared all catalog, capsule, and search stores, then failed after 28,693,015 ms with `search-v3-query-budget` before state materialization, faults, matrix lanes, or composition. Its retained data and failure report are not a pass. The later [report correction and retained-tail command](M11-report-correction.md) addresses a reproduced final-aggregation failure without changing the retained runtime or certifying a completed campaign. The separate recovery command is implemented but has not run. It requires natural settlement and a new parent exact-go after implementation delivery.

## Run boundary

Run the full campaign only after the project lead supplies the final integrated commit and confirms that no duplicate M11 campaign is active. The script refuses a candidate SHA that differs from checkout `HEAD`.

The campaign uses synthetic data only. It does not discover private histories, load provider configuration, call a model, change shared policy, or create an independent live-host capacity pool. All catalog, capsule, and search workers in one lane use one campaign-owned scheduler namespace and the requested 1–4 slot limit.

Reference host inspection before implementation found 2.1 TiB free under `/home`, 31 GiB RAM with 19 GiB available, and 24 logical CPUs. This observation is not a reservation or a later launch check.

## Bounded execution plan

1. Build the exact integrated candidate through the repository's accepted native/build procedure. For the retained main build, `better-sqlite3@12.9.0` on Node 24.18.0 uses `better_sqlite3.node` SHA-256 `baac38739b5e4c5137ea0514c451df58423c2e626f43cddcfb4542206f93d013`. Verify both package version and hash before reuse. A later final candidate must repeat its own accepted dependency/native verification.
2. Confirm the candidate SHA and exclusive campaign ownership.
3. Put the campaign root on `/home`, not the 16 GiB `/tmp` filesystem.
4. Launch the parent in an owner-only systemd user service with these resource settings and a separate disk acceptance check:
   - wall time: 36 hours, enforced externally by systemd `RuntimeMaxSec`. The harness reports `wallLimitMs` but has no internal wall-time watchdog;
   - campaign disk: 48 GiB, checked by the harness after the qualification work. This is not a continuous disk quota or a systemd limit;
   - parent V8 heap: 512 MiB;
   - parent operating-system memory: 1 GiB;
   - swap: disabled for the campaign scope;
   - tasks: 512;
   - workers: existing 128 MiB V8 and 256 MiB operating-system limits;
   - admitted workers: at most four.
5. Retain a failed synthetic root for diagnosis. Copy and hash the safe aggregate report before removing a successful root.
6. For process-restart evidence, invoke `resume` against the same owner-only root only after the parent confirms that the campaign process and its separately contained workers have settled. `prepared-state.json` is a data checkpoint, not a safe pause point. The harness starts fault injection immediately after writing it, so a polling stop can interrupt corruption restoration. Do not stop merely because that file appears. A real system reboot is a separate operator step and must be recorded directly. Process resume is not system-restart evidence.

Estimated resources, based on the prior M05 136 MiB campaign duration and the current 32 KiB decoded chunk route:

- source generation: approximately 4–8 GiB of real JSONL bytes;
- derived stores and bounded evidence: approximately 12–30 GiB;
- end-of-run disk acceptance threshold: 48 GiB, without a continuous hard quota;
- expected wall time: 18–30 hours;
- external systemd wall cutoff: 36 hours.

These are planning estimates, not tested results.

```sh
cd packages/pi-chrono-compaction
SHA=$(git rev-parse HEAD)
node scripts/m11-scale-campaign.mjs plan --profile full --candidate-sha "$SHA"
mkdir -p "$HOME/.local/state/chrono-m11" "$HOME/.local/state/chrono-m11-results"

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

### Historical retained preparation resume

This is the original pre-state resume route. It is not current-main or post-matrix recovery. Use the separate retained-tail command only within its narrower approved boundary.

The failed preparation candidate is `aa160c082dd9f027b0e378c53c2784e00ef1727e`. Resume may reuse its completed catalog, capsule, and search stores only when the harness validates all of these conditions:

- the manifest names that preparation candidate and the generated source files still match their catalog snapshot identities, exact sizes, and sampled anchor hashes;
- catalog, derived, and search metadata, schema versions, routes, identities, views, generations, readiness counts, and failure counts match exactly;
- all preparation-path Git differences between the preparation candidate and final candidate are on the narrow allowlist. The allowlist contains only the literal-query planner source and generated output;
- the final candidate uses the same existing postings and does not rebuild, clear, or regenerate the retained source or stores.

The literal correction uses one quoted FTS5 phrase for literal candidate selection. Ranked search keeps its bounded OR-term plan. Exact source verification and all existing candidate, request, response, memory, worker, disk, and wall limits remain unchanged.

After the corrected candidate is built and its SHA is final, use the existing owner-only root and a new safe output file:

```sh
cd packages/pi-chrono-compaction
SHA=$(git rev-parse HEAD)
systemd-run --user --wait --pipe --collect \
  --unit="chrono-m11-resume-${SHA:0:12}" \
  --property=MemoryMax=1073741824 \
  --property=MemorySwapMax=0 \
  --property=TasksMax=512 \
  --property=RuntimeMaxSec=129600 \
  node --max-old-space-size=512 scripts/m11-scale-campaign.mjs resume \
    --candidate-sha "$SHA" \
    --prepared-candidate-sha aa160c082dd9f027b0e378c53c2784e00ef1727e \
    --campaign-root "$HOME/.local/state/chrono-m11/aa160c082dd9f027b0e378c53c2784e00ef1727e" \
    --output "$HOME/.local/state/chrono-m11-results/${SHA}-resume.json"
```

A resumed report must record both candidate SHAs and that 16 prepared stores were reused. Initial preparation latency, request, process-I/O, and worker-peak measurements were not persisted by the failed process. They remain unavailable and resumed measurements must not replace them.

The retained M07 runtime at `09a8e9147095079668689546ae85146d787d8b68` processes one large-body chunk per worker job. The first chunk covers 32,768 decoded UTF-16 units and each later overlapped chunk advances by at least 24,576 units. Applying that contract to the retained indexed source ranges projects 164,170 body-step calls across 16 sessions, plus final completion work. This is a calculation from retained metadata, not measured runtime. The harness uses a finite per-session upper guard derived from decoded units, record count, the 24,576-unit minimum progress, and eight-event metadata pages: 34,322 calls for the largest session and 9,262 for each other session. These guards do not increase any worker, source, output, memory, or externally enforced wall-time cap. If systemd reaches the 36-hour cutoff, the campaign has not passed and might not write a result JSON. The parent must also establish that the separately contained workers have settled.

## Separate retained-tail recovery

Use `scripts/m11-retained-tail-recovery.mjs`, not ordinary `resume`, for the anticipated natural final-aggregation failure under exact frozen runtime `09a8e9147095079668689546ae85146d787d8b68`. The [command documentation](M11-report-correction.md#exact-go-input-and-invocation) defines the hash-bound approval file, unchanged runtime/dependencies, original parent identity receipt, existing nonblocking lock, all worker namespaces, exclusive output, and external two-hour guard.

It validates completed retained state and exactly one original matrix suffix. It then permits only three fault worker calls, nine lanes/504 calls, 39 lease probes, 84 new tiny appends, and 128 double compositions. The 80 validation worker calls, 64 read-only database opens, bounded source reads, and validation time are separate measurements. Missing original metrics remain unavailable. A completed frozen tail does not qualify the final runtime or close the remaining M11 gaps.

## Minimal final-runtime qualification route

This is planning for the parent to approve, not an additional test campaign. The comparison is exact frozen `09a8e9147095079668689546ae85146d787d8b68` against accepted `613d523610a869a6dc801ef8a7d1dcc326883beb`, runtime version `2.0.34`. Refresh the comparison if the final source changes. Do not repeat source generation or infer state equivalence from schema numbers, complete cuts, or row counts.

| Changed production paths, with corresponding generated JavaScript | Smallest affected behavior check |
| --- | --- |
| `catalog-sqlite.ts`, `logical-session-store.ts`, repair paths in `episode-state-store.ts` | One small disposable store scenario that distinguishes recognized corruption/repair from permission or storage failure. Require unchanged source, safe error classification, no reset on denied parent access, and bounded successful recovery only for the supported repair case. |
| `episode-state-contract.ts`, `episode-state-reducer.ts`, `episode-state-store.ts` | One dense synthetic state scenario through actual materialization, stored selection, and exact recall. Include supersession at old/new cuts, sibling exclusion, explicit custom-message authority, protected-row coverage, and mandatory-row overflow refusal. Check real selected content and provenance, not only completeness flags. |
| Batching and large-body paths in `episode-state-store.ts` | One body that crosses overlapping chunks plus enough small records to cross the new batch boundary. Resume an interrupted step on the same synthetic source, finish metadata, and compare the resulting selection with an uninterrupted result. Require bounded work and no duplicate or missing state. |
| `search-v3-store.ts` | One small literal search/recall scenario that needs lexical fallback, including punctuation or text without a useful FTS candidate. Check exact verification, old-view exclusion of later appends, and truthful bounded refusal when the candidate budget is exhausted. |
| `runtime-identity.ts` | Verify the accepted package/native identity and the identity reported by the actually loaded final tool during the checks above. A build or settings change alone is not activation evidence. |

Prefer the corresponding existing focused checks and practical tool calls. These are four behavior scenarios plus identity verification, not a request to add a new suite or rerun the full preparation. The parent must settle the exact test selection and any additional scope first.

Separate evidence reuse as follows:

- The manifest and preserved source hashes can support the original real source-scale claim. They do not provide lost historical preparation latency or I/O distributions.
- Catalog, capsule, chunk, scheduler, and worker producer paths outside the listed storage-wrapper changes have unchanged production source in this comparison. Their revision-bound source/preparation evidence can support those paths after exact identity/compatibility checks. This is not permission to widen ordinary resume or use a different runtime on the retained stores.
- Frozen state materialization, saved selections, and frozen composition results remain evidence for `09a8e91` only. Changed reduction, effective cuts, supersession, repair, selection coverage, and lexical behavior require the final-runtime checks above. An unchanged composer does not make its changed state inputs equivalent.
- Final integrated Pi behavior, remaining scale-matrix performance, reboot evidence, and other unverified M11 rows remain separate acceptance decisions. Neither the small final-runtime checks nor the frozen retained tail alone produces full M11 acceptance.

## Actual scale represented by the full profile

The generator writes real decoded text into real JSONL files. It does not create sparse files or multiply a smaller output into a scale claim.

- 16 logical synthetic sessions.
- 4,000,000,000 generated decoded UTF-16 units before JSON encoding.
- At least 1,000,000,000 estimated tokens under the runtime rule `ceil(text.length / 4)`.
- One 800,000,000-unit session, exactly 200,000,000 estimated tokens. This meets the charter's plural "hundreds of millions" scale.
- The remaining 3,200,000,000 units are distributed exactly across 15 sessions without extrapolation.
- Physical shards hold at most 64 MiB of generated decoded bodies. The largest session has at least 12 physical shards, and the campaign requires at least ten.
- Real source bytes, events, shards, and token estimates are counted from generation results.
- 128 real deterministic `composeShadowContext` generations run twice and must have equal payload hashes.

The harness prepares each generated catalog, capsule, search, and state store once. It then runs the complete nine-row Cartesian matrix: 4, 8, and 16 active sessions at 1, 2, and 4 shared worker slots. Query lanes reuse immutable prepared generations and add bounded real source appends, so the matrix does not duplicate the large derivation campaign.

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
| Corrupt derived data | M02 fault controller and M04/M05 publication tests cover corrupt/truncated artifacts and refusal | The current harness also corrupts the exact capsule segment selected by the store, requires `capsule-content-corrupt`, restores the verified bytes, measures recovery, and rechecks every source-shard hash. |
| p50/p95/p99 and RSS | Prior reports include maxima and selected query latencies | They do not contain the full required M11 distributions or synchronized total-host RSS. |
| Context coverage | M02 reports restriction/source-reference metrics; M09 evidence in the M06 report records exact coverage flags and known failures | Final 100+ generation coverage must be measured on the integrated candidate. |
| Logical shards, forks, rollover | M04/M05 cover declared shards/forks. M10 core is integrated at `dba62fb`. The later M12 hook and fixture at `67b08a8` have fresh Pi 0.85.1 resume/adoption evidence: an existing on-disk source was resumed twice with automatic logical binding and search/recall/exact recovery in 14.54 s | This harness performs real catalog ingestion plus search and recall for every generated physical shard, including at least ten in the largest logical session. It does not invoke Pi switching, so the M10 Pi evidence remains separate. |

All named evidence heads are ancestors of the starting `d9c5f1f` checkout. This ancestry does not make changed runtime paths equivalent.

## Measurements produced by the harness

The safe JSON report contains:

- actual generated decoded units, estimated tokens, JSONL bytes, events, physical shards, and compaction records;
- campaign-parent baseline/final RSS and cgroup observations, separate worker peaks, and sampled whole-workstation process RSS;
- maximum observed worker RSS and worker cgroup peak;
- event-loop delay p50/p95/p99;
- search p50/p95/p99;
- recall p50/p95;
- exact retrieval and deterministic composition distributions;
- per-operation source-reader bytes;
- per-operation process I/O counter distributions;
- failure-code counts;
- measured scheduler queue wait/position and scheduler settlement for every matrix lane;
- append-to-caught-up ingestion lag;
- sampled exact-reference results;
- deterministic composition count and actual coverage flags from `materializeState` through `composeStateSelection` and `composeStoredSelection`;
- fault status with explicit `passed`, `pending`, reused revision, or unavailable wording.

## Metrics that are not currently verifiable

The current public worker observations do not separate these values:

- synchronized total host RSS with shared-page attribution. The harness supplies baseline/final whole-workstation `VmRSS` sums instead;
- immutable-segment bytes read apart from combined process I/O;
- queue wait for an individual contained worker request, because current clients discard `runBoundedWorker` metrics. The harness separately measures real scheduler lease queue wait and maximum queue position in each matrix lane;
- lifecycle settled-event to background-ready lag. The harness does measure append completion through the caught-up catalog response;
- system restart recovery without an actual operator reboot;
- Pi model continuation quality, because providers are forbidden for this campaign.

The report must keep these fields unavailable. Do not derive them from maxima, wall time, source bytes, or process I/O.

## Preparation checks

- Syntax and revision-bound `plan` output passed. The corrected plan reports 16 sessions, 4,000,000,000 decoded units, 1,000,000,000 minimum estimated tokens, one 200,000,000-token session, 128 composition generations, all nine concurrency rows, a 48 GiB disk ceiling, and a 36-hour wall ceiling.
- The focused harness contract test compiled and passed 3/3 checks. It covers revision/path binding, exact full-profile arithmetic, and observed percentile calculation.
- Smoke attempt 1 stopped in 26 ms before runtime work because this worktree had no dependencies. Local result SHA-256: `8cda989d568ccad217880f8965625b28d15f0c9bf5a094e3f4c120e0eca3e6bf`.
- Smoke attempt 2 used the matching ignored 0.85.1 dependency tree and stopped after 926 ms with `catalog-sqlite-failed`. Diagnosis found that the borrowed tree did not contain a built native `better-sqlite3` binding. Local result SHA-256: `0eb8a54093053150b3aa623c7c67736465fd102a271296cc7869f48958630dec`.
- The retained accepted main dependency tree then verified `better-sqlite3@12.9.0` and native binding SHA-256 `baac38739b5e4c5137ea0514c451df58423c2e626f43cddcfb4542206f93d013`. The one authorized affected smoke retry passed generation and the catalog, capsule, search, recall, pinned-append, exact-retrieval, stale-schema, and scheduler-settlement phases. It reached deterministic composition after 76.191 seconds, then exposed an invalid synthetic composition cut. Local result SHA-256: `23180e6f0fbb0408a3d5eb317e4824558c9d559ce607985c5d68df32c1e15315`.
- The next authorized smoke prepared real catalog, capsule, search, and state stores with the verified native binding, then exposed that the fault injector corrupted an unselected segment. It failed after 55.481 seconds, before matrix lanes. Local result SHA-256: `6a9ed1a33280d239507fbfb4b2c16991621693d51a3a5fd3aeca8ec1f81c8a86`.
- The corrected injector selects the exact first capsule segment through the derived catalog. A focused final-path check returned `capsule-content-corrupt`, restored the original bytes, recovered in 503 ms, refused the incompatible search generation, and verified every source-shard hash unchanged.
- A focused 4-session/1-slot lane passed with one shared scheduler: three measured lease waits had p50 441 ms and p95/p99 616 ms, maximum queue position 3, four searches, four recalls, twelve exact operations including large decoded chunk reads, four measured append lags, and zero ticket/slot residue.
- A direct actual-producer composer check used retained `materializeState` and `composeStateSelection` output. Two compositions had equal hashes. Actual validation was safe-tail true, within-ceiling true, protected coverage false, and open-work coverage true. The false protected result is retained rather than hand-overridden. The generator now places one bounded explicit restriction separately from neutral large payloads for the final campaign.
- The first full campaign generated the full source scale and completed all 16 catalog, capsule, and search stores. Its first literal shard-marker query exceeded the 128-candidate budget because literal mode incorrectly shared ranked mode's broad OR-term candidate plan. Read-only inspection found 214–782 candidates for the failing unscoped queries. A quoted FTS5 phrase returns exactly one candidate for each of all 72 retained marker targets from the existing postings.
- The retained stores contain 3,967 catalog events across 72 shards; 3,967 capsule-ready records with zero capsule failures; and 3,967 search documents, 3,839 raw-ready documents, 128 generated exclusions, 122,096 chunks, and 16 complete search heads. No state materialization, matrix lane, fault phase, or composition completed.
- No provider call occurred. The retained owner-only root remains available for bounded recovery and must not be cleared or regenerated.

## Remaining implementation and execution gaps

- A controlled native build or an exact verified reusable native binding is a campaign prerequisite. The complete smoke attempts are failures, not a complete M11 pass. Focused final-path fault, lane, and actual-producer composition checks passed after the last failure.
- The retained full campaign preparation ran at `aa160c082dd9f027b0e378c53c2784e00ef1727e`, with the later state resume at frozen `09a8e91`, not final runtime `2.0.34`. Ordinary resume keeps its strict preparation-path allowlist. Separate frozen retained-tail recovery does not authorize current-main store or selection reuse. The parent must approve the concrete final-runtime checks and evidence boundaries above.
- The current harness does not inject repeated worker death or kill a live transaction. Prior evidence is revision-bound and later runtime changed.
- The current harness safely refuses an incompatible search generation, preserves a pinned view across source append, and corrupts/restores one selected capsule segment with source hashes unchanged. It does not rebuild a completely new derived store after corruption because exact-byte restoration is the bounded repair under test.
- The current harness does not perform a real system reboot.
- M10 supplies fresh Pi resume/adoption and logical binding evidence. Actual Pi rollover, switch, and rollback across the generated ten-plus-shard scale remain outside this core campaign.
- M04/M05 revision-bound evidence covers forks and sibling isolation. The current full generator does not add an abandoned-branch workload, so final-candidate abandoned-branch evidence remains a gap.
- Whole-workstation process RSS is sampled by summing readable `VmRSS` values and is explicitly distinct from campaign-parent RSS, worker RSS/cgroup peaks, and any actual Pi process. No Pi process participates in this core-only synthetic campaign, so main-Pi RSS remains unavailable.
- Segment-only reads remain unavailable. The report includes actual per-operation worker `readChars`, `writeChars`, storage-read, and storage-write distributions without mislabeling them as segment-only I/O.
- Actual scheduler queue wait and append-to-caught-up lag are instrumented. Background lifecycle settled-to-ready lag remains unavailable.
- No full-campaign pass claim is valid until the aggregate report exists, is revision-bound to the final candidate, and every required gap is either tested or accepted with a justified threshold revision.
