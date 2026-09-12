# M11 report correction and retained-tail recovery

Status: the report correction and a separate, operator-gated `m11-retained-tail-recovery.mjs` command are implemented. Recovery has not run. Execution requires natural campaign settlement and a new explicit parent approval after implementation delivery. The retained runtime is unchanged. See the [qualification plan](M11-qualification-plan.md) for the campaign boundary and final-runtime checks.

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

Ordinary `resume` also requires `prepared-state.json.candidateSha` to equal the checkout candidate. Its saved-state path trusts the recorded states rather than repeating source/view/store validation. Its no-saved-state path requires original exact source sizes and event counts, which no longer describe sources after matrix appends. Neither path is a supported cross-revision report recovery. Its output writer can overwrite an existing file. The separate recovery command instead reserves a new output exclusively.

The separate command loads only the exact frozen runtime and verifies the post-matrix checkpoint. It does not make current-main state compatible, weaken ordinary resume gates, or edit saved candidate identities.

## Supported recovery boundary

The separate command implements the following procedure. This document is not authorization to execute it, run ordinary `resume`, stop the active campaign, or create an approved exact-go file.

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

Those totals exclude checkpoint/source validation work. The implementation does not repeat source generation, capsule/search preparation, or the calculated 164,170 state steps. Catalog ingestion is permitted only for the 84 new tiny matrix appends. It supports the anticipated final aggregation failure only, not a timeout, partial state, incomplete first matrix, reboot, or interrupted recovery.

## Finite validation and preservation

The command requires exactly one complete, known original matrix suffix, totaling 84 append events. It verifies a second such suffix after recovery. Append IDs, parent IDs, timestamps, payloads, order, offsets, and final sizes must match the existing generator. It rejects any other suffix without reset or regeneration.

Validation has these explicit limits, reported separately from fresh tail measurements:

- 16 sessions, 72 shards, and 3,967 original catalog records. The full-profile decoded-unit totals must match the manifest.
- Two streamed original-prefix hash passes, at most 16 GiB in total. Catalog anchors add at most 16 reads of 64 KiB per shard. Suffixes are at most 16 KiB per session per pass. Fault-phase hashes of the largest session are counted separately.
- Two directory inventories, each limited to 600,000 entries, depth 16, and 48 GiB. Canonical directories must be owner-only. Retained files must be owner-only regular files with one hard link and no symlink route.
- 64 read-only SQLite opens. At most 4,096 validation statements return bounded rows, normally at most 1,024 each. Schemas must match the exact frozen declarations. The command verifies identities, original pins, complete body/metadata heads, and absence of active cursors before worker calls. It does not repair or migrate a store.
- 80 frozen validation worker calls: one original-leaf pin, capsule status, search status, state status, and stored selection per session. The regenerated selection response must equal the saved response except for nondeterministic metrics and worker observations. These calls cannot request materialization.
- At most three settlement passes over the original parent and 44 fixed worker unit names across the existing 11 scheduler namespaces. Each pass also requires no scheduler tickets or slots. The third pass is for failure reporting. No new admission pool is created.
- All 427 tracked frozen package files must match commit `09a8e9147095079668689546ae85146d787d8b68`, package tree `c317f4851100b072ff84a5d78dd0a7fadc77131f`. Executed dependency files and their resolution routes, the native addon, Node binary, and both harness files are separately hash-bound.

The runtime is version `2.0.30`, not current-main `2.0.34`. Its package-lock SHA-256 is `36c55c89ec4541a28ddff1176f8f25fcd1783f153ce6eb5383935cf5d4eb1659`. Node must be exactly `24.18.0`. The native addon hash is recorded in the qualification plan. Runtime files and runtime manifests are not changed for this harness-only addition.

The command reads and hashes the selected capsule, decodes its source identity, and checks that source against the original pin before corruption. It reserves and fsyncs a private `${output}.capsule-restore` sidecar first. The fault hook restores the original bytes in `finally`. A successful report also verifies the restored hash. Recovery waits for started lane tasks and tracked worker/source-read promises before failure reporting.

An external kill or power loss can interrupt restoration or report publication. In that case, do not blindly rerun. First establish parent/worker settlement under the same lock. Inspect the sidecar and verify its content hash against the selected capsule name before any separately approved restoration. A failed report distinguishes an incomplete sidecar and unverified settlement/restoration. Prior reports and checkpoints are not overwritten. Expected catalog appends are not rolled back.

## Exact-go input and invocation

The `plan` command is safe without recovery approval. It does not inspect retained data:

```sh
node packages/pi-chrono-compaction/scripts/m11-retained-tail-recovery.mjs plan
```

The executable command requires a canonical absolute path to a mode-0600 JSON file in a mode-0700 directory, plus the SHA-256 of that exact file. Prepare it only after natural settlement and new parent approval. Keep it private. All fields below are required:

