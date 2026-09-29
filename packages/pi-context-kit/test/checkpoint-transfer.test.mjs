import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setImmediate as settledTurn } from "node:timers/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { captureStateTransfer, NATIVE_CHECKPOINT_ENTRY, OWNER_BINDING_ENTRY, STATE_TRANSFER_LIMITS,
  STATE_TRANSFER_REQUEST, STATE_TRANSFER_RESPONSE } from "@context-kit/protocol/transfer";
import { fixtureDirectory, persistedSession, NativeProviderHost } from "./fixtures/native-providers.mjs";

async function host(t, entries = [], providers = ["todo", "notes", "workplan"]) {
  const root = await fixtureDirectory("checkpoint-transfer");
  const manager = await persistedSession(root);
  for (const entry of entries) manager.appendCustomEntry(entry.customType, entry.data);
  const result = new NativeProviderHost(manager, root, { providers });
  t.after(() => result.lifecycle("session_shutdown"));
  await result.lifecycle("session_start");
  return result;
}
async function exported(source) {
  // A collected reply precedes the provider's promise finalizer. Start the next probe in a new turn.
  await settledTurn();
  const getBranch = source.manager.getBranch;
  source.manager.getBranch = () => { throw new Error("Checkpoint export must not replay history"); };
  try { return await captureStateTransfer(source.events, () => source.scope(), { providers: [...source.tools.keys()], waitMs: 3000 }); }
  finally { source.manager.getBranch = getBranch; }
}
function states(entries, count = 3) {
  const native = entries.filter((entry) => entry.customType === NATIVE_CHECKPOINT_ENTRY);
  assert.equal(native.length, count);
  return Object.fromEntries(native.map((entry) => [entry.data.provider, entry.data.state]));
}
async function refused(source, { maxBytes = STATE_TRANSFER_LIMITS.providerBytes, scope = source.scope() } = {}) {
  await settledTurn();
  const requestId = `negative-${++source.calls}`, replies = new Map();
  let remove, timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Transfer response timeout")), 3000);
      remove = source.events.on(STATE_TRANSFER_RESPONSE, (reply) => {
        if (reply.requestId !== requestId) return;
        replies.set(reply.provider, reply);
        if (replies.size === source.tools.size) resolve([...replies.values()]);
      });
      source.events.emit(STATE_TRANSFER_REQUEST, { version: 2, requestId, scope, providers: [...source.tools.keys()], maxBytes, deadlineMs: Date.now() + 3000 });
    });
  } finally { clearTimeout(timer); remove?.(); }
}

test("native checkpoint transfer preserves exact state, subsequent actions, and selected branches", async (t) => {
  const source = await host(t);
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

  const prefix = await readFile(source.manager.getSessionFile());
  const checkpoints = await exported(source), before = states(checkpoints);
  assert.equal(checkpoints.filter((entry) => entry.customType === OWNER_BINDING_ENTRY).length, 3);
  assert.deepEqual(await readFile(source.manager.getSessionFile()), prefix, "capture preserves the original source");
  assert.equal(before.notes.nextNoteNumber, 4);
  assert.equal(before.todo.nextId, 20);
  assert.equal(before.workplan.nextPlanNumber, 3);
  assert.equal(before.workplan.plans[0].status, "active");
  assert.equal(before.workplan.plans[0].revisions.length, 4);
  assert.equal(before.workplan.plans[1].status, "archived");
  const restored = await host(t, checkpoints);
  assert.deepEqual(states(await exported(restored)), before);
  const checkpointLeaf = restored.manager.getLeafId();
  const oldPlanText = (await source.execute("workplan", { action: "read", planId: "WP1" })).content;
  assert.deepEqual((await restored.execute("workplan", { action: "read", planId: "WP1" })).content, oldPlanText);
  assert.equal((await restored.execute("notes", { action: "read", id: "N1" })).details.result.body, "Exact note\nUnicode: café");
  assert.match((await restored.execute("workplan", { action: "recover", planId: "WP1" })).content[0].text, /WP1-K1/);
  assert.equal((await restored.execute("notes", { action: "add", body: "After transfer" })).details.result.id, "N4");
  await restored.execute("notes", { action: "update", id: "N1", expectedRevision: 2, title: "Updated after transfer" });
  await restored.execute("todo", { action: "add", text: "New task" });
  assert.equal((await restored.execute("todo", { action: "list" })).details.state.tasks.at(-1).id, "T20");
  await restored.execute("todo", { action: "update", id: "T19", waitReason: "" });
  await restored.execute("workplan", { action: "checkpoint", planId: "WP1", expectedRevision: 4, content: { summary: "Next recovery" } });
  const after = states(await exported(restored));
  assert.equal(after.workplan.plans[0].revision, 5);
  assert.equal(after.workplan.plans[0].checkpoints.at(-1).id, "WP1-K2");
  assert.deepEqual(after.workplan.plans[0].revisions.slice(0, 4), before.workplan.plans[0].revisions);
  const updatedLeaf = restored.manager.getLeafId();
  await restored.lifecycle("session_tree");
  assert.deepEqual(states(await exported(restored)), after);
  restored.manager.branch(checkpointLeaf);
  await restored.lifecycle("session_tree");
  assert.deepEqual(states(await exported(restored)), before);
  await assert.rejects(() => restored.execute("notes", { action: "read", id: "N4" }), /STATE_NOT_FOUND/);
  restored.manager.resetLeaf();
  await restored.lifecycle("session_tree");
  const sibling = states(await exported(restored));
  assert.equal(sibling.notes.notes.length, 0);
  assert.equal(sibling.todo.tasks.length, 0);
  assert.equal(sibling.workplan.plans.length, 0);
  restored.manager.branch(updatedLeaf);
  await restored.lifecycle("session_tree");
  assert.deepEqual(states(await exported(restored)), after);
});

