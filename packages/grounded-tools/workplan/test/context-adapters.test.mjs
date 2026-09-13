import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { requestChannel, responseChannel, validateResponse, jsonBytes } from "@context-kit/protocol";
import groundedTasks from "../../tasks/index.ts";
import groundedNotes from "../../notes/index.ts";
import groundedWorkplan from "../index.ts";

const factories = { todo: groundedTasks, notes: groundedNotes, workplan: groundedWorkplan };
class Host {
  listeners = new Map();
  handlers = new Map();
  tools = new Map();
  calls = 0;
  active;
  events = {
    on: (name, handler) => {
      if (this.rejectAdapter && name.startsWith("context-kit:")) throw new Error("Transport unavailable");
      const listeners = this.listeners.get(name) ?? new Set();
      listeners.add(handler);
      this.listeners.set(name, listeners);
      return () => listeners.delete(handler);
    },
    emit: (name, value) => { for (const handler of [...(this.listeners.get(name) ?? [])]) handler(value); },
  };
  constructor(names = Object.keys(factories), manager = SessionManager.inMemory(), rejectAdapter = false) {
    this.manager = manager;
    this.rejectAdapter = rejectAdapter;
    const host = this;
    this.context = { get sessionManager() { return host.manager; }, hasUI: false, ui: { setWidget() {}, notify() {} } };
    for (const name of names) factories[name](this, { settingsPath: join(tmpdir(), "context-kit-no-settings", "settings.json") });
  }
  on(name, handler) { const handlers = this.handlers.get(name) ?? []; handlers.push(handler); this.handlers.set(name, handlers); }
  registerTool(tool) { this.tools.set(tool.name, tool); }
  registerCommand() {}
  registerShortcut() {}
  getActiveTools() { return this.active ?? [...this.tools.keys()]; }
  appendEntry(type, data) { this.manager.appendCustomEntry(type, data); }
  scope() { return { sessionId: this.manager.getSessionId(), leafId: this.manager.getLeafId() }; }
  async lifecycle(name) { for (const handler of this.handlers.get(name) ?? []) await handler({ type: name }, this.context); }
  async persist(name, id, result) {
    const message = { role: "toolResult", toolName: name, toolCallId: id, content: result.content, details: result.details, isError: false, timestamp: Date.now() };
    this.manager.appendMessage(message);
    for (const handler of this.handlers.get("message_end") ?? []) await handler({ type: "message_end", message }, this.context);
  }
  async execute(name, args) {
    const id = `call-${++this.calls}`;
    const result = await this.tools.get(name).execute(id, args, new AbortController().signal);
    await this.persist(name, id, result);
    return result;
  }
  async query(providerId, overrides = {}) {
    const request = { version: 1, requestId: `query-${++this.calls}`, providerId, scope: this.scope(), query: "",
      categories: [], limits: { records: 6, scan: 128, bytes: 8192 }, deadlineMs: Date.now() + 1000, ...overrides };
    let response;
    const remove = this.events.on(responseChannel(providerId), (value) => { response = value; });
    const getBranch = this.manager.getBranch;
    this.manager.getBranch = () => { throw new Error("Context adapters must not replay native history"); };
    try {
      this.events.emit(requestChannel(providerId), request);
      await tick();
      if (response) validateResponse(response, request);
      return response;
    } finally { this.manager.getBranch = getBranch; remove(); }
  }
}

const operations = {
  todo: { add: { action: "add", text: "Initial task" }, update: { action: "update", id: "T1", text: "Changed task" }, read: { action: "list" }, id: "T1" },
  notes: { add: { action: "add", title: "Initial note", body: "Source text" }, update: { action: "update", id: "N1", expectedRevision: 1, title: "Changed note" }, read: { action: "read", id: "N1" }, id: "N1" },
  workplan: { add: { action: "create", content: { title: "Initial plan", objective: "Recover native state", approach: "Bounded reads" } },
    update: { action: "revise", planId: "WP1", expectedRevision: 1, section: "title", content: "Changed plan", rationale: "Clarify" },
    read: { action: "recover", planId: "WP1" }, id: "WP1" },
};

test("each actual native factory works alone and refuses unpersisted, wrong-view, hidden, and corrupt state", async () => {
  for (const [name, op] of Object.entries(operations)) {
    const host = new Host([name]);
    await host.lifecycle("session_start");
    const initial = await host.execute(name, op.add);
    const initialLeaf = host.manager.getLeafId();
    const ready = await host.query(name);
    assert.equal(ready.readiness, "ready");
    assert.equal(ready.cards[0].id, op.id);
    assert.equal(ready.cards[0].revision, name === "todo" ? String(initial.details.state.tasks[0].updatedAt) : "1");
    assert.equal((await host.query(name === "notes" ? "todo" : "notes")), undefined, "absent peers do not register providers");
    assert.ok((await host.execute(name, op.read)).content[0].text.length);
    const oldScope = host.scope();
    const pending = await host.tools.get(name).execute("pending", op.update, new AbortController().signal);
    assert.equal((await host.query(name)).readiness, "pending");
    assert.deepEqual((await host.query(name)).cards, []);
    await host.persist(name, "pending", pending);
    assert.equal((await host.query(name)).readiness, "ready");
    assert.equal((await host.query(name, { scope: oldScope })).readiness, "scope_changed");
    assert.equal((await host.query(name, { scope: { ...host.scope(), sessionId: "other-session" } })).readiness, "scope_changed");
    host.active = [];
    assert.equal((await host.query(name)).readiness, "unavailable");
    host.active = undefined;
    host.manager.branch(initialLeaf);
    await host.lifecycle("session_tree");
    assert.deepEqual((await host.query(name)).cards, ready.cards, "tree restore returns the selected native revision");
    await host.lifecycle("session_shutdown");
    assert.equal(await host.query(name), undefined, "shutdown removes the context listener");
    const reloaded = new Host([name], host.manager);
    await reloaded.lifecycle("session_start");
    assert.deepEqual((await reloaded.query(name)).cards, ready.cards);
    const broken = structuredClone(initial.details);
    if (name === "todo") broken.state = {};
    else broken.event.stateRevision = 999999;
    reloaded.manager.appendMessage({ role: "toolResult", toolName: name, toolCallId: "invalid", content: [], details: broken, isError: false, timestamp: Date.now() });
    await reloaded.lifecycle("session_tree");
    assert.equal((await reloaded.query(name)).readiness, "corrupt");
    await assert.rejects(() => reloaded.execute(name, op.read), /STATE_CORRUPT/);
    await reloaded.lifecycle("session_shutdown");
  }
});

