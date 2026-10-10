# Interval compaction implementation

Source: `pi-chrono-compact` `4.1.1-local.20261010`, October 10, 2026. Chrono development dependencies use Pi/AI/TUI `1.1.0`, with peer ranges `>=1.1.0 <1.2.0`. Root tooling and other product pins remain `0.85.1`. See the [Chrono manifest](../../../packages/pi-chrono-compaction/package.json) and [release compatibility](../../chrono-release-compatibility.md).

The [approved Markdown reference](../compaction-reference/reference.md) and [styled HTML](../compaction-reference/reference.html) remain the implementation baseline. Status: Approved implementation baseline; implementation in progress. This page describes candidate source, not remote acceptance, selected configuration, or loaded code. The candidate package typecheck and build passed with Pi 1.1.0 on October 9, 2026. One bounded offline public-Pi 1.1 lifecycle check passed: normal and direct current-agent commits, deterministic recovery, commit-before-continuation ordering, exact C, and cancellation without automatic continuation. Three actual saved commits each preceded one continuation. The check made no real model or network calls. This earlier evidence does not verify later repairs. Updates also require [exact-root authorization before selection](../operations/startup-authorization.md), without automatic trust of changed code. The older [session-agent contract](session-agent-compaction.md), [budget reference](compaction-and-budgets.md), and [operations](../operations/README.md) retain their revision-bound behavior and evidence.

## Purpose and first inspection

The candidate separates current task state from historical evidence. The current conversational agent writes its handoff and immediate continuation. Code selects bounded history from the current work interval. Optional history helpers cannot write the agent's current intent, grant permission, or declare work complete.

In a separately approved candidate installation, open `/Chrono`, then `Status and diagnostics`, then `Overview and search readiness`. Check the loaded identity and `composition.mode` before interpreting interval status. `Settings` shows the automatic policy and history-role selections when V4 is selected. A saved selection, a build, or a registered tool does not prove that an existing process loaded or exercised the candidate. Do not upgrade merely to reproduce this documentation.

The inspected selector still defaults to `v3`. `contextCompiler: "v4"` selects the interval candidate. `PI_CHRONO_CONTEXT_COMPILER`, when set, takes precedence. Memory ownership is a separate startup choice. Select exactly one native writer per provider. See [activation and migration](../operations/activation-and-migration.md), subject to this candidate's Pi 1.1 boundary rather than the older host pin in that procedure.

## Original interval and A/B/C

The interval begins after the latest committed compaction, or at the initial source origin. Its end is frozen before the generated handoff exchange. Source capture applies effective context edits and binds the selected ancestry, original records, projection, and entry identities.

| Range | Candidate treatment |
| --- | --- |
| A = `[S,H)` | Older original work. Use a labeled deterministic synopsis, or a ready compatible `activePrefix` helper product. |
| B = `[H,R)` | Recent original work. Use deterministic tool-specific reducers, with eligible ready `event` alternatives when available. |
| C = `[R,E)` | Newest original work. Preserve supported effective native messages without semantic rewriting. |

`S <= H <= R <= E`. The ranges are disjoint. A and B can be empty. Code keeps each complete assistant tool-call batch with its results. C can expand beyond its nominal allowance to retain the newest required complete unit, but the whole request must fit. An oversized required unit refuses instead of being split or called exact after truncation.

A unique valid tool call can lack a result on the selected branch after a branch change. If a later native user message exists in the same source association, capture preserves that earlier call as labeled historical text. It retains the name, ID, arguments, and source recovery route, and states that the outcome is unknown in this branch's selected context. It does not import a sibling-branch result, invent a result, or change the source JSONL. The receipt records this projection change. C retains the labeled text rather than an unpaired executable call. A missing result without a later native user boundary still refuses. Custom messages, generated compaction requests, duplicate IDs, malformed calls, and deferred responses do not qualify. See [`interval-source.ts`](../../../packages/pi-chrono-compaction/src/interval-source.ts) and [`interval-render.ts`](../../../packages/pi-chrono-compaction/src/interval-render.ts).

Previous compaction packets, branch summaries, generated control exchanges, instructions, metadata, context-excluded records, and identifiable imported history bodies are not new original history. A native state readback supplies typed identity and revision for the synopsis. The archive can retain an eligible original readback as an observed snapshot, not proof that all described actions occurred in this interval. Hidden reasoning and unsupported helper media have explicit exclusions. "Exact C" refers to supported content under the effective projection, not byte-identical provider serialization or restoration of omitted source.

