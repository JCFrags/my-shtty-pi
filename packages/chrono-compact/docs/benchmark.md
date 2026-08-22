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

The public benchmark has no comparator mode. Historical evaluation, private fixtures, and private wrappers remain outside this repository.

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
