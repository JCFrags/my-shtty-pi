import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import groundedNotes from "../../notes/index.ts";
import groundedTasks from "../../tasks/index.ts";
import groundedWorkplan from "../index.ts";
import {
  STATE_CHECKPOINT_ENTRY,
  STATE_CHECKPOINT_MAX_BYTES,
  STATE_CHECKPOINT_REQUEST_EVENT,
  STATE_CHECKPOINT_RESPONSE_EVENT,
} from "../../core/src/state-transfer.ts";

class ProviderHost {
  listeners = new Map();
  handlers = new Map();
  tools = new Map();
  calls = 0;
  events = {
    on: (name, handler) => {
      const listeners = this.listeners.get(name) ?? new Set();
      listeners.add(handler);
      this.listeners.set(name, listeners);
      return () => listeners.delete(handler);
    },
    emit: (name, value) => { for (const handler of [...(this.listeners.get(name) ?? [])]) handler(value); },
  };
  constructor(manager = SessionManager.inMemory(), factories = [groundedNotes, groundedTasks, groundedWorkplan]) {
    this.manager = manager;
    this.context = { sessionManager: manager, hasUI: false, ui: { setWidget() {}, notify() {} } };
    for (const factory of factories) factory(this);
  }
  on(name, handler) {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
  }
  registerTool(tool) { this.tools.set(tool.name, tool); }
  registerCommand() {}
  registerShortcut() {}
  appendEntry(type, data) { this.manager.appendCustomEntry(type, data); }
  async lifecycle(name) {
    for (const handler of this.handlers.get(name) ?? []) await handler({ type: name }, this.context);
  }
  async persist(name, callId, result) {
    const message = { role: "toolResult", toolCallId: callId, toolName: name, content: result.content,
      details: result.details, isError: false, timestamp: Date.now() };
    this.manager.appendMessage(message);
    for (const handler of this.handlers.get("message_end") ?? []) await handler({ type: "message_end", message }, this.context);
  }
  async execute(name, args) {
    const callId = `call-${++this.calls}`;
    const result = await this.tools.get(name).execute(callId, args, new AbortController().signal);
    await this.persist(name, callId, result);
    return result;
  }
  export(maxBytes = STATE_CHECKPOINT_MAX_BYTES, overrides = {}) {
    const responses = [];
    const remove = this.events.on(STATE_CHECKPOINT_RESPONSE_EVENT, (value) => responses.push(value));
    const getBranch = this.manager.getBranch;
    this.manager.getBranch = () => { throw new Error("Checkpoint export must not replay history"); };
    try {
      this.events.emit(STATE_CHECKPOINT_REQUEST_EVENT, { version: 1, requestId: "transfer-1",
        sourceSessionId: this.manager.getSessionId(), sourceLeafId: this.manager.getLeafId(), maxBytes, ...overrides });
    } finally {
      this.manager.getBranch = getBranch;
      remove();
    }
    return responses;
  }
}

function states(responses) {
  assert.equal(responses.length, 3);
  assert.ok(responses.every((response) => response.ok), JSON.stringify(responses.filter((response) => !response.ok)));
  return Object.fromEntries(responses.map((response) => [response.provider, response.entry.data.state]));
}

async function replacement(responses) {
  const manager = SessionManager.inMemory();
  // This is the native append API used inside newSession.setup, before provider startup.
  for (const response of responses) manager.appendCustomEntry(response.entry.customType, response.entry.data);
  const host = new ProviderHost(manager);
  await host.lifecycle("session_start");
  return host;
}

