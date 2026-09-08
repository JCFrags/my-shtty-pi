# My Pi extensions

This repository owns the supported Pi extensions and their reproducible inputs.
`package.json` lists active, temporary, and inactive products. It is not an
inventory frozen to an old deployment.

## Supported architecture

- **Project Glance** (`packages/pi-project-glance`) presents Todo, Workplan, and
  progress updates. `/project-glance` opens its Herdr pane. It does not import
  orchestration, Files, or provider implementation code in its runtime.
- **Orchestration** (`packages/pi-herdr-orchestrator`) uses the direct Herdr agent
  path and retained broker infrastructure. `/agent-settings` owns agent settings;
  the retired presentation surfaces and compatibility commands are not supported.
- **Grounded tools** own Todo and Workplan state and their public event contracts.
  Files remains a separate product. Signal Board is removed.
- Other registered products keep their existing entrypoints. The temporary
  cancellation-isolation product remains separate until explicitly retired.

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
scripts, runs Workplan tests, creates package archives, and checks their contents.
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
