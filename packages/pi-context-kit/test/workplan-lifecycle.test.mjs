import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { captureStateTransfer, NATIVE_CHECKPOINT_ENTRY } from "@context-kit/protocol/transfer";
import { validateWorkplanActivity, WORKPLAN_ACTIVITY_EVENT, WORKPLAN_SUMMARY_CHANGED_EVENT,
  WORKPLAN_SUMMARY_EVENT, WORKPLAN_SUMMARY_REQUEST_EVENT } from "@grounded/pi-core/workplan-summary";
import { fixtureDirectory, persistedSession, NativeProviderHost } from "./fixtures/native-providers.mjs";

async function host(t) {
  const root = await fixtureDirectory("workplan-lifecycle");
  const pi = new NativeProviderHost(await persistedSession(root), root, { providers: ["workplan"] });
  t.after(() => pi.lifecycle("session_shutdown"));
  return pi;
}
const execute = (pi, input, persist = true) => pi.execute("workplan", input, { persist });
function activitiesFor(pi) {
  const activities = [];
  pi.events.on(WORKPLAN_ACTIVITY_EVENT, (activity) => {
    validateWorkplanActivity(activity);
    const leaf = pi.manager.getEntry(pi.manager.getLeafId());
    assert.equal(leaf.customType, "context-kit:state-anchor:v1");
    assert.ok(readFileSync(pi.manager.getSessionFile(), "utf8").includes(leaf.id), "activity follows the persisted owner anchor");
    activities.push(activity);
  });
  return activities;
}
async function seedMilestone(pi, acceptanceCriteria) {
  await execute(pi, { action: "create", content: { title: "Plan", objective: "Objective", approach: "Approach", ...(acceptanceCriteria ? { acceptanceCriteria } : {}) } });
  await execute(pi, { action: "resume", planId: "WP1", expectedRevision: 1, rationale: "Start" });
  await execute(pi, { action: "add_milestone", planId: "WP1", expectedRevision: 2, content: { title: "Milestone" } });
  await execute(pi, { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M1", expectedRevision: 3, content: { status: "in_progress" } });
}

test("provider responds with bounded summaries and emits activity after the owned disk commit", async (t) => {
  const pi = await host(t);
  const changes = [], responses = [], activities = activitiesFor(pi);
  pi.events.on(WORKPLAN_SUMMARY_CHANGED_EVENT, (value) => changes.push(value));
  pi.events.on(WORKPLAN_SUMMARY_EVENT, (value) => responses.push(value));
  const branchId = pi.scope().leafId;
  await pi.lifecycle("session_start");
  assert.equal(changes.length, 1);
  assert.deepEqual(activities, []);
  pi.events.emit(WORKPLAN_SUMMARY_REQUEST_EVENT, { version: 1, requestId: "request-1", branchId });
  assert.deepEqual(responses.at(-1), { version: 1, requestId: "request-1", branchId, summary: { version: 1 } });
  await execute(pi, { action: "create", content: { title: "Plan", objective: "Objective", approach: "Approach" } });
  await execute(pi, { action: "resume", planId: "WP1", expectedRevision: 1, rationale: "Start" });
  assert.equal(activities.length, 0);
  const checkpoint = await execute(pi, { action: "checkpoint", planId: "WP1", expectedRevision: 2,
    content: { summary: "Saved", currentFocus: "Focus", nextActions: ["Next"] } }, false);
  assert.deepEqual(activities, [{ version: 1, id: "workplan:WP1:3:checkpoint_recorded", type: "checkpoint_recorded",
    planId: "WP1", title: "Plan", summary: "Saved", currentFocus: "Focus", nextActions: ["Next"], at: checkpoint.details.event.at }]);
  assert.deepEqual(activities[0], checkpoint.details.activity);
  await pi.persist("workplan", "checkpoint", checkpoint);
  await pi.lifecycle("session_tree");
  assert.equal(activities.length, 1, "tool results and restoration do not replay activity");
  assert.ok(changes.length >= 2);
});

test("provider echoes opaque request and real branch identifiers exactly", async (t) => {
  const pi = await host(t), responses = [];
  const branchId = pi.scope().leafId, requestId = " request  1 ";
  pi.events.on(WORKPLAN_SUMMARY_EVENT, (value) => responses.push(value));
  await pi.lifecycle("session_start");
  pi.events.emit(WORKPLAN_SUMMARY_REQUEST_EVENT, { version: 1, requestId, branchId });
  assert.deepEqual(responses.at(-1), { version: 1, requestId, branchId, summary: { version: 1 } });
});

test("provider ignores wrong-branch requests and repeated tool results do not duplicate activity", async (t) => {
  const pi = await host(t), responses = [], activities = activitiesFor(pi);
  pi.events.on(WORKPLAN_SUMMARY_EVENT, (value) => responses.push(value));
  await pi.lifecycle("session_start");
  pi.events.emit(WORKPLAN_SUMMARY_REQUEST_EVENT, { version: 1, requestId: "wrong", branchId: "other" });
  assert.equal(responses.length, 0);
  await execute(pi, { action: "create", content: { title: "Plan", objective: "Objective", approach: "Approach" } });
  const checkpoint = await execute(pi, { action: "checkpoint", planId: "WP1", expectedRevision: 1, content: { summary: "Saved" } }, false);
  assert.equal(activities.length, 1);
  await pi.persist("workplan", "same-result", checkpoint);
  await pi.persist("workplan", "same-result", checkpoint);
  assert.equal(activities.length, 1);
});

test("milestone completion activity follows the real evidence transition exactly once", async (t) => {
  const pi = await host(t), activities = activitiesFor(pi);
  await pi.lifecycle("session_start");
  await seedMilestone(pi);
  const completed = await execute(pi, { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M1", expectedRevision: 4,
    content: { evidence: ["verified"], status: "completed" } }, false);
  assert.deepEqual(activities, [{ version: 1, id: "workplan:WP1:5:milestone_completed", type: "milestone_completed",
    planId: "WP1", milestoneId: "WP1-M1", title: "Milestone", at: completed.details.event.at }]);
  assert.deepEqual(completed.details.activity, activities[0]);
  await pi.persist("workplan", "completed", completed);
  await pi.persist("workplan", "completed", completed);
  assert.equal(activities.length, 1);
  await assert.rejects(() => execute(pi, { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M1",
    expectedRevision: 4, content: { status: "completed" } }));
  for (const content of [{ status: "in_progress" }, { status: "completed" }, { dependsOn: [] }, { evidence: ["verified"] }]) {
    await assert.rejects(() => execute(pi, { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M1",
      expectedRevision: 5, content }), /Only title, description, and linkedTodoIds/);
  }
  const correction = await execute(pi, { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M1", expectedRevision: 5,
    content: { title: "Corrected milestone", description: "Corrected metadata", linkedTodoIds: ["task:release", "T128"] } });
  assert.equal(correction.details.activity, undefined);
  const read = await execute(pi, { action: "read", planId: "WP1" });
  assert.match(read.content[0].text, /Corrected milestone/);
  const transfer = await captureStateTransfer(pi.events, () => pi.scope(), { providers: ["workplan"], waitMs: 3000 });
  const plan = transfer.find((entry) => entry.customType === NATIVE_CHECKPOINT_ENTRY).data.state.plans[0];
  assert.equal(plan.revision, 6);
  assert.deepEqual(plan.milestones[0], { id: "WP1-M1", title: "Corrected milestone", description: "Corrected metadata",
    status: "completed", dependsOn: [], acceptanceCriteria: [], evidence: ["verified"], linkedTodoIds: ["task:release", "T128"],
    createdAt: plan.milestones[0].createdAt, updatedAt: correction.details.event.at });
  assert.equal(plan.revisions[4].action, "update_milestone");
  assert.deepEqual(plan.revisions[5].updatedIds, ["WP1", "WP1-M1"]);
  assert.equal(activities.length, 1, "metadata corrections do not repeat completion");
});

test("plan completion activity requires actual completion and checkpoint evidence", async (t) => {
  const pi = await host(t), activities = activitiesFor(pi);
  await pi.lifecycle("session_start");
  await seedMilestone(pi, ["Criterion"]);
  await execute(pi, { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M1", expectedRevision: 4,
    content: { evidence: ["verified"], status: "completed" } });
  await execute(pi, { action: "checkpoint", planId: "WP1", expectedRevision: 5,
    content: { summary: "Evidence checkpoint", currentFocus: "Done", nextActions: ["Complete"],
      criterionEvidence: [{ criterionId: "WP1-C1", evidence: "Verified" }] } });
  const completed = await execute(pi, { action: "complete", planId: "WP1", expectedRevision: 6, rationale: "All evidence is recorded" }, false);
  assert.equal(activities.length, 3);
  assert.deepEqual(activities[2], { version: 1, id: "workplan:WP1:7:plan_completed", type: "plan_completed",
    planId: "WP1", title: "Plan", at: completed.details.event.at });
  assert.deepEqual(completed.details.activity, activities[2]);
  await pi.persist("workplan", "completed", completed);
  await pi.persist("workplan", "completed", completed);
  assert.equal(activities.length, 3);
});

test("late tool results cannot replay activity across restore or shutdown", async (t) => {
  const pi = await host(t), activities = activitiesFor(pi);
  await pi.lifecycle("session_start");
  await execute(pi, { action: "create", content: { title: "Plan", objective: "Objective", approach: "Approach" } });
  const saved = await execute(pi, { action: "checkpoint", planId: "WP1", expectedRevision: 1, content: { summary: "Saved" } }, false);
  assert.equal(activities.length, 1);
  await pi.lifecycle("session_tree");
  await pi.persist("workplan", "late", saved);
  assert.equal(activities.length, 1);
  await pi.lifecycle("session_shutdown");
  await pi.persist("workplan", "later", saved);
  assert.equal(activities.length, 1);
});
