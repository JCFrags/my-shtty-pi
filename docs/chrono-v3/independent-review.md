# Review compatibility index

Canonical M00 review provenance is maintained in [`reviews/`](./reviews/):

- [`M00-project-lead-review-1.md`](./reviews/M00-project-lead-review-1.md) records the first directing-assistant project-lead review and its R1 changes-requested result.
- [`M00-project-lead-review-2.md`](./reviews/M00-project-lead-review-2.md) records the second directing-assistant project-lead review and R2-F001 through R2-F010.
- The latest advisory local secondary audit inspected pushed head `74c2e45ecf4faf65c73db3ddd3d4b8a7628bf5b9` and reproduced no blocking defect. It is not a directing-assistant project-lead review or an M00 acceptance decision.

Historical references to “independent review” in earlier records mean local secondary review unless the record explicitly names a directing-assistant project-lead review. Local secondary review is advisory evidence only; it is not project-lead acceptance.

## Current state

M00–M04 have directing-assistant acceptance; see the [milestone ledger](./milestone-ledger.md). Selected M04 is separately accepted 2.0.5 at `dcd91924dbcfc0c02489e04c3e163b33e2b08e86`; installed identity does not prove current-boot worker readiness. M05 remains unaccepted, draft and unmerged in PR #38. Its corrected candidate returns to the directing assistant for independent review. Recovery-procedure preparation is separate and does not authorize production apply, a new write window, deployment, M06, or V1.2.

## Standing owner direction: proportionate validation

For current and future Chrono assignments, do not commission review-only agents or recursive peer-review rounds. Implementation delegation is allowed. Perform the normal implementation self-check, then return the pushed candidate to the directing assistant. Preserve useful findings from existing reviews without ordering another round.

During edits, run affected tests and immediate integrations. Use small parameterized regressions and the smallest fixtures that cross the real boundary; preserve unique assertions rather than growing test counts. Prefer explicit readiness/completion signals over arbitrary sleeps. Targets are under one second for ordinary pure cases, ten seconds for ordinary integrations, and two minutes for a focused group. These targets do not weaken required behavior or authorize blind deadline changes; retain slower real-process checks when needed.

Batch related fixes and necessary documentation before one required final push/PR validation pair. Required CI provides comprehensive candidate checks; do not duplicate local root, normal, native and heap sequences without a specific local-only risk. Documentation-only changes need relevant static/publication checks, not runtime campaigns. Record final CI in the PR, not report-only pushes. Preserve failures; no unchanged retry loops or bypass of protected checks.

Long scale/endurance/fault campaigns belong at relevant milestone or release gates, or where storage, I/O, containment, retained-state bounds or a concrete scale risk invalidates existing evidence. The blanket F003 136 MiB / 2,048-record rerun requirement is withdrawn. Use focused mixed-detector, Unicode, restart, final-byte, small persisted/contained and bounded multi-chunk regressions. Identify reused evidence by its original revision and limits; never label it as a new-runtime measurement. No known defect, product invariant, recovery safeguard, or acceptance boundary is waived. This direction supersedes earlier broad-rerun process requirements without changing the frozen charter.

Historical review results above remain historical evidence, not the current milestone state.
