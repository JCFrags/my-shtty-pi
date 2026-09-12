# M11 installed-Pi logical-session practical qualification

Status: package 2.0.29 at `9e35102a64f31694757eed11a982a1f81af6d347` passed required CI `34660070498`. Its installed-Pi run completed ten main rollovers and created the logical fork, then stopped during the remaining checks. The retained sources support an affected-tail resumption. A structured shard-refusal correction passed its focused check. Full qualification remains pending that resumption.

## Scope

`scripts/m11-logical-pi-qualification.mjs` is one consolidated, bounded M10/M11 scenario. It uses the installed `pi` executable in Pi 0.85.1 offline RPC mode. It does not call a model or provider.

The scenario creates one owner-only synthetic logical session and uses the packaged extension's actual commands and indexed history tools. It does not call logical-session core functions directly and does not supply coverage flags or coverage counts. Each rollover must pass the actual catalog, state-selection, composition, and continuation gates in `/chrono-logical-session`.

The scenario checks:

- ten actual main-branch rollover operations, which produce eleven main physical shards;
- one logical child fork, for twelve active child search routes including ancestors;
- exact-marker search, source-linked recall, and `history_get` recovery across old shards, including a marker beyond the eight-route internal search page;
- exact rollback to the old Pi source after the first replacement;
- retention of the rolled-back replacement on an isolated abandoned branch;
- refusal of an exact read that names the abandoned sibling shard from the child branch;
- process shutdown and a fresh installed-Pi RPC reopen of the child;
- an actual RPC `switch_session` back to the main active shard;
- exactly one Pi thinking-level lifecycle entry, one logical-continuation entry, and five linked seed entries in each seeded physical source, with a maximum of seven non-header entries in every physical source file;
- unchanged hashes for all source shards present before restart, all source files still present, and zero source deletions;
- Pi 0.85.1, the required candidate package version, candidate SHA, built distribution, and native `better-sqlite3` prerequisites.

The synthetic setup appends completed user and assistant turns around one Pi compaction entry per new shard through the installed SessionManager API. The assistant records are fixed fixture data and do not call a model or provider. The compaction contains a regular Pi summary because a model call is prohibited. These entries are producer input only. The harness does not assert producer coverage. A successful rollover is the coverage assertion because the packaged command derives and validates the selection itself.

## Execution boundary

Run against an exact packaged candidate under the owner's standing completion authorization. Reuse validated retained sources after a late failure and repeat only the affected checks. Do not treat a plan invocation, any blocked prior run, or the mock ten-route fixture as qualification evidence.

Prerequisites:

1. Check out the exact final candidate in a clean task worktree.
2. Install its locked dependencies and build `dist` with the repository procedure.
3. Run the repository native SQLite probe successfully.
4. Confirm that `pi --version` is exactly `0.85.1`.
5. Select a new owner-only synthetic root and a new output path outside that root.
6. Do not run another copy against the same root.

Generic commands:

```sh
cd packages/pi-chrono-compaction
RUNTIME_SHA="${CORRECTED_CANDIDATE_SHA:?set the exact corrected candidate SHA}"
npm ci
npm run catalog:sqlite:probe
npm run build
node scripts/m11-logical-pi-qualification.mjs plan --runtime-sha "$RUNTIME_SHA"
mkdir -p /path/to/qualification-parent /path/to/result-parent
chmod 700 /path/to/qualification-parent /path/to/result-parent
node scripts/m11-logical-pi-qualification.mjs run \
  --runtime-sha "$RUNTIME_SHA" \
  --root /path/to/new-qualification-root \
  --output /path/to/new-safe-result.json
```

The run records the runtime candidate and harness commits independently. It requires the runtime candidate to be an ancestor of the harness and refuses any runtime source, distribution, lockfile, or package metadata difference between them. It also refuses a package version other than the version bound in the harness, an installed Pi version other than 0.85.1, a missing distribution, a missing native SQLite binding, a reused output file, or an output path inside the synthetic root. Pi receives an environment without provider credentials and runs with `--offline` and no built-in tools.

## Prepared checks

Preparation checks:

