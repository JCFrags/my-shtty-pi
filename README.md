# My Pi extensions

This repository owns the supported Pi extensions and their reproducible inputs.
`package.json` lists active, temporary, and inactive products. It is not an
inventory frozen to an old deployment.

## Supported architecture

- **Project Glance** (`packages/pi-project-glance`) presents Todo, Workplan, and
  progress updates and deferred questions. `/project-glance` opens its Herdr pane. It does not import
  orchestration, Files, or provider implementation code in its runtime.
- **Orchestration** (`packages/pi-herdr-orchestrator`) uses the direct Herdr agent
  path and retained broker infrastructure. `/agent-settings` owns agent settings;
  the retired presentation surfaces and compatibility commands are not supported.
- **Grounded tools** own Todo and Workplan state and their public event contracts.
  Files remains a separate product. Signal Board is removed.
- Other registered products keep their existing entrypoints. Main’s completed
  removal of the temporary cancellation-isolation product is preserved.

## Terminal-browser and AgentCursor source copy

[`vendor/terminal-browser`](vendor/terminal-browser/README.md) contains a browser-only
copy from `JCFrags/my-shtty-pi-web` at `19c33769a33edddd066b3bac291ce371d2c1aba9`.
It includes the Electron browser, pinned AgentCursor dependency, rendering engine,
CLI, Pi extension, Herdr plugin, assets, build tools, and browser tests. Its pnpm
workspace stays separate from this repository's npm workspace.

WebX search/read, its optional loader, research services, retirement scripts, and
external publishing automation are not imported. The original web repository and
current installed tools remain unchanged. This source copy is not an additional
automatically loaded Pi package. Per-file hashes and intentional copy adaptations
are recorded in `vendor/terminal-browser/copy-provenance.json`.

From the copied directory, use `pnpm install --frozen-lockfile` and `pnpm build`.
The native build needs Rust/Cargo and the platform libraries documented there.
Use the five native browser tools in Pi, not the upstream CLI as a substitute.

## Verification

Use Node.js 24, npm, Git, and Python 3. Stage intended changes first: verification
copies **Git index blobs** into a private disposable directory. Unstaged edits,
untracked files, ignored dependencies, and local build output are not inputs.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run verify:static
npm run verify
npm run verify -- --product pi-project-glance
```

Static checks cover the registry, locks, local imports, package boundaries,
retired commands/dependencies, and privacy. Full verification installs package
locks with lifecycle scripts disabled, runs supported typecheck/syntax/build/test
scripts, runs Dialog and Workplan tests, creates package archives, and checks their contents.
Glance provider tests use the same disposable source tree. Existing tracked
compiled products must reproduce their checked-in output; Glance and
orchestration may generate untracked build output from supported source.
`--product` narrows execution, not repository-wide static checks. These checks do
not activate packages or replace live Herdr interaction checks.

## Historical evidence

`deployed-baseline-2026-09-01` preserves the captured deployment. To check its
hash manifests against **historical Git objects only**:

```sh
npm run verify:history
# Optional explicit historical tag or commit:
npm run verify:history -- deployed-baseline-2026-09-01
```

Historical counts and `DEPLOYED.sha256` files describe that capture. They do not
constrain current product files, build counts, or the supported product registry.
Deployment and local activation are separate from repository verification.
