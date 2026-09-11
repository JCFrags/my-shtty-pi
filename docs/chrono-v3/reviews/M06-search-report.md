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
   This assertion correction passed PR routine CI at `647e369`; no third local invocation ran.

Final source and test-build compilation passed. Parent integration also corrected
source-exact lookup, cut-bound generations, path punctuation, conditional approval
handling, and conservative resource freshness. PR run `34430157110` passed all ten
applicable statuses at `647e369`. The initial new-branch push was refused by the
existing zero-before-SHA classifier; it was not rerun or reported as successful.

A subsequent read-path correction keeps recall coverage conservative when a page
stops inside an event or a cursor pins an older generation. Recall must use the
visible committed cut, not the latest head's event counter. The existing engine
fixture now compares partial materialization and recall coverage. Responses also
state that custom metadata is outside body-capsule coverage. Source/test compilation
passed; routine CI must verify this correction. No additional local runtime test,
startup suite, full local suite or scale campaign ran. Deployment is pending;
live 2.0.9, automatic rollout, source stores and rollback are unchanged.

Remaining limits: extraction is deterministic and conservative, not semantic task
understanding. Compound prose can omit secondary claims; episode retrieval pages
members rather than returning an unlimited narrative. Existing editable-memory
and retention tools remain intact, but their custom metadata mirrors are not yet
materialized by this body-capsule path. Large-archive qualification and full live
catch-up remain outstanding. These are not claims of M07 acceptance.

## Consolidated M07 completion and M08 authority

The directing assistant keeps M07 open at deployed `3ef58e7` (2.0.10).
Both exact-head push and PR checks passed all ten statuses. Actual development
use returned an episode, qualified unresolved assistant-report state, and a
resource observation with unknown revision/freshness. Exact episode-source page,
complete state block and complete resource-entry recovery succeeded. Manual
handle transcription failures were preserved; they were not successful recovery.
The observed coverage was search 3,252 / 14,172 and memory through 148, not a
whole-archive result. Source, previous stores and scoped 2.0.9 rollback remain.

The completion batch corrects proposition identity, tool outcome fidelity,
explicit restriction transitions and historical-record visibility. It integrates
the actual custom-event writers and enclosing-episode expansion. Changed M07
semantics use a new derivation identity; catalog, capsule and search progress
must not reset. Old memory pagination must refuse a ruleset mismatch rather than
silently apply the old generation to a new store. Metadata recovery uses bounded
catalog-selected, hash-verified raw source references. Runtime check results and
final artifact qualification will be recorded with the substantive completion.

M08 implementation is now authorized directly after corrected pushed M07 and
relevant focused checks, on a stacked branch and draft PR. Both PRs remain
unmerged for directing-assistant review. This does not accept M07 or authorize
M09 activation. No authoritative compaction change, full backfill claim, new
model, review-only agent or scale campaign is part of this completion batch.

Completion checks (2.0.11 source batch): the lifecycle/identity fixture passed
1/1 (95.5 ms invocation); the persisted metadata/historical-cut/episode fixture
passed 1/1 (882.2 ms invocation). These are the two authorized local runtime
checks; no third invocation or broad suite ran. Parent integration added explicit
cut filters, held metadata behind the fully processed body frontier, corrected
FTS keyset aliases and suppressed future transition fields. It also preserved
ordinary-memory demotion through touch, refused non-writer-shaped metadata and
prevented duplicate mirrors from rewinding the hash chain. These subsequent
small corrections compile; routine CI supplies their runtime verification.

The metadata path accepts only ordinary writer contracts. Custom type, sourceRef
and hash-chain consistency are not producer authentication and never establish
user/project authority. Unsupported protected-authority mirrors remain partial,
not promoted to instructions. Episode cues for inactive metadata omit its derived
text while retaining exact archived recovery. Missing/oversized metadata remains
partial. The candidate uses `state-v2.sqlite` and ruleset v2 alongside preserved
v1; search and capsule identities are unchanged.

