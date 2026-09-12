# Deployment identity and activation

A candidate package, accepted remote source, linked local package, loaded runtime, and usable behavior are separate states. This documentation does not establish a V3 release or M11/M12 acceptance. `memoryEngineEnabled` remains false by default. See the [documentation boundary](README.md#current-documentation-boundary).

## Authoritative owners

- [Operations](operations.md#deployment-and-reload-safeguards) owns the Chrono deployment and reload sequence.
- [Recovery](recovery.md#deployment-rollback) owns scoped package rollback and preservation of runtime data.
- [Repository activation guidance](../activation.md#activate-and-confirm) records Pi's compiled-module cache behavior. Retargeting an unchanged alias alone can leave an existing process on old code.
- [ADR-002](adr/ADR-002-sqlite-catalog.md) owns the controlled native SQLite dependency. Build the complete package and verified binding together.
- The [selected-package verifier](../../scripts/verify-chrono-v3-baseline.mjs) and [deployment hash manifest](../../packages/pi-chrono-compaction/DEPLOYED.sha256) own declared package identities. Historical release reports do not replace current pins.

## Evidence to retain

| State | Evidence needed |
| --- | --- |
| Accepted source | Exact commit/tree and successful repository checks, plus the applicable acceptance record. Verify remote `main` separately. |
| Built package | Metadata and lock identity, source/distribution hashes, deployment manifest, and verified native addon. Tracked `dist` is part of the package, not an arbitrary live build output. |
| Linked installation | Exact retained package source and Chrono alias/registration, with previous values preserved privately. |
| Loaded runtime | Version, entrypoint hash, and deployment-manifest hash from each intended Pi process. A fresh loader or symlink check is not existing-process activation. |
| Usable behavior | Bounded search-to-recall-to-exact recovery, effective settings, and the actual cut gates for any compaction or rollover in scope. |
| Exercised rollback | The prior package loaded in the intended processes, followed by its practical checks. A backup or `--check` receipt alone is insufficient. |

[Runtime identity capture](../../packages/pi-chrono-compaction/src/runtime-identity.ts) reports loaded bytes. Correlate those hashes with the accepted build receipt; a version string alone cannot identify a source commit.

## Safety and limits

Use an exact accepted source and its supported activation procedure. Preserve only task-owned registration values for rollback. Never restore a whole old settings file over another package's newer settings. Reload one settled process at a time, with no editor draft, active tool, streaming response, compaction, pending switch, or managed job.

Configuration enablement is separate from package activation. One ready synthetic session does not authorize a global default change. Preserve old source shards and derived/routing stores across package rollback. New provider calls, npm publication, public release, automatic rollover, and source deletion are not authorized by these procedures.

[ADR-012 deployment](adr/ADR-012-deployment-generated-artifacts-and-live-identity.md) records the decision. Milestone change history and candidate-specific results remain in the [ledger](milestone-ledger.md) and [review records](reviews/). This page creates no deployment receipt or new claim that a milestone shipped.
