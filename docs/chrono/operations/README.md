---
title: Chrono operation
audience: [users, operators, agents]
status: current reference
purpose: Route configuration, observation, activation, migration, and safe recovery.
related:
  - ../README.md
---

# Operation

| Need | Procedure or reference |
| --- | --- |
| Use the menu or understand settings | [Menu and configuration](menu-and-configuration.md) |
| Understand CPU, memory, scheduling, or caches | [Workers and caches](workers-and-caches.md) |
| Read runtime counters or quality observations | [Telemetry](telemetry.md) |
| Authorize an accepted Chrono update before selecting it | [Startup authorization](startup-authorization.md) |
| Select code and move existing state safely | [Activation and migration](activation-and-migration.md) |
| Investigate a refusal or return to compatible code/state | [Troubleshooting and rollback](troubleshooting-and-rollback.md) |

Begin with read-only status. A build, loader check, or ready index does not prove loaded use or a successful compaction. Keep source files and rollback assets. Do not clear stores or scheduler reservations merely to make status look ready.

[Documentation index](../README.md) · [Repository activation runbook](../../activation.md)
