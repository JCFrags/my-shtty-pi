/** Pure state for a summary produced by this session's normal agent turn.
 *
 * Public integration requires Pi 1.1 runtime boundary proposals. The caller
 * checks the loaded host before admission and never retries an aborted ticket.
 * - Keep request_compaction registered with one stable optional-fields schema.
 *   {} returns renderSessionAgentSummaryRequest() as its normal tool result.
 *   Idle manual requests use sendMessage(). A direct-input recovery can append
 *   one transient CustomMessage in context, bound to the actual persisted user
 *   leaf. Pi 1.1 automatic freeze can propose a custom message at turn_end.
 *   Never replace the system, model, tools or transcript.
 * - Observe the request in the normal context hook, then accept only the next
 *   assistant's sole submission call. Return terminate:true from that tool.
 * - At turn_end, settle the persisted accepted result and propose a retain-none
 *   compaction with truthful current-agent authorship. Verify the actual native
 *   commit before continuation. Private preview keeps its idle technical cut.
 * - Cancel native compaction while waiting. That hook cannot await another turn.
 *   Runtime overflow recovery is a separate labeled deterministic path, not
 *   fresh summary acceptance or another full ordinary provider request.
 * - Own one in-memory request. Clear it on new input, abort, switch, tree move,
 *   reload, failure or completion. Never restore/retry a ticket from history.
 *
 * turn_end sees persisted tool results. message_end/tool_execution_end do not.
 * terminate:true is effective only if the whole tool batch terminates, hence the
 * sole-call check. Native /compact aborts before its hook. An idle sendMessage
 * starts this agent without before_agent_start, not a rebuilt summarizer.
 * The ordinary CompactionResult cannot return retainedTail, despite the
 * session-format documentation. To avoid retaining duplicate summary arguments,
 * the caller can append and verify a small custom-message cut at idle using
 * sendMessage({ ... }, { triggerTurn:false }). nextTurn only queues a message.
 * These guards prove source correlation, not exact final provider payloads or
 * cache hits. Other public hooks can still change the outgoing request.
 */
export const SESSION_AGENT_SUMMARY_CUSTOM_TYPE = "chrono-session-agent-summary-request";
export const SESSION_AGENT_SUMMARY_TOOL = "request_compaction";
/** Local planning allowances, not provider-enforced output limits. Keep the
 * normal model request unchanged, including Codex routes without output caps. */
