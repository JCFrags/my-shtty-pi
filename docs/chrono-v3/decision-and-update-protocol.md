# M00 decision and update protocol

This protocol applies to the ChronoCompact V3 M00 evidence and containment work. The byte-preserved north-star charter remains authoritative.

## Delegation and authority

The repository owner delegated routine architecture and milestone direction to the directing assistant under the north-star. Within that delegation, the directing assistant may request corrections, accept or reject milestones, authorize reversible implementation work, and authorize a reversible, tested live deployment when the relevant milestone deployment gate and rollback requirements are satisfied.

Local Pi agents may implement, test, inspect, and report within their assigned scope. They may not self-accept a milestone, authorize M01, authorize a release, or represent an advisory review as project-lead acceptance.

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
- whether M00 acceptance has been recorded and whether M01 authorization has been recorded.

For M00-R2, the normal final status is: `M00-R2 corrections complete; ready for directing-assistant project-lead re-review`. It is not an acceptance claim.

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
