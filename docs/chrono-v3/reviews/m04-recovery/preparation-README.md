# M04 2.0.5 boot-recovery preparation

Status: **review candidate only**. Created 2026-09-09. No production apply, window, job, process stop, configuration write, registration change, alias change, dependency change, or Git change was performed.

## Authorized source identity and provenance

- Accepted commit: `dcd91924dbcfc0c02489e04c3e163b33e2b08e86`
- Git authority used read-only: `REDACTED_LOCAL_GIT_CHECKOUT`
- Git object type: `commit`
- Package tree at the accepted commit: `5c70e9c1826fe88c0da9f9e4f51b41aa62b2240c`
- Package identity from the accepted Git blob: `pi-chrono-compact` version `2.0.5`
- Manifest: 96 entries: `package.json` plus every one of the 95 recursive `dist/src/**/*.js` files.
- Deterministic `path NUL digest newline` closure-record SHA-256: `53744675ef444812aa8c2905ac381d1bb933e6bbac4cb796ebe290585848700a`
- Profile SHA-256: `2c0b48e15d817a6d1333eaa4855cbb8cd41a32d3ba0c6be41479e6e6022507b9`

The expected hashes were generated with `git show` from the accepted commit. Installed files were checked only afterward: all 96 matched. Installed bytes were not used to create the profile.

The profile keeps only the existing four configuration projection key names and its SHA-256. It contains no configuration values. The helper reads the owner-only configuration directly, computes the same projection in memory, and emits no values.

## Files

- `boot-recovery-m04.mjs`: preparation-only candidate helper.
- `recovery-profile.json`: exact accepted identity, 96-file runtime closure, limits, projection hash, and synthetic scope.
- `synthetic-checks.sh`: local checks restricted to this directory's private synthetic namespace.
- `synthetic-check-results.json`: preserved initial bounded receipt; the corrected harness never overwrites it.
- `receipts/`: collision-safe receipt paths created once per successful corrected-harness run.
- `helper-diff-vs-original.patch`: exact unified diff against the retained M03-pinned helper.
- `SHA256SUMS`: hashes of stable review artifacts and the latest unique receipt; the checksum file excludes itself.

All files are owner-only mode `0600`; this directory, `synthetic-runs/`, and `receipts/` are mode `0700`.

## Change from the retained helper

The retained helper and pins were read only. Their supplied hashes were confirmed:

- Original helper: `d9af16f8fd16f16fbf145683b2b80941eb2513ef2fadb3a5226b2de62877b98f`
- Original 74-entry M03 pins: `209d6abb8d2a655662f617a3b1dd8306bc1f5dccc67aececab6a2df6c2978cb9`

The candidate:

1. Pins accepted M04 commit identity and a 96-entry full recursive runtime manifest instead of the old 74-entry subset.
2. Therefore covers the 12 M04 catalog files and the 10 recursive reducer files omitted by the old subset.
3. Matches the three known selected-runtime differences: `package.json`, `dist/src/pi-extension.js`, and `dist/src/user-config.js`.
4. Verifies the recursive JavaScript file set exactly, so an extra or missing runtime JavaScript file refuses.
5. Keeps the accepted M03/M04 admission modules and limits unchanged. M03 and M04 Git hashes are identical for `worker-runtime-legacy-gate.js`, `worker-runtime-namespace.js`, `worker-runtime-systemd.js`, and `worker-runtime-limits.js`.
6. Expands bounded double process quiescence from only `compaction-worker-entry` to compaction, history, catalog, bootstrap, and bridge entry-point basenames.
7. Keeps all four fixed systemd unit checks before mutation and repeats them during and after synthetic installation.
8. Refuses every `PI_CHRONO_*` and temporary-directory environment override.
9. Is fresh-bootstrap only. Either occupied namespace, a partial namespace, or foreign state refuses. It is not a post-install health command.
10. Preserves failure state. It does not delete namespaces, remove ownership records, remove a gate, stop units, signal processes, migrate state, or relax policy.
11. Makes production apply impossible: `--apply` without an approved private synthetic root returns `production-apply-disabled`. The allowed synthetic root must be one immediate owner-only `recovery-test-*` child of this candidate's `synthetic-runs/` directory.

