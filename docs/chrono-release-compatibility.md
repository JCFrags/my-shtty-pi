# ChronoCompact release compatibility

## Current promotion

The owner now directs promotion of the finished M09/M10 stack and all-live-session
adoption. See [the promotion report](chrono-v3/reviews/main-promotion.md) for the
2.0.23 integration delta, approval boundary and rollout policy. Its candidate
identity replaces the current verifier pins only after explicit reconciliation.
No approval, merge or loaded adoption is implied by this document change.

The sections below record the earlier 2.0.15 release. Their version, file counts,
peer range and campaign commands are historical, not instructions to repeat
those campaigns for the new promotion.

## Prior 2.0.15 release boundary

The current integration nominates ChronoCompact **2.0.15** from commit
`b5918dbf952423e86a50a71e03ae1996c4801ea5`. Its upstream package tree is
`fe3c1df802214b6eba96f39fc36912817058d0d3`.

The integration imported only `packages/pi-chrono-compaction/`. It did not merge
the Chrono development branch. The imported package has five intentional
test-only differences from the upstream tree:

| Test-only difference | Upstream SHA-256 | Integrated SHA-256 |
| --- | --- | --- |
| `test/capsule-extension.test.ts` | `6070fcea5f49f22632d37d2853b6538b3c3daf41ff28608de002dda6b31d9902` | `d0dd28fb1f7dbe71f945f52174284a5102730c1631228cb7d64230478bd3e37d` |
| `test/catalog-history-provenance.test.ts` | `37a10d10a33c1ad7bebfb082d1e3396782331924fae9ecbd76dcefd09a0e4bbb` | `bdbd323f06ff4be86695c40e503c9dcc8d126950d53f6d6c52f3db1b545e1abd` |
| `test/catalog-lifecycle.test.ts` | `ad0ac9d641c5453c181fd954776062dd156b3ed208f8fa447c6e2872f1a2d8c4` | `90d33f69ddd8a7f93b0e8113d283207bdb2814fef73fc3f6c45f35d7efa7632d` |
| `test/extension.test.ts` | `1d0247207b0dc2fc30e3b219c277d0f8ad4ffdf12e7be9d7f5ac11f782675c06` | `b2c1439fc352ff4bb9fdf7b24cdc7bafaf6e97e330ed66105a4e9161ae2afc8d` |
| `test/worker-runtime.test.ts` | `d55227e12c9ce45e42b4703daf30b2966f95d1352cd442319ae01fd8fbf7fee0` | `54ed55886810e4dbaf14625efc8a84aacc39a6f88009a71c1e7ea20821046b3b` |

The capsule and incremental fixtures provide the session identity that the
current asynchronous `session_start` rollout interface requires. The catalog
lifecycle fixture awaits that interface and explicitly disables the mutually
exclusive search index before it checks catalog opt-in behavior. The extension
registration fixture covers the current tool and command sets. The provenance
fixture covers `history_status` as a registered retrieval-provenance tool.

The worker fixture records every original cgroup member by PID and process start
identity. After abrupt client death and replacement execution, it requires every
original identity to be absent. It does not require immediate removal of the
fixed, reusable systemd slot pathname. This corrects a race with asynchronous
cgroup filesystem cleanup without changing runtime behavior or weakening old
process-tree detection.

All other 393 package files are byte-for-byte copies from the upstream package.
This includes all `src/`, `dist/`, policy, manifest, lock, and package documentation
bytes. The integrated package is therefore not the exact upstream package tree.
Its complete pinned identity is 398 indexed files and Git tree
`eb53a6a18c63cd15cc6108bcc94243ec2c4116f7`.

| Boundary | SHA-256 |
| --- | --- |
| Package metadata | `7a2e4b5b9f7612e488140ac7c0f4049eb73783f7ab25aed1941cec0e0f596803` |
| Package lock | `7aaedb56346065f378ae5f6587c8904c60d6f00b7cde8e5d524c9f8da007fd23` |
| Deployment manifest | `8abe0294264262df6b6bf6d71170c495f5ea323d5340e63c2f96848c8af39b7f` |
| Entrypoint | `10694c70ba9da19637675417cb9d6a9ebef08d6ae40de83a0571aae4f2bef4dd` |
| Source tree, 125 files | `a5c919799e771f98b798a8258a7c4059a7cece74811ba3eed3d92da6a13f920b` |
| Distribution tree, 124 files | `bcfee536e0cec3308dbe92352d72c359eb800dcffbc4c265b2c214dc7d8ce843` |

The source-tree and distribution-tree hashes use sorted paths relative to their
respective directories. Each path is followed by NUL, the file bytes, and NUL.
The complete Git tree includes tests, scripts, documentation, metadata, and the
compiled distribution.

## Dependencies and checks

Prepare dependencies from the package-local lock. The strict local route requires
the exact Node 24.18.0 runtime and its already prepared, verified header root:

```sh
cd packages/pi-chrono-compaction
npm ci --ignore-scripts --no-audit --no-fund
npm run catalog:sqlite:build -- node_modules/node-gyp/bin/node-gyp.js <verified-node-24.18.0-headers-root> 24.18.0
npm run typecheck
npm run build
npm run catalog:sqlite:probe
sha256sum -c DEPLOYED.sha256
npm run test:normal
npm run test:fixed-heap
node scripts/independent-client-soak.mjs --package-root "$PWD" --expected-version 2.0.15
```

