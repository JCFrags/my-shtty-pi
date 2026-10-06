---
title: Session-agent compaction contract
audience: [agents, maintainers]
status: implemented, preview reviewed, process-specific activation
purpose: Preserve the required context shape and distinguish source-bound verification from loaded activation.
related:
  - compaction-and-budgets.md
  - retention-and-projections.md
  - ../architecture/contracts-and-trust.md
---

# Session-agent compaction

## Required result

The session agent helps compact its own context. Ask that agent for the continuation summary at the end of the context it already uses. Do not create another agent or serialize the conversation into a different summarizer prompt. Selecting the same model for a separate summarizer does not satisfy this requirement.

The next model-facing context has this order:

1. **Continuation summary written by the session agent.** Preserve the project purpose, useful exact code locations, how and why the approach was chosen, and the direction now authorized. Keep the current goal, the user's latest corrections, decisions and their limits, what actually happened, unfinished work, and necessary next actions. Include external waits and approval gates for paused or archived work, with saved plan IDs and native recovery routes. Distinguish evidence from claims and unknown facts. The summary must not invent approval or promote old restrictions into new instructions.
2. **Programmatically compressed chronological events.** Preserve the natural User, Assistant, tool-call, and tool-result sequence. Keep useful arguments, outcomes, source meaning, and concise exact-recovery routes. Give currently relevant events more detail. Reduce redundant or obsolete detail before dropping useful events. Do not render a category-sorted report or dump native JSON cards.
3. **Only the necessary exact tail.** Retain content the summary-producing request did not consume and any additional messages needed for valid pending interactions. Preserve complete tool-call/result pairs. Do not reserve thousands of tokens merely because an old tail preset did so.

The summary and chronological replay complement each other. A summary alone, deterministic extracts alone, a rewritten rollover message, and a handwritten output mockup are not substitutes.

## Meaningful task transitions

Use the existing `request_compaction({})` exchange when the authorized task or direction changes and substantial earlier detail is no longer useful. A major milestone is a cue to evaluate that change, not completion proof. Do not compact automatically after every ordinary milestone, checkpoint, successful test, status update, or temporary wait. No Workplan event listener or second compactor is involved.

Before the request, recover missing project facts through permitted reads and save a checkpoint when applicable. Preserve purpose, useful code locations, approach/reasons, current focus, next actions, unresolved obligations, and approval gates. Pending native state is not empty state. If leaving a project, pause it. Archive only when intended, without completing unfinished work, and retain its ID and recovery route.

After state writes settle, request compaction once, preferably as the sole call. The next response submits the summary as its sole tool call. Do not retrieve more state or start another operation between those calls. Reduce superseded alternatives, repetitive troubleshooting, and completed implementation detail before useful evidence. Keep decisive results and uncertainty. Relevance hints should describe the next direction and decisive evidence, not retain all old detail.

Existing source/model/epoch/expiry binding, safe-idle settlement, cancellation, stale-input refusal, and one-ticket rules remain unchanged. Repeated calls do not create a queue or a durable exactly-once transition record. Do not repeat a request merely because a checkpoint, restore, or compaction notice is visible. Continue only previously authorized work after a confirmed commit. If no next task is authorized, preserve the wait or stopping point. Saved guidance and lifecycle status are not new permission.

This policy guides agent judgment; it does not detect semantic task changes in code. If Chrono is unavailable or not permitted, retain the checkpoint and report that compaction was not requested.

## Selection and source rules

- Preserve original JSONL and exact-source recovery. Compaction changes the model-facing view, not the source.
- Use bounded recent event input. Do not rebuild lifetime history at a compaction boundary.
- Keep chronological order after relevance-based detail selection.
- Native Memory, Todo, Notes, and Workplan are fallible evidence. A saved record is not automatically current, relevant, true, or authoritative.
- Default current-work selection must not let archived or completed records displace open work. Apply lifecycle selection before bounded record and byte fitting. Keep archive recovery available.
- Keep full receipts, internal scores, classification labels, omitted-record inventories, and provider transport metadata outside the main context. Show only the short notices and recovery routes needed to interpret the content safely.
- Keep the configured context ceiling unchanged, including its 32,000-token default. This is a maximum, not a target. Apply the adaptive replay policy below within the remaining allowance. Charge the complete summary, replay, exact tail, and required framing. Account separately for system text, tools, and response reserve. Label estimates as estimates.
- Refuse a stale, mismatched, cancelled, or unusable compaction rather than silently return the rejected old representation. If a summary cannot be requested safely after overflow, preserve the source and report that limit.

