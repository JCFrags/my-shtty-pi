# Pi Package Incubator

`my-shtty-pi` is an independent community Pi package incubator. This public repository contains nine products and seventeen release units. It is not endorsed by Pi.

The root is a private npm control plane, not a workspace or install boundary. npm `private: true` prevents accidental publication of the root package. It does not make this GitHub repository private.

## Package status

The lifecycle status describes review state. It is not a release, installation, or publication approval. See [status definitions](docs/package-status.md).

| Product | Status | Package source |
|---|---|---|
| ChronoCompact | quarantined | [source](packages/chrono-compact) |
| Grounded Tools | experimental | [source](packages/grounded-tools) |
| Progressive Tools | experimental | [source](packages/progressive-tools) |
| Agent Context | experimental | [source](packages/pi-agent-context) |
| Tool Controls | host-dependent | [source](packages/tool-controls) |
| Review UI | blocked | [source](packages/review-ui) |
| Files UI | candidate | [source](packages/files-ui) |
| Herdr Status | candidate | [source](packages/herdr-status) |
| Native SSH | candidate | [source](packages/native-ssh) |

No package is stable, generally recommended, or publication-approved. This repository does not make a general installation recommendation. Files UI is the intended first stabilization pilot.

## Root commands

Run the repository checks without installing dependencies:

```sh
npm run test:repo
npm run check:catalog
npm run check:public-tree
npm run inventory
npm run check
```

These commands check repository structure and policy. They do not prove package behavior or Pi compatibility.

## Working order

See the [roadmap](docs/roadmap.md) for the broad stabilization order and [release gates](docs/release.md) for package-specific release decisions.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Read [SECURITY.md](SECURITY.md) before reporting a security concern. Do not post secrets or exploit details in public issues.

## Safety and provenance

Extensions run with Pi process permissions. Review source and pin exact inputs before use. Never commit credentials, tokens, cookies, private keys, sessions, logs, machine paths, or private state. See [NOTICE](NOTICE) and [provenance guidance](docs/provenance.md).

## License

Original package source uses the package license shown in its manifest. Repository documentation is MIT-licensed where marked.
