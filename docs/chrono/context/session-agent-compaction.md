---
title: Session-agent compaction contract
audience: [agents, maintainers]
status: implemented in isolation, model output not yet accepted
purpose: Preserve the required context shape and the evidence needed before activation.
related:
  - compaction-and-budgets.md
  - retention-and-projections.md
  - ../architecture/contracts-and-trust.md
---

# Session-agent compaction

## Required result

The session agent helps compact its own context. Ask that agent for the continuation summary at the end of the context it already uses. Do not create another agent or serialize the conversation into a different summarizer prompt. Selecting the same model for a separate summarizer does not satisfy this requirement.

The next model-facing context has this order:

1. **Continuation summary written by the session agent.** Preserve the current goal, the user's latest corrections, decisions and their limits, what actually happened, unfinished work, and necessary next actions. Distinguish evidence from claims. The summary must not invent approval or promote old restrictions into new instructions.
2. **Programmatically compressed chronological events.** Preserve the natural User, Assistant, tool-call, and tool-result sequence. Keep useful arguments, outcomes, source meaning, and concise exact-recovery routes. Give currently relevant events more detail. Reduce redundant or obsolete detail before dropping useful events. Do not render a category-sorted report or dump native JSON cards.
3. **Only the necessary exact tail.** Retain content the summary-producing request did not consume and any additional messages needed for valid pending interactions. Preserve complete tool-call/result pairs. Do not reserve thousands of tokens merely because an old tail preset did so.

The summary and chronological replay complement each other. A summary alone, deterministic extracts alone, a rewritten rollover message, and a handwritten output mockup are not substitutes.

## Selection and source rules

- Preserve original JSONL and exact-source recovery. Compaction changes the model-facing view, not the source.
- Use bounded recent event input. Do not rebuild lifetime history at a compaction boundary.
- Keep chronological order after relevance-based detail selection.
- Native Memory, Todo, Notes, and Workplan are fallible evidence. A saved record is not automatically current, relevant, true, or authoritative.
- Default current-work selection must not let archived or completed records displace open work. Apply lifecycle selection before bounded record and byte fitting. Keep archive recovery available.
- Keep full receipts, internal scores, classification labels, omitted-record inventories, and provider transport metadata outside the main context. Show only the short notices and recovery routes needed to interpret the content safely.
- Keep the 32,000-token default for Chrono-owned context. Charge the complete summary, replay, exact tail, and required framing. Account separately for system text, tools, and response reserve. Label estimates as estimates.
- Refuse a stale, mismatched, cancelled, or unusable compaction rather than silently return the rejected old representation. If a summary cannot be requested safely after overflow, preserve the source and report that limit.

## Session and cache behavior

Use the current session's normal agent request path, effective instructions, model, tools, and conversation. A compaction request adds a small summary instruction at the end. It must not replace the system prompt with a summarizer role or create a new routing session merely for summarization.

Bind the requested summary to the session, consumed boundary, and actual assistant submission. Later tool results and user input must not be falsely described as consumed. Use public Pi hooks. Do not patch private AgentSession methods or interrupt unrelated tools and agents.

Prompt-cache reuse is a verification goal, not a consequence that follows from using the same model. Compare the effective request prefix and provider usage. Report unsupported provider evidence, cold-cache behavior, or unrelated prefix changes honestly.

## Pi 0.85.1 integration limits

Use the installed declarations and implementation to check public-hook behavior. The installed `docs/session-format.md` describes `retainedTail`, but `CompactionResult`, `AgentSession.compact()`, and `SessionManager.appendCompaction()` in Pi 0.85.1 do not pass that field. Returning `retainedTail: []` from an extension therefore does not remove the old tail. Use a verified `firstKeptEntryId` boundary instead.

`message_end` precedes persistence. `turn_end` sees the completed tool results in source order. A tool result with `terminate: true` ends the automatic continuation only when every result in its batch terminates. Require the summary submission to be the assistant's sole tool call, then settle it at `agent_settled` with no pending input.

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

Implementation is authorized in isolation. GitHub publication and live activation are not authorized. The user must approve the actual output before activation or V4 closeout. Record observed results separately from this target contract.

## Verification status

Source typecheck and six focused offline tests pass. The checks cover the native current-state selection, pure summary guards, chronological compiler, and registered tool/hook exchange. The hook fixture uses Pi's in-memory SessionManager with synthetic messages. It does not run an AgentSession or call a model. The fixture preserves its original session entries. Preview and active compiler output match at the same captured input, and the retained tail has one small verified boundary message. The later post-commit resume message is separate from that pre-commit tail.

These checks do not establish model-written summary quality, final request-prefix equality, cache reuse, live timing, or activation. The actual same-agent generated preview is still pending. The user approved a temporary same-session preview-only load because the installed old tool cannot accept the new submission fields. Do not substitute a manually supplied summary or a new summarizer agent for that missing evidence.

The private `sessionAgentPreview` integration option uses the registered summary tool and the same capture and compiler functions. It pins the intended session, source, settings, and response reserve. It skips candidate background work and vetoes native compaction for the entire temporary load. Its callback receives the complete result after safe-idle settlement. Call `revalidate()` during the callback, including after an awaited file write. That function is no longer valid after the callback returns and the summary ticket is cleared. The adapter does not start a model turn, apply compaction, or send a continuation. The extended existing hook fixture verifies this dispatch without a model or live session.