## Pi context edits

Apply the latest applicable `context_edit` before extracting replay content. A null replacement omits the message. A non-null replacement supplies its content while preserving the source ID, role, and tool metadata. Only edits on the active branch and within Pi's latest retained context apply. Edits after the replay cut still affect their earlier targets.

Replay checks edit and compaction metadata through the complete active branch. It retains edit references only for the bounded replay candidates and does not copy lifetime message bodies. Locked Pi 0.85.1 does not export `buildSessionProjection`, so capture uses a small compatibility adapter. Focused synthetic fixtures match installed Pi 0.87.1 projection behavior. This does not widen the package's declared Pi compatibility range.

Exact raw `history_get` remains unchanged. Context edits do not rewrite source JSONL or remove text already copied into an older saved summary. The summary-submission freshness guards remain in force.

## Adaptive replay selection

Replay starts with a preferred allowance of 5,000 estimated tokens. This is a starting heuristic, not a measured optimum, a minimum size, or a new context setting. The compiler still supplies the hard replay limit after it charges the continuation summary and exact tail. The final complete-request check is unchanged.

Selection happens before token fitting. User wording, relevant evidence, explicit error outcomes, and a small recent suffix are eligible. Older unrelated tool output is not retained merely because it fits. Repeated tool excerpts keep the latest representative. This is excerpt deduplication, not proof that the original entries are identical or that an error was resolved. Omitted entries keep their original recovery IDs.

A polling call does not prove that its result is routine. Only empty results, explicit empty process/session lists, or the recognized nonterminal process-status envelope receive that classification. Final stdout, failures, agent handoffs, and other substantive results use normal evidence admission. A recent relevant status-only poll can remain as a brief excerpt, but cannot expand the preferred allowance.

Replay combines submitted model hints with bounded native commit and concrete path references. Collect the current pages before selecting events, then retain those same pages in the receipt. Keep model hints first. Native terms use only ready pages with known current lifecycle states: `pending`, `in_progress`, or `blocked` Todo items, `active` Notes, `draft`, `active`, or `paused` Workplans, and `active` accepted Memory knowledge. Closed records, unknown statuses, and proposals do not supply implicit hints. If the captured Workplan page has an active plan, draft and paused plans do not supply implicit hints. Otherwise, open plans can supply bounded resource references. The native allowance is at most 16 terms within the existing 24-term, 160-unit-per-term limit. Native terms are selection data, not instructions or proof that historical work remains open. Collected native cards do not enter the rendered context as a separate state dump.

Implicit terms admit absolute paths, dot-relative paths, relative paths with a filename extension, and commit-shaped hexadecimal tokens. Recognition is a syntax filter, not filesystem or commit validation. URLs, generic prose, and bare native record IDs do not supply implicit terms. Prose-only tasks and extensionless relative directories may supply no native terms. Do not fill unused slots with broader text. Native IDs and recovery descriptors remain unchanged in the receipt, and explicit model hints remain available.

These hints are fallible relevance terms. A direct match or two significant words from one hint can admit an event. Expansion requires a direct match, overlap with at least two hints, matching user wording, or an explicit error among the last eight captured events. A single weak word overlap and an older unmatched error cannot expand replay. These rules do not determine whether historical work is still open. The continuation summary remains the primary current-state account.

The effective allowance can grow only to the preferred-detail cost of expansion-eligible evidence, and never above the compiler's hard limit. Routine and older optional detail cannot cause that growth. Fitting removes optional detail first, then reduces important detail before omitting useful events. Selected excerpts remain in source order. Short histories do not fill unused space.

