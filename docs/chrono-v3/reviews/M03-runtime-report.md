# M03 transactional-runtime report

## Milestone identity

- Branch: `work/chrono-v3-m03-runtime`
- Base and M02 merge commit: `ea977dbb09ccea5265a435ce831303282622f97a`
- Pull request: #35, draft into `rebuild/chrono-memory-v3`
- Current corrective release candidate: ChronoCompact `2.0.4`

**M03 is accepted by the directing assistant at `afec7d3ac48ef369b27c6609347666af2f8c289b`.** The 2026-09-07 M03 closeout/M04 brief records project-lead acceptance and closes F001/F002. This local record transcribes that decision; it is not self-acceptance. M04 implementation is authorized after integration closeout; M05 and production catalog activation are not authorized.

## Accepted closeout

- Accepted review head: `afec7d3ac48ef369b27c6609347666af2f8c289b`. F001 failure-atomic admission and F002 locally bounded waiters are closed by project-lead review.
- Exact accepted-head CI: push **34143221402**, attempt **2**, and PR **34143224021**, both successful. The first push attempt hit the existing 2000 ms incremental-lifecycle readiness timeout; the unchanged failed-job retry passed. Carry this timing issue into ordinary M04 test maintenance, not reopened M03 acceptance.
- Validation: 412/412 normal tests, both fixed-heap lanes, replay equality, 54-job deployed recovery soak, typecheck/build/manifests, privacy and post-activation root verification passed as recorded below.
- Deployment is a separate identity: installed **2.0.4** from clean detached `ad23f0b71ee473d33aff26d367459e76d208c631`. Closeout rechecked that identity and a fresh synthetic offline Pi process loaded 2.0.4 with doctor/status and the worker enabled. This does not establish every existing process's loaded version.
- Verified **2.0.3** rollback remains ready; 2.0.4, its configuration, scheduler policy, and older backups are unchanged. The accepted merge includes metadata-only closeout above the accepted head and targets only `rebuild/chrono-memory-v3`, never `main`.
- Remaining limits: trusted-Node logical source-read accounting does not cover native SQLite I/O; controller ownership remains authoritative for process-tree capacity; boot/policy recovery remains explicit; local waiter settlement cannot confirm cleanup of an unresponsive coordinator; the queued election helper can remain until its existing lock timeout; the abrupt promotion commit-to-IPC window remains; no real-machine reboot fault campaign was performed.

All later sections retain chronological pre-acceptance evidence. Their earlier pending, unmerged, deployment, or authorization statements describe those historical checkpoints, not current authority.

## Historical changes-requested correction pass

The project lead reproduced an abandoned live-owner slot after fairness-state publication failed (`EISDIR` or one-shot `ENOSPC`). The project lead also reproduced a follower pending beyond its deadline while its coordinator was stopped with `SIGSTOP`. Both findings must be corrected without weakening process-tree containment or compaction/history semantics.

Initial read-only inspection confirmed that the installed package remains 2.0.3 at `7449c03240dd6b69426fd678cb453c89621d9e4d` and its verified 2.0.2 rollback remains ready. After the host restart, both production scheduler namespaces were absent and the boot-bound gate was invalid. No stranded production admission was present; no scheduler file, inhibitor, or unrelated process was removed. Production worker admission must remain refused until verified gate installation during corrective activation. Installed identity does not establish what every existing Pi process has loaded.

### Corrective implementation

