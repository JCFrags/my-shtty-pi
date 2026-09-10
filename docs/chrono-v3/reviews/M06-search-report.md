# M06 incremental search candidate

Status: M06 accepted by the directing assistant at `a4ad86c1fff3c28a5f27eee739a6508afb9181ed`, deployed and loaded as 2.0.9. Actual development-session indexed search → recall → exact recovery succeeded with explicit prefix coverage. PR42 merged only into `rebuild/chrono-memory-v3` at `6ac27c2def386ccaeb03d8ef0e1c208504f4c9f3`, using applicable existing checks and no acceptance-only push. Older candidate statements below are historical evidence, not current acceptance or deployment status.

Full archive catch-up and release-scale qualification remain incomplete. At ordinary M07 work boundaries, indexed coverage advanced from cut 113 to 1,265 while the requested cut grew from 13,640 to 13,681. This is continuing catch-up, not a stalled worker or complete archive coverage. The accepted indexed prefix remains usable. The peer declaration is still `>=0.84.2 <0.85.0`; observed Pi 0.85.1 use does not establish broader declared compatibility. Later large-archive qualification remains separate.

M07 is authorized and in development on `work/chrono-v3-m07-state`. Its first substantive increment carries this acceptance record. M07 must remain unmerged for directing-assistant acceptance; authoritative compaction remains unchanged until M09. No other sessions or defaults are authorized by this report.

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

The owner accepted the delivered M04 recovery evidence. The later post-boot authorization below is a separate recovery scope; it does not repeat or replace that accepted evidence. M06 remains active and unmerged. The first 2.0.6 offline command-driven canary is historical evidence, not the required implementing-session rollout.

The completion candidate uses the previously unused 2.0.7 identity. Its read-only `history_status` and `/chrono-search-status` surfaces report cached layer progress, requested/indexed cuts, lag, validated last-ready availability and a safe error, without scheduling work or reading archives. `/chrono-search on|off` changes only the current session runtime; it does not write persistent settings or enable other sessions. Session replacement resets the override.

During append catch-up, the adapter retains one last-ready target. It serves that target only after the new catalog pin proves the old view is a prefix of the requested branch. A source/session/shard change or incompatible pinned branch discards it. Before that bounded validation completes, readiness is explicitly unavailable; the adapter does not guess that an unvalidated leaf is an append.

Indexed tool responses use one-result pages with continuation to keep ordinary default budgets usable. Exact recall omits a redundant handle and can reduce decoded text to the remaining budget, returning adjusted exact coordinates and a continuation character. A budget too small for even the verified source reference still refuses explicitly.

Backend correction `873be7c12ccf9962036a9d1710138356a8419a8f` was integrated as `ea25f751b870bb389af79ba65c56fcef4ab651c8`. Ranked spans now use verified source matches and real handle validation. Recall evidence labels come from stored provenance. Kind/tool/error filtering and bounded phrase/term relevance are implemented. Empty-event traversal stops after the existing event budget and persists its cursor. Search configuration identity advances to v2 for changed path/identifier derivation; old index files and M05 derivations are not rewritten.

Regex source anchors do not treat an internal chunk edge as a source boundary. Only ASCII literal alternatives and source anchors have a directly established exhaustive finite-width route. Other patterns report non-exhaustive window coverage. Lookarounds, lexical boundary assertions and patterns matching empty input refuse explicitly; zero-length matches are not emitted as recoverable spans. Arbitrary expressions have no exhaustive whole-body claim.

The two allowed local focused invocations are retained honestly:
- Backend: 3/4 passed in 14.97 seconds including compilation. The omitted-phrase fixture failed its prerequisite because a newly placed protected path caused the phrase to be retained. Moving that metadata to the beginning corrected the fixture.
- Combined backend/adapter: 4/5 passed in 26.21 seconds including compilation. All four backend cases passed. The adapter stopped at an over-strict new assertion that generated status output must have no search cue. The actual hit was correctly labeled generated and non-independent. The assertion now checks those required evidence properties; later adapter assertions did not run in this local invocation.

No third local runtime invocation was run. The corrected adapter fixture must pass applicable routine CI before activation. Build passed after the final runtime changes. CI, exact deployment identity and actual implementing-session use belong in the completion receipt; this section does not claim them.

## Authorized post-boot recovery and automatic resume