## First M08 bounded rollup increment

Corrected M07 2.0.11 (`5073892`) was installed and normally reloaded after
both focused checks and both ten-status CI runs passed. Actual development
use recovered an episode and an exact source page; state recall returned
qualified source-backed unresolved work. At the observed work boundary,
search covered 6,964 of 14,464 events, and corrected memory covered 456.
Metadata ingestion was progressing, but that prefix had no accepted custom
memory/retention events. Actual metadata recovery is not claimed. PR44 is
unmerged and M07 is not self-accepted.

The stacked M08 increment adds a separate `rollup-v1.sqlite` store. Immutable
closed episode fragments feed an eight-way frontier. Jobs admit at most eight
leaf pages, eight members per leaf, 64 created nodes and 8 MiB source reads.
Nodes are limited to 64 KiB. Publication handles pin branch, cut, state
and rollup generation. Descendant expansion verifies an ordered path from
the pinned root. Recall visits at most 24 nodes and pages exact sources
individually. Closed intervals are not completed tasks. Protected and advisory
metadata omissions remain explicit; children and exact source references
retain the detail. Bounded query traversal reports its limitation and offers
root browsing. This is outside authoritative compaction; M09 is inactive.

The adapter exposes `history_recall` with `level="rollup"` and cached rollup
status. Automatic shadow work waits for a completed memory prefix, then
alternates bounded rollup and memory work without changing search limits.
Read-only resume checks reuse existing publications. A missing store receives
a distinct status error; unsafe occupied paths are not treated as missing.

Local M08 runtime allowance is exhausted (two invocations). The first check
found a 15-placeholder insert into a 14-column node table. That was corrected.
The second invocation passed the persisted rollup/source/pin fixture (1.24 s)
but failed adapter readiness (6.09 s). Inspection identified that SQLite's
missing-path open reports an unsafe-path error, preventing fresh automatic
materialization. Status now distinguishes ENOENT before open; creation still
performs the existing safety validation. Build and test compilation pass.
The corrected adapter path awaits routine CI, not another local runtime run.
No M08 deployment or actual rollup use is claimed yet. Existing deployment,
rollback chain, source history and older stores are unchanged.

Artifact verification: the static Chrono source/dist/manifest check passed.
Local root verification did not finish its all-ref privacy phase within the
caller deadlines (30 s for an initial incorrectly unscoped invocation, then
240 s for static-only). Neither run completed root verification; no package
runtime suites were reached. Full root qualification remains a CI gate.

## Accepted M07 and M08 pinned-prefix correction (2.0.13 candidate)

The directing assistant accepted M07 at `5073892eac0208e6216c91b5cd83275767e1ae2c`.
PR44 merged only into integration at `72dc8dea31b6bce846e2fc08b2f4aec5c8d135f3`.
PR45 now targets integration; normal ancestry reconciliation preserves published
history. PR45 remains unmerged. M09 implementation and same-session shadow
preview are authorized, but authoritative compaction activation is blocked.

The preceding 2.0.12 push and PR CI each passed all ten statuses. Installation,
loader parity, scoped rollback and actual-session automatic enablement passed.
Actual recall returned `search-v3-rollup-store-missing`: waiting for a complete
memory head prevented useful closed-prefix publication during catch-up.

The correction pins the common fully processed body/metadata cut, one state
generation and a compatible full source view in the existing frontier cursor.
Only closed episodes and members visible at that snapshot are exported. The
first leaf fragment can publish immediately; continuation retains its pin even
when the requested view grows. Completed cycles retain their position and repin
without resetting any store. Empty eligible input persists an exhausted cursor
and reports the condition without forcing an episode closed. Status separates
requested cut, processed cut, represented closed range and remaining work.
Immutable memory/retention hints are historical, not current instruction authority.
The scheduler alternates bounded memory/rollup jobs while search continues; it
compares processed cuts rather than complete-head or changing-generation gates.

