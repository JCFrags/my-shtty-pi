# ChronoCompact current configuration

## Configuration source and precedence

The default configuration file is:

```text
$HOME/.pi/agent/chrono-compact.json
```

`PI_CHRONO_CONFIG_PATH` can select another file. The selected file must contain one JSON object. File validation is strict for known values. If the file is absent, ChronoCompact uses defaults. If parsing or validation fails, ChronoCompact ignores the complete file for that process, uses defaults and environment values, and exposes a warning in the settings interface.

For a runtime setting, precedence is:

1. the corresponding `PI_CHRONO_*` environment variable;
2. the value in `chrono-compact.json`;
3. the compiled default.

The interactive `/chrono-compact-settings` command writes only the JSON file. It cannot override an environment variable. The writer validates the complete object, creates an owner-only temporary file, and renames it into place. Use the settings screen instead of editing a running process's file when practical.

## V3 controls

| JSON key | Environment | Default | Current effect |
| --- | --- | ---: | --- |
| `memoryEngineEnabled` | `PI_CHRONO_MEMORY_ENGINE` | `false` | Selects startup adoption, indexed derivation, and readiness-gated V3 composition. It also disables legacy incremental candidate reconstruction. |
| `searchIndexEnabled` | `PI_CHRONO_SEARCH_INDEX` | `false` | Selects indexed search and recall. The memory engine normally implies search unless this value is explicitly false. |
| `catalogShadowEnabled` | `PI_CHRONO_CATALOG_SHADOW` | `false` | Runs catalog-only shadow ingestion when indexed search is not selected. |
| `rollupShadowEnabled` | `PI_CHRONO_ROLLUP_SHADOW` | `false` | Runs the older replay-comparison rollup shadow path. This is separate from `rollup-v3.sqlite` in the indexed memory pipeline. |
| `hostWorkerSlots` | `PI_CHRONO_HOST_WORKER_SLOTS` | `1` | Bounded deterministic worker slots, valid range 1 through 4. |
| `workerTimeoutSeconds` | `PI_CHRONO_WORKER_TIMEOUT_SECONDS` | `900` | Worker deadline, valid range 30 through 3,600 seconds. |
| `workerNiceLevel` | `PI_CHRONO_WORKER_NICE` | `10` | Worker nice value, valid range 0 through 19. |
| `isolatedWorkerEnabled` | `PI_CHRONO_ISOLATED_WORKER` | `false` | Selects the contained compatibility replay worker. Indexed store jobs already use bounded workers. |

The candidate default for `memoryEngineEnabled` remains off pending qualification. Do not describe the presence of a setting as activation evidence.

## Composition controls

The V3 composer always retains the regular Pi summary. `PI_CHRONO_PI_SUMMARY=false` and the old JSON `hybridSummaryEnabled: false` shape are retired for this purpose and do not disable that summary.

Relevant controls are:

| JSON key | Environment | Default |
| --- | --- | ---: |
| `hybridSummaryTargetTokens` | `PI_CHRONO_PI_SUMMARY_TOKENS` | `2500` |
| `targetContextTokens` | `PI_CHRONO_TARGET_CONTEXT` | `32000` |
| `rawTail` | `PI_CHRONO_RAW_TAIL` | `dynamic` |
| `dynamicRawTailMinTokens` | `PI_CHRONO_RAW_TAIL_MIN` | `3000` |
| `dynamicRawTailMaxTokens` | `PI_CHRONO_RAW_TAIL_MAX` | `6000` |

The V3 return path still enforces its fixed 30,000-token combined summary-and-tail ceiling. Increasing another context target does not increase this ceiling.

`incrementalPrecomputeEnabled` and `PI_CHRONO_INCREMENTAL_PRECOMPUTE` control the V2 compatibility candidate store. When the memory engine is on, ChronoCompact cancels this work instead of maintaining both lifetime derivation paths.

## Session-specific search inclusion and exclusion

`/chrono-search on` and `/chrono-search off` write one owner-only record for the exact Pi session ID and source path. The default directory is adjacent to the configuration file under `chrono-session-rollouts/`. The file name contains only hashes.

Precedence for effective indexed search is:

1. An explicit global search disable in the environment or JSON file forces search off.
2. Otherwise, an exact session rollout record selects on or off.
3. Otherwise, a valid logical binding or exact fresh-session canary selects search on.
4. Otherwise, `memoryEngineEnabled` or `searchIndexEnabled` selects search on.

A persisted session value of false blocks automatic logical adoption and takes precedence over a continuation grant. Unsafe rollout storage also fails closed. Rollout directories must be absolute, canonical, owner-owned, mode `0700`, and free of unsafe symlink ancestry. Records must be owner-owned regular files with mode `0600`, one link, bounded size, and matching hashed identity.

The logical-session root defaults beside the configuration file under `chrono-logical-sessions/`. Composition artifacts default beside it under `chrono-compositions/`. These are private local data and must not be committed.

## Environment parsing

Boolean environment values accept `1`, `true`, `yes`, or `on`, and `0`, `false`, `no`, or `off`, without case sensitivity. Unknown boolean text falls back to the lower-precedence or default behavior used by the resolver. Numeric environment values are clamped to their supported range when finite. The JSON validator instead rejects out-of-range values.

Because environment variables win, always inspect the loaded status in the process that will perform an operation. A changed JSON file alone does not prove the effective setting.

## Retired and separate controls

- `historyEditorEnabled` and `PI_CHRONO_HISTORY_EDITOR` are retained only for configuration compatibility. The history editor cannot run.
- `valueWorkerMode` defaults to `off`. Optional model advice is separate from the deterministic memory engine and is not required for catalog, search, state, rollup, or composition.
- `rollupShadowEnabled` controls the older compatibility comparison path. It does not enable indexed `rollup-v3` composition.
- Automatic logical rollover has no enabling configuration in this candidate. Rollover and fork are manual commands.

## Safe inspection

Use these read-only views:

- `history_status` or `/chrono-search-status` for indexed lifecycle, migration phase, loaded runtime identity, and the last safe error;
- `/chrono-worker-status` for bounded worker and scheduler state;
- `/chrono-doctor` for source, ledger, containment, scheduler, and memory-admission checks;
- `/chrono-logical-session status <logical-session-id>` for one active logical branch.

Do not infer cut eligibility from a ready migration phase. The actual compaction or continuation command performs mandatory cut validation.
