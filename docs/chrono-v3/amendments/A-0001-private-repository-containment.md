# A-0001 — Private repository containment

**Status:** superseded by A-0003 on 2026-09-03; retained as historical containment record
**Applies to:** the containment interval of M00

## Historical change

During the original containment decision, the repository was private. Every push, pull request, and publication report required an authenticated repository-identity and visibility check. The earlier public interval remains a P1 incident record and is not described as retracted.

A-0001 no longer governs the current repository visibility. A-0003 records the later, explicitly authorized transition to public review and its replacement controls. The privacy boundary for session data, credentials, diagnostics, and owner-only evidence is unchanged.

## Reason

ChronoCompact processes private Pi session history. Repository visibility is a trust boundary, and private evidence must never be used as a substitute for source review.

## Historical controls

- static privacy verification ran in CI;
- owner-only evidence was ignored and kept outside Git;
- raw sessions, private diagnostics, credentials, and absolute private paths were prohibited;
- no release, package publication, telemetry, or deployment was implied by M00.
