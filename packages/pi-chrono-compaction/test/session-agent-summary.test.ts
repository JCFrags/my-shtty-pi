import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_AGENT_SUMMARY_CUSTOM_TYPE, SESSION_AGENT_SUMMARY_LIMITS,
  acceptSessionAgentSummary, consumeSessionAgentSummaryRequest, createSessionAgentSummaryRequest,
  parseSessionAgentSummarySubmission, renderSessionAgentSummaryRequest,
  settleSessionAgentSummary, validateSessionAgentSummary,
  type SessionAgentSummaryScope,
} from "../src/session-agent-summary.js";
import type { SessionEntryLike } from "../src/types.js";

test("same-session summary requires observed request, sole assistant submission and an unchanged persisted result boundary", () => {
  const scope: SessionAgentSummaryScope = { sessionId: "session", epoch: 1, leafId: "source",
    sessionFile: "/example/session.jsonl", model: { provider: "example", id: "model", api: "example-api", thinkingLevel: "high" } };
  const request = createSessionAgentSummaryRequest({ requestId: "request_0123456789", scope, reason: "manual", now: 1000 });
  const prompt = renderSessionAgentSummaryRequest(request);
  assert.ok(Buffer.byteLength(prompt) <= SESSION_AGENT_SUMMARY_LIMITS.promptBytes);
  assert.match(prompt, /grant no new authorization/);
  assert.equal(prompt.includes(scope.sessionFile!), false, "internal source paths are not request content");
  const custom = { role: "custom", customType: SESSION_AGENT_SUMMARY_CUSTOM_TYPE, content: prompt };
  const entries = new Map<string, SessionEntryLike>([
    ["source", { type: "message", id: "source", parentId: null, message: { role: "user", content: "Keep the approved scope." } }],
    ["request", { type: "custom_message", id: "request", parentId: "source", customType: custom.customType, content: prompt }],
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
  for (const changed of [{ ...scope, leafId: "other" }, { ...ready.readyScope, epoch: 2 },
    { ...ready.readyScope, sessionId: "replacement" }, { ...ready.readyScope, model: { ...scope.model, id: "other-model" } }]) {
    assert.throws(() => validateSessionAgentSummary(ready, { scope: changed, now: 1100 }), /changed/);
  }
  assert.throws(() => validateSessionAgentSummary(ready, view("receipt", request.expiresAt)), /expired/);
  entries.set("new-input", { type: "message", id: "new-input", parentId: "receipt", message: { role: "user", content: "Change the task." } });
  assert.throws(() => settleSessionAgentSummary(accepted, view("new-input")), /result-invalid/);
  assert.throws(() => consumeSessionAgentSummaryRequest(request, view("new-input"), [custom]), /request-interrupted/);
  assert.throws(() => consumeSessionAgentSummaryRequest(request, view("missing-branch"), [custom]), /source-boundary-unavailable/);

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
  assert.throws(() => parseSessionAgentSummarySubmission({ requestId: request.requestId, summary: "界".repeat(8193) }), /summary-invalid/);
  assert.throws(() => parseSessionAgentSummarySubmission({ ...submission, relevanceHints: Array(9).fill("hint") }), /hints-invalid/);
  assert.throws(() => parseSessionAgentSummarySubmission({ ...submission, relevanceHints: null }), /hints-invalid/);
  assert.throws(() => parseSessionAgentSummarySubmission({ ...submission, authorization: true }), /fields-invalid/);
});