See `helper-diff-vs-original.patch` for the exact source diff.

## Current-boot identity API

The helper and corrected synthetic harness use the accepted M04 export `verifyLegacyAdmissionGate(runtimeDirectory, legacyDirectory)` from `dist/src/worker-runtime-legacy-gate.js`. At accepted source `src/worker-runtime-legacy-gate.ts`, lines 23–36, `readManifest` reads the live `/proc/sys/kernel/random/boot_id`, requires the stored manifest boot ID to match, requires its PID 1 start identity to equal `linuxProcessStartIdentity(1)`, checks the exact legacy namespace digest, then `verifyLegacyAdmissionGate` verifies all four inhibitor owner records. The corrected harness explicitly calls that exported API after synthetic installation and requires `true`.

This is a current-boot check only. It does not prove a later boot, production namespace freshness, process quiescence, or authorization. It must run again in any separately authorized production procedure.

## Synthetic verification

Corrected harness run started at `2026-09-09T03:57:00-07:00` after syntax validation:

```text
node --check boot-recovery-m04.mjs                   PASS
bash -n synthetic-checks.sh                         PASS
synthetic-checks.sh                                 PASS (11 checks, 1620 ms)
current-boot identity API                            PASS (explicit accepted export call)
Git-derived profile comparison                      PASS (96/96, 0 mismatch)
installed accepted-package comparison               PASS (96/96, 0 mismatch)
```

Latest unique receipt:

`receipts/synthetic-check-20260909T105702Z-3LuuzF2W.json`

The checks covered:

- production apply disabled;
- hidden override refusal;
- accepted-package mismatch refusal;
- partial/occupied namespace refusal;
- foreign byte preservation;
- fresh check with no write;
- synthetic apply through the accepted M04 gate, namespace, limits, and systemd APIs;
- explicit current-boot identity verification through the accepted gate export;
- exact canonical policy and four inhibitor artifacts;
- all four units inactive and bounded double relevant-worker scans;
- fresh-only refusal after installation;
- no policy relaxation, force-stop API, process signal, gate removal, or helper cleanup path.

The corrected harness allocates every invocation and case root atomically with `mktemp -d` as a new immediate child of `synthetic-runs/`; it never reclaims a fixed or pre-existing name. It has no exit cleanup trap. On any failure, it preserves the exact invocation root, log, and case roots for inspection. Only after every check passes—and after the helper has rechecked all four synthetic units inactive—does it remove the four paths created exclusively by that invocation. It never resolves or writes the production default namespaces.

A successful run creates a new `mktemp` receipt under `receipts/` and never overwrites the preserved initial receipt or a prior unique receipt.

## Failure and reversal behavior

This candidate cannot change production, so its current production reversal is no action. A failed synthetic apply leaves its reserved state for inspection; the helper does not clean or overwrite it. The corrected test harness also leaves its invocation roots and log on failure. It removes only the exact collision-safe paths that its successful invocation created, and only after settlement.

A future production-capable procedure must continue to fail closed. If it creates only part of a new production namespace, it must leave that state intact and stop for a separately verified recovery decision. Existing admission state must never be deleted or rewritten to make a fresh check pass.

## Later authorization boundary

This preparation is not authorization to apply. A later production action needs all of the following as a separate decision:

1. independent acceptance of these frozen candidate files and hashes;
2. a separately changed and reviewed production-capable procedure (this helper has no enable flag);
3. fresh same-boot checks of both default namespaces, all four units, relevant worker processes, package identity, configuration projection, and exact limits;
4. explicit authorization for the production apply scope;
5. a coordinated settings/process window and confirmed settled jobs if that later procedure requires them.

The currently released COMMAND8 window grants none of those actions. Do not modify this candidate in place to bypass `production-apply-disabled`; create a separately identified reviewed procedure after authorization.

## Limitations

- The synthetic check proves the accepted APIs and byte closure in a private namespace. It does not prove that production namespaces are fresh or that a future production window is safe.
- It does not start a real worker job or alter current worker policy.
- It does not validate existing-session reload state.
- systemd state and process quiescence are boot-bound and must be checked again immediately before any separately authorized production action.
