---
title: ChronoCompact package
audience: [users, agents, maintainers]
status: source reference, activation is process-specific
purpose: Identify the candidate source, package boundary, approved compaction baseline, and retained runtime documentation.
related:
  - ../../docs/chrono/compaction-reference/reference.md
  - ../../docs/chrono/context/interval-compaction.md
  - ../../docs/chrono/README.md
  - ../../docs/chrono/USER-GUIDE.md
  - ../../docs/chrono-release-compatibility.md
---

# ChronoCompact

Chrono selects useful chronological context and preserves source-linked historical recovery for long-running Pi tasks. The V3 and compatibility programmatic paths can run without model calls. The interval candidate's V4 path requires a same-agent task handoff and a separate immediate continuation. Deterministic A/B/C history remains available with all helper roles off.

Source version: `4.1.5-local.20261010`. Chrono development Pi/AI/TUI dependencies are `1.1.0`, with peers `>=1.1.0 <1.2.0`. Root tooling and other product pins remain `0.85.1`. The package typecheck, build, and bounded offline Pi 1.1 lifecycle check passed, including saved normal/recovery commits, cancellation, and one continuation per commit. These earlier checks do not verify later repairs or loaded activation. Updates use the current required repository checks and [authorization-before-selection procedure](../../docs/chrono/operations/startup-authorization.md). See the [manifest](package.json), [interval implementation guide](../../docs/chrono/context/interval-compaction.md), and [release compatibility](../../docs/chrono-release-compatibility.md).

- Pi entrypoint: `dist/src/pi-extension.js`, compiled-loaded.
- Build: `npm run build`, after the required locked dependencies and native SQLite preparation.
- Identity check: `node ../../scripts/verify-chrono-v3-baseline.mjs --static-only`.
- Operator interface: one `/Chrono` menu, with settings, status, reports, and maintenance.

## Read the documentation

Start with the [approved Markdown reference](../../docs/chrono/compaction-reference/reference.md) or its [standalone styled HTML](../../docs/chrono/compaction-reference/reference.html). Status: Approved implementation baseline; implementation in progress. The [interval implementation guide](../../docs/chrono/context/interval-compaction.md) describes candidate source and its unsettled integration limits. The other routes retain the earlier runtime baseline. None establishes completion or activation of the new design. These are Chrono documents, not official upstream Pi documentation.

| Need | Start here |
| --- | --- |
| Approved compaction behavior and open implementation choices | [Markdown reference](../../docs/chrono/compaction-reference/reference.md) · [Styled HTML](../../docs/chrono/compaction-reference/reference.html) |
| Candidate source, A/B/C, handoff, helper consent, request bounds, and recovery | [Interval implementation](../../docs/chrono/context/interval-compaction.md) |
| Plain-language functions and practical controls | [User guide](../../docs/chrono/USER-GUIDE.md) |
| Complete subject map | [Chrono documentation](../../docs/chrono/README.md) |
| Architecture, contracts, and module ownership | [Architecture](../../docs/chrono/architecture/README.md) |
| Historical search, exact recovery, chronology, and rollover | [History](../../docs/chrono/history/README.md) |
| Compaction, budgets, receipts, retention, and Recall | [Context](../../docs/chrono/context/README.md) |
| Independent Memory and native state | [State providers](../../docs/chrono/state/README.md) |
| Configuration, workers, caches, migration, and rollback | [Operations](../../docs/chrono/operations/README.md) |
| Version boundary, changes, evidence, and limitations | [Design and evidence](../../docs/chrono/design/README.md) |

The inspected selector still defaults to `v3`. `contextCompiler: "v4"` selects the interval candidate, subject to its Pi 1.1 public-hook requirement. V4 is a compiler choice, not a second compactor. The same-session `{}` request now asks for `handoff` plus a separate `continuation` in the sole submission. Main-agent planning reserves `min(model.maxTokens, DEFAULT_COMPACTION_SETTINGS.reserveTokens)`, at most 16,384 tokens with Pi 1.1 defaults. The reserve is not a provider output cap. Crossing the planning threshold requests a summary-only response rather than refusing that response. Helper calls separately require effective request-local caps. Legacy token, trigger, tail, summary, and value-worker tuners do not govern the automatic interval policy. See the [implementation guide](../../docs/chrono/context/interval-compaction.md) for fallback, refusal, archive reads, and early projected-media admission. Independent Memory still needs its own startup ownership handoff. Existing legacy state requires explicit import.

## Build and installation boundary

