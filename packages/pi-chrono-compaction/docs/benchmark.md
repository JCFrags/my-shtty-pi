# Public benchmark

`../scripts/benchmark-v2.mjs` is a manual benchmark. It is not part of the npm payload.

## Run

Build the package, then run the synthetic benchmark:

```bash
npm run benchmark
```

The default input is generated in memory with 250 synthetic tasks. It does not inspect Pi sessions, home directories, environment settings, or the current process. A smaller or larger synthetic run can use an explicit count from 1 through 1,000:

```bash
node scripts/benchmark-v2.mjs --synthetic-tasks 100
```

This option cannot be combined with an external fixture. Focused automated checks use a small synthetic count so the manual benchmark does not add heavy parallel load to the normal test suite.

An external fixture requires an explicit option:

```bash
node scripts/benchmark-v2.mjs --fixture ./fixture.jsonl
```

The fixture must be one regular, non-symlinked `.jsonl` file no larger than 16 MiB. The benchmark opens it without following symlinks where the platform supports that flag, then verifies the opened file identity, regular-file type, and size before reading. It does not scan directories. The input must use the package's supported Pi JSONL format.

The command prints one aggregate JSON object. It does not print fixture paths, source text, queries, probes, recovered text, identifiers, or input fingerprints. Timing fields are advisory and can vary. The schema version and non-timing aggregate fields are intended to remain stable.

The V2 replay benchmark has no comparator mode. Historical evaluation, private fixtures, and private wrappers remain outside this repository.

## Background value-worker benchmark

`scripts/benchmark-value-worker.mjs` is an offline measured harness over the built value-worker modules. It creates real owner-only candidate and advice files, uses real batching, scheduling, retry, repair, circuit, budget, advice-loading, and score-application code, and injects a deterministic fake model through the production call seam. The fake records prompts, thinking, attempts, repairs, and usage. It never opens its invalid example URL and makes no network call.

```bash
node scripts/benchmark-value-worker.mjs series --final-tasks 5000 --batches 50
node scripts/benchmark-value-worker.mjs advisory --tasks 5000
node scripts/benchmark-value-worker.mjs failures
node scripts/benchmark-value-worker.mjs budget --segments 1000
```

`series` reports measured incremental work and an exact-hit second run. `advisory` measures production advice application and runs deterministic off, shadow, and advisory compaction validation after real fake-model orchestration. `failures` invokes 18 safe model-resolution, retry, repair, budget, circuit, cancellation, contention, and corruption cases. `budget` stops real orchestration at a hard call boundary. These synthetic results establish implementation behavior, not real-provider advice quality.

## Hierarchical history rollup benchmark

`scripts/benchmark-history-rollups.mjs` measures the isolated rollup prototype with synthetic data. It has strict `series`, `render`, `scale`, `metadata`, `query`, `restrictions`, `branch`, and `compare` modes. It uses owner-only temporary files and no network. It does not discover or read private sessions.

```bash
npm run benchmark:history-rollups -- series --final-tasks 5000 --batches 50
npm run benchmark:history-rollups -- render --tasks 1000 --target-tokens 20000
npm run benchmark:history-rollups -- scale --source-tokens 50000000 --batches 50 --target-tokens 20000
npm run benchmark:history-rollups -- branch --common-tasks 5000 --left-tasks 5000 --right-tasks 5000
npm run benchmark:history-rollups -- compare --tasks 5000
```

The comparator reports current replay and prototype render measures for the same synthetic branch. It does not change either path. Metadata mode can model one million entry descriptors without one large source body. Query mode measures bounded top-down recovery of omitted old evidence. Restriction mode measures final-line recovery under pressure. See [history-rollup-store.md](history-rollup-store.md).

## Rollup shadow benchmark

`scripts/benchmark-rollup-shadow.mjs` uses synthetic source only. It schedules the same low-priority one-job worker used by the default-off shadow setting. It has strict `compare`, `generations`, `pressure`, and `failures` modes.

```bash
npm run benchmark:rollup-shadow -- compare --tasks 5000
npm run benchmark:rollup-shadow -- generations --final-tasks 1000 --generations 50
npm run benchmark:rollup-shadow -- pressure --source-tokens 50000000 --restrictions 1000
npm run benchmark:rollup-shadow -- failures
```

Compare mode runs the current replay, then measures rollup update, render, final quality, worker delay, and unchanged current bytes. Generations mode measures repeated replay and post-result shadows with one bounded sidecar. Pressure mode skips the current full replay and measures only bounded rollup work. Failure mode checks every strict stage and safe code and reports counts only. Reports contain aggregate public values. They contain no output text, source text, path, entry ID, source reference, or hash. See [rollup-shadow.md](rollup-shadow.md).

## Repeated-generation and concurrent-process benchmark

