import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { jsonBytes } from "@context-kit/protocol";
import { createWorkplanContextRecord, projectNotesPage, projectTodoPage, projectWorkplanPage } from "@grounded/pi-core/context-adapters";
import { emptyWorkplanState, performWorkplanAction } from "@grounded/pi-core/workplan";
import { WorkplanStore } from "@context-kit/workplan/store";
import { fixtureDirectory, persistedSession, NativeProviderHost } from "./fixtures/native-providers.mjs";

async function assertDiskAnchor(host, providerId) {
  const anchor = host.manager.getEntries().findLast((entry) => entry.type === "custom"
    && entry.customType === "context-kit:state-anchor:v1" && entry.data.providerId === providerId);
  assert.ok(anchor);
  const persisted = (await readFile(host.manager.getSessionFile(), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(persisted.find((entry) => entry.id === anchor.id), JSON.parse(JSON.stringify(anchor)));
}

const operations = {
  todo: { add: { action: "add", text: "Initial task" }, update: { action: "update", id: "T1", text: "Changed task" }, read: { action: "list" }, id: "T1" },
  notes: { add: { action: "add", title: "Initial note", body: "Source text" }, update: { action: "update", id: "N1", expectedRevision: 1, title: "Changed note" }, read: { action: "read", id: "N1" }, id: "N1" },
  workplan: { add: { action: "create", content: { title: "Initial plan", objective: "Recover native state", approach: "Bounded reads" } },
    update: { action: "revise", planId: "WP1", expectedRevision: 1, section: "title", content: "Changed plan", rationale: "Clarify" },
    read: { action: "recover", planId: "WP1" }, id: "WP1" },
};

test("each owned factory works alone, commits before tool results, and preserves exact branch state", async (t) => {
  for (const [name, op] of Object.entries(operations)) {
    const root = await fixtureDirectory(`context-${name}`);
    const host = new NativeProviderHost(await persistedSession(root), root, { providers: [name] });
    t.after(() => host.lifecycle("session_shutdown"));
    await host.lifecycle("session_start");
    const initial = await host.execute(name, op.add);
    const initialLeaf = host.manager.getLeafId();
    const ready = await host.query(name);
    assert.equal(ready.readiness, "ready");
    assert.equal(ready.cards[0].id, op.id);
    assert.ok(ready.cards[0].revision);
    if (name !== "todo") assert.equal(ready.cards[0].revision, "1");
    assert.ok(initial.details.owner.commitId);
    await assertDiskAnchor(host, name);
    assert.equal((await host.query(name === "notes" ? "todo" : "notes")), undefined, "absent peers do not register providers");
    assert.ok((await host.execute(name, op.read)).content[0].text.length);
    const oldScope = host.scope();
    const committed = await host.execute(name, op.update, { persist: false });
    assert.equal((await host.query(name)).readiness, "ready", "the owned disk anchor is the persistence boundary");
    await assertDiskAnchor(host, name);
    await host.persist(name, "committed", committed);
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
    const reopened = SessionManager.open(host.manager.getSessionFile());
    reopened.branch(initialLeaf);
    const reloaded = new NativeProviderHost(reopened, root, { providers: [name] });
    t.after(() => reloaded.lifecycle("session_shutdown"));
    await reloaded.lifecycle("session_start");
    assert.deepEqual((await reloaded.query(name)).cards, ready.cards);
    const broken = structuredClone(initial.details);
    if (name === "todo") broken.state = {};
    else broken.event.stateRevision = 999999;
    reloaded.manager.appendMessage({ role: "toolResult", toolName: name, toolCallId: "invalid", content: [], details: broken, isError: false, timestamp: Date.now() });
    await reloaded.lifecycle("session_tree");
    assert.deepEqual((await reloaded.query(name)).cards, ready.cards, "owned tool-result envelopes cannot replace committed state");
    assert.ok((await reloaded.execute(name, op.read)).content[0].text.length);
    await reloaded.lifecycle("session_shutdown");
  }
});

test("current-state browse selects open records before scan and reply limits without deleting retained state", async () => {
  const directory = await fixtureDirectory("context-kit-current-selection");
  const store = new WorkplanStore({ storeRoot: join(directory, "workplan") });
  const entries = new Map();
  let leafId = null;
  const host = {
    sessionManager: {
      getSessionId: () => "selection-fixture", getSessionFile: () => undefined,
      getLeafId: () => leafId, getEntry: (id) => entries.get(id),
      getHeader: () => ({ id: "selection-fixture" }),
    },
    appendEntry(customType, data) {
      const id = `anchor-${entries.size + 1}`;
      entries.set(id, { id, parentId: leafId, type: "custom", customType, data });
      leafId = id;
    },
  };
  try {
    let state = emptyWorkplanState();
    const apply = (input) => { state = performWorkplanAction(state, input, 1_700_000_000_000).state; };
    for (let number = 1; number <= 20; number++) {
      apply({ action: "create", content: { title: `Retired plan ${number}`, objective: "Old objective", approach: "Native recovery retained" } });
      apply({ action: "archive", planId: `WP${number}`, expectedRevision: 1, rationale: "Fixture complete" });
    }
    apply({ action: "create", content: { title: "Current active plan", objective: "Continue current task", approach: "Use native state" } });
    apply({ action: "resume", planId: "WP21", expectedRevision: 1, rationale: "Start current task" });
    await store.resolve(host);
    const root = await store.stageNativeState(state);
    await store.commitRoot(host, root, { expectedCommitId: null, durability: "allow-volatile" });
    const nativeBefore = JSON.stringify(store.root), entriesBefore = entries.size;
    const loaded = [];
    const projection = store.projection.bind(store);
    store.projection = (metadata, signal) => { loaded.push(metadata.id); return projection(metadata, signal); };
    const request = (overrides = {}) => ({ version: 2, requestId: "selection", providerId: "workplan",
      scope: { sessionId: "selection-fixture", leafId }, query: "", categories: [],
      limits: { records: 6, scan: 128, bytes: 8192 }, deadlineMs: Date.now() + 1000, ...overrides });
    for (const limits of [{ records: 6, scan: 128, bytes: 8192 }, { records: 1, scan: 1, bytes: 2048 }]) {
      loaded.length = 0;
      const input = request({ limits });
      const page = await store.contextPage(host, input);
      assert.equal(page.readiness, "ready");
      assert.deepEqual(page.cards.map(({ id, revision, status }) => ({ id, revision, status })), [{ id: "WP21", revision: "2", status: "active" }]);
      assert.deepEqual(loaded, ["WP21"], "closed projections never consume browse scan work");
      assert.deepEqual(page.coverage, { scanned: 1, matched: 1, excluded: 0, scanComplete: true });
      assert.ok(jsonBytes({ version: input.version, requestId: input.requestId, providerId: input.providerId, scope: input.scope, ...page }) <= limits.bytes);
    }
    const queried = await store.contextPage(host, request({ query: "retired" }));
    assert.equal(queried.cards[0].id, "WP1");
    assert.equal(queried.cards[0].status, "archived");
    assert.deepEqual(queried.coverage, { scanned: 21, matched: 20, excluded: 14, scanComplete: true });
    const recovered = await store.execute(host, queried.cards[0].recovery.args);
    assert.match(recovered.text, /archived/);
    assert.deepEqual(recovered.recovery, { planId: "WP1", revision: 2 });
    assert.deepEqual(await store.readSelected(store.root, "WP1"), state.plans[0]);
    assert.equal(JSON.stringify(store.root), nativeBefore);
    assert.equal(entries.size, entriesBefore, "projection and recovery do not append source entries");
    assert.equal((await store.contextPage(host, request({ scope: { sessionId: "wrong-view", leafId } }))).readiness, "scope_changed");

    const records = state.plans.map(createWorkplanContextRecord);
    const openAndClosed = [{ ...records[0], status: "draft" }, { ...records[1], status: "completed" }, ...records.slice(2)];
    const bounded = request({ limits: { records: 1, scan: 1, bytes: 2048 } });
    const current = projectWorkplanPage(bounded, openAndClosed);
    assert.equal(current.cards[0].id, "WP21", "active plans precede other open plans before scanning");
    assert.equal(current.coverage.scanComplete, false, "another eligible draft was not scanned");
    assert.deepEqual(projectWorkplanPage(request(), records.slice(0, 20)).coverage,
      { scanned: 0, matched: 0, excluded: 0, scanComplete: true });
    assert.deepEqual(projectWorkplanPage(request(), [{ ...records[0], status: "completed" }]).cards, []);
    assert.equal(projectWorkplanPage(request({ query: "retired" }), [{ ...records[0], status: "completed" }]).cards[0].status, "completed");

    const tasks = Array.from({ length: 20 }, (_, index) => ({ id: `T${index + 1}`, text: "Retired task", status: "done", blockedBy: [], createdAt: 1, updatedAt: 1 }));
    tasks.push({ ...tasks[0], id: "T21", text: "Pending task", status: "pending" }, { ...tasks[0], id: "T22", text: "Current task", status: "in_progress" });
    const todo = { tasks, nextId: 23 };
    assert.equal(projectTodoPage({ ...bounded, providerId: "todo" }, todo).cards[0].id, "T22");
    assert.equal(projectTodoPage(request({ providerId: "todo", query: "retired" }), todo).cards[0].status, "done");
    const notes = Array.from({ length: 20 }, (_, index) => ({ id: `N${index + 1}`, title: "Retired note", body: "Source text", tags: [], status: "archived", revision: 1, createdAt: "1", updatedAt: "1" }));
    notes.push({ ...notes[0], id: "N21", title: "Current note", status: "active" });
    const notesState = { notes, nextNoteNumber: 22, stateRevision: 21 };
    assert.equal(projectNotesPage({ ...bounded, providerId: "notes" }, notesState).cards[0].id, "N21");
    assert.equal(projectNotesPage(request({ providerId: "notes", query: "retired" }), notesState).cards[0].status, "archived");
    const oversizedLegacy = { tasks: Array.from({ length: 257 }, (_, index) => ({ ...tasks[0], id: `T${index + 1}` })), nextId: 258 };
    assert.deepEqual(projectTodoPage(request({ providerId: "todo" }), oversizedLegacy).coverage,
      { scanned: 0, matched: 0, excluded: 0, scanComplete: false }, "metadata admission is bounded even for uncapped legacy Todo state");
  } finally {
    store.close();
  }
});

test("bounded query excerpts and native relations survive a hidden peer without changing tool state", async (t) => {
  const root = await fixtureDirectory("context-relations");
  const host = new NativeProviderHost(await persistedSession(root), root);
  t.after(() => host.lifecycle("session_shutdown"));
  await host.lifecycle("session_start");
  await host.execute("todo", { action: "add", text: "Review" });
  await host.execute("todo", { action: "add", text: "Release gate", blockedBy: ["T1"], waitReason: "Approval" });
  const body = "Earlier context. ".repeat(90) + "needle evidence for rollback" + " unrelated continuation".repeat(300);
  await host.execute("notes", { action: "add", title: "Source note", body });
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
  host.active = ["todo", "workplan"];
  assert.equal((await host.query("notes")).readiness, "unavailable");
  assert.equal((await host.query("todo")).readiness, "ready");
  assert.equal((await host.query("workplan")).readiness, "ready");
  await host.lifecycle("session_shutdown");

  const optionalRoot = await fixtureDirectory("context-optional-transport");
  const noTransport = new NativeProviderHost(await persistedSession(optionalRoot), optionalRoot,
    { providers: ["todo", "notes"], rejectAdapter: true });
  t.after(() => noTransport.lifecycle("session_shutdown"));
  await noTransport.lifecycle("session_start");
  for (const name of ["todo", "notes"]) {
    const op = operations[name];
    await noTransport.execute(name, op.add);
    assert.ok((await noTransport.execute(name, op.read)).content[0].text.length);
  }
  await noTransport.lifecycle("session_shutdown");
});