One local correction regression invocation failed after 3.03 s before rollup
assertions: its expanded fixture incorrectly treated per-job accepted metadata
counts on the final materialization page as lifetime counts. The fixture now
accumulates those counts across its existing bounded loop. No local runtime
rerun was performed; routine CI must validate the corrected fixture. Source and
test TypeScript compilation passed. Active compaction, source archives, stores,
automatic rollout, worker limits and rollback points are unchanged. Actual
2.0.13 publication/use is not yet claimed.

## M08 actual publication and M09 shadow composition work

The 2.0.13 exact deployment `52c0d55bd6828326f23115c37d1abf67acd1f20b`
passed push and PR CI, ten statuses each. Scoped registration, candidate/installed
loader parity and rollback to 2.0.12 passed. After the coordinated normal reload,
automatic materialization published a closed range covering events 4–61 at
processed body/metadata cut 5,343, state generation 5,706 and rollup generation 1.
The requested cut was 15,135 and indexed cut 12,084. Remaining eligible episodes
and later memory were explicitly pending. Root, child and source traversal then
recovered 300 exact UTF-16 units from the selected event. Several agent handle
transcription errors refused `search-v3-reference-invalid`; an entry-ID-only
request required byte pagination. These failures did not change the stores.
The final exact opaque source handle succeeded. Private source content is not
included here. Closed coverage does not imply task completion or current authority.

M09 work adds a bounded read-only state selection operation, a composition core,
and an explicit recorded-compaction preview function. The adapter pins a compatible
already-cataloged prefix and performs one contained selection without ingestion.
The preview reuses the recorded separate Pi summary and baseline at the same cut,
checks at most 256 retained entries within 512 KiB, and applies existing tool-pair
cut validation. Missing boundary evidence refuses without reconstruction or a
provider call. Detailed selection, rendered output, comparison and section totals
are persisted outside Pi history in a private content-addressed artifact. This
function does not register or replace an authoritative compaction hook.

Mandatory propositions retain their full selected text. Incomplete coverage keeps
supported historical items with explicit historical labels, never a complete current
contract. Budget fallback reports omitted mandatory coverage. The first preview path
has no synchronous delta reconstruction and no older-rollup selection, and therefore
uses an explicit degradation path. The explicit `/chrono-composition-preview [compaction-entry-id]` command uses
already-loaded entries and the contained adapter. Discovery is limited to 256
current-branch entries. It saves the artifact under the private configuration sibling
`chrono-compositions/<hashed-session-id>/` and emits only a UI receipt, not a Pi
history entry. This is a preview command, not an activation command. The real
same-cut preview remains pending. No M09 deployment or acceptance is claimed.

Two focused local M09 checks passed: core composition, byte preservation, chronology,
lag degradation and mandatory budget behavior (3.47 ms test body), then recorded-cut
preview, private persistence and pre-selection unsafe-tail refusal (10.84 ms test
body). Source/test compilation passed. This uses the two-check M09 allowance;
remaining validation belongs to routine CI, not repeated local runtime checks.
Active compaction, first tool-result delivery, model/provider settings, rollout,
source stores and rollback remain unchanged.

## M08/M09 continuing publication and producer completion (2.0.15 candidate)

The authorized bounded diagnostic established `search-v3-rollup-node-limit`,
not database corruption. The SQLite transaction boundary had sanitized that
known application code. A nine-code exact allowlist now preserves code-only
errors while unknown exception messages remain sanitized. Rollup fitting reduces
optional summaries, metadata copies, and protected copies within the existing
64 KiB limit. It preserves ordered children, source references, immutable nodes,
and explicit omission counts. Recall also pages by response bytes, not only count.

The corrected contained materializer published generation 2 at common cut 5,343,
extending represented closed history from events 4–61 to 4–639. Generation 1
and its handles remain preserved. Root/child/episode traversal recovered 300
UTF-16 units from event 69 under its exact source hash. Further publication
remains pending. These are bounded development-use results, not full backfill.