Successful typed Todo and Workplan transitions can suggest a cut. A checkpoint is a saved position, not completion. Hints cannot override safe pairing or `H <= R`. Logical rollover requires pinned original-shard routes and bounded exact reads. Missing or changed originals refuse. A continuation summary is not a substitute source.

Source: [interval source](../../../packages/pi-chrono-compaction/src/interval-source.ts), [logical source adapter](../../../packages/pi-chrono-compaction/src/interval-logical-source.ts), [partition](../../../packages/pi-chrono-compaction/src/interval-partition.ts), and [typed boundary hints](../../../packages/pi-chrono-compaction/src/interval-boundary-hints.ts).

## Same-agent handoff and separate continuation

The candidate's normal exchange uses the registered `request_compaction` tool:

1. Save necessary current state and exact outstanding resource IDs before requesting compaction. Outstanding work need not finish solely for compaction.
2. Call `request_compaction({})` once as the sole tool call. The result supplies a bounded same-session request and its `requestId`.
3. Use the already available context to submit `requestId`, nonempty `handoff`, nonempty `continuation`, and optional `relevanceHints` as the sole tool call. Do not retrieve history, delegate, or perform unrelated work between request and submission.
4. Stop the exchange and allow runtime validation. Submission acceptance does not mean that compaction committed.

The handoff preserves the goal, restrictions, decisions, actual results, current position, unresolved resources, and next steps. The separate continuation states the immediate next action or a wait, cancellation, completed-task stop, or approval gate. Neither field grants new authority. The old `summary` field remains for compatibility. Do not reuse older summary-only examples for this exchange.

Handoff plus continuation must fit 32,768 UTF-16 units and 48 KiB of UTF-8 text. The continuation also has its own limit of 8,192 UTF-16 units and 12 KiB. Up to eight relevance hints are allowed, each at most 256 UTF-16 units and 1,024 UTF-8 bytes. Adaptive allowances can be smaller than these hard limits. They are not goals to fill. The request expires after five minutes and is invalidated by relevant input, source, branch, model, or operation changes. A persisted old request is not a retry ticket.

At `turn_end`, the runtime proposes a native retain-none compaction from the accepted current-agent submission. This avoids native manual preparation's small-session refusal without changing `keepRecentTokens`, padding history, or making another model request. The proposal preserves current-agent authorship and must match a later persisted commit. Private previews keep their verified technical boundary.

The compiler stores the handoff, A synopsis, and B rendering in the summary. Its receipt binds exact C, the distinct continuation, source ranges, derivation, coverage, and budget. The context adapter expands only the exact correlated persisted packet, placing C and continuation before new work. It hides only the correlated technical boundary or wake marker. Native state cards remain owner evidence in the receipt, not a second rendered state dump.

Source: [summary protocol](../../../packages/pi-chrono-compaction/src/session-agent-summary.ts), [compiler envelope](../../../packages/pi-chrono-compaction/src/context-compiler.ts), [interval compiler](../../../packages/pi-chrono-compaction/src/interval-compiler.ts), and [restart projection](../../../packages/pi-chrono-compaction/src/interval-runtime.ts).

## Helpers are off until selected

With all history roles unselected, A uses a labeled deterministic fallback and B uses deterministic reducers. C remains exact. This is a model-free **history reduction** baseline, not model-free normal compaction: the current agent still produces the handoff and continuation in its normal model response.

Persistent configuration defaults to `~/.pi/agent/chrono-compact.json`, unless `PI_CHRONO_CONFIG_PATH` selects another file. The optional `historyHelpers` object requires `schemaVersion: 1`. Omission selects no roles. A source-compatible illustration with no helper consent is:

```json
{
  "contextCompiler": "v4",
  "historyHelpers": { "schemaVersion": 1 }
}
```

This illustration is not an activation instruction. Preserve unrelated settings and ownership. Legacy background-model settings and the current main model do not implicitly select any history role.

| Role key | Settings label | Eligible historical input |
| --- | --- | --- |
| `activePrefix` | `Active-prefix synopsis` | Original A only. |
| `event` | `Optional event alternatives` | Selected noisy B tool outputs with complete-unit interpretation context. Not user-directive rewriting. |
| `archive` | `Optional full-interval archive` | Original full `[S,E)`, independently of rendered A/B/C. |

Each selected role requires exact `provider` and `model` identifiers plus `selectedForHistory: true`. Provider identifiers are limited to 128 UTF-8 bytes, model identifiers to 512. Whitespace, control characters, unknown fields, and missing consent refuse. In V4 `Settings`, select a role, select an explicit provider/model route, and confirm history disclosure and possible charges. `Clear only this role` removes that selection. Selection does not itself call or authenticate a model.

