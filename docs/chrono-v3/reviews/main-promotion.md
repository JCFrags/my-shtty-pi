# Chrono main promotion and local adoption

Status: 2.0.24 final qualification candidate. PR63 and the PR66 resulting-main correction are merged. Final CI, M11 qualification, approval, and deployment remain pending.

## Source reconciliation

The promotion starts at main `e4b4b6d5542515a852f4851034085665af87f14e` and merges M10 `ae0d72660b7b2dfa350a9663141879f35a3e8b6b`. That history contains M09 `910a51d0e3bc898a420fef23ea7491a728b54f15` and M08 `52c0d55bd6828326f23115c37d1abf67acd1f20b`.

PR59 imported the exact 2.0.15 runtime from `b5918dbf952423e86a50a71e03ae1996c4801ea5`, rather than merging the development history. Main then corrected five Chrono fixtures. The reconciliation compares each conflicting package file with that imported snapshot. It takes the finished development delta only where main was unchanged and preserves each later main correction. The extension registration assertion also adds the new manual logical-session command.

Main's supported-product verifier, workflow, native build prerequisite, repository lock, unrelated packages and historical capture verifier remain authoritative. The development branch's replacement workflow, scope classifier and obsolete baseline-verifier tests are not imported. They remain recoverable in the merged source history. Current root tests cover the retained self-contained package-tree verifier. Historical Chrono documentation and the public privacy scanner remain available.

After the promotion merges, PR45, PR46 and PR55 are incorporated through ancestry and superseded as separate promotion routes. Until then, their open/draft state is not acceptance. PR57 carries the append-only coordination update separately. Inclusion of M10 does not mark M10 or V3 complete.

## Integrated delta for final qualification

The candidate uses patch **2.0.24** because it packages the integrated M10 recovery and M12 guarded migration runtime after the 2.0.23 Pi API adaptation. It includes the M11 qualification harness, but no M11 scale result. The candidate retains these 2.0.23 compatibility changes:

- Pin Pi development dependencies to 0.85.1 and declare peers `>=0.85.1 <0.86.0`. Do not claim compatibility with the previous 0.84 API order.
- Adapt manual replacement to Pi 0.85.1, which starts the replacement extensions before `setup`. Prevent provisional logical replacement startup from initializing admission or scheduling work. Bind the completed manifest and continuation before the final replacement reload. Keep rollover manual and preserve refusal/recovery behavior.
- Replace the stale 2.0.3 extension version with the package version. Expose a bounded module-load identity through read-only history status: package version, API target, Node version, PID/start identity, entrypoint digest and deployment-manifest digest. This does not certify coverage or invent a source commit.
- Preserve main's five fixture corrections, update the command inventory for M10 and refresh exact package/runtime identity records.

No new scoring, extraction, retention or rollover feature is proposed. Existing M09 coverage gates and the 30,000-token combined ceiling remain unchanged.

## Reused evidence and limits

M09 2.0.21 push CI 34552481123 and PR CI 34552484213 passed. Its one isolated fresh Pi 0.84.2 canary used the normal hook, an independent regular Pi summary and a safe retained tail. It continued the real task and recovered exact source. That evidence is for its original candidate and API, not a new all-session activation claim.

M10 2.0.22 PR CI 34552665371 passed. Its original disposable replacement and switch-back evidence used Pi 0.84.2. The new-branch push qualification failure remains disclosed in the historical handoff. Installed-Pi compatibility requires the focused integration check described below.

The original large-session bounded campaign ended naturally after 6,653 jobs, known through 6,580, with `bounded-campaign-limit`. Its incomplete mandatory coverage does not qualify authoritative replacement. Source, working context, old stores, partial derivation progress and rollback remain intact. No campaign, comparison or provider call is repeated for this promotion.

## Candidate verification

The installed Pi 0.85.1 replacement fixture passed after one substantive correction. The first run exposed SDK bootstrap metadata before setup, so the empty-branch assumption was wrong. The corrected predicate reuses the existing fresh-canary policy only behind the exact one-shot M10 parent marker: at most 16 model, thinking-level or session-info entries, and no conversation or custom content. The fixture captures entry types outside Pi's error-catching callback and verifies replacement, post-bind reload and the retained session-switch assertions. It made no provider call.

The second short check invoked the compiled factory's `history_status` tool. It verified 14 registered tools, 12 commands, the manual logical-session command, a captured process-bound 2.0.23 identity and disabled canary authorization. It did not activate a live session. That evidence remains specific to 2.0.23. The 2.0.24 packaging build records every nested distribution module in a 134-record deployment manifest. The status mechanism is unchanged; final qualification and deployment must compare the complete manifest digest below.