The stored selection now includes successive recent episode members, bounded
older obligation-linked episodes, and up to 64 committed delta records. Excess
lag uses an independently pinned recent suffix without certifying the gap.
Existing metadata writers still require maintained materialization. Exact
zero-omission evidence is accepted. Nonzero surrounding omissions require
verified complete bounded context. Conditions, negation, source coordinates,
and speaker authority remain distinct from exact text fidelity. Oversized or
unsupported clauses remain explicit coverage gaps, not absent obligations.

The composer reserves known restrictions and pending work before optional
history. It removes duplicate optional source representations without collapsing
distinct mandatory text. Historical rollups do not have to reach the current
cut; maintained older episodes are also eligible. Processing lag, unsupported
extraction, selection omissions, and render-budget loss are reported separately.
The regular Pi summary and safe tail remain unchanged, with the tail counted
once under the 30,000-token combined ceiling. Composer-local serialization
preserves shared validation objects and distinguishes payload and final artifact
hashes. Shared hash contracts and old artifacts are unchanged.

The normal-return adapter is connected to the same stored composition path but
hard-disabled pending output review. It returns only summary, cut, minimal
provenance, and a private artifact reference. It cannot replace authoritative
context when mandatory coverage is incomplete. No active compaction, provider,
first-result delivery, global configuration, or unrelated session changed.

Exactly two local focused checks were used in this completion batch. The extended
rollup fixture failed on a response-size limit after publication succeeded. The
established recall paging cause and its fixture continuation were corrected;
there was no local rerun. The actual M07 producer → stored selection → rendered
and persisted composer fixture passed in 4.033 seconds. Subsequent deduplication,
context-budget, and historical-rollup corrections await routine CI. CI now runs
the existing composer tests alongside search/memory contracts and emits the
public-safe synthetic rendered fixture to its log and job summary. No private
history is exported. No broad local campaign or reviewer agent was added.

This candidate includes the separable M08 source correction `734df6c` on the
M09 stack. PR45 and PR46 remain unmerged. The prior 2.0.14 same-cut comparison
showed severe historical lag and no rendered protected/open-work rows; it is not
current acceptance evidence. Exact candidate CI, deployment with scoped rollback,
and an updated private same-cut comparison remain required before completion.

## M09 original-cut comparison and early normal path (2.0.16 proposal)

Installed and loaded 2.0.15 at `b5918dbf952423e86a50a71e03ae1996c4801ea5`
remains the fixed nomination under review, not an accepted release. The isolated
2.0.16 source is a proposed replacement. No shared registration, configuration,
reload, or authoritative composition change accompanies this proposal.

Explicit historical IDs now use current-view catalog membership and verified
selected bytes, including comparison with the loaded entry when available.
Sibling targets refuse before raw reading. No-ID discovery still stops after
256 parents. One selected record uses the existing catalog source-read budget
and 32 KiB pages. The separate 512 KiB comparison-string and retained-tail limits
are unchanged. Applying the comparison-string limit to the whole legacy record
was an unpublished implementation error: unrelated legacy details made the
actual record larger than its rendered comparison input.

A private driver invoked frozen 2.0.15 `previewStoredCompaction` exactly once for
the original compaction, summarized-prefix cut 15,307 and first-kept cut 15,308.
This was not the installed slash command. Owner-observed `history_status`
validated the current branch view at 15,969 before and after the operation.
Catalog membership, selected recorded bytes, source file identity, original
artifact hash, summary inputs, and retained-tail boundary were checked. New
appends were not treated as selected historical input. Earlier driver gate
failures remain preserved: full-file equality rejected normal append lag;
a bounded append inspection refused; a copied materializer-only `limit` field
failed the selection request contract. None invoked the composer. The corrected
request passes the existing validator and does not change a worker limit.

