# Foundation package status

This catalog describes the Foundation incubator. No lifecycle status is release approval or installation approval. Every product and release unit has installation, publication, and stable flags set to `false`.

## Lifecycle terms

- **quarantined**: The product scope or failure domain needs decomposition before further Foundation review.
- **experimental**: The product is under active evaluation and has not completed stabilization review.
- **host-dependent**: Full behavior depends on host capabilities that are not part of the package.
- **blocked**: A defined correction is required before Foundation review can continue.
- **candidate**: The product is selected for staged compatibility and stabilization review. It is not approved.

## Product status

| Product | Status | Source | Next gate |
|---|---|---|---|
| ChronoCompact | quarantined | [`packages/chrono-compact`](../packages/chrono-compact) | Decompose its current product scope and failure domain. |
| Grounded Tools | experimental | [`packages/grounded-tools`](../packages/grounded-tools) | Review its broad privileged tool surface. |
| Progressive Tools | experimental | [`packages/progressive-tools`](../packages/progressive-tools) | Complete the same public stabilization and deployment-boundary review. |
| Tool Controls | host-dependent | [`packages/tool-controls`](../packages/tool-controls) | Validate patched Pi capability compatibility. |
| Review UI | blocked | [`packages/review-ui`](../packages/review-ui) | Correct its clean source, build, package, and loading boundary. |
| Files UI | candidate | [`packages/files-ui`](../packages/files-ui) | Use it as the intended first stabilization pilot. |
| Herdr Status | candidate | [`packages/herdr-status`](../packages/herdr-status) | Run real compatibility testing as a later candidate. |

The machine-readable catalog is [`package-catalog.json`](package-catalog.json). Its structure is defined by [`package-catalog.schema.json`](package-catalog.schema.json).
