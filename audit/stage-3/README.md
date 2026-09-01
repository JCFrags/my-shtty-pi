# Stage 3 — clean monorepo materialization

Stage 3 materialized the Stage 2 map without changing live Pi state or existing development history.

## Published candidate

- Clean branch: `consolidation/clean-monorepo-20260901`
- Clean commit: `d0e7f35c36e7b5ff60118e0c33de016c9e73fff9`
- Draft product PR: <https://github.com/JCFrags/my-shtty-pi/pull/27>
- Canonical base: `21ea17db6e5cfd98c5c044f505cdc0acc519e750`
- Stage 1 authority: `19110f9cf34ab29b2059e3bff460e856c7157bce`
- Stage 2 authority: `aae9d45e8f1d5bc8b4fa1bf3813c05a9c5a26a01`

The candidate contains exactly 17 product directories. Fifteen families remain active, including the separate temporary cancellation-isolation package, and represent all 21 in-scope active entrypoints. Review UI and Tool Controls remain inactive. Grounded Tools remains one family with seven entrypoints and one shared core. `pi-web` is excluded.

## Reconciliation result

All 28 review-required groups have one final disposition:

- 5 `ABSORBED_CANONICAL`
- 7 `DUPLICATE_OR_SUPERSEDED`
- 8 `PRESERVED_TARGET_BRANCH`
- 3 `REJECTED_NONCORE`
- 5 `REJECTED_STALE_DEPENDENCY`
- 0 `BLOCKED`

Eight preserved branch-change groups and one sanitized private-state record produced nine published `preserved/pi-herdr-orchestrator/*` branches. Each preserved commit is based directly on the clean candidate and changes only `packages/pi-herdr-orchestrator/`. Future or undeployed code did not enter the canonical branch.

## Verification

- Stage 1 hash accounting: 272/272 in-scope runtime records map to 261 unique canonical files; every SHA-256 is exact. The 11 duplicate records are shared deployed files deduplicated by the canonical package layout.
- Active product boundary: 15/15 families and 21/21 entrypoints pass.
- Inactive boundary: 2/2 inactive products are not declared active.
- Compiled reproducibility: ChronoCompact 65/65, Pi Herdr Orchestrator 30/30, Pi Signal Board 57/57.
- Package and JSON manifests parse; all declared Pi entrypoints resolve.
- The root lockfile and all ten package lockfiles complete `npm ci --ignore-scripts` in disposable owner-only directories.
- Narrow syntax smoke check: 232 deployed TypeScript/JavaScript files and 22 deployed JSON files parse without executing extensions.
- Exact root shape, one verification workflow, `git diff --check`, private-path scan, high-confidence secret scan, and no-`pi-web` package checks pass.

## Size result

- Before (`origin/main`): 475 tracked files; 4,388,746 tracked blob bytes.
- After (clean candidate): 655 tracked files; 7,316,704 tracked blob bytes.

The byte increase is primarily exact compiled runtime closure and the orchestrator's required pinned ChronoCompact build-provenance tarball; historical audits, reports, roadmaps, screenshots, examples, archives, benchmarks, broad workflows, and duplicated package roots were not retained on the clean branch.

## Safety boundary

PR #26 remains the draft audit PR. PR #27 remains the draft product PR. Neither PR was merged. `main`, live settings, deployed files, active packages/extensions, `pi-web`, old repositories, and pre-existing refs were not changed or deleted. No extension behavior, feature, API, dependency, or deployment was changed during consolidation.