test("native checkpoint transfer preserves exact state, subsequent actions, and selected branches", async () => {
  const source = new ProviderHost();
  await source.lifecycle("session_start");
  await source.execute("notes", { action: "add", title: "Active", body: "Exact note\nUnicode: café" });
  await source.execute("notes", { action: "update", id: "N1", expectedRevision: 1, tags: ["keep"] });
  await source.execute("notes", { action: "add", body: "Archived note" });
  await source.execute("notes", { action: "archive", id: "N2", expectedRevision: 1 });
  await source.execute("notes", { action: "add", body: "Removed note" });
  await source.execute("notes", { action: "remove", id: "N3", expectedRevision: 1 });
  await source.execute("todo", { action: "replace", tasks: [
    { id: "T7", text: "Completed", status: "done" },
    { id: "T19", text: "Waiting", status: "blocked", blockedBy: ["T7"], waitReason: "Input required" },
  ] });
  await source.execute("workplan", { action: "create", content: { title: "Current plan", objective: "Preserve identity", approach: "Use native state" } });
  await source.execute("workplan", { action: "resume", planId: "WP1", expectedRevision: 1, rationale: "Start" });
  await source.execute("workplan", { action: "checkpoint", planId: "WP1", expectedRevision: 2,
    content: { summary: "Prior recovery", currentFocus: "Transfer", nextActions: ["Continue"] } });
  await source.execute("workplan", { action: "record_decision", planId: "WP1", expectedRevision: 3, content: { decision: "Keep IDs" }, rationale: "Preserve references" });
  await source.execute("workplan", { action: "create", content: { title: "Retained old plan", objective: "Keep archive", approach: "Do not discard" } });
  await source.execute("workplan", { action: "archive", planId: "WP2", expectedRevision: 1, rationale: "Retain history" });

  const checkpoints = source.export();
  const before = states(checkpoints);
  assert.equal(before.notes.nextNoteNumber, 4);
  assert.equal(before.todo.nextId, 20);
  assert.equal(before.workplan.nextPlanNumber, 3);
  assert.equal(before.workplan.plans[0].status, "active");
  assert.equal(before.workplan.plans[0].revisions.length, 4);
  assert.equal(before.workplan.plans[1].status, "archived");
  const restored = await replacement(checkpoints);
  assert.equal(restored.manager.getEntries().length, 3);
  assert.deepEqual(states(restored.export()), before);
  const checkpointLeaf = restored.manager.getLeafId();
  const oldPlanText = (await source.execute("workplan", { action: "read", planId: "WP1" })).content;
  assert.deepEqual((await restored.execute("workplan", { action: "read", planId: "WP1" })).content, oldPlanText);
  assert.equal((await restored.execute("notes", { action: "read", id: "N1" })).details.result.body, "Exact note\nUnicode: café");
  assert.match((await restored.execute("workplan", { action: "recover", planId: "WP1" })).content[0].text, /WP1-K1/);
  assert.equal((await restored.execute("notes", { action: "add", body: "After transfer" })).details.result.id, "N4");
  await restored.execute("notes", { action: "update", id: "N1", expectedRevision: 2, title: "Updated after transfer" });
  assert.equal((await restored.execute("todo", { action: "add", text: "New task" })).details.state.tasks.at(-1).id, "T20");
  await restored.execute("todo", { action: "update", id: "T19", waitReason: "" });
  await restored.execute("workplan", { action: "checkpoint", planId: "WP1", expectedRevision: 4, content: { summary: "Next recovery" } });
  const after = states(restored.export());
  assert.equal(after.workplan.plans[0].revision, 5);
  assert.equal(after.workplan.plans[0].checkpoints.at(-1).id, "WP1-K2");
  assert.deepEqual(after.workplan.plans[0].revisions.slice(0, 4), before.workplan.plans[0].revisions);
  const updatedLeaf = restored.manager.getLeafId();
  await restored.lifecycle("session_tree");
  assert.deepEqual(states(restored.export()), after, "ordinary events must replay after the checkpoint");

  restored.manager.branch(checkpointLeaf);
  await restored.lifecycle("session_tree");
  assert.deepEqual(states(restored.export()), before);
  await assert.rejects(() => restored.execute("notes", { action: "read", id: "N4" }), /STATE_NOT_FOUND/);
  restored.manager.resetLeaf();
  await restored.lifecycle("session_tree");
  const sibling = states(restored.export());
  assert.equal(sibling.notes.notes.length, 0);
  assert.equal(sibling.todo.tasks.length, 0);
  assert.equal(sibling.workplan.plans.length, 0);
  restored.manager.branch(updatedLeaf);
  await restored.lifecycle("session_tree");
  assert.deepEqual(states(restored.export()), after);
  await source.lifecycle("session_shutdown");
  await restored.lifecycle("session_shutdown");
});

test("exports refuse pending, wrong-scope, and over-budget state; invalid native checkpoints fail closed", async () => {
  const source = new ProviderHost();
  await source.lifecycle("session_start");
  for (const [name, args] of [
    ["notes", { action: "add", body: "Pending note" }],
    ["todo", { action: "add", text: "Pending task" }],
    ["workplan", { action: "create", content: { title: "Pending plan", objective: "Objective", approach: "Approach" } }],
  ]) {
    const id = `pending-${name}`;
    const resultPromise = source.tools.get(name).execute(id, args, new AbortController().signal);
    assert.equal(source.export().find((response) => response.provider === name).code, "state-checkpoint-pending");
    const result = await resultPromise;
    assert.equal(source.export().find((response) => response.provider === name).code, "state-checkpoint-pending");
    await source.persist(name, id, result);
    assert.equal(source.export().find((response) => response.provider === name).ok, true);
  }
  assert.ok(source.export(64).every((response) => response.code === "state-checkpoint-budget"));
  assert.ok(source.export(STATE_CHECKPOINT_MAX_BYTES + 1).every((response) => response.code === "state-checkpoint-budget"));
  assert.ok(source.export(undefined, { sourceLeafId: "wrong-branch" }).every((response) => response.code === "state-checkpoint-scope"));

  const checkpoints = source.export();
  checkpoints[0].entry.data.state.nextNoteNumber = 1;
  const invalid = await replacement(checkpoints);
  assert.equal(invalid.export().find((response) => response.provider === "notes").code, "state-checkpoint-corrupt");
  await assert.rejects(() => invalid.execute("notes", { action: "read", id: "N1" }), /STATE_CORRUPT/);
  assert.equal(source.export()[0].entry.data.state.nextNoteNumber, 2, "exports must be detached from provider state");

  const duplicate = await replacement([...source.export(), source.export()[0]]);
  assert.equal(duplicate.export().find((response) => response.provider === "notes").code, "state-checkpoint-corrupt");
  const manager = SessionManager.inMemory();
  manager.appendCustomMessageEntry(STATE_CHECKPOINT_ENTRY, "A prose continuation is not native state", false, source.export()[0].entry.data);
  const prose = new ProviderHost(manager, [groundedNotes]);
  await prose.lifecycle("session_start");
  const onlyPresentOwner = prose.export();
  assert.equal(onlyPresentOwner.length, 1);
  assert.equal(onlyPresentOwner[0].provider, "notes");
  assert.equal(onlyPresentOwner[0].entry.data.state.notes.length, 0);
  for (const host of [source, invalid, duplicate, prose]) await host.lifecycle("session_shutdown");
});