- `node --check scripts/m11-logical-pi-qualification.mjs` passed.
- The earlier 2.0.24 `plan` passed and reported ten rollover operations, eleven main physical shards, one child shard, Pi 0.85.1, and zero provider calls. The 2.0.25 binding has syntax validation only until that package exists.
- `git diff --check` passed.
- Runtime candidate `932365908d7ca43c587f489517f4dfbb69c9652e` was supplied with package 2.0.24, Pi 0.85.1, Node 24.18.0 ABI 137, `better-sqlite3` 12.9.0, native binding SHA-256 `baac38739b5e4c5137ea0514c451df58423c2e626f43cddcfb4542206f93d013`, and 134 verified package-manifest records.

## Package 2.0.24 result

The installed-Pi run against unchanged runtime candidate `932365908d7ca43c587f489517f4dfbb69c9652e` stopped safely at the first `/chrono-logical-session rollover`. The command refused with the public safe error `logical-session-unavailable`. It did not create a pending rollover, replace a Pi session, call a provider, or delete a source.

Focused diagnosis through the same actual indexed selection reproduced `capsule-canonical-invalid` in `buildManualContinuationCandidate`. The composer produced valid episode rows with fractional `importance: 0.7`. `buildManualContinuationCandidate` then tried to rehash the artifact with capsule `canonicalJson`, which intentionally accepts only nonnegative safe integers. The composer contract already defines `envelope.artifactHash` as the SHA-256 hash of its stable artifact serialization.

The accepted correction reuses `composed.envelope.artifactHash`. It does not loosen `canonicalJson`, alter producer importance, rebuild the frozen 2.0.24 candidate, or change other continuation validation. One focused regression sends an actual fractional-importance episode row through the composer and continuation builder, then verifies that the continuation preserves the composer artifact hash.

All failed synthetic roots remain owner-only and retained for diagnosis.

## Package 2.0.25 result

The authorized installed-Pi retry used unchanged runtime candidate `aa160c082dd9f027b0e378c53c2784e00ef1727e`, exact committed `dist`, package 2.0.25, Pi 0.85.1, Node 24.18.0 ABI 137, `better-sqlite3` 12.9.0, and native binding SHA-256 `baac38739b5e4c5137ea0514c451df58423c2e626f43cddcfb4542206f93d013`. The package tree was `bf6d3c3c5d60732bb98b556c3f1a9a9f428aa849`; the 134-record manifest hash was `b0a8fdb3421e75f53fb86695d6f3b5d8c190555dc447f3a4c5928e6b9d4ee386`.

The initial indexed search, recall, and exact recovery probe passed. The first actual rollover passed the corrected continuation producer and validation gates. The immediate rollback then passed and reopened the exact old source. Its manifest retained two physical shards across the main branch and isolated rollback branch, but Pi had not created the replacement JSONL named by the rollback shard.

Pi 0.85.1 defers creation of a new session file until the session contains a normal assistant message. The logical continuation is a `custom_message`, while rollback eligibility correctly requires the replacement to contain only bootstrap records and that continuation. A focused harness-sequencing diagnostic confirmed that adding normal fixture messages creates the source but makes the real rollback gate refuse `logical-session-rollback-ineligible`. The harness cannot satisfy both conditions without fabricating a source or bypassing the gate.

Scalar result: one rollover command passed, one immediate rollback command passed, one retained manifest source was absent, zero providers were called, and no qualification result JSON was emitted. Three failed owner-only synthetic roots are retained. The remaining ten-rollover, fork, reopen, ancestor recovery, bounded-shard, and no-source-deletion checks are unqualified. This requires a corrected packaged runtime; it is not an ordinary harness correction.

## Prepared durability correction

The Pi command adapter now creates only the exact new continuation-only shard before manifest binding. It validates the public manager's generated path, version-3 header, session ID, canonical working and session directories, exact parent source, bounded ordered bootstrap chain, continuation identity, and serialized size. It publishes the actual public header and entries with Pi's newline encoding through an owner-only exclusive temporary file and no-overwrite hard link, fsyncs the file and directory, and reloads the same path through public `SessionManager.setSessionFile()`. It never opens an old shard for writing. An existing target is accepted only when its owner, mode, link count, size, and bytes match exactly.

One focused test uses the actual Pi 0.85.1 `SessionManager`. It proves that Pi initially leaves the continuation-only source absent, the adapter persists exact public header and entry bytes, exact replay is idempotent, a later normal assistant append retains the complete prefix and source identity, reopening retains the exact session and parent IDs, a conflicting existing target refuses without overwrite, and the old source bytes do not change.

