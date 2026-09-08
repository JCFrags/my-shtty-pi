# ChronoCompact release compatibility

## Frozen release boundary

The exact-main integration preserves ChronoCompact **2.0.4** from commit
`ad23f0b71ee473d33aff26d367459e76d208c631`. Import only
`packages/pi-chrono-compaction/`, not the whole Chrono development branch.
Later unfinished M04 catalog work is outside this release.

The complete package has 278 indexed files and Git tree
`14dbd0cb89a8b66f4225e2932503b62a808d9be1`. Package source, compiled distribution,
tests, documentation, metadata, deployment manifest, and lock are frozen together.
Do not change the package to satisfy a verifier for an older release.

| Boundary | SHA-256 |
| --- | --- |
| Package metadata | `21ad16a4f192bd7ab831a1f73ca04f3e8d2fd6f099538882f4687a9c02adbd5a` |
| Package lock | `00edb712bdddb3818f54c447da14b38e852b4a4fae1bf0ea23f940de1dae183a` |
| Deployment manifest | `5882a88414a5c8067566c8f46435935f5242598805b23ebeb5187c17bacaa07a` |
| Entrypoint | `e6dab767e69f670daf90a215dbad64f07de7849f9f2f32d25f5183237f5746aa` |
| Source tree, 84 files | `0d0eaca5b0c103b51d5fe9fb373f7c39bc93e4d7229d2c7d2bb91f7b1ee04b02` |
| Distribution tree, 83 files | `04d1bf07b228c9ae6238672794c6adb43a5213c9d91f1690cd32f699ce989747` |

The source-tree hash uses sorted `src/`-relative-to-package paths, each followed
by NUL, file bytes, and NUL. The distribution hash uses sorted paths relative to
`dist/` with the same framing. The Git tree covers the entire package, not just
runtime files.

## Dependencies and checks

Prepare dependencies from the package-local lock:

```sh
cd packages/pi-chrono-compaction
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run build
sha256sum -c DEPLOYED.sha256
npm run test:normal
npm run test:fixed-heap
node scripts/independent-client-soak.mjs --package-root "$PWD" --expected-version 2.0.4
```

Build before tests that load `dist`. Do not rebuild while a suite or worker is
running. Normal, fixed-heap 512/1024 MiB, and independent-client checks use
synthetic sources. Worker tests require Linux user systemd and cgroup support.
Use isolated temporary HOME and agent configuration for package tests, and only
explicit synthetic runtime namespaces. The legacy-gate test file exercises gate
installation and removal in its own temporary namespace; do not substitute
production paths. No package verification command authorizes deployment or live
gate installation.

The independent-client soak requires a real script path, not a symlink. Require
nonempty JSON with `status: passed`; it exercises 54 replay jobs across slots
1, 2, and 4. Its slot-file samples are advisory. The runtime tests separately
check actual kernel resource limits and descendant cleanup.

The frozen package declares Pi peers `>=0.84.2 <0.85.0` and locks development
Pi dependencies to 0.84.2. The accepted repository root uses Pi 0.85.1. Keep the
package lock and metadata unchanged. Package tests prove its locked development
boundary, not installed-Pi compatibility; the rollout owner must run an isolated
installed-Pi loader and synthetic extension check. Loading the entrypoint alone
does not prove native Node dependency resolution for worker scripts.

Root verification must copy indexed inputs, prepare locked dependencies, rebuild
and compare tracked distribution bytes, and validate the frozen package hashes.
Ignore package-local `node_modules/` and generated `dist-test/` in Git. The
frozen compiler also emits 83 source maps beside the 83 tracked JavaScript files.
Validate these generated maps during build checks, then remove only those
untracked maps from the release candidate before checking the exact frozen
83-file distribution tree. Do not remove tracked `dist/` or move dependency
trees to satisfy historical catalog checks. Exclude generated test output from
the verification pack rather than editing this frozen package's manifest.

## Root verifier integration

The pre-integration root scanner rejected all JSONL files. The current verifier
uses an exact path and SHA-256 exception with normal privacy checks. This package
contains one reviewable synthetic fixture, `test/fixtures/session.jsonl`, with SHA-256
`23f198ab80ffe75dec1dbf1aad28037cfa6d5141261d43ea9a82502842efe047`.
Only that frozen fixture is admitted; other JSONL files or changed fixture bytes
remain rejected. The frozen `scripts/memory-characterization.mjs` also
imports `dist-test/src/jsonl.js` and `dist-test/src/search-index.js`. The verifier
resolves these exact caller/specifier pairs against the indexed test build configuration
and retained sources. Other test-build imports, changed configuration, and
missing sources fail. Generated tests are not indexed or shipped.

