# Package artifact checks

`tests/packed-artifacts.test.ts` checks public package boundaries.

The source-pack checks run `npm pack` in a temporary root with a bounded environment. npm runs offline with audit, funding, and lifecycle scripts disabled. The archive checks use reviewed entry lists and reject tests, rollback data, migration data, private paths, and unexpected package peers.

The load checks extract the archive below the same temporary root. They use only controlled peer stubs and a copied TypeScript loader fixture below that root. They load the feature and umbrella extensions in manifest order. They check tool registration, bundled-core resolution, fabricated state, and lifecycle-free manifests. Resolution must stay below the temporary root. It must not reach the source checkout, a home directory, a global Pi installation, or a network fallback.

Source-pack checks and exact release-artifact checks are separate. Exact release verification requires the caller to supply the artifact path, its SHA-256 digest, and provenance. The digest is checked before extraction and loading. Ambient artifact paths and ambient provenance are not used.

The test uses fabricated public-safe state only. It does not inspect installed Pi state, package registration, deployment paths, backups, migration inventories, or rollback data. Live rollback remains a private concern and is not proven by this test.

The test source remains outside npm publication through the package `files` boundary.
