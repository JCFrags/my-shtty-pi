# ChronoCompact decision and update protocol

This protocol governs milestone authority and evidence. The byte-preserved north-star charter remains authoritative, with approved amendments. [A-0004](./amendments/A-0004-v3-timeline-and-catalog-scope.md) records current V3 scope and M04 authority; the ledger records current status. M00/R2-specific examples below are historical, not current deployment or authorization claims.

## Delegation and authority

The repository owner delegated routine architecture and milestone direction to the directing assistant under the north-star. Within that delegation, the directing assistant may request corrections, accept or reject milestones, authorize reversible implementation work, and authorize a reversible, tested live deployment when the relevant milestone deployment gate and rollback requirements are satisfied.

Local Pi agents may implement, test, inspect, and report within their assigned scope. They may not self-accept a milestone, authorize a later milestone, authorize a release, or represent an advisory review as project-lead acceptance.

A **local secondary review** is advisory evidence from a local worker or reviewer. A **directing-assistant project-lead review** is the governing review after the directing assistant inspects the pushed repository state and required evidence. Review provenance is recorded in [`reviews/`](./reviews/).

## User decision gates

The user must be asked before:

- changing master product goals or invariants;
- destructive history migration or deleting exact archive data;
- credential rotation or revocation;
- public release, package publication, or a paid service or recurring external cost;
- an irreversible live change;
- a live change without a proven rollback path;
- a material privacy-boundary change;
- Git history rewrite or force push.

The user need not be asked before:

- ordinary source, test, documentation, and verification work within the accepted milestone scope;
- normal commits and normal pushes;
- CI reruns;
- temporary synthetic tests;
- a reversible local deployment already covered by an accepted milestone gate.

Silence, a passing test, a local review, or a successful push is not milestone acceptance.

## Required status updates

Every milestone report must state:

- user input required now;
- the exact requested user action, if any;
- the next user decision point;
- current live deployment;
- locally usable fixes;
- rollback state;
- whether the current milestone has project-lead acceptance and whether the next milestone or activation is authorized.

For M00-R2, the normal final status is: `M00-R2 corrections complete; ready for directing-assistant project-lead re-review`. It is not an acceptance claim.

## Shared release coordination

Check the latest `main/message-board.md` at each handoff and before shared writes.
Publish material decisions, blockers, and ownership or release changes through
append-only, board-only protected PRs from current main. Preserve prior entries.
Use existing direct agent messaging to contact the current owners; do not ask the
user to relay coordination. Keep private operational evidence in its private channel.

A nominated version is under review, not accepted. Keep the shared installed
selection fixed during release coordination. Identify candidate-changing corrections
as separate proposals. Shared deployment requires exact candidate agreement and
an acknowledged scoped window with COMMAND 8. Do not infer a window or waiver
from silence, passing checks, or a board proposal. Isolated implementation and
staged execution can continue within the user's scope while replies are pending.
Do not enable Chrono in another owner's session or interrupt their work.

## Deployment vocabulary and announcements

The following states are separate and must not be conflated: **built**, **merged**, **deployed**, **enabled**, and **usable locally**.

A live deployment must be announced when:

1. deployment starts;
2. smoke checks pass;
3. the fix becomes locally usable;
4. rollback occurs;
5. a defect forces disablement.

M00 has no live deployment. The current safe report is `ChronoCompact V3 runtime fixes deployed: none`, `Live extension behavior: unchanged`, `I-0001 fixed: no`, `I-0002 fixed: no`, and `First expected usable fix milestone: M01`.

## R2 control-plane limitation

The weekly publication audit in `.github/workflows/verify.yml` becomes operational on GitHub only when this workflow version exists on the repository default branch. Until a reviewed control-plane change reaches `main`, the milestone branch relies on its push and pull-request workflows plus the mandatory pre-push local publication gate. M00-R2 does not modify `main`; adding the corrected workflow to the default branch is a carry-forward control-plane action after M00 acceptance.
