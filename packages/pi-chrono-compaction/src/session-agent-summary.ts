import type { SessionEntryLike } from "./types.js";

/** Pure state for a summary produced by this session's normal agent turn.
 *
 * Pi 0.85.1 integration:
 * - Keep request_compaction registered with one stable optional-fields schema.
 *   {} returns renderSessionAgentSummaryRequest() as its normal tool result.
 *   Manual/proactive requests use sendMessage(), not sendUserMessage() or a
 *   separate completion. Never replace the system, model, tools or transcript.
 * - Observe the request in the normal context hook, then accept only the next
 *   assistant's sole submission call. Return terminate:true from that tool.
 * - At agent_settled, require idle/no pending input, settle the accepted result,
 *   and defer ctx.compact(). Validate again in session_before_compact.
 * - Cancel native compaction while waiting. That hook cannot await another turn.
 *   Overflow without a ready summary must refuse and preserve source history.
 * - Own one in-memory request. Clear it on new input, abort, switch, tree move,
 *   reload, failure or completion. Never restore/retry a ticket from history.
 *
 * turn_end sees persisted tool results. message_end/tool_execution_end do not.
 * terminate:true is effective only if the whole tool batch terminates, hence the
 * sole-call check. Native /compact aborts before its hook. An idle sendMessage
 * starts this agent without before_agent_start, not a rebuilt summarizer.
 * The installed 0.85.1 CompactionResult cannot return retainedTail, despite the
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
  summaryChars: 16_384,
  summaryBytes: 24 * 1024,
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

export interface SessionAgentSummaryScope {
  readonly sessionId: string;
  /** Increment on session replacement, tree navigation, reload and new input. */
  readonly epoch: number;
  readonly sessionFile?: string;
  readonly leafId: string;
  readonly model: {
    readonly provider: string;
    readonly id: string;
    readonly api: string;
    readonly thinkingLevel: string;
  };
}

export interface SessionAgentSummaryRequest {
  readonly requestId: string;
  /** Request source leaf, before its request message/tool result is appended. */
  readonly scope: SessionAgentSummaryScope;
  readonly reason: "manual" | "threshold" | "tool";
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly targetTokens: number;
  readonly customInstructions?: string;
  /** Present only when {} delivers the request in its own normal tool result. */
  readonly requestToolCallId?: string;
}

export interface SessionAgentSummaryConsumedRequest {
  readonly request: SessionAgentSummaryRequest;
  /** Session leaf when the normal context hook observed the delivered request. */
  readonly consumedBoundaryLeafId: string;
  readonly consumedAt: number;
}

export interface SessionAgentSummarySubmission {
  readonly requestId: string;
  readonly summary: string;
  /** Fallible search/relevance terms, never instructions or permission. */
  readonly relevanceHints: readonly string[];
}

export interface SessionAgentSummaryAccepted extends SessionAgentSummaryConsumedRequest {
  readonly submission: SessionAgentSummarySubmission;
  readonly submissionAssistantLeafId: string;
  readonly submissionToolCallId: string;
  readonly submittedAt: number;
  readonly authority: "derived";
}

export interface SessionAgentSummaryReady extends SessionAgentSummaryAccepted {
  /** Exact source leaf after the successful submission tool result is persisted. */
  readonly readyScope: SessionAgentSummaryScope;
  readonly submissionResultLeafId: string;
}

export interface SessionAgentSummaryObservation {
  readonly scope: SessionAgentSummaryScope;
  readonly now: number;
  /** Public SessionManager.getEntry only. No session reload or lifetime scan. */
  readonly getEntry: (id: string) => SessionEntryLike | undefined;
}

