# ChronoCompact

- Purpose: Compact long-running Pi history while retaining source-linked state.
- Status: active canonical
- Pi entrypoint(s): `dist/src/pi-extension.js`
- Load form: compiled-loaded
- Build/check command: `npm run build`
- Deployment hash verification command: `node ../../scripts/verify-deployed-baseline.mjs --product pi-chrono-compaction`

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
