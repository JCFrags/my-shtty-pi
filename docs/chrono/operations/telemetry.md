---
title: Runtime and quality Telemetry
audience: [users, agents, maintainers]
status: implemented, independently loadable
purpose: Explain local observations without confusing runtime success with answer quality.
related:
  - workers-and-caches.md
  - ../design/evidence-and-roadmap.md
  - ../../../packages/pi-context-kit/telemetry/README.md
---

# Runtime and quality Telemetry

Context Kit Telemetry is independent of Chrono, Recall, the state providers, and any model service. It observes Pi lifecycle events. It does not alter tools, inject context, compact, start a model turn, or read source history.

Call `telemetry_status({})` or open `/context-telemetry`. Both read the current loaded run's in-memory snapshot without filesystem reads. They are not lifetime aggregates.

## Runtime channel

The runtime channel measures bounded operational events:

- Started, paired, abandoned, and unpaired operations.
- Aggregate tool success/failure and monotonic durations.
- Correlated compaction success, failure, and abort.
- Provider-reported token totals separated by usage channel, with missing usage counted separately.
- Whole-Pi-process resident memory and JavaScript heap readings.

An agent or turn ending means `ended`, not task success. Process memory is not Telemetry's own allocation. Token totals are reported usage, not inferred cost or exact missing usage.

Pi has no compaction operation ID. Correlation uses serialized lifecycle, reason, retry flag, and local pending state. Duplicate, orphan, or overlapping events do not create a false paired success. Some delayed matching events cannot be distinguished perfectly. This is not an exact distributed trace.

Reload, resume, fork, and new-session activation start a fresh random run identity. Tree navigation abandons pending correlations but retains that loaded run's aggregate counts.

## Quality channel

Quality requires an explicit caller observation through `pi-context:quality-v1`. Accepted fields describe `retrieval` or `agent_outcome`, `pass`/`fail`/`unknown`, declared basis, issue category, and optional bounded expected/observed evidence counts.

No observation means `quality.state: "unknown"`. Valid observations mean `observed_not_verified`, not certified correctness. `source_known_case` is the caller's declared basis. Telemetry does not inspect the source or independently score the answer. Self-reports remain separately identifiable. Repeated observations are not deduplicated into unique cases.

Runtime events never increment quality success. Lower tokens, faster replies, or a smaller context cannot establish better agent behavior by themselves.

## Privacy

Stored records contain generated random run IDs, bounded numbers, booleans, and fixed codes. They exclude prompt/result bodies, tool arguments, raw tool names, headers, credentials, environment values, source/session IDs, private paths, and raw exception text. There is no network exporter.

This Telemetry is distinct from Pi's own install/update telemetry and from Chrono's internal diagnostics. Loading Context Kit Telemetry does not control those separate systems.

## Storage and load order

Load Telemetry before Chrono or another compactor that can cancel `session_before_compact`. Pi 0.85.1 stops dispatching that before-event when an earlier handler cancels. A later collector can then see an unpaired terminal event.

The collector uses a bounded asynchronous queue: at most 128 records of 2,048 bytes each. Managed storage has 256 fixed 64 KiB slots, a 16 MiB ceiling shared by cooperating local writers. Partly filled or crash-abandoned slots still consume capacity.

The writer never overwrites, reuses, rotates, or deletes old slots automatically. Full or failed storage stops disk collection, not agent work or bounded in-memory counters. Many short runs can fill the slot inventory before 16 MiB of useful data exists.

Records are best-effort, not a synchronized audit log. Shutdown has a 150 ms waiting budget and reports unconfirmed writes honestly. A crash can leave a partial final line. Manual archival or cleanup requires stopped writers and an approved scope.

Same-process validation does not sandbox hostile code or protect against another same-user program modifying files.

## Useful interpretation

Use runtime observations to ask whether an operation ran, failed, waited, or lacked a paired event. Use a source-known practical scenario to ask whether the agent recovered the correct fact and acted safely. Report those findings separately.

[Operations index](README.md) · [Full Telemetry contract](../../../packages/pi-context-kit/telemetry/README.md) · [Evidence limits](../design/evidence-and-roadmap.md)
