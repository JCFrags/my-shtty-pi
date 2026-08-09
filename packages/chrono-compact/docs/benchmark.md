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
