# ChronoCompact

- Purpose: Keep useful selective chronological memory and recover exact history in long-running Pi tasks.
- Status: active canonical
- Pi entrypoint(s): `dist/src/pi-extension.js`
- Load form: compiled-loaded
- Build/check command: `npm run build`
- Current package identity check: `node ../../scripts/verify-chrono-v3-baseline.mjs --static-only`

## Operator interface in the 3.0.5 source

Use `/Chrono` for Settings, Status and diagnostics, Maintenance, and About. `/Chrono [action]` also supports the direct actions listed in [operations](../../docs/chrono-v3/operations.md#operator-menu-and-actions). Valid settings changes save immediately. Invalid input returns to the same input with an error. Terminal status reports use a read-only scroller. Enter or Esc returns to the menu. Direct RPC action output remains notifications.

Background LLM is off by default and can incur charges. Lite, Medium, and Max presets apply per-job and per-session limits. The first exhausted call, token, or enabled estimated-cost budget stops further work. Custom exposes all controls and a provider/model picker. This compatibility worker stays paused while the default V3 memory engine is on. Enabling it does not switch engines. See [preset limits](../../docs/chrono-v3/configuration.md#optional-background-llm-presets).

Optional tool-result shortening is selected only on the first request after successful compaction. Ordinary turns reuse frozen replacements. New results remain exact until the next compaction. Reload, resume, and tree navigation reset to exact results. Safety binding refusals also return the exact request. Source history stays unchanged, but provider-cache hits are not guaranteed. See [projection timing](../../docs/chrono-v3/configuration.md#tool-result-shortening-at-compaction).

These are source changes, not evidence of accepted integration, local activation, or new runtime validation.

## V3 direction and current architecture

V3 prioritizes useful fuzzy chronological memory and recall, from short tasks to extremely long lifetime tasks, while keeping RAM, CPU, and optional GPU use bounded. The programmatic core keeps selective chronological short-term memory, gives important events more detail, and uses a small adaptive raw tail with model-aware, configurable token limits. Optional language-model assistance may improve individual events or bounded groups. It must not replace whole history or become required processing.

The V3 path uses checkpointed catalog, capsule, search, state, and rollup stores. Source JSONL stays immutable and recoverable when detail leaves active context. Exact recovery validates source identity and bounded coordinates. Derived state retains its source role and does not become a user instruction. See the [current overview](../../docs/chrono-v3/README.md) for delivery priorities and evidence boundaries.

Version `3.0.0` enables the programmatic memory engine by default. `memoryEngineEnabled` selects this architecture, and `PI_CHRONO_MEMORY_ENGINE` overrides the JSON value. No model call is required. Missing optional memory uses an explicitly incomplete bounded fallback. Explicit search disable, per-source exclusion, unsafe private storage, and invalid logical bindings still prevent adoption.

Enabled sessions adopt their existing physical file as logical shard zero. Resume reuses the binding and stored progress. `/Chrono search-status` and `history_status` distinguish migration readiness from composition eligibility. Ready indexes alone do not prove that selected context fits. The [context composer](../../docs/chrono-v3/context-composer.md) documents source coverage, token budgeting, retained-tail policy, and safe refusal.

The V3 path does not run legacy incremental candidate reconstruction or whole-history token estimation. Its default combined context target is 32,000 estimated tokens, reduced to fit the selected model, with an adaptive 3,000–6,000-token raw tail. Important events receive more detail within chronological history. Compatibility paths remain available when V3 is disabled.

Automatic rollover defaults on after 8 MiB of new source growth at a safe idle boundary. The threshold is configurable from 1 through 64 MiB. This is not a byte-perfect cap during active work. The system preserves old shards and transfers complete native Notes, Todo, and Workplan state with the matching Grounded providers. Managed jobs, open persistent sessions, unsafe state, or unavailable exact source pinning defer the switch. `/Chrono logical-session` provides manual adoption, status, rollover, fork, recovery, and rollback. See [operations](../../docs/chrono-v3/operations.md) and [compatible recovery](../../docs/chrono-v3/recovery.md#native-state-after-rollover).

Focused checks exercise model-free composition, public history retrieval, and real Pi physical replacement with restart. They do not establish perfect recall or billion-token normal-use qualification. An existing oversized physical file still incurs Pi's initial file load. See the [current release evidence](../../docs/chrono-v3/README.md#current-documentation-boundary) for integration and activation separately. The [M12 migration report](../../docs/chrono-v3/reviews/M12-migration-report.md) and [M11 qualification plan](../../docs/chrono-v3/reviews/M11-qualification-plan.md) remain revision-bound historical evidence, not the current release checklist.

## 2.0.3 memory-admission boundary

- Legacy history loading reserves a conservative eight-times source charge before allocation, reads only the admitted bytes, and revalidates source identity before parsing; the 64 MiB source guard remains in force.
- Exact retrieval from a larger session requires an existing verified source ledger; it does not create a ledger or fall back to a whole-file read.
- Local search-index work reserves capacity before loading or parsing. It uses a measured 32-times source envelope, with explicit pending-load, pending-build, live-index, bounded-query-result, and retained-reference accounting.
- The local history admission ceiling is 512 MiB. Retained indexes also remain within a strict 128 MiB cache ceiling, and only one current generation is retained per session. Work that does not fit returns a controlled refusal.
- The deterministic fixed-heap characterization now fails unless the declared index envelope covers the measured retained-heap delta; the former eight-times charge did not.
- Isolated workers bind an immutable source prefix, accept a verified pure append, and reject replacement, truncation, or prefix mutation.
- Worker failures use stable protocol codes and write bounded, sanitized, owner-only diagnostics outside publication.
- Scheduler ownership is published atomically and stable malformed artifacts are recovered conservatively.
- The diagnostics now exposed as `/Chrono worker-status` and `/Chrono doctor` show bounded aggregate state without session content or private paths.

## Test-foundation commands

- Complete normal suite and deterministic bounded report: `npm run test:normal`
- Fixed-heap scale, fault, and memory lanes: `npm run test:fixed-heap`
- Optional local 2 GiB lane: `npm run test:fixed-heap -- --heaps 2048`

Machine-readable reports separate deterministic workload, byte, hash, code, and determinism fields from advisory time, CPU, RSS, heap, and derived-store metrics.
