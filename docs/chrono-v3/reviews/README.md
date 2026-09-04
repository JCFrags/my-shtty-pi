# M00 review records

This directory is the canonical index for M00 review provenance.

- [`M00-project-lead-review-1.md`](./M00-project-lead-review-1.md) records the directing-assistant project-lead review that identified the R1 correction set.
- [`M00-project-lead-review-2.md`](./M00-project-lead-review-2.md) records the directing-assistant project-lead review that identified R2-F001 through R2-F010.

## Latest advisory audit

A fresh local secondary read-only audit inspected exact pushed head `74c2e45ecf4faf65c73db3ddd3d4b8a7628bf5b9` after its push and pull-request CI runs passed. It reproduced no blocking defect; the final diff from `fd596f6` is limited to four sanitized documentation/evidence files, and the validation-target and CI attestations are present. This result is advisory, distinct from directing-assistant project-lead review, and does not accept M00 or authorize M01.

## Terminology

- **Local secondary review:** advisory review performed by a local Pi worker or local read-only reviewer. It is not project-lead acceptance.
- **Directing-assistant project-lead review:** the governing review performed by the directing assistant against the pushed GitHub state and required evidence.
- **Acceptance:** an explicit directing-assistant decision. A test pass, local secondary review, or correction completion does not grant it.

The current R2 state is `M00-R2 corrections complete; ready for directing-assistant project-lead re-review`. M00 remains unaccepted, and M01 remains unauthorized.