## Package 2.0.26 result

Exact-head pull-request CI run `34581029129` passed for candidate `fac5d3566339b8ac51379c1703bcb1347e768d8b`. The authorized installed-Pi run used package tree `89c845a1309ea9e98095e1783eb4f9286ddf8eeb`, Pi 0.85.1, Node 24.18.0 ABI 137, `better-sqlite3` 12.9.0, and native binding SHA-256 `baac38739b5e4c5137ea0514c451df58423c2e626f43cddcfb4542206f93d013`.

The run passed adoption, the initial indexed search, recall, and exact recovery probe, the first rollover, exact rollback, abandoned-branch retention, and presence of the abandoned continuation source. It then issued the first rollover in the ten-rollover loop while the search index was rebuilding after the session switch. The command safely refused with `search-v3-index-not-ready`, and the harness assertion stopped the run after 19.788 seconds. Zero providers were called. No result JSON was emitted. The owner-only failure root and exact failure log remain preserved.

The existing `probe()` command already waits for catalog, capsules, index, memory, rollup, and the expected logical route count for up to 150 seconds, then verifies search, recall, and exact recovery. The harness now calls that probe after it validates the rollback branch and before it starts the ten-rollover loop. This is a harness sequencing correction, not a runtime change. The ten-rollover, fork, restart, and final source-preservation assertions remain unqualified until one authorized run of the next frozen candidate completes. Package 2.0.26 does not establish a full M10 or M11 pass.

## Package 2.0.27 result

Exact-head pull-request CI run `34586386020` passed for candidate `3cde8caf97b1ca48898dbf73d141d210f496649d`. The authorized installed-Pi run used package tree `bfee6f916a07f6209a9da6f3f75ae08079d7c589`, Pi 0.85.1, Node 24.18.0 ABI 137, `better-sqlite3` 12.9.0, and native binding SHA-256 `baac38739b5e4c5137ea0514c451df58423c2e626f43cddcfb4542206f93d013`.

The run again passed adoption, the initial indexed search, recall, and exact recovery probe, the first rollover, exact rollback, abandoned-branch retention, and presence of the abandoned continuation source. It stopped after 170.543 seconds when the first rollover in the ten-rollover loop safely refused with `search-v3-index-not-ready`. No loop rollover completed, no result JSON was emitted, and the owner-only failure root and log remain preserved.

The apparent successful post-rollback probe was stale harness evidence. `RpcClient.notify()` retained a notification after it delivered the notification to a waiter. The harness deliberately reused the initial marker after rollback, so the second probe selected the earlier pre-rollback success. Pi 0.85.1 awaits an extension slash-command handler, but reports the command as handled after converting a handler failure into an extension error. Thus the post-rollback command could exhaust its 150-second readiness bound without invalidating the stale payload that `probe()` later asserted. The elapsed time is consistent with that bounded wait followed by the safe rollover refusal. The preserved run does not prove that a ready index became unready between the probe and rollover.

The package 2.0.28 harness consumes each delivered or queued notification exactly once, gives probe notifications the command's 180-second outer bound, and converts a readiness timeout into a fresh probe payload with the exact safe error. One focused in-memory RPC check proved that a repeated predicate remains pending until a new notification and receives the fresh timeout evidence. The readiness predicate, its 150-second inner deadline, command refusal, and all rollover, fork, restart, rollback, recovery, and source-preservation assertions remain unchanged. No runtime correction is justified from the stale 2.0.27 observation. One authorized 2.0.28 run after exact-head CI must establish the actual post-rollback result.

## Package 2.0.28 result

Exact-head pull-request CI run `34589583968` passed for candidate `ec1d2bb5cb7143b29b74699b1eb332b9001f598d`. The authorized installed-Pi run used package tree `61a922c65921dc3e4dd9b6f90c5e01259a4cdd9e`, the unchanged fresh-notification harness, Pi 0.85.1, Node 24.18.0 ABI 137, `better-sqlite3` 12.9.0, and native binding SHA-256 `baac38739b5e4c5137ea0514c451df58423c2e626f43cddcfb4542206f93d013`.