Eligible user text and tool evidence can reach the selected provider. A locally running process can still use a remote provider. Charges and provider retention terms apply. Helpers have no action tools and no silent provider/model fallback. The adapter conservatively excludes protected, private, and credential-shaped fields, but it is not a complete secret detector. Unsupported media produces coverage notices, not image interpretation from base64 text.

Source: [role schema and consent](../../../packages/pi-chrono-compaction/src/history-helper-config.ts), [user configuration](../../../packages/pi-chrono-compaction/src/user-config.ts), [original-field adapter](../../../packages/pi-chrono-compaction/src/interval-helper-adapter.ts), and [route enforcement](../../../packages/pi-chrono-compaction/src/history-helper-model.ts).

## Finite helper work and independent archive

A closed A prefix can prepare before final E. Appending after H permits reuse only if the exact S/H originals, projection, ancestry, and derivation still match. Advancing H requires original `[S,H2)`, never an old synopsis plus a delta.

Helper pools have finite queue, concurrency, call, input, output, cache, and deadline limits. The archive uses a separate finite lane. Final assembly reads ready compatible products synchronously. It never waits for a model or archive. Missing, slow, failed, invalid, or stale helper products leave deterministic history available. Late results do not rewrite a committed packet.

Cancellation requests abort. A running call retains its owned provider slot until its promise settles. A deadline or cancellation signal is not proof of provider closure, stopped billing, or resource release. Output checks prove structure and source mapping, not semantic fidelity. "Full" coverage means every eligible original input part was supplied, not lossless output.

After observing a correlated native commit, the candidate can schedule the explicitly selected archive role over original `[S,E)`. It does not summarize the restart packet. Archive failure cannot gate assembly, commit, or continuation. The runtime API persists archives only when supplied with an `archiveDirectory` or `archiveStore`. The inspected extension supplies a private `chrono-interval-archives` directory beside its configuration.

The candidate registers the read-only `/Chrono archive <commit-id> [item-offset]` action and `Maintenance` choice `Read an interval archive`. It requires safe idle and the exact committed entry on the selected loaded ancestry. It verifies the receipt and original-source association, then reads a matching derived record. It does not list foreign archives, call a model, or change accepted Memory. The default zero-based item offset is `0`. Pages select at most 16 whole items within a 30 KiB complete-envelope bound, including continuation metadata. Continue only with the returned `nextItemOffset` or continuation command. No compatible record means unavailable, not empty original history. This surface is source-inspected, not practically exercised.

Source: [helper service and settlement](../../../packages/pi-chrono-compaction/src/history-helper.ts), [finite runtime lanes](../../../packages/pi-chrono-compaction/src/interval-helper-runtime.ts), [prefix preparation](../../../packages/pi-chrono-compaction/src/interval-precompute.ts), [private archive store](../../../packages/pi-chrono-compaction/src/interval-archive.ts), and [menu/action integration](../../../packages/pi-chrono-compaction/src/pi-extension.ts).

## Request bounds, media, and Pi hooks

One product-owned `interval-v1` policy derives layer, preparation, growth, safety, and output allowances from the selected model and current overhead. Unknown model identity, invalid context/output metadata, invalid estimates, or insufficient restart capacity still refuse. A context percentage alone does not establish request fit.

Current-request estimates include system instructions, active schemas, and framing. The planning reserve is `min(model.maxTokens, DEFAULT_COMPACTION_SETTINGS.reserveTokens)`, which is at most 16,384 tokens with Pi 1.1 defaults. Crossing a planning threshold freezes ordinary work and requests the same agent's handoff and continuation. It does not refuse that summary-only response, even when the estimate exceeds the advertised context window. The context hook can append the request to the current projection without starting another provider turn. The provider can still reject the request. A correlated provider size failure uses the existing deterministic recovery path.

The compiled restart remains bounded, including the handoff, A/B/C, continuation, overhead, response reserve, and safety. This output check prevents committing a replacement that is already too large. Model/source binding, tool readiness, sole submission, cancellation, and persisted-commit checks remain required. The planning reserve is not a provider output cap. The main-agent payload hook caps the field already selected by Pi only for `openai-completions`. Codex and other APIs remain unchanged.

Helper calls separately require an effective request-local output cap accepted by the selected adapter. Their payload guard checks the cap, no-tools contract, route, fallback controls, and request bytes. Uncapped subscription routes, unknown adapters, and unverified router routes are not silently accepted as helpers. Account readiness and model metadata are not independent proof of remote capacity or entitlement.