test("owned exports use committed anchors and refuse wrong scope, budget, and invalid native checkpoints", async (t) => {
  const source = await host(t);
  for (const [name, args] of [
    ["notes", { action: "add", body: "Committed note" }],
    ["todo", { action: "add", text: "Committed task" }],
    ["workplan", { action: "create", content: { title: "Committed plan", objective: "Objective", approach: "Approach" } }],
  ]) {
    const result = await source.execute(name, args, { persist: false });
    assert.ok(states(await exported(source))[name]);
    await source.persist(name, `committed-${name}`, result);
  }
  assert.ok((await refused(source, { maxBytes: 64 })).every((reply) => reply.code === "state-checkpoint-budget"));
  assert.ok((await refused(source, { scope: { ...source.scope(), leafId: "wrong-branch" } })).every((reply) => reply.code === "state-checkpoint-scope"));
  const checkpoints = await exported(source);
  checkpoints.find((entry) => entry.customType === NATIVE_CHECKPOINT_ENTRY && entry.data.provider === "notes").data.state.nextNoteNumber = 1;
  const invalid = await host(t, checkpoints);
  await assert.rejects(() => exported(invalid), /state-checkpoint-corrupt/);
  await assert.rejects(() => invalid.execute("notes", { action: "read", id: "N1" }), /STATE_CORRUPT/);
  assert.equal(states(await exported(source)).notes.nextNoteNumber, 2, "exports are detached from provider state");
  const valid = await exported(source);
  const duplicate = await host(t, [...valid, valid.find((entry) => entry.customType === NATIVE_CHECKPOINT_ENTRY && entry.data.provider === "notes")]);
  await assert.rejects(() => exported(duplicate), /state-checkpoint-corrupt/);

  const root = await fixtureDirectory("checkpoint-prose"), manager = await persistedSession(root);
  manager.appendCustomMessageEntry(NATIVE_CHECKPOINT_ENTRY, "A prose continuation is not native state", false,
    valid.find((entry) => entry.customType === NATIVE_CHECKPOINT_ENTRY && entry.data.provider === "notes").data);
  const prose = new NativeProviderHost(manager, root, { providers: ["notes"] });
  t.after(() => prose.lifecycle("session_shutdown"));
  await prose.lifecycle("session_start");
  assert.equal(states(await exported(prose), 1).notes.notes.length, 0);

  const ephemeral = new NativeProviderHost(SessionManager.inMemory(), await fixtureDirectory("checkpoint-unpersisted"), { providers: ["notes"] });
  t.after(() => ephemeral.lifecycle("session_shutdown"));
  await ephemeral.lifecycle("session_start");
  await assert.rejects(() => ephemeral.execute("notes", { action: "add", body: "Cannot commit without a disk source" }));
  assert.equal(ephemeral.manager.getLeafId(), null, "a refused write must not append an anchor");
});
