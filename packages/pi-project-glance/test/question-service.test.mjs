import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { ProjectGlanceQuestionService } from "../dist/questions/service.js";
import { QUESTION_ENTRY_TYPE, QUESTION_ANSWER_MESSAGE_TYPE } from "../dist/questions/model.js";
import { REQUEST_EVENT, RESPONSE_EVENT } from "../dist/questions/wire.js";

class Bus {
  listeners = new Map();
  responses = [];
  on(event, fn) { const set = this.listeners.get(event) ?? new Set(); set.add(fn); this.listeners.set(event, set); return () => set.delete(fn); }
  emit(event, value) { if (event === RESPONSE_EVENT) this.responses.push(value); for (const fn of [...this.listeners.get(event) ?? []]) fn(value); }
}
const assistant = () => ({ role: "assistant", content: [{ type: "text", text: "Synthetic saved session." }], api: "openai-responses", provider: "synthetic", model: "synthetic", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
function harness(t, { saved = true, idle = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "glance-question-test-"));
  const bus = new Bus();
  const h = { directory, bus, sm: SessionManager.create(directory, directory), idle, sends: 0, changes: 0, appendMode: "normal", sendMode: "normal", now: Date.now(), services: [] };
  if (saved) h.sm.appendMessage(assistant());
  h.context = () => ({ sessionManager: h.sm, isIdle: () => h.idle });
  h.create = () => {
    const service = new ProjectGlanceQuestionService({ events: bus, getContext: h.context, appendEntry(data) {
      if (h.appendMode === "throw") throw new Error("Synthetic secret error MUST NOT escape.");
      if (h.appendMode === "no-delivery" && data.kind === "DELIVERY") throw new Error("Synthetic interrupted acknowledgment.");
      const persist = h.sm.persist;
      if (h.appendMode === "memory-only") h.sm.persist = false;
      try { h.sm.appendCustomEntry(QUESTION_ENTRY_TYPE, data); } finally { h.sm.persist = persist; }
    }, sendMessage(message) {
      assert.equal(h.idle, true, "No sending during an active run");
      h.sends++;
      if (h.sendMode === "throw") throw new Error("Synthetic send failure.");
      const persist = h.sm.persist;
      if (h.sendMode === "memory-only") h.sm.persist = false;
      try {
        // Actual installed idle AgentSession path, no Agent/model/prompt is constructed.
        const fake = { isStreaming: false, agent: { state: { messages: [] } }, sessionManager: h.sm, _emit() {}, _appendCustomMessage: AgentSession.prototype._appendCustomMessage };
        void AgentSession.prototype.sendCustomMessage.call(fake, message, { triggerTurn: false });
      } finally { h.sm.persist = persist; }
    }, onChange() { h.changes++; }, now: () => h.now });
    h.services.push(service); service.start(); h.service = service; return service;
  };
  h.create();
  h.ask = (patch = {}) => {
    const request = { schemaVersion: 1, correlationId: `ask_${randomUUID()}`, operation: "ask", mode: "deferred", question: "Choose a test value?", reason: "Synthetic test only.", class: "information", response: { kind: "single_or_text", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }, recommendedOptionIds: [], affectedWork: [], continuingWork: [], attachments: [], deliveryMode: "nextTurn", blockingPolicy: "never", ...patch };
    bus.emit(REQUEST_EVENT, request);
    return { request, result: bus.responses.at(-1) };
  };
  h.answer = (answer, actionId = randomUUID(), question = h.service.questions[0]) => h.service.applyAction({ type: "question_answer", questionId: question.id, expectedRevision: question.revision, answer }, actionId);
  h.entries = () => h.sm.getEntries().filter((entry) => entry.type === "custom" && entry.customType === QUESTION_ENTRY_TYPE);
  h.messages = () => h.sm.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === QUESTION_ANSWER_MESSAGE_TYPE);
  t.after(() => { for (const service of h.services) service.stop(); rmSync(directory, { recursive: true, force: true }); });
  return h;
}

