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

Open `/Chrono` and select Settings, or use `/Chrono settings`. The settings interface writes only the JSON file. It cannot override an environment variable. The writer validates the complete object, creates an owner-only temporary file, and renames it into place. Use the settings screen instead of editing a running process's file when practical.

Each completed valid change saves immediately. There is no final save step. A value rejected by input validation returns to the same input with an error. Cancel that input to keep its previous value. A failed save remains marked as unsaved until retried or discarded. Custom settings exposes all controls. These are 3.0.5 source behaviors, not evidence that an existing process has loaded the patch.

## V3 controls

| JSON key | Environment | Default | Current effect |
| --- | --- | ---: | --- |
| `memoryEngineEnabled` | `PI_CHRONO_MEMORY_ENGINE` | `true` | Selects startup adoption, indexed derivation, and bounded V3 composition. Missing optional memory uses an explicitly incomplete programmatic fallback, not lifetime reconstruction. |
| `searchIndexEnabled` | `PI_CHRONO_SEARCH_INDEX` | implied by memory engine | Selects indexed search and recall. An explicit false value still disables search. |
| `automaticRolloverEnabled` | `PI_CHRONO_AUTOMATIC_ROLLOVER` | `true` | Switches the physical Pi shard at safe idle after configured source growth. |
| `rolloverSourceBytes` | `PI_CHRONO_ROLLOVER_BYTES` | `8388608` | Source growth threshold in bytes, valid range 1 through 64 MiB. New-shard bootstrap bytes are excluded from growth. |
| `catalogShadowEnabled` | `PI_CHRONO_CATALOG_SHADOW` | `false` | Runs catalog-only shadow ingestion when indexed search is not selected. |
| `rollupShadowEnabled` | `PI_CHRONO_ROLLUP_SHADOW` | `false` | Runs the older replay-comparison rollup shadow path. This is separate from `rollup-v3.sqlite` in the indexed memory pipeline. |
| `hostWorkerSlots` | `PI_CHRONO_HOST_WORKER_SLOTS` | `1` | Bounded deterministic worker slots, valid range 1 through 4. |
| `workerTimeoutSeconds` | `PI_CHRONO_WORKER_TIMEOUT_SECONDS` | `900` | Worker deadline, valid range 30 through 3,600 seconds. |
| `workerNiceLevel` | `PI_CHRONO_WORKER_NICE` | `10` | Worker nice value, valid range 0 through 19. |
| `isolatedWorkerEnabled` | `PI_CHRONO_ISOLATED_WORKER` | `false` | Selects the contained compatibility replay worker. Indexed store jobs already use bounded workers. |

Normal startup selects V3 without a canary or manual migration command. Explicit global and session exclusions remain effective. A compiled default is not proof that an existing process loaded this source.

## Composition controls

The baseline requires no language-model summary call. Set `hybridSummaryEnabled` or `PI_CHRONO_PI_SUMMARY` to true to request an independent regular Pi summary. Its absence or failure does not block valid programmatic composition.

Relevant controls are:

| JSON key | Environment | Default |
| --- | --- | ---: |
| `hybridSummaryEnabled` | `PI_CHRONO_PI_SUMMARY` | `false` |
| `hybridSummaryTargetTokens` | `PI_CHRONO_PI_SUMMARY_TOKENS` | `2500` |
| `targetContextTokens` | `PI_CHRONO_TARGET_CONTEXT` | `32000` |
| `rawTail` | `PI_CHRONO_RAW_TAIL` | `dynamic` |
| `dynamicRawTailMinTokens` | `PI_CHRONO_RAW_TAIL_MIN` | `3000` |
| `dynamicRawTailMaxTokens` | `PI_CHRONO_RAW_TAIL_MAX` | `6000` |

`targetContextTokens` is the combined hard token limit for normal composition, preview, and logical continuation. The settings screen labels this control "Combined context hard limit". Its valid range is 8,000 through 250,000. The effective limit is the lower of this setting and selected-model capacity minus system-prompt tokens, Chrono context reserve (default 1,500), and response reserve. Normal compaction uses Pi's supplied reserve. Preview and logical continuation reserve 16,384 tokens. Missing model capacity or fewer than 512 usable tokens refuses. These are token estimates, not tokenizer measurements.

V3 always uses `dynamicRawTailMinTokens` and `dynamicRawTailMaxTokens`, with the existing 3,000/6,000 defaults. Fixed, preset, and `pi` raw-tail modes apply only to compatibility replay. The dynamic maximum is also limited to the effective combined budget minus 3,000 tokens for history and summary. If complete tool boundaries force a smaller tail, the minimum is a soft target. An indivisible suffix above the maximum refuses instead of retaining a large Pi tail.

When enabled and its input fits the bounded preparation window, the independent Pi summary target is 2,500 tokens. Important history receives more detail, but a larger token setting is not a promise to retain all historical restrictions or work. Excerpts and omissions are expected, reported, and recoverable through history tools. Raising the combined limit does not increase source/row/byte limits, native memory, I/O allowances, or worker deadlines. The compatibility replay's separate 25,000-token cap remains. See [context composition](context-composer.md#budgets-and-refusal) for exact finite limits.

