import assert from "node:assert/strict";
import test from "node:test";

import groundedWorkplan from "../index.ts";
import {
  validateWorkplanActivity,
  WORKPLAN_ACTIVITY_EVENT,
  WORKPLAN_SUMMARY_CHANGED_EVENT,
  WORKPLAN_SUMMARY_EVENT,
  WORKPLAN_SUMMARY_REQUEST_EVENT,
} from "../../core/src/workplan-summary.ts";

class EventBus {
  #listeners = new Map();

  on(channel, handler) {
    const listeners = this.#listeners.get(channel) ?? new Set();
    listeners.add(handler);
    this.#listeners.set(channel, listeners);
    return () => listeners.delete(handler);
  }

  emit(channel, value) {
    for (const handler of [...(this.#listeners.get(channel) ?? [])]) handler(value);
  }
}

class FakePi {
  events = new EventBus();
  #handlers = new Map();
  tool;

  on(event, handler) {
    const handlers = this.#handlers.get(event) ?? [];
    handlers.push(handler);
    this.#handlers.set(event, handlers);
  }

  registerTool(tool) {
    this.tool = tool;
  }

  async emitLifecycle(event, value, ctx = context()) {
    for (const handler of this.#handlers.get(event) ?? []) await handler(value, ctx);
  }
}

function context(branch = []) {
  return {
    sessionManager: {
      getLeafId: () => null,
      getBranch: () => branch,
    },
  };
}

function messageEnd(details) {
  return { message: { role: "toolResult", toolName: "workplan", details } };
}

function signal() {
  return new AbortController().signal;
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function executePersisted(pi, input, persist = true) {
  const result = await pi.tool.execute(input.action, input, signal());
  if (persist) {
    await pi.emitLifecycle("message_end", messageEnd(result.details));
    await nextTick();
  }
  return result;
}

test("provider responds with a bounded summary and emits activity only after message persistence", async () => {
  const pi = new FakePi();
  groundedWorkplan(pi);
  const changes = [];
  const activities = [];
  const responses = [];
  pi.events.on(WORKPLAN_SUMMARY_CHANGED_EVENT, (value) => changes.push(value));
  pi.events.on(WORKPLAN_ACTIVITY_EVENT, (value) => activities.push(value));
  pi.events.on(WORKPLAN_SUMMARY_EVENT, (value) => responses.push(value));

  await pi.emitLifecycle("session_start", { type: "session_start" }, context());
  assert.equal(changes.length, 1);
  assert.deepEqual(activities, []);

  pi.events.emit(WORKPLAN_SUMMARY_REQUEST_EVENT, { version: 1, requestId: "request-1", branchId: "root" });
  assert.deepEqual(responses.at(-1), {
    version: 1,
    requestId: "request-1",
    branchId: "root",
    summary: { version: 1 },
  });

  const created = await pi.tool.execute("create", {
    action: "create",
    content: { title: "Plan", objective: "Objective", approach: "Approach" },
  }, signal());
  assert.equal(activities.length, 0);
  await pi.emitLifecycle("message_end", messageEnd(created.details));
  await nextTick();
  assert.equal(activities.length, 0);

  const resumed = await pi.tool.execute("resume", {
    action: "resume",
    planId: "WP1",
    expectedRevision: 1,
    rationale: "Start the plan",
  }, signal());
  await pi.emitLifecycle("message_end", messageEnd(resumed.details));
  await nextTick();
  assert.equal(activities.length, 0);

  const checkpoint = await pi.tool.execute("checkpoint", {
    action: "checkpoint",
    planId: "WP1",
    expectedRevision: 2,
    content: { summary: "Saved", currentFocus: "Focus", nextActions: ["Next"] },
  }, signal());
  assert.equal(activities.length, 0);
  await pi.emitLifecycle("message_end", messageEnd(checkpoint.details));
  assert.equal(activities.length, 0);
  await nextTick();
  assert.deepEqual(activities, [{
    version: 1,
    id: "workplan:WP1:3:checkpoint_recorded",
    type: "checkpoint_recorded",
    planId: "WP1",
    title: "Plan",
    summary: "Saved",
    currentFocus: "Focus",
    nextActions: ["Next"],
    at: checkpoint.details.event.at,
  }]);

  const activityCount = activities.length;
  await pi.emitLifecycle("session_tree", { type: "session_tree" }, context());
  await nextTick();
  assert.equal(activities.length, activityCount);
  assert.ok(changes.length >= 2);
});

test("provider ignores wrong-branch summary requests and repeated persistence does not duplicate activity", async () => {
  const pi = new FakePi();
  groundedWorkplan(pi);
  const activities = [];
  pi.events.on(WORKPLAN_ACTIVITY_EVENT, (value) => activities.push(value));
  await pi.emitLifecycle("session_start", { type: "session_start" }, context());

  const responses = [];
  pi.events.on(WORKPLAN_SUMMARY_EVENT, (value) => responses.push(value));
  pi.events.emit(WORKPLAN_SUMMARY_REQUEST_EVENT, { version: 1, requestId: "wrong", branchId: "other" });
  assert.equal(responses.length, 0);

  const created = await pi.tool.execute("create", {
    action: "create",
    content: { title: "Plan", objective: "Objective", approach: "Approach" },
  }, signal());
  const end = messageEnd(created.details);
  await pi.emitLifecycle("message_end", end);
  await pi.emitLifecycle("message_end", end);
  await nextTick();
  assert.deepEqual(activities, []);
});

test("milestone completion activity follows the real evidence transition exactly once", async () => {
  const pi = new FakePi();
  groundedWorkplan(pi);
  const activities = [];
  pi.events.on(WORKPLAN_ACTIVITY_EVENT, (value) => activities.push(value));
  await pi.emitLifecycle("session_start", { type: "session_start" }, context());

  await executePersisted(pi, { action: "create", content: { title: "Plan", objective: "Objective", approach: "Approach" } });
  await executePersisted(pi, { action: "resume", planId: "WP1", expectedRevision: 1, rationale: "Start" });
  await executePersisted(pi, { action: "add_milestone", planId: "WP1", expectedRevision: 2, content: { title: "Milestone" } });
  await executePersisted(pi, {
    action: "update_milestone",
    planId: "WP1",
    milestoneId: "WP1-M1",
    expectedRevision: 3,
    content: { status: "in_progress" },
  });
  const completed = await executePersisted(pi, {
    action: "update_milestone",
    planId: "WP1",
    milestoneId: "WP1-M1",
    expectedRevision: 4,
    content: { evidence: ["verified"], status: "completed" },
  }, false);
  assert.equal(activities.length, 0);
  const end = messageEnd(completed.details);
  await pi.emitLifecycle("message_end", end);
  assert.equal(activities.length, 0);
  await nextTick();
  assert.equal(activities.length, 1);
  assert.deepEqual(activities[0], {
    version: 1,
    id: "workplan:WP1:5:milestone_completed",
    type: "milestone_completed",
    planId: "WP1",
    milestoneId: "WP1-M1",
    title: "Milestone",
    at: completed.details.event.at,
  });
  assert.deepEqual(validateWorkplanActivity(activities[0]), activities[0]);
  await pi.emitLifecycle("message_end", end);
  await nextTick();
  assert.equal(activities.length, 1);

  await assert.rejects(() => pi.tool.execute("invalid", {
    action: "update_milestone",
    planId: "WP1",
    milestoneId: "WP1-M1",
    expectedRevision: 4,
    content: { status: "completed" },
  }, signal()));
  assert.equal(activities.length, 1);
});

test("plan completion activity requires actual completion and checkpoint evidence", async () => {
  const pi = new FakePi();
  groundedWorkplan(pi);
  const activities = [];
  pi.events.on(WORKPLAN_ACTIVITY_EVENT, (value) => activities.push(value));
  await pi.emitLifecycle("session_start", { type: "session_start" }, context());

  await executePersisted(pi, { action: "create", content: { title: "Completable", objective: "Objective", approach: "Approach", acceptanceCriteria: ["Criterion"] } });
  await executePersisted(pi, { action: "resume", planId: "WP1", expectedRevision: 1, rationale: "Start" });
  await executePersisted(pi, { action: "add_milestone", planId: "WP1", expectedRevision: 2, content: { title: "Milestone" } });
  await executePersisted(pi, {
    action: "update_milestone",
    planId: "WP1",
    milestoneId: "WP1-M1",
    expectedRevision: 3,
    content: { status: "in_progress" },
  });
  await executePersisted(pi, {
    action: "update_milestone",
    planId: "WP1",
    milestoneId: "WP1-M1",
    expectedRevision: 4,
    content: { evidence: ["verified"], status: "completed" },
  });
  await executePersisted(pi, {
    action: "checkpoint",
    planId: "WP1",
    expectedRevision: 5,
    content: { summary: "Evidence checkpoint", currentFocus: "Done", nextActions: ["Complete"], criterionEvidence: [{ criterionId: "WP1-C1", evidence: "Verified" }] },
  });
  const completed = await executePersisted(pi, { action: "complete", planId: "WP1", expectedRevision: 6, rationale: "All evidence is recorded" }, false);
  assert.equal(activities.length, 2);
  const end = messageEnd(completed.details);
  await pi.emitLifecycle("message_end", end);
  assert.equal(activities.length, 2);
  await nextTick();
  assert.equal(activities.length, 3);
  assert.deepEqual(activities[2], {
    version: 1,
    id: "workplan:WP1:7:plan_completed",
    type: "plan_completed",
    planId: "WP1",
    title: "Completable",
    at: completed.details.event.at,
  });
  assert.deepEqual(validateWorkplanActivity(activities[2]), activities[2]);
  await pi.emitLifecycle("message_end", end);
  await nextTick();
  assert.equal(activities.length, 3);
});

test("pending activity cannot cross shutdown or replay restore", async () => {
  const pi = new FakePi();
  groundedWorkplan(pi);
  const activities = [];
  pi.events.on(WORKPLAN_ACTIVITY_EVENT, (value) => activities.push(value));
  await pi.emitLifecycle("session_start", { type: "session_start" }, context());
  const created = await executePersisted(pi, { action: "create", content: { title: "Plan", objective: "Objective", approach: "Approach" } }, false);
  assert.equal(activities.length, 0);
  await pi.emitLifecycle("session_tree", { type: "session_tree" }, context());
  await pi.emitLifecycle("message_end", messageEnd(created.details), context());
  await nextTick();
  assert.equal(activities.length, 0);

  await pi.emitLifecycle("session_start", { type: "session_start" }, context());
  const reloaded = await executePersisted(pi, { action: "create", content: { title: "Reloaded", objective: "Objective", approach: "Approach" } }, false);
  await pi.emitLifecycle("session_shutdown", { type: "session_shutdown" }, context());
  await pi.emitLifecycle("message_end", messageEnd(reloaded.details), context());
  await nextTick();
  assert.equal(activities.length, 0);
});