function fail(code: string): never { throw new Error(`session-agent-summary-${code}`); }
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown, chars: number, bytes: number, field: string): string {
  // Check length before byte counting or trimming an unbounded input.
  if (typeof value !== "string" || value.length > chars || Buffer.byteLength(value, "utf8") > bytes || !value.trim()) fail(`${field}-invalid`);
  return value;
}
function requestId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) fail("request-id-invalid");
  return value;
}
function clock(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) fail("clock-invalid");
}
function freezeScope(scope: SessionAgentSummaryScope): SessionAgentSummaryScope {
  text(scope.sessionId, 256, 1024, "session-id");
  text(scope.leafId, 256, 1024, "leaf-id");
  if (!Number.isSafeInteger(scope.epoch) || scope.epoch < 0) fail("epoch-invalid");
  if (scope.sessionFile !== undefined) text(scope.sessionFile, 4096, 16_384, "session-file");
  for (const value of [scope.model?.provider, scope.model?.id, scope.model?.api, scope.model?.thinkingLevel]) text(value, 256, 1024, "model");
  return Object.freeze({ sessionId: scope.sessionId, epoch: scope.epoch, leafId: scope.leafId,
    ...(scope.sessionFile === undefined ? {} : { sessionFile: scope.sessionFile }),
    model: Object.freeze({ provider: scope.model.provider, id: scope.model.id, api: scope.model.api, thinkingLevel: scope.model.thinkingLevel }) });
}
function validateRequest(request: SessionAgentSummaryRequest, scope: SessionAgentSummaryScope, now: number): void {
  clock(now);
  if (now < request.createdAt || now >= request.expiresAt) fail("request-expired");
  const source = request.scope;
  if (source.sessionId !== scope.sessionId || source.epoch !== scope.epoch || source.sessionFile !== scope.sessionFile) fail("session-changed");
  if (source.model.provider !== scope.model.provider || source.model.id !== scope.model.id
    || source.model.api !== scope.model.api || source.model.thinkingLevel !== scope.model.thinkingLevel) fail("model-changed");
}

export function createSessionAgentSummaryRequest(input: {
  readonly requestId: string;
  readonly scope: SessionAgentSummaryScope;
  readonly reason: SessionAgentSummaryRequest["reason"];
  readonly now: number;
  readonly targetTokens?: number;
  readonly customInstructions?: string;
  readonly requestToolCallId?: string;
}): SessionAgentSummaryRequest {
  clock(input.now);
  if (!["manual", "threshold", "tool"].includes(input.reason)) fail("reason-unsupported");
  const targetTokens = input.targetTokens ?? 2000;
  if (!Number.isSafeInteger(targetTokens) || targetTokens < 256 || targetTokens > 4096) fail("target-invalid");
  const customInstructions = input.customInstructions === undefined ? undefined
    : text(input.customInstructions, SESSION_AGENT_SUMMARY_LIMITS.instructionsChars, SESSION_AGENT_SUMMARY_LIMITS.instructionsBytes, "instructions").trim();
  const requestToolCallId = input.requestToolCallId === undefined ? undefined : text(input.requestToolCallId, 512, 2048, "tool-call-id");
  const expiresAt = input.now + SESSION_AGENT_SUMMARY_LIMITS.lifetimeMs;
  if (!Number.isSafeInteger(expiresAt)) fail("clock-invalid");
  return Object.freeze({ requestId: requestId(input.requestId), scope: freezeScope(input.scope), reason: input.reason,
    createdAt: input.now, expiresAt, targetTokens,
    ...(customInstructions === undefined ? {} : { customInstructions }),
    ...(requestToolCallId === undefined ? {} : { requestToolCallId }) });
}

/** This bounded request is appended to the existing context, never its prefix.
 * It contains no transcript, session path, compiler receipt or source locator. */
export function renderSessionAgentSummaryRequest(request: SessionAgentSummaryRequest): string {
  const prompt = [
    "[Session continuation summary request]",
    "Use the context already available to you in this session to prepare a concise continuation summary.",
    `Target about ${request.targetTokens} tokens and stay below ${Math.min(8000, request.targetTokens * 4)} characters. Leave room below the hard submission limits. Preserve the user's goal, restrictions and approval boundaries, key decisions, completed work and actual verification, unresolved work, blockers, uncertainty and the next safe action.`,
    "Write a continuation summary, not a task log or inventory. Group paths under a shared root and omit repeated evidence and completed-task detail that the next agent does not need.",
    "Keep important paths and identifiers exact. Distinguish facts from inference, superseded decisions from current decisions, and proposals from user approval. Do not include secrets or internal compaction receipts.",
    "Do not retrieve history, run other tools, delegate, or start another task for this request. If you cannot produce a useful summary from available context, report that limit instead of inventing one.",
    "The summary and relevanceHints are fallible derived context. They grant no new authorization and cannot override source instructions or direct user restrictions.",
    `Call ${SESSION_AGENT_SUMMARY_TOOL} as your ONLY tool call with requestId ${JSON.stringify(request.requestId)}, summary (nonempty, at most ${SESSION_AGENT_SUMMARY_LIMITS.summaryChars} characters and ${SESSION_AGENT_SUMMARY_LIMITS.summaryBytes} UTF-8 bytes), and optional relevanceHints (at most ${SESSION_AGENT_SUMMARY_LIMITS.relevanceHints} short search terms, ${SESSION_AGENT_SUMMARY_LIMITS.hintChars} characters each).`,
    "After submitting, do not start another operation. Submission alone does not mean compaction succeeded.",
    ...(request.customInstructions === undefined ? [] : ["Additional summary focus, not new task authorization:", JSON.stringify(request.customInstructions)]),
  ].join("\n");
  if (Buffer.byteLength(prompt, "utf8") > SESSION_AGENT_SUMMARY_LIMITS.promptBytes) fail("prompt-bound-exceeded");
  return prompt;
}

