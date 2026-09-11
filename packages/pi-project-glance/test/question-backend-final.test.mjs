import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { QUESTION_ACTIVE_WORK_MS, QUESTION_MEANINGFUL_RUNS, classifyQuestionWork, questionActiveMs } from "../dist/questions/activity.js";
import { QUESTION_ANSWER_MESSAGE_TYPE, QUESTION_ENTRY_TYPE } from "../dist/questions/model.js";
import { ProjectGlanceQuestionService } from "../dist/questions/service.js";
import { REQUEST_EVENT } from "../dist/questions/wire.js";

class Bus {
  listeners = new Map(); responses = [];
  on(name, fn) { const set = this.listeners.get(name) ?? new Set(); set.add(fn); this.listeners.set(name, set); return () => set.delete(fn); }
  emit(name, value) { if (name.endsWith("response-v1")) this.responses.push(value); for (const fn of this.listeners.get(name) ?? []) fn(value); }
}
const assistant = (stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text: "synthetic" }], api: "openai-responses", provider: "synthetic", model: "synthetic", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: Date.now() });
const toolResult = (id, name = "edit") => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }], isError: false, timestamp: Date.now() });

function harness(t) {
  const root = mkdtempSync(join(tmpdir(), "glance-final-question-"));
  const sm = SessionManager.create(root, root); sm.appendMessage(assistant());
  const bus = new Bus(); let idle = false; let mono = 0; let sendMode = "normal";
  const ctx = () => ({ sessionManager: sm, isIdle: () => idle });
  const service = new ProjectGlanceQuestionService({ events: bus, getContext: ctx, appendEntry: (data) => sm.appendCustomEntry(QUESTION_ENTRY_TYPE, data), sendMessage(message) {
    if (sendMode === "throw") throw new Error("synthetic");
    const fake = { isStreaming: false, agent: { state: { messages: [] } }, sessionManager: sm, _emit() {}, _appendCustomMessage: AgentSession.prototype._appendCustomMessage };
    void AgentSession.prototype.sendCustomMessage.call(fake, message, { triggerTurn: false });
  }, onChange() {}, monotonicNow: () => mono });
  service.start();
  const ask = () => { bus.emit(REQUEST_EVENT, { schemaVersion: 1, correlationId: `ask_${randomUUID()}`, operation: "ask", mode: "deferred", question: "Still needed?", reason: "Synthetic", class: "information", response: { kind: "text" }, recommendedOptionIds: [], affectedWork: [], continuingWork: [], attachments: [], deliveryMode: "nextTurn", blockingPolicy: "never" }); return bus.responses.at(-1); };
  const run = (index, error = false) => {
    service.agentStart(ctx());
    for (let i = 0; i < 2; i++) {
      const id = `run-${index}-edit-${i}`;
      service.toolStart({ toolCallId: id, toolName: "edit", args: { path: "x", edits: [] } }, ctx());
      mono += 5 * 60 * 1000;
      service.toolEnd({ toolCallId: id, toolName: "edit", isError: error }, ctx());
      if (!error) sm.appendMessage(toolResult(id));
    }
    service.agentEnd({ messages: [assistant(error ? "error" : "stop")] }, ctx());
    service.agentSettled(ctx());
  };
  const invalidatedRun = (index, reason) => {
    service.agentStart(ctx());
    if (reason === "retry") service.agentStart(ctx());
    const id = `invalid-${index}`;
    service.toolStart({ toolCallId: id, toolName: "edit", args: { path: "x", edits: [] } }, ctx());
    mono += 5 * 60 * 1000;
    if (reason === "prompt") { service.uiPromptStart(ctx()); service.uiPromptEnd(ctx()); }
    service.toolEnd({ toolCallId: id, toolName: "edit", isError: false }, ctx());
    sm.appendMessage(toolResult(id)); service.agentEnd({ messages: [assistant()] }, ctx()); service.agentSettled(ctx());
  };
  t.after(() => { service.stop(); rmSync(root, { recursive: true, force: true }); });
  return { sm, service, ask, run, invalidatedRun, setIdle(value) { idle = value; }, setSendMode(value) { sendMode = value; }, entries: () => sm.getEntries().filter((entry) => entry.type === "custom" && entry.customType === QUESTION_ENTRY_TYPE), messages: () => sm.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === QUESTION_ANSWER_MESSAGE_TYPE) };
}

