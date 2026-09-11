import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import projectGlanceExtension from "../dist/pi/extension.js";
import { ProjectGlanceClient } from "../dist/protocol/client.js";
import { encodeFrame, ProjectGlanceFrameDecoder } from "../dist/protocol/framing.js";
import { readConnectionDescriptor } from "../dist/runtime/connection-file.js";
import { deriveSessionKey, runtimePathsForSession } from "../dist/runtime/paths.js";
import { QUESTION_ENTRY_TYPE, QUESTION_ANSWER_MESSAGE_TYPE } from "../dist/questions/model.js";

// Match the retained-root/source verification convention used by provider-integration.
// Only tests import Grounded implementation. The Glance extension uses public events.
const providerRoot = process.env.PI_PROJECT_GLANCE_PROVIDER_ROOT
  ? resolve(process.env.PI_PROJECT_GLANCE_PROVIDER_ROOT)
  : fileURLToPath(new URL("../../..", import.meta.url));
const { registerGroundedDialog } = await import(pathToFileURL(join(providerRoot, "packages/grounded-tools/dialog/index.ts")).href);
const { ASK_USER_DEFERRED_REQUEST_EVENT_V1, ASK_USER_BLOCKING_REQUEST_EVENT_V1 } = await import(pathToFileURL(join(providerRoot, "packages/grounded-tools/core/src/ask-user-v1.ts")).href);

