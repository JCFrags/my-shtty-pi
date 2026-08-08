import assert from "node:assert/strict";
import test from "node:test";
import {
  addTask,
  clearDone,
  completeTask,
  emptyTaskState,
  startTask,
  updateTask,
  validateTaskState,
} from "@grounded/pi-core/tasks";

test("task dependencies block, unblock, and enforce one current task", () => {
  const state = emptyTaskState();
  const first = addTask(state, { text: "first" }, 1);
  const second = addTask(state, { text: "second", blockedBy: [first.id] }, 2);
  assert.equal(second.status, "blocked");
  assert.throws(() => startTask(state, second.id), /blocked/);
  completeTask(state, first.id, 3);
  assert.equal(second.status, "pending");
  startTask(state, second.id, 4);
  assert.equal(second.status, "in_progress");
});

test("cycles and unknown blockers fail without corrupting state", () => {
  const state = emptyTaskState();
  const first = addTask(state, { text: "first" });
  const second = addTask(state, { text: "second", blockedBy: [first.id] });
  assert.throws(() => updateTask(state, first.id, { blockedBy: [second.id] }), /cycle/);
  assert.deepEqual(first.blockedBy, []);
  const nextId = state.nextId;
  assert.throws(() => addTask(state, { text: "bad", blockedBy: ["missing"] }), /unknown blocker/);
  assert.equal(state.tasks.length, 2);
  assert.equal(state.nextId, nextId);
  validateTaskState(state);
});

test("explicit generated-style ids advance nextId and blockers demote active work", () => {
  const state = emptyTaskState();
  const explicit = addTask(state, { id: "T7", text: "explicit" });
  const generated = addTask(state, { text: "generated" });
  assert.equal(generated.id, "T8");
  startTask(state, generated.id);
  updateTask(state, generated.id, { blockedBy: [explicit.id] });
  assert.equal(generated.status, "blocked");
  assert.throws(() => completeTask(state, generated.id), /blocked/);
});

test("clearing completed tasks removes satisfied references", () => {
  const state = emptyTaskState();
  const first = addTask(state, { text: "first" });
  const second = addTask(state, { text: "second", blockedBy: [first.id] });
  completeTask(state, first.id);
  assert.equal(clearDone(state), 1);
  assert.deepEqual(second.blockedBy, []);
});
