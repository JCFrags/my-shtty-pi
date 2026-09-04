# ChronoCompact

- Purpose: Compact long-running Pi history while retaining source-linked state.
- Status: active canonical
- Pi entrypoint(s): `dist/src/pi-extension.js`
- Load form: compiled-loaded
- Build/check command: `npm run build`
- Deployment hash verification command: `node ../../scripts/verify-deployed-baseline.mjs --product pi-chrono-compaction`

## 2.0.1 safety boundary

- Legacy whole-file history search and recall stop before reading a persisted session larger than 64 MiB.
- Exact retrieval from a larger session requires an existing verified source ledger; it does not create a ledger or fall back to a whole-file read.
- Local search indexes are generation-bound, concurrent builds coalesce, and retained indexes share a strict 128 MiB accounting limit.
- Isolated workers bind an immutable source prefix, accept a verified pure append, and reject replacement, truncation, or prefix mutation.
- Worker failures use stable protocol codes and write bounded, sanitized, owner-only diagnostics outside publication.
- Scheduler ownership is published atomically and stable malformed artifacts are recovered conservatively.
- `/chrono-worker-status` and `/chrono-doctor` show bounded aggregate state without session content or private paths.