- F001: `89a35e1` integrates the admission correction. Fairness publication and own-ticket removal precede slot publication. Policy initialization publishes only a fully written and synced private file. Cleanup and lease release compare inode identity and owner nonce. A persistent cleanup I/O outage keeps the transaction pending rather than rejecting with abandoned live ownership; when the fault clears, cleanup resumes. Abandoned temporary aliases can be reclaimed under the queue lock without releasing their linked slot.
- F002: `c759507` integrates the waiter correction. Local timeout and abort cover election, connection, retry, and response waits with at most 250 ms for acknowledgement, subject to caller event-loop scheduling. Socket closure detaches the caller; it does not free controller capacity. Cancellation status is `confirmed`, `detached`, or `unconfirmed`; the replay client preserves that status separately from the failure response. Ordinary history refusal codes do not claim confirmed remote cleanup.
- Corrective policy revision 2 refuses already-loaded 2.0.3 scheduler clients before admission. A synthetic check against the actual installed 2.0.3 module confirmed refusal, subsequent 2.0.4 acquisition, and zero residue. Activation must pin revision 2 before enabling the boot gate; it must not migrate occupied production state. Rollback to 2.0.3 requires serialized controller drain and exact-policy restoration while preserving the 2.0.2 inhibitors. Old Pi processes require reload to use corrective workers; regular fallback remains available.
- A queued election-lock helper can remain until lock release or its existing 15-second lock timeout after local waiter settlement. Its callback is fenced from starting work. An unresponsive coordinator cannot confirm cleanup; its shared work remains controller-owned until stopped. Responsive last-waiter cancellation retains the existing process-tree cleanup contract.
- Focused implementation gates passed 43 scheduler tests and 21 rendezvous/runtime/gate tests. The new separate-process cases cover stopped coordinators, 900 ms deadlines, abort, surviving waiters, recovery/death, and cleanup status. Admission cases cover EISDIR, ENOSPC, partial writes, sync/link/rename/unlink failures, replacement ownership, and recovery by a separate client before the still-running original client.
- The corrected-distribution soak passed 54 jobs (six clients, three repeats, slots 1/2/4). Each slot case first injected and removed its own EISDIR fault in the same synthetic namespace; subsequent independent-client replay results were equal, bounded, leak-free, and left zero scheduler residue. The final local and deployed runs both passed; the corrective release evidence follows.

### Corrective release verification and deployment

- Deployed source: `ad23f0b71ee473d33aff26d367459e76d208c631`, version **2.0.4**, from a clean detached exact-commit build. Implementation and policy commits are `c759507`, `89a35e1`, `4c2bc44`, and `ab429f8`; `ad23f0b` updates the frozen package/lock metadata hashes.
- Exact-source CI passed: push **34140039294**, PR **34140043742**. The preceding runs **34139175182 / 34139177631** failed on stale frozen package metadata, not runtime tests; the corrected frozen verifier and its **29/29** tests passed before repush. No deployment occurred before both corrected CI runs succeeded.
- Final normal suite: **412/412**, plus deterministic replay equality. Both **512/1024 MiB** lanes passed. Typecheck, reproducible distribution, all 84 deployment-manifest entries, full root verification, and unchanged all-ref privacy scanning passed. The initial shadow-test crash occurred while a distribution build overlapped testing; the isolated rerun and two subsequent frozen-build complete runs passed. Builds must finish before tests that load the distribution.
- Source tree (84 files): `0d0eaca5b0c103b51d5fe9fb373f7c39bc93e4d7229d2c7d2bb91f7b1ee04b02`. Distribution (83 files): `04d1bf07b228c9ae6238672794c6adb43a5213c9d91f1690cd32f699ce989747`. Entrypoint: `e6dab767e69f670daf90a215dbad64f07de7849f9f2f32d25f5183237f5746aa`.
- Before activation, both production namespaces were absent and all four fixed production units were inactive. Revision 2 was pinned before installing all four boot-bound inhibitors and proving old-worker quiescence. Only the ChronoCompact alias and legacy-named activation pointer changed. Effective configuration, package order, Pi Web, and unrelated work were preserved.
- Fresh processes loaded **2.0.4** and passed doctor/status, production discovery, contained compaction, worker-disabled fallback, and oversized-history search/recall refusal. Contained history search passed with parent graph access forbidden; the deliberate 32 MiB feedback reservation remained accounted until session shutdown, then admission returned to zero. An initial smoke assertion incorrectly required that retained reservation to be zero before shutdown; correcting the smoke did not change runtime code.
- Worker canaries passed three repeated successes, append during execution, bounded private diagnostics, internal error, and child crash. Unexplained SIGKILL remained `worker-crashed`, not controller-confirmed exhaustion. The deployed **54-job** independent-client soak passed slots **1/2/4**, equality, memory bounds, and recovery after synthetic EISDIR. Production ended with zero tickets/slots, four inactive units, and a valid gate; no unrelated process was stopped. Available RAM remained about 23 GiB, with zero swap use.
- The current activation root contains a fresh byte-verified **2.0.3** backup and `backup/rollback.sh --check` reports ready. Its synthetic reverse-transition check restored policy 1, allowed the actual prior 2.0.3 scheduler to acquire, refused 2.0.4, and preserved the legacy inhibitors. Actual production rollback was not performed. Rollback disables the exact gate under admission locking, stops controller-owned trees, allows pending starts to observe refusal and release their own metadata, then restores the exact prior policy/gate under queue locking. It refuses changed configuration or ownership; interrupted rollback remains fail-closed and requires verified recovery. The older 2.0.2 rollback root is retained.
- Post-activation root verification exposed a test that expected the real production gate to be absent. With a valid installed gate, its synthetic job correctly succeeded and the assertion failed. The test now checks `withVerifiedLegacyAdmission` in its own synthetic ungated namespace, so it neither relies on nor submits work through production state. Runtime and deployed package bytes did not change.
- Existing Pi processes were not force-reloaded. They may still have 2.0.3 loaded and must reload to use corrected workers; policy mismatch refuses safely. This safety deployment does not grant M03 acceptance, PR merge, or M04/proposal implementation authority.

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

