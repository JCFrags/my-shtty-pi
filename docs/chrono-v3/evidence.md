# M00-R2 evidence register

This register names evidence without copying private source data. The owner-only raw evidence remains outside Git under the ignored `.chrono-v3-private/` directory.

| Evidence class | Public representation | Private representation | Result |
| --- | --- | --- | --- |
| Repository identity and history | exact repository identity, visibility, branch/PR state, commit IDs, and aggregate counts | authenticated API responses and mirror inventory | public, non-fork review state; branches, tags, and fetched PR heads are scanned by the R2 publication gate |
| Public exposure | classification and method | bounded scanner reports and public-surface probes | P1 limited metadata exposure; no P2 confirmed and no P3 surface |
| Repository baseline | `baseline.md`, sanitized schema-2 `baseline-evidence.json`, and verifier output | full command records | frozen runtime hashes match; package metadata has only the typed `test-script-only-metadata-divergence` exception |
| Live package | hash-only measurements | stable discovery passes and comparison reports | source/dist/entrypoint content matches the frozen baseline; no live change performed |
| Settings and flags | bounded booleans and limits | sanitized settings projection | authoritative composition remains unchanged |
| Scheduler | aggregate artifact counts and permissions | owner-only directory inspection | no stale host-worker artifact at capture; no scheduler mutation |
| Affected session | alias, size, line-boundary counts, and reader bound only | streaming hash and boundary measurement | source untouched; no content emitted or materialized |
| Rollback | created, verified, used flags | owner-only backup | backup exists and is verified; no live switch performed |
| Tests and gates | commands and aggregate results | bounded command logs | ChronoCompact 294/294; publication verifier 40/40; baseline verifier 29/29; root result recorded after final gate |
| Review provenance | canonical review directory and status terms | read-only review prompts and reports | local secondary reviews are advisory; review 1 and review 2 are changes-requested records; R2 is ready for directing-assistant project-lead re-review |

## Gate separation

The content gate and public identity gate are independent. A passing content scan does not prove repository visibility, and public visibility does not permit private evidence. Event-scoped scans and canonical identity validation must both pass before a push or public review update.

## R2 scanner evidence

Schema 3 separates unique blob-byte scans from complete historical path/mode contexts. It reports commit, path-context, blob, worktree, and index counters, rejects unsafe or unsupported inputs, and fails closed on limits and malformed event payloads. CI uses the pull-request, push, new-branch, schedule, or manual-dispatch event scope rather than relying only on an all-ref scan. The sanitized machine-readable counters are in `baseline-evidence.json` and are refreshed after final validation.

## R2 baseline and timing evidence

The baseline verifier fails on dirty repositories by default. `--allow-dirty` is a read-only diagnostic seam used only by disposable mutation tests; neither CI nor root verification uses it. The package output contains no generic accepted metadata mismatch: runtime mismatches are `[]`, and the only accepted difference is the exact typed exception `test-script-only-metadata-divergence` for the package test script.

The readiness marker and scheduler barrier are test-harness-only changes. Serialization is also test-harness containment; it does not prove cross-agent runtime safety, fix the worker scheduler, or authorize a runtime change. Targeted concurrent runtime regressions remain an M01 scope.

This register is not an attestation that public history was retracted. M00 remains unaccepted, and M01 remains unauthorized until a fresh directing-assistant project-lead review records an explicit decision.
