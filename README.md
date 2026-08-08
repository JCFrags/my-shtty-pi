# my-shtty-pi

Source-only repository for reusable Pi extensions and small local tools.

This is an independent project. It is not an official Pi project.

## Status

The project is early and experimental. Package APIs may change. Review each package before use.
Extensions run with the permissions of the Pi process. Do not install source that you have not reviewed.

Included packages:

- `pi-chrono-compact` — chronological context compaction. Experimental. Pi 0.83-compatible source boundary.
- `pi-grounded-tools` — evidence-first tools and coordination extensions. Experimental. Pi 0.83-compatible source boundary.
- `pi-tool-controls` — tool-output display controls. Experimental.
- `pi-review-ui` — approval UI for edit and write tools. Experimental.
- `pi-files-ui` — file and context browser. Experimental.
- `pi-herdr-status` — display-only Herdr metadata. Experimental. It does not replace official Herdr integration.

## Installation

No installation is provided by this repository. Use a pinned local path or a pinned Git reference.
Do not use an unpinned remote source.

Each package has its own manifest and package instructions. Build output is intentionally absent from this source-only tree.

## Development

Use the package's documented offline checks. Do not install dependencies in this repository during review.
The repository-level public-tree check is:

```text
node scripts/check-public-tree.mjs
```

## Safety

These packages can read files, run commands, use Pi session state, or connect to a local Herdr endpoint as documented by the individual package.
Review permissions, configuration, and source before use. Never commit credentials, tokens, cookies, private keys, sessions, logs, or machine-specific paths.

## Provenance

See `NOTICE` and `docs/provenance.md`. Source custody records stay outside this repository.

## License

Original package source uses the package license shown in its manifest. The repository documentation is MIT-licensed where marked.
Third-party dependencies are not bundled in this repository and remain the responsibility of each package's dependency and peer-dependency metadata.
