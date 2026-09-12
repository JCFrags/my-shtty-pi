# M11 report correction and recovery design

Status: the report arithmetic and exit-status correction is implemented. Recovery remains a design, not an executable mode. No scale campaign or recovery ran for this correction. The retained runtime is unchanged. See the [qualification plan](M11-qualification-plan.md) for the campaign boundary.

## Reproduced failure and correction

The retained harness at `09a8e9147095079668689546ae85146d787d8b68` calls `Math.max(...values)` for metric distributions and spreads all worker observations into two more `Math.max` calls. On Node 24.18.0, its `distribution` function throws `RangeError: Maximum call stack size exceeded` for both 135,179 and 164,170 samples. The latter is the retained preparation's calculated body-step count, not an invented stress-test scale.

The correction uses an iterative maximum for those campaign-sized arrays. Percentile selection, empty-distribution `null`, and empty-worker-peak zero remain unchanged. Small fixed-size session and queue arrays retain their existing code.

The old harness sets `passed=true` before constructing the report. An aggregation error then enters the failure-report catch without clearing that flag, so failed JSON can accompany exit code 0. The correction removes the separate flag. The report writer derives the exit code from the final report status after writing the JSON. An output or serialization error still reaches the command's top-level failure handler.

Two added focused checks cover campaign-sized distributions and worker maxima, and actual child-process exit codes plus written report status after a simulated aggregation failure. They do not generate sessions, open stores, start workers, or run the campaign. Only the affected test file was compiled and executed. Its five existing and added tests passed, along with script syntax and diff checks.

## What survives a natural aggregation failure

All paths in this section are relative to the retained campaign root.

| Persisted file or directory | Evidence retained |
| --- | --- |
| `campaign-manifest.json` | Original source-generation totals, sessions, shards, and preparation candidate |
| `prepared/session-*/search/state-v4.sqlite` | Committed body and metadata progress, state records, coverage, and generations |
| `prepared-state.json` | All completed session states, stored selections, views, identities, routes, and verified-shard counts |
| Catalog, derived, and search stores | Completed preparation and later committed catalog appends |
| Synthetic source shards | Original generated source plus completed matrix appends |

The harness awaits writing `prepared-state.json` before faults, matrix lanes, compositions, or final report construction. Thus the expensive state derivation is saved before the reproduced aggregation failure. Individual SQLite steps are committed even before that file exists. The file write is not an atomic pause protocol or proof of power-loss durability. Fault injection starts immediately afterward. Never stop the process merely because the file appears.

There is no persisted metric accumulator or post-matrix results checkpoint. The failure report retains candidate identities, the error, a retained-root flag, and wall time. Original latency distributions, worker peaks, per-operation I/O, queue measurements, fault timings, composition observations, process baselines, and event-loop measurements remain in memory and are lost on exit. Scheduler files and appended source records cannot reconstruct them.

The failure is still anticipated until a naturally settled process emits its actual result. A timeout or earlier failure does not prove that `prepared-state.json` exists or that later phases ran.

## Why current-main recovery is not implemented

The retained state runtime is `09a8e9147095079668689546ae85146d787d8b68`. The correction starts from accepted main `3d5c77d33804df4934985ba47dcb8d151a5792f8`. Their runtime source differences include:

- `src/catalog-sqlite.ts`
- `src/episode-state-contract.ts`, `src/episode-state-reducer.ts`, and `src/episode-state-store.ts`
- `src/search-v3-store.ts`
- `src/logical-session-store.ts` and `src/runtime-identity.ts`
- Corresponding generated JavaScript, package metadata, and the lockfile.

`catalog-sqlite.ts` and its generated output are outside the existing preparation allowlist. State-production code also changed, while the old preparation-path list does not cover the episode-state files. The same schema number or an unchanged record count cannot establish compatible state meaning. Do not broaden the allowlist or reuse stored selections under the changed runtime merely to satisfy a command.

Ordinary `resume` also requires `prepared-state.json.candidateSha` to equal the checkout candidate. Its saved-state path trusts the recorded states rather than repeating source/view/store validation. Its no-saved-state path requires original exact source sizes and event counts, which no longer describe sources after matrix appends. Neither path is a supported cross-revision report recovery. The current output writer can overwrite an existing output, so a future recovery mode must not reuse it without exclusive output handling.

The missing prerequisite is a validated, separate harness/runtime identity route that loads the exact frozen runtime and verifies the post-matrix checkpoint without modifying it. This correction does not add that route, weaken existing gates, or edit checkpoint identities.

## Bounded recovery design

This procedure is a design for a later approved implementation. It is not authorization to run ordinary `resume` or an ad hoc recovery script.

1. Wait for natural settlement. Read the actual failed report and validate the complete preparation checkpoint. Confirm that the campaign parent and every contained worker in its namespaces have settled. A released parent lock or exit code 0 alone is insufficient.
2. Acquire the same existing global nonblocking `flock` used by the campaign, before any store operation, and hold it through report publication. Do not create a second campaign lock or admission pool. Select a new output outside the campaign root and reserve it exclusively with no symlink following or overwrite. Preserve every prior report, manifest, checkpoint, and source prefix.
3. Record separate source-preparation, state-preparation, execution-runtime, current-main, and corrected-harness commit identities. Record the runtime package tree, harness hash, locked dependency/native identities, and hashes of the retained manifest, checkpoint, and failed report. Keep private paths and source bodies out of the aggregate report.
4. Execute only the exact frozen runtime used by the state checkpoint. Verify its source, built output, and dependencies against the recorded identity. Keep the corrected harness identity separate. Do not import current-main workers into a frozen-runtime recovery or certify current main from the result.
5. Validate canonical owner-only routes and regular files, source device/inode identities, current catalog snapshots and anchor hashes, and the bounded matrix append suffixes. Match each original pinned view and source cut across the manifest, catalog, derived store, search store, state head, and saved selection. Require complete body and metadata cuts, matching schemas and identities, no active large-body cursor, and settled namespaces. Validate the selected capsule segment before any corruption fault. Reject unexplained appends, mismatches, missing state, or corrupt source. Do not create or repair preparation as a fallback.
6. Reuse the completed preparation and stored selections. Repeat only the qualification tail below under an explicit external wall limit, existing worker caps, and the same admission rules. Report the fresh tail measurements separately from unavailable original measurements.
7. Publish the new report without replacing an old file. Recheck source prefixes and checkpoint hashes, retain all data, and report any expected new bounded append suffix separately. Derive the exit code from the published status. A completed tail remains partial core evidence, not a full M11 pass.

The least repeat work for fresh measured evidence is:

- Three fault worker calls, including corruption restoration and source-hash checks.
- Nine matrix lanes, totaling 504 worker calls and 84 bounded source appends.
- 39 scheduler lease probes.
- 128 double compositions, followed by the disk acceptance check.

Those totals exclude checkpoint/source validation work. Recovery must place explicit bounds on that validation and the complete tail before execution. It must not repeat source generation, catalog/capsule/search derivation, or the calculated 164,170 state steps. A structural-only report can omit repeated timing checks, but cannot reconstruct their lost measurements or claim equivalent qualification.
