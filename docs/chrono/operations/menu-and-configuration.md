---
title: Chrono menu and configuration
audience: [users, agents, operators]
status: current reference
purpose: Describe the unified operator interface, setting precedence, defaults, and path-specific controls.
related:
  - ../USER-GUIDE.md
  - workers-and-caches.md
  - activation-and-migration.md
---

# Chrono menu and configuration

## One menu

Open `/Chrono`. The unified interface has **Settings**, **Status and diagnostics**, **Maintenance**, **About**, and **Close**. It replaces the old separate `/chrono-*` operator commands. Native model-facing history tools retain their names.

Settings exposes common controls first and **Custom settings (all options)** for advanced controls. Valid changes save immediately. Failed writes remain visible and can be corrected or discarded. Reports remain in the interface, not the conversation or model context.

Use Up/Down or Page Up/Page Down to scroll a report. Home/End select its ends. Enter or Esc returns. The local focused-overlay correction keeps page keys in the report when Pi runs fullscreen. Implementation of that correction is not proof that an older running process loaded it.

### Status and diagnostics

| Menu entry | Direct action |
| --- | --- |
| Overview and search readiness | `/Chrono search-status` |
| Background LLM usage | `/Chrono value-worker-status` |
| Local workers | `/Chrono worker-status` |
| Read-only health check | `/Chrono doctor` |
| Source catalog shadow | `/Chrono catalog-status` |
| Capsule shadow | `/Chrono capsules-status` |
| Rollup shadow | `/Chrono rollup-shadow-status` |

The shadow reports describe retained diagnostic paths, not certificates of active composition eligibility. Search status and `history_status` read cached lifecycle observations. Worker/doctor diagnostics do not clear reservations, resume owners, repair admission, or change worker limits.

### Maintenance

Maintenance contains session search on/off, a stored-compaction preview, logical-session actions, explicit rollup repair, and background failure-circuit reset. Advanced direct forms include:

```text
/Chrono search on
/Chrono search off
/Chrono composition-preview [compaction-entry-id]
/Chrono logical-session status <logical-session-id> [branch-id]
/Chrono rollup-repair status <repair-id>
/Chrono value-worker-reset
```

Preview saves a bounded private comparison and does not replace context. Repair changes derived state. Reset cancels this process's pending value work and clears its persisted failure pause. If eligible and enabled, model work can resume afterward. Do not use those mutating actions as status checks.

`/Chrono settings` opens the interface. Do not assume the old `/chrono-compact-settings key value` syntax remains a setter. The internal `_auto-rollover` action uses a one-use guard and is not a manual maintenance route.

## Configuration precedence

The default file is `$HOME/.pi/agent/chrono-compact.json`. `PI_CHRONO_CONFIG_PATH` can select another JSON object file.

For supported settings, the environment wins over JSON, which wins over compiled defaults. Menu writes change JSON only. A missing file uses defaults. A malformed or invalid file is ignored as a whole for that process, with a visible warning. Numeric environment values are generally clamped by their resolver. JSON validation rejects invalid known values. Do not assume every field has identical parsing behavior.

The writer validates the object and replaces it through an owner-only temporary file and rename. This is not a transaction with Pi package settings or provider migration. An external file edit alone does not prove that a process uses the new effective value.

## Core controls

