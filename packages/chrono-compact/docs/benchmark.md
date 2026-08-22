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
