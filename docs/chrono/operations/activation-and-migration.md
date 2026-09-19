---
title: Activation and state migration
audience: [operators, agents, maintainers]
status: current procedure, no activation claim
purpose: Separate code selection, loaded use, explicit data import, and practical verification.
related:
  - troubleshooting-and-rollback.md
  - ../state/persistence-and-transfer.md
  - ../../activation.md
---

# Activation and state migration

Activation changes which code Pi loads. Migration changes how a provider owns existing state. Neither is a side effect of documentation, a build, or a successful loader check.

Use the repository [activation runbook](../../activation.md#context-kit-owned-providers-and-v4-compilation) for the full supported workflow. This page explains the Chrono-specific sequence and decision points. It does not authorize an upgrade, import, worker-policy change, restart, or cleanup.

## Preserve before selecting

Keep the original sessions, legacy Memory sidecars, logical manifests, owned stores, prior package roots, configuration, and exact affected registration metadata. Store backups privately outside the repository. Preserve unrelated package order and later settings changes.

Use one native writer for Memory, Todo, Notes, and Workplan. Do not register the Context Kit grouping directory or its pure `protocol` and `state-store` libraries as Pi extensions.

## Prepare the intended source

1. Identify the exact intended source revision and its delivery boundary. A locally accepted integration is not a published GitHub release.
2. Use the repository-root lock for Context Kit and Grounded workspaces. Do not install dependencies separately inside their workspace subpackages.
3. Prepare Chrono's package-local lock after the root lock. Its file dependency must resolve to the retained sibling Context Kit protocol.
4. Build the declared compiled outputs and verify their recorded identity through the repository workflow. Chrono's native catalog driver requires the controlled SQLite build/probe and matching Node headers.
5. Retain the complete needed checkout. A lone Chrono tarball without its protocol sibling is not the supported V4 installation.

The documented integration target is Node 24.18.0 and Pi/TUI 0.85.1. Independent Memory specifically uses Node 24 built-in SQLite. Package manifests and exact retained dependencies remain the compatibility authority. Historical broader Chrono engine ranges do not make every Context Kit provider work on Node 20.

Do not rebuild a package under a running worker or point Pi at a disposable verification tree.

## Coordinate code selection

1. Inspect the complete Pi loader, selected roots, compiled entrypoints, active tool/command owners, and any auto-discovery aliases.
2. Prepare the intended retained source in an isolated loader check, preserving unrelated extensions and Ask User ownership.
3. Replace only the selected legacy Todo, Notes, and Workplan sources. Add independent Memory only with the Chrono ownership handoff.
4. Set `contextCompiler: "v4"` and `memoryOwner: "context-kit"` when those features are intended. Preserve unrelated settings, including the explicit choices for background value work and projections.
5. Keep Telemetry before Chrono. Keep Recall and each state provider independently registered.
6. Guard the selection window so a new loader cannot observe a partial handoff. Use compare-before-write checks, per-file atomic replacement, and a durable rollback journal.
7. Compare the complete selected loader again. Require exactly one owner for each native name, one `/Chrono`, intended provider commands, matching dependency/source identity, and unchanged unrelated owners.

Pi settings and Chrono configuration are different files. Per-file atomic renames do not create multi-file atomicity. On failure, compensate only task-owned changes while preserving unrelated later edits.

## Load and verify

A fresh loader proves registration, not an existing process's activation. A symlink retarget alone can also leave a compiled JavaScript module cached in an existing Pi process. The supported runbook changes the package-list source to the intended retained absolute root before a safe `/reload`.

Before reload, confirm settled agents, no managed jobs or open resources that must continue, no active compaction/switch, and no unsent editor draft. Reload emits shutdown events and can terminate managed jobs. Never clear or overwrite a draft to force it.

After loading:

1. Use `/Chrono search-status` or `history_status` in the actual target process.
2. Compare `loaded.version`, `loaded.entrypointSha256`, and `loaded.deploymentManifestSha256` with the intended source. Match the loaded process identity where available.
3. Check `composition.mode`, captured/configured Memory owner, and reload-required state.
4. Open `/Chrono`, read a report, scroll it, and return without changing settings.
5. Exercise the affected registered interface within the approved practical-check scope. Report source-only, loader-only, and loaded-use evidence separately.

A selected V4 compiler does not prove that every existing branch has imported state or that every Pi process reloaded. Do not repeat already accepted large scenarios merely to produce more test output. A focused changed-path check and retained revision-bound evidence have distinct roles.

## Import existing legacy branches

Freeze the exact branch during import. Select one owner before any new native write. If the provider reports legacy or pending state, do not initialize empty state as a shortcut.

| Provider | Explicit operation | Completion rule |
| --- | --- | --- |
| Todo | `/todo-import` | Repeat bounded pages while pending. Compare complete native state and IDs. |
| Notes | `/notes-import` | Repeat bounded pages while pending. Compare records, archives, revisions, and counters. |
| Workplan | `/workplan-import` | Repeat source/replay steps while pending. Compare complete plans, revision history, decisions, and checkpoints. |
| Memory | `/memory-import-v2` with one explicitly selected sidecar | Preserve exact source bytes and legacy hash formats. Publish only after complete import and durable anchoring. |

Complete Todo import before starting Notes, then complete Notes before starting Workplan. Each progress pointer binds the exact leaf. A different provider's completed import appends an anchor and changes that leaf. Hold model work, other native mutations, and tree moves during each provider's pages. Preserve prior progress if a changed-cut refusal occurs. Do not clear progress or restart from empty state.

Import commands do not silently run during startup, Recall, or package selection. Missing, changed, oversized, invalid, or corrupt source refuses. Partial progress is not a completed import and must not become visible empty state.

A fresh checkpoint-only rollover replacement is different from an old legacy branch. Its bounded complete bootstrap can be restored automatically by the matching owned provider. That does not permit automatic replay of arbitrary legacy history.

After import, compare full native state and source identity before new writes. Verify reopen, branch visibility, and native recovery as needed. Recall coverage is not migration completeness. Memory stays logical-session-visible while Todo/Notes/Workplan stay branch-local.

## Plan the return path first

Before new writes, understand whether the old installation can read the new bootstrap and store formats. After new owned writes, code rollback alone cannot carry those writes back to old providers.

Todo, Notes, and Workplan need complete latest native checkpoints in a fresh replacement. Memory needs reverse V2 export to that replacement's actual sidecar, a complete companion, and verified old native reads before owner selection. Do not append a transfer checkpoint after earlier legacy state.

Keep both source generations and owned stores. Stop before switching if complete capture/export cannot fit or its expected cut changed. See [troubleshooting and rollback](troubleshooting-and-rollback.md).

[Operations index](README.md) · [Selection/evidence boundary](../design/evidence-and-roadmap.md) · [Repository activation runbook](../../activation.md)
