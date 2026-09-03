# M00 evidence register

This register names evidence without copying private source data. The owner-only raw evidence remains outside Git under the ignored `.chrono-v3-private/` directory.

| Evidence class | Public representation | Private representation | Result |
| --- | --- | --- | --- |
| Repository identity and history | exact repository identity, visibility, commit IDs, and aggregate counts | authenticated API responses and mirror inventory | public review state; 13 branches, 3 tags; prior audit covered 141 commits and 2,486 reachable mirror objects |
| Public exposure | classification and method | bounded scanner reports, PR/issue/action/package/page/LFS probes | P1 limited metadata exposure; no P2 confirmed and no P3 surface |
| Repository baseline | `baseline.md`, `baseline-evidence.json`, and verifier output | full command records | committed local baseline selected; runtime hashes match |
| Live package | hash-only measurements | two stable discovery passes and comparison reports | source/dist/entrypoint content matches baseline package |
| Settings and flags | bounded booleans and limits | sanitized settings projection | current authoritative composition remains unchanged |
| Scheduler | aggregate artifact counts and permissions | owner-only directory inspection | no stale host-worker artifact at capture |
| Affected session | size and line-boundary counts only | streaming hash and boundary measurement | source untouched; whole file was not materialized |
| Rollback | backup existence and non-deployment rule | owner-only backup | backup exists; no live switch performed |
| Tests and gates | commands and aggregate results | bounded command logs | M00 suite 294/294; R1 correction tests 30/30; R1 checkpoint all-ref scan at `7e3d5cb5f84e33c3dd72b804ba42f3b5421de6b3` scanned 2,908 blobs with zero findings |

The content gate and public identity gate are separate. A passing content scan does not prove repository visibility, and public visibility does not permit private evidence. The register is not an attestation that public history was retracted. It is a reproducible record of the containment decision, R1 correction controls, and M00 inputs. Complete validation and independent review found no blocking defect; M00-R1 remains pending an explicit acceptance decision and M01 remains blocked.
