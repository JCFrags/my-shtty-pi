# ADR-004: Kernel locks and contained worker slots

Status: records the implemented runtime choice, not a new scheduler policy or M11 acceptance. See the [documentation boundary](../README.md#current-documentation-boundary).

## Context

A persistent JSON ownership record can outlive its client. A client lock alone also cannot prove that all worker descendants have exited. Shared admission must separate short metadata transactions from actual process-tree capacity.

## Decision

Use kernel `flock` for short queue/publication mutexes and fixed systemd user-service units for contained worker slots. Keep bounded owner-only queue tickets with nonce and process-start identity checks. Use host rendezvous to coalesce identical validated jobs. The controller verifies capacity and stops the whole process tree before normal slot release.

This is a hybrid, not a claim that all JSON scheduler metadata was removed. The runtime has high/low priorities, bounded queues, and aging. The [worker subject page](../workers.md) maps its source and limits.

## Alternatives

- JSON records as the sole capacity authority can retain stale ownership.
- Kernel locks as the sole worker boundary do not account for descendants that survive the client.
- A persistent socket broker adds daemon startup, authentication, and upgrade lifecycle. The current runtime does not require one.
- Uncontained child processes or a larger V8 heap cannot bound native SQLite memory and process descendants.

## Consequences

Linux, user systemd, cgroup support, and the authorized startup/legacy transition are prerequisites. Missing containment fails closed. Kernel locks remove mutex ownership on death, while validated metadata recovery and fixed units handle scheduling separately. A reused cgroup pathname is not proof that an old process remains alive. Multi-session fairness and scale still need their candidate-bound evidence.

## Migration

Use the existing verified startup transition and one shared admission namespace. Do not create a second live capacity pool or delete metadata to bypass policy. Existing compatibility jobs use the same runtime where integrated.

## Reversal path

Stop scheduling new task-owned work at a safe boundary and restore the known compatible package/policy through [deployment rollback](../recovery.md#deployment-rollback). Keep another session's active workers and policy intact. A rollback is not permission to return to uncontained workers or clear the host scheduler broadly.
