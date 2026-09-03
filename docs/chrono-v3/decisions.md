# M00 decisions

## D-0001 — Keep the repository private

**Status:** superseded by D-0006 and A-0003 on 2026-09-03; retained as the original containment decision

During the original containment interval, the repository remained private. The earlier public interval is recorded as exposure history, not treated as retracted. No public release or package publication was allowed by this decision.

## D-0002 — Use a clean execution clone

**Status:** accepted 2026-09-02

The original project worktree and its unrelated local changes are preserved and excluded from M00 edits. All project changes are made in the clean execution clone and reviewed as a separate branch.

## D-0003 — Select the committed local start as M00 baseline

**Status:** accepted 2026-09-02

`BASELINE_SHA` is `eb9742c318a76eeaf753e87a620fae83ca9048d1`. It is the committed local start captured before external feature-branch drift. The ChronoCompact source and compiled runtime content matched the live installation; the three commits beyond `origin/main` concern the existing Project Glance/root-verifier state and are not a ChronoCompact runtime change.

## D-0004 — Preserve the historical test boundary

**Status:** accepted 2026-09-02

Restore the historical suite from `9a4d25a46f329bd91828a22a925e5de81c71eee4`, adapt only test-support paths, and exclude `incremental-context.test.ts` from the runnable set because the selected current source no longer contains `incremental-context.ts`. Do not recreate that removed runtime module in M00.

## D-0005 — Do not deploy M00

**Status:** accepted 2026-09-02 and unchanged by R1

M00 adds evidence, privacy controls, tests, and diagnostics only. The live package, settings, scheduler configuration, Pi agents, and session JSONL remain unchanged.

## D-0006 — Permit public review without weakening the content boundary

**Status:** applied 2026-09-03; independent review completed with no blocking defect; explicit acceptance pending

The repository is public for source review under A-0003. This is not a release, package publication, deployment, or M01 authorization. Public identity and visibility are checked separately from the fail-closed worktree/index/history privacy scan. A finding, malformed input, identity mismatch, unverified ref, or correction-scope violation blocks publication.
