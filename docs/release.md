# Release gates

A release is package-specific. Every gate must be satisfied in order. Lifecycle status is not release approval.

1. Package selected for stabilization.
2. Package-specific clean checkout.
3. Type checking and tests.
4. Build when required.
5. Exact package artifact creation.
6. Reviewed payload.
7. Clean isolated load.
8. Exact Pi compatibility evidence.
9. Privacy and secret review.
10. Prerelease version.
11. Manual user-value validation.
12. Project-lead approval.
13. Exact release artifact and provenance verification.
14. Publication.
15. Post-release installation check.

Foundation 0 does not perform these package release actions. It does not change package behavior, package readiness, publication, deployment, registrations, or live state.