test("durable ask/options/answer wait while busy, then installed idle insertion once", (t) => {
  const h = harness(t);
  const { request, result } = h.ask();
  assert.equal(h.bus.responses.at(-2).state, "accepted");
  assert.equal(result.state, "queued"); assert.equal(result.revision, 1);
  assert.equal(result.questionId, request.correlationId.replace("ask_", "qst_"));
  assert.equal(h.service.pendingCount, 1);
  assert.equal(h.answer({ optionIds: ["a"] }), true);
  assert.equal(h.service.questions[0].state, "submitted"); assert.equal(h.sends, 0);
  h.idle = true; h.service.sync();
  assert.equal(h.sends, 1); assert.equal(h.service.pendingCount, 0);
  assert.deepEqual(h.entries().map((entry) => entry.data.kind), ["CREATED", "ANSWER", "DELIVERY"]);
  assert.equal(h.messages().length, 1);
  assert.match(h.messages()[0].content, /next|idle/u);
  h.service.sync(); assert.equal(h.sends, 1);
  assert.ok(readFileSync(h.sm.getSessionFile(), "utf8").includes(h.messages()[0].details.deliveryId));
});

test("text, multiple, and or-text shapes validate choices, bounds and normalized order", (t) => {
  for (const kind of ["text", "single", "multiple", "single_or_text", "multiple_or_text"]) {
    const h = harness(t);
    h.ask({ response: kind === "text" ? { kind } : { kind, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] } });
    assert.equal(h.answer({ optionIds: ["unknown"] }), false);
    assert.equal(h.answer({ optionIds: [], text: "😀".repeat(1100) }), false);
    assert.equal(h.answer({ optionIds: ["a", "a"] }), false);
    assert.equal(h.answer({ optionIds: ["a"], text: "mixed" }), false);
    const answer = kind === "text" || kind.endsWith("_or_text") ? { optionIds: [], text: "  synthetic answer  " } : { optionIds: kind === "single" ? ["b"] : ["b", "a"] };
    assert.equal(h.answer(answer), true, kind);
    assert.deepEqual(h.service.questions[0].answer, answer.text ? { optionIds: [], text: "synthetic answer" } : { optionIds: kind === "single" ? ["b"] : ["a", "b"] });
  }
});

test("stable correlation replay and conflicting payload; original revisions and action IDs", (t) => {
  const h = harness(t);
  const { request, result } = h.ask();
  h.bus.emit(REQUEST_EVENT, { ...request }); assert.deepEqual(h.bus.responses.at(-1), result);
  h.bus.emit(REQUEST_EVENT, { ...request, reason: "Changed" }); assert.equal(h.bus.responses.at(-1).error.code, "ASK_USER_CORRELATION_CONFLICT");
  const action = { type: "question_answer", questionId: result.questionId, expectedRevision: 1, answer: { optionIds: ["a"] } };
  assert.equal(h.service.applyAction(action, "submission-1"), true);
  assert.equal(h.service.applyAction(action, "submission-1"), true);
  assert.equal(h.service.applyAction({ ...action, answer: { optionIds: ["b"] } }, "submission-1"), false);
  assert.equal(h.service.applyAction(action, "submission-2"), false);
  h.bus.emit(REQUEST_EVENT, request); assert.equal(h.bus.responses.at(-1).revision, 1);
  assert.equal(h.entries().filter((entry) => entry.data.kind === "ANSWER").length, 1);
  h.service.stop(); h.create();
  assert.equal(h.service.applyAction(action, "submission-1"), true);
});

test("facade cancellation replays identical correlation at original receipt revision, no duplicate notification", (t) => {
  const h = harness(t, { idle: true });
  const { result } = h.ask();
  const cancel = { schemaVersion: 1, correlationId: `ask_${randomUUID()}`, operation: "cancel", mode: "deferred", id: result.displayId, expectedRevision: 1, reason: "No longer needed." };
  h.bus.emit(REQUEST_EVENT, cancel); const receipt = h.bus.responses.at(-1);
  assert.equal(receipt.state, "cancelled"); assert.equal(receipt.revision, 2); assert.equal(h.service.pendingCount, 0); assert.equal(h.sends, 0);
  h.service.stop(); h.create(); h.bus.emit(REQUEST_EVENT, cancel); assert.deepEqual(h.bus.responses.at(-1), receipt);
  h.bus.emit(REQUEST_EVENT, { ...cancel, reason: "Changed" }); assert.equal(h.bus.responses.at(-1).error.code, "ASK_USER_CORRELATION_CONFLICT");
});