The run passed adoption, the initial indexed search, recall, and exact recovery probe, the first rollover, exact rollback, abandoned-branch retention, and presence of both source files. The fresh post-rollback probe then waited for its 150-second readiness deadline and reported `qualification-index-timeout`. Its final status had search disabled, catalog, capsules, index, memory, and rollup pending, no requested or indexed cut, no logical grant, `servingLastReady: false`, `requestedViewValidated: false`, startup ready, and `lastSafeError: search-v3-rollout-unsafe`. The run stopped after 170 seconds. No result JSON was emitted and no scenario was repeated.

The final revision-5 manifest was valid. It retained the restored main shard and the replacement on an isolated rollback branch, both source files were present, and no rollover was pending. Thus the failure was not a missing source, incomplete rollback commit, readiness timeout, or stale harness notification.

Pi 0.85.1 starts the resumed runtime and emits `session_start` before it invokes `switchSession()`'s `withSession` callback. `rollbackLast()` committed the manifest transition inside that callback. The first resumed startup therefore saw the pre-rollback manifest, safely rejected the old adoption binding, and disabled search. The callback then committed the correct manifest, but no second startup occurred. The focused correction reloads the resumed runtime only after the callback commits the rollback manifest. Prepared-rollover recovery uses the same commit-then-reload order after removing its intent. Switch cancellation leaves the manifest unchanged, and a reload failure leaves the committed manifest and every source available for a later normal reopen.

A focused logical-session test preserves rollback, isolated-branch, source, and recovery assertions while requiring post-commit reload. A focused test against the actual Pi 0.85.1 runtime confirms the exact ordering: initial resumed startup sees pre-callback state, and the supported reload sees the committed state. Neither check calls a provider. The corrected source is not a packaged qualification result. One separately packaged candidate and exact-head CI run are required before one affected installed-Pi retry.

## Package 2.0.29 result

Exact-head pull-request CI run `34592458271` passed for candidate `65abc70be9de289300b19cfdd70ad909d6292b14`. The authorized installed-Pi run used package tree `09d7c3275e2ccaa0498a876b18fe95b1e9fb2393`, Pi 0.85.1, Node 24.18.0 ABI 137, `better-sqlite3` 12.9.0, and native binding SHA-256 `baac38739b5e4c5137ea0514c451df58423c2e626f43cddcfb4542206f93d013`.

The run passed adoption, initial search, recall, and exact recovery, the first rollover, exact rollback, abandoned-branch retention, the fresh post-rollback search, recall, and exact probe, and the next rollover command. It stopped after 27 seconds at seed ordinal 1 because `SessionManager.getEntries()` returned seven entries while the harness allowed at most six. No result JSON was emitted and the scenario was not repeated. The owner-only scalar evidence has SHA-256 `5876f9741b2cdc5acee4c613f52eff3db8b20182c0089c05d85533c6a5a675ed`.

The retained active source had eight physical rows: its header, one `thinking_level_change` lifecycle entry, one `chrono-logical-continuation`, and the five linked seed entries. The lifecycle correction in package 2.0.29 reloads Pi after committing rollback state, so Pi records its bounded thinking-level startup entry before the continuation. The earlier coarse six-entry limit did not describe that established lifecycle shape.

The corrected harness requires exactly seven non-header entries for every seeded shard. It validates the lifecycle and continuation order, all five seed row types and roles, the complete parent chain, the returned seed and summary identifiers, nonempty unique identifiers, and the unchanged seven-entry ceiling. It rejects an unknown lifecycle row, a duplicate identifier, or any extra row. The final all-shard ceiling remains strict at seven. One focused shape check accepted the observed shape and rejected separate unknown-row, duplicate-identifier, and extra-row fixtures. This correction does not change runtime code, production guards, package version, readiness predicates, rollover behavior, providers, or source retention. Packaging and exact-head CI are still required before one affected run. The ten-rollover, fork, restart, and final source-preservation results remain unqualified.

## Corrected-harness package 2.0.29 result

Exact-head pull-request CI run `34594672847` passed for candidate `a7a931c52c604a50e6c70cebc646fb979847ceda`. The one authorized installed-Pi run used package tree `6bebbf41e8872e16910187e58c4244f2039a2a0e`, harness SHA-256 `91865b5369ac1c7cdd5bbc690c48822cb240fe86d690aedc19b83ecac7eef3ca`, Pi 0.85.1, Node 24.18.0 ABI 137, `better-sqlite3` 12.9.0, and the unchanged native binding.

