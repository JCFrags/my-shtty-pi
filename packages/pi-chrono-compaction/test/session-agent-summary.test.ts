import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_AGENT_SUMMARY_CUSTOM_TYPE, SESSION_AGENT_SUMMARY_LIMITS,
  acceptSessionAgentSummary, consumeSessionAgentSummaryRequest, createSessionAgentSummaryRequest,
  parseSessionAgentSummarySubmission, renderSessionAgentSummaryRequest,
  settleSessionAgentSummary, validateSessionAgentSummary, validateDeferredSessionSummaryIntent,
  type SessionAgentSummaryScope,
} from "../src/session-agent-summary.js";
import type { SessionEntryLike } from "../src/types.js";
import { estimateCurrentRequestBudget, estimateCurrentRequestTokens, estimateProviderRequestTokens } from "../src/context-budget.js";

test("request accounting uses fresh provider usage, charges unseen growth and keeps system-hidden hooks consistent", () => {
  const model = { provider: "fixture", id: "fixture", api: "openai-codex-responses" };
  const tool = { name: "read", description: "Read exact text", parameters: { type: "object" } };
  const prompt = "S".repeat(12000);
  const system = { role: "system", content: prompt, toolsAdded: [tool], timestamp: 0 };
  const user = { role: "user", content: "H".repeat(240000), timestamp: 1 };
  const assistant = { role: "assistant", content: [{ type: "text", text: "Ready." }], timestamp: 2,
    provider: model.provider, model: model.id, api: model.api, stopReason: "stop",
    usage: { input: 49990, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 50000 } };
  const nativeMessages: unknown[] = [system, user, assistant];
  const entries: SessionEntryLike[] = nativeMessages.map((message, index) => ({ type: "message", id: `entry-${index}`, message }));
  const inputs = { messages: nativeMessages, nativeMessages, branchEntries: entries, model,
    nativeTokens: 50000 as number | null, systemPrompt: prompt, activeTools: [tool.name], allTools: [tool] };
  const budget = estimateCurrentRequestBudget(inputs);
  assert.equal(budget.tokens, 50000, "already consumed system, schemas and framing are not charged again");
  assert.ok(budget.tokens < budget.projectionTokens - 10000, "provider usage replaces the inflated full-history estimate");
  assert.deepEqual(estimateCurrentRequestBudget({ ...inputs, messages: nativeMessages.filter(value => (value as any).role !== "system") }), budget);
  assert.equal(estimateCurrentRequestTokens(inputs), estimateCurrentRequestTokens({ ...inputs, messages: [user, assistant] }));
  assert.deepEqual(estimateCurrentRequestBudget({ ...inputs, allTools: [{ ...tool, displayOnly: "X".repeat(80000) } as typeof tool] }), budget,
    "unpublished tool fields do not affect schema accounting");

  const growth = { role: "toolResult", toolCallId: "read", toolName: "read", content: [{ type: "text", text: "G".repeat(40000) }], timestamp: 3 };
  const grownMessages = [...nativeMessages, growth], grownEntries = [...entries, { type: "message", id: "growth", message: growth }];
  const withGrowth = estimateCurrentRequestBudget({ ...inputs, nativeTokens: 60000, nativeMessages: grownMessages,
    messages: grownMessages, branchEntries: grownEntries });
  assert.equal(withGrowth.tokens - budget.tokens, 10032, "native trailing estimates are not charged twice");
  const hookGrowth = estimateCurrentRequestBudget({ ...inputs, messages: grownMessages });
  assert.equal(hookGrowth.tokens, withGrowth.tokens, "content not yet in native usage is still charged");

  const enlarged = { ...tool, description: `${tool.description}${"T".repeat(4000)}` };
  const publicGrowth = estimateCurrentRequestBudget({ ...inputs, systemPrompt: `${prompt}${"P".repeat(4000)}`, allTools: [enlarged] });
  assert.equal(publicGrowth.tokens - budget.tokens, 2000, "pending prompt and schema growth is charged");
  const systemDelta = { role: "system", content: "", sections: { extra: "P".repeat(4000) }, toolsAdded: [enlarged], timestamp: 4 };
  const deltaMessages = [...nativeMessages, systemDelta];
  const deltaNative = 50000 + Math.ceil((4000 + JSON.stringify([enlarged]).length) / 4);
  const deltaBudget = estimateCurrentRequestBudget({ ...inputs, nativeTokens: deltaNative, messages: [user, assistant],
    nativeMessages: deltaMessages, branchEntries: [...entries, { type: "message", id: "system-delta", message: systemDelta }],
    systemPrompt: `${prompt}\n\n${"P".repeat(4000)}`, allTools: [enlarged] });
  assert.ok(deltaBudget.tokens - budget.tokens < 2200, "persisted native system/tool deltas are not charged again as effective overhead");
  assert.deepEqual(deltaBudget, estimateCurrentRequestBudget({ ...inputs, nativeTokens: deltaNative, messages: deltaMessages,
    nativeMessages: deltaMessages, branchEntries: [...entries, { type: "message", id: "system-delta", message: systemDelta }],
    systemPrompt: `${prompt}\n\n${"P".repeat(4000)}`, allTools: [enlarged] }));

  for (const type of ["context_edit", "compaction", "model_change", "thinking_level_change"]) {
    const invalidated = estimateCurrentRequestBudget({ ...inputs, branchEntries: [...entries, { type, id: "invalidate" }] });
    assert.equal(invalidated.tokens, budget.projectionTokens, type);
    assert.equal(invalidated.nativeTokens, null, type);
  }
  assert.equal(estimateCurrentRequestBudget({ ...inputs, nativeTokens: null }).tokens, budget.projectionTokens);
  assert.equal(estimateCurrentRequestBudget({ ...inputs, model: { ...model, id: "different-model" } }).nativeTokens, null);
  assert.equal(estimateCurrentRequestBudget({ ...inputs, messages: [user, { ...assistant, content: [] }] }).nativeTokens, null);
  assert.equal(estimateCurrentRequestBudget({ ...inputs, messages: [{ ...user, content: "Edited prefix" }, assistant] }).nativeTokens, null);
  for (const stopReason of ["aborted", "error"]) {
    const failed = { ...assistant, stopReason };
    assert.equal(estimateCurrentRequestBudget({ ...inputs, messages: [system, user, failed], nativeMessages: [system, user, failed],
      branchEntries: [{ type: "message", id: "failed", message: failed }] }).nativeTokens, null);
  }
  assert.throws(() => estimateCurrentRequestBudget({ ...inputs, nativeTokens: NaN }), /headroom-unavailable/);
  assert.throws(() => estimateCurrentRequestBudget({ ...inputs, nativeTokens: -1 }), /headroom-unavailable/);

  const payload = { instructions: prompt, input: [{ role: "user", content: user.content }], tools: [tool] };
  const projectionTokens = Math.ceil(JSON.stringify(payload).length / 4) + 512;
  const lateInputs = { api: model.api, payload, projectionTokens, admittedTokens: budget.tokens, nativeTokens: budget.nativeTokens };
  assert.ok(lateInputs.admittedTokens < projectionTokens);
  assert.equal(estimateProviderRequestTokens(lateInputs), budget.tokens);
  assert.equal(estimateProviderRequestTokens({ ...lateInputs, payload: { ...payload, instructions: `${prompt}${"L".repeat(40000)}` } }), budget.tokens + 10000);
  assert.ok(estimateProviderRequestTokens({ ...lateInputs, nativeTokens: null }) >= projectionTokens);
  assert.ok(estimateProviderRequestTokens({ ...lateInputs, api: "unknown-api" }) >= projectionTokens);
});