## Historical remaining gates

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


## Historical 2.0.3 deployment evidence

- Deployed source: `7449c03240dd6b69426fd678cb453c89621d9e4d`, version **2.0.3**.
- Exact-head push CI `34088763954` and PR CI `34088767240`: **success**. All 370 package tests, both 512/1024 MiB fixed-heap lanes, determinism, typecheck, generated build consistency, publication scanning, frozen-baseline verifier tests, and complete root verification passed.
- The CI corrections changed only test synchronization and inventory expectations: wait for background completion rather than manifest existence; assert the queue lease bound rather than assuming job coalescing; advance exact source/dist inventory hashes and counts. No runtime limit was relaxed.
- Source tree: `1c56108207ff15c37a7e995350959db8185364a193d4b42bc72697ab0ed42ef8` (84 files).
- Dist tree: `c4deb398d4ff5e3201b3bc66490d28a433cf583f35fc880ed44484b30d3c957b` (83 files).
- New entrypoint: `e6dab767e69f670daf90a215dbad64f07de7849f9f2f32d25f5183237f5746aa`.
- Previous 2.0.2 entrypoint: `256f9003455b66d40c0445dbf0e7d4a5584785e295513354542927295c7181f2`.
- Backup identity: `m03-20260907T054318Z-48019e4`. Its name reflects preparation time, not deployed source. Full prior 2.0.2 package/config copies matched; checked rollback remains ready. The candidate checkout is clean and detached at the deployed commit.
- Four legacy inhibitors were installed without stealing ownership. Two bounded process scans after reservation confirmed no old replay workers before enabling the new pool. Production gate verification passed. Only the ChronoCompact alias and activation pointer changed; persistent configuration and unrelated checkout/package order remained unchanged.
- Fresh offline Pi loader, doctor/status, and production discovery passed with no private paths or extension errors. Ordinary synthetic compaction used the isolated worker and returned a nonempty summary. Regular fallback remains available.
- Synthetic source above 64 MiB refused search and recall with `legacy-history-size-limit`; parent survived. Default production contained history search passed and released all dispatch admission.
- Worker canaries passed three repeated successes, verified append, controlled `worker-internal-error`, child crash, and unexplained SIGKILL as `worker-crashed`. Owner-only diagnostics remained bounded without private text. Controller-confirmed OOM is separately covered by the passing runtime fault suite.
- Deployed-package soak passed **36 jobs**: six independent clients, three repeats, slot configurations one and two. Replay source-plan hashes were equal, no cross-session leakage occurred, client RSS remained below 512 MiB, and synthetic scheduler residue was zero. Actual cgroup slot and descendant containment evidence comes from the passing runtime suite, not advisory soak samples.
- Post-canary production status reported zero active workers and queued jobs. Process checks found no remaining Node/test launchers. CPU/RAM checks continued throughout; no unrelated process was stopped.
- Isolated worker remains **enabled**. I-0001 remains contained by bounded history admission and verified-ledger exact retrieval. I-0002 now produces stable bounded failures while Pi survives.

The direct-Node history smoke initially lacked local peer dependencies; the existing locked dependency tree was prepared in the detached candidate, then the smoke passed. The Pi loader itself had already passed. A smoke assertion initially misread the status flag for blocked legacy admission; the corrected assertion checks the actual gate and passed. Neither issue required a product-code change or scanner bypass.

Remaining limitations are the trusted-Node logical-read boundary, conservative boot/policy recovery, preexisting abrupt commit-to-IPC promotion window, and no real-machine reboot test. Already-running 2.0.2 clients safely lose old worker admission until reloaded; fresh Pi processes use 2.0.3. No preserved private session was inspected or compacted. Code review and milestone acceptance belong to the user. PR #35 remains draft and unmerged; M04 has not started.