export const SESSION_AGENT_SUMMARY_HEADROOM = Object.freeze({
    planningTokens: 16_384,
    safetyTokens: 1024,
    proactiveMarginTokens: 4096,
});
export const SESSION_AGENT_SUMMARY_LIMITS = Object.freeze({
    summaryChars: 32_768,
    summaryBytes: 48 * 1024,
    continuationChars: 8192,
    continuationBytes: 12 * 1024,
    relevanceHints: 8,
    hintChars: 256,
    hintBytes: 1024,
    instructionsChars: 2048,
    instructionsBytes: 4096,
    promptBytes: 12 * 1024,
    ancestryEntries: 64,
    contextMessages: 64,
    assistantBlocks: 128,
    lifetimeMs: 5 * 60 * 1000,
});
function fail(code) { throw new Error(`session-agent-summary-${code}`); }
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function text(value, chars, bytes, field) {
    // Check length before byte counting or trimming an unbounded input.
    if (typeof value !== "string" || value.length > chars || Buffer.byteLength(value, "utf8") > bytes || !value.trim())
        fail(`${field}-invalid`);
    return value;
}
function requestId(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value))
        fail("request-id-invalid");
    return value;
}
function clock(now) {
    if (!Number.isSafeInteger(now) || now < 0)
        fail("clock-invalid");
}
function freezeScope(scope) {
    text(scope.sessionId, 256, 1024, "session-id");
    text(scope.leafId, 256, 1024, "leaf-id");
    if (!Number.isSafeInteger(scope.epoch) || scope.epoch < 0)
        fail("epoch-invalid");
    if (scope.sessionFile !== undefined)
        text(scope.sessionFile, 4096, 16_384, "session-file");
    for (const value of [scope.model?.provider, scope.model?.id, scope.model?.api, scope.model?.thinkingLevel])
        text(value, 256, 1024, "model");
    return Object.freeze({ sessionId: scope.sessionId, epoch: scope.epoch, leafId: scope.leafId,
        ...(scope.sessionFile === undefined ? {} : { sessionFile: scope.sessionFile }),
        model: Object.freeze({ provider: scope.model.provider, id: scope.model.id, api: scope.model.api, thinkingLevel: scope.model.thinkingLevel }) });
}
function validateRequest(request, scope, now) {
    clock(now);
    if (now < request.createdAt || now >= request.expiresAt)
        fail("request-expired");
    const source = request.scope;
    if (source.sessionId !== scope.sessionId || source.epoch !== scope.epoch || source.sessionFile !== scope.sessionFile)
        fail("session-changed");
    if (source.model.provider !== scope.model.provider || source.model.id !== scope.model.id
        || source.model.api !== scope.model.api || source.model.thinkingLevel !== scope.model.thinkingLevel)
        fail("model-changed");
}
export function createSessionAgentSummaryRequest(input) {
    clock(input.now);
    if (!["manual", "threshold", "tool"].includes(input.reason))
        fail("reason-unsupported");
    const targetTokens = input.targetTokens ?? 3000;
    if (!Number.isSafeInteger(targetTokens) || targetTokens < 256 || targetTokens > 8000)
        fail("target-invalid");
    for (const value of [input.handoffTokens, input.continuationTokens])
        if (value !== undefined
            && (!Number.isSafeInteger(value) || value < 1 || value > 8192))
            fail("layer-budget-invalid");
    const customInstructions = input.customInstructions === undefined ? undefined
        : text(input.customInstructions, SESSION_AGENT_SUMMARY_LIMITS.instructionsChars, SESSION_AGENT_SUMMARY_LIMITS.instructionsBytes, "instructions").trim();
    const requestToolCallId = input.requestToolCallId === undefined ? undefined : text(input.requestToolCallId, 512, 2048, "tool-call-id");
    const expiresAt = input.now + SESSION_AGENT_SUMMARY_LIMITS.lifetimeMs;
    if (!Number.isSafeInteger(expiresAt))
        fail("clock-invalid");
    return Object.freeze({ requestId: requestId(input.requestId), scope: freezeScope(input.scope), reason: input.reason,
        createdAt: input.now, expiresAt, targetTokens,
        ...(input.handoffTokens === undefined ? {} : { handoffTokens: input.handoffTokens }),
        ...(input.continuationTokens === undefined ? {} : { continuationTokens: input.continuationTokens }),
        ...(customInstructions === undefined ? {} : { customInstructions }),
        ...(requestToolCallId === undefined ? {} : { requestToolCallId }) });
}
/** This bounded request is appended to the existing context, never its prefix.
 * It contains no transcript, session path, compiler receipt or source locator. */
