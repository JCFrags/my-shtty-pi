# M00 evidence register

This register names evidence without copying private source data. The owner-only raw evidence remains outside Git under the ignored `.chrono-v3-private/` directory.

| Evidence class | Public representation | Private representation | Result |
| --- | --- | --- | --- |
| Repository identity and history | commit IDs and aggregate counts | API responses and mirror inventory | private repository; 141 commits, 2,486 reachable mirror objects |
| Public exposure | classification and method | bounded scanner reports, PR/issue/action/package/page/LFS probes | P1; no P2 confirmed |
| Repository baseline | `baseline.md` and verifier output | full hashes and command records | committed local baseline selected |
| Live package | hash-only measurements | two stable discovery passes and comparison reports | source/dist/entrypoint content matches baseline package |
| Settings and flags | bounded booleans and limits | sanitized settings projection | current authoritative composition remains unchanged |
| Scheduler | aggregate artifact counts and permissions | owner-only directory inspection | no stale host-worker artifact at capture |
| Affected session | size and line-boundary counts only | streaming hash and boundary measurement | source untouched; whole file was not materialized |
| Rollback | backup identity and hash | owner-only backup | backup exists; no live switch performed |
| Tests | counts and commands | bounded command logs | 294 tests passed; one historical test is explicitly excluded |

The register is not an attestation that public history was retracted. It is a reproducible record of the containment decision and M00 inputs.
