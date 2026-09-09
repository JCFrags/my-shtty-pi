# M06 incremental search candidate

Status: implementation candidate, not milestone acceptance. Keep the M06 PR unmerged into `rebuild/chrono-memory-v3`. Production selection remains accepted M04 2.0.5 until a separately recorded limited development canary. This report does not authorize other sessions or defaults.

## Accepted predecessor and recovery

- M05 accepted code/storage: `6a624dd5b6fd64365a3820b6e71c1f0242a35025`; PR38 merged into integration at `56f7f88c809b53c5de32413a18b0c166de636834` without an acceptance-only push.
- PR41 exact eleven-path inventory repair: `a1c867054438639e7675e632387d38d26acc3e3b`. All eight push and eight PR checks passed. PR41 merged into integration at `853f45eb72e3bff2dc791b39c17168655391505e`.
- The authorized production derivative preserved the accepted M04 commit, all 96 file pins, configuration projection, limits and gate logic. A fresh exclusive window permitted initialization and one normal installed-runtime catalog job. The window was explicitly released. COMMAND8 retains its separate release-acceptance decision.
- A post-job harness failed on the wrong import for `legacySchedulerDirectory`. The worker had succeeded. The correction inspected settlement only: no second worker job and no repeated initialization. Failure evidence and original recovery assets remain private and preserved.
- Public derivative diff and checksum relationships are in `m04-recovery/`. Redacted profiles are not executable production profiles. Never repin the recovery runner to M06.

## Delivered design

The real session lifecycle schedules bounded catalog ingestion, M05 derivation and M06 indexing separately. There is one active step and one coalesced replacement target. Cancellation settles before replacement. An incomplete JSONL tail waits for a later lifecycle event. Queries never schedule ingestion, rebuild indexes, or load lifetime JSONL.

M06 stores cue metadata and a raw lexical locator in SQLite/FTS5. Raw search reads persisted exact decoded M05 chunks, including text omitted from capsules. The authorized read-only `chunkSourcePage` API enumerates completed chunk sources without changing M05 schemas or reducer semantics. Generated retrieval bodies are not independent raw evidence.

Search handles bind the search and capsule identities, catalog generation, branch, cut and exact source. Query cursors also pin the index generation and query options. Results use source chronology after bounded selection. Exact expansion reauthorizes through M05. Raw JSONL recovery resolves an indexed event ID and checks the current catalog view before byte access.

`history_get` supports source handles, event/block lookup and bounded raw bytes. Partial raw records return base64 and an explicit byte cursor. `history_range` pages exact chronological source bytes with a branch/cut-bound cursor. A page contains at most 8,192 raw bytes. No large record is parsed just to recover it.

The feature defaults off. Existing compaction, summary, chronological replay and legacy off-path behavior remain unchanged. No model provider, embeddings, semantic observer or automatic recall agent is added.

## Focused verification

- Backend handoff `758a5615a3cdffb83be9e2d12d05d80604a91c05`, integrated as `c29a8b3`: two contained-worker scenarios passed in approximately 10.1 seconds. They cover capsule-omitted phrase search, exact recall/source lookup, explicit regex scans, append/restart, old index-generation cursors and real main/fork views.
- Backend boundedness correction `0c011c9beac39fc7432287389acf3717dbc623a6`, integrated as `8bbe93c`: ingest is capped at four enumeration pages (256 descriptors), primary-key transactions gate exactly-once FTS insertion, range uses keysets, and all queries apply per-segment cuts. Changed lexical/recovery plus enumeration checks passed in 4.87 seconds; the isolated enumeration/FTS-plan regression passed in 0.197 seconds; changed append/fork/keyset recovery passed in 6.76 seconds. These are affected-path checks, not a repeated broad campaign.
- Parent adapter scenario: one test passed in 18.1 seconds after a focused TypeScript correction. It uses the real lifecycle and contained workers, then exercises search, recall, decoded block, raw event, append with a pinned raw-range cursor, and sibling refusal. This duration reflects several real worker jobs rather than an ordinary pure-function case.
- Catalog history helper: scope refusal before source reads and exact split-UTF-8 byte reassembly passed. Lifecycle scheduler and validation-classifier focused checks also passed.
- The initial adapter compile failure is retained: a readonly capsule view needed an explicit mutable catalog-view copy; test assertions also needed type narrowing. No runtime test ran in that failed compile.

These are focused development results, not a new large-scale campaign. Historical M05 and earlier scale evidence retains its original runtime identity. No repeated full local root/native/heap sequence is claimed. Final candidate hashes, applicable CI and development canary evidence belong in the PR receipt after the substantive push.

## Explicit limits

