# A-0003 — M00-R1 public-review correction

**Status:** applied in the R1 tree; independent read-only review completed 2026-09-03 with no blocking defect; explicit acceptance remains pending
**Date:** 2026-09-03
**Applies to:** M00 repository review and publication gates

## Change

This amendment supersedes A-0001's current-visibility requirement. After the M00-A1 preconditions and explicit authorization were recorded, `JCFrags/my-shtty-pi` was changed from private to public for review. The current public state is intentional; it does not claim that prior public copies were retracted.

The content boundary remains fail-closed and independent of repository visibility. Public review is permitted only for source, tests, synthetic fixtures, sanitized aggregate evidence, and reproducible verification tools. Private session data, credentials, raw diagnostics, owner-only evidence, and private paths remain prohibited.

## Controls

- Before every push, pull request update, or final report, verify the exact repository identity and public visibility through an authenticated API check.
- Scan the worktree, staged index, all local refs, branches, tags, and fetched pull-request heads with the privacy verifier.
- Require CI event identity to match `JCFrags/my-shtty-pi` and to report public visibility; reject forks, identity mismatches, malformed event data, and unscanned input.
- Keep full-ref checkout and explicit branch/tag/pull-request-head fetching in CI.
- Keep the frozen M00 runtime baseline, north-star hash, correction-artifact allowlist, and no-deployment boundary; any synthetic test-timing correction must remain explicitly allowlisted and must not change deployed runtime source or dist.
- Treat every push as public. Do not rewrite history, force-push, publish a release or package, deploy, or start M01 under this amendment.

## Review boundary

A-0003 records the correction and its controls; it is not an acceptance attestation. Complete validation and independent review found no blocking defect. M00-R1 remains pending an explicit acceptance decision, and M01 remains blocked.