| Original-cut result | Earlier 2.0.14 preview | Frozen 2.0.15 preview |
| --- | --- | --- |
| Selected memory generation | 7,318 | 13,077 |
| Memory processed through | 7,494 | 15,307 |
| Memory lag at target | 7,813 | 0 |
| Rendered summary tokens | 4,164 | 5,806 |
| Identical retained-tail tokens | 5,883 | 5,883 |
| Combined tokens | 10,047 | 11,689 |
| Protected section tokens | 0 | 0 |
| Open-work section tokens | 0 | 1,438 |
| Recent section tokens | 1,410 | 1,457 |

The unchanged original representation is 23,430 summary tokens plus the same
5,883-token tail, totaling 29,313. Regular Pi summary input remains 2,500 tokens.
Newer memory processing is a comparison variable, not identical conditions.
The new output has seven open-work rows spanning events 14,592–15,203 and five
ordered recent rows at 15,303–15,307. Recovery handles remain attached. No older
or delta rows were rendered; no selected row was lost during rendering.

This is **not activation-eligible**. Both mandatory coverage flags remain false.
The seven open-work rows are tool failures or assistant progress text, not
established user obligations. Recent rows show CI/worktree preparation rather
than a complete request-to-correction experience. No protected restrictions
were selected. Fully processed history at this old cut does not establish
complete extraction or current-session completeness. These gaps are not waived.
The synthetic eligible path must not be presented as actual producer eligibility.

The normal hook now runs before legacy retention, memory reads, generation
hashing, sidecars, and replay planning. It uses the actual Pi-prepared boundary,
one independent Pi summary, the same stored composer, and private persistence.
Success returns only the combined summary and minimal composition envelope,
without duplicate Pi summary text or detailed plans. Invalid boundaries cancel.
Selection failure uses the unchanged Pi summary and validated prepared tail only
within 30,000 tokens, otherwise cancels. Session/leaf drift or abort cancels.
The enabled new path never falls through to lifetime reconstruction. The
replacement flag remains false and cannot be enabled by user configuration.

The two authorized focused checks passed. The first covered a target beyond 300
later events, sibling refusal before source reading, and mismatched/noncompaction
refusal. The second exercised the actual early hook, real normal composer and
private persistence with synthetic complete evidence. It preserved the separate
summary, protected obligation, open work and safe tail while making legacy
session-file access throw. It asserted the minimal details envelope and one
summary/composer call (21.749 ms test body). No broad local suite or extra model
call was used. Compilation passed; exact-head routine CI remains the release gate.

At an ordinary observation boundary, memory and rollup processing reached 15,969,
with rollup generation 234 and closed represented range 4–15,827. Earlier member
cursor observation advanced beyond 15,789; this is continuing publication, not a
stall inferred from generation counters. The remaining state was no eligible
closed episode. Old publications and stores were preserved.

A metadata-only inspection mistakenly emitted nested private row text into the
local Pi conversation. No secrets were apparent and no private prose was sent to
Git or a PR. The output boundary was breached; no deletion or history rewrite was
attempted. Subsequent exports must explicitly project nested scalar fields,
never print whole nested rows. Detailed artifacts and failure receipts remain
owner-only. Public reports contain structural evidence only.

### M09 category coverage correction (2.0.17, staged only)

The frozen installation remains 2.0.15. This candidate reserves 16 restriction
rows and eight work rows before SQL limits, preserving the combined 24-row cap.
User goals and pending approvals precede assistant reports and incidental tool
failures. Restriction and work overflow flags are independent. Response trimming
removes optional history and work before restrictions; all losses remain explicit.

A bounded private trace at cut 15,307 found original user restrictions in stored
extraction and selection, but their full-source context expansions did not fit the
response budget. Rendering then refused the incomplete clauses. The shared quota
also retained many later failure rows. No private source prose is included here.
The corrected path reserves response space before enrichment and verifies whole
blank-line paragraphs, preserving wrapped conditions and exceptions. A paragraph
that cannot fit remains unsupported; exact copying does not establish authority.

