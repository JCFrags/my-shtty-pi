# Worker runtime and scheduling

V3 store work runs outside Pi in bounded local workers. The runtime is provider-free. This describes the [candidate implementation](README.md#current-documentation-boundary), not a new host-policy or startup authorization.

## Coordination model

The implemented runtime is a combination of kernel locks, bounded queue metadata, and fixed systemd user-service slots:

- A kernel `flock` mutex serializes short queue and publication transactions. Client death closes its control pipe and releases that mutex.
- Owner-only queue tickets record bounded identity and priority metadata. Process start identity and nonce checks distinguish dead owners and reused process IDs. JSON files still exist; the design is not a pure lock-file-slot implementation.
- A fixed systemd unit per slot controls the actual worker process tree. A stale metadata ticket does not authorize a second worker in an occupied unit.
- Requests coalesce through a host rendezvous keyed by validated job inputs, limits, and entrypoint identity. Followers validate the final response independently.

There are high and low priorities, bounded host/per-session queues, and aging to reduce starvation. The current configuration allows one through four deterministic slots, default one. It does not implement every priority class proposed by the charter or a persistent worker broker.

## Resource and privacy boundaries

The host worker-memory contract is 2 GiB divided across configured slots. Indexed catalog/capsule/search clients use lower job-specific caps, normally 128 MiB V8 heap and 256 MiB operating-system memory with a 30-second request deadline. Source-read, decoded-data, output, and per-operation limits are separate. See the individual store contracts for exact limits.

Systemd containment uses process-tree termination, a memory cap, disabled swap, bounded tasks, and a deadline. The controller verifies effective cgroup memory settings. Startup refuses when the required containment or authorized legacy transition is unavailable; it does not fall back to an uncontained native worker.

Deterministic workers receive an allowlisted environment, not provider credentials. Public errors and status expose bounded codes and categories, not private source paths or output. SQLite's native allocation limit is separate from V8 and total process memory. Source-helper counters do not measure native SQLite I/O or total host RSS.

## Operator use and recovery

Start with `/chrono-worker-status` and `/chrono-doctor` as described in [operations](operations.md#startup-check). A fixed cgroup name can survive or be reused after an execution, so its pathname alone is not a live-process identity. Do not delete scheduler artifacts, stop another session's worker, or create a competing live capacity pool to bypass admission.

Normal retries reuse validated checkpoints and the shared admission path. Containment failures and deployment changes follow [recovery](recovery.md) and [deployment](deployment.md), not broad scheduler cleanup.

[ADR-004](adr/ADR-004-kernel-locks-and-contained-worker-slots.md) records the choice and alternatives. Implementation owners: [runtime](../../packages/pi-chrono-compaction/src/worker-runtime.ts), [scheduler](../../packages/pi-chrono-compaction/src/host-worker-scheduler.ts), [kernel mutex](../../packages/pi-chrono-compaction/src/worker-runtime-mutex.ts), [systemd controller](../../packages/pi-chrono-compaction/src/worker-runtime-systemd.ts), and [limits](../../packages/pi-chrono-compaction/src/worker-runtime-limits.ts).