`scripts/benchmark-generations.mjs` measures repeated full-prefix compactions in one process and simultaneous synthetic compactions in separate child processes. It uses only the deterministic synthetic generator and built package. It does not inspect real sessions, scan directories, read home data, use the network, or persist benchmark data.

Build and run a generation series:

```bash
npm run benchmark:generations -- series --final-tasks 1000 --generations 25
node scripts/benchmark-generations.mjs series --final-tasks 1000 --generations 50
```

Run concurrent process probes:

```bash
node scripts/benchmark-generations.mjs concurrent --tasks 1000 --workers 2
node scripts/benchmark-generations.mjs concurrent --tasks 1000 --workers 4
```

Run one process-level compaction probe:

```bash
node scripts/benchmark-generations.mjs single --tasks 2000
```

The series output reports requested and actual generation counts, final and cumulative source tokens, source-work amplification, compaction times, process memory, timer delay, and quality fields. Source-work amplification is cumulative source tokens processed divided by final source tokens.

The concurrent output reports worker count, source tokens, wall and worker times, summed child peak RSS, timer delay, and quality fields. `sumWorkerPeakRssKiB` is the sum of child peak values. It is not a measured host peak.

`maximumTimerDelayMs` is a process-level timer probe around compaction. It is not a complete Pi UI latency measurement. All timing and memory measurements are advisory.

## Source-ledger benchmark

`scripts/benchmark-source-ledger.mjs` measures the isolated incremental source ledger with synthetic Pi JSONL data. It creates and removes one temporary session and sidecar. It does not inspect real Pi sessions.

Build and run it with:

```bash
npm run benchmark:source-ledger -- --final-tasks 2000 --batches 20
node scripts/benchmark-source-ledger.mjs --final-tasks 5000 --batches 50
node scripts/benchmark-source-ledger.mjs large-entry --tokens 500000
```

The task mode reports initial build, warm append, exact-hit, cold sidecar-load, exact-retrieval, memory, and integrity fields. `sourceReadAmplification` is the source bytes read by the initial build and append updates divided by final source bytes. It excludes cold sidecar reads. `exactHitSourceBytesRead` is the bounded tail anchor read. `exactRetrievalBytesRead` is the sum of the selected early, middle, and late entry lengths. Timing and memory fields are advisory.

Large-entry mode builds one synthetic tool-result entry, runs an exact hit, appends one small entry, retrieves the complete large entry, and loads the sidecar cold. `sourceLineAssemblyBytes` reports bytes copied when chunk parts are joined once. `maximumSourceLineBytes` reports the largest complete line. `exactHitAnchorBytesRead` and `appendAnchorBytesRead` are fixed-size tail checks. `appendNewSourceBytesRead` is the small suffix. `exactRetrievalBytesRead` is the complete requested entry and is not an anchor read.

## Candidate-segment benchmark

`scripts/benchmark-candidate-segments.mjs` measures the source-ledger-backed immutable candidate store with synthetic Pi JSONL. It creates and removes owner-only temporary sessions, ledgers, manifests, and segments. It does not inspect real Pi sessions.

```bash
npm run benchmark:candidate-segments -- series --final-tasks 5000 --batches 50
npm run benchmark:candidate-segments -- compare --tasks 5000
npm run benchmark:candidate-segments -- entries --entries 25000
npm run benchmark:candidate-segments -- generations --final-tasks 1000 --generations 50
```

`series` reports source-read, block-parse, and persistent-candidate work amplification. It also reports immutable segment reuse, store sizes, timer delay, exact-hit time, and cold manifest and segment load times. `compare` checks exact summary, plan, validation, generation-hash, and rendered-token equivalence for warm and reloaded stores. `entries` checks limits independently of the retired 20,000-entry and 16 MiB whole-checkpoint caps. `generations` reports cumulative work and output equivalence across repeated appends and compactions.

On 2026-08-22, three serial runs per size gave these medians. Timing and memory are advisory.

| Tasks / batches | Source-read amplification | Block-parse amplification | Candidate-work amplification | Total append ms | Final append ms | Exact hit ms | Store bytes |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,000 / 10 | 1.0034 | 1.0000 | 1.0000 | 210.85 | 20.07 | 1.46 | 2,135,970 |
| 2,000 / 20 | 1.0035 | 1.0000 | 1.0000 | 418.06 | 22.45 | 1.73 | 4,283,440 |
| 5,000 / 50 | 1.0036 | 1.0000 | 1.0000 | 1,132.58 | 19.94 | 1.57 | 10,726,012 |

| Tasks | Cold compaction ms | Warm store ms | Reloaded store ms | Candidate load ms | Warm / cold |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 729.08 | 699.35 | 677.51 | 38.26 | 0.959 |
| 2,000 | 1,631.20 | 1,524.46 | 1,519.47 | 74.46 | 0.957 |
| 5,000 | 5,405.98 | 5,408.48 | 4,778.89 | 185.71 | 1.000 |