`incrementalPrecomputeEnabled` and `PI_CHRONO_INCREMENTAL_PRECOMPUTE` control the V2 compatibility candidate store. When the memory engine is on, ChronoCompact cancels this work instead of maintaining both lifetime derivation paths.

## Optional background LLM presets

In Settings, select Background LLM. This optional language-model worker is off by default and can incur provider charges. Enabling it requires confirmation because it sends bounded assistant and tool excerpts to the selected model. User messages and protected instruction text are excluded. Enabling also selects local incremental precompute. Compaction does not wait for this work.

This is the compatibility value worker, not the programmatic V3 memory pipeline. It remains paused while `memoryEngineEnabled` is true, which is the default. Selecting a preset, model, or enabled mode does not switch the memory engine off. Changing that engine selection is a separate explicit setting. V3 does not require this worker.

Usage offers Lite (`lite`, the recommended starting preset), Medium (`medium`), Max (`max`), and Custom (`custom`). A preset writes ordinary worker settings. Selecting one does not by itself enable model calls. First enable uses Lite unless a preset or Custom configuration was already selected.

| Preset | Calls per session | Input tokens per session | Output tokens per session | Estimated USD per session |
| --- | ---: | ---: | ---: | ---: |
| `lite` | 20 | 40,000 | 8,000 | $0.25 |
| `medium` | 100 | 250,000 | 50,000 | $2 |
| `max` | 400 | 1,000,000 | 200,000 | $10 |

The first exhausted call, input-token, output-token, or enabled estimated-cost budget stops further work. These are ceilings, not guaranteed call counts or bill totals. Model prices and actual usage determine cost.

| Preset | Preferred thinking | Input/output tokens per job | Items per job | Timeout | Retries |
| --- | --- | ---: | ---: | ---: | ---: |
| `lite` | `off` | 4,000 / 1,000 | 10 | 90 seconds | 0 |
| `medium` | `low` | 6,000 / 1,500 | 20 | 120 seconds | 1 |
| `max` | `medium` | 12,000 / 4,000 | 40 | 180 seconds | 1 |

All presets allow one concurrent model call and pause after three consecutive failures for 1,800 seconds. A preset uses a supported thinking level if its preference is unavailable for the selected model.

Model offers the current main model or a provider/model picker. The picker uses Pi's scoped models when present, otherwise its available model registry. Custom controls exposes mode (`off`, `advisory`, or `shadow`), model, supported thinking levels or `inherit`, all per-job and per-session bounds above, concurrency, retries, timeout, estimated-cost limit or `off`, and failure-pause controls. Changing an individual limit selects Custom. Environment overrides still take priority.

## Tool-result shortening at compaction

`toolResultProjectionMode`, overridden by `PI_CHRONO_TOOL_RESULT_PROJECTION`, accepts `off`, `safe`, or `aggressive` and defaults to `off`. In Settings, select Tool-result shortening at compaction.

When enabled, Chrono selects shortened representations only on the first model request after a successful compaction. The existing recent-result, first-consumption, protected-content, and source-validation rules still apply. Ordinary turns reuse the exact frozen replacements for unchanged source results. New results stay exact until the next successful compaction. A failed compaction does not start projection. A refused or empty boundary projection is not retried on later ordinary turns.

Saving a different mode, including `off`, does not discard an already-sent snapshot. The new mode applies at the next compaction boundary. Snapshots exist only in memory. Reload, resume, a new or forked session, and tree navigation reset projection to exact results until another successful compaction.

Safety checks take priority over reuse. Invalid tool pairs, unsupported content, or uncertain or changed source bindings return the exact unmodified request instead of recomputing a reduction. Source JSONL is never rewritten. Stable Chrono replacements are not a general provider-cache hit guarantee. Other context changes and lifecycle resets can still change the request prefix.

## Session-specific search inclusion and exclusion

`/Chrono search on` and `/Chrono search off` write one owner-only record for the exact Pi session ID and source path. The default directory is adjacent to the configuration file under `chrono-session-rollouts/`. The file name contains only hashes.

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
- In `/Chrono`, select Settings, Custom settings (all options), then Automatic physical-shard rollover. Select Disabled to stop automatic switching, or Enabled to set the source-growth threshold. Manual logical rollover and fork remain available.

## Safe inspection

Use these read-only views:

- `history_status` or `/Chrono search-status` for indexed lifecycle, migration phase, loaded runtime identity, and the last safe error;
- `/Chrono worker-status` for bounded worker and scheduler state;
- `/Chrono doctor` for source, ledger, containment, scheduler, and memory-admission checks;
- `/Chrono logical-session status <logical-session-id>` for one active logical branch.

Use Status and diagnostics for the search, worker, and health reports. Use Maintenance for logical-session operations. In the terminal UI, reports use a read-only scroller. Up/Down and PgUp/PgDn scroll. Enter or Esc returns to the menu. Reports do not enter model context. Direct RPC action output remains notifications.

Do not infer cut eligibility from a ready migration phase. The actual compaction or continuation command performs mandatory cut validation.
