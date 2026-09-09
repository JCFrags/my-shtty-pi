# Accepted-M04 recovery procedure: review delivery

**Review only. Production apply is disabled. No recovery run or production write
window is authorized by this delivery.** These text files transfer the existing
preparation for directing-assistant inspection. Receipt is not approval;
COMMAND 8 retains its final release-acceptance decision.

## Target and evidence

Accepted target: `dcd91924dbcfc0c02489e04c3e163b33e2b08e86`, package
`pi-chrono-compact` **2.0.5**, package tree
`5c70e9c1826fe88c0da9f9e4f51b41aa62b2240c`.
The profile contains all **96 Git-derived pins**: package.json and 95 recursive
runtime JavaScript files. All 96 published pins were compared with the accepted
Git blobs during transfer; no pin was changed or generated from installed bytes.

The separate approved M05 code/storage candidate remains frozen at
`6a624dd5b6fd64365a3820b6e71c1f0242a35025`, draft PR #38. These recovery materials
target accepted M04, not M05. Neither PR is authorized to merge or deploy.

## Read these files

- [Complete helper](boot-recovery-m04.mjs): byte-identical tested source, including
  its original profile-hash check and disabled production-apply boundary.
- [96-file profile](recovery-profile.json): **path-redacted review copy**; all pins,
  limits, projection keys/hash and accepted identities are unchanged.
- [Original helper diff](helper-diff-vs-original.patch): byte-identical complete
  prepared unified diff against the original M03-pinned helper, with context.
- [Preparation README](preparation-README.md): **path-redacted historical copy**,
  including preconditions, tests, refusal behavior and limitations.
- [Synthetic harness](synthetic-checks.sh): **path-redacted review copy**, not an
  invocation instruction. No harness logic was removed or rewritten.
- [Initial 10-check result](synthetic-check-results.json) and
  [final 11-check result](receipts/synthetic-check-20260909T105702Z-3LuuzF2W.json):
  unchanged existing sanitized receipts. The latter includes the explicit
  accepted current-boot gate-verifier check. No recovery tests were rerun for
  this publication; these receipts do not describe new production readiness.
- [Publication provenance](publication-provenance.json): original and published
  SHA-256 for every transferred file, exact byte-identity flags and redaction
  categories.
- [Published checksums](SHA256SUMS): current review files, excluding this manifest
  itself. [Original checksums](ORIGINAL-SHA256SUMS) remain unchanged historical
  evidence and refer to the original filenames/bytes, not renamed/redacted copies.

## Redaction and trust boundary

Only private configuration, preparation-directory and local Git-checkout paths
were replaced with explicit `REDACTED_*` markers. No credentials, real session
content, configuration values/copies, rollback copies or raw diagnostics are
included. The original ZIP and all original files remain unchanged privately.
Original bundle SHA-256:
`1de7b0563c3e73f743867a4814ac4f49b66aa685746f26d9235789020f5473ca`.

**The redacted profile is not byte-identical to the tested profile.** The helper
retains its original `PROFILE_HASH` of
`2c0b48e15d817a6d1333eaa4855cbb8cd41a32d3ba0c6be41479e6e6022507b9`.
It therefore refuses this review profile rather than silently trusting a
replacement. Do not repin the helper, substitute real paths, or enable apply to
make these review copies runnable. Files are ordinary documentation inputs,
not installed packages or an executable recovery release. Git checkout modes
do not reproduce the original owner-only runtime permissions.

All essential helper logic and pins are visible. The withheld path values mean
this public copy cannot independently replay the private filesystem placement;
the historical receipts apply to the original hashes in the provenance record.

## Preconditions and refusal behavior

The helper requires a non-root Linux user; canonical owner-controlled paths;
exact accepted package identity, recursive file set and hashes; the unchanged
configuration projection and bounded limits; both namespaces absent; four fixed
units inactive; and two bounded scans establishing relevant-worker quiescence.
It refuses hidden Chrono/temp-directory overrides, changed hashes/configuration,
partial, occupied or foreign namespaces, and unsafe ownership or permissions.

`--apply` without the profile's restricted private synthetic root refuses with
`production-apply-disabled`. The allowed root must be one fresh owner-only
immediate `recovery-test-*` child of the pinned synthetic base. Synthetic apply
reserves absent namespaces exclusively, rechecks identity/quiescence, writes
only the canonical policy and accepted gate, and verifies current-boot identity.
The helper never stops processes, removes ownership, cleans failed state,
migrates namespaces or relaxes admission policy. Failed partial state remains
for inspection. The historical harness cleans only its successful owned fixtures.

Production apply needs a separately identified and reviewed production-capable
procedure, fresh checks, explicit authorization and any required coordinated
window. This helper has no production-enable flag. The write window remains
released; accepted M04, verified 2.0.4 rollback, settings and admissions are not
changed by this delivery.

## Accepted inventory repair and recovery

The owner authorized exactly the eleven review-file inventory additions. PR41
head `a1c867054438639e7675e632387d38d26acc3e3b` passed all eight checks on both
push 34393031775 and PR 34393037538. Root checks took 22m47s and 22m46s.
PR41 merged only into integration at
`853f45eb72e3bff2dc791b39c17168655391505e`. The original inventory failures
remain historical evidence; scanners and their protections were not relaxed.

The original preparation files above remain unchanged and production-disabled.
The owner separately authorized a mechanical production derivative. Its
[review diff](production-derivative-diff.patch) and
[checksum relationship](production-checksum-relationship.json) identify the
exact original and tested derivative. Only authorization arguments, scope labels,
and corresponding helper/profile identity changed. All 96 accepted pins,
configuration projection, limits, validation and gate logic were preserved.
The two private synthetic-base paths in the diff are redacted; this review patch
is not a runnable profile or byte-identical copy of the private exact diff.

One short promoted synthetic check passed. In a new exclusive COMMAND8 window,
immediate preflight found a genuinely fresh state and production apply reported
ready with the exact accepted M04 policy. One normal installed catalog ingestion
job succeeded and caught up. The post-job harness then failed because it imported
`legacySchedulerDirectory` from the wrong module. That failure was preserved;
only read-only settlement inspection was corrected, not the worker job repeated.
Settlement confirmed zero active, queued or malformed claims, no remaining
capacity claims, and the valid current-boot compatibility gate. The window was
explicitly released and COMMAND8 acknowledged release.

Installed selection remains accepted M04 2.0.5; settings, aliases and the verified
2.0.4 rollback were not changed. Original private assets and partial failure
evidence remain preserved. The installer can undo only inhibitors created by
its own failed installation; this is not a claim of no cleanup at all.
COMMAND8 retains its separate release-acceptance decision. Any future recovery
requires a new window and fresh checks; healthy state must not be recreated.

## Future review handoffs

Deliver necessary public-safe review files directly through a dedicated GitHub
draft PR, with commit-pinned links and verified remote checksums. Preserve
originals, label redactions and their checksum relationships, and exclude private
data. Do not require owner-relayed attachments when this authorized route fits.
