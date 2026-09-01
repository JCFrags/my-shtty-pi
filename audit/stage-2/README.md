# Stage 2 — Pi extension consolidation map

This analysis uses Stage 1 commit `19110f9cf34ab29b2059e3bff460e856c7157bce`. It changes no live extension, setting, deployment, repository, branch, worktree, or stash.

## Verified baseline

- 22 Stage 1 entries are accounted for: 21 active in-scope entrypoints and one `EXTERNAL_EXCLUDED` `pi-web` entry.
- The 21 entrypoints form 15 active families: 14 `ACTIVE_CANONICAL` and one `ACTIVE_TEMPORARY`.
- Two inactive real extensions, Review UI and Tool Controls, are retained for later compatibility decisions.
- Proposed retained count: 17 products. `pi-web` is not included.

Grouping corrections are material: Grounded Tools is one seven-entrypoint family with one shared core; Agent Board/deck belongs to Pi Herdr Orchestrator; Signals remains a separate durable inbox product; ChronoCompact remains independent; and singleton lifecycle/presentation utilities remain separate from Herdr Status.

## Source/runtime result

All three compiled products are `EXACT_REPRODUCIBLE` for their Stage 1 runtime closures. Direct isolated TypeScript builds matched 65/65 ChronoCompact JavaScript files, 30/30 Pi Herdr Orchestrator files, and 57/57 Pi Signal Board files. Builds used existing dependencies, ran no package lifecycle hook, and did not execute extension entrypoints. Stage 1 bytes remain authoritative.

`temporary-orchestrator-cancel-isolation` behavior is not present in the deployed orchestrator. It remains `ACTIVE_TEMPORARY` and retained until a later acceptance decision.

## Unmerged and private state

The 87 unmerged ref records deduplicate to 86 change groups: 7 in `my-shtty-pi`, 35 in `my-shtty-pi-herdr-deck`, and 44 in `pi-signal-board`. Objective SHA/tree/stable-patch evidence marks 58 groups `safe-to-delete-later=yes`; 28 remain review-required. Nothing was deleted.

Private Stage 1 evidence records eight dirty worktrees and two stashes. Their product-level conclusions remain `UNKNOWN_REQUIRES_REVIEW`, `safe-to-delete-later=no`; exact bytes were not uploaded.

## Files

- `canonical-products.json` — 18 product records, baseline hashes, product boundaries, provenance, retention, and uncertainty.
- `branch-reconciliation.tsv` — one row per distinct unmerged change group.
- `source-runtime-matrix.md` — compiled-source mapping and isolated build results.
- `proposed-tree.txt` — exact future tree shape; design only.
- `cleanup-policy.md` — later-stage retention, removal, and verification gates.

## Exclusion and safety

`pi-web` is Stage 1 evidence only. Stage 2 did not inspect or reconcile its history, copy it into the proposed tree, or touch its installation, source, settings, or activation.