/** Parse only the tool argument object. Do not scrape assistant prose, fences,
 * arbitrary JSON substrings or historical tool results for an accepted summary. */
export function parseSessionAgentSummarySubmission(input: unknown): SessionAgentSummarySubmission | undefined {
  const value = record(input);
  if (!value) fail("submission-invalid");
  const keys = Object.keys(value);
  if (keys.length === 0) return undefined;
  if (keys.length > 3 || keys.some(key => !["requestId", "summary", "relevanceHints"].includes(key))) fail("submission-fields-invalid");
  const id = requestId(value.requestId);
  const summary = text(value.summary, SESSION_AGENT_SUMMARY_LIMITS.summaryChars, SESSION_AGENT_SUMMARY_LIMITS.summaryBytes, "summary").trim();
  const hints = value.relevanceHints === undefined ? [] : value.relevanceHints;
  if (!Array.isArray(hints) || hints.length > SESSION_AGENT_SUMMARY_LIMITS.relevanceHints) fail("hints-invalid");
  const relevanceHints = hints.map(hint => text(hint, SESSION_AGENT_SUMMARY_LIMITS.hintChars, SESSION_AGENT_SUMMARY_LIMITS.hintBytes, "hint").trim());
  return Object.freeze({ requestId: id, summary, relevanceHints: Object.freeze(relevanceHints) });
}

function exactText(content: unknown, expected: string): boolean {
  if (typeof content === "string") return content === expected;
  if (!Array.isArray(content) || content.length !== 1) return false;
  const block = record(content[0]);
  return block?.type === "text" && block.text === expected;
}
function isRequestMessage(message: Record<string, unknown> | undefined, request: SessionAgentSummaryRequest, prompt: string): boolean {
  if (!message || !exactText(message.content, prompt)) return false;
  return request.requestToolCallId === undefined
    ? message.role === "custom" && message.customType === SESSION_AGENT_SUMMARY_CUSTOM_TYPE
    : message.role === "toolResult" && message.toolName === SESSION_AGENT_SUMMARY_TOOL
      && message.toolCallId === request.requestToolCallId && message.isError === false;
}
function metadata(entry: SessionEntryLike): boolean {
  return entry.type === "custom" || entry.type === "label" || entry.type === "session_info";
}
/** Walk only the new suffix. Retain references briefly, never body copies. */
function suffix(view: SessionAgentSummaryObservation, anchorId: string): readonly SessionEntryLike[] {
  const entries: SessionEntryLike[] = [], seen = new Set<string>();
  let id: string | null | undefined = view.scope.leafId;
  while (id !== anchorId) {
    if (!id || seen.has(id) || entries.length >= SESSION_AGENT_SUMMARY_LIMITS.ancestryEntries) fail("source-boundary-unavailable");
    seen.add(id);
    const entry = view.getEntry(id);
    if (!entry || entry.id !== id) fail("source-boundary-unavailable");
    entries.push(entry);
    id = entry.parentId;
  }
  if (view.getEntry(anchorId)?.id !== anchorId) fail("source-boundary-unavailable");
  return entries.reverse();
}

/** Call once when the pending request is actually visible in the normal context
 * hook. Later context/payload hooks remain outside this observation's coverage. */