test("UI cancel and expiry persist, remove pending, and cancellation uses only safe idle outbox", (t) => {
  const h = harness(t);
  const { result } = h.ask();
  assert.equal(h.service.applyAction({ type: "question_cancel", questionId: result.questionId, expectedRevision: 99 }, "cancel-wrong"), false);
  assert.equal(h.service.applyAction({ type: "question_cancel", questionId: result.questionId, expectedRevision: 1 }, "cancel-ui"), true);
  assert.equal(h.service.pendingCount, 0); assert.equal(h.sends, 0);
  h.idle = true; h.service.sync(); assert.equal(h.sends, 1); assert.match(h.messages()[0].content, /cancelled_by_user/u);
  h.ask({ expiresAt: new Date(h.now + 1000).toISOString() });
  h.now += 2000; h.service.sync(); assert.equal(h.service.pendingCount, 0);
  assert.equal(h.entries().at(-1).data.kind, "EXPIRE");
  assert.equal(h.ask({ expiresAt: new Date(h.now - 1).toISOString() }).result.state, "rejected");
});

test("four unresolved maximum and metadata/normalization overflow is rejected, never truncated", (t) => {
  const h = harness(t);
  for (let i = 0; i < 4; i++) assert.equal(h.ask().result.state, "queued");
  assert.equal(h.ask().result.state, "rejected");
  const fresh = harness(t);
  assert.equal(fresh.ask({ reason: "😀".repeat(1900), recommendation: "x".repeat(1000) }).result.state, "rejected");
  assert.equal(fresh.service.pendingCount, 0);
});

test("ordinary leaf append preserves scope; unrelated tree branch and fork cannot adopt records", (t) => {
  const h = harness(t);
  const root = h.sm.getLeafId();
  const { request, result } = h.ask();
  h.sm.appendCustomEntry("synthetic-unrelated", { marker: 1 }); h.service.sync(); assert.equal(h.service.pendingCount, 1);
  h.sm.branch(root); h.sm.appendCustomEntry("synthetic-other-branch", {}); h.service.sync();
  assert.equal(h.service.pendingCount, 0);
  assert.equal(h.service.applyAction({ type: "question_answer", questionId: result.questionId, expectedRevision: 1, answer: { optionIds: ["a"] } }, "stale-branch"), false);
  h.bus.emit(REQUEST_EVENT, request); assert.equal(h.bus.responses.at(-1).error.code, "ASK_USER_CORRELATION_CONFLICT");
  const other = h.ask(); assert.equal(other.result.displayId, "Q-2");
  const leaf = h.sm.getLeafId();
  const forkPath = h.sm.createBranchedSession(leaf);
  h.sm = SessionManager.open(forkPath, h.directory); h.service.sync();
  assert.equal(h.service.pendingCount, 0);
  assert.equal(h.ask().result.displayId, "Q-3");
});

test("reload and restart after send-before-ack reconcile existing message without duplicate", (t) => {
  const h = harness(t);
  h.ask(); h.answer({ optionIds: ["a"] });
  h.appendMode = "no-delivery"; h.idle = true; h.service.sync();
  assert.equal(h.sends, 1); assert.equal(h.messages().length, 1); assert.equal(h.service.questions[0].state, "delivery_failed");
  h.service.stop(); h.sm = SessionManager.open(h.sm.getSessionFile(), h.directory); h.appendMode = "normal"; h.create();
  assert.equal(h.sends, 1); assert.equal(h.messages().length, 1); assert.equal(h.service.pendingCount, 0);
});

test("a historical marker on another branch is not permission to resend", (t) => {
  const h = harness(t);
  h.ask(); h.answer({ optionIds: ["a"] });
  const answered = h.sm.getLeafId();
  h.idle = true; h.service.sync(); assert.equal(h.sends, 1);
  h.sm.branch(answered); h.sm.appendCustomEntry("synthetic-sibling", {}); h.service.sync();
  assert.equal(h.sends, 1); assert.equal(h.service.questions[0].state, "delivery_failed");
  const q = h.service.questions[0];
  assert.equal(h.service.applyAction({ type: "question_retry", questionId: q.id, expectedRevision: q.revision }, "retry-other-branch"), true);
  assert.equal(h.sends, 1);
});