The owner subsequently authorized a separately Git-pinned recovery for installed 2.0.7, preserving the original 2.0.5 recovery profile, helper and rollback assets. All 115 installed runtime manifest records were verified against Git-derived hashes from `215ac43e9582ef357f95219334ac9f05c066965f`. The namespace, gate, systemd and resource-limit APIs have no source difference from accepted M04. The separate private recovery derivative is prepared, not applied. PR43 placed a fresh COMMAND 8 window request on `main`; a request or merged board entry is not a grant. One ordinary installed worker operation, settlement and explicit window release remain required.

The new candidate persists rollout only for an exact session ID and source-path identity. It reads one bounded owner-only record outside history during normal session loading. Missing records retain defaults; unsafe records disable rollout. An explicit environment/configuration disable takes precedence. Optional `/chrono-search on|off` writes only that session record; no activation command is required after normal loading. Session changes invalidate pending reads and callbacks. No history source, regular Pi summary, provider configuration or global feature default is changed.

A separate bounded startup process reads a trusted deployment authorization. It verifies exact package manifest hashes, canonical package binding, configuration projection and unchanged limits before importing runtime APIs. A fixed owner-only OS lock serializes startup across deployments. A verified current-boot gate is reused without interrupting legitimate work. Fresh initialization requires both namespaces absent, fixed units inactive and repeated bounded worker-quiescence checks. Unsafe, partial, foreign or ambiguous state refuses without cleanup or migration. Startup authorization is not stored in source history or inferred from a session message. It must be created by the authorized deployment procedure from the exact pushed Git identity.

Two focused invocations were allowed for this new batch:

- First: 1 pass and 4 failures in 0.14 seconds. A runtime manifest check incorrectly assumed `package.json` sorted before `dist/`. It was corrected to membership validation. The failure is retained; it was not a passing startup check.
- Second: 7/7 passed in 12.80 seconds. It covered fresh initialization, concurrent repeat/reuse, unsafe authorization, partial state, a foreign artifact and malformed ticket metadata. Two fresh offline Pi processes used normal extension loading and a persisted exact-session rollout, without an activation command, then completed actual registered-tool search, recall and exact recovery. The fixture also checks another session is not opted in and explicit disable persists.

The second check uses isolated scheduler namespaces and synthetic history. It does not prove production recovery or successful retrieval in the implementing development session. No third local runtime invocation, review agent, reboot test or broad campaign was run. Required build/artifact/publication checks and applicable routine CI remain separate. PR42 stays unmerged; M06 is not accepted and M07 has not started.

### Delivery artifact and current recovery result

The automatic-resume artifact is 2.0.8: 119 source records, 118 compiled JavaScript files and 119 deployed manifest rows. Source tree: `551230f6faee5a78a7f46a1c42aab15fe6ce6aa8cbbc2afe3a489bbc0d6c869a`; compiled tree: `3e8a97e5d74ef1b7fa9dd089e1efc62ac9ecc5551b16b9af7a410c70f968b33c`; entrypoint: `d059190f64cf12126da96785881d53541c756f6d52c50ea5b4e21655106d7c31`. Exact count classification must cover both the integration PR base (107) and preceding pushed candidate (114), each ending at 118; unrelated metadata still refuses.

Build and focused static identity checks passed. The deployed static verifier first timed out at 120 seconds. Its longer invocation completed privacy in 597,769 milliseconds, then identified a missing startup graph root. That exact graph-root metadata was corrected; the expensive verifier was not repeated afterward. Applicable routine CI remains required. Protected workflows are unchanged; existing CI selects the extended automatic-resume adapter fixture, but does not directly select the new startup fixture already covered by the local result above.

COMMAND 8 explicitly granted fresh window `command8-chrono-207-recovery-20260909-01` through the existing direct channel. After fresh Git-derived identity, registration/rollback, configuration, boot, fixed-unit and quiescence checks, the installed 2.0.7 recovery succeeded. Exactly one ordinary catalog worker completed, reading 360 bytes and two records. Settlement showed zero active jobs, queued jobs and malformed artifacts, with the current-boot legacy gate verified. Only the task fixture was removed; no production namespace cleanup occurred. The lead explicitly released the window. This proves installed 2.0.7 recovery, not installation or successful implementing-session use of 2.0.8.

## Source recovery and bounded-prefix correction (2.0.9 candidate)

The authorized data-only repair verified all 1,033 contiguous recorded SHA-256 spans (66,774,791 bytes) before and after publication. Two contained ingestion jobs observed the same current device/inode. This establishes a stale binding, not why the device identity changed. Existing staged recovery rebuilt and integrity-checked 68,465,656 bytes, matched 12,968 prior event rows, and published cut 13,422 with the original expected-owner check. The source and all old stores remain intact; an explicit old-store request still refuses its stale binding. Final-job record counts are not total catalog or search coverage.