State schema/rules v3 records cut- and generation-bound restriction, work and
optional extraction gaps. Indexed gap lookups replace cumulative partialCount in
mandatory eligibility. Optional gaps remain reported but cannot invalidate an
unrelated category or an earlier pin. This is supported syntactic/source coverage,
not semantic completeness. Bounded reducers inspect the whole permitted body,
then prioritize explicit obligations within the existing 32-proposition output
bound. Truncation and unreadable relevant sources remain category gaps.

The new state-v3.sqlite and rollup-v2.sqlite namespaces preserve prior databases
and old-version identities. Existing state/rollup handles refuse version mismatch
rather than silently binding to a new derivation. Source, catalog, capsules and
search progress are unchanged. Only affected memory and dependent rollup work
recomputes through existing bounded background operations. Selection retains the
beginning and end of recent episode experience and obligation-linked older context.

The old readiness fixture charged five cold layers against one ten-second wait.
The corrected fixture keeps a finite ten-second bound per layer (at most fifty
seconds), records stage progress, and does not reset deadlines on repeated ticks.
Its local run exposed an append race: scheduler status retained earlier ready
layers while the replacement was only scheduled. The fixture now observes the
adapter's current layers, which reset on a changed target. The real publication,
exact recovery, append, restart and sibling assertions remain. This final fixture
correction awaits routine CI; no unchanged retry was used.

The actual-producer focused check passed in 5.17 seconds. It exercises a conditional
restriction after forty background lines, later failure overflow, category-isolated
rendering, an oversized later user source, and an unchanged earlier generation/cut.
The synthetic example retains the condition and exception and does not certify
open-work overflow. There were two local focused invocations, no broad local suite.
Runtime CI now selects these two named scenarios instead of accumulating all prior
M06–M09 runtime scenarios. Full tests remain available for milestone qualification.
Required status, native provenance, build and publication gates remain in place.
Staged original-cut comparison and exact-head CI results are still pending.

The first corrected CI pair passed producer coverage but exposed a second
readiness race at append: cached prefix layers were ready while the scheduler
still reported lagging for the requested target. The final stage now requires
both rollup readiness and whole-target scheduler settlement within the same
existing stage deadline. No timeout was increased and no publication/recovery
assertion was removed. This substantive fixture correction receives fresh CI,
not an unchanged rerun. Runtime and derived semantics are byte-identical.

The first staged v3 comparison at the original cut retained twelve user
restriction paragraphs and user-sourced open work, but only one recent row.
This demonstrated over-reservation: the fixed 40% response reserve discarded
chronology before actual context sizes were known. Patch 2.0.18 removes that
percentage. Context allocation uses actual bytes within the unchanged 80 KiB
ceiling, dropping optional detail only when mandatory expansion needs the space.
Whole paragraphs and individual obligations remain protected. The same v3
memory derivation remains compatible; no second memory rebuild is needed.
Earlier artifacts remain preserved. This correction receives routine CI, not
additional local tests. The frozen installation remains unchanged.

### M09 guarded fresh-session candidate (2.0.19)

The directing assistant accepted the 2.0.18 corrections and CI for continued
work. The shared installed selection remains 2.0.15. Only one isolated fresh
session is authorized for guarded composition. PR45/46 remain unmerged.

An explicit `chrono-canary-session` flag binds the exact fresh physical session
and source. The control defaults off, reads its value after CLI flag binding,
and cannot carry across resume, fork, switch, or reload. It uses the existing
host admission policy through a read-only readiness check. It does not initialize
another pool. The normal hook checks mandatory coverage before obtaining the
independent Pi summary. Relevant gaps, overflow, source changes, unsafe tails,
and composition errors cancel replacement and preserve context. Safe refusal
codes are visible in status. No summary-only fallback counts as activation.