| Field | Exact requirement |
| --- | --- |
| `schemaVersion`, `kind` | `1`, `chrono-m11-retained-tail-exact-go` |
| `approveRetainedTail`, `naturalSettlement` | Both `true`, supplied only after the new approval and actual settlement |
| `sourcePreparationSha` | `aa160c082dd9f027b0e378c53c2784e00ef1727e` |
| `statePreparationSha`, `executionRuntimeSha` | Both `09a8e9147095079668689546ae85146d787d8b68` |
| `currentMainSha`, `harnessSha` | Exact accepted main and harness commits. The local `origin/main` and harness `HEAD` must match. Main must be an ancestor of the harness. |
| `campaignRoot`, `runtimePackage`, `failedReport`, `output` | Canonical absolute private routes. The root basename is the source-preparation SHA. Output must be new, outside the root, and distinct from the failed report. Its parent directory must already exist. |
| `recoveryUnit` | `chrono-m11-retained-tail-` plus the first 12 harness SHA characters plus `.service` |
| `parent.unit` | `chrono-m11-resume-09a8e9147095.service` |
| `parent.bootId`, `parent.processes` | The recorded original boot ID and exactly two `{pid, startTicks}` records for the flock process and its Node child. `startTicks` is a decimal string from proc stat field 22. The boot must still match, and neither process identity may remain alive. Preserve this metadata before natural exit. |
| `hashes` | SHA-256 strings under `manifest`, `checkpoint`, `failedReport`, `harness`, `sharedHarness`, `dependencies`, and `node` |
| `sources` | Exactly 72 records `{session, ordinal, device, inode, prefixSha256}`. Device and inode are decimal strings. Hash each original prefix of the manifest's `sourceBytes` length, not the post-matrix whole file. |

`hashes.manifest` and `hashes.checkpoint` bind `campaign-manifest.json` and `prepared-state.json`. `hashes.harness` binds the recovery helper. `hashes.sharedHarness` binds `m11-scale-campaign.mjs`. Capture settled source prefix hashes under the existing lock without changing files. These fresh hashes bind the approved input and its preservation. They do not reconstruct missing historical full-file digests.

For `hashes.dependencies`, sort these paths relative to the frozen `node_modules`: every `.js` file recursively below `better-sqlite3/lib`, plus `better-sqlite3/package.json`, `better-sqlite3/build/Release/better_sqlite3.node`, `bindings/package.json`, `bindings/bindings.js`, `file-uri-to-path/package.json`, and `file-uri-to-path/index.js`. Feed each UTF-8 relative path, a NUL byte, its exact bytes, and another NUL byte into one SHA-256 hash. The helper rejects alternate dependency or native-addon resolution.

The following template cannot execute without operator-supplied values and a valid approved file. Run it from the accepted harness package. Do not create placeholder approval booleans or substitute current-main workers:

```sh
cd packages/pi-chrono-compaction
: "${EXACT_GO_JSON:?Set the approved absolute JSON path after natural settlement}"
: "${EXACT_GO_SHA256:?Set the SHA-256 of that exact approved file}"
: "${NODE_BIN:?Set the verified absolute Node 24.18.0 binary path}"
HARNESS_SHA=$(git rev-parse HEAD)
systemd-run --user --wait --pipe --collect \
  --unit="chrono-m11-retained-tail-${HARNESS_SHA:0:12}" \
  --property="WorkingDirectory=$PWD" \
  --property=UMask=0077 --property=KillMode=control-group \
  --property=MemoryMax=1073741824 --property=MemorySwapMax=0 \
  --property=TasksMax=512 --property=RuntimeMaxSec=7200 \
  /usr/bin/env -u NODE_OPTIONS -u NODE_PATH -u NODE_BINDINGS_COMPILED_DIR \
  "$NODE_BIN" --max-old-space-size=512 scripts/m11-retained-tail-recovery.mjs recover \
    --go "$EXACT_GO_JSON" --go-sha256 "$EXACT_GO_SHA256"
```

The helper acquires the existing parent `.campaign.lock` with nonblocking `flock`. It requires the declared recovery unit, verifies its own cgroup membership, and checks the kernel memory/swap/task limits. Worker caps remain unchanged. The two-hour wall limit is external. Disk is checked before and after, not continuously enforced.

A successful output has `status: completed`, `qualificationStatus: partial-frozen-runtime-tail-only`, `fullM11Acceptance: false`, and `currentMainAcceptance: false`. It separates validation time/reads/calls from fresh tail metrics and keeps missing original metrics unavailable. It contains no private paths or source bodies. An early gate refusal can leave no output. A later failure writes a failed report when the exclusively reserved output remains valid.

Two new targeted checks passed. They exercised actual CLI plan/refusal behavior, explicit module-root binding with seven tiny mock modules, synthetic checkpoint/identity/completion validation, suffix bounds, and exclusive output/symlink refusal. They did not open retained stores, start contained workers, perform corruption, or execute recovery. Existing required CI remains the integration check, not final-runtime M11 qualification.
