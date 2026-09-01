# Cleanup policy for a later implementation stage

Stage 2 authorizes no deletion. This policy defines evidence gates for building a later clean tree.

## Retention boundary

Retain 17 products: 14 active canonical products, the temporary active cancellation-isolation shim, and two inactive real extensions pending compatibility review. Keep `pi-web` outside the tree. Preserve the 15-family active baseline and its 21 entrypoints.

For each retained product, keep only:

1. the exact Stage 1 runtime closure and `DEPLOYED.sha256`;
2. source needed to produce or maintain that runtime;
3. package and lock metadata, build/type configuration, runtime schemas, and runtime-read configuration;
4. license and one concise README;
5. narrowly necessary smoke verification.

Compiled output is retained only for ChronoCompact, Pi Herdr Orchestrator, and Pi Signal Board because Pi loads it. The orchestrator's pinned ChronoCompact tarball is a narrow build-provenance exception to the archive-removal default.

## Removal candidates

Remove from the future clean tree after copying and verifying retained bytes:

- archives and legacy copies, except the pinned orchestrator build dependency;
- planning, milestone, implementation, traceability, and historical audit reports;
- screenshots, generated demonstrations, benchmark scripts, and benchmark artifacts;
- examples not read by runtime;
- duplicated, obsolete, or release-ceremony documentation;
- stale workflows, issue templates, and repository-administration history;
- generated output absent from the deployed runtime closure;
- duplicated package trees and repeated Grounded shared-core copies;
- broad test suites after preserving narrowly necessary smoke checks.

These are categories, not Stage 2 deletion instructions. Exact future removals require a reviewed implementation diff.

## Branch and private-state gates

- `safe-to-delete-later=yes` in `branch-reconciliation.tsv` means only that objective tip/tree/stable-patch evidence shows the branch change is represented elsewhere. It does not delete or authorize deletion.
- Every `safe-to-delete-later=no` group must be reconciled into a retained product or explicitly rejected after review.
- Dirty worktree and stash evidence remains private and is `UNKNOWN_REQUIRES_REVIEW`. Reconcile those bytes before any repository cleanup.
- Keep all refs, worktrees, stashes, backups, and live repositories unchanged until a separate deletion stage receives explicit approval.

## Product boundaries

- Grounded Tools is one family with seven entrypoints and one shared core.
- Agent Board/deck belongs to Pi Herdr Orchestrator; it is not a second Pi product.
- Pi Signal Board is a separate durable inbox product; integration does not transfer ownership to the deck.
- ChronoCompact is independent even though the orchestrator pins a vendored package.
- Herdr Agent State, Herdr Blocked Bridge, Herdr Status, and the temporary cancellation shim remain distinct.
- Native SSH's source-only persistent-session provider is not active baseline behavior.
- Review UI and Tool Controls remain inactive and must not be activated without later acceptance.

## Verification gate for the future tree

The future verification script must compare every active entrypoint and runtime-closure file against Stage 1 SHA-256 values, validate manifests, verify the three reproducible compiled closures, and fail if `pi-web` appears in the consolidated packages. The single workflow should run only these deterministic checks and narrow smoke tests.

## pi-web exclusion

Do not copy, refactor, inspect, reconcile, activate, deactivate, or delete `pi-web`. Keep its Stage 1 snapshot unchanged as historical evidence only.
