import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkplanActivity,
  buildWorkplanSummary,
  matchesWorkplanRequest,
  validateWorkplanSummary,
  validateWorkplanSummaryChanged,
  validateWorkplanSummaryRequest,
  validateWorkplanSummaryResponse,
  workplanBranchId,
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

test("opaque request and branch identifiers preserve bytes and reject unsafe input", () => {
  const requestId = " request  1 ";
  const branchId = " branch  A ";
  const request = validateWorkplanSummaryRequest({ version: 1, requestId, branchId });
  assert.equal(request.requestId, requestId);
  assert.equal(request.branchId, branchId);
  assert.equal(workplanBranchId(branchId), branchId);
  assert.equal(workplanBranchId("branch\nA"), "root");

  const response = validateWorkplanSummaryResponse({ version: 1, requestId, branchId, summary: { version: 1 } });
  assert.equal(response.requestId, requestId);
  assert.equal(response.branchId, branchId);
  assert.equal(validateWorkplanSummaryChanged({ version: 1, branchId }).branchId, branchId);
  assert.equal(matchesWorkplanRequest(response, request), true);
  assert.equal(matchesWorkplanRequest({ ...response, requestId: "request  1" }, request), false);
  assert.equal(matchesWorkplanRequest({ ...response, branchId: "branch  A" }, request), false);

  for (const invalidRequestId of ["request\n1", "request\u00001", "\u0000"]) {
    assert.throws(() => validateWorkplanSummaryRequest({ version: 1, requestId: invalidRequestId }));
  }
  for (const invalidBranchId of ["branch\nA", "branch/A", "branch\\A", "branch\u0000A"]) {
    assert.throws(() => validateWorkplanSummaryRequest({ version: 1, requestId: "request-1", branchId: invalidBranchId }));
    assert.equal(workplanBranchId(invalidBranchId), "root");
  }
  assert.equal(validateWorkplanSummaryRequest({ version: 1, requestId: "a".repeat(128) }).requestId, "a".repeat(128));
  assert.throws(() => validateWorkplanSummaryRequest({ version: 1, requestId: "a".repeat(129) }));
  assert.equal(validateWorkplanSummaryRequest({ version: 1, requestId: "é".repeat(64) }).requestId, "é".repeat(64));
  assert.throws(() => validateWorkplanSummaryRequest({ version: 1, requestId: "é".repeat(64) + "a" }));
  assert.equal(validateWorkplanSummaryRequest({ version: 1, requestId: "request-1", branchId: "a".repeat(128) }).branchId, "a".repeat(128));
  assert.throws(() => validateWorkplanSummaryRequest({ version: 1, requestId: "request-1", branchId: "a".repeat(129) }));
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