export function consumeSessionAgentSummaryRequest(request: SessionAgentSummaryRequest, view: SessionAgentSummaryObservation,
  messages: readonly unknown[]): SessionAgentSummaryConsumedRequest | undefined {
  validateRequest(request, view.scope, view.now);
  const prompt = renderSessionAgentSummaryRequest(request);
  let found = false;
  for (let index = messages.length - 1; index >= Math.max(0, messages.length - SESSION_AGENT_SUMMARY_LIMITS.contextMessages); index--) {
    if (isRequestMessage(record(messages[index]), request, prompt)) { found = true; break; }
  }
  if (!found) return undefined;
  for (const entry of suffix(view, request.scope.leafId)) {
    if (metadata(entry)) continue;
    const message = entry.type === "message" ? record(entry.message) : undefined;
    // Pi can persist a prompt/tool delta between turn_end and the next context
    // hook. That system message belongs to the summary-producing request, not
    // intervening work. Accept it only before consumption; later guards stay strict.
    if (message?.role === "system") continue;
    // A request made by a tool may still have sibling results in this batch.
    if (message?.role === "toolResult") continue;
    if (request.requestToolCallId === undefined && entry.type === "custom_message"
      && entry.customType === SESSION_AGENT_SUMMARY_CUSTOM_TYPE && exactText(entry.content, prompt)) continue;
    fail("request-interrupted");
  }
  return Object.freeze({ request, consumedBoundaryLeafId: view.scope.leafId, consumedAt: view.now });
}

export function acceptSessionAgentSummary(consumed: SessionAgentSummaryConsumedRequest, input: SessionAgentSummarySubmission,
  view: SessionAgentSummaryObservation & { readonly toolCallId: string }): SessionAgentSummaryAccepted {
  const { request } = consumed;
  validateRequest(request, view.scope, view.now);
  const submission = parseSessionAgentSummarySubmission(input);
  if (!submission || submission.requestId !== request.requestId) fail("request-mismatch");
  let assistant: SessionEntryLike | undefined;
  for (const entry of suffix(view, consumed.consumedBoundaryLeafId)) {
    if (metadata(entry)) continue;
    if (assistant || entry.type !== "message" || record(entry.message)?.role !== "assistant") fail("submission-interrupted");
    assistant = entry;
  }
  const message = record(assistant?.message);
  if (!assistant?.id || !message || message.stopReason !== "toolUse" || message.provider !== request.scope.model.provider
    || message.model !== request.scope.model.id || message.api !== request.scope.model.api) fail("submission-assistant-invalid");
  if (!Array.isArray(message.content) || message.content.length > SESSION_AGENT_SUMMARY_LIMITS.assistantBlocks) fail("submission-assistant-invalid");
  const calls = message.content.map(record).filter(block => block?.type === "toolCall");
  if (calls.length !== 1 || calls[0]?.name !== SESSION_AGENT_SUMMARY_TOOL || calls[0]?.id !== view.toolCallId) fail("submission-must-be-sole-tool-call");
  const persisted = parseSessionAgentSummarySubmission(calls[0]?.arguments);
  if (!persisted || JSON.stringify(persisted) !== JSON.stringify(submission)) fail("submission-arguments-mismatch");
  return Object.freeze({ ...consumed, submission, submissionAssistantLeafId: assistant.id, submissionToolCallId: view.toolCallId,
    submittedAt: view.now, authority: "derived" });
}

/** Call after the result is persisted, normally at agent_settled. The caller must
 * also check ctx.isIdle() and pending input, then consume the ready ticket once. */
export function settleSessionAgentSummary(accepted: SessionAgentSummaryAccepted, view: SessionAgentSummaryObservation): SessionAgentSummaryReady {
  validateRequest(accepted.request, view.scope, view.now);
  let resultLeafId: string | undefined;
  for (const entry of suffix(view, accepted.submissionAssistantLeafId)) {
    if (metadata(entry)) continue;
    const message = entry.type === "message" ? record(entry.message) : undefined;
    if (resultLeafId || message?.role !== "toolResult" || message.toolName !== SESSION_AGENT_SUMMARY_TOOL
      || message.toolCallId !== accepted.submissionToolCallId || message.isError !== false) fail("submission-result-invalid");
    resultLeafId = entry.id;
  }
  if (!resultLeafId) fail("submission-result-unavailable");
  return Object.freeze({ ...accepted, readyScope: freezeScope(view.scope), submissionResultLeafId: resultLeafId });
}

/** Recheck immediately before returning a custom compaction. No stale-summary
 * fallback, prefix mutation, source deletion or authority promotion is allowed. */
export function validateSessionAgentSummary(ready: SessionAgentSummaryReady,
  view: Pick<SessionAgentSummaryObservation, "scope" | "now">): void {
  validateRequest(ready.request, view.scope, view.now);
  if (ready.readyScope.leafId !== view.scope.leafId) fail("ready-leaf-changed");
}