The preparation procedures below apply to an accepted retained checkout. They do not authorize selection or establish loaded activation of this candidate. Use the root [verification workflow](../../README.md#verification) and [release compatibility](../../docs/chrono-release-compatibility.md), not old campaign commands as new release gates. Chrono's native SQLite build must enforce allocation refusal. Prepare the root lock before the package-local lock because compiled Chrono imports the sibling Context Kit protocol. Use Chrono's package-local TypeScript and Node declarations for its typecheck and build. The retained root and package-local Node declaration versions can differ. Do not change worker source merely to accommodate the wrong dependency route. A lone package tarball is not the supported V4 retained installation.

### Portable checkout preparation

Retain a full accepted repository checkout at a safe absolute path. Use Node 24.18.0 on Linux x64, a working user systemd manager with cgroup support, `/usr/bin/flock`, GCC, Python 3, Make, and separately prepared verified Node 24.18.0 headers. Do not copy another computer's dependencies, native addon, authorizations, or worker namespaces.

From the retained checkout, with `NODE_HEADERS` set to that verified header directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build --workspace @context-kit/protocol
cd packages/pi-chrono-compaction
npm ci --ignore-scripts --no-audit --no-fund
npm run catalog:sqlite:build-record -- "$PWD/node_modules/node-gyp/bin/node-gyp.js" "$NODE_HEADERS" 24.18.0
npm run typecheck
npm run build
npm run catalog:sqlite:probe-record
sha256sum -c DEPLOYED.sha256
```

The record route admits compiler-specific native output only after the same pinned source, node-gyp, and headers checks. Its probe verifies the recorded binary and allocation refusal. The strict `catalog:sqlite:build`/`probe` route instead requires the recorded reference binary hash. Neither route downloads headers or a prebuild. A reinstall removes the addon, so rebuild and probe after the last package install. Do not build inside a root used by running workers. Direct builds also produce source maps. Follow the repository's validated map-cleanup and exact-tree verification procedure before authorization preparation.

### Exact-root startup authorization

`pi install` only registers source. It does not authorize workers or prepare dependencies. For updates, use [the guarded selector](../../docs/chrono/operations/startup-authorization.md), which prepares or verifies authorization before changing the named package registration. Keep the prepare-only command below for explicit preparation or first setup. Never edit an active retained root to update its code. Before first startup at a new package root, review the accepted commit and the intended configuration. The four worker fields must be explicit: `hostWorkerSlots` (1–4), `workerTimeoutSeconds` (30–3600), `workerNiceLevel` (0–19), and `isolatedWorkerEnabled: true`. Do not change a healthy installation's worker policy to make preparation pass.

The prepare-only generator reads accepted Git bytes and verifies their exact runtime inventory and installed contents. It hashes the ordered worker-configuration projection. It does not start workers, initialize or repair admission, change policy, register packages, or reload Pi. It requires a clean Chrono package at the named checkout HEAD, real protected ancestors, and an existing owner-only output directory. It creates a new mode-0600 file exclusively and refuses an existing output.

```sh
node packages/pi-chrono-compaction/scripts/prepare-startup-authorization.mjs \
  --checkout "$CHECKOUT" --commit "$ACCEPTED_COMMIT" \
  --config "$CHRONO_CONFIG" --output "$PRIVATE_OUTPUT/startup-authorization.candidate.json"
```

Run this command from the checkout root. Use absolute real paths for `CHECKOUT`, `CHRONO_CONFIG`, and `PRIVATE_OUTPUT`. Create only a new private output directory, outside the checkout, with mode 0700. `ACCEPTED_COMMIT` is the reviewed 40-character HEAD, not an inferred latest branch. Preparation does not establish GitHub acceptance or grant permission to initialize workers.

The result names `expectedAuthorizationPath`: beside the configuration, under `chrono-deployments/<SHA-256 of the exact package path>/startup-authorization.json`. In an authorized selection window, create only the new protected mode-0700 deployment directories and generate the authorization there with a new exclusive output. Preserve all previous authorizations. Do not copy a record from a different root or replace an existing record.

The existing `dist/src/worker-runtime-startup-client.js` exports `startAuthorizedWorkerRuntime(authorizationPath)`. Run it only when worker startup is authorized. On a fresh machine, the supported startup checks inactive systemd slots and absent runtime and legacy namespaces before initialization. Success reports `state: "ready", changed: true`. A code-only update with a healthy existing gate must report `state: "ready", changed: false`. Partial, foreign, unsafe, or mismatched state refuses. Do not delete state or bypass the guard to retry.

A build, registration, effective setting, loaded identity, and practical use are separate checks. Follow [activation and migration](../../docs/chrono/operations/activation-and-migration.md). Preserve source shards, provider stores, and compatible rollback assets.

The package-local `docs/` directory and the [V3](../../docs/chrono-v3/README.md)/[V4](../../docs/chrono-v4/README.md) directories retain detailed older contracts and revision-bound evidence. Their old defaults, command names, paths, and milestone status do not override the current subject guide. V3 compaction, compatibility replay, stored previews, logical continuation, and persisted-history readers remain supported.

[Repository](../../README.md) · [Context Kit](../pi-context-kit/README.md)
