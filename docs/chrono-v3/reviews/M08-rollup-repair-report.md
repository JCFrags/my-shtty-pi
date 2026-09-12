# M08 bounded rollup repair report

## Candidate

This source-only candidate starts at `b0e98fb3aeaeb64699bcd00ea68e4a2438553d4f`. It adds a separate versioned repair store and an atomic active-route record. It does not change package metadata, generated output, shared settings, installed code, live stores, or active campaigns.

The public worker contract and `/chrono-rollup-repair` command expose one finite `start`, `step`, `status`, or `publish` transition. The history adapter resolves the requested persisted leaf and submits that transition through existing worker admission. Callers must explicitly repeat `step`.

The implementation preserves storeless legacy handles. Replacement handles contain `storeId`. New replacement databases add the bounded publication index `(lineage,eventCut DESC,generation DESC)` and use the matching status order. Existing databases are not migrated and keep exact-head status behavior.

## Focused verification

Two local checks ran after implementation:

1. Package typecheck passed with `tsc -p tsconfig.json --noEmit`.
2. The existing persisted metadata/rollup fixture passed as one selected test. Its added repair lifecycle exercised a partial step, start retry without reset, status resume, incomplete publish refusal, completion through explicit bounded steps, corrupt-target publish refusal, atomic publication, active-route status, old storeless-handle recovery, and unchanged source bytes.

The focused test result was one pass, zero failures, in approximately 9.1 seconds. No broad suite, campaign, package build, push, deployment, or live-store operation ran.

Exact-head CI run `34584977436` passed 671 of 672 Chrono tests. The only failure was the normal extension-hook fixture's exact command-registration array, which omitted the implemented `chrono-rollup-repair` command. The correction adds that command in its actual registration order and preserves the full-array equality and deterministic replay assertions. Run this fixture from the package directory because its synthetic fixture path is package-relative. An initial repository-root invocation stopped before the fixture with `ENOENT`; the corrected package-directory invocation ran the one selected fixture and passed. No broad suite was repeated.

## Limits

This is synthetic persisted-fixture evidence, not live repair evidence. Routine continuous integration, integration review, packaging, deployment, and any live repair remain parent-controlled. Failed targets are preserved and no cleanup command is provided. The active pointer supports compare-and-swap publication, but this candidate does not expose a general rollback command.

## Installed-command qualification on 2.0.34

A real offline Pi 0.85.1 process loaded the accepted 2.0.34 package from main `3d5c77d33804df4934985ba47dcb8d151a5792f8`. Node was 24.18.0. The check used production host-wide one-slot admission and a private synthetic source, not a separate capacity pool. It made no provider calls or shared configuration changes.

The first harness incorrectly compared Pi's 23 non-header entries with catalog cut 24. The runtime reached exact catalog, index, memory, and rollup cut 24 with zero lag in 62,399 ms. The harness stopped without running a repair. Its child was terminated with an identity-verified SIGTERM and exited 143. That failure remains preserved.

One separately identified correction bound the cut to the validated physical JSONL record count, including the header and normal adoption entry. It also reduced cached status polling to once per second. The original 300-second deadline, 32-step ceiling, runtime, worker limits, and source checks remained unchanged.

The corrected check passed in 133,305 ms with nine repair steps and 2,394,370 retained bytes. The source contained 21 meaningful events and one 10,617-byte tool result. Actual command results, rather than RPC prompt acknowledgments alone, proved:

- `/chrono-rollup-repair start`, `step`, and `status` created a resumable replacement.
- A normal `/q-quit` of the test bridge and a second Pi process resumed the same repair.
- Eight more steps completed replacement generation 9. `publish` bound it to event cut 24 and state generation 20.
- `history_recall` still read the old generation-20 handle after replacement publication. The active root returned replacement generation 9.
- The retained handle recovered the original restriction entry.
- Actual registered `history_get` recovered the tool-result entry in two exact raw pages of 8,192 and 2,818 bytes. All 11,010 raw bytes matched the source, with SHA-256 `d08269a6708b0c6334cc040693e3131c1b2cca44d4808735a596d9c3a7eaecd4`.

Both Pi processes exited 0 through the test bridge's shutdown command, without signals or extension errors. The original source prefix stayed unchanged. Normal startup appended one 286-byte logical-adoption entry. No source bytes changed after that adoption. Measured repair-worker peak RSS was 70,479,872 bytes. The observed worker cgroup peak was 66,871,296 bytes. These are distinct observations, not synchronized measurements.

The optional preview compared deterministic replay and a canned common summary at the same prefix cut 20, not repair cut 24. Restriction, open-work, blocker, safe-tail, and token-ceiling checks passed. All 11 selected rows came from memory: one restriction, two open-work rows, six recent episodes, and two older episodes. No rollup row was selected. This preview does not establish replay-versus-rollup composition, older-rollup chronology, a real Pi model summary, the normal compaction hook, or model continuation quality.

Corrected harness SHA-256: `f70f9fad9403f845a54937360a01e45b9ae9148eb6f24939121994a06635cf8b`. Receipt SHA-256: `4c2daed4914f50ddccc7dbc1a0e89f74ab18881475f3f02e505d9d9a823cd166`. The unchanged bridge hash is `838849d34a65072e0afbf9b1e940f5916ecbecbb68570d62453cf6e7ff303e7f`.

This completes the focused installed repair-command, restart, retained-handle, and exact raw-recovery checks. It does not complete M08 or M09 by itself. The parent verified the retained hashes, source hash, and child settlement, then closed the completed QA agent. Private source paths and raw logs remain local.
