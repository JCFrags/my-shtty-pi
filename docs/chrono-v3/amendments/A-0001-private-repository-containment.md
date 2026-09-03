# A-0001 — Private repository containment

**Status:** accepted 2026-09-02
**Applies to:** M00 and all later ChronoCompact V3 milestones

## Change

The repository is private. Every push, pull request, and publication report requires an authenticated repository-identity and visibility check. The earlier public interval remains a P1 incident record and is not described as retracted.

## Reason

ChronoCompact processes private Pi session history. Repository visibility is a trust boundary, and private evidence must never be used as a substitute for source review.

## Controls

- static privacy verification runs in CI;
- owner-only evidence is ignored and kept outside Git;
- raw sessions, private diagnostics, credentials, and absolute private paths are prohibited;
- no release, package publication, telemetry, or deployment is implied by M00.
