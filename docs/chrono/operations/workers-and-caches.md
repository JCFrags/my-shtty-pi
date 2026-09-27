---
title: Workers, resource bounds, and caches
audience: [agents, operators, maintainers]
status: current reference
purpose: Explain admission, containment, optional model work, cache ownership, and unsupported performance claims.
related:
  - menu-and-configuration.md
  - telemetry.md
  - troubleshooting-and-rollback.md
---

# Workers, resource bounds, and caches

## Deterministic work

Catalog, capsule, search, historical state, and rollup work use bounded local workers outside Pi. These workers do not need a provider or model call. Small native provider connectors remain in Pi and must keep their own work bounded.

Host admission combines:

- A kernel `flock` mutex for short queue/publication transactions.
- Owner-only tickets with process-start identity and nonce checks.
- Fixed systemd user-service slots that control the actual process tree.
- A bounded rendezvous that coalesces compatible jobs. Followers still validate results.

A stale ticket does not authorize another worker in an occupied slot. A stopped live Pi owner can retain a reservation even when the worker unit is inactive. Do not infer free admission from a service name or an empty process view alone.

High/low priorities and aging reduce starvation within finite queues. The contract allows 128 host tickets, eight per-session tickets, 64 coalesced jobs, and 64 waiters per job. Default deterministic concurrency is one, configurable to four. This is not a persistent worker broker or a fairness guarantee for every load pattern.

## Distinct resource limits

The host worker-memory contract is 2 GiB divided across configured slots. Indexed jobs normally have lower limits: 128 MiB V8 heap, 256 MiB operating-system memory, and a 30-second request deadline. Source bytes, decoded data, query candidates, output bytes, and database allocation have separate bounds.

Systemd containment checks effective memory controls, disables swap, bounds tasks, and terminates the whole worker process tree. The controller confirms cleanup. An old reusable cgroup pathname is not a unique execution identity.

Chrono's synchronous `better-sqlite3` catalog binding runs only in contained workers. Its controlled build enables effective SQLite memory accounting. The allocation-refusal probe matters: reading back a configured heap number alone previously gave false assurance. SQLite's allocation ceiling does not measure all native memory, V8, page cache, or host RSS.

Independent Memory uses Node's built-in SQLite with its own page/cache limits. It does not use this process-global catalog allocator setting. Workplan file I/O and selected-plan CPU work have their own bounds and are not placed in a new worker framework.

A status read never raises a limit, installs a worker gate, resumes an owner, or removes another session's reservation. The replacement-session startup correction can recheck a specific earlier unavailable gate during normal scheduling. It does not initialize or repair admission.

## Optional model work

The retained value worker is retrospective compatibility advice, not required indexing. It starts only after compatible segmented candidate preprocessing. With the normal memory engine enabled, that preprocessing and value worker remain paused.

When explicitly enabled and eligible, it uses one immutable segment or a bounded item group. It can send sanitized assistant/tool excerpts. It excludes user and protected instruction text, whole history, full tool output/arguments, source routes, and credentials from its intended prompt format. Redaction is not proof that every private fact is safe to send.

Typed advice can adjust eligible importance scores. It cannot write final context, assign authority, resolve tasks, invent source claims, or downgrade protected safety-floor items. Deterministic code chooses representations and validates the result.

A separate model-slot namespace and per-session run lock coordinate calls. Call/token/cost reservations persist before attempts. Retries and repair calls count. A bounded persisted circuit pauses repeated failure. At compaction, queued work is cancelled and the active signal is aborted without waiting for provider cancellation. Late advice cannot alter a frozen compiler input.

Read [configuration](menu-and-configuration.md#optional-background-llm) for presets and [the detailed value-worker contract](../../../packages/pi-chrono-compaction/docs/value-worker.md) for schemas, budgets, and privacy. No general quality benefit is established.

## Cache inventory

| Data or cache | What it is | Safe interpretation |
| --- | --- | --- |
| Model-provider prompt cache | Provider-controlled reuse of request prefixes. | Stable text helps avoid avoidable changes but cannot guarantee hits or savings. |
| Boundary projection snapshot | Process-local exact replacements for eligible tool results. | Reused between compactions, invalidated with the relevant lifecycle. Original source remains authoritative. |
| Compatibility compaction cache | A sidecar keyed by source/configuration and schema, with prior summary data. | An optional compatibility optimization, not independent Memory or canonical history. |
| Segmented candidate store | Derived alternatives for the older replay pipeline. | Do not run it as a second required lifetime path beside the normal engine. |
| Value-advice store | Immutable validated advice and budget/circuit metadata. | Missing/stale advice leaves deterministic behavior. Budget state is not permission to erase counters and spend again. |
| Search/index/state/rollup stores | Maintained historical derivations with separate identities and checkpoints. | Not a generic cache directory to clear. Pins, readiness, repair, and recovery rules apply. |
| Native context projections | Bounded current-state views owned by each provider. | Not complete provider snapshots or backup files. Workplan retains at most 128 projection objects in its projection cache. |
| Native bindings and logical manifests | Routes to canonical state and preserved source. | Recovery-critical metadata, not disposable summaries. |
| Legacy process-local history index cache | Compatibility-only bounded admitted in-memory index state. | Its 128 MiB cache ceiling and 512 MiB admission ceiling are not total Chrono process memory guarantees. |

There is no general automatic garbage collector for original shards, provider revisions, or old pinned derived stores. Retention on disk and retention in model context are different policies. Any cleanup needs an explicit safe scope and recovery plan.

## Diagnostics and measurement

Use `/Chrono worker-status`, `/Chrono doctor`, `history_status`, and independent `telemetry_status` for their specific observations. A worker timeout includes admission wait. A cache metric is not an accuracy score. Source-wrapper I/O counters do not include every native database read or total system I/O.

The private cache trace is a separate local diagnostic, not bundled/public functionality. Do not copy trace bodies, private routes, or identifiers into repository documentation. It does not feed the Memory store or certify quality.

[Operations index](README.md) · [Telemetry](telemetry.md) · [Troubleshooting](troubleshooting-and-rollback.md)