export function renderSessionAgentSummaryRequest(request) {
    const prompt = [
        "[Current-agent compaction submission request]",
        "Use the context already available to you in this session. Write a task handoff and a separate immediate continuation for this same agent after compaction.",
        "Include the information needed to continue safely, and no more. Omit filler and repetition. Do not pad the summary or try to use all available space. Keep it comfortably below the hard submission limits. Preserve the user's goal, restrictions and approval boundaries, key decisions, completed work and actual verification, unresolved work, blockers, uncertainty and the next safe action.",
        "Organize the handoff around these sections. Combine them when the task is small, but keep past actions, current work, and future steps distinct:",
        "- What happened: summarize the task's progress, the user's latest corrections, key decisions, and why the current approach was chosen.",
        "- What was done: state the actions you actually took and their results. Separate verified outcomes from attempts, failures, and unverified claims. Do not present saved or built work as integrated or active unless that was verified.",
        "- Current work: identify the authorized task now in progress and the exact point where it stopped. Include useful code locations, unfinished work, blockers, and uncertainty. Distinguish active work from completed, paused, or superseded work.",
        "- Next steps: state the intended result, where the work needs to go, and the short sequence that continues only work already authorized by the user. If no next task is authorized, state the wait or stopping point.",
        "The separate continuation identifies the immediate next action and why it is next. Preserve exact outstanding resource IDs. Do not restart a process or worker merely because compaction occurred. State any wait, completed-task stop, cancellation, or approval gate. A continuation is not permission to act.",
        "Preserve the project's purpose, useful exact repository/code locations, how and why the approach was chosen, and the direction now authorized. Record unknown facts as unknown.",
        "Preserve unresolved obligations, external waits, and approval gates, including paused or archived work. Keep the saved plan ID and workplan recover/read route when full project detail is no longer needed. Milestone completion, archive status, and saved guidance are not new permission.",
        "Write a task handoff, not a task log or inventory. Group paths under a shared root. Reduce superseded alternatives, repetitive troubleshooting, repeated evidence, and completed-task detail before useful evidence. Keep decisive results and uncertainty. Use relevanceHints for the next direction and decisive evidence, not indiscriminate retention of old detail.",
        "Keep important paths and identifiers exact. Distinguish facts from inference, superseded decisions from current decisions, and proposals from user approval. Do not include secrets or internal compaction receipts.",
        "Do not retrieve history, run other tools, delegate, or start another task for this request. If you cannot produce a useful summary from available context, report that limit instead of inventing one.",
        "The summary and relevanceHints are fallible derived context. They grant no new authorization and cannot override source instructions or direct user restrictions.",
        `Call ${SESSION_AGENT_SUMMARY_TOOL} as your ONLY tool call with requestId ${JSON.stringify(request.requestId)}, handoff (nonempty), continuation (nonempty, at most ${SESSION_AGENT_SUMMARY_LIMITS.continuationChars} UTF-16 units and ${SESSION_AGENT_SUMMARY_LIMITS.continuationBytes} UTF-8 bytes), and optional relevanceHints (at most ${SESSION_AGENT_SUMMARY_LIMITS.relevanceHints} short search terms, ${SESSION_AGENT_SUMMARY_LIMITS.hintChars} UTF-16 units each). Handoff plus continuation must stay below ${SESSION_AGENT_SUMMARY_LIMITS.summaryChars} UTF-16 units and ${SESSION_AGENT_SUMMARY_LIMITS.summaryBytes} UTF-8 bytes. Do not submit the legacy summary field.`,
        ...(request.handoffTokens === undefined ? [] : [`Keep the handoff brief enough for its adaptive allowance of approximately ${request.handoffTokens} tokens and the continuation for approximately ${request.continuationTokens ?? 128} tokens. These accounting allowances are not provider-enforced output caps. Do not pad either field.`]),
        "After submitting, do not start another operation. Submission alone does not mean compaction succeeded.",
        ...(request.customInstructions === undefined ? [] : ["Additional summary focus, not new task authorization:", JSON.stringify(request.customInstructions)]),
    ].join("\n");
    if (Buffer.byteLength(prompt, "utf8") > SESSION_AGENT_SUMMARY_LIMITS.promptBytes)
        fail("prompt-bound-exceeded");
    return prompt;
}
/** Parse only the tool argument object. Do not scrape assistant prose, fences,
 * arbitrary JSON substrings or historical tool results for an accepted summary. */