Receipts retain the existing selected and omitted ID fields. The `adaptive-replay-v1` policy adds the preferred, effective, and hard replay allowances, expansion demand, and content-free selection reasons. The replay receipt records its actual bounded terms. The submitted model hints remain unchanged in the session-summary receipt. The model-facing text discloses selection and allowance omissions, gives a captured-interval `history_range` route, and keeps each selected entry's exact `history_get` reference. Source JSONL, exact recovery, and submission freshness guards are unchanged. The later `4.0.7-local.20261001` release adds prompt guidance for project purpose, code locations, approach, unresolved work, and approval gates. It does not change replay selection or admission.

Two focused synthetic scenarios check selective admission below the preferred allowance, multiword hints, useful poll output, relevance-driven expansion, stale and repeated errors, source order, recovery IDs, and complete-context fitting. They do not establish semantic completeness, an optimal allowance, or loaded activation. Real-prefix practical verification remains separate.

## Session and cache behavior

Use the current session's normal agent request path, effective instructions, model, tools, and conversation. A compaction request adds a small summary instruction at the end. It must not replace the system prompt with a summarizer role or create a new routing session merely for summarization.

Bind the requested summary to the session, consumed boundary, and actual assistant submission. Pi can persist native system prompt or tool-definition updates after `turn_end` and before the summary request reaches the `context` hook. These pre-consumption updates belong to the summary-producing request and do not interrupt it. System updates after consumption still invalidate the submission or result boundary. Keep this exception out of general metadata handling. Later tool results and user input must not be falsely described as consumed. Use public Pi hooks. Do not patch private AgentSession methods or interrupt unrelated tools and agents.

Prompt-cache reuse is a verification goal, not a consequence that follows from using the same model. Compare the effective request prefix and provider usage. Report unsupported provider evidence, cold-cache behavior, or unrelated prefix changes honestly.

Keep `request_compaction` active before normal requests begin. With Progressive Tools, add `{ "name": "request_compaction" }` to `alwaysActive`. Preserve other rules. A blocked rule still wins. Chrono refuses an unavailable submission tool before sending the summary request. It does not activate tools behind the policy or ask for help during the sole-submission exchange.

Pi can insert a newly reactivated definition at its first historical `addedToolNames` marker. Reload removes managed activation but preserves those markers. Reactivation can therefore change an old input prefix while leaving the immediate tool-schema list unchanged. Stable activation avoids that transition within the exchange, but does not guarantee provider cache reuse.

## Failure barrier and deliberate recovery

In `4.0.8-local.20261002`, V4 failures suspend ordinary provider work. A refused or interrupted tool terminates its turn and aborts the active run. An oversized submission can fail native schema validation before the tool executes. The following `turn_end` detects the missing valid submission and stops further model work. A sibling tool from an already-issued batch can already be in flight. The barrier cannot undo completed tool effects.

`history_status.composition.providerBarrier` shows `open`, `summary-only`, or `paused`, plus the retry latch and recovery condition. Summary acceptance does not release the barrier. Neither a new agent run nor index/startup readiness releases it. A correlated native commit must match the pending epoch, session, source, parent, receipt, summary hash, and extension origin. A V4 commit with no matching pending receipt is not successful recovery.

Direct user input or explicit native `/compact` permits one fresh, summary-only attempt after strict admission. A freshly admitted `request_compaction({})` returns the same existing request prompt. It does not reuse the failed ticket or first reopen ordinary work. If recovery cannot fit, remain paused and report the blocker. Extension-generated input does not permit recovery. Tree, model, thinking-level, and session changes invalidate old requests. A deliberate branch move does not delete or silently merge the abandoned suffix.

The early `context` hook checks current headroom before provider setup. At the proactive threshold, it pins a scoped intent and aborts the ordinary run. Create the fresh summary ticket only after safe idle. Validate expiry, session, model, thinking level, epoch, and native ancestry again. Only metadata, native system deltas, and at most one empty aborted/error assistant artifact may follow the pinned leaf. Ordinary tool work, user input, partial output, and a branch rewind invalidate that intent.

The final `before_provider_request` check retains the admitted floor and adds positive final-payload growth above the separately captured early projection estimate. A valid positive native observation permits only known Codex `input` reasoning `encrypted_content` to use that estimated floor instead of a ciphertext-length text charge. Visible summaries, conversation, system instructions, schemas, and other fields remain charged. The native observation is not proof of exact provider tokenization or zero-cost reasoning. Null usage and unknown APIs keep the full serialized-payload estimate. Invalid observations and malformed opaque fields refuse. Accounting does not change the original payload.

