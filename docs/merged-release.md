# Project Glance V1.1 merged release

This document defines the integration and deployment gates. It is not a claim
that the merge, local cutover, or final user acceptance has happened. Record
those identities and results on the release PR and immutable release checkpoint.

## Coordinated external browser pin

This is the fixed component pin for COMMAND 8. Approved recovery and selection
are complete. The browser lead verified its loaded parent and daemon, but final
in-scope session convergence remains a separate gate. This is not final
integrated acceptance. The browser lead owns deployment and readiness.

| Identity | Exact value |
| --- | --- |
| External repository | `JCFrags/my-shtty-pi-web` |
| Reviewed artifact source | `3ac4ca2b02b8133d1843f62d6df41843c565548a` |
| Selected immutable artifact | `d62924d931d306aa9624ff6e44f26d3bece4f1abda89d8e868db53d8d87ba0f4` |
| History-preserving main promotion | `a89e0363c9904b7bf34ad9a35125d05ca4656285` ([PR #11](https://github.com/JCFrags/my-shtty-pi-web/pull/11)) |
| Previously selected browser artifact | `e5acc00eee9bce5cd70a0d6f425f5f002767c45d8352ba82bc609c980215572c` |

The browser lead reports that promotion preserves the reviewed source ancestry
and changes only the release workflow and README relative to that source.
Runtime/package inputs are unchanged. The selected artifact therefore retains
`3ac4ca2b02b8133d1843f62d6df41843c565548a` as its source identity; do not relabel it
as built from the promotion merge. Promotion removes automatic external
publication/deployment on a main push. Explicit tag/manual publication is a
separate operation, not authorized by COMMAND 8 deployment coordination.

The lead reports required promotion CI passed in run `34507293291`; the optional
upstream pixel baseline remains separately disclosed. Resulting-main CI
`34508739599` also passed its required jobs, as reported by the browser lead.
These are provenance and
promotion checks, not proof of installed or per-session runtime parity.

Coordination references are board entries
`20260910T153009Z-command8-release-freeze-proposal` and
`20260910T170517Z-browser-main-window-request`. Approved window
`browser-main-cutover-20260910-01` completed guarded recovery and scoped browser
selection, then was explicitly released. Board entry
`20260911T021000Z-browser-recovery-selected` records that result. The separate
`browser-parent-verify-01` window also completed and was released. The browser
owner verified a loaded parent, matching daemon, companion reuse, semantic and
visual observation, a native click, and manual pause/resume. The companion was
left paused. These checks do not prove that every older session has converged.
No further write, reload, or automatic resume is authorized by this document.
Require fresh process-level inventory and exact safe handoffs for remaining
reloads. Multiple Pi processes can share a pane. A stopped process is not exited
or safe to reload. Preserve its conversation. Also wait for managed shell jobs
to settle normally: Pi reload can terminate them even when the editor is idle.

External WebX/research remains independently owned and unchanged. Chrono
2.0.15 at `b5918dbf952423e86a50a71e03ae1996c4801ea5` remains the fixed installed
nomination under review, not accepted, with unchanged enablement. This browser
pin does not complete the remaining component manifest or select a replacement
Chrono candidate. Later board/documentation-only commits do not require
redeploying unchanged runtime inputs.

## Integration boundary

- Accepted Glance V1.1: `5eb72bae6ff1cc1e174a4d6aec2ba86be2608efc`.
- Release integration base: `250179d8f458534380410208c599eed0db1b0c13`.
  Fetch again before merge; validate any newer integrated tree.
- Codex Usage Footer is user-accepted. PR #54 integrated its runtime. PR #58
  changes only two polling fixtures to await startup settlement; required CI
  `34556905509` passed. These test changes do not require a runtime reload.
- Keep main's removal of the temporary cancellation extension. The supported
  registry rejects reintroduction of that extension or Signal Board.
- The accepted orchestration package already contains all six main M10 direct
  lifecycle modules and their reliability check without changes. Retain its
  broker, authentication, historical replay, CLI, and `/agent-settings` source
  closure. Retired presentation routes and tracked generated orchestration
  output remain absent.
- Integrate the fixed installed ChronoCompact 2.0.15 runtime from
  `b5918dbf952423e86a50a71e03ae1996c4801ea5`, not newer development heads.
  See [Chrono compatibility](chrono-release-compatibility.md) for the complete
  package pin and declared test-only integration correction. Preserve runtime
  source, compiled distribution, live gate, policy, slots, and configuration.
  PR #45, #46, and #55 remain separate development work, not release inputs.
  The older 2.0.4 integration is historical provenance, not the selected runtime.

### Chrono operating limits and acceptance

The nominated source keeps `M09_AUTHORITATIVE_REPLACEMENT_ENABLED` false.
The original large-session mandatory-coverage failure blocks the new stored-
selection replacement mode. It is not a demonstrated failure of the existing
normal compaction policy, whose response follows a separate code path. Keep
legacy replay, the independent Pi summary, retained tail, ceilings, and current
session enablement unchanged. No new mode, automatic rollover, or wider rollout
is part of this release.

The legacy representation is bounded and lossy. Derived search and state can
lag or be partial. The installed explicit-ID preview searches only 256 recent
branch entries. The package declares Pi peers below 0.85, while local Pi is
0.85.1; existing loader and practical-use checks provide limited compatibility
evidence, not a changed support declaration. Newer isolated canary results do
not qualify the original large session. Record the user's plain-language
acceptance of these limits in the final release check. Do not wait for later
M09 backfill or M10 development to finish this fixed release.

Use a protected history-preserving PR merge. Required CI applies to the actual
reviewed head. An independent agent review is evidence, not a fabricated GitHub
review approval. Do not bypass rules, rewrite history, or push corrections
directly to main. Verify the resulting main commit and tree before deployment.

## Complete deployment inventory

The supported registry contains 16 products, including two inactive products.
The local deployment has 16 repository-owned Pi package resources, four
repository-owned automatically discovered extensions, and the shared Grounded
core. These counts describe different boundaries; they are not interchangeable.

Repository-owned package resources, in their existing order:

1. Progressive Tools
2. Agent Context
3. Grounded Files
4. Grounded Process
5. Grounded LSP
6. Grounded Dialog
7. Grounded Tasks
8. Grounded Notes
9. Grounded Workplan
10. ChronoCompact
11. Herdr Orchestrator
12. Native SSH
13. Herdr Status
14. Files UI
15. Pixel CUA
16. Project Glance

The external terminal browser follows these resources. Preserve it, external
Herdr plugins, and any independently configured Pi Web integration. Do not
recreate an external extension merely because an older runbook mentions it.
The four automatic repository extensions are Codex Usage Footer, Herdr Agent
State, Herdr Blocked Bridge, and Titlebar Spinner. The two repository-owned
Herdr plugins are Glance and the startup-only orchestrator.

For the final release, record the exact Git commit/tree, all indexed source
hashes, package and lock identities, generated build hashes, installed Pi/TUI
and Herdr versions, and intended relative registration paths. Keep full local
manifests private; publish only sanitized source/build summaries on the PR.
No settings, credentials, session contents, or machine-specific paths belong in
public evidence. Reproduce all repository-owned registrations from one retained
exact-main release, not just Glance and Dialog. Keep external resources separate.

## Preservation and maintenance window

See [activation](activation.md) for loader, deferred delivery, and pane checks.
Before moving the canonical checkout, present the concrete preservation plan.
Preserve tracked edits, the index, staged deletions, untracked and ignored work,
local-only refs, linked worktrees, and historical recovery roots. Verify private
recovery before any relocation. Never reset, clean, silently stash, or overlay
unrelated work onto the release. A fresh independent main checkout can replace
the canonical path only after the original repository has been preserved intact
and its linked-worktree paths have been repaired and verified.

Stop for explicit maintenance-window confirmation before changing registrations,
relocating the canonical checkout, or replacing the broker. Finish or checkpoint
active work. Account for every older in-scope Pi process and Glance pane. An idle
agent does not prove that its editor has no draft. Never overwrite a draft to
send `/reload`.

Changed absolute package paths are required for compiled module cache identity.
Retargeted links alone do not activate already-loaded code. `/reload` refreshes
Pi extensions but does not replace a running Glance pane; close and reopen that
pane separately. Require actual reload evidence and retained session identity.

## Broker-only replacement

The supported package CLI provides `broker stop` and `broker start`. Starting
or linking a new package alone can keep a healthy older broker running. Use the
same authenticated state/runtime namespace and canonical Herdr socket.

An external maintenance handoff must own stop, identity verification, start,
and health checks without depending on the broker's own agent result channel.
The supported stop validates PID/start identity, requests authenticated shutdown,
and waits for exact-owned process artifacts to disappear. It does not terminate
Herdr, Pi, or their panes. It also does not wait for every remote model turn:
operator-confirmed task, workflow, callback, and answer-delivery quiescence is
still required. A shutdown timeout is a blocker, not permission to kill a
process or remove locks manually.

After replacement, verify the new process and start identity, exact launch root
and build closure, authenticated healthy status, event-sequence continuity,
required doctor checks, and working policy reads. The retired
`provider-projection-contracts` doctor check must be absent. Package version or
launcher hash alone cannot distinguish the old broker from this release.
Historical actor replay stays narrow; new writes and authentication still reject
retired actors. Preserve keys and current state. Code rollback must not overwrite
new events with an older state backup.

## Required acceptance

- Complete indexed supported verification, separate historical verification, and
  exact Chrono corrective package verification.
- Locked builds, package checks, source/resource closure, and privacy checks.
- Full installed-Pi candidate loader with one `/project-glance`, one `ask_user`,
  `orchestrate`, `/agent-settings`, Todo/Workplan, and standalone Files preserved.
- Isolated real Herdr link/unlink/relink and rollback checks; actual pane checks.
- A real model-backed direct-Herdr child from the candidate through completion,
  collection, and exact settled-child closure. The model-free broker smoke is
  not a substitute, and broker policy does not select direct-Herdr child models.
- Post-cutover remote/main, canonical, retained source/build, registration, and
  running-process parity, including the replacement broker.
- Live feed, reconnect, deferred option/text answer, persistence/reload,
  safe-idle next-natural-request insertion without automatic response, and the
  unchanged blocking modal.
- Consolidated user acceptance of the exact merged deployment before creating
  the new immutable release checkpoint. Preserve baseline tags, deliberate WIP
  recovery, and rollback roots. V1.2 remains on hold until all gates pass.

Readable persisted bytes are not an `fsync` guarantee or an exactly-once model
processing guarantee. Deferred questions cannot authorize actions. Those limits
are unchanged by this release.
