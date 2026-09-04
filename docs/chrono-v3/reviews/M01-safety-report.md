# M01 safety report

## Review target

- Branch: `work/chrono-v3-m01-safety`
- Base: `ca8a94134e5577edd82204ae173126464fc82b70`
- Reviewed head: `1a4d784a30087a9b46705dcfb6de5ecee0fa6079`
- Draft pull request: #31 into `rebuild/chrono-memory-v3`
- Package version: `2.0.1`

M01 remains unmerged. It does not request or authorize a merge to `main`.

## Safety boundary

M01 refuses legacy whole-file history search and recall above 64 MiB before parsing session content. Exact retrieval above that limit requires an existing verified source ledger and has no whole-file fallback. Search indexes are generation-bound, coalesced, and held under a global 128 MiB byte budget.

The isolated worker uses a bounded source anchor that permits verified append while rejecting replacement or prefix mutation. Stable failure codes cover internal errors, unavailable entrypoints, and resource termination without terminating the parent process. Private diagnostics retain bounded operational fields and an stderr digest and byte count, never arbitrary stderr. Diagnostic files are owner-only, no-follow, single-link regular files with a 1 MiB cap.

Scheduler ownership publication is atomic. Malformed artifacts are removed only after a stable delay and fingerprint revalidation. `/chrono-worker-status` and `/chrono-doctor` expose bounded aggregate state without session content or private paths.

## Verification

The exact reviewed head passed:

- ChronoCompact package tests: 300/300.
- Focused M01 safety tests: 30/30.
- Schema-3 baseline-verifier tests: 29/29.
- Synthetic 205 MiB refusal under a 128 MiB Node heap.
- Package typecheck and committed build comparison.
- Complete root verification and publication/privacy scanning.
- Both GitHub verification checks for PR #31.

The schema-3 M01 boundary records these exact hashes:

- Source tree: `ce9e04d11e314fa19d8d6409bc238d788ab5c9f0332f59612d9b486f34f56b63`.
- Dist tree: `baba971b54b84e97f4382f7dd532ddae3ec74ed80b5b9eec48eb1cbcacf7ea0e`.
- Entrypoint: `2dc8f0dff8c8204c60e0487067263c92ef010415c877938f2b6e807144699d89`.
- Package metadata: `bf56a67fb0a7f449929cec8eac5b44b1e2ca66065648202c5afeea39b61e679d`.
- Lock metadata: `cbccc05104d11e0b082fa419253c517087a52f0bb3bc58f40e60515ecb02f22c`.

An early advisory audit identified three blocking defects: a red focused test, unbounded source hashing, and arbitrary stderr retention. All three were corrected and the complete gates above passed afterward. Later managed audit attempts did not produce results because the orchestration service failed; the directing user waived an additional independent review requirement.

## Activation status

Live activation is deferred. The canonical activation checkout contains unrelated in-progress Project Glance work and is not clean on `main`, so changing it would violate the activation runbook and risk unrelated work. No package replacement, `/reload`, live success smoke, or controlled-failure smoke occurred. The persistent isolated-worker setting remains disabled pending activation.

Before activation, restore the required clean canonical `main` state, create and verify an owner-only rollback, run the isolated loader comparison, activate atomically, reload, and run both live smokes. Enable the isolated worker only if both smokes pass; otherwise keep it disabled and roll back.

## Project-lead disposition

The implementation and review artifacts are ready for project-lead review as an unmerged release candidate. Deployment acceptance remains open because activation and live smoke evidence are intentionally deferred.