Late cancellation is best effort. Throwing from that handler is not cancellation: installed Pi catches handler errors and continues. Chrono calls public `ctx.abort()` instead and leaves the normal payload unchanged. Installed Pi 0.99.1 cached Codex can invoke a send before checking the aborted signal. The offline native fixture with the actual early guard made zero extra sends for known paused and headroom states. An artificial late payload mutation reached the final guard, which aborted but still invoked one cached send. This is a provider dependency limit, not an all-provider or real-network guarantee. No host upgrade or private runtime patch is required by this implementation.

## Post-commit continuation

The earlier `4.0.10-local.20261006` hotfix retained one scoped continuation intent after a correlated V4 commit. Installed Pi 0.99.1 awaits `session_compact` handlers while its compaction flag is still set. A later awaited handler can therefore outlast a zero-delay callback. Manual compaction emits no later `agent_settled` event. The former callback discarded a busy continuation permanently.

The current implementation captures eligibility from the original live run before the summary exchange changes its messages or stops that run. An observed agent loop with actual user or custom-message input can supply eligibility. A passive stored custom message, an old non-stop assistant response, and open Todo or Workplan records cannot. The original assistant's final or aborted response clears unresolved work. An explicit model-issued `request_compaction` remains eligible because it interrupts that agent's current authorized turn. The summary's own `toolUse` response supplies no permission. An idle manual request after final output can compact but cannot start an ordinary continuation.

Incoming input invalidates the old intent before Pi persists the new prompt. If native pre-prompt compaction still sees the previous leaf, Chrono defers that attempt and waits for the actual new context. This deferral does not release a paused provider barrier.

After a correlated V4 commit, the owned manual `ctx.compact` completion callback drains the intent after native cleanup. For an automatic path, Pi 0.99.1's actionable `agent_before_settle` boundary can return one hidden continuation message. Native retry and queued work take precedence. This boundary does not require `ctx.isIdle()`, which is false inside the surrounding run. `agent_settled` is notification-only and does not dispatch a continuation. `deliverAs: "nextTurn"` cannot wake an idle session.

Both dispatch paths consume the intent before use and keep exact session, source, branch leaf, model, thinking-level, epoch, receipt, summary-hash, expiry, cancellation, and paused-provider checks. They add no polling loop or second compactor and cannot release a failure barrier without a correlated commit. A small structural adapter exposes the installed Pi 0.99.1 boundary while the development SDK remains pinned to Pi 0.85.1. V3 continuation remains separate.

Historical focused synthetic checks held the compaction hook open across the zero-delay callback, verified one owned completion resume, and kept completed idle manual work idle. Those checks do not establish the current live-run capture or actionable-boundary behavior. The current lifecycle changes have no new practical-use or live-activation evidence in this document.

## Pi 0.85.1 integration limits

Use the installed declarations and implementation to check public-hook behavior. The installed `docs/session-format.md` describes `retainedTail`, but `CompactionResult`, `AgentSession.compact()`, and `SessionManager.appendCompaction()` in Pi 0.85.1 do not pass that field. Returning `retainedTail: []` from an extension therefore does not remove the old tail. Use a verified `firstKeptEntryId` boundary instead.

`message_end` precedes persistence. `turn_end` sees the completed tool results in source order. A tool result with `terminate: true` ends the automatic continuation only when every result in its batch terminates. Require the summary submission to be the assistant's sole tool call, then settle it at `agent_settled` with no pending input.