test("same-session summary requires observed request, sole assistant submission and an unchanged persisted result boundary", () => {
  const scope: SessionAgentSummaryScope = { sessionId: "session", epoch: 1, leafId: "source",
    sessionFile: "/example/session.jsonl", model: { provider: "example", id: "model", api: "example-api", thinkingLevel: "high" } };
  const request = createSessionAgentSummaryRequest({ requestId: "request_0123456789", scope, reason: "manual", now: 1000 });
  const prompt = renderSessionAgentSummaryRequest(request);
  assert.ok(Buffer.byteLength(prompt) <= SESSION_AGENT_SUMMARY_LIMITS.promptBytes);
  assert.match(prompt, /grant no new authorization/);
  for (const section of ["What happened:", "What was done:", "Current work:", "Next steps:"]) assert.ok(prompt.includes(section));
  const largerRequest = createSessionAgentSummaryRequest({ requestId: request.requestId, scope, reason: "manual", now: 1000, targetTokens: 8000 });
  assert.equal(renderSessionAgentSummaryRequest(largerRequest), prompt, "the configured value must not become a size goal in the prompt");
  assert.doesNotMatch(prompt, /Target about|soft length guide|estimated tokens/);
  assert.match(prompt, /Include the information needed to continue safely, and no more\./);
  assert.match(prompt, /Do not pad the summary or try to use all available space\./);
  assert.throws(() => createSessionAgentSummaryRequest({ requestId: request.requestId, scope, reason: "manual", now: 1000, targetTokens: 8001 }), /target-invalid/);
  assert.equal(prompt.includes(scope.sessionFile!), false, "internal source paths are not request content");
  const custom = { role: "custom", customType: SESSION_AGENT_SUMMARY_CUSTOM_TYPE, content: prompt };
  const entries = new Map<string, SessionEntryLike>([
    ["source", { type: "message", id: "source", parentId: null, message: { role: "user", content: "Keep the approved scope." } }],
    ["system", { type: "message", id: "system", parentId: "source", message: {
      role: "system", content: "", sections: { tools: "Updated native tool definitions" }, toolsAdded: [],
    } }],
    ["request", { type: "custom_message", id: "request", parentId: "system", customType: custom.customType, content: prompt }],
  ]);
  const view = (leafId: string, now = 1100) => ({ scope: { ...scope, leafId }, now, getEntry: (id: string) => entries.get(id) });
  assert.equal(consumeSessionAgentSummaryRequest(request, view("source"), []), undefined);
  assert.equal(consumeSessionAgentSummaryRequest(request, view("request"), [{ role: "user", content: prompt }]), undefined);
  const consumed = consumeSessionAgentSummaryRequest(request, view("request"), [custom]);
  assert.ok(consumed);
  assert.equal(consumed.request.scope.leafId, "source");
  assert.equal(consumed.consumedBoundaryLeafId, "request");
  const submission = parseSessionAgentSummarySubmission({ requestId: request.requestId,
    summary: "Continue the approved task. The last focused check passed. Publication is not approved.", relevanceHints: ["current task"] });
  assert.ok(submission);
  const call = { type: "toolCall", id: "submit-call", name: "request_compaction", arguments: submission };
  const assistant = { role: "assistant", provider: scope.model.provider, model: scope.model.id, api: scope.model.api,
    stopReason: "toolUse", content: [call] };
  entries.set("assistant", { type: "message", id: "assistant", parentId: "request", message: assistant });
  const beforeAccept = JSON.stringify([...entries.values()]);
  const accepted = acceptSessionAgentSummary(consumed, submission, { ...view("assistant"), toolCallId: call.id });
  assert.equal(accepted.submissionAssistantLeafId, "assistant");
  assert.equal(accepted.authority, "derived");
  entries.set("late-system", { type: "message", id: "late-system", parentId: "request", message: {
    role: "system", content: "Changed after the request was consumed.",
  } });
  entries.set("late-assistant", { type: "message", id: "late-assistant", parentId: "late-system", message: assistant });
  assert.throws(() => acceptSessionAgentSummary(consumed, submission,
    { ...view("late-assistant"), toolCallId: call.id }), /submission-interrupted/);
  entries.delete("late-system"); entries.delete("late-assistant");
  assert.throws(() => settleSessionAgentSummary(accepted, view("assistant")), /result-unavailable/);
  assert.equal(JSON.stringify([...entries.values()]), beforeAccept, "request and submission guards do not rewrite source entries");
  assert.throws(() => acceptSessionAgentSummary(consumed, { ...submission, summary: "Different" },
    { ...view("assistant"), toolCallId: call.id }), /arguments-mismatch/);
  assistant.content.push({ ...call, id: "sibling-call" });
  assert.throws(() => acceptSessionAgentSummary(consumed, submission, { ...view("assistant"), toolCallId: call.id }), /sole-tool-call/);
  assistant.content.pop();
  entries.set("result", { type: "message", id: "result", parentId: "assistant", message: {
    role: "toolResult", toolName: "request_compaction", toolCallId: call.id, isError: false, content: [{ type: "text", text: "Accepted, not yet compacted." }],
  } });
  entries.set("receipt", { type: "custom", id: "receipt", parentId: "result", customType: "internal-receipt", data: {} });
  const ready = settleSessionAgentSummary(accepted, view("receipt"));
  assert.equal(ready.submissionResultLeafId, "result");
  assert.equal(ready.readyScope.leafId, "receipt");
  validateSessionAgentSummary(ready, view("receipt"));
  entries.set("late-result-system", { type: "message", id: "late-result-system", parentId: "receipt", message: {
    role: "system", content: "Changed after the submission.",
  } });
  assert.throws(() => settleSessionAgentSummary(accepted, view("late-result-system")), /result-invalid/);
  for (const changed of [{ ...scope, leafId: "other" }, { ...ready.readyScope, epoch: 2 },
    { ...ready.readyScope, sessionId: "replacement" }, { ...ready.readyScope, model: { ...scope.model, id: "other-model" } }]) {
    assert.throws(() => validateSessionAgentSummary(ready, { scope: changed, now: 1100 }), /changed/);
  }
  assert.throws(() => validateSessionAgentSummary(ready, view("receipt", request.expiresAt)), /expired/);
  entries.set("new-input", { type: "message", id: "new-input", parentId: "receipt", message: { role: "user", content: "Change the task." } });
  assert.throws(() => settleSessionAgentSummary(accepted, view("new-input")), /result-invalid/);
  assert.throws(() => consumeSessionAgentSummaryRequest(request, view("new-input"), [custom]), /request-interrupted/);
  assert.throws(() => consumeSessionAgentSummaryRequest(request, view("missing-branch"), [custom]), /source-boundary-unavailable/);

  const intent = { scope, createdAt: request.createdAt, expiresAt: request.expiresAt };
  entries.set("aborted", { type: "message", id: "aborted", parentId: "system", message: {
    role: "assistant", content: [], stopReason: "aborted",
  } });
  validateDeferredSessionSummaryIntent(intent, view("aborted"));
  assert.throws(() => validateDeferredSessionSummaryIntent(intent, view("request")), /request-interrupted/);
  assert.throws(() => validateDeferredSessionSummaryIntent(intent, view("new-input")), /request-interrupted/);
  assert.throws(() => validateDeferredSessionSummaryIntent(intent, view("missing-branch")), /source-boundary-unavailable/);
  assert.throws(() => validateDeferredSessionSummaryIntent(intent, view("aborted", request.expiresAt)), /expired/);
  assert.throws(() => validateDeferredSessionSummaryIntent(intent, { ...view("aborted"), scope: { ...scope, epoch: 2 } }), /session-changed/);
  entries.set("partial-abort", { type: "message", id: "partial-abort", parentId: "system", message: {
    role: "assistant", content: [{ type: "text", text: "Unconsumed partial output" }], stopReason: "aborted",
  } });
  assert.throws(() => validateDeferredSessionSummaryIntent(intent, view("partial-abort")), /request-interrupted/);
  entries.set("late-tool", { type: "message", id: "late-tool", parentId: "aborted", message: {
    role: "toolResult", content: "An intervening operation",
  } });
  assert.throws(() => validateDeferredSessionSummaryIntent(intent, view("late-tool")), /request-interrupted/);

  // {} uses the existing tool's normal response, including a completed sibling.
  const toolRequest = createSessionAgentSummaryRequest({ requestId: "tool_request_012345", scope: { ...scope, leafId: "assistant" },
    reason: "tool", requestToolCallId: "request-call", now: 1000 });
  const toolMessage = { role: "toolResult", toolName: "request_compaction", toolCallId: "request-call", isError: false,
    content: [{ type: "text", text: renderSessionAgentSummaryRequest(toolRequest) }] };
  entries.set("request-result", { type: "message", id: "request-result", parentId: "assistant", message: toolMessage });
  entries.set("sibling-result", { type: "message", id: "sibling-result", parentId: "request-result", message: {
    role: "toolResult", toolCallId: "prior-sibling", toolName: "read", isError: false, content: "Available context",
  } });
  assert.equal(consumeSessionAgentSummaryRequest(toolRequest, view("sibling-result"), [toolMessage])?.consumedBoundaryLeafId, "sibling-result");
  assert.equal(parseSessionAgentSummarySubmission({}), undefined);
  assert.throws(() => parseSessionAgentSummarySubmission({ requestId: request.requestId, summary: " " }), /summary-invalid/);
  assert.equal(parseSessionAgentSummarySubmission({ requestId: request.requestId, summary: "s".repeat(32000) })?.summary.length, 32000);
  assert.throws(() => parseSessionAgentSummarySubmission({ requestId: request.requestId, summary: "s".repeat(SESSION_AGENT_SUMMARY_LIMITS.summaryChars + 1) }), /summary-invalid/);
  assert.throws(() => parseSessionAgentSummarySubmission({ requestId: request.requestId,
    summary: "界".repeat(Math.floor(SESSION_AGENT_SUMMARY_LIMITS.summaryBytes / 3) + 1) }), /summary-invalid/);
  assert.throws(() => parseSessionAgentSummarySubmission({ ...submission, relevanceHints: Array(9).fill("hint") }), /hints-invalid/);
  assert.throws(() => parseSessionAgentSummarySubmission({ ...submission, relevanceHints: null }), /hints-invalid/);
  assert.throws(() => parseSessionAgentSummarySubmission({ ...submission, authorization: true }), /fields-invalid/);
});