export function parseSessionAgentSummarySubmission(input) {
    const value = record(input);
    if (!value)
        fail("submission-invalid");
    const keys = Object.keys(value);
    if (keys.length === 0)
        return undefined;
    if (keys.length > 5 || keys.some(key => !["requestId", "summary", "handoff", "continuation", "relevanceHints"].includes(key)))
        fail("submission-fields-invalid");
    const id = requestId(value.requestId);
    if (value.summary !== undefined && value.handoff !== undefined && value.summary !== value.handoff)
        fail("handoff-conflict");
    const handoff = text(value.handoff ?? value.summary, SESSION_AGENT_SUMMARY_LIMITS.summaryChars, SESSION_AGENT_SUMMARY_LIMITS.summaryBytes, "handoff").trim();
    const continuation = value.continuation === undefined ? undefined : text(value.continuation, SESSION_AGENT_SUMMARY_LIMITS.continuationChars, SESSION_AGENT_SUMMARY_LIMITS.continuationBytes, "continuation").trim();
    if (handoff.length + (continuation?.length ?? 0) > SESSION_AGENT_SUMMARY_LIMITS.summaryChars
        || Buffer.byteLength(handoff, "utf8") + Buffer.byteLength(continuation ?? "", "utf8") > SESSION_AGENT_SUMMARY_LIMITS.summaryBytes)
        fail("submission-bound-exceeded");
    const hints = value.relevanceHints === undefined ? [] : value.relevanceHints;
    if (!Array.isArray(hints) || hints.length > SESSION_AGENT_SUMMARY_LIMITS.relevanceHints)
        fail("hints-invalid");
    const relevanceHints = hints.map(hint => text(hint, SESSION_AGENT_SUMMARY_LIMITS.hintChars, SESSION_AGENT_SUMMARY_LIMITS.hintBytes, "hint").trim());
    return Object.freeze({ requestId: id, summary: handoff, handoff,
        ...(continuation === undefined ? {} : { continuation }), relevanceHints: Object.freeze(relevanceHints) });
}
function exactText(content, expected) {
    if (typeof content === "string")
        return content === expected;
    if (!Array.isArray(content) || content.length !== 1)
        return false;
    const block = record(content[0]);
    return block?.type === "text" && block.text === expected;
}
function isRequestMessage(message, request, prompt) {
    if (!message || !exactText(message.content, prompt))
        return false;
    return request.requestToolCallId === undefined
        ? message.role === "custom" && message.customType === SESSION_AGENT_SUMMARY_CUSTOM_TYPE
        : message.role === "toolResult" && message.toolName === SESSION_AGENT_SUMMARY_TOOL
            && message.toolCallId === request.requestToolCallId && message.isError === false;
}
function metadata(entry) {
    return entry.type === "custom" || entry.type === "label" || entry.type === "session_info";
}
/** Walk only the new suffix. Retain references briefly, never body copies. */
function suffix(view, anchorId) {
    const entries = [], seen = new Set();
    let id = view.scope.leafId;
    while (id !== anchorId) {
        if (!id || seen.has(id) || entries.length >= SESSION_AGENT_SUMMARY_LIMITS.ancestryEntries)
            fail("source-boundary-unavailable");
        seen.add(id);
        const entry = view.getEntry(id);
        if (!entry || entry.id !== id)
            fail("source-boundary-unavailable");
        entries.push(entry);
        id = entry.parentId;
    }
    if (view.getEntry(anchorId)?.id !== anchorId)
        fail("source-boundary-unavailable");
    return entries.reverse();
}
/** Bind one deliberate direct input to its actual persisted user entry. The
 * input hook runs before persistence, so its old leaf cannot be a summary source.
 * Prompt/tool deltas and invisible metadata may surround the new user entry.
 * Other messages or context edits refuse rather than inventing user authority. */