The user-approved summary headroom policy reserves 16,384 tokens for planning, or the valid `model.maxTokens` value if it is smaller. This is not a provider-enforced output cap. The installed `openai-codex-responses` request builder does not serialize an output-token cap. [LiteLLM's ChatGPT documentation](https://docs.litellm.ai/docs/providers/chatgpt) and the [openai-codex-auth client documentation](https://pypi.org/project/openai-codex-auth/) report that the subscription backend rejects token-limit fields. Keep model metadata, provider fields, and the request prefix unchanged. The provider can generate more than the planning allowance.

Admission requires the current token estimate, plus `ceil(request.length / 4)`, the planning allowance, the configured Chrono reserve, and the existing 1,024-token safety allowance to be strictly below the model context window. Use the largest current-projection estimate, native usage, or newer turn-end observation. Charge current system text, complete active schemas, framing, and native system/tool deltas that the locked converter omits. When the summary prompt is already in the projection, do not charge it twice. Native usage can be null on the first valid post-commit continuation. Estimate the current compacted projection, not zero usage or lifetime history. Recheck admission before a deferred request is sent and at the final provider hook. Keep invalid-usage and invalid-model refusals, tool readiness, source/model binding, submission limits, and sole-call validation.

Normal proactive timing uses the earliest of the configured threshold, 75% of the model context window, and the maximum-request admission limit minus a 4,096-token lead. The 12 KiB request bound reserves 3,072 estimated prompt tokens for this timing calculation. With a 272,000-token window, `maxTokens: 128000`, and the default 1,500-token Chrono reserve, this headroom threshold is 245,924 tokens. A configured threshold of 200,000 therefore triggers first. A correlated V4 commit clears the prior attempt's token count so the next context cycle does not wait to exceed the old count. Pending requests and failed-attempt controls remain in force. A large single turn can still pass the admission limit. Refuse that request and preserve source history rather than weaken the guard. These are estimates, not tokenizer measurements or output guarantees.

The V4 session-agent request has a dedicated soft target of 3,000 estimated tokens by default, configurable from 256 to 4,096. The default prompt gives a soft length guide of 12,000 UTF-16 units. The prompt guide uses the smaller of `targetTokens * 4` and 15,360 UTF-16 units to leave room below the unchanged hard limits of 16,384 UTF-16 units and 24 KiB. These are text-length estimates, not tokenizer measurements or provider output caps. Configure the target with `PI_CHRONO_SESSION_SUMMARY_TOKENS` or the V4 session-agent summary target menu. The V3 hybrid target, `PI_CHRONO_PI_SUMMARY_TOKENS`, and V3 regular Pi summary menu remain separate and do not control V4. Native schema validation can reject an oversized submission before the tool handler runs. The following `turn_end` then refuses the unaccepted ticket. Do not resubmit that ticket or weaken the guard. Preserve the failure and use a shorter summary in a new, deliberately initiated attempt within the approved scope.

At safe idle, `sendMessage(message, { triggerTurn: false })` without `deliverAs` appends a custom message through the public API. Verify that message's exact leaf, parent, type, content, and details before using it as the minimal retained boundary. `deliverAs: "nextTurn"` only queues a message and cannot establish that boundary.

A native compaction hook cannot wait for another turn from the same agent. Defer a manual summary request until the hook has unwound and the session is idle. An idle `sendMessage(..., { triggerTurn: true })` uses the existing agent prompt for its first response without `before_agent_start`. Later between-turn refreshes can change that prompt. Require the immediate sole submission rather than allowing unrelated work between the request and submission. These source-level checks do not prove final provider payload equality or cache reuse.

## Acceptance evidence

One bounded real-history preview must use the actual candidate summary-submission and compiler paths. Preserve the rejected baseline unchanged.

The preview must include:

- The complete actual model-written summary, compressed chronology, and exact tail, without substituting an example.
- Candidate source identity, source cut, output hashes, and bounded coverage.
- Proof that the summary came from the session agent's normal request path, not a helper agent or standalone summarizer call.
- Request-prefix and cache evidence with explicit limits.
- A role/order and tool-pair check against source, useful arguments and outcomes, and exact recovery of a selected reduced event.
- A default current-state check in which a newer open plan survives older archived plans.
- A complete context-budget result and an explanation of why the exact suffix is needed.

Inspect the result as an agent would use it: can the agent identify the current task, preserve the user's correction, distinguish old work from pending work, and find the evidence needed to continue? Passing structural checks alone does not establish useful context.

The initial isolated implementation did not authorize GitHub publication or live activation. Its acceptance gate required the user's review of actual output before activation or V4 closeout. That historical restriction is not the current publication scope. See the [current source and activation boundary](../design/evidence-and-roadmap.md#current-source-boundary). Record observed results separately from this target contract.

## Verification status

The bounded native-state relevance bridge passed the two affected compiler and hook test files, with three synthetic tests and no failures. A current Workplan path admitted older source call/result evidence that the explicit model hints did not match. Completed and archived cards did not supply implicit terms. The checks also verified the 24-term limit, unchanged explicit hints, one native collection per preparation, source order, recovery IDs, zero native rendered tokens, preview/active parity, and stale-schema refusal. The hook uses an in-memory SessionManager and synthetic submissions. These checks do not establish semantic completeness, real model-written summary quality, or loaded activation.

The earlier isolated implementation passed six focused offline tests. Its later source typecheck and two affected summary/hook tests passed. The hook fixture uses Pi's in-memory SessionManager with synthetic messages. It does not run an AgentSession or call a model. It verifies source preservation, preview/active compiler parity, a small retained boundary, and refusal when the submission tool is unavailable. The extended assertions verify strict headroom admission, configured and headroom-based proactive timing, refusal after a single-turn overshoot, and a fresh trigger cycle after a successful commit.

A genuine same-session preview was generated and the user reviewed its overall shape. History compression can improve incrementally. That preview used the recent interval after housekeeping compaction, not the original pre-first-compaction fixture. Its configured ceiling was 40,000 tokens. Summary generation reported 11.17% cached input. The activation-related early prefix change was reproduced through Pi's offline serializer, but the cause of the later low reuse remains unknown.

Recompiling the same saved input with relevance-based preferred detail reduced estimated context from 35,967 to 13,048 tokens. It kept the summary unchanged and all 82 captured events in source order. Ceilings of 32,000 and 40,000 produced identical text. This checks ceiling behavior on one captured input, not semantic completeness or a new live compaction. No additional model request was made. At that stage, the bounded summary headroom policy was approved for isolated implementation. That comparison did not verify activation. The corrected live high-context exchange remains unverified.

For the context-edit and adaptive replay changes, four synthetic edit fixtures matched installed Pi 0.87.1 projection behavior across 25 captures. Combined edit, replay, compiler, and hook checks passed. A fixed real conversation prefix reused its saved summary without a model call. Estimated replay decreased from 17,833 to 6,971 tokens, with 46 of 156 events selected. Total compiled context was 9,833 tokens under the unchanged 40,000-token ceiling. Practical continuation review found no blocking gap and verified source order, roles, recovery IDs, and truthful omission notices. This checks one prefix, not semantic completeness, a live summary exchange, or activation. The source and saved summary remained unchanged.

The later local release is `4.0.5-local.20260926`, with Chrono source `be67e0ec` and native ancestry correction `0121b02`. Its Chrono verifier reported 704 passed, zero failed, and two skipped. Loaded activation was separately verified in the coordinating process only. It does not establish fleet adoption, complete indexing, or a new committed compaction. GitHub acceptance is separate from these local results.

The `4.0.8-local.20261002` candidate passed the two affected offline suites and two installed-native evidence drivers on Pi 0.99.1. A valid two-call handoff made three provider requests, committed once, and continued once with null native usage handled by projection estimation. A rejected mixed batch stopped after its second request. One direct summary-only recovery then committed once and continued once. Oversized submission, response overshoot, tool-result growth, and input growth stopped further ordinary requests. Source entries remained unchanged. The cached-Codex fake socket recorded zero additional sends for the actual early paused/headroom guards, and one send after an artificial late mutation and final-hook abort. The fixtures used synthetic history, scripted usage, and no real credentials or network. They do not reproduce the original incident, establish model-written summary quality, or verify GitHub integration or live activation. The declared Pi API target remains 0.85.1.

The private `sessionAgentPreview` integration option uses the registered summary tool and the same capture and compiler functions. It pins the intended session, source, settings, and response reserve. It skips candidate background work and vetoes native compaction for the entire temporary load. Its callback receives the complete result after safe-idle settlement. Call `revalidate()` during the callback, including after an awaited file write. That function is no longer valid after the callback returns and the summary ticket is cleared. The adapter does not start a model turn, apply compaction, or send a continuation. The extended existing hook fixture verifies this dispatch without a model or live session.