test("in-memory message ahead of disk is never resent; retry remains visibly failed", (t) => {
  const h = harness(t);
  h.ask(); h.answer({ optionIds: ["a"] });
  h.sendMode = "memory-only"; h.idle = true; h.service.sync();
  assert.equal(h.sends, 1); assert.equal(h.service.questions[0].state, "delivery_failed");
  h.sendMode = "normal";
  const q = h.service.questions[0];
  assert.equal(h.service.applyAction({ type: "question_retry", questionId: q.id, expectedRevision: q.revision }, "retry-disk"), true);
  assert.equal(h.sends, 1); assert.equal(h.service.questions[0].state, "delivery_failed");
});

test("unflushed session and I/O failures reject durable ack with sanitized visible state", (t) => {
  const h = harness(t, { saved: false });
  const { request, result } = h.ask();
  assert.equal(result.state, "rejected"); assert.equal(result.error.code, "ASK_USER_PROVIDER_FAILURE");
  assert.equal(h.service.questions[0].state, "delivery_failed");
  h.bus.emit(REQUEST_EVENT, request); assert.equal(h.bus.responses.at(-1).state, "rejected"); assert.equal(h.entries().length, 1);
  h.sm.appendMessage(assistant()); h.service.sync();
  h.bus.emit(REQUEST_EVENT, request); assert.equal(h.bus.responses.at(-1).state, "queued");
  const failed = harness(t);
  failed.appendMode = "memory-only";
  assert.equal(failed.ask().result.state, "rejected"); assert.equal(failed.service.questions[0].state, "delivery_failed");
  const before = harness(t); before.ask(); before.appendMode = "throw";
  assert.equal(before.answer({ optionIds: ["a"] }), false); assert.equal(before.service.questions[0].state, "delivery_failed");
  assert.doesNotMatch(JSON.stringify(before.service.questions), /secret/u);
});

test("malformed/nonnarrow requests reject, abort and stop after acceptance always terminate", (t) => {
  const h = harness(t);
  for (const patch of [
    { class: "authorization" }, { deliveryMode: "steer" }, { deliveryMode: "followUp" }, { blockingPolicy: "when_agent_settles" },
    { response: { kind: "single", options: [{ id: "a", label: "A" }, { id: "a", label: "Duplicate" }] } },
    { attachments: [{ kind: "note", label: "Test", text: "x", extra: true }] },
    { temporaryDefault: { optionIds: ["a"], disclosure: "Default" } },
    { recommendedOptionIds: ["missing"] }, { recommendedOptionIds: ["a", "b"] },
    { continuingWork: ["same"], affectedWork: ["same"] }, { extra: true }, { response: { kind: "text", signal: true } },
  ]) assert.equal(h.ask(patch).result.state, "rejected", JSON.stringify(patch));
  const aborted = new AbortController(); aborted.abort(); assert.equal(h.ask({ signal: aborted.signal }).result.state, "rejected");
  const unsubscribe = h.bus.on(RESPONSE_EVENT, (value) => { if (value.state === "accepted") h.service.stop(); });
  assert.equal(h.ask().result.state, "rejected"); unsubscribe();
  assert.equal(h.bus.listeners.get(REQUEST_EVENT).size, 0);
});

test("partial or missing contexts are passive and fail closed without disrupting callers", () => {
  const bus = new Bus();
  let ctx;
  const service = new ProjectGlanceQuestionService({ events: bus, getContext: () => ctx, appendEntry() { assert.fail("No append without a full context"); }, sendMessage() { assert.fail("No send without a full context"); }, onChange() {} });
  try {
    assert.doesNotThrow(() => service.start());
    for (ctx of [undefined, {}, { sessionManager: {} }, { isIdle: () => true, sessionManager: { getEntries: () => [] } }]) {
      assert.doesNotThrow(() => service.sync()); assert.equal(service.pendingCount, 0);
      assert.equal(service.applyAction({ type: "question_cancel", questionId: "missing", expectedRevision: 1 }, "partial"), false);
    }
  } finally { service.stop(); }
});

