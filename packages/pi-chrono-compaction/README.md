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

V4 is an explicit compiler choice, not a second compactor. It keeps the same-session `{}` followed by sole-summary submission exchange. Failed exchanges pause ordinary model work until a freshly admitted summary-only recovery reaches a correlated commit. See the [failure barrier and cancellation limits](../../docs/chrono/context/session-agent-compaction.md#failure-barrier-and-deliberate-recovery). The 16,384-token planning reservation is not an output cap. Independent Memory also needs a startup ownership handoff. Existing legacy state requires explicit import. Background LLM presets belong to the compatibility advice worker, which is paused under the normal memory engine. They do not enrich V4 indexed compaction.

## Build and installation boundary

Use the root [verification workflow](../../README.md#verification) and [release compatibility](../../docs/chrono-release-compatibility.md), not old campaign commands as new release gates. Chrono's native SQLite build must enforce allocation refusal. Prepare the root lock before the package-local lock because compiled Chrono imports the sibling Context Kit protocol. Use Chrono's package-local TypeScript and Node declarations for its typecheck and build. The retained root and package-local Node declaration versions can differ. Do not change worker source merely to accommodate the wrong dependency route. A lone package tarball is not the supported V4 retained installation.

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

`pi install` only registers source. It does not authorize workers or prepare dependencies. Before first startup at a new package root, review the accepted commit and the intended configuration. The four worker fields must be explicit: `hostWorkerSlots` (1–4), `workerTimeoutSeconds` (30–3600), `workerNiceLevel` (0–19), and `isolatedWorkerEnabled: true`. Do not change a healthy installation's worker policy to make preparation pass.

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

The package-local `docs/` directory and the [V3](../../docs/chrono-v3/README.md)/[V4](../../docs/chrono-v4/README.md) directories retain detailed older contracts and revision-bound evidence. Their old defaults, command names, paths, and milestone status do not override the current subject guide. Runtime module boundaries remain unchanged.

[Repository](../../README.md) · [Context Kit](../pi-context-kit/README.md)