test("activity policy is conservative and unions capped eligible intervals", () => {
  assert.equal(QUESTION_ACTIVE_WORK_MS, 30 * 60 * 1000);
  assert.equal(QUESTION_MEANINGFUL_RUNS, 3);
  for (const name of ["bash", "process", "session", "subagent_channel", "ask_user"]) assert.equal(classifyQuestionWork(name, {}).eligible, false);
  assert.deepEqual(classifyQuestionWork("local_search", { action: "capabilities" }), { eligible: false, strong: false });
  assert.equal(classifyQuestionWork("edit", {}).strong, true);
  assert.equal(questionActiveMs([{ startedAt: 0, endedAt: 600_000 }, { startedAt: 240_000, endedAt: 900_000 }]), 540_000);
});

test("expiry needs thirty observed minutes and three settled meaningful runs, then sends one exact idle notice", (t) => {
  const h = harness(t); h.ask();
  h.run(1); h.run(2); h.setIdle(true); h.run(3);
  assert.equal(h.service.questions.length, 0);
  assert.deepEqual(h.entries().filter((entry) => entry.data.kind === "ACTIVITY").map((entry) => entry.data.meaningful), [true, true, true]);
  assert.equal(h.entries().filter((entry) => entry.data.kind === "EXPIRE").length, 1);
  assert.equal(h.messages().length, 1);
  assert.match(h.messages()[0].content, /expired unanswered after continued work/);
  h.service.sync(); assert.equal(h.messages().length, 1);
});

test("errors do not accelerate expiry and editing presence suppresses the qualified transition", (t) => {
  const h = harness(t); const queued = h.ask();
  h.run(0, true); h.invalidatedRun(0, "prompt"); h.invalidatedRun(0, "retry"); h.run(1); h.run(2); h.run(3);
  assert.equal(h.entries().filter((entry) => entry.data.kind === "ACTIVITY").length, 3);
  h.setIdle(true);
  const owner = {};
  assert.equal(h.service.setEditing(owner, { questionId: queued.questionId, expectedRevision: 1, active: true }), true);
  h.service.sync(); assert.equal(h.entries().some((entry) => entry.data.kind === "EXPIRE"), false);
  h.service.releaseEditing(owner);
  assert.equal(h.entries().filter((entry) => entry.data.kind === "EXPIRE").length, 1);
});

test("runs settled while editing do not accrue expiry credit or expire on editor release", (t) => {
  const h = harness(t); const queued = h.ask(); const owner = {};
  assert.equal(h.service.setEditing(owner, { questionId: queued.questionId, expectedRevision: 1, active: true }), true);
  h.run(1); h.run(2); h.run(3); h.setIdle(true);
  h.service.releaseEditing(owner);
  assert.equal(h.entries().filter((entry) => entry.data.kind === "ACTIVITY").length, 0);
  assert.equal(h.entries().filter((entry) => entry.data.kind === "EXPIRE").length, 0);
  assert.equal(h.service.questions.length, 1);
  h.run(4); h.run(5); h.run(6);
  assert.equal(h.entries().filter((entry) => entry.data.kind === "EXPIRE").length, 1);
});

test("manual dismiss is distinct; hiding a failed submitted card preserves answer and retry state", (t) => {
  const manual = harness(t); const queued = manual.ask(); manual.setIdle(true);
  assert.equal(manual.service.applyAction({ type: "question_dismiss", questionId: queued.questionId, expectedRevision: 1 }, "dismiss-1"), true);
  assert.match(manual.messages()[0].content, /dismissed unanswered by user/);
  assert.doesNotMatch(manual.messages()[0].content, /expired unanswered/);

  const answered = harness(t); const answerQueued = answered.ask();
  assert.equal(answered.service.applyAction({ type: "question_answer", questionId: answerQueued.questionId, expectedRevision: 1, answer: { optionIds: [], text: "keep me" } }, "answer-1"), true);
  answered.setSendMode("throw"); answered.setIdle(true); answered.service.sync();
  const failed = answered.service.questions[0]; assert.equal(failed.state, "delivery_failed");
  assert.equal(answered.service.applyAction({ type: "question_hide", questionId: failed.id, expectedRevision: failed.revision }, "hide-1"), true);
  assert.equal(answered.service.questions.length, 0); assert.equal(answered.service.hiddenAttentionCount, 1);
  assert.deepEqual(answered.service.hiddenAttention.map(({ state, retryAvailable }) => ({ state, retryAvailable })), [{ state: "delivery_failed", retryAvailable: true }]);
  assert.equal(answered.entries().filter((entry) => entry.data.kind === "ANSWER").length, 1);
  assert.deepEqual(answered.entries().find((entry) => entry.data.kind === "ANSWER").data.answer, { optionIds: [], text: "keep me" });
});
