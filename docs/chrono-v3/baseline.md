# M00 baseline

## Selection

`BASELINE_SHA` is:

```text
eb9742c318a76eeaf753e87a620fae83ca9048d1
```

This is the committed local start selected for M00. It is three commits ahead of `origin/main` (`8b80aebdd3bd2780800880e88054e91c74824990`) and has no commits behind it. The ChronoCompact source tree is identical to `origin/main`; the extra committed work is existing Project Glance/root-verifier work, not a ChronoCompact runtime change.

M00 is built from this committed object in a clean execution clone. Uncommitted files from the separate source worktree are excluded. That worktree was preserved during the initial containment operation. A later boundary check found it clean at an externally advanced feature-branch commit; that external drift is not part of this baseline and was not edited here.

## Runtime comparison

The local baseline verifier (`scripts/verify-chrono-v3-baseline.mjs`) hashes relative paths and file bytes. It reported:

| Set | Files | Tree hash |
| --- | ---: | --- |
| committed `src/` | 66 | `f85564ddbf1f6d726d96b81dc9af65e22612245c83ec6d2a7dc6d444217d5ecc` |
| committed `dist/` | 65 | `58cad759fb0bac9f80f2642a3524adee4f7e6780b3626886fcc71a6698370c31` |
| live `src/` | 66 | `f85564ddbf1f6d726d96b81dc9af65e22612245c83ec6d2a7dc6d444217d5ecc` |
| live `dist/` | 65 | `58cad759fb0bac9f80f2642a3524adee4f7e6780b3626886fcc71a6698370c31` |

The live entrypoint hash is `282d5aab3846ad1e6b0d13baea8d357bd8908ab90dacff88ee8bc2bdfaf6fc50`, equal to the committed entrypoint. The package version is `2.0.0`. The independent containment audit used a different tree-fingerprint encoding; its source, dist, and entrypoint fingerprints also matched the repository content. The two tree-hash formats must not be compared numerically.

`packages/pi-chrono-compaction/DEPLOYED.sha256` has no runtime mismatch. Its only mismatch is the historical `package.json` metadata record: expected `56c6803348bcdd4b963c996e06e31e39edfb31568bc3672efcd9efe153e3b25d`, current `43b270792d5d95a03096f38d57ba2ca479d4999e3cb5c3e514232e040b3cf869`. The verifier accepts this documented metadata-only exception; it does not accept a runtime mismatch.

## Runtime settings at capture

The authoritative settings projection was recorded without model/provider names or private paths:

| Setting | Captured value |
| --- | --- |
| isolated local worker | disabled |
| incremental precompute | disabled |
| rollup shadow evaluation | disabled |
| background value worker | off |
| ranked search | enabled |
| editable memory | enabled |
| hybrid summary | enabled |
| cache | enabled |
| host worker slots | 1 |
| worker timeout | 900 seconds |
| worker nice level | 10 |

No setting, scheduler file, Pi agent, live package, or session JSONL was changed for M00.

## Session and scheduler boundary

The affected live session was analyzed only with a 1 MiB streaming reader. The reader did not materialize the file or emit records. It measured 205,035,658 bytes, 23,017 line-boundary records, a maximum line of 1,658,763 bytes, and a complete final line. The session content, identifier, and path are excluded from Git and from this document.

The host-worker scheduler directory was owner-only (`0700`) and contained no artifacts at capture. No value-worker scheduler artifacts were present.

## Safe failure-code boundary

No live failure was induced during M00. The characterization suite exercised these safe outcomes: `worker-disabled`, `worker-timeout`, `worker-aborted`, `worker-crashed`, `branch-not-persisted`, `invalid-cut`, `source-changed`, `shadow-invalid-cut`, `shadow-source-changed`, and `shadow-memory-gate`. The current protocol contains 16 general worker codes and 22 rollup-shadow codes; private evidence records the complete vocabulary without any raw error message, stderr, source path, or session content.

## Toolchain and tests

- Node.js `v24.18.0`
- npm `11.16.0`
- Pi `0.84.2`
- TypeScript `5.9.3`
- ChronoCompact package `2.0.0`

The restored suite contains 55 historical test files, with 54 in the runnable test project. `incremental-context.test.ts` is retained as an explicit compatibility boundary but excluded because the selected source tree does not contain its former runtime module. `npm run test` passed 294/294 tests.

## M00 acceptance boundary

This document establishes provenance and evidence. It does not authorize deployment, a live reload, a release, a public repository, a force push, history rewrite, merge to `main`, or M01 work.
