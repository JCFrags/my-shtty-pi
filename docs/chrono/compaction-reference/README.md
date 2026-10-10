# Maintain the Chrono compaction reference

Status: Approved implementation baseline; implementation in progress.

[reference.md](reference.md) is canonical. [reference.html](reference.html) is its standalone styled derivative. Keep requirements, source qualifications, open implementation choices, and quality limits in Markdown. These are maintained Chrono documents, not official upstream Pi documentation or proof of loaded activation.

## Render offline

Use the repository's supported Node.js version, 24.18.0, and dependencies that are already installed. The renderer first resolves `marked` from the repository-declared `@earendil-works/pi-coding-agent`, then tries a local `marked` package. It does not install dependencies, invoke Pi, or make network requests. The promotion render used `marked` 18.0.5. Other versions must pass the same parity checks before their output is accepted.

From the repository root:

```sh
SOURCE_SHA256=$(sha256sum docs/chrono/compaction-reference/reference.md | cut -d ' ' -f 1)
node docs/chrono/compaction-reference/build-reference.mjs --source-sha256 "$SOURCE_SHA256"
```

The hash binds this render to the reviewed source bytes. It is not an approval receipt. The renderer refuses a hash mismatch or a source change during rendering. It writes only the HTML derivative through a temporary file in this directory.

If normal resolution is unavailable, select an existing compatible `marked` module file explicitly. The path below is a placeholder:

```sh
node docs/chrono/compaction-reference/build-reference.mjs \
  --marked-module /path/to/marked/lib/marked.esm.js \
  --source-sha256 "$SOURCE_SHA256"
```

`--self-check` exercises headings, a table, a code block, and all six diagram embeds without writing HTML. `--parity-json --source-sha256 "$SOURCE_SHA256"` returns the standard Markdown render, styled article, and statistics without writing HTML. Compare article prose, reference links, and exact code text with the standard render. Also verify that the stored HTML matches the current render.

## Presentation assets

The renderer embeds [reference.css](reference.css) and these six accessible SVGs:

- [Interval boundaries](assets/intervals.svg).
- [Restart packet](assets/restart-packet.svg).
- [Cut selection](assets/cuts.svg).
- [Closed-prefix preparation](assets/precompute.svg).
- [Parallel work](assets/parallel.svg).
- [Commit and recovery](assets/commit.svg).

The HTML needs no remote scripts, styles, fonts, or image assets. Reference links navigate only when selected. `assets/draw-diagrams.mjs` retains the diagram source generator. Running it updates only these six SVGs. Regenerate the HTML after an asset change.

The renderer checks all six embeds, token counts, unique IDs, local anchors, accessible label targets, and prohibited active or external assets. These checks do not establish full browser layout, accessibility, model fidelity, or runtime behavior. The promoted style retains the earlier basic visual check only. No browser was started for promotion.

## Evidence boundary

The original private review bundle and its incident receipts are not bundled or changed. Public references identify provider documentation and repository baseline contracts. They do not expose private transcripts, configuration, credentials, runtime identities, or local deployment metadata. Screen every outgoing file and keep generic example paths.

[Chrono documentation](../README.md) · [Package](../../../packages/pi-chrono-compaction/README.md)