The original `ad23f0b` baseline script was a Chrono-development-branch verifier.
It required M00 ancestry, a narrow branch correction-path allowlist, a historical
master-plan hash, and retired root consolidation counters. Those assumptions do
not describe the accepted main integration. The new self-contained gate hashes
the complete 278-file package as a Git tree and independently checks the Git
index and working files against the literal approved tree. It requires neither
the original commit object nor branch ancestry, so shallow CI and later branch
cleanup remain supported. The original commit is provenance only. Missing,
extra, modified, non-regular, and index-only package changes fail; only the
package-root local dependency directory is outside the working-file hash.
Root historical verification remains historical; it must not be presented as current activation
verification.

Run the independent check from the repository root:

```sh
node scripts/verify-chrono-v3-baseline.mjs --allow-missing-live --static-only
```

It reports `live.state: not-checked` and never discovers or reads activation
state. Root static and generated-build verification also check the frozen tree.
The root build uses isolated Chrono HOME/configuration and TMPDIR (including the
legacy scheduler lookup), validates the complete
test-output and runtime-map inventories and source bindings, removes only
proven unindexed outputs inside its disposable snapshot, then checks the exact
frozen package before packing. It never cleans the caller checkout.

## Explicit candidate source-map cleanup

After an authorized direct build has produced exactly 83 untracked Chrono
source maps in an indexed candidate checkout, use this explicit helper from
that repository root:

```sh
node --input-type=module -e "import { removeChronoBuildMaps } from './scripts/verify-supported.mjs'; console.log(JSON.stringify(removeChronoBuildMaps(process.cwd())));"
```

The helper first requires the exact approved 278-file index and working package
apart from the 83 maps. It validates the complete map inventory and each map's
binding to its retained source, then removes only those regular untracked map
files. It refuses missing, extra, indexed, malformed, or wrongly bound maps and
any package drift. It does not remove test output, dependencies, or source
files. The result must report 83 removed maps and the approved 278-file tree.
This is an explicit candidate operation, not an activation or live-state check.

## Corrections to frozen historical documentation

Package documentation is preserved for byte identity. These integration notes
supersede the following stale operational statements:

- `README.md` labels the memory boundary 2.0.3 and points at a historical
  deployment verifier. The accepted package identity here is 2.0.4; require the
  frozen hashes above and the current root verifier.
- `docs/local-development.md` uses the retired `packages/chrono-compact` path
  and describes deleting generated distribution or moving local dependencies
  for an old catalog gate. The path is `packages/pi-chrono-compaction`; tracked
  distribution and ignored dependencies must remain at the current boundary.
  Do not follow its automatic backup-removal instruction for retained rollback
  roots.
- `docs/compaction-worker.md` and `docs/architecture.md` describe the older
  PID/file-based capacity model. M03 uses fixed systemd service slots and
  controller-confirmed whole-process-tree cleanup. Metadata alone does not prove
  capacity is free. Revision 2 rejects older 2.0.3 clients without a second pool.
- The older worker document says any append fails. The approved implementation
  accepts a verified pure append beyond the immutable source prefix and refuses
  replacement, truncation, or prefix mutation.
- The benchmark document's 36-job, slots-1-and-2 description predates the frozen
  independent-client script, which runs 54 jobs across slots 1, 2, and 4.
- Historical milestone reports can describe incomplete earlier candidates.
  They are not the authority for this frozen release or current rollout scope.

## Activation boundary

Repository integration is not a new worker-gate transition. Preserve the
accepted live policy, fixed systemd slots, legacy inhibitors, controllers,
configuration, package order, and retained rollback roots. Never install a new
gate, delete scheduler records, stop existing agents, or migrate occupied policy
state merely to integrate exact package bytes into main.

The rollout owner must compare exact candidate hashes, verify an isolated loader
and synthetic worker, and follow the current activation runbook for any package
path change. A running Pi process does not load new bytes automatically. A
same-symlink compiled-ESM reload can retain old modules; use the verified new
absolute package root at the existing package-order position when required.
Do not force reload a process with an unsent draft. Rollback must preserve
unrelated later settings changes and must not restore session JSONL.
