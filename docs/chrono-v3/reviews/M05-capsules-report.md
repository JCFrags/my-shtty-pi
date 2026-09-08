# M05 — Capsules and decoded chunks

**Status: implementation in progress; not accepted, deployed, or ready for review.**

## Entry boundary

M04 was accepted at `a13669b4a8a5afdf758cdfd357d01d9a68b5e5e7`.
Metadata-only acceptance closeout `d2a00bf16d770071edf14347cbd0f44b4fffb3ec`
passed local frozen/static/privacy verification and exact-head push
[34235976242](https://github.com/JCFrags/my-shtty-pi/actions/runs/34235976242)
and PR [34235980568](https://github.com/JCFrags/my-shtty-pi/actions/runs/34235980568)
CI, attempt 1, eight passing jobs each. PR #36 was marked ready and merged only
into `rebuild/chrono-memory-v3` at `49b63c88380ce02e335bf7142d49140242b4bb5c`.
M05's dedicated `work/chrono-v3-m05-capsules` branch starts at that merge.

This work does not deploy the acceptance metadata or M05. Installed private 2.0.5
remains at `dcd91924dbcfc0c02489e04c3e163b33e2b08e86`: catalog shadow globally
OFF, isolated workers ON. No settings, aliases, admission policy, or production
sources are changed. The reconciled Chrono-only 2.0.4 rollback is verified, not
exercised. The separate read-only post-reboot check found missing boot-bound
admission state; historical execution evidence is not current-boot worker proof.
No recovery is authorized or performed by this implementation work.

M05 must return as a draft, unmerged PR for project-lead code/storage review.
No model-facing authority, ordinary history/summary behavior change, M06, broad
ingestion, or activation is included. The master charter remains byte-frozen.

## Permission fixture correction

`test/catalog-sqlite.test.ts` now explicitly applies `chmodSync(path, 0o644)`
and asserts the observed 0644 mode before testing unsafe-file refusal. File
creation mode alone is filtered by the caller's umask and did not establish
the intended unsafe fixture under 077. Runtime safety checks are unchanged.

After building and probing the pinned native dependency, the seven SQLite tests
passed under each of explicit umask 077 and 022, including the native allocation
refusal and actual subprocess crash test. This is focused fixture evidence, not
M05 storage acceptance. Development dependencies were copied from the verified
M04 worktree; this is not a claim of a fresh clean installation gate.

## Initial compatibility and decoder evidence

The initial M05 worktree passed typecheck and all 535 existing tests, followed
by the normal small/medium deterministic replay harness. These checks preceded
capsule/storage implementation and do not establish M05 acceptance.

The shared `src/json-string-decoder.ts` extracts the existing M04 byte decoder
without changing parser checkpoint version 1 or its six decoder state fields.
It emits UTF-16 code units to a sink and retains no decoded output. The parent
reviewed the extraction and ran all 17 parser/decoder tests after integration;
all passed. The integrated worktree then passed typecheck and all 539 tests.
The parent also repeated an exact baseline/extracted serialized checkpoint
comparison at every byte across five synthetic fixtures, totaling 537 steps;
valid escaped Unicode/CRLF/nested data and malformed input matched. The worker
separately reported a matching comparison across 230 fixture steps.

A generated 33,554,434-byte escaped Unicode string decoded to 8,388,608 UTF-16
units in a subprocess with a 32 MiB V8 heap. Its largest serialized decoder
state was 170 bytes, with a reusable 65,536-byte source buffer. The pinned hash
was `07d02bc92e8618c10de61fd6157807852c57d5f281a3f2ed6090773a90669bb8`.
This demonstrates bounded decoder state and V8-heap execution, not hard OS
memory enforcement or a completed chunk storage pipeline.

The worker retained one diagnosed test failure: an initial assertion expected
inactive historical accumulator fields to be cleared. M04 retains those fields;
the new test was corrected to require only pending-state fields to clear. Parser
semantics were not changed to satisfy that assertion.

## Remaining evidence

Versioned reducer/publication contracts, implementation, fidelity and exact
roundtrips, bounded append/noop/late-range measurements, native and real
subprocess failure tests, independent review, full resource lanes, reproducible
manifests, privacy/root checks, and exact final-head CI remain pending. Initial
M04 compatibility checks are recorded separately from future M05 acceptance.
