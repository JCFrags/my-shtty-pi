# GitHub administration handoff

## Status

Applied on 2026-08-09. See the [applied administration state](github-admin-state.md). The original plan remains below.

## Original Foundation 0 handoff

This is a plan only. Do not apply these settings as part of Foundation 0.

1. Protect `main`.
2. Require pull requests.
3. Require the exact check `Repository integrity`.
4. Block force pushes.
5. Block branch deletion.
6. Do not require another human approval while there is one human maintainer.
7. Keep administrator behavior explicit. The administration record must state whether administrators can bypass each protection.
8. Enable private vulnerability reporting.
9. Create a Foundation 0 milestone.
10. Create package and status labels.
11. Enable merge commits and disable squash and rebase merges. This preserves the three reviewed logical commit identities and provenance evidence as ancestors. The later administration record must state the enabled methods and their provenance effects.
12. Review the stale default `gh` CLI authentication entry without exposing or changing credentials.

Proposed labels:

- `foundation`
- `security`
- `packaging`
- `release`
- `documentation`
- `package:chrono-compact`
- `package:grounded-tools`
- `package:progressive-tools`
- `package:tool-controls`
- `package:review-ui`
- `package:files-ui`
- `package:herdr-status`
- `status:candidate`
- `status:experimental`
- `status:blocked`
- `status:host-dependent`
- `status:quarantined`

The handoff must preserve the separation between repository merge, package readiness, publication, and private deployment state.
