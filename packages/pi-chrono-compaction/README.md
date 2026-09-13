# ChronoCompact

- Purpose: Compact long-running Pi history while retaining source-linked state.
- Status: active canonical
- Pi entrypoint(s): `dist/src/pi-extension.js`
- Load form: compiled-loaded
- Build/check command: `npm run build`
- Deployment hash verification command: `node ../../scripts/verify-deployed-baseline.mjs --product pi-chrono-compaction`

## V3 direction and current architecture

V3 prioritizes useful fuzzy chronological memory and recall, from short tasks to extremely long lifetime tasks, while keeping RAM, CPU, and optional GPU use bounded. The programmatic core keeps selective chronological short-term memory, gives important events more detail, and uses a small adaptive raw tail with model-aware, configurable token limits. Optional language-model assistance may improve individual events or bounded groups. It must not replace whole history or become required processing.

The V3 path uses checkpointed catalog, capsule, search, state, and rollup stores. Source JSONL stays immutable and recoverable when detail leaves active context. Exact recovery validates source identity and bounded coordinates. Derived state retains its source role and does not become a user instruction. See the [current overview](../../docs/chrono-v3/README.md) for delivery priorities and evidence boundaries.

`memoryEngineEnabled` in the Chrono configuration selects this architecture. `PI_CHRONO_MEMORY_ENGINE` overrides that value. The candidate default remains `false` while qualification is incomplete. Deployment can enable the setting without a user activation command. An explicit search disable, per-source exclusion, unsafe private store, or invalid logical binding prevents adoption.

Enabled sessions adopt their existing physical file as logical shard zero. Resume reuses the binding and stored progress. `/chrono-search-status` and `history_status` distinguish migration readiness from composition eligibility. Ready indexes alone do not prove that selected context fits. The [context composer](../../docs/chrono-v3/context-composer.md) documents source coverage, token budgeting, retained-tail policy, and safe refusal.

The selected V3 path does not run legacy incremental candidate reconstruction or whole-history token estimation. Compatibility paths remain available when V3 is disabled. Automatic rollover remains disabled. `/chrono-logical-session` exposes guarded adoption, status, rollover, fork, recovery, and rollback. Old shards remain readable and are not deleted by rollback.

The [M12 migration report](../../docs/chrono-v3/reviews/M12-migration-report.md) and [M11 qualification plan](../../docs/chrono-v3/reviews/M11-qualification-plan.md) retain revision-bound evidence and historical campaign plans. They are not the current release checklist. Implemented architecture does not establish active `3.0.0`, perfect recall, billion-token qualification, or local deployment.

## 2.0.3 memory-admission boundary

- Legacy history loading reserves a conservative eight-times source charge before allocation, reads only the admitted bytes, and revalidates source identity before parsing; the 64 MiB source guard remains in force.
- Exact retrieval from a larger session requires an existing verified source ledger; it does not create a ledger or fall back to a whole-file read.
- Local search-index work reserves capacity before loading or parsing. It uses a measured 32-times source envelope, with explicit pending-load, pending-build, live-index, bounded-query-result, and retained-reference accounting.
- The local history admission ceiling is 512 MiB. Retained indexes also remain within a strict 128 MiB cache ceiling, and only one current generation is retained per session. Work that does not fit returns a controlled refusal.
- The deterministic fixed-heap characterization now fails unless the declared index envelope covers the measured retained-heap delta; the former eight-times charge did not.
- Isolated workers bind an immutable source prefix, accept a verified pure append, and reject replacement, truncation, or prefix mutation.
- Worker failures use stable protocol codes and write bounded, sanitized, owner-only diagnostics outside publication.
- Scheduler ownership is published atomically and stable malformed artifacts are recovered conservatively.
- `/chrono-worker-status` and `/chrono-doctor` show bounded aggregate state without session content or private paths.

## Test-foundation commands

- Complete normal suite and deterministic bounded report: `npm run test:normal`
- Fixed-heap scale, fault, and memory lanes: `npm run test:fixed-heap`
- Optional local 2 GiB lane: `npm run test:fixed-heap -- --heaps 2048`

Machine-readable reports separate deterministic workload, byte, hash, code, and determinism fields from advisory time, CPU, RSS, heap, and derived-store metrics.
