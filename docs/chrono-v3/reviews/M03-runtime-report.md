# M03 transactional-runtime report

## Milestone identity

- Branch: `work/chrono-v3-m03-runtime`
- Base and M02 merge commit: `ea977dbb09ccea5265a435ce831303282622f97a`
- Pull request: #35, draft into `rebuild/chrono-memory-v3`
- Current release candidate: ChronoCompact `2.0.3`

M03 is in progress. This report records each independently gated runtime slice; it does not claim milestone acceptance, authorize a merge to `main`, or start M04.

## 2.0.3 memory-admission slice

The first M03 slice corrects the accepted M02 accounting limitation. Legacy whole-file loading now reserves capacity before reading or parsing. Search work reserves one conservative envelope before loading, transitions it through pending-load and pending-build states, and retains explicit live-index, query-result, and retained-reference charges. One current index generation is retained per session under the existing 128 MiB cache ceiling. Complete load-and-build work coalesces for an identical source generation, and active users pin retained accounting until their work finishes. Admission failure returns a controlled bounded refusal rather than loading rejected work.

The local admission ceiling is 512 MiB. Legacy sources retain the 64 MiB source guard and use an eight-times pre-load charge. Indexed sources retain the 16 MiB source guard and use a measured conservative 32-times envelope with an 8 MiB minimum. This is a safety slice, not the final M03 child-containment design; later M03 work must move work whose expansion cannot be safely admitted into bounded worker isolation and must not transfer complete indexes back into Pi.

The fixed-heap characterization now has a meaningful pass condition. It first reproduces the old omission, then requires the declared envelope to cover measured retained heap. In both the 512 MiB and 1 GiB lanes, the synthetic workload used `1,093,409` source bytes, retained approximately `24,734,000` bytes, reported the old estimate as `6,626,032` bytes, and reserved `34,989,088` bytes. The observed admission headroom was approximately `1.414`.

## Concurrent admission correction

A pre-activation regression used 24 independent synthetic session sources with simultaneous index builds. It reproduced `201,326,592` retained charge bytes against the `134,217,728` cache ceiling: pending builds were admitted before completed-cache accounting advanced. The correction reserves the aggregate index budget before loading and keeps the reservation through pending work, publication, and eviction while an active caller still holds references. Successful completion or a controlled `history-index-memory-limit` refusal is required. The regression now passes, as do the full normal and fixed-heap suites. No candidate was deployed before this correction.

A fresh read-only review also reproduced growth between the caller's admission stat and the reader's open. Both legacy and indexed callers now pass the admitted identity, size, and modification time to the bounded reader, which compares the opened handle before allocating or reading. A caller-level regression covers growth and same-size replacement in both paths and requires zero content reads and complete pending-reservation cleanup. The full normal and 512/1024 MiB fixed-heap suites passed after correction.

## Historical memory-slice validation (before later integration)

The results and hashes below describe the memory slice at `8a052cb44323b312ee0d4f4032ed19080c042f2b`, not the subsequent history/runtime integration. They must not be used as deployment evidence for a later head.

- Complete serialized package suite: 335/335.
- Unified normal suite and deterministic small/medium report: passed.
- Fixed-heap 512 MiB and 1 GiB lanes: passed; OOM remains non-passing.
- Package typecheck, generated distribution, and deployment manifest: passed.
- Complete repository-root verifier: 17/17 manifests, 262/262 deployed hashes, 66/66 ChronoCompact build files, 15/15 safe scripts, 17/17 package dry runs, and zero unexplained dependency-graph files.

Candidate repository identities before the source commit is created:

- Source tree: `1f2a2fed0269e9f5ab85975d3dfd9cdb53a01ad3dc58c210bed3664d01899295` (67 files).
- Dist tree: `cc41a9cf5686a82cf5675e7d11829d27930615c14256072adcdc642322aeb108` (66 files).
- Entrypoint: `01ab9e4c562ff84f3dacce0fa513b5be85ca1c51b6b38b604118d7336bf43986`.
- Package metadata: `b5367bea62b54492669157e7ee7fb74c99f450cf3c7478ad713425e80c236a7a`.
- Lock metadata: `3edda0714e750097ae37d9185fddb6fd1c87e48beeffd3b951f0760575949e73`.

The exact pushed source commit, CI runs, backup identity, deployed hashes, activation method, and fresh-process canaries will be added only after those gates complete. Live ChronoCompact remains `2.0.2` from `0c7173ff03ed010747ab9b5d7be6f8f84d423819` until then. The verified M02 rollback remains ready.

## Local history integration (not deployed)

Local integration head `18714b50c8c8eddb5d2d51ea61627db3fd5b8113` removes whole-session history parsing and complete indexes from Pi. Persisted history operations dispatch bounded scalar requests to a child; verified source-ledger exact reads retain their direct bounded path. Unpersisted sources refuse with `history-source-unpersisted` before graph access or serialization.

The history contract declares a 128 MiB child memory limit, 80 MiB heap, 64 KiB request, 256 KiB response, 50 KiB returned text, and 30-second waiter deadline. These are contract limits awaiting integrated OS-runtime verification, not a completed containment claim. Pi reserves the child and result envelopes before dispatch and retains only bounded feedback. Existing persisted semantic tests use an explicitly named in-process synthetic adapter; they prove behavior, not OS isolation.

