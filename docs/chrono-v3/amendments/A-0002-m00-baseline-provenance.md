# A-0002 — M00 baseline provenance

**Status:** accepted 2026-09-02
**Applies to:** M00 baseline records

## Change

M00 uses `eb9742c318a76eeaf753e87a620fae83ca9048d1` as `BASELINE_SHA`, the committed local start captured before external feature-branch drift. Uncommitted worktree changes are excluded from the baseline.

## Reason

The original worktree contained unrelated local work and must not be modified or silently folded into ChronoCompact. The baseline must be reproducible from a committed object and must describe the live package relationship without changing runtime behavior.

## Boundary

This amendment does not authorize merging the baseline to `main`, deploying it, rewriting history, or beginning M01. Later milestones must record their own commit, build, deployment, and rollback evidence.