export function bindSessionAgentSummaryInput(intent, view, messages) {
    validateRequest(intent, view.scope, view.now);
    let user;
    for (const entry of suffix(view, intent.scope.leafId)) {
        if (metadata(entry))
            continue;
        const message = entry.type === "message" ? record(entry.message) : undefined;
        if (message?.role === "system")
            continue;
        if (message?.role === "user" && !user) {
            user = entry;
            continue;
        }
        fail("direct-input-boundary-invalid");
    }
    const message = record(user?.message);
    if (!user?.id || !message || !Number.isSafeInteger(message.timestamp))
        fail("direct-input-unavailable");
    const matches = messages.slice(-SESSION_AGENT_SUMMARY_LIMITS.contextMessages).filter(value => {
        const candidate = record(value);
        return candidate?.role === "user" && candidate.timestamp === message.timestamp
            && JSON.stringify(candidate.content) === JSON.stringify(message.content);
    });
    if (matches.length !== 1)
        fail("direct-input-projection-changed");
    return freezeScope({ ...view.scope, leafId: user.id });
}
/** Validate the original ancestry of a deterministic recovery intent after a
 * stopped attempt. This never admits an automatic replacement provider call.
 * No ordinary tool, user message, branch rewind or partial output may intervene. */
export function validateDeferredSessionSummaryIntent(intent, view) {
    validateRequest(intent, view.scope, view.now);
    let interruptedAssistants = 0;
    for (const entry of suffix(view, intent.scope.leafId)) {
        if (metadata(entry))
            continue;
        const message = entry.type === "message" ? record(entry.message) : undefined;
        if (message?.role === "system")
            continue;
        if (message?.role === "assistant" && ["aborted", "error"].includes(String(message.stopReason))
            && ++interruptedAssistants <= 1 && Array.isArray(message.content)
            && message.content.every(value => {
                const block = record(value);
                return (block?.type === "text" && block.text === "") || (block?.type === "thinking" && block.thinking === "");
            }))
            continue;
        fail("request-interrupted");
    }
}
/** Call once when the pending request is actually visible in the normal context
 * hook. Later context/payload hooks remain outside this observation's coverage. */
export function consumeSessionAgentSummaryRequest(request, view, messages) {
    validateRequest(request, view.scope, view.now);
    const prompt = renderSessionAgentSummaryRequest(request);
    let found = false;
    for (let index = messages.length - 1; index >= Math.max(0, messages.length - SESSION_AGENT_SUMMARY_LIMITS.contextMessages); index--) {
        if (isRequestMessage(record(messages[index]), request, prompt)) {
            found = true;
            break;
        }
    }
    if (!found)
        return undefined;
    for (const entry of suffix(view, request.scope.leafId)) {
        if (metadata(entry))
            continue;
        const message = entry.type === "message" ? record(entry.message) : undefined;
        // Pi can persist a prompt/tool delta between turn_end and the next context
        // hook. That system message belongs to the summary-producing request, not
        // intervening work. Accept it only before consumption; later guards stay strict.
        if (message?.role === "system")
            continue;
        // A request made by a tool may still have sibling results in this batch.
        if (message?.role === "toolResult")
            continue;
        if (request.requestToolCallId === undefined && entry.type === "custom_message"
            && entry.customType === SESSION_AGENT_SUMMARY_CUSTOM_TYPE && exactText(entry.content, prompt))
            continue;
        fail("request-interrupted");
    }
    return Object.freeze({ request, consumedBoundaryLeafId: view.scope.leafId, consumedAt: view.now });
}
/** Identify only the observed failed assistant for this already consumed summary
 * request. Exact suffix identity is not permission to hide new original work. */
