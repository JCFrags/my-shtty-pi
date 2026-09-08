# M05 — Capsules and decoded chunks

**Status: project-lead changes requested at `bda0cb60d4cc55b7f0c7df7f2e4b5e1c510ab429`. Corrections in progress; not accepted or deployed.**

## Project-lead correction scope

M04 remains accepted. The M05 project-lead review withheld code/storage approval
for F001–F004: overlapping edge selection and coverage, meaningful protected
source neighborhoods, partition-invariant recognition and versioning, and exact
chunk-to-source identity binding. The existing catalog, immutable-segment, and
contained-worker architecture remains required. PR #38 stays draft and unmerged.

The results below describe the previously reviewed candidate unless a correction
section states a later exact version and head. Local secondary review and passing
CI did not constitute project-lead acceptance. Corrections must first reproduce
the findings through final envelopes, persisted stores, and public worker routes.
No production recovery, deployment, broad ingestion, or M06 is authorized.

## Correction evidence in progress

The F004 red regression commit `2f333da` precedes fix `51697bd`.
Valid foreign chunks are rejected after binding the authorized source, artifact,
manifest, encoded descriptor, contiguous coordinates, and segment/payload hashes.
The parent independently passed 23 focused store, segment, and contained-worker
tests after build and typecheck. A fresh read-only review of the frozen fix found
no blocking defect. Same-view substitution has original failing worker evidence;
additional sibling-worker coverage was added with the pipeline follow-up.

The F001–F003 red regression commit `ffb5d41` precedes fix `bad4481`.
The parent passed 29 focused reducer and native-persistence tests after build and
typecheck. These include overlapping edge lengths around 4,096 and 8,192 units,
final coverage, protected neighborhoods, long failure grammar, partition changes,
and JSON checkpoint restarts. This is focused evidence, not a completed gate.

Pipeline red commit `2424fbc` precedes fix `dfe1a20`. The current derivation
identity is `capsule-pure-v2`. Old-identity completed and partial derives refuse
before catalog calls or store preparation; durable database, immutable-object,
and source bytes stay unchanged. Current identity cannot relabel an old physical
store. Old read-only pins retain their original identity. There is no physical
schema migration. The parent passed all 20 focused store, worker, and persistence
tests after integrating this follow-up.

The independent reducer review reproduced a remaining blocker: `exit code17a`
and `exit code17_` incorrectly became failure cues. Sixteen malformed tokens
could exhaust the cue cap and hide a later valid long failure clause. The
original reducer worker corrected the trailing word boundary in `ec81738`, after
red commit `3a04083` reproduced the failure in final envelopes and persisted
retrieval. Its 32 focused tests passed across whole, one-unit, and uneven restart
feeds. Integrated full validation remains pending. Tiny caller budgets below the omission-marker
length also safely refuse; this nonblocking limit is outside the default-budget
correction scope.

The read-only operating check at 2026-09-08T20:25:11Z matched all 96 installed
M04 manifest rows and the selected alias/settings. Isolated workers remain ON,
catalog shadow remains OFF, both admission namespaces are absent, and all four
fixed units are inactive. A helper refusal was retained: the caller supplied the
M04 package to a helper intentionally pinned to M03. Independent byte checks
confirmed M04; no helper, package, configuration, or admission repair was made.
Configured policy is not current-boot executable admission evidence.

All earlier large campaigns below are historical, not corrected-pipeline scale
evidence. Full integrated gates and exact-head CI are still pending.

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
schema 1. The separate correction sets only the derived physical schema to 2.
A regression verifies fresh version 2 operation and refusal of version 1 requests
and stores without changing database bytes. No migration, relabeling, or deletion
is implemented.

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
an OS memory unit. No deployment or self-acceptance is claimed.

## Bounded synthetic scale campaigns

Two campaigns passed on frozen `4e319fe` runtime/script behavior, before the
derived-schema discriminator changed from 1 to 2. They retain the original
30-minute campaign limit and 30-second per-worker limit.

| Input | Calls | Wall time | Parent cgroup peak / limit | Largest worker cgroup peak / limit |
| --- | ---: | ---: | ---: | ---: |
| 2 records, 136 MiB body | 2,221 | 1,174.837 s | 212,119,552 / 268,435,456 B | 64,311,296 / 268,435,456 B |
| 2,048 records, 1 MiB body | 2,122 | 1,194.954 s | 50,659,328 / 268,435,456 B | 62,275,584 / 268,435,456 B |

Each parent and its streaming generator ran in an external 256 MiB systemd unit
with swap disabled; each sequential worker had a separate 256 MiB unit. Both
parent V8 heaps were 128 MiB. These are separate enforced limits, not a measured
single combined cgroup. The report correctly says the script does not contain
itself; the external launcher supplies parent containment.