- Current/superseded and unresolved inference belong to M07 and are unsupported. Episode/resource recall and neighbor expansion remain unsupported. Practical path matching normalizes slash, backslash and case, then matches an exact path or path-component suffix; this is not edit-distance matching.
- Regex requires an explicit bounded scan. Literal token-index results are explicitly non-exhaustive; use `scan:true` with exact mode for substring or punctuation coverage. Case-insensitive literal matching preserves original UTF-16 coordinates. Indexed candidate overflow returns a query-budget refusal rather than claiming complete search coverage.
- SQLite candidate materialization is capped and no longer sorts lifetime FTS results. SQLite can still traverse additional postings rejected by scope filters; no hard per-posting work budget is claimed. The M03 worker deadline remains the final interruption boundary for synchronous statements.
- Search currently retains zero result-cache bytes. SQLite and worker limits remain enforced; this is not a claim that all queries complete inside the budget.
- The focused backend fixture exercises the new chunk-source route but does not naturally produce the exact chunk-ready/capsule-unsupported state. That state has implementation coverage, not a separate forced-state test result.
- A pushed candidate, final artifact identities, CI receipt and limited live-use evidence are still required before delivery is complete. No M06 installation or loaded-version claim follows from a local build.

## Artifact and validation procedure

The first increment used version 2.0.6; the completion candidate uses previously unused 2.0.7, with 115 source files and 114 compiled JavaScript files. The source, compiled tree, entrypoint and package hashes are pinned in the baseline verifier and `DEPLOYED.sha256`. A build also emits ignored source maps; remove only those generated `dist/**/*.js.map` files before a local repository-identity check, because the deployed inventory contains JavaScript only. A clean checkout does not contain those maps.

Routine CI classifies exact event diffs, performs scoped publication checks, build/type checks, focused search checks and static baseline verification. Root metadata classification permits only the exact Chrono compiled-count transition from 107 to 114; unrelated metadata fails closed. Six classifier regressions passed in 0.91 seconds. Broad normal/replay/heap/root campaigns require explicit exact-head milestone dispatch. A new-branch push with an all-zero `before` refuses classification and requires PR qualification; it must not be retried unchanged or treated as a pass.

The local final artifact/static baseline check passed. A separate deployed-static invocation reached its all-ref privacy phase and was terminated at the caller's 90-second limit; it is retained as unfinished, not a passing gate. It was not retried. Required scoped publication and PR checks remain separate.


## Completion correction after the first development increment

The owner accepted the delivered M04 recovery evidence; initialization and recovery tests must not be repeated. M06 remains active and unmerged. The first 2.0.6 offline command-driven canary is historical evidence, not the required implementing-session rollout.

The completion candidate uses the previously unused 2.0.7 identity. Its read-only `history_status` and `/chrono-search-status` surfaces report cached layer progress, requested/indexed cuts, lag, validated last-ready availability and a safe error, without scheduling work or reading archives. `/chrono-search on|off` changes only the current session runtime; it does not write persistent settings or enable other sessions. Session replacement resets the override.

During append catch-up, the adapter retains one last-ready target. It serves that target only after the new catalog pin proves the old view is a prefix of the requested branch. A source/session/shard change or incompatible pinned branch discards it. Before that bounded validation completes, readiness is explicitly unavailable; the adapter does not guess that an unvalidated leaf is an append.

Indexed tool responses use one-result pages with continuation to keep ordinary default budgets usable. Exact recall omits a redundant handle and can reduce decoded text to the remaining budget, returning adjusted exact coordinates and a continuation character. A budget too small for even the verified source reference still refuses explicitly.

Backend correction `873be7c12ccf9962036a9d1710138356a8419a8f` was integrated as `ea25f751b870bb389af79ba65c56fcef4ab651c8`. Ranked spans now use verified source matches and real handle validation. Recall evidence labels come from stored provenance. Kind/tool/error filtering and bounded phrase/term relevance are implemented. Empty-event traversal stops after the existing event budget and persists its cursor. Search configuration identity advances to v2 for changed path/identifier derivation; old index files and M05 derivations are not rewritten.

Regex source anchors do not treat an internal chunk edge as a source boundary. Only ASCII literal alternatives and source anchors have a directly established exhaustive finite-width route. Other patterns report non-exhaustive window coverage. Lookarounds, lexical boundary assertions and patterns matching empty input refuse explicitly; zero-length matches are not emitted as recoverable spans. Arbitrary expressions have no exhaustive whole-body claim.

The two allowed local focused invocations are retained honestly:
- Backend: 3/4 passed in 14.97 seconds including compilation. The omitted-phrase fixture failed its prerequisite because a newly placed protected path caused the phrase to be retained. Moving that metadata to the beginning corrected the fixture.
- Combined backend/adapter: 4/5 passed in 26.21 seconds including compilation. All four backend cases passed. The adapter stopped at an over-strict new assertion that generated status output must have no search cue. The actual hit was correctly labeled generated and non-independent. The assertion now checks those required evidence properties; later adapter assertions did not run in this local invocation.

No third local runtime invocation was run. The corrected adapter fixture must pass applicable routine CI before activation. Build passed after the final runtime changes. CI, exact deployment identity and actual implementing-session use belong in the completion receipt; this section does not claim them.