export function identifyFailedSessionAgentSummary(consumed, view, assistantEntryId) {
    validateRequest(consumed.request, view.scope, view.now);
    let failed;
    for (const entry of suffix(view, consumed.consumedBoundaryLeafId)) {
        if (metadata(entry))
            continue;
        const message = entry.type === "message" ? record(entry.message) : undefined;
        if (message?.role === "system" && !failed)
            continue;
        if (failed || entry.id !== assistantEntryId || message?.role !== "assistant")
            fail("failed-summary-boundary-invalid");
        failed = entry;
    }
    const message = record(failed?.message), model = consumed.request.scope.model;
    if (!failed?.id || !message || !["aborted", "error", "length"].includes(String(message.stopReason))
        || message.provider !== model.provider || message.model !== model.id || message.api !== model.api
        || !Array.isArray(message.content) || message.content.length > SESSION_AGENT_SUMMARY_LIMITS.assistantBlocks)
        fail("failed-summary-unavailable");
    let calls = 0;
    for (const value of message.content) {
        const block = record(value);
        if (block?.type === "toolCall" && (++calls > 1 || block.name !== SESSION_AGENT_SUMMARY_TOOL
            || typeof block.id !== "string" || !block.id || record(block.arguments)?.requestId !== consumed.request.requestId))
            fail("failed-summary-has-original-tool-call");
    }
    return failed.id;
}
export function acceptSessionAgentSummary(consumed, input, view) {
    const { request } = consumed;
    validateRequest(request, view.scope, view.now);
    const submission = parseSessionAgentSummarySubmission(input);
    if (!submission || submission.requestId !== request.requestId)
        fail("request-mismatch");
    // Legacy parsing is read compatibility, not current-agent continuation authorship.
    if (!submission.continuation)
        fail("fresh-continuation-required");
    if (request.handoffTokens !== undefined && Math.ceil(submission.handoff.length / 4) > request.handoffTokens)
        fail("handoff-budget-exceeded");
    if (request.continuationTokens !== undefined && Math.ceil(submission.continuation.length / 4) > request.continuationTokens)
        fail("continuation-budget-exceeded");
    let assistant;
    for (const entry of suffix(view, consumed.consumedBoundaryLeafId)) {
        if (metadata(entry))
            continue;
        if (assistant || entry.type !== "message" || record(entry.message)?.role !== "assistant")
            fail("submission-interrupted");
        assistant = entry;
    }
    const message = record(assistant?.message);
    if (!assistant?.id || !message || message.stopReason !== "toolUse" || message.provider !== request.scope.model.provider
        || message.model !== request.scope.model.id || message.api !== request.scope.model.api)
        fail("submission-assistant-invalid");
    if (!Array.isArray(message.content) || message.content.length > SESSION_AGENT_SUMMARY_LIMITS.assistantBlocks)
        fail("submission-assistant-invalid");
    const calls = message.content.map(record).filter(block => block?.type === "toolCall");
    if (calls.length !== 1 || calls[0]?.name !== SESSION_AGENT_SUMMARY_TOOL || calls[0]?.id !== view.toolCallId)
        fail("submission-must-be-sole-tool-call");
    const persisted = parseSessionAgentSummarySubmission(calls[0]?.arguments);
    if (!persisted || JSON.stringify(persisted) !== JSON.stringify(submission))
        fail("submission-arguments-mismatch");
    return Object.freeze({ ...consumed, submission, submissionAssistantLeafId: assistant.id, submissionToolCallId: view.toolCallId,
        submittedAt: view.now, authority: "derived" });
}
/** Call after the result is persisted at a public actionable boundary or safe
 * idle. The caller checks cancellation and pending input, then consumes once. */
export function settleSessionAgentSummary(accepted, view) {
    validateRequest(accepted.request, view.scope, view.now);
    let resultLeafId;
    for (const entry of suffix(view, accepted.submissionAssistantLeafId)) {
        if (metadata(entry))
            continue;
        const message = entry.type === "message" ? record(entry.message) : undefined;
        if (resultLeafId || message?.role !== "toolResult" || message.toolName !== SESSION_AGENT_SUMMARY_TOOL
            || message.toolCallId !== accepted.submissionToolCallId || message.isError !== false)
            fail("submission-result-invalid");
        resultLeafId = entry.id;
    }
    if (!resultLeafId)
        fail("submission-result-unavailable");
    return Object.freeze({ ...accepted, readyScope: freezeScope(view.scope), submissionResultLeafId: resultLeafId });
}
/** Recheck immediately before returning a custom compaction. No stale-summary
 * fallback, prefix mutation, source deletion or authority promotion is allowed. */
export function validateSessionAgentSummary(ready, view) {
    validateRequest(ready.request, view.scope, view.now);
    if (ready.readyScope.leafId !== view.scope.leafId)
        fail("ready-leaf-changed");
}
//# sourceMappingURL=session-agent-summary.js.map