test("bounded query excerpts and native relations survive a failed peer without changing tool state", async () => {
  const host = new Host();
  await host.lifecycle("session_start");
  await host.execute("todo", { action: "add", text: "Review" });
  await host.execute("todo", { action: "add", text: "Release gate", blockedBy: ["T1"], waitReason: "Approval" });
  const body = "Earlier context. ".repeat(90) + "needle evidence for rollback" + " unrelated continuation".repeat(300);
  const note = await host.execute("notes", { action: "add", title: "Source note", body });
  await host.execute("workplan", { action: "create", content: { title: "Release plan", objective: "Recover state", approach: "Use native records", constraints: ["Retain recovery data"] } });
  await host.execute("workplan", { action: "add_milestone", planId: "WP1", expectedRevision: 1, content: { title: "Release gate" } });
  await host.execute("workplan", { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M1", expectedRevision: 2, content: { status: "in_progress", linkedTodoIds: ["T2"] } });
  await host.execute("workplan", { action: "record_decision", planId: "WP1", expectedRevision: 3, content: { decision: "Abort the release if recovery fails" }, rationale: "Keep state" });
  const before = host.manager.getEntries().length;
  const source = await host.query("notes", { query: "needle", categories: ["note"] });
  assert.match(source.cards[0].text, /needle evidence/);
  assert.ok(source.cards[0].omittedFields.includes("body"));
  assert.equal(source.coverage.scanComplete, false);
  assert.deepEqual(source.cards[0].recovery, { tool: "notes", args: { action: "read", id: "N1" } });
  const blocker = await host.query("todo", { query: "Release", categories: ["blocker"] });
  assert.deepEqual(blocker.cards[0].relations, [{ type: "blocked_by", providerId: "todo", id: "T1" }]);
  const decision = await host.query("workplan", { query: "Abort", categories: ["decision"] });
  assert.equal(decision.cards[0].id, "WP1");
  assert.equal(decision.cards[0].revision, "4");
  assert.equal(decision.cards[0].category, "decision");
  assert.match(decision.cards[0].text, /Abort the release/);
  assert.deepEqual(decision.cards[0].relations, [{ type: "linked_todo", providerId: "todo", id: "T2" }]);
  assert.equal((await host.query("workplan", { query: "recovery", categories: ["constraint"] })).cards[0].category, "constraint");
  assert.equal(host.manager.getEntries().length, before, "adapter queries do not append or inject context");
  source.cards[0].text = "Consumer mutation";
  assert.equal((await host.execute("notes", { action: "read", id: "N1" })).details.result.body, body);
  const bounded = await host.query("workplan", { limits: { records: 1, scan: 1, bytes: 2048 } });
  assert.ok(jsonBytes(bounded) <= 2048);
  assert.equal(bounded.coverage.matched, bounded.cards.length + bounded.coverage.excluded);
  await host.execute("todo", { action: "replace", tasks: Array.from({ length: 129 }, (_, i) => ({ text: `Task ${i}` })) });
  const capped = await host.query("todo", { limits: { records: 1, scan: 512, bytes: 2048 } });
  assert.equal(capped.coverage.scanned, 128);
  assert.equal(capped.coverage.scanComplete, false);
  assert.equal(capped.coverage.excluded, 127);
  const invalid = structuredClone(note.details);
  invalid.event.stateRevision = 999999;
  host.manager.appendMessage({ role: "toolResult", toolName: "notes", toolCallId: "invalid", content: [], details: invalid, isError: false, timestamp: Date.now() });
  await host.lifecycle("session_tree");
  assert.equal((await host.query("notes")).readiness, "corrupt");
  assert.equal((await host.query("todo")).readiness, "ready");
  assert.equal((await host.query("workplan")).readiness, "ready");
  await host.lifecycle("session_shutdown");

  const noTransport = new Host(undefined, undefined, true);
  await noTransport.lifecycle("session_start");
  for (const [name, op] of Object.entries(operations)) {
    await noTransport.execute(name, op.add);
    assert.ok((await noTransport.execute(name, op.read)).content[0].text.length);
  }
  await noTransport.lifecycle("session_shutdown");
});