State schema/rules v4 processes oversized bodies through one existing M05 decoded
chunk per checkpointed background step, with an 8,192-unit boundary overlap.
The 32,768-unit whole-body threshold is unchanged. Source coordinates remain
absolute, overlapping clauses are deduplicated before state transitions, and
processing does not advance past an unfinished source. Verified catalog parser
metadata can establish a missing structural role. Unknown roles remain gaps.

Mandatory selection reads at most eight indexed pages of 32 rows per category,
512 rows total. Work reads user evidence before assistant reports and incidental
failures. The 16 restriction and eight work reservations apply to representations,
not raw rows. Only exact same-source context with matching category, authority,
and status consolidates. The private selection retains every covered proposition
and its source coordinates. Selection-work exhaustion and response overflow have
separate flags. The external worker bounds and 30,000-token ceiling are unchanged.
State-v4 and dependent rollup-v3 namespaces preserve prior stores and identities.
Only affected memory and rollup derivations recompute.

The coverage worker used two focused invocations. The first exposed an unrelated
restriction in the fixture assertion. The second exposed repeated paragraph
payloads displacing work. The final correction consolidates exact representations.
No third local invocation ran. Routine CI must qualify that final correction.
The parent canary check passed. Its second invocation did not match the composed
preview test name, so that invocation provides no additional preview evidence.
The routine workflow explicitly selects the real preview test and canary binding
alongside the two relevant coverage/publication scenarios. No broad local suite
ran. Exact-head CI, actual canary continuation, and updated original-cut evidence
are pending, not claimed by this implementation report.


### Shared paragraph payload correction (2.0.20)

Both 2.0.19 CI runs failed the producer fixture because open work was absent.
The other three focused scenarios passed. Consolidation still copied each full
expanded paragraph into every covered proposition. The response budget then
removed work. Patch 2.0.20 retains one paragraph representation, identified by a
SHA-256 key. Covered propositions retain their original exact clauses and source
coordinates and refer to that representation. No proposition, condition or
authority is removed. The original open-work assertion remains unchanged.
Typecheck and diff validation passed. No additional local runtime invocation ran.
The correction requires fresh routine CI. State-v4 and rollup-v3 derivation
identities remain valid because this changes response packing, not stored state.
The failed 2.0.19 evidence remains preserved. No canary or shared deployment has
run, and the fixed installed selection remains 2.0.15.

### Mandatory allocation correction (2.0.21 candidate)

The 2.0.20 candidate at `b6d1b25` again failed the unchanged synthetic
assertion that assistant open work must remain selected. Push run 34550886207
retains that failure; the other three focused scenarios passed. The failed
2.0.19 and 2.0.20 results are not passing evidence.

The established defect was an authority-priority inversion after the bounded
work query. A chronological sort replaced user/assistant/tool priority before
representation reservation. Response overflow then removed the earliest small
assistant rows before the later large incidental tool-failure representation.
The correction preserves authority priority through packing, removes
lower-authority and larger incidental work first, and records every loss through
the existing category and rendered-overflow flags. It fits mandatory rows before
refilling the already bounded recent, current and older candidates with actual
remaining bytes. No quota, response ceiling, worker limit, state schema or
external source contract changes.

The runtime-test allowance remains exhausted. Source typecheck, build, manifest
identity and dirty-tree static verification passed. The 2.0.21 push and pull
request runs 34552073457 and 34552075570 then failed the newly added user-goal
assertion. The fixture did not state an explicit user goal at that source row,
so the assertion did not establish a runtime retention loss. The fixture now
states `Goal: investigate the parser boundary.` while preserving the original
coverage assertions and assistant open-work assertion. This corrects only the
synthetic fixture input; the 2.0.21 runtime and schemas are byte-identical.
Replacement routine CI is pending. The shared installation, configuration,
source archives, state-v3/state-v4 stores, rollup-v2/rollup-v3 stores and
rollback points remain unchanged.