class Bus {
  listeners = new Map();
  requests = [];
  on(name, callback) {
    const listeners = this.listeners.get(name) ?? new Set();
    this.listeners.set(name, listeners); listeners.add(callback);
    return () => listeners.delete(callback);
  }
  emit(name, value) {
    if (name === ASK_USER_DEFERRED_REQUEST_EVENT_V1) this.requests.push(value);
    for (const callback of [...(this.listeners.get(name) ?? [])]) callback(value);
  }
}
const assistant = () => ({ role: "assistant", content: [{ type: "text", text: "Synthetic integration session; no model is started." }], api: "openai-responses", provider: "synthetic", model: "synthetic", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
const ask = (kind = "single_or_text") => ({ operation: "ask", mode: "deferred", question: "Choose a harmless synthetic value?", reason: "Independent synthetic work can continue.", class: "information", response: kind === "text" ? { kind } : { kind, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }, deliveryMode: "nextTurn", escalationPolicy: "never" });

async function waitFor(predicate, label = "bounded integration condition") {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function harness(t) {
  const directory = mkdtempSync(join(tmpdir(), "glance-facade-integration-"));
  const priorRuntimeDir = process.env.XDG_RUNTIME_DIR;
  const priorStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_RUNTIME_DIR = directory;
  process.env.XDG_STATE_HOME = join(directory, "state");
  mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
  const h = { directory, sm: SessionManager.create(directory, directory), idle: false, sends: [], sendPromises: [], clients: [], notices: [], pi: undefined };
  h.sm.appendMessage(assistant()); // Flush the real synthetic session before asking.
  h.rootLeaf = h.sm.getLeafId();
  h.context = () => ({ sessionManager: h.sm, isIdle: () => h.idle, hasUI: true, mode: "tui", ui: { setStatus() {}, notify(message) { h.notices.push(message); }, select: async (_title, options) => options[0], input: async () => "Synthetic blocking text" } });
  h.entries = () => h.sm.getEntries().filter((entry) => entry.type === "custom" && entry.customType === QUESTION_ENTRY_TYPE);
  h.messages = () => h.sm.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === QUESTION_ANSWER_MESSAGE_TYPE);
  h.disk = () => readFileSync(h.sm.getSessionFile(), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  h.descriptorPath = () => runtimePathsForSession(deriveSessionKey(h.sm.getSessionId()), { ...process.env, XDG_RUNTIME_DIR: directory }).descriptorPath;
  h.create = async () => {
    const pi = {
      events: new Bus(), tools: [], commands: new Map(), hooks: new Map(),
      registerTool(tool) { this.tools.push(tool); },
      registerCommand(name, options) { this.commands.set(name, options); },
      on(name, callback) { this.hooks.set(name, [...(this.hooks.get(name) ?? []), callback]); },
      appendEntry(type, data) { h.sm.appendCustomEntry(type, data); },
      sendMessage(message, options) {
        assert.equal(h.idle, true, "Delivery must wait for safe idle");
        assert.deepEqual(options, { triggerTurn: false }, "No steering, follow-up queue, or automatic turn");
        h.sends.push({ message, options });
        const fake = { isStreaming: false, agent: { state: { messages: [] } }, sessionManager: h.sm, _emit() {}, _appendCustomMessage: AgentSession.prototype._appendCustomMessage,
          prompt() { assert.fail("The integration must not request a model turn"); } };
        // Real installed idle insertion/persistence path; no Agent/model is constructed.
        h.sendPromises.push(AgentSession.prototype.sendCustomMessage.call(fake, message, options));
      },
      sendUserMessage() { assert.fail("No synthetic user prompt or model request is allowed"); },
      async lifecycle(name, event = {}) {
        for (const callback of this.hooks.get(name) ?? []) await callback(event, h.context());
      },
    };
    h.pi = pi;
    registerGroundedDialog(pi, { askUserV1Enabled: true });
    // This factory constructs the actual QuestionService and RelayRuntime and wires
    // their lifecycle. No terminal provider reply or question service is mocked.
    await projectGlanceExtension(pi);
    await pi.lifecycle("session_start", { reason: "startup" });
    assert.deepEqual(pi.tools.map((tool) => tool.name), ["ask_user"]);
    assert.equal(pi.events.listeners.get(ASK_USER_DEFERRED_REQUEST_EVENT_V1)?.size, 1);
    assert.equal(pi.events.listeners.get(ASK_USER_BLOCKING_REQUEST_EVENT_V1)?.size, 1);
    assert.deepEqual(h.notices, [], "The real relay must start without degraded-mode warning");
  };
  h.execute = (input, id) => h.pi.tools[0].execute(id, input, undefined, undefined, h.context());
  h.connect = async () => {
    const state = { snapshot: undefined, errors: [], client: undefined };
    state.client = new ProjectGlanceClient({ descriptorPath: h.descriptorPath(), onSnapshot(snapshot) { state.snapshot = snapshot; }, onError(code) { state.errors.push(code); } });
    h.clients.push(state.client); state.client.start();
    await waitFor(() => state.client.state === "connected" && state.snapshot, "authenticated client snapshot");
    return state;
  };
  h.recreate = async () => {
    for (const client of h.clients) client.stop();
    h.clients = [];
    await h.pi.lifecycle("session_shutdown", { reason: "reload" });
    const sessionPath = h.sm.getSessionFile();
    h.sm = SessionManager.open(sessionPath, directory);
    await h.create();
  };
  t.after(async () => {
    try {
      for (const client of h.clients) client.stop();
      if (h.pi) await h.pi.lifecycle("session_shutdown", { reason: "quit" });
      await Promise.all(h.sendPromises);
    } finally {
      if (priorRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = priorRuntimeDir;
      if (priorStateHome === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = priorStateHome;
      rmSync(directory, { recursive: true, force: true });
    }
  });
  await h.create();
  return h;
}

// Send synthetic adversarial envelopes on an actual authenticated relay connection.
// Descriptor tokens stay inside this helper and are never included in assertions/logs.
async function rawPeer(t, descriptorPath) {
  const descriptor = await readConnectionDescriptor(descriptorPath);
  const socket = createConnection(descriptor.socketPath);
  const decoder = new ProjectGlanceFrameDecoder();
  const frames = [];
  const errors = [];
  socket.on("error", () => errors.push("socket"));
  socket.on("data", (chunk) => {
    try { frames.push(...decoder.push(chunk)); } catch { errors.push("frame"); }
  });
  t.after(() => socket.destroy());
  await waitFor(() => !socket.connecting, "synthetic socket connection");
  socket.write(encodeFrame({ version: 1, type: "hello", requestId: "integration-hello", sessionKey: descriptor.sessionKey, generation: descriptor.generation, token: descriptor.token }));
  await waitFor(() => frames.some((frame) => frame.type === "snapshot"), "authenticated raw snapshot");
  assert.ok(frames.some((frame) => frame.type === "hello"));
  return {
    async action(snapshot, action, patch = {}) {
      const requestId = `integration-${randomUUID()}`;
      socket.write(encodeFrame({ version: 1, type: "action", requestId, actionId: `action-${randomUUID()}`, sessionKey: descriptor.sessionKey, generation: descriptor.generation, branchId: snapshot.branchId, baseRevision: snapshot.revision, action, ...patch }));
      await waitFor(() => frames.some((frame) => frame.requestId === requestId), "correlated relay action receipt");
      assert.deepEqual(errors, []);
      return frames.find((frame) => frame.requestId === requestId);
    },
  };
}

for (const kind of ["single_or_text", "text"]) {
  test(`actual facade -> durable service -> authenticated Client ${kind} answer -> idle insertion once across reload`, async (t) => {
    const h = await harness(t);
    const input = ask(kind);
    const pending = h.execute(input, "stable-call");
    // The service must save CREATED before the facade promise can resolve queued.
    assert.equal(h.disk().filter((entry) => entry.customType === QUESTION_ENTRY_TYPE && entry.data.kind === "CREATED").length, 1);
    const queued = await pending;
    assert.equal(queued.details.status, "queued");
    const originalCorrelation = queued.details.correlationId;
    assert.equal(h.sends.length, 0);
    h.sm.appendCustomEntry("synthetic-independent-work", { completed: "Harmless independent work continued while awaiting an answer." });
    await h.pi.lifecycle("tool_execution_start");
    assert.equal(h.messages().length, 0);
    await h.recreate(); // Real disk reopen + both actual extension factories recreated.
    const replay = await h.execute(input, "stable-call");
    assert.deepEqual(replay.details, queued.details);
    assert.equal(replay.details.correlationId, originalCorrelation);
    assert.equal(h.entries().filter((entry) => entry.data.kind === "CREATED").length, 1);
    const connection = await h.connect();
    await waitFor(() => connection.snapshot.questions?.[0]?.id === queued.details.questionId, "restored pending question");
    const question = connection.snapshot.questions[0];
    assert.equal(question.state, "pending");
    const answer = kind === "text" ? { optionIds: [], text: "Synthetic text answer" } : { optionIds: ["a"] };
    const action = { type: "question_answer", questionId: question.id, expectedRevision: question.revision, answer };
    await connection.client.sendQuestionAction(connection.snapshot.branchId, connection.snapshot.revision, action);
    await waitFor(() => connection.snapshot.questions?.[0]?.state === "submitted", "busy submitted outbox snapshot");
    assert.equal(h.messages().length, 0);
    assert.equal(h.sends.length, 0);
    const savedAnswer = h.entries().find((entry) => entry.data.kind === "ANSWER");
    assert.deepEqual(savedAnswer.data.answer, answer);
    assert.equal(h.disk().filter((entry) => entry.customType === QUESTION_ENTRY_TYPE && entry.data.kind === "ANSWER").length, 1);
    const duplicate = await rawPeer(t, h.descriptorPath());
    assert.equal((await duplicate.action(connection.snapshot, action, { actionId: savedAnswer.data.action.id })).code, "replayed_action");
    await h.recreate(); // Submitted answers must survive without native in-memory Pi queues.
    const restored = await h.connect();
    await waitFor(() => restored.snapshot.questions?.[0]?.state === "submitted", "restored durable outbox");
    const durableReplay = await rawPeer(t, h.descriptorPath());
    assert.equal((await durableReplay.action(restored.snapshot, action, { actionId: savedAnswer.data.action.id })).type, "action_result");
    assert.equal(h.entries().filter((entry) => entry.data.kind === "ANSWER").length, 1);
    assert.equal(h.sends.length, 0);
    h.idle = true;
    await h.pi.lifecycle("agent_settled");
    await Promise.all(h.sendPromises);
    assert.equal(h.messages().length, 1);
    assert.equal(h.sends.length, 1);
    const delivered = JSON.parse(h.messages()[0].content.split("\n").slice(1).join("\n"));
    assert.equal(delivered.outcome, "answered");
    assert.equal(delivered.questionId, question.id);
    assert.deepEqual(delivered.answer, answer);
    assert.equal(h.sm.buildSessionContext().messages.filter((message) => message.customType === QUESTION_ANSWER_MESSAGE_TYPE).length, 1, "Next natural model context contains exactly one answer");
    assert.equal(h.disk().filter((entry) => entry.type === "custom_message" && entry.customType === QUESTION_ANSWER_MESSAGE_TYPE).length, 1);
    assert.deepEqual(h.entries().map((entry) => entry.data.kind), ["CREATED", "ANSWER", "DELIVERY"]);
    assert.ok(h.disk().some((entry) => entry.customType === "synthetic-independent-work"));
    await h.pi.lifecycle("agent_settled");
    await h.recreate();
    await h.execute(input, "stable-call");
    await h.pi.lifecycle("agent_settled");
    assert.equal(h.messages().length, 1);
    assert.equal(h.sends.length, 1);
    assert.equal(h.entries().filter((entry) => entry.data.kind === "CREATED").length, 1);
    assert.deepEqual(connection.errors, []);
  });
}

test("actual relay rejects stale revision/wrong branch envelopes; facade cancel receipt survives recreation", async (t) => {
  const h = await harness(t);
  const queued = await h.execute(ask(), "cancel-target");
  const connection = await h.connect();
  await waitFor(() => connection.snapshot.questions?.length === 1, "pending cancel target");
  const snapshot = connection.snapshot;
  const question = snapshot.questions[0];
  const action = { type: "question_answer", questionId: question.id, expectedRevision: question.revision, answer: { optionIds: ["a"] } };
  const raw = await rawPeer(t, h.descriptorPath());
  assert.equal((await raw.action(snapshot, action, { branchId: "synthetic-wrong-branch" })).code, "stale_action");
  assert.equal((await raw.action(snapshot, action, { baseRevision: snapshot.revision - 1 })).code, "stale_action");
  assert.equal((await raw.action(snapshot, { ...action, expectedRevision: 99 })).code, "invalid_action");
  assert.equal(h.entries().length, 1);
  await assert.rejects(h.execute({ operation: "cancel", mode: "deferred", id: queued.details.questionId, expectedRevision: 99, reason: "Synthetic stale cancellation." }, "cancel-stale"), /ASK_USER_/);
  const cancel = { operation: "cancel", mode: "deferred", id: queued.details.displayId, expectedRevision: 1, reason: "Synthetic work no longer needs this answer." };
  const cancelled = await h.execute(cancel, "cancel-stable");
  assert.equal(cancelled.details.status, "cancelled");
  assert.equal(cancelled.details.revision, 2);
  await h.recreate();
  assert.deepEqual((await h.execute(cancel, "cancel-stable")).details, cancelled.details);
  assert.deepEqual(h.entries().map((entry) => entry.data.kind), ["CREATED", "CANCEL"]);
  h.idle = true; await h.pi.lifecycle("agent_settled");
  assert.equal(h.messages().length, 0, "Agent cancellation is not a user answer");
  assert.equal(h.sends.length, 0);

  h.idle = false;
  const orphan = await h.execute(ask(), "branch-question");
  const beforeBranch = await h.connect();
  await waitFor(() => beforeBranch.snapshot.questions?.some((q) => q.id === orphan.details.questionId), "pre-navigation question");
  const oldSnapshot = beforeBranch.snapshot;
  h.sm.branch(h.rootLeaf);
  h.sm.appendCustomEntry("synthetic-other-branch", { marker: "No authority for sibling answers" });
  await h.pi.lifecycle("session_tree");
  await waitFor(() => beforeBranch.snapshot.revision !== oldSnapshot.revision && !(beforeBranch.snapshot.questions ?? []).some((q) => q.id === orphan.details.questionId), "new branch snapshot");
  assert.equal(beforeBranch.snapshot.questions?.length ?? 0, 0);
  const branchPeer = await rawPeer(t, h.descriptorPath());
  const orphanAction = { type: "question_answer", questionId: orphan.details.questionId, expectedRevision: 1, answer: { optionIds: ["a"] } };
  assert.equal((await branchPeer.action(oldSnapshot, orphanAction)).code, "stale_action");
  assert.equal((await branchPeer.action(beforeBranch.snapshot, orphanAction)).code, "invalid_action");
  assert.equal(h.entries().filter((entry) => entry.data.kind === "ANSWER").length, 0);
});

test("actual enabled registration advertises narrow facade schema and preserves the real blocking provider", async (t) => {
  const h = await harness(t);
  const tool = h.pi.tools[0];
  assert.deepEqual(h.pi.tools.map((entry) => entry.name), ["ask_user"]);
  const deferredSchema = tool.parameters.oneOf.find((schema) => schema.properties.mode.enum.includes("deferred") && schema.properties.operation.enum.includes("ask"));
  assert.deepEqual(deferredSchema.properties.class.enum, ["preference", "information", "reversible"]);
  assert.deepEqual(deferredSchema.properties.deliveryMode.enum, ["nextTurn"]);
  assert.deepEqual(deferredSchema.properties.escalationPolicy.enum, ["never"]);
  assert.equal(deferredSchema.properties.expiresAt, undefined);
  assert.doesNotMatch(tool.description, /Signals/u);
  for (const patch of [{ class: "authorization" }, { deliveryMode: "steer" }, { deliveryMode: "followUp" }, { escalationPolicy: "when_agent_settles" }, { expiresAt: new Date(Date.now() + 60_000).toISOString() }]) {
    await assert.rejects(h.execute({ ...ask(), ...patch }, "invalid-public-input"), /ASK_USER_INVALID_REQUEST/);
  }
  assert.equal(h.pi.events.requests.length, 0);
  const blocking = await h.execute({ operation: "ask", mode: "blocking", question: "Choose a synthetic blocking answer?", response: { kind: "single_or_text", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }, timeoutMs: 60_000 }, "blocking-call");
  assert.deepEqual(blocking.details.answer, { kind: "option", optionId: "a" });
  assert.equal(blocking.details.status, "answered");
  assert.equal(h.entries().length, 0);
  assert.equal(h.sends.length, 0);
});
