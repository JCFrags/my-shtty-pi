import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkplanActivity,
  buildWorkplanSummary,
  validateWorkplanSummary,
  validateWorkplanSummaryRequest,
  WORKPLAN_SUMMARY_CHANGED_EVENT,
  WORKPLAN_SUMMARY_LIMITS,
} from "../../core/src/workplan-summary.ts";

const at = "2026-09-03T00:00:00.000Z";

function milestone(id, title, status, dependsOn = []) {
  return { id, title, status, dependsOn };
}

function checkpoint(id, summary, currentFocus, nextActions) {
  return { id, summary, currentFocus, nextActions, criterionEvidence: [], at };
}

function plan(overrides = {}) {
  return {
    id: "WP1",
    title: "A useful plan",
    objective: "Deliver a bounded projection",
    status: "active",
    revision: 7,
    milestones: [],
    checkpoints: [],
    ...overrides,
  };
}

test("summary selects in-progress, then ready, then blocked milestones in persisted order", () => {
  const summary = buildWorkplanSummary({
    plans: [plan({
      milestones: [
        milestone("WP1-M1", "Blocked first", "blocked"),
        milestone("WP1-M2", "Pending dependency", "pending", ["WP1-M1"]),
        milestone("WP1-M3", "Ready next", "pending"),
        milestone("WP1-M4", "Current work", "in_progress"),
        milestone("WP1-M5", "Completed", "completed"),
      ],
      checkpoints: [checkpoint("WP1-K1", "older", "old focus", ["old action"]), checkpoint("WP1-K2", "latest", "current focus", ["next action"])],
    })],
    nextPlanNumber: 2,
    stateRevision: 9,
  });
  assert.deepEqual(summary.activePlan.currentMilestone, { id: "WP1-M4", title: "Current work", status: "in_progress" });
  assert.deepEqual(summary.activePlan.latestCheckpoint, {
    id: "WP1-K2",
    summary: "latest",
    currentFocus: "current focus",
    nextActions: ["next action"],
    at,
  });

  const ready = buildWorkplanSummary({ plans: [plan({ milestones: [milestone("WP1-M1", "First ready", "pending")] })], nextPlanNumber: 2, stateRevision: 1 });
  assert.equal(ready.activePlan.currentMilestone.id, "WP1-M1");
  const blocked = buildWorkplanSummary({ plans: [plan({ milestones: [milestone("WP1-M1", "Blocked", "blocked")] })], nextPlanNumber: 2, stateRevision: 1 });
  assert.equal(blocked.activePlan.currentMilestone.status, "blocked");
});

test("summary is bounded, normalized, and malformed internal state degrades to empty", () => {
  const summary = buildWorkplanSummary({
    plans: [plan({ title: "  title\nwith\tcontrols  ", objective: "objective\u0000 value", checkpoints: [checkpoint("WP1-K1", "checkpoint", "focus", ["a", "b"]) ] })],
    nextPlanNumber: 2,
    stateRevision: 1,
  });
  assert.equal(summary.activePlan.title, "title with controls");
  assert.equal(summary.activePlan.objective, "objective value");
  assert.ok(Buffer.byteLength(summary.activePlan.title, "utf8") <= WORKPLAN_SUMMARY_LIMITS.titleBytes);
  assert.deepEqual(validateWorkplanSummary(summary), summary);
  assert.deepEqual(buildWorkplanSummary({ plans: [{ ...plan(), objective: "\ud800" }], nextPlanNumber: 2, stateRevision: 1 }), { version: 1 });
});

test("contract validates exact request keys and branch identity", () => {
  const request = validateWorkplanSummaryRequest({ version: 1, requestId: "request-1", branchId: "leaf-1" });
  assert.deepEqual(request, { version: 1, requestId: "request-1", branchId: "leaf-1" });
  assert.throws(() => validateWorkplanSummaryRequest({ version: 1, requestId: "request-1", extra: true }));
  assert.equal(WORKPLAN_SUMMARY_CHANGED_EVENT, "pi-workplan:summary-changed-v1");
});

test("activities are deterministic and limited to authoritative completion/checkpoint events", () => {
  const state = { plans: [plan({ title: "Plan title", milestones: [milestone("WP1-M1", "Finished", "completed")] })], nextPlanNumber: 2, stateRevision: 1 };
  const checkpointEvent = { protocol: "grounded-state-event/v1", tool: "workplan", action: "checkpoint", baseStateRevision: 0, stateRevision: 1, at, data: { planId: "WP1", revision: 8, checkpoint: checkpoint("WP1-K1", "saved checkpoint", "focus", ["one"]) } };
  const checkpointActivity = buildWorkplanActivity(checkpointEvent, state);
  assert.equal(checkpointActivity.type, "checkpoint_recorded");
  assert.equal(checkpointActivity.id, "workplan:WP1:8:checkpoint_recorded");
  assert.deepEqual(buildWorkplanActivity(checkpointEvent, state), checkpointActivity);

  const milestoneEvent = { ...checkpointEvent, action: "update_milestone", data: { planId: "WP1", revision: 9, milestoneId: "WP1-M1", changes: { status: "completed" } } };
  assert.equal(buildWorkplanActivity(milestoneEvent, state).type, "milestone_completed");
  assert.equal(buildWorkplanActivity({ ...milestoneEvent, data: { ...milestoneEvent.data, changes: { status: "blocked" } } }, state), undefined);
});