The current request estimator uses native usage only for the unchanged conversation projection. Otherwise, it uses Pi's message conversion and estimates, including Pi's image estimate. A restart never inherits usage from the old full prefix. Chrono does not estimate the provider JSON again or add a separate image charge. Accounting does not delete or rewrite outgoing media to obtain fit. Public-hook estimates are not exact tokenizer or final-wire measurements.

The interval path requires loaded Pi 1.1 public behavior, including the edit-aware `buildSessionProjection`, actionable `turn_end` and `agent_before_settle` proposals, and context/provider hooks. Ordinary manual compaction also uses `session_before_compact`, `session_compact`, and notification-only `agent_settled`. Current-agent and deterministic recovery proposals do not emit `session_compact`; later public context or boundary observation must find the exact persisted correlated entry. A returned proposal cannot release the provider barrier. Continuation records suppress duplicate local dispatch only, not exactly-once execution across crashes.

The current `before_provider_request` check preserves request scope, summary lifecycle, and the supported output cap. Cancellation at this hook is late and best effort. The earlier context hook controls ordinary versus summary-only work. Normal, preview, and emergency precommit checks also charge the expanded handoff, A/B/C, and continuation without using an old usage anchor. An oversized restart packet refuses before commit. Late abort on cached Codex transport is not reliable. Later hooks, cached transports, and serialization can change the request or dispatch timing. The offline public-SDK check exercised hook, commit, and continuation ordering. Actual provider transport and loaded-session behavior remain separate limits. Registering a handler or pinning Pi 1.1 does not establish that acceptance.

Source: [automatic policy](../../../packages/pi-chrono-compaction/src/interval-policy.ts), [request/media accounting](../../../packages/pi-chrono-compaction/src/context-budget.ts), [public boundary contracts](../../../packages/pi-chrono-compaction/src/interval-runtime.ts), and [live hook consumers](../../../packages/pi-chrono-compaction/src/pi-extension.ts).

## Refusal, recovery, and compatible rollback

Source changes, stale operations, unsafe tool boundaries, oversized protected content, and unavailable capabilities refuse rather than weaken guards. A failed exchange preserves source and pauses ordinary provider work. Direct user input or `/compact` can request fresh summary-only admission. Do not repeatedly retry an unchanged refusal or silently select the older compiler as fallback.

The separate deterministic recovery adapter labels the absence of a fresh current-agent handoff and continuation. It preserves effective user wording since the previous commit, an explicitly as-of older checkpoint, and native/source recovery references. An older checkpoint can be stale. Unsupported protected media refuses unless C preserves it exactly. Required content that exceeds the bound refuses, with source and size information. This path does not reissue the oversized ordinary request, rewind a branch, invent authorship, or authorize repeating uncertain side effects. An aborted path does not automatically resume work.

Recover original evidence with the existing [history tools](../history/indexing-and-exact-recovery.md), including exact source and shard locators after rollover. A generated archive or handoff is not accepted Memory and does not replace original evidence. Current native state remains with its owners.

The [migration report](../../../packages/pi-chrono-compaction/src/user-config.ts) retains legacy target/replay budgets, trigger thresholds, tail presets, summary targets, value-worker knobs, precompute/projection settings, and hot/warm controls for older paths and rollback. These keys do not govern `interval-v1`. Ownership, indexing, physical rollover, and worker-admission settings are separate contracts, not obsolete tuning fields to delete. The scoped interval reset removes only `historyHelpers`, not unrelated settings or native data.

Rollback must preserve original sessions, source shards, manifests, provider stores, later settings, and both compatible source generations. Restore only intended selection/configuration fields. Do not restore session JSONL files or replace a whole old settings document. Older code must be able to read the active receipt/checkpoint/store formats. Code rollback alone cannot reverse new native writes. Use [data-preserving rollback](../operations/troubleshooting-and-rollback.md#data-preserving-rollback-after-new-writes) when needed.

Source: [deterministic recovery](../../../packages/pi-chrono-compaction/src/interval-recovery.ts), [configuration migration/reset](../../../packages/pi-chrono-compaction/src/user-config.ts), and [runtime guards](../../../packages/pi-chrono-compaction/src/pi-extension.ts). Source/document checks, the package typecheck/build, and the bounded offline public-SDK lifecycle check passed. These checks establish no real-model quality result, GitHub publication, or loaded local activation.

[Chrono index](../README.md) · [Package](../../../packages/pi-chrono-compaction/README.md) · [Approved baseline](../compaction-reference/reference.md)
