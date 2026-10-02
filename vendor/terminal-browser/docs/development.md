# Development and release verification

[Product guide](../README.md) · [Installation and rollback](installation.md)

## Source boundary

Run browser commands from `vendor/terminal-browser`. Its pnpm workspace is
separate from the parent repository's npm workspace. Copying or building source
does not activate a Pi extension or replace an installed browser.

`copy-provenance.json` records the original import and maintained changes. In
schema version 2, a new local file has `sourceSha256: null`: there was no imported
source file to hash. Removed imported files retain their original hashes in the
removal records. These records describe origin, not current runtime activation.
Do not invent original hashes for new files. `upstreams.lock.json` separately
pins external runtime inputs.

After staging the intended browser changes, regenerate provenance from the parent
repository root, inspect the resulting JSON, and stage it:

```sh
node scripts/update-browser-provenance.mjs
git add vendor/terminal-browser/copy-provenance.json
```

The verifier supports locally added files with `sourceSha256: null` and retained
hashes for removed imported files. Stage only intended changes before regeneration.

This copy includes the browser and pinned AgentCursor, not WebX search/read,
research loaders, retirement tooling, or unrelated web services. Contributions
follow this repository's rules, not inherited upstream contribution gates.

## Prepare and build

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm -r build
bash scripts/copy-react-grab.sh
pnpm --filter terminal-browser --filter terminal-browser-cli --filter pi-terminal-browser typecheck
pnpm --filter terminal-browser --filter terminal-browser-cli --filter pixel-store --filter pi-terminal-browser test
```

After an `--ignore-scripts` install, `copy-react-grab.sh` supplies
`assets/react-grab/index.global.js` for source runtime startup. The TypeScript
build does not replace this step.

Use pnpm 10.13.1 and a compatible Node host. The repository browser-copy CI uses
Node 24.18.0 on Ubuntu 22.04 and a Rust toolchain. Native builds need Cargo, a C/C++
linker toolchain, `pkg-config`, and the platform graphics/font development
libraries used by the Rust renderer. Complete Linux artifact checks also need
Python 3.11+, Bubblewrap, and an X11 test display for native Electron fixtures.
Inspect the actual CI workflow and Cargo inputs when preparing another host;
a successful TypeScript build alone does not establish native readiness.

Electron remains pinned to **43.3.0** and AgentCursor to commit
`b23c633c66fd240f836f5edd1034f6fcf678e237`. `upstreams.lock.json` records patched
Electron archive checksums, AgentCursor, and the blocking engine/filter inputs.
The legacy `agent-browser` input and bundle are removed. The native CLI is the
agent control interface.

## Build a complete artifact

```sh
TERMINAL_BROWSER_RELEASE_OUT=/absolute/fresh-output pnpm build:dist
pnpm test:dist
```

Choose a fresh output directory. The build does not replace source `dist`
directories, install Pi/Herdr packages, run setup, or stop browsers. It stages
Electron, browser/CLI code, the N-API module, AgentCursor, bundled blocking
filters, fonts, skills, license notices, the optional Pi extension, and prebuilt
Herdr adapter under `<output>/<artifact-id>/terminal-browser/`. Bundling optional
adapter files does not select or start those integrations.

The build verifies Electron's pinned archive checksum and uses locked Cargo
inputs with separate outputs. To reuse the native cache, set
`TERMINAL_BROWSER_NATIVE_TARGET`. Never point it at a live runtime directory.
Use `CARGO_BUILD_JOBS=2` to limit native build memory use.

Each `build-manifest.json` records the full source commit, dirty flag, source-input
digest, lockfile hashes, runtime/tool versions, integration metadata, and runtime
file hashes/modes. A dirty build has a dirty-tree suffix, not a clean-commit claim.
The outer platform manifest hashes both the archive and internal manifest.

```sh
node scripts/dist-manifest.mjs verify /absolute/extracted/terminal-browser /absolute/manifest-linux-x64.json
pnpm test:dist:smoke /absolute/extracted/terminal-browser
pnpm test:dist:recovery /absolute/release-output-A /absolute/release-output-B
```

Product release tags use `terminal-browser-vVERSION`. A tag or local build is not
proof of artifact publication, installation, or loaded-process identity. Use the
actual available archive and matching manifest. Do not use upstream `upgrade`.

## Verification scope

The Linux x64 distribution smoke and recovery fixtures use Bubblewrap with no
real HOME, checkout, development `node_modules`, display socket, or external
network. Only the loopback fixture is reachable. They test packaged launchers,
native SQLite/assets, and the packaged daemon through private PTYs and CLI/socket
interfaces. Coverage includes actions, frames, popups, separate owners, pause,
and exact-inventory shutdown refusal. Internal captures are not visible terminal
acceptance. For a CPU-sensitive startup failure, use `taskset -c` with one available
CPU and record that condition rather than silently replacing the result.

Recovery requires two complete sealed output directories. It stages packaged
managers outside the checkout, checks interrupted activation and scoped rollback,
and switches selections while an old daemon and paused companion stay loaded.
The new CLI must refuse mismatched mutation without replay. The Pi loader checks
loaded identity against next-launch selection and explicit A/B lifecycle changes.
These fixtures do not touch a real Herdr API, production installation, or live
Pi session. SIGKILL recovery checks do not establish power-loss durability.

Run retained-manager checks through `scripts/install.sh`, not host Node with
`install-manager.mjs`. The shell entrypoint selects bundled Electron. Its normal
`fs` API exposes `.asar` files as virtual directories even with
`ELECTRON_RUN_AS_NODE=1`. The installer also sets `ELECTRON_NO_ASAR=1` so validation
hashes physical archive bytes and modes. This setting is limited to the installer
process and its children. It does not change browser launchers or running processes.

The prepared Pi test host defaults to the pinned workspace host, 0.84.2. Set
`TERMINAL_BROWSER_PI_ROOT` to another prepared host directory, including the
installed 0.99.1 host, when testing that specific version. Missing host dependencies
fail rather than skip. A peer dependency wildcard follows Pi's host-module mapping
contract. It is not a promise that all Pi versions work. See the
[adapter guide](../pi-extension/README.md) for compatibility evidence.

```sh
# Existing offline loader fixture. It neither starts a browser nor reloads Pi.
TERMINAL_BROWSER_PI_ROOT=/absolute/pi-coding-agent node --test scripts/test/pi-reload.test.mjs
```

Packaged Pi and Herdr entrypoints call their own artifact's `bin/terminal-browser`.
That launcher establishes `TERMINAL_BROWSER_DIST_ROOT` and uses bundled Electron
as the CLI runtime. The Pi source build instead selects an explicit source launch
mode. The packaged Herdr descriptor has no checkout build step. No development
symlink or runtime dependency installation is needed for those packaged adapters.

`pnpm test:dist:ci` builds two fresh complete releases outside the checkout and
runs the distribution, smoke, and recovery gates. Inspect its script and current
workflow before treating it as a CI requirement. The repository's browser-copy
job also builds, typechecks, and tests integration packages. Terminal-adapter
baseline checks are not a substitute for packaged runtime acceptance.

## Native and visible checks

`pnpm --filter terminal-browser test:electron` runs pinned Electron fixtures.
Linux needs an X11 display, for example `xvfb-run -a`: the native Wayland dialog
backend can fail on hidden windows. An isolated private XDG runtime may not contain
the host Wayland socket. Use `--ozone-platform=x11` for an approved X11 runtime
check in that environment; do not weaken isolation merely to find the socket. The fixtures cover root/popup/frame input,
opener communication, dialogs and beforeunload decisions, project files,
transfers, cancellation, takeover, and locator/frame geometry limits. Tests for
terminal overlay positions do not prove alignment on a particular terminal.

For a focused visible check, run `node browser/test/fixtures/dynamic-live.cjs`
and open its loopback URL. Choose the right card, wait for the replaced delayed
control, then select the `contact-form` frame. Fill `Contact name`, wait for
`Submit embedded` to become actionable, and capture the result. Each counter
must increase only once. Repeat the frame step in its popup to check alignment.
The fixture uses local data. Record the terminal, display scale, artifact identity,
and actual result. Do not claim cross-monitor or cross-platform acceptance from
this one fixture.

A rebuilt CLI does not replace an existing Electron daemon. Follow the exact
inventory/approval process in [installation](installation.md) before replacement.
Then verify a fresh process and changed behavior. Source HEAD alone is not evidence.

Tests must isolate HOME, all XDG directories, `TERMINAL_BROWSER_APPDATA`,
`TERMINAL_BROWSER_INTEROP_DIR`, and `PI_CODING_AGENT_DIR`. Remove inherited Herdr
and browser-owner routes. Use a short private runtime path, such as a directory
from `mktemp -d /tmp/XXXXXX`, because Unix sockets have a small path-length limit.
XDG isolation alone does not isolate global interop state.
