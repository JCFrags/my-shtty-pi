# M00 directing-assistant project-lead review 2

- **Review date:** 2026-09-03
- **Reviewer role:** directing-assistant project-lead review
- **Result at review time:** changes requested
- **Review basis:** direct inspection of the repository, PR #30, commit history, changed files, workflow configuration, source, tests, and GitHub Actions evidence.

The review found the following independent gaps. This record preserves the finding names and the required correction boundary; it is not an acceptance attestation.

| Finding | Required correction boundary |
| --- | --- |
| R2-F001 — CI hardening incomplete | Weekly schedule, cancellation and timeout bounds, non-persisted checkout credentials, read-only permissions, canonical step wording, full-ref fetching, and event-specific publication scanning. Document default-branch schedule activation. |
| R2-F002 — historical path contexts can be missed | Separate blob-byte scanning from complete per-commit path/mode contexts; cover aliases, renames, removed files, symlinks, ranges, all refs, and bounded unscanned inputs. |
| R2-F003 — dirty-tree enforcement missing | Fail closed on dirty repositories by default; keep `--allow-dirty` diagnostic-only and absent from CI/root verification. |
| R2-F004 — baseline matrix incomplete | Add safe `--repository-root` testing, root/symlink boundaries, runtime and metadata mutations, live checks, deterministic output, and the complete meaningful matrix. |
| R2-F005 — metadata exception imprecise | Report only the exact typed `test-script-only-metadata-divergence` exception and an explicit empty runtime-mismatch list; keep package-lock and all other metadata frozen. |
| R2-F006 — review provenance incorrect | Distinguish local secondary review from directing-assistant project-lead review; preserve historical facts without claiming acceptance. |
| R2-F007 — historical inventory incomplete | Record one deterministic row with both Git blob IDs, classification, runnable status, reason, and family for every historical test and fixture/support file. |
| R2-F008 — machine evidence incomplete | Replace the evidence projection with sanitized schema version 2 or higher covering repository, north-star, runtime, configuration, scheduler, session, incident, tests, privacy, rollback, deployment, and review state. |
| R2-F009 — timeline dates inconsistent | Reconcile dates against retained evidence, Git timestamps, PR state, and milestone reports without inventing times. |
| R2-F010 — timing test blind delay | Use a bounded readiness marker/poll for the synthetic worker and a bounded, cleanup-safe scheduler barrier without changing runtime code. |

## Correction status

The R2 correction tree implements these boundaries in verification tooling, workflow, tests, documentation, evidence, inventory, and review records. Local validation and CI evidence are recorded only after they are actually run. The resulting status is `M00-R2 corrections complete; ready for directing-assistant project-lead re-review`.

## Acceptance boundary

This review record does not accept M00, authorize deployment, authorize a release, or authorize M01. A fresh directing-assistant project-lead review of the pushed R2 head is required. Local secondary reviews remain advisory evidence only.