All compare runs were byte-equivalent and remained within 15% of cold compaction. The maximum median timer delay in the series table was 1.65 ms. One 25,000-entry run accepted all entries, built 13 segments and a 17,251,387-byte store, and loaded only the manifest in 0.39 ms. This exceeds both retired checkpoint limits without reintroducing them. One 50-generation run reported 1.0000 block-parse and persistent-work amplification, a 0.9671 candidate hit rate, and exact output equivalence.

## Ledger-branch benchmark

`scripts/benchmark-ledger-branch.mjs` uses synthetic sessions only. It creates owner-only temporary source, ledger, cache, and scheduler data and removes it after each run.

```bash
npm run benchmark:ledger-branch -- linear --tasks 5000
node scripts/benchmark-ledger-branch.mjs branched --active-tasks 5000 --abandoned-tasks 20000 --branches 4
node scripts/benchmark-ledger-branch.mjs retrieval --tasks 5000 --samples 500
node scripts/benchmark-ledger-branch.mjs worker --active-tasks 5000 --abandoned-tasks 20000 --branches 4
```

`linear` compares complete-file parsing with ledger cold load, branch resolution, and verified branch reads. It reports sidecar bytes and bytes per entry. `branched` adds abandoned source and source-byte avoidance. Source-byte avoidance is `1 - ledger source bytes read / complete source bytes`. Coalescing-gap bytes are bytes between selected entries that one bounded range also reads. `retrieval` requires exact text equality for record, block, page, ancestor-range, and file-order operations. `worker` compares the full-file reference replay with the normal ledger-backed child and reports output equality, wall time, RSS, source bytes, response bytes, and main-process timer delay. Timing and RSS are advisory.

## Explicit session-set benchmark

The [explicit session-set benchmark](local-session-benchmark.md) accepts only a private manifest. It never discovers session files.

```bash
npm run benchmark:sessions -- run \
  --manifest PRIVATE_MANIFEST.json \
  --output PRIVATE_REPORT.json \
  --minimum-bytes 1048576 \
  --minimum-count 12 \
  --maximum-files 100 \
  --maximum-minutes 120 \
  --per-session-timeout-seconds 900
```

The manifest lists explicit session JSONL paths. The command keeps sources read-only and benchmarks stable temporary snapshots. Output contains anonymous fixture IDs, aggregate numeric measurements, safe result counts, numeric distributions, and bounded failure categories. It excludes paths, file names, session IDs, source hashes, source references, source text, tool arguments, commands, URLs, recovered text, validation messages, and unit IDs.

`compactionOutcome` distinguishes success, no savings, hard-cap rejection, structural rejection, factual rejection, runtime failure, memory gating, invalid input, and timeout. `validationFailureCodes` and `validationFailureCodeCounts` contain safe codes only. Token fields record the raw source, effective target, and unchanged hard output limit. A `memory-gate` result means the source-ledger checks ran but conservative memory limits prevented full compaction. It is not a compaction failure.

Historical protected fields count all blocks, exact duplicates, and unique text groups. State-model restriction fields count deterministic restriction cells, exact value visibility, source-cue visibility, conflicts, and current-state selection. The state model is heuristic, not a perfect authority model. Final-plan fields separate plan representation, current-state coverage, and history-only recovery. Current-state line fields detect any rendered line without its complete source-link suffix.

Private manifests and reports must remain outside the repository and must not be committed.

## Isolated-worker benchmark

`scripts/benchmark-compaction-worker.mjs` uses generated synthetic JSONL only. It has no private fixture or discovery option. The `compare`, `queue`, `update`, and `generations` modes report aggregate numeric results without source text or identifiers.

The 5,000-task compare case ran three times on the baseline machine. Medians were 5,909.0 ms in process and 5,935.5 ms in the worker. Worker overhead was 0.45%. Every summary, generation hash, validation report, plan source set, and rendered token count was equivalent. Median main-process timer delay changed from 5,900.1 ms in process to 0.6 ms with the worker. Median worker peak RSS was 521,864 KiB. The complete response was 611,802 bytes, below the 8 MiB protocol limit. Every run reported zero model and network calls.

Five queued synthetic jobs reached maximum active counts of exactly 1, 2, and 4 for configured limits 1, 2, and 4. Each run ended with zero ticket and slot files. The 5,000-task candidate update took 1,191.1 ms, created eight segments, read 13,747,773 source bytes, had 0.9 ms main-process timer delay, and reported zero model and network calls.

These values show event-loop isolation and scheduler limits. They do not show lower total CPU work. Timing remains machine-specific.

A five-generation isolated series at 1,000 through 5,000 tasks measured worker wall times of 1,054.5, 2,019.6, 3,172.1, 4,501.2, and 6,110.8 ms. Main-process timer delay remained from 0.4 through 2.1 ms. Complete responses remained from 450,959 through 611,802 bytes.
