# Context Kit Telemetry

`@context-kit/telemetry` is an independent, local Pi extension. It observes lifecycle events. It does not require Recall, Chrono, Grounded Tools, a provider extension, a model, or a network service.

The extension factory only registers handlers, one tool, and one command. `session_start` creates the collector, a quality-event subscription, and an unreferenced 30-second memory timer. `session_shutdown` removes the subscription, clears the timer, and gives queued writes a 150 ms timer budget to finish. No handler replaces tools, intercepts context, appends session entries, compacts a session, or starts a model turn.

## Load order

If an earlier extension returns `cancel: true` from `session_before_compact`, Pi 0.85.1 stops dispatching that before-event. Put Telemetry before Chrono or another cancelling compactor in the `packages` settings list to observe those attempts. Preserve the relative order of other packages. Otherwise, a terminal event can be unpaired because Telemetry never received its before-event. The collector reports that gap rather than inventing success.

## Read the observations

- Call `telemetry_status` with `{}`. It returns an in-memory snapshot and performs no filesystem reads.
- Run `/context-telemetry` for the same snapshot in Pi's user interface.

Both interfaces show the current loaded session's counters, not a lifetime aggregate. Reload, resume, fork, and new-session activation start a new random run identity. Tree navigation abandons pending correlations, but keeps that loaded session's aggregate counters. A status tool call can itself produce ordinary tool and usage events after its snapshot was made.

### Runtime channel

The runtime channel contains:

- Started, paired terminal, abandoned, and unpaired operation counts. Duration is measured with a monotonic clock. Agent and turn completion mean `ended`, not task success.
- Aggregate tool success and failure. Raw tool names, tool call IDs, and tool contents are not written. At most 64 correlation entries per operation kind remain in memory. Each key is at most 256 characters. Agent and compaction correlations each use one fixed key.
- Paired compaction success, failure, and abort. The before-event and terminal event must agree on reason and retry flag. Orphan, duplicate, mismatched, and overlapping events do not create a paired success. A branch boundary clears previous pending work.
- Provider-reported token totals, split into assistant messages, tool messages, compaction summaries, and branch summaries. Only completed-message or summary usage is counted. Missing or invalid usage has a separate count. Failed compaction usage is not available from the failure event.
- Current process resident memory and JavaScript heap usage. These are whole-process readings, not the extension's memory use.

Counters saturate at JavaScript's maximum safe integer. Individual duration readings saturate at seven days. Each token field must be an integer from 0 through one billion. The collector does not estimate missing tokens, reconcile provider accounting differences, read cost data, or infer accuracy from speed or token use.

Pi supplies no compaction operation ID. Pairing relies on its serialized event lifecycle, reason, retry flag, and local pending state. Overlap becomes ambiguous and is not accepted as success. A missing terminal event becomes abandoned at a lifecycle boundary. If a delayed old terminal arrives after a new matching begin, these fields cannot identify which attempt produced it. This is not an exact distributed trace or a claim that an aborted attempt completed.

### Quality channel

Quality is explicit caller-provided evidence. Runtime events never increment quality success. Without a valid quality observation, `quality.state` is `unknown`. With observations, it is `observed_not_verified`.

A cooperating extension can emit this native Pi event:

```ts
pi.events.emit("pi-context:quality-v1", {
  version: 1,
  kind: "retrieval",
  outcome: "fail",
  basis: "source_known_case",
  issue: "missing_evidence",
  expectedEvidence: 2,
  observedEvidence: 1,
});
```

The package exports `QUALITY_EVENT` and the `QualityObservation` type. Emitting the event does not require importing this package or loading another Context Kit extension.

| Field | Accepted values |
| --- | --- |
| `version` | `1` |
| `kind` | `retrieval`, `agent_outcome` |
| `outcome` | `pass`, `fail`, `unknown` |
| `basis` | Optional. `self_report` by default, or `source_known_case` |
| `issue` | Optional. `none` by default, or `missing_evidence`, `stale_conclusion`, `unsupported_claim` |
| `expectedEvidence`, `observedEvidence` | Optional integers from 0 through 1,000,000 |

Only plain objects with own data properties are accepted. Extra fields, symbols, accessors, invalid enums, and invalid numbers are rejected. The collector copies only these fields. It keeps outcomes and issue counts separate for each kind and basis. A `source_known_case` label means the caller claims to have a known source-backed case. The collector does not read the source, verify the claim, detect duplicate submissions, or certify an outcome. Evidence sums can include repeated caller observations and are not counts of unique sources. Do not emit identifiers, text, paths, or source handles on this channel.

Pi extensions share one JavaScript process. These checks isolate cooperative malformed data and ordinary exceptions. They cannot contain a hostile synchronous loop, proxy, process crash, or filesystem modification by another same-user program.

## Privacy and storage limits

Records contain generated random run UUIDs, bounded numbers, booleans, and fixed codes. They contain no prompt or result bodies, tool arguments, headers, environment values, credentials, raw session IDs, file paths, or raw exception text. Tool call IDs exist only in bounded transient pairing maps. Runtime and quality records have different `channel` values in the same local files and separate status sections. There is no exporter or network code.

The default directory is `~/.local/state/pi-context-kit/telemetry/v1`. The three owned directories (`pi-context-kit`, `telemetry`, and `v1`) must be real, owner-only directories. The writer refuses unsafe existing directories. It does not change their permissions. New files use mode `0600`. The status output never includes the resolved path.

Normal event handlers serialize a small sanitized record, enqueue it, and return without waiting for I/O. One asynchronous writer drains at most 128 queued records of at most 2,048 bytes each. Queue pressure drops new records. Write failures retire the writer with a fixed error code. Counters remain available even when storage fails.

The global managed-storage ceiling is 256 fixed slots of 64 KiB each, or 16 MiB. Exclusive file creation assigns a slot to one writer. No writer appends to another writer's slot, overwrites an existing slot, scans session history, or deletes old files. Concurrent cooperating processes share the same ceiling. A partially filled or crash-abandoned slot still consumes a slot. Therefore, many short runs can exhaust storage before the byte ceiling. At exhaustion, storage reports `full` and `global_cap`, drops later records, and keeps collecting bounded in-memory counters.

Storage does not rotate or resume old slots automatically. Stop all writers and obtain approval for any manual archival or cleanup needed to restore capacity. Unmanaged files and changes by other programs are outside the managed-storage ceiling. The writer does not call `fsync`, so records are best-effort, not an audit log. A crash can leave a partial final JSON line. Shutdown stops waiting when its timer budget expires. A blocked JavaScript event loop can delay the timer. Pending records then appear as `shutdownUnconfirmed`, not confirmed writes or definite losses. An operating-system I/O request can finish later and close its owned handle. Unreferenced timers do not keep Pi running.

## Verification

From the repository root, run:

```sh
npm test --workspace @context-kit/telemetry
```

Two focused Node checks invoke the registered tool and command with a standalone Pi API fixture and real temporary storage. They cover lifecycle pairing, success/failure/abort, branch changes, usage channels, quality separation, privacy sentinels, bounded correlations, queue pressure, concurrent exclusive slot allocation, global exhaustion, and storage refusal. Temporary test files remain for inspection. Tests do not load live settings, call a model, or modify the live telemetry directory.

The checks use the installed Pi 0.85 event types. Native TypeScript test execution requires Node 22.18 or later. The package does not add a runtime dependency beyond Pi's host and TypeBox peers. These checks do not measure agent accuracy, throughput, long-duration filesystem behavior, or activation in an existing Pi process.
