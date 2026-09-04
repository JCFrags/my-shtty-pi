# M01 safety report

## Release identity

- Branch: `work/chrono-v3-m01-safety`
- Base and M00 merge commit: `ca8a94134e5577edd82204ae173126464fc82b70`
- Deployed source commit: `24c6f13f1f6ac9468dfbeba4cad8021b44ecae7f`
- Runtime correction commit: `31b54202bc7ebfc3ce84698102b06276a4cf3efa`
- Draft pull request: #31 into `rebuild/chrono-memory-v3`
- Package version: `2.0.1`

M01 remains draft and unmerged. It does not request or authorize a merge to `main`.

## Safety boundary

M01 refuses legacy whole-file history search and recall above 64 MiB before parsing session content. Exact retrieval above that limit requires an existing verified source ledger and has no whole-file fallback. Search indexes are generation-bound, coalesced, and held under a global 128 MiB byte budget.

The isolated worker uses a bounded source anchor that permits verified append while rejecting replacement or prefix mutation. Stable failure codes cover internal errors, unavailable entrypoints, crashes, and resource termination without terminating the parent process. Private diagnostics retain bounded operational fields plus an stderr digest and byte count, never arbitrary stderr. Diagnostic files are owner-only, no-follow, single-link regular files with a 1 MiB cap.

Scheduler ownership publication is atomic. Malformed artifacts are removed only after a stable delay and fingerprint revalidation. Polling waits remove each AbortSignal listener on resolution, rejection, or cancellation. Verified ledger snapshots accept same-inode growth beyond their checkpoint only while the checkpoint anchor and every selected entry remain hash-valid; replacement, truncation, and selected or checkpoint mutation fail closed. `/chrono-worker-status` and `/chrono-doctor` expose bounded aggregate state without session content or private paths.

## Verification and hashes

The deployed source commit passed:

- ChronoCompact package tests: 307/307.
- Focused correction tests: 39/39.
- Schema-3 baseline-verifier tests: 29/29.
- Synthetic 205 MiB refusal under a 128 MiB Node heap.
- Package typecheck, committed build comparison, root verification, and publication/privacy scanning.
- Both push and pull-request GitHub verification runs at `24c6f13f1f6ac9468dfbeba4cad8021b44ecae7f`.

The clean detached deployment reproduced and verified the manifest with these exact hashes:

- Source tree: `cd131fdf1c89d9a5cefd86e57c0b82258061a6a9569a73aef56c53fb69b81fc2` (66 files).
- Dist tree: `ac067d4a555d9707305fbb319ce85e42e4783d8d45108fb93fb19869a71ae9f0` (65 files).
- Entrypoint: `2dc8f0dff8c8204c60e0487067263c92ef010415c877938f2b6e807144699d89`.
- Package metadata: `bf56a67fb0a7f449929cec8eac5b44b1e2ca66065648202c5afeea39b61e679d`.
- Lock metadata: `cbccc05104d11e0b082fa419253c517087a52f0bb3bc58f40e60515ecb02f22c`.

The previous live package was version `2.0.0` with entrypoint hash `282d5aab3846ad1e6b0d13baea8d357bd8908ab90dacff88ee8bc2bdfaf6fc50`.

## Activation and rollback

Activation used a new clean detached checkout at the exact deployed commit. It did not alter, clean, stash, switch, or depend on the unrelated canonical working checkout. The stable ChronoCompact alias alone was atomically replaced.

Fresh owner-only backup identity: `m01-20260904T185758Z-24c6f13f`. The backup contains the previous live package, effective configuration, original alias metadata, and a checked rollback script. Package and configuration copies matched their live inputs byte-for-byte. The previous entrypoint and configuration hashes were verified as `282d5aab3846ad1e6b0d13baea8d357bd8908ab90dacff88ee8bc2bdfaf6fc50` and `ba127b5650d2317d711199c53c6723da01b82659b32729f1c046b094e986acd0`. The backup and deployment root are owner-only and outside Git; their private paths are intentionally omitted.

## Live smoke evidence

With the isolated worker initially disabled:

- A fresh disposable Pi process loaded version `2.0.1` and both read-only commands.
- Ordinary synthetic small-session compaction succeeded in the main process; the parent remained alive and ordinary fallback was available.
- `/chrono-doctor` and `/chrono-worker-status` returned bounded output with no private path or session filename.
- Synthetic search and recall over a sparse source one byte above 64 MiB both returned `legacy-history-size-limit` under a 128 MiB heap with zero observed RSS growth during the calls.

Temporary worker canaries then passed:

- Three consecutive replay compactions succeeded.
- Verified append during execution succeeded.
- Controlled malformed input returned `worker-internal-error`.
- Controlled child exit returned `worker-crashed`.
- Controlled SIGKILL/resource termination returned `worker-resource-limit`.
- The Pi parent survived every canary.
- Diagnostics remained mode `0600`, below 1 MiB, and excluded injected credential-like text, source text, session filenames, and private paths.

Because every canary passed, `isolatedWorkerEnabled` was changed from `false` to `true` as the only effective configuration change. A fresh production-discovery Pi process loaded without extension errors, reported the worker enabled, and exposed both commands without private paths. A repeated ordinary synthetic compaction used the isolated worker successfully while the parent remained alive. Main-process fallback remains configured for safe worker failure.

## Incident status

- I-0001: contained for legacy search and recall by the deployed 64 MiB pre-read guard; oversized exact retrieval is ledger-only and bounded.
- I-0002: resolved for the controlled reproduction. The observed internal-failure code is `worker-internal-error`; child crash and resource canaries returned `worker-crashed` and `worker-resource-limit`, and the parent/fallback path remained available.

## Disposition

The M01 safety fixes are usable locally. Persistent isolated-worker execution is enabled after all required canaries passed. Rollback is verified and ready. Remaining risk is limited to synthetic acceptance coverage: the preserved affected session was not read or modified, and PR #31 remains draft and unmerged pending project-lead review.
