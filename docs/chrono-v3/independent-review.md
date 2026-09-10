# Review compatibility index

Canonical M00 review provenance is maintained in [`reviews/`](./reviews/):

- [`M00-project-lead-review-1.md`](./reviews/M00-project-lead-review-1.md) records the first directing-assistant project-lead review and its R1 changes-requested result.
- [`M00-project-lead-review-2.md`](./reviews/M00-project-lead-review-2.md) records the second directing-assistant project-lead review and R2-F001 through R2-F010.
- The latest advisory local secondary audit inspected pushed head `74c2e45ecf4faf65c73db3ddd3d4b8a7628bf5b9` and reproduced no blocking defect. It is not a directing-assistant project-lead review or an M00 acceptance decision.

Historical references to “independent review” in earlier records mean local secondary review unless the record explicitly names a directing-assistant project-lead review. Local secondary review is advisory evidence only; it is not project-lead acceptance.

## Current state

M00–M05 have directing-assistant acceptance; see the [milestone ledger](./milestone-ledger.md). Selected M04 is separately accepted 2.0.5 at `dcd91924dbcfc0c02489e04c3e163b33e2b08e86`; installed identity does not prove current-boot worker readiness. M05 was accepted at `6a624dd5b6fd64365a3820b6e71c1f0242a35025` and merged by PR #38 as integration commit `56f7f88c809b53c5de32413a18b0c166de636834`. M06 validation-cadence implementation is authorized; this does not authorize production apply, a new write window, deployment, or V1.2.

## Standing owner direction: proportionate validation

For current and future Chrono assignments, do not commission review-only agents or recursive peer-review rounds. Implementation delegation is allowed. Perform the normal implementation self-check, then return the pushed candidate to the directing assistant. Preserve useful findings from existing reviews without ordering another round.

During edits, run affected tests and immediate integrations. Use small parameterized regressions and the smallest fixtures that cross the real boundary; preserve unique assertions rather than growing test counts. Prefer explicit readiness/completion signals over arbitrary sleeps. Targets are under one second for ordinary pure cases, ten seconds for ordinary integrations, and two minutes for a focused group. These targets do not weaken required behavior or authorize blind deadline changes; retain slower real-process checks when needed.

Batch related fixes and necessary documentation before one required final push/PR validation pair. Required CI provides comprehensive candidate checks; do not duplicate local root, normal, native and heap sequences without a specific local-only risk. Documentation-only changes need relevant static/publication checks, not runtime campaigns. Record final CI in the PR, not report-only pushes. Preserve failures; no unchanged retry loops or bypass of protected checks.

Long scale/endurance/fault campaigns belong at relevant milestone or release gates, or where storage, I/O, containment, retained-state bounds or a concrete scale risk invalidates existing evidence. The blanket F003 136 MiB / 2,048-record rerun requirement is withdrawn. Use focused mixed-detector, Unicode, restart, final-byte, small persisted/contained and bounded multi-chunk regressions. Identify reused evidence by its original revision and limits; never label it as a new-runtime measurement. No known defect, product invariant, recovery safeguard, or acceptance boundary is waived. This direction supersedes earlier broad-rerun process requirements without changing the frozen charter.

Historical review results above remain historical evidence, not the current milestone state.

## CI cadence and acceptance semantics

Push and pull-request events receive fail-closed diff classification. Documentation-only diffs run documentation/publication validation and explicitly report runtime campaigns as not applicable. Routine runtime classification is limited to ChronoCompact package paths, the owned validation workflow/classifier/tests, and the two Chrono baseline/privacy verifiers. Any other non-documentation path is unknown rather than silently accepted by Chrono-only checks. Supported routine diffs run scoped publication scanning, typecheck, generated-build consistency, the focused M06 search contract tests against a controlled source-built SQLite artifact, and static baseline identity/inventory verification; they do not claim complete unit, determinism, fixed-heap, or root-runtime evidence. A new-branch push, empty diff, malformed event, mismatched pull-request merge checkout, or unsupported event is unknown and fails rather than selecting a weaker path.

Broad validation is selected only by a manual `workflow_dispatch` milestone checkpoint whose `expected_head` exactly matches the checked-out 40-character commit. Push and pull-request events cannot select it, so the broad campaign is not duplicated across their paired runs. Existing job names remain visible, and the `verify` aggregate preserves the protected-main required context. A successful routine job means its applicability gate was evaluated and its stated applicable work passed; an explicit message identifies every unrun runtime campaign. It is not evidence that an inapplicable campaign ran.
