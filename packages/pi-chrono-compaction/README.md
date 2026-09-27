---
title: ChronoCompact package
audience: [users, agents, maintainers]
status: active canonical source
purpose: Identify the package entrypoint, build boundary, and current subject documentation.
related:
  - ../../docs/chrono/README.md
  - ../../docs/chrono/USER-GUIDE.md
  - ../../docs/chrono-release-compatibility.md
---

# ChronoCompact

Chrono selects useful chronological context and provides source-linked historical recovery for long-running Pi tasks. The programmatic path needs no model call. Source history remains preserved when detail leaves active context.

- Pi entrypoint: `dist/src/pi-extension.js`, compiled-loaded.
- Build: `npm run build`, after the required locked dependencies and native SQLite preparation.
- Identity check: `node ../../scripts/verify-chrono-v3-baseline.mjs --static-only`.
- Operator interface: one `/Chrono` menu, with settings, status, reports, and maintenance.

## Read the documentation

| Need | Start here |
| --- | --- |
| Plain-language functions and practical controls | [User guide](../../docs/chrono/USER-GUIDE.md) |
| Complete subject map | [Chrono documentation](../../docs/chrono/README.md) |
| Architecture, contracts, and module ownership | [Architecture](../../docs/chrono/architecture/README.md) |
| Historical search, exact recovery, chronology, and rollover | [History](../../docs/chrono/history/README.md) |
| Compaction, budgets, receipts, retention, and Recall | [Context](../../docs/chrono/context/README.md) |
| Independent Memory and native state | [State providers](../../docs/chrono/state/README.md) |
| Configuration, workers, caches, migration, and rollback | [Operations](../../docs/chrono/operations/README.md) |
| Version boundary, changes, evidence, and limitations | [Design and evidence](../../docs/chrono/design/README.md) |

V4 is an explicit compiler choice, not a second compactor. Independent Memory also needs a startup ownership handoff. Existing legacy state requires explicit import. Background LLM presets belong to the compatibility advice worker, which is paused under the normal memory engine. They do not enrich V4 indexed compaction.

## Build and installation boundary

Use the root [verification workflow](../../README.md#verification) and [release compatibility](../../docs/chrono-release-compatibility.md), not old campaign commands as new release gates. Chrono's native SQLite build must enforce allocation refusal. Prepare the root lock before the package-local lock because compiled Chrono imports the sibling Context Kit protocol. A lone package tarball is not the supported V4 retained installation.

A build, registration, effective setting, loaded identity, and practical use are separate checks. Follow [activation and migration](../../docs/chrono/operations/activation-and-migration.md). Preserve source shards, provider stores, and compatible rollback assets.

The package-local `docs/` directory and the [V3](../../docs/chrono-v3/README.md)/[V4](../../docs/chrono-v4/README.md) directories retain detailed older contracts and revision-bound evidence. Their old defaults, command names, paths, and milestone status do not override the current subject guide. Runtime module boundaries remain unchanged.

[Repository](../../README.md) · [Context Kit](../pi-context-kit/README.md)