The run passed adoption, initial search, recall, and exact recovery, first rollover, exact rollback, abandoned-branch retention, post-rollback search, recall, and exact recovery, the next rollover command, and the corrected seven-entry seed assertion. The first main-loop probe then emitted no payload and reached its unchanged 180-second outer bound. The run stopped after 207 seconds. It emitted no result JSON and was not repeated. The owner-only scalar evidence has SHA-256 `62e005959a50d6e1d5d4275a0dcc64d8142f35a2716f450efb4e7fcadda1b73d`.

The active source contained eight rows and 8,728 bytes: the header, the bounded thinking-level lifecycle row, the logical continuation, and five seed rows. Its catalog had observed and committed all eight events. Its matching search head remained at event 3 with one document and one membership. `complete: true` described that stale requested cut, not coverage of the current source at event 8.

The qualification seed command writes five entries directly through `SessionManager`. Pi extension slash commands do not run an agent turn and do not emit `agent_settled`. Chrono schedules search at `session_start`, session transitions, and `agent_settled`, so no scheduling boundary followed those direct fixture appends. The subsequent readiness call saw the already-complete event-3 request. A later search miss or search error escaped the probe handler because only the readiness wait has a notification-producing catch. Pi 0.85.1 converts a thrown extension command handler error into an extension error and reports the slash command as handled, so the RPC prompt completed while the harness waited for a notification that could not arrive.

The fixture correction sends the seed-shape receipt, then calls the supported `ctx.reload()` as its terminal action. Reload emits a fresh `session_start` against the same current source, which schedules the search target at the new leaf before the separate probe command. The correction does not reinterpret readiness, force an index state, change the 150-second inner wait or 180-second outer bound, change worker admission, or alter runtime scheduling. This qualification uses an explicit fixture reload after direct `SessionManager` seed writes. It does not establish that ordinary extension-command appends schedule search automatically. The correction changes only the qualification fixture and this report. The full ten-rollover, fork, restart, and final source-preservation sequence remains unqualified until a separately packaged candidate passes exact-head CI and one authorized affected run.

## Ten-rollover result and retained-source recovery

Candidate `9e35102a64f31694757eed11a982a1f81af6d347` ran through the actual installed Pi 0.85.1 RPC interface with committed 2.0.29 artifacts. It completed adoption, the first replacement and exact old-path rollback assertion, all ten main-loop rollovers with their seven-entry seed and search/recall/exact assertions, and the logical fork. Its revision-38 manifest retained eleven main shards, one child shard, and one abandoned rollback shard. Every source was present. The run then ended with `notify-timeout` and no final result report. These intermediate results do not constitute a complete run.

A fresh read-only probe on the retained child recovered the oldest main marker through twelve logical routes with search, recall, and exact retrieval. It did not repeat rollover or change source. The subsequent affected-tail resumption reached the abandoned-shard refusal and timed out because the RPC fixture did not surface the thrown extension error.

The committed adapter reproduced the cause without workers or source reads: `getBlock`, `getRaw`, and `range` throw `logical-session-route-unavailable` for an unlisted shard before entering their error handler. The branch guard correctly prevents access, but the missing structured result escapes the qualification command. The correction moves those same route guards inside the existing handler. It preserves the refusal code, ancestor routes, source scope, and worker limits. One focused check passed all three structured refusals and confirmed unchanged scheduler state.

The RPC fixture now checks `extension_error` events after each command and returns a probe notification for every probe failure. Readiness predicates, deadlines, route-page limits, and output limits are unchanged. The retained thirteen sources will be reused for the remaining sibling refusal, all-shard retrieval, process reopen, switch-back, and hash-preservation checks. Preparation and correction runtime identities must be reported separately. No full campaign restart is needed for this correction.

## Result fields

A successful run writes one owner-only JSON report with candidate and package identity, aggregate shard and route counts, boolean search/recall/exact, fork, rollback, restart, bounded-entry and source-preservation results, and `providerCalls: 0`. It omits source paths, session paths, logical identifiers, marker text, command output, and private host details.

The synthetic root is retained after success. This lets the parent inspect source files and derived stores without weakening the no-source-deletion check. Any later removal is a separate cleanup action and is not part of this harness.
