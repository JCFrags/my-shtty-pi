# Known incidents and unresolved boundaries

Only sanitized classifications and bounded outcomes are recorded here.

| ID | Classification | Status | M00/R2 handling |
| --- | --- | --- | --- |
| I-0001 | Heap exhaustion during large-history processing | confirmed | Retained as a reason for the V3 safety work. No larger heap, runtime rewrite, live failure, or locally usable fix was induced in M00. |
| I-0002 | Fallback path observed during a worker failure | unresolved | The actual safe failure code is not established. M00 preserves this boundary and does not induce a risky live failure or claim a resolution. |
| I-0003 | Malformed scheduler artifact | source-confirmed, causality unresolved | Scheduler state was inspected with owner-only controls; no stale host-worker artifact remained at capture. No scheduler repair was attempted. |
| I-0004 | Unexpected worker errors converted into protocol failures | source-confirmed | Remains a later runtime correction item. M00 records the boundary without changing the deployed protocol. |
| I-0005 | Historical public reachability and limited metadata exposure | P1 | Public review controls, historical scanning, and explicit non-retraction language are recorded. No P2 credential or private-session material and no P3 surface were confirmed. |
| I-0006 | Historical package metadata hash transcription discrepancy | reconciled | The manifest-derived 64-character SHA-256 is authoritative; the separately supplied invalid candidate is rejected. Runtime hashes remain frozen. |
| I-0007 | Synthetic verification timing sensitivity under CI load | corrected in R2 | The worker abort probe now waits for an owner-only synthetic readiness marker, and the scheduler-capacity test uses a bounded readiness wait with cleanup release. These are test-only corrections; deployed runtime source/dist remain unchanged. |
| I-0008 | Scheduled publication audit activation | documented limitation | GitHub scheduled workflows run from the default branch. The corrected weekly workflow is not active on `main` until a reviewed control-plane change reaches that branch. M00-R2 does not modify `main`; push/PR gates and the mandatory local pre-push gate remain the active controls. |

These records are not a substitute for private diagnostic evidence and do not authorize M00 acceptance, deployment, or M01.