Independent read-only review found a handled partial-promotion failure: the first sidecar update committed, then a later size refusal omitted its receipt. Correction `5484459946969c28477a52d75695c6e9c3335b85` (integrated as `18714b5`) returns up to three strictly validated commit receipts on handled refusal. Pi mirrors them once without retry. A pre-write guard under the existing lock prevents an unreturnable receipt from committing. The exact 261,494-byte sidecar regression and two validation regressions passed (3/3); focused independent confirmation reproduced no remaining blocker. The earlier commit-to-IPC crash window remains a documented limitation; this correction does not add an M04 transaction framework.

The independent-client harness passed 36 replay jobs: six forked client processes, three repetitions, and slot configurations one and two. This run used the earlier pre-kernel distribution and validates the harness only. Integrated kernel-runtime stress, equality, complete package tests, fixed-heap tests, build identities, and deployment canaries remain required.

The worktree/index-only privacy scan passed with zero findings. The complete all-ref publication gate remains blocked by an unrelated historical privacy finding. No bypass, history rewrite, further push, or deployment is authorized by a local-only pass. Live version remains 2.0.2; no M03 fix is yet usable through the live package.

## Integrated runtime (local only)

Runtime source `565bd0a079697205192149e9c340458f05f1bf34` was integrated as `253fe84`. Integration correction `d9702df` accepts validated history JSON-string progress frames, preserves allowlisted runtime refusal codes, and routes synthetic extension jobs through an explicit isolated namespace. Production still requires a verified legacy admission gate.

Fixed systemd service identities hold host slots through whole-process-tree termination. Queue metadata is advisory; `flock` serializes queue changes. The fixed host memory budget is 2 GiB, with no swap, at most 64 tasks per job, and a per-job controller memory cap. A namespace pins its first slot policy; conflicting settings refuse rather than create another pool. Bounded queues use replay priority, five-second aging, and session turns. Unix sockets coalesce equivalent jobs across processes without result-payload files; waiter deadlines and cancellation remain independent.

Memory, hard deadline, task count, and process cleanup are controller-enforced for descendants. Logical source-read admission covers trusted Node filesystem APIs, including asynchronous file handles; it is not a sandbox against native code or descendants deliberately bypassing those wrappers. The production replay/history workers do not spawn source readers. Only controller-confirmed OOM is classified as `worker-resource-limit`; unexplained SIGKILL remains `worker-crashed`.

The single integrated package run passed 369/370 tests. Its sole failure was a shadow extension fixture still using the production admission gate. Routing that fixture to its synthetic namespace corrected it; the focused rerun passed. A contained history-search smoke also passed with zero retained dispatch admission. Typecheck and build passed; the candidate distribution contains 83 JavaScript files. No full-suite rerun or additional test matrix was added after the test-only correction.

The integrated run includes six independent clients, two repeated jobs, and slot configurations one, two, and four, measured through actual cgroup identities and execution intervals. Duplicate replay identity, independent waiter cancellation/deadlines, allocation pressure, unexplained SIGKILL, detached descendants, controlling-client death/restart, source-read admission, heap limits, fairness, PID reuse, and frozen 2.0.2 transition fixtures passed. This is local synthetic evidence, not deployed-canary evidence. No real reboot or user-manager restart was performed.

CPU/RAM checks accompanied these runs. Test launchers exited; no confirmed task-owned leftovers required termination. Raw process data is not committed. Code review is reserved strictly to the user; no further agent review is planned.

## Activation and rollback procedure

`installLegacyAdmissionGate` must first reserve all four old slots without stealing live ownership, then receive positive proof that old worker process trees are stopped. Empty slot files alone are insufficient. Boot-bound PID1 inhibitors prevent future 2.0.2 admissions; they are compatibility guards, not the new semaphore. Do not start the new live pool without the completed gate.

`removeLegacyAdmissionGate` serializes against new starts, disables new admission, stops all new units, and only then removes exact-owned inhibitors. Replaced or malformed gate state fails closed. Reboot recovery and pinned-policy reconfiguration require explicit drain/recovery, not silent pool recreation. No live gate has been installed. A fresh verified 2.0.2 backup and exact green-CI detached build remain mandatory before activation.

## Remaining gates

All-ref privacy and dependent root/CI/publication gates remain blocked. A bounded root-verifier attempt reached its all-ref scan and timed out; its tracked process tree exited. This is not a passing result and did not bypass the scanner. Final fixed-heap/build-manifest gates, exact-head CI, guarded activation, and fresh-process live canaries remain outstanding. The M03 pull request stays draft and unmerged; M04 is not authorized.


## Approved privacy remediation

The all-ref gate found one private absolute checkout path in line 14 of
`M00-BASELINE-CHECKPOINT.md` at the tip of the unrelated
`work/grounded-ssh-r1-m00-baseline` branch. A follow-up commit would not remove
that finding from scanned history. The user explicitly approved replacing this
one tip commit using an exact `force-with-lease` guard.

An owner-only recovery bundle was created and verified outside the repository.
The path was replaced with `<repository-checkout>`; every other file and the
parent commit were preserved. The remote update succeeded only against the
approved old tip:

- Old tip: `ef5c91c0d3090c473fd5b43a80e9af5034c4ddfe`
- Redacted tip: `35bbbb2fc747ec46bc8a8e79e4dff30badb352c8`

The replacement commit scan passed. The subsequent complete local scan passed
with zero findings across 211 commits, 104,598 path contexts, 2,016 unique blobs,
and the index/worktree. This supersedes the privacy blocker described above.
The scanner was not changed or bypassed. No M03 history, other branch, repository
visibility, live package, or private session was changed by the remediation.
GitHub caches and existing clones may retain the old commit; this is not a claim
of global erasure. The scan process exited, with no tracked child left running.
Remaining root, CI, and deployment gates still require completion.