| JSON field | Environment override | Default and applicability |
| --- | --- | --- |
| `contextCompiler` | `PI_CHRONO_CONTEXT_COMPILER` | `v3`. Select `v4` explicitly for the same-session summary and compressed chronological replay. Native cards remain evidence in the receipt, not a rendered state dump. |
| `memoryOwner` | `PI_CHRONO_MEMORY_OWNER` | `chrono`. Select `context-kit` before factory load for independent Memory. Requires a safe reload and explicit data migration. |
| `memoryEngineEnabled` | `PI_CHRONO_MEMORY_ENGINE` | `true`. Normal adoption, indexed derivation, and V3 memory path. V4 compiler selection is a separate control. |
| `searchIndexEnabled` | `PI_CHRONO_SEARCH_INDEX` | The normal engine implies search unless explicitly disabled. |
| `targetContextTokens` | `PI_CHRONO_TARGET_CONTEXT` | 32,000 estimated retained tokens, range 8,000–250,000. Model headroom can lower the effective ceiling. |
| `sessionSummaryTargetTokens` | `PI_CHRONO_SESSION_SUMMARY_TOKENS` | 3,000 estimated tokens, range 256–4,096. Soft guidance for V4's required same-session continuation summary, not a provider output cap. |
| `dynamicRawTailMinTokens` / `dynamicRawTailMaxTokens` | `PI_CHRONO_RAW_TAIL_MIN` / `PI_CHRONO_RAW_TAIL_MAX` | 3,000 / 6,000. Minimum cannot exceed maximum. V3 uses these dynamic limits. Current V4 retains only the minimal safe exact suffix, not this token floor. |
| `triggerThresholdTokens` | `PI_CHRONO_TRIGGER_TOKENS` | Unset. V3 has no Chrono proactive threshold by default. V4 uses the threshold rule below. Pi context pressure remains active independently. |
| `triggerMinimumGrowthTokens` | `PI_CHRONO_TRIGGER_MIN_GROWTH` | 4,000. Growth gate for another threshold attempt. It does not bypass the failure retry pause. |
| `automaticRolloverEnabled` | `PI_CHRONO_AUTOMATIC_ROLLOVER` | `true`, subject to safe-idle and complete-transfer checks. |
| `rolloverSourceBytes` | `PI_CHRONO_ROLLOVER_BYTES` | 8,388,608, range 1–64 MiB of growth beyond bootstrap. |
| `toolResultProjectionMode` | `PI_CHRONO_TOOL_RESULT_PROJECTION` | `off`. `safe` and `aggressive` select boundary-stable request-local shortening. |
| `hostWorkerSlots` | `PI_CHRONO_HOST_WORKER_SLOTS` | 1, range 1–4 deterministic worker slots. |
| `workerTimeoutSeconds` | `PI_CHRONO_WORKER_TIMEOUT_SECONDS` | 900, range 30–3,600 for applicable compatibility jobs. Indexed jobs have lower operation-specific deadlines. |
| `workerNiceLevel` | `PI_CHRONO_WORKER_NICE` | 10, range 0–19. |