test("accepted observer cannot retarget request into a different session", (t) => {
  const h = harness(t);
  const off = h.bus.on(RESPONSE_EVENT, (value) => {
    if (value.state !== "accepted") return;
    h.sm = SessionManager.create(h.directory, h.directory); h.sm.appendMessage(assistant());
  });
  assert.equal(h.ask().result.error.code, "ASK_USER_CORRELATION_CONFLICT");
  assert.equal(h.entries().length, 0); off();
});

test("a failed send retries with stable action receipt, and duplicate retry never sends again", (t) => {
  const h = harness(t);
  h.ask(); h.answer({ optionIds: ["a"] }); h.sendMode = "throw"; h.idle = true; h.service.sync();
  assert.equal(h.service.questions[0].state, "delivery_failed"); assert.equal(h.sends, 1);
  h.sendMode = "normal";
  const q = h.service.questions[0];
  const retry = { type: "question_retry", questionId: q.id, expectedRevision: q.revision };
  assert.equal(h.service.applyAction(retry, "stable-retry"), true);
  assert.equal(h.sends, 2); assert.equal(h.messages().length, 1); assert.equal(h.service.pendingCount, 0);
  assert.equal(h.service.applyAction(retry, "stable-retry"), true); assert.equal(h.sends, 2);
});

test("supported reversible metadata is stored as internal data without automatic default or escalation", (t) => {
  const h = harness(t);
  const { result } = h.ask({ class: "reversible", recommendedOptionIds: ["a"], recommendation: "Use A", recommendedText: "Alternative", temporaryDefault: { optionIds: ["a"], disclosure: "Continue with A until answered." }, priority: "high", affectedWork: ["Dependent choice"], continuingWork: ["Independent reading"], attachments: [{ kind: "note", label: "Synthetic note", text: "Data only" }] });
  assert.equal(result.state, "queued");
  assert.equal(h.service.questions[0].state, "pending"); assert.equal(h.service.questions[0].temporaryDefault.disclosure, "Continue with A until answered.");
  h.idle = true; h.service.sync(); assert.equal(h.sends, 0);
  assert.equal(h.entries()[0].type, "custom");
  assert.equal(h.sm.buildSessionContext().messages.some((message) => JSON.stringify(message).includes("Data only")), false);
});

test("question and answer text are display-safe without clipping deliberate paths or multiline text", (t) => {
  const h = harness(t);
  for (const unsafe of ["Escape \u001b[31m", "Bell\u0007", "Lone\ud800", "\u000btrailing"]) assert.equal(h.ask({ reason: unsafe }).result.state, "rejected");
  assert.equal(h.ask({ question: `${" ".repeat(160)}Q` }).result.state, "rejected", "Wire field limits apply before trimming");
  const { result } = h.ask({ response: { kind: "text" }, reason: "Use /tmp/synthetic\nnext line\ttab", question: "  Cafe\u0301?  " });
  assert.equal(result.state, "queued"); assert.equal(h.service.questions[0].question, "Café?");
  assert.equal(h.service.questions[0].reason, "Use /tmp/synthetic\nnext line tab");
  assert.equal(h.answer({ optionIds: [], text: "Bad\u009bcontrol" }), false);
  assert.equal(h.answer({ optionIds: [], text: "Use /tmp/synthetic\r\nkeep this line\tand tab" }), true);
  assert.equal(h.service.questions[0].answer.text, "Use /tmp/synthetic\nkeep this line\tand tab");
});

test("queued UI cancellation notice retains one outbox slot so failure cannot exceed four cards", (t) => {
  const h = harness(t);
  const { result } = h.ask();
  assert.equal(h.service.applyAction({ type: "question_cancel", questionId: result.questionId, expectedRevision: 1 }, "cancel-capacity"), true);
  for (let i = 0; i < 3; i++) assert.equal(h.ask().result.state, "queued");
  assert.equal(h.ask().result.state, "rejected");
  h.sendMode = "throw"; h.idle = true; h.service.sync();
  assert.equal(h.service.questions.length, 4);
});