Build before tests that load `dist`. Do not rebuild while a suite or worker is
running. The package lock pins `better-sqlite3` 12.9.0 and node-gyp 12.3.0.
`npm ci --ignore-scripts` deliberately leaves the native addon unbuilt. Use the
explicit native source build and allocation-refusal probe after the last package
reinstall and before tests. The build command verifies the source tree, node-gyp,
target, and header tree. It has no prebuild or header-download fallback. Do not
weaken install isolation or execute an unreviewed dependency script to make a
gate pass.

Normal, fixed-heap, and independent-client checks use synthetic sources. Worker
tests require Linux user systemd and cgroup support. Use isolated temporary HOME,
Pi configuration, and TMPDIR paths. Use only explicit synthetic runtime
namespaces. The legacy-gate tests install and remove a gate only in their own
temporary namespace. No package verification command authorizes deployment,
live gate installation, or production namespace access.

The package declares Pi peers `>=0.84.2 <0.85.0` and locks development Pi
dependencies to 0.84.2. The repository root can use a different Pi version.
Package tests prove the locked development boundary, not installed-Pi
compatibility. The rollout owner must run an isolated installed-Pi loader and
synthetic extension check before activation.

## Root verifier integration

The self-contained root gate pins the complete integrated 398-file package tree.
It reports the upstream commit/tree and all five declared test-only differences.
It independently checks the Git index and working files against the
integrated tree. The upstream commit object does not need to remain available in
a shallow CI checkout.

Run the independent static check from the repository root:

```sh
node scripts/verify-chrono-v3-baseline.mjs --allow-missing-live --static-only
```

The command reports `live.state: not-checked`. It does not discover or read live
activation state. Root supported verification copies indexed inputs to a disposable snapshot,
installs locked dependencies, performs a controlled source build of the native
addon, probes the recorded addon and its effective heap limit, rebuilds the
package, compares all 124 tracked distribution JavaScript files byte-for-byte,
validates generated output and source-map bindings, and removes only proven
generated files before checking the exact integrated tree. Root verification
requires Node 24.18.0 and an explicit `CHRONO_CATALOG_NODE_HEADERS` path. The
header tree must be the verified Node 24.18.0 tree. For example:

```sh
CHRONO_CATALOG_NODE_HEADERS="$HOME/.cache/node-gyp/24.18.0" npm run verify
```

CI pins Node 24.18.0, prepares that header tree separately with locked node-gyp
12.3.0, and passes the path to the disposable verifier. The verifier uses the
package's `catalog:sqlite:build-record` and `catalog:sqlite:probe-record` route so
Ubuntu compiler output is recorded and checked without weakening the immutable
Fedora reference hashes. Header preparation is the only network-enabled step in
this sequence. The controlled native build cannot download headers or a prebuild.

The root privacy scanner admits only the reviewable synthetic fixture
`test/fixtures/session.jsonl`, SHA-256
`23f198ab80ffe75dec1dbf1aad28037cfa6d5141261d43ea9a82502842efe047`.
Other JSONL files or changed fixture bytes remain rejected. The verifier retains
the exact test-build import and source checks for the memory characterization
script.

## Explicit candidate source-map cleanup

An authorized direct package build produces exactly 124 untracked source maps
beside the 124 tracked distribution JavaScript files. To remove those maps from
an exact candidate checkout, run:

```sh
node --input-type=module -e "import { removeChronoBuildMaps } from './scripts/verify-supported.mjs'; console.log(JSON.stringify(removeChronoBuildMaps(process.cwd())));"
```

The helper first requires the exact approved index and working package apart
from the maps. It validates the complete map inventory and every source binding,
then removes only those regular untracked map files. It does not remove tracked
`dist/`, test output, dependencies, or source files.

## Historical baseline provenance

The earlier exact-main integration preserved ChronoCompact **2.0.4** from commit
`ad23f0b71ee473d33aff26d367459e76d208c631`. That historical package had 278
files and Git tree `14dbd0cb89a8b66f4225e2932503b62a808d9be1`.
`CHRONO_HISTORICAL_BASELINE` retains this identity for provenance. It is not an
accepted current package identity and does not relax the current 2.0.15 gate.

The original 2.0.4 development-branch verifier also depended on historical
ancestry, master-plan, and consolidation assumptions. Current verification uses
the literal integrated package tree instead. Historical reports remain evidence
for their own candidates only.

## Corrections to package-local historical documentation

Package-local documentation is preserved byte-for-byte from the nominated
upstream source. These integration notes supersede stale operational statements:

- `README.md` labels an older memory boundary and points at a historical
  deployment verifier. The integrated candidate is 2.0.15 and uses the current
  root verifier.
- `docs/local-development.md` uses the retired `packages/chrono-compact` path and
  describes removing or relocating package outputs for an older gate. The path
  is `packages/pi-chrono-compaction`. Keep tracked distribution bytes and locked
  dependencies intact. Root verification performs cleanup only in a disposable
  indexed snapshot.
- Older worker documentation can describe PID/file-based capacity. Current
  runtime capacity uses fixed systemd service slots and controller-confirmed
  whole-process-tree cleanup. A fixed cgroup pathname is not a unique execution
  identity.

## Activation boundary

Repository integration does not authorize a new worker-gate transition, M09
authoritative enablement, settings changes, deployment, reload, or service
restart. Preserve the existing live policy, systemd slots, legacy inhibitors,
controllers, configuration, package order, and rollback roots.

The rollout owner must compare the exact integrated hashes, verify an isolated
loader and synthetic worker, and follow the current activation runbook for any
package path change. Running Pi processes do not load new bytes automatically.
Rollback must preserve unrelated later settings and must not restore session
JSONL files.