V4 requests its same-session summary at the earliest of the configured threshold, when set, 75% of the model context window, or the summary-admission limit minus a 4,096-token lead. Admission reserves the maximum summary-request prompt, the planning allowance, the configured Chrono reserve, and the safety allowance. An unset `triggerThresholdTokens` does not disable this V4 rule. The growth gate, pending-request checks, and retry pause still apply. A large single turn can cross the admission limit and cause refusal. See [summary headroom](../context/session-agent-compaction.md#pi-0851-integration-limits).

The V4 continuation-summary target is separate from the optional regular Pi summary and compatibility replay controls. Its default guidance is roughly 12,000 UTF-16 units. The hard submission bounds remain 16,384 UTF-16 units and 24,576 UTF-8 bytes. These token values are length estimates, not exact tokenizer measurements.

The menu does not expose every V4 ownership/selection field as a dedicated choice. Configure `contextCompiler` and `memoryOwner` through the coordinated activation procedure, not an improvised live handoff. Status shows the captured versus configured Memory owner and whether reload is required.

The planned local selection is V4 plus independent Memory, with value advice and projections off. See [the single status owner](../design/evidence-and-roadmap.md) for implementation and activation evidence.

## Search inclusion

Effective indexed search resolves in this order:

1. An explicit global false environment or JSON setting forces search off.
2. Otherwise, the exact session/source rollout record selects on or off.
3. Otherwise, a valid logical binding or eligible fresh-session canary can select it.
4. Otherwise, the normal memory-engine/search defaults apply.

`/Chrono search on|off` changes one exact session/source record, not every session. A persisted false value blocks automatic adoption. Unsafe rollout storage fails closed. Status is read-only and does not retry startup admission.

## Optional background LLM

Background LLM is off by default. Modes are `off`, `shadow`, and `advisory`. Shadow stores advice without applying it. Advisory can adjust eligible deterministic value scores, not final text or authority.

The menu's **Usage** choices write ordinary settings:

| Preset | Input/output per job | Items | Calls per session | Input/output per session | Estimated USD ceiling |
| --- | --- | ---: | ---: | --- | ---: |
| Lite | 4,000 / 1,000 | 10 | 20 | 40,000 / 8,000 | $0.25 |
| Medium | 6,000 / 1,500 | 20 | 100 | 250,000 / 50,000 | $2 |
| Max | 12,000 / 4,000 | 40 | 400 | 1,000,000 / 200,000 | $10 |

All presets use one concurrent model call. Lite uses zero retries and a 90-second timeout. Medium/Max use one retry and 120/180 seconds. Their preferred thinking levels are off/low/medium, adjusted to supported model metadata. Each uses three failures before a 1,800-second pause.

Custom controls expose mode, model, thinking, per-job and per-session limits, timeout, retries, concurrency, estimated cost, and circuit settings. Selecting a preset is not a measured quality level or guaranteed bill. When a cost ceiling is configured, unavailable model pricing prevents the call rather than guessing.

The model picker uses available scoped models when present, otherwise available registry models. Choose the main model or a provider/model. An unavailable exact model does not silently fall back. The background choice does not change the main conversation model.

Enabling asks for confirmation because bounded assistant/tool excerpts can leave the local process and incur charges. It also enables compatibility precompute. Crucially, this worker is paused while the normal memory engine is enabled. It does not currently enrich the V3/V4 indexed compiler. Do not imply that selecting Max improves V4.

## Retained compatibility controls

- `hybridSummaryEnabled` / `PI_CHRONO_PI_SUMMARY`, default false, requests an optional independent regular Pi summary on supported paths. V4 does not use this optional summary input. This switch does not enable or disable V4's required same-session summary.
- `hybridSummaryTargetTokens` / `PI_CHRONO_PI_SUMMARY_TOKENS` keeps its 2,500-token default for the optional V3/compatibility summary. It does not control V4's required summary. Use `sessionSummaryTargetTokens` for V4. Neither target is a provider output cap.
- `rawTail`, default `dynamic`, also accepts Pi/fixed/preset tail modes for compatibility replay. Those do not override V3's dynamic-tail policy or V4's minimal safe suffix.
- `replayTargetTokens` controls compatibility replay, whose separate hard cap is 25,000 tokens. It does not control current V4's [adaptive replay allowance](../context/session-agent-compaction.md#adaptive-replay-selection). V4 keeps the configured total ceiling and has no separate replay setting.
- `incrementalPrecomputeEnabled`, default false, selects the older candidate store. The normal memory engine cancels this work rather than maintaining both lifetime derivation paths.
- `isolatedWorkerEnabled`, default false, selects contained compatibility replay. Indexed jobs already use bounded workers.
- `catalogShadowEnabled` and `rollupShadowEnabled`, default false, select separate shadow diagnostics, not V4 ownership or indexed-rollup readiness.
- `editableMemoryEnabled` applies to Chrono-owned legacy Memory. It is not the independent Memory ownership switch.
- `rankedSearchEnabled`, hot/warm source bands, and summary rebase are retained compatibility controls. Do not confuse them with a new indexed-history search model.
- `historyEditorEnabled` is accepted only for old configuration compatibility. The retired editor cannot run.

[Operations index](README.md) · [Compaction](../context/compaction-and-budgets.md) · [Workers and cost boundaries](workers-and-caches.md)
