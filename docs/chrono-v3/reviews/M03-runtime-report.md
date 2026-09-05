# M03 transactional-runtime report

## Milestone identity

- Branch: `work/chrono-v3-m03-runtime`
- Base and M02 merge commit: `ea977dbb09ccea5265a435ce831303282622f97a`
- Pull request: pending draft into `rebuild/chrono-memory-v3`
- Current release candidate: ChronoCompact `2.0.3`

M03 is in progress. This report records each independently gated runtime slice; it does not claim milestone acceptance, authorize a merge to `main`, or start M04.

## 2.0.3 memory-admission slice

The first M03 slice corrects the accepted M02 accounting limitation. Legacy whole-file loading now reserves capacity before reading or parsing. Search work reserves one conservative envelope before loading, transitions it through pending-load and pending-build states, and retains explicit live-index, query-result, and retained-reference charges. One current index generation is retained per session under the existing 128 MiB cache ceiling. Complete load-and-build work coalesces for an identical source generation, and active users pin retained accounting until their work finishes. Admission failure returns a controlled bounded refusal rather than loading rejected work.

The local admission ceiling is 512 MiB. Legacy sources retain the 64 MiB source guard and use an eight-times pre-load charge. Indexed sources retain the 16 MiB source guard and use a measured conservative 32-times envelope with an 8 MiB minimum. This is a safety slice, not the final M03 child-containment design; later M03 work must move work whose expansion cannot be safely admitted into bounded worker isolation and must not transfer complete indexes back into Pi.

The fixed-heap characterization now has a meaningful pass condition. It first reproduces the old omission, then requires the declared envelope to cover measured retained heap. In both the 512 MiB and 1 GiB lanes, the synthetic workload used `1,093,409` source bytes, retained approximately `24,734,000` bytes, reported the old estimate as `6,626,032` bytes, and reserved `34,989,088` bytes. The observed admission headroom was approximately `1.414`.

## Validation before push

- Complete serialized package suite: 333/333.
- Unified normal suite and deterministic small/medium report: passed.
- Fixed-heap 512 MiB and 1 GiB lanes: passed; OOM remains non-passing.
- Package typecheck, generated distribution, and deployment manifest: passed.
- Complete repository-root verifier: 17/17 manifests, 262/262 deployed hashes, 66/66 ChronoCompact build files, 15/15 safe scripts, 17/17 package dry runs, and zero unexplained dependency-graph files.

Candidate repository identities before the source commit is created:

- Source tree: `7614d90623745360f9afb30246ef074542fc617a56f71b2ee5fc3f500c28b67f` (67 files).
- Dist tree: `a9f2881623af9e2726759e3aed51463913a452104e2569941113208cde2ea751` (66 files).
- Entrypoint: `fcd0209d5b76beab91ca42585319f15968861fa81ff15a4a7e15bb1ae858f15e`.
- Package metadata: `b5367bea62b54492669157e7ee7fb74c99f450cf3c7478ad713425e80c236a7a`.
- Lock metadata: `3edda0714e750097ae37d9185fddb6fd1c87e48beeffd3b951f0760575949e73`.

The exact pushed source commit, CI runs, backup identity, deployed hashes, activation method, and fresh-process canaries will be added only after those gates complete. Live ChronoCompact remains `2.0.2` from `0c7173ff03ed010747ab9b5d7be6f8f84d423819` until then. The verified M02 rollback remains ready.

## Remaining M03 runtime work

The remaining milestone must replace descriptive scheduler ownership with kernel-held capacity, implement bounded fair host queues and complete job identity/coalescing, enforce limits in worker descendants, unify protocol and configuration validation, add host-wide status and progress, and pass the independent-client stress matrix. The M03 pull request must remain draft and unmerged, and M04 remains outside this milestone boundary.
