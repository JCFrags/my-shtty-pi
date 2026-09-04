# M01 safety report

## Review target

- Branch: `work/chrono-v3-m01-safety`
- Base: `ca8a94134e5577edd82204ae173126464fc82b70`
- Runtime source commit: `31b54202bc7ebfc3ce84698102b06276a4cf3efa`
- Draft pull request: #31 into `rebuild/chrono-memory-v3`
- Package version: `2.0.1`

M01 remains unmerged. It does not request or authorize a merge to `main`.

## Safety boundary

M01 refuses legacy whole-file history search and recall above 64 MiB before parsing session content. Exact retrieval above that limit requires an existing verified source ledger and has no whole-file fallback. Search indexes are generation-bound, coalesced, and held under a global 128 MiB byte budget.

The isolated worker uses a bounded source anchor that permits verified append while rejecting replacement or prefix mutation. Stable failure codes cover internal errors, unavailable entrypoints, and resource termination without terminating the parent process. Private diagnostics retain bounded operational fields and an stderr digest and byte count, never arbitrary stderr. Diagnostic files are owner-only, no-follow, single-link regular files with a 1 MiB cap.

Scheduler ownership publication is atomic. Malformed artifacts are removed only after a stable delay and fingerprint revalidation. Polling waits remove each AbortSignal listener on resolution, rejection, or cancellation, so long waits do not accumulate listeners. Verified ledger snapshots accept same-inode growth beyond their checkpoint only while the checkpoint anchor and every selected entry remain hash-valid; replacement, truncation, and selected or checkpoint mutation fail closed. `/chrono-worker-status` and `/chrono-doctor` expose bounded aggregate state without session content or private paths.

## Verification

The runtime source commit passed:

- ChronoCompact package tests: 307/307.
- Focused correction tests: 39/39.
- Schema-3 baseline-verifier tests: 29/29.
- Synthetic 205 MiB refusal under a 128 MiB Node heap.
- Package typecheck and committed build comparison.
- Complete root verification and publication/privacy scanning.
- Both GitHub verification checks for PR #31 are required before activation.

The schema-3 M01 boundary records these exact hashes:

- Source tree: `cd131fdf1c89d9a5cefd86e57c0b82258061a6a9569a73aef56c53fb69b81fc2`.
- Dist tree: `ac067d4a555d9707305fbb319ce85e42e4783d8d45108fb93fb19869a71ae9f0`.
- Entrypoint: `2dc8f0dff8c8204c60e0487067263c92ef010415c877938f2b6e807144699d89`.
- Package metadata: `bf56a67fb0a7f449929cec8eac5b44b1e2ca66065648202c5afeea39b61e679d`.
- Lock metadata: `cbccc05104d11e0b082fa419253c517087a52f0bb3bc58f40e60515ecb02f22c`.

An early advisory audit identified three blocking defects: a red focused test, unbounded source hashing, and arbitrary stderr retention. All three were corrected and the complete gates above passed afterward. Later managed audit attempts did not produce results because the orchestration service failed; the directing user waived an additional independent review requirement.

## Activation status

Activation will use a clean detached checkout at the exact final pushed head. The unrelated canonical working checkout will not be altered, cleaned, stashed, or switched. Before replacement, activation requires a fresh owner-only verified package backup and an isolated loader check. The persistent isolated-worker setting remains disabled until all success and controlled-failure canaries pass.

## Project-lead disposition

The implementation and review artifacts are ready for project-lead review as an unmerged release candidate. Deployment acceptance remains open because activation and live smoke evidence are intentionally deferred.
