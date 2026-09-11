# M11 installed-Pi logical-session practical qualification

Status: harness prepared on a task commit above runtime candidate `932365908d7ca43c587f489517f4dfbb69c9652e`. Practical result pending.

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
- a maximum of six non-header entries in each physical source file;
- unchanged hashes for all source shards present before restart, all source files still present, and zero source deletions;
- Pi 0.85.1, package 2.0.24, candidate SHA, built distribution, and native `better-sqlite3` prerequisites.

The synthetic setup appends one user entry and one Pi compaction entry per new shard through the installed SessionManager API. The compaction contains a regular Pi summary because a model call is prohibited. These entries are producer input only. The harness does not assert producer coverage. A successful rollover is the coverage assertion because the packaged command derives and validates the selection itself.

## Execution boundary

Run this scenario once after the project lead supplies the final integrated 2.0.24 candidate. Do not treat a plan invocation, an earlier package version, or the mock ten-route fixture as qualification evidence.

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
RUNTIME_SHA=932365908d7ca43c587f489517f4dfbb69c9652e
npm ci
npm run catalog:sqlite:probe
npm run build
node scripts/m11-logical-pi-qualification.mjs plan --runtime-sha "$RUNTIME_SHA"
mkdir -m 700 /path/to/new-qualification-root
node scripts/m11-logical-pi-qualification.mjs run \
  --runtime-sha "$RUNTIME_SHA" \
  --root /path/to/new-qualification-root \
  --output /path/to/new-safe-result.json
```

The run records the runtime candidate and harness commits independently. It requires the runtime candidate to be an ancestor of the harness and refuses any runtime source, distribution, lockfile, or package metadata difference between them. It also refuses a package version other than 2.0.24, an installed Pi version other than 0.85.1, a missing distribution, a missing native SQLite binding, a reused output file, or an output path inside the synthetic root. Pi receives an environment without provider credentials and runs with `--offline` and no built-in tools.

## Prepared checks

Preparation checks:

- `node --check scripts/m11-logical-pi-qualification.mjs` passed.
- The pre-candidate `plan` passed and reported ten rollover operations, eleven main physical shards, one child shard, Pi 0.85.1, package 2.0.24, and zero provider calls.
- `git diff --check` passed.
- Runtime candidate `932365908d7ca43c587f489517f4dfbb69c9652e` was supplied with package 2.0.24, Pi 0.85.1, Node 24.18.0 ABI 137, `better-sqlite3` 12.9.0, native binding SHA-256 `baac38739b5e4c5137ea0514c451df58423c2e626f43cddcfb4542206f93d013`, and 134 verified package-manifest records.

The practical result is recorded below after the one authorized run.

## Result fields

A successful run writes one owner-only JSON report with candidate and package identity, aggregate shard and route counts, boolean search/recall/exact, fork, rollback, restart, bounded-entry and source-preservation results, and `providerCalls: 0`. It omits source paths, session paths, logical identifiers, marker text, command output, and private host details.

The synthetic root is retained after success. This lets the parent inspect source files and derived stores without weakening the no-source-deletion check. Any later removal is a separate cleanup action and is not part of this harness.
