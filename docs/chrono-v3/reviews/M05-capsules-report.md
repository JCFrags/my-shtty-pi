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

## Contract and runtime scaffolding checks

The parent verified the contract corrections with typecheck, build, and ten
focused tests. Structural metadata now requires a caller-verified raw reference
for each supplied field. A decoded body reference cannot establish metadata
outside that body. Supported outcomes require structural facts; quoted phrases
are not outcome evidence. These validators check structure, not raw-byte truth
or pinned-view authorization.

The bounded worker client and default-off shadow scheduler passed five focused
tests after build. These cover request refusal before admission, wire limits,
independent readiness, deferred scheduling, caller settlement before replacement,
and sanitized failure without automatic retry. They do not establish real worker
execution. A settled derive pass does not mean capsules or chunks are ready.

## Initial independent reducer findings

Independent read-only review of reducer candidate
`1ad3c1e19ffaa10de3e2e087dd54b225b9eefd28` reproduced four defects despite
14 passing pre-existing focused tests:

- Negated or quoted “pending approval” produced a supported pending outcome.
- Splitting a URL across legal feeds retained a prefix cue and changed output.
- An internal text cap dropped content without a structured omission.
- Structural metadata cited the decoded body instead of supporting raw bytes.

The raw-fact contract and reducer corrections were integrated with focused
regression tests. Parent verification then reproduced a remaining exact-boundary
failure: splitting `pending approval tail` at unit 16 lost the cue. A separate
settled scan offset corrected it. Exhaustive split positions, serialized restarts,
one-unit feeds, and cue overflow checks were added. The overflow test initially
failed because complete head coverage had no omission record; that was corrected
without weakening the test or deadline. Original failures remain evidence.

The integrated build and typecheck passed, followed by 54 focused capsule tests.
One uses real M03-contained workers in an isolated synthetic scheduler namespace:
derive, status, capsule page, and exact UTF-16 chunk retrieval passed with a
256 MiB observed cgroup limit and bounded worker RSS/cgroup peak. Its tickets and
slots settled to zero and its unit became inactive. Setup itself is not a claim
of parent-process OS containment. An initial assertion incorrectly expected all
capsule descriptors ready; M04 emits a bodyless block descriptor as well as its
text-body descriptor. The corrected assertion requires one ready body and one
unsupported descriptor, rather than weakening readiness or fabricating a body.

The worker entry and contained shadow bridge are implemented. Production/Pi
activation is still absent; callers supply an explicit durable physical identity
and both catalog/derived routes. Storage has no automatic identity discovery.
The normal suite at this integration point passed 593/593 tests. This does not
supersede review findings or establish acceptance of later changes.

## Synthetic extension status and retained review findings

The extension now accepts an explicitly injected synthetic prepared target only
with an explicit isolated scheduler directory. No production setting or automatic
UUID discovery was added. Session start and settled events schedule deferred
contained work; switch, fork, and shutdown cancel it. `/chrono-capsules-status`
reports cached progress and independent readiness without storage reads. Normal
extension loading remains disabled for capsule work. The caller must retain the
physical identity and supply an actual pinned M04 view.

Build/typecheck and 13 focused extension tests passed, including a real synthetic
capsule pass, cached status, and zero model mutations. An initial command-list
assertion failed because it lacked the new status command; the explicit expected
list was updated. The original failure is retained.

Independent storage review reproduced three defects despite 17 passing focused
tests: global artifact pagination let sibling rows poison fork/old-pin pages;
check-then-rename could replace a raced destination; and status recreated a
missing publication lock. The correction adds an indexed lineage selection before
the page limit, an existing-only validated read lock, and syscall-only
`renameat2(RENAME_NOREPLACE)` publication. The latter requires the installed
Python 3 standard library and libc capability described in ADR-003; it has no
ordinary-rename, copy, or hard-link fallback. Independent re-review passed all
three corrections and 15 focused compiled tests. It also reproduced a versioning
regression: the new ancestry table still used the predecessor's declared derived
schema 1. A separate physical-schema version correction is required; existing
stores must not be migrated, relabeled, or deleted.

Independent adapter review found that a `NaN` aggregate budget bypassed numeric
comparisons. The corrected public binding factory rejects any supplied budget
that is not a positive safe integer before selecting or invoking an executor.
Regression tests cover `NaN`, both infinities, zero, negative, and fractional
values with exactly zero executor calls. The six focused adapter tests passed.

The integrated correction build and typecheck passed, followed by 63 capsule
tests under a 128 MiB V8 heap. A three-record, 1 MiB synthetic campaign then
passed 43 contained calls in 20.951 seconds, including fork capsule ancestry and
old-pin stability after sibling publication. Tickets and slots settled to zero
and the worker unit became inactive. An initial campaign assertion confused the
capsule `(eventSeq, descriptor)` cursor with the catalog's event-only cursor;
the corrected request explicitly excludes all descriptors at the previous event.
The failed assertion is retained. This small run did not contain its parent in
an OS memory unit. Larger frozen-code campaigns and final schema verification
remain pending. No deployment or self-acceptance is claimed.

## Remaining evidence

Versioned reducer/publication contracts, implementation, fidelity and exact
roundtrips, bounded append/noop/late-range measurements, native and real
subprocess failure tests, independent review, full resource lanes, reproducible
manifests, privacy/root checks, and exact final-head CI remain pending. Initial
M04 compatibility checks are recorded separately from future M05 acceptance.