Normal settlement resumed indexing without activation or reload: catalog ready, requested cut 13,449, capsules lagging, index pending, no safe error, persisted enablement and healthy startup reuse. A bounded head read showed derivation at event 207. This did not establish successful search.

The 2.0.9 adapter now fully derives and indexes catalog-pinned prefixes of at most 16 committed branch events before serving them. Requested cut remains the actual full pin; indexed cut and lag describe only the searchable prefix. Search/status do not start ingestion. Existing whole-view heads cannot be rewound. The explicit new `chrono-m06-capsule-prefix-v1` configuration identity therefore uses separate derived/search routes and preserves the old routes without cross-identity artifact adoption. The real ingested branch key is unchanged. Restart restoration validates the persisted search cut and hash against a fresh catalog page/pin; incomplete index restoration also requires exact capsule readiness. Incompatible views refuse rather than redirect.

The two focused invocations for this correction are exhausted:

- First candidate failed `catalog-branch-mismatch`: a different branch label was invalid, not a permitted lineage alias. That candidate was reverted and never deployed.
- Second: existing append/fork and exact recovery passed in 24.727 seconds. The prefix fixture timed out at its 10-second deadline while capsules were still lagging without an error; total invocation 36.340 seconds. Its waits were changed to bounded 60-second waits, preserving assertions. This correction is not a passing runtime result. Exact routine CI must qualify the final fixture; no third local invocation was run.

Build passed. Artifact counts remain 119 source records, 118 compiled JavaScript files and 119 deployment rows. The frozen charter, protected workflow, resource limits, M05 schemas and reducers are unchanged. Actual-session prefix search → recall → exact recovery remains required after qualified deployment. PR42 remains draft/unmerged; M06 is not accepted and M07 is unstarted.

## M07 development candidate (2.0.10, not accepted)

The next substantive increment adds bounded episode membership, source-backed
state and resource observations through the existing contained search worker and
`history_recall`/cached status. It does not replace authoritative compaction.
The SQLite store binds catalog/capsule/search identities and physical routes;
per-source generations preserve old branch-cut reads across later writes.
Episode closure means a chronological span ended at another original request,
not that the earlier task succeeded. Resource mentions preserve declared versus
unknown revisions; neither a tool-result hash nor a declaration proves the current
file revision or validation freshness. Queries validate the catalog view but never
ingest. Exact decoded recovery and original-entry IDs accompany displayed memory.

Materialization handles at most eight capsules per job, with bounded exact raw
role/tool metadata (64 KiB event), decoded bodies (32,768 UTF-16 units), source
reads (8 MiB), and the existing contained-worker limits. Oversized or unknown-role
records remain partial. Memory jobs run behind search catch-up. The first search
prefix remains 16 branch events; later prefixes coalesce at most eight existing
16-event page calls before one pin/publication. Store/configuration identities and
already committed progress are unchanged. No measured speedup is claimed yet.

Two local runtime invocations were used, with failures preserved:

1. The engine fixture failed at first materialization (0/1, 1.39 s): 15 SQL
   placeholders for 14 state columns. The implementation was corrected without
   an unchanged rerun.
2. The integrated invocation ran the engine fixture and one existing real
   lifecycle scenario (38.15 s). The lifecycle scenario passed: contained worker,
   state/resource/episode recall, exact memory recovery, append, restart and
   branch isolation. The engine fixture failed because it required every resource
   observation to have a declared revision, including an assistant report with
   none. Its assertion now requires that report to retain a null/unknown revision.
   This assertion correction awaits routine CI; no third local invocation ran.

Final source and test-build compilation passed. Parent integration also corrected
source-exact lookup, cut-bound generations, path punctuation, conditional approval
handling, and conservative resource freshness. Routine CI and deployment remain
pending at this checkpoint. No startup suite, full local suite or scale campaign
was repeated. Live 2.0.9, automatic rollout, source stores and rollback are unchanged.

Remaining limits: extraction is deterministic and conservative, not semantic task
understanding. Compound prose can omit secondary claims; episode retrieval pages
members rather than returning an unlimited narrative. Existing editable-memory
and retention tools remain intact, but their custom metadata mirrors are not yet
materialized by this body-capsule path. Large-archive qualification and full live
catch-up remain outstanding. These are not claims of M07 acceptance.
