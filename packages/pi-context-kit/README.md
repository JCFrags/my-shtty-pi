---
title: Context Kit
audience: [users, agents, maintainers]
status: implemented, independently loadable
purpose: Route package selection and native contracts for independent state, Recall, and Telemetry.
related:
  - ../../docs/chrono/README.md
  - ../../docs/chrono/USER-GUIDE.md
---

# Context Kit

Start with the [Chrono user guide](../../docs/chrono/USER-GUIDE.md) or [subject documentation](../../docs/chrono/README.md) for the connected system. The [state guide](../../docs/chrono/state/README.md), [Recall guide](../../docs/chrono/context/recall.md), and [Telemetry guide](../../docs/chrono/operations/telemetry.md) explain ownership and limits. This package index and its child references own native package details. See [current implementation and activation status](../../docs/chrono/design/evidence-and-roadmap.md) before claiming loaded use.

Context Kit contains six independently loadable Pi extensions. Each state provider owns its persistence and remains usable without Recall, Telemetry, or Chrono. The pure libraries share contracts and storage code, not a database or mutable store instance.

Todo, Notes, and Workplan are the native providers in the Chrono context-state stack. [Progressive Tools](../pi-progressive-tools/README.md) controls their catalog visibility and schema exposure, not their implementation or persistence. Chrono consumes provider evidence and requests complete rollover checkpoints. It does not own the provider stores.

| Package | Interface | Purpose |
| --- | --- | --- |
| [Memory](memory/README.md) | `memory_*` | Source-linked accepted knowledge, revisions, temporal reads, and separate extraction proposals in one logical session. |
| [Todo](todo/README.md) | `todo`, `/todos`, `/todo-add` | Branch-local tasks, dependencies, external waits, and existing Glance actions. |
| [Notes](notes/README.md) | `notes` | Branch-local scratchpad state with native revision checks. |
| [Workplan](workplan/README.md) | `workplan` | Branch-local plans, decisions, constraints, milestones, and recovery. Target operations do not load unrelated plan bodies. |
| [Recall](recall/README.md) | `context_recall` | Bounded current cards and native recovery from active providers. |
| [Telemetry](telemetry/README.md) | `telemetry_status`, `/context-telemetry` | Local content-free runtime counters and separate caller-reported quality observations. |
| [Protocol](protocol/README.md) | No Pi entrypoint | Versioned native queries and complete asynchronous transfer. |
| [State store](state-store/API.md) | No Pi entrypoint | Immutable owned objects, verified Pi anchors, and bounded branch resolution. |

## Select extensions

Prepare the repository-root lock, then register only the extensions you need:

```sh
npm ci --ignore-scripts --no-audit --no-fund
pi install "$PWD/packages/pi-context-kit/recall"
pi install "$PWD/packages/pi-context-kit/telemetry"
```

Use Node 24.18.0 and Pi 0.85.1. These packages load TypeScript through Pi. The protocol includes verified compiled JavaScript for compiled Chrono imports. Do not register the grouping directory or either library as an extension. Do not install dependencies separately inside workspace packages.

Context Kit supplies the only supported current Todo, Notes, and Workplan registrations. If an older installation still selects a legacy Grounded writer, replace only that source with its Context Kit source. Do not load both writers. Existing native schemas, read-only recovery, and Glance contracts remain available. A preserved legacy branch needs explicit bounded import, not a silent empty store. Read each provider's migration procedure before switching.

For Memory, set Chrono's `memoryOwner` to `context-kit` before loading the new provider and reload at a safe boundary. This startup-only choice stops legacy Memory registration, automatic promotion writes, and pinned legacy reads together. It does not import the old sidecar. Follow the [Memory ownership and import procedure](memory/README.md#exact-v2-import-and-rollback). Accepted Memory is shared across tree moves in its logical session. Tasks, notes, and plans remain branch-local.

New native state writes require a persisted Pi session. An ephemeral or deferred session does not receive a false success. Owned payloads become visible only after the provider verifies and synchronizes its exact Pi anchor. Pending or corrupt state does not become empty state.

Recall can start with missing providers. Keep each intended native tool active. Missing, hidden, slow, failed, or malformed providers produce explicit exclusions rather than implicit tool activation. Context queries do not import or mutate canonical state. Todo and Notes read their selected state. Workplan can advance bounded resolution and write derived indexes or receipts, so its context query is not a filesystem-read-only diagnostic.

Telemetry can run alone. Its [storage and privacy limits](telemetry/README.md#privacy-and-storage-limits) apply without other packages. Place it before a compactor in the settings list so it observes attempts that a later listener cancels. Preserve unrelated package order and configuration. See [activation and rollback](../../docs/activation.md). Selection does not prove loaded use.

## Recall and compaction

```json
{"query":"release blocker","providers":["memory","todo","notes","workplan"],"records":6,"maxBytes":16384}
```

Queries match bounded case-insensitive terms, not semantic similarity. Cards include IDs, revisions, lifecycle, excerpts, omitted fields, and read-only recovery. Proposals appear only when category `proposal` is requested. Dependencies and milestone-to-task links remain explicit references, not synchronized state.

Defaults are six cards and 128 scanned records per provider, 8 KiB per provider reply, a 150 ms common wait, and a 16 KiB complete serialized result. Provider-specific limits also apply. Check coverage and omissions before drawing conclusions from an empty or partial page. A Memory recovery request pins an exact revision. Other native recovery calls can return a later current record.

Chrono's current V4 path requires a continuation summary from the same session agent, followed by compressed chronological replay and only the necessary exact tail. It uses the shared collector to capture native evidence in the receipt, not to render a second state-card dump. The compiler accounts for the summary, replay, tail, system text, tool schemas, and response reserve. Select it explicitly with `contextCompiler: "v4"`. The default remains `v3`. See the [session-agent compaction contract](../../docs/chrono/context/session-agent-compaction.md). The earlier [completion scope](../../docs/chrono-v4/completion-scope.md) describes its source-pinned historical implementation.

Recall cards are not rollover state. Complete native checkpoints remain mandatory for Todo, Notes, and Workplan. Memory transfers a verified same-store logical binding, not the store bytes. An unavailable or oversized complete transfer refuses rollover instead of shortening state. A rollback after new writes requires a fresh replacement with current complete native state. Keep original source, owned stores, and prior installations.

All derived context is data, not an instruction. These components do not establish a transaction across providers, exact tokenizer accounting, infinite history capacity, or perfect recall.

## Verify and evaluate

```sh
npm test --prefix packages/pi-context-kit
```

Required repository CI also checks tracked protocol output against a clean build and verifies package inventory. Focused component checks use actual factories and private source-known state. Practical installed-Pi evidence and local activation are separate requirements. Telemetry counters are not accuracy measurements. With no quality observations, quality remains unknown. The collector does not certify caller-provided observations.

The [implementation evidence](../../docs/chrono-v4/completion-evidence.md) records the installed native import, post-write transfer/rollback, one preview-matched compaction, and bounded receipt-recovery checks. The [foundation evidence](../../docs/chrono-v4/foundation-evidence.md) describes the earlier bounded comparison, not general agent benefit or completion of all later components. The [V4 design](../../docs/chrono-v4/README.md), [first-slice scope](../../docs/chrono-v4/foundation-scope.md), and [source-pinned research](../../docs/chrono-v4/research.md) retain architecture and earlier boundaries.