The giant body contains 142,606,336 UTF-16 units in a 142,606,743-byte source.
Initial derivation took 2,182 jobs, reading at most 163,840 source bytes per job.
The 2,048-record run took 2,068 initial derive jobs with the same maximum. Both
verified first and late exact UTF-16LE chunk samples, including Unicode, lone
surrogates, and CRLF, and unchanged source hashes except one explicit append.
Exact chunk retrieval read zero authoritative source bytes. Fork capsule pages
matched M04 ancestry, and old-pin capsule hashes remained stable after sibling
publication. Tickets and slots reached zero, units became inactive, and each
owned synthetic namespace was removed after settlement.

Source counters are not total I/O: initial derive process-read counters were
5,104,020,271 and 5,019,194,338 characters respectively, including native SQLite,
startup, and measurement reads. Native allocation has a configured 64 MiB cap;
it was not separately measured. The combined append/noop/fork phase took 15 calls
for the giant case and 46 for the 2,048-record case, including bounded resumable
fork-prefix reuse. This is not a 50,000-record M05 claim or proof that complete
fork reconstruction takes constant total work. Capsule readiness remains honestly
unsupported where M04 emits bodyless descriptors; eligible text chunks are ready.

After the schema correction, a fresh version 2 smoke campaign passed 43 calls in
21.629 seconds with an externally enforced 256 MiB parent limit. Its first attempt
refused because the campaign script still supplied literal schema 1. The script
now imports schema constants and reports the derived version explicitly; the
original failure and its synthetic diagnostics are retained. The large campaigns
were not rerun under schema 2 and are not represented as final-head scale runs.

## Clean build and normal-suite evidence

A separate clean worktree at `fc0a08a` installed the pinned dependencies with
lifecycle scripts disabled, then performed the controlled native build. The
native probe verified SQLite 3.53.0, WAL/FULL, zero mmap, the 64 MiB hard heap cap,
and allocation refusal. Build and typecheck passed. Its 107 JavaScript outputs
byte-matched the integrated development build. The candidate manifest has 108
rows; it does not change the installed package or historical deployed inventory.

The clean normal suite passed 603/603 tests in 205.124 seconds, followed by the
unchanged small/medium deterministic replay harness. This includes the original
535-test baseline and added regressions, without skipped tests.

The unchanged selected fault/memory suite also passed at both 512 and 1,024 MiB
V8 limits, including small/medium replay and memory-accounting characterization.
Separately, all 64 capsule tests passed at each heap limit. These are selected
fixed-heap suites, not a claim that all 603 tests ran at each heap size.

## Real client settlement

Two additional isolation tests use the existing publication mutex as a barrier,
without new runtime hooks. Two actual clients receive the same coalesced response
with one admitted slot and no second ticket. Repeating a completed derive adds
no immutable segments, manifests, or receipts. The cancellation test observes an
admitted slot and an active owned systemd unit before aborting, then requires
`capsule-worker-aborted`, zero tickets/slots, and an inactive unit before cleanup.
The focused three-test isolation suite passed under a 128 MiB parent V8 limit.
An initial strict-TypeScript compile failure was corrected with explicit response
narrowing; no runtime behavior or deadline changed.

After integration at `f7b7ae2`, typecheck and the complete normal suite passed
605/605 tests in 207.898 seconds, followed by unchanged deterministic replay.
All 66 capsule tests then passed separately at both 512 and 1,024 MiB V8 limits.
No tests were skipped. These additions change tests only; the 107 compiled runtime
files and candidate manifest remain byte-identical to the clean build.

## Root verification and retained gate corrections

The full root gate passed at `79e9e26` within its unchanged 25-minute deadline:
303 current hashes, historical 291 plus 12 exact additions, 107 reproducible
compiled files, all five safe scripts, pack verification, all-ref privacy, frozen
M00 preservation, and zero unexplained artifacts. It performed a clean temporary
build, native checks, normal tests/replay, and the original fixed-heap lanes.
Prepared compatibility integration is recorded separately from the production
entrypoint graph. This is repository evidence, not installed-byte verification.

Independent review reproduced one defect in the new historical-manifest guard:
a missing unmapped path compared equal to an undefined authorization. Replacing
the historical package metadata row with an existing README row kept the same
counts and incorrectly passed the synthetic verifier. `78d47b0` requires explicit
map membership before exact hash equality. All 71 verifier tests passed after
integration, including valid authorization and same-count substitution rejection.
Only isolated test copies bypass the expensive publication scan; the real scanner
and publication gates remain unchanged. This correction changes no runtime bytes.

The earlier adaptation also incorrectly froze the two legitimately changed old
Chrono module hashes; exact named hashes now authorize only those two changes.
An initial clean-tree check refused untracked generated maps; all 107 maps were
preserved outside the worktree, not deleted. A caller then omitted the static-only
flag and obtained the expected draft-versus-installed identity mismatch. The
correct repository-only check passed cleanly without a dirty-tree exception or
production action. These invocation failures are retained, not counted as passes.

The ad-hoc all-ref privacy preflight exceeded its 180-second caller limit and
produced no completed result. The later planned standard root gate completed its
unchanged privacy scan successfully. No scanner policy, original root/CI deadline,
or safety assertion was weakened. Final static/publication checks and both
exact-head CI receipts belong with the draft PR handoff. Local results do not
accept M05 or authorize merge, deployment, boot recovery, or M06.