Strict native source build and probe passed on Node 24.18.0 with native SHA-256 `baac38739b5e4c5137ea0514c451df58423c2e626f43cddcfb4542206f93d013`. The probe confirmed allocation refusal. Typecheck, generated build and root static verification passed. The root static gate ran its existing 18 indexed-input/integrity checks. No broad local runtime or scale campaign ran. Promotion CI 34567753311 failed on nine legacy mocks without the required `getSessionId()` method and one obsolete 2.0.3 diagnostic assertion. The correction supplies explicit synthetic session identities and checks the package version. Runtime artifacts and coverage guards remain unchanged. Existing behavior assertions remain in place. The corrected head requires fresh CI; no unchanged workflow retry or broad local rerun is used.

Generate `DEPLOYED.sha256` with bytewise `LC_ALL=C` path sorting. Locale-aware sorting can reorder names that differ near punctuation and change the manifest bytes without changing artifact bytes. Inspect the manifest diff and require unchanged rows to retain their prior order.

The integrated 2.0.24 package has 422 indexed files, Git tree `52d5b2e6fdaeed68f30da79cc9c8ce646c4559c3`, and 37 declared differences from the preserved M10 upstream package tree. The root verifier records every changed path and both available digests. New M11, M10 completion, and M12 files are tracked in the exact inventory.

| Artifact | SHA-256 |
| --- | --- |
| Package metadata | `10bfd2181fbe03e9bb57625d71b7970508aab670514b77b248620f1318141d93` |
| Package lock | `2bade90ba051db80b40884b6590c03fdef1981c4adf32ddb571c3cd8152d39bf` |
| Deployment manifest | `5a0661aab847753dcdb7ba8b9d45aa269ef21d027c3739b5999c90da54c940c0` |
| Entrypoint | `ebebe119ef38bef358b1a0185f32c970d8050768bf17f03fb75c3fa7855edae4` |
| Source tree, 134 files | `41b1d2c2622f610f08ef16839c664fe2266512b607d3546dfd1ff95778dc28ad` |
| Distribution tree, 133 files | `9dfd81919cfa04a4c94d6a076014e0039d6eda50c5fc4efd51059f3abbcd0ab7` |

Tree SHA-256 values use sorted directory-relative paths, NUL, file bytes and NUL. The source commit for approval is the exact promotion PR head, not the upstream M10 commit. The package tree and digest records avoid a self-referential embedded commit hash.

## Adoption policy

Shared selection is not loaded adoption. Before the swap, verify the accepted main artifact, native provenance, complete loader identity/order and scoped rollback. Change only the Chrono selection and its deployment authorization. Preserve other packages, browser/research resources and services.

Deploy exact session/source indexed-search rollout records for authorized live sessions. Explicit disable settings, unsafe records and private-source boundaries still take precedence. Records enable bounded background/indexed work, not authoritative composition. No activation slash command is required.

The existing fresh-session composer authorization remains separate. Ordinary existing sessions without that authorization report composer blocked, even if indexing is healthy. A session with mandatory gaps retains its working context. Do not infer eligibility from registration, zero lag or an old successful canary. A manual logical replacement does not inherit composer authorization.

Manual M10 rollover additionally requires its existing source, idle, pending-work, summary, coverage, safe-tail and ancestor-cut checks. It must not replace a session to hide unresolved obligations. No automatic rollover is enabled.

## Verification and session roster

Use at most two short checks for the meaningful integration delta: the installed Pi replacement lifecycle and the changed registration/loaded-identity path. Run existing required CI and artifact/build checks. Do not add a broad local campaign, force compaction or call a provider merely to fill a report.

Keep the exact roster private. Reconcile process-table and Herdr identities, including standalone processes, previously excluded owners and temporary workers. Record owner, process/start identity, Pi/Node version, selected and loaded artifact, tool availability, enablement, migration/coverage state and reload status. Historical receipts and exited workers do not count as live adoption.

Every reload requires a fresh owner handoff, natural settlement, empty editor, no active tool operation, compaction, pending switch or managed job, followed by exact reload confirmation and unchanged session identity. A reload can terminate managed jobs. Busy sessions remain pending until their safe checkpoint. Do not restart Herdr or its broker.

Final merge, installed identity and N-of-N adoption evidence are pending. The final roster must distinguish loaded, automatically available, indexing/catching up, composer authorization/coverage blocks and reload pending. Publish only safe owner-level counts and exceptions. Release all coordination windows after the verified handoff.

## Resulting-main readiness correction

PR63 required CI 34568765799 passed. Resulting-main CI 34571201308 failed the existing lifecycle fixture after its aggregate 10-second wait: catalog, capsules, index and memory were ready, while rollup was still running. The fixture now reuses `readyLayers()` at its four lifecycle boundaries. Each cold layer retains the existing finite 10-second deadline; repeated running ticks cannot extend it. Existing search, state, exact recovery, append, restart and branch-isolation assertions remain intact. Runtime artifacts and configuration are unchanged. The affected named fixture passed locally in 43.28 seconds across all four boundaries. No unchanged CI retry or broad local rerun is used.
