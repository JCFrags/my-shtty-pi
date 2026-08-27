import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWorkplanEvent,
  emptyWorkplanState,
  performWorkplanAction,
  renderWorkplan,
  renderWorkplanRecovery,
  type WorkplanState,
} from "@grounded/pi-core/workplan";

let clock = 0;
function run(state: WorkplanState, input: Record<string, unknown>) { return performWorkplanAction(state, input, clock++); }
function create(criteria: string[] = ["criterion one"]): WorkplanState {
  return run(emptyWorkplanState(), { action: "create", content: { title: "Plan", objective: "Objective", approach: "Approach", acceptanceCriteria: criteria } }).state;
}
function mutate(state: WorkplanState, input: Record<string, unknown>): WorkplanState { return run(state, input).state; }

test("workplan supports the complete operation sequence with evidence", () => {
  let state = create();
  assert.equal(state.plans[0]!.status, "draft");
  state = mutate(state, { action: "resume", planId: "WP1", rationale: "start", expectedRevision: 1 });
  state = mutate(state, { action: "add_milestone", planId: "WP1", expectedRevision: 2, content: { title: "First", acceptanceCriteria: ["done"] } });
  state = mutate(state, { action: "add_milestone", planId: "WP1", expectedRevision: 3, content: { title: "Second", dependsOn: ["WP1-M1"] } });
  state = mutate(state, { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M1", expectedRevision: 4, content: { status: "in_progress", linkedTodoIds: ["T2"] } });
  state = mutate(state, { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M1", expectedRevision: 5, content: { evidence: ["verified"], status: "completed" } });
  state = mutate(state, { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M2", expectedRevision: 6, content: { status: "in_progress" } });
  state = mutate(state, { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M2", expectedRevision: 7, content: { evidence: ["verified second"], status: "completed" } });
  state = mutate(state, { action: "record_decision", planId: "WP1", rationale: "because", expectedRevision: 8, content: { decision: "Use exact events" } });
  state = mutate(state, { action: "record_risk", planId: "WP1", expectedRevision: 9, content: { description: "Risk", impact: "Impact", mitigation: "Mitigation" } });
  state = mutate(state, { action: "record_question", planId: "WP1", expectedRevision: 10, content: { question: "Question", status: "resolved", answer: "Answer" } });
  state = mutate(state, { action: "checkpoint", planId: "WP1", expectedRevision: 11, content: { summary: "Checked", criterionEvidence: [{ criterionId: "WP1-C1", evidence: "proof" }] } });
  state = mutate(state, { action: "pause", planId: "WP1", rationale: "pause", expectedRevision: 12 });
  state = mutate(state, { action: "complete", planId: "WP1", rationale: "complete", expectedRevision: 13 });
  state = mutate(state, { action: "archive", planId: "WP1", rationale: "archive", expectedRevision: 14 });
  const plan = state.plans[0]!;
  assert.equal(plan.status, "archived");
  assert.equal(plan.revisions.length, plan.revision);
  assert.equal(plan.revisions[0]!.action, "create");
  assert.equal(plan.revisions.at(-1)!.action, "archive");
  assert.ok(plan.revisions.every((record) => /^[0-9a-f]{64}$/.test(record.beforeDigest) && /^[0-9a-f]{64}$/.test(record.afterDigest)));
  const status = run(state, { action: "status", planId: "WP1" }).result as any;
  assert.deepEqual(status.milestones, { completed: 2, total: 2 });
  assert.equal(status.linkedTodoIds, 1);
  const list = run(state, { action: "list" }).result as any[];
  assert.deepEqual(Object.keys(list[0]!), ["id", "title", "status", "revision", "updatedAt"]);
});

test("workplan revise preserves stable IDs, records exact changes, and never reuses removed IDs", () => {
  let state = create(["one", "two"]);
  state = mutate(state, { action: "revise", planId: "WP1", section: "acceptance_criteria", expectedRevision: 1, rationale: "replace", content: [{ id: "WP1-C1", text: "one changed" }, { text: "three" }] });
  let plan = state.plans[0]!;
  assert.deepEqual(plan.acceptanceCriteria.map((item) => item.id), ["WP1-C1", "WP1-C3"]);
  assert.deepEqual(plan.revisions[1]!.addedIds, ["WP1-C3"]);
  assert.deepEqual(plan.revisions[1]!.updatedIds, ["WP1-C1"]);
  assert.deepEqual(plan.revisions[1]!.removedIds, ["WP1-C2"]);
  state = mutate(state, { action: "revise", planId: "WP1", section: "acceptance_criteria", expectedRevision: 2, rationale: "add", content: [{ id: "WP1-C1", text: "one changed" }, { id: "WP1-C3", text: "three" }, { text: "four" }] });
  plan = state.plans[0]!;
  assert.equal(plan.acceptanceCriteria.at(-1)!.id, "WP1-C4");
  assert.equal(plan.nextCriterionNumber, 5);
  assert.equal(plan.revisions[0]!.rationale, "Explicit create operation");
});

test("risk and question replacement preserve IDs and reject wrong or duplicate IDs", () => {
  let state = create([]);
  state = mutate(state, { action: "record_risk", planId: "WP1", expectedRevision: 1, content: { description: "r", impact: "i", mitigation: "m" } });
  state = mutate(state, { action: "record_question", planId: "WP1", expectedRevision: 2, content: { question: "q" } });
  state = mutate(state, { action: "revise", planId: "WP1", section: "risks", expectedRevision: 3, rationale: "risk edit", content: [{ id: "WP1-R1", description: "r2", impact: "i", mitigation: "m", status: "accepted" }, { description: "new", impact: "i", mitigation: "m" }] });
  state = mutate(state, { action: "revise", planId: "WP1", section: "open_questions", expectedRevision: 4, rationale: "question edit", content: [{ id: "WP1-Q1", question: "q", status: "resolved", answer: "a" }, { question: "new" }] });
  assert.deepEqual(state.plans[0]!.risks.map((item) => item.id), ["WP1-R1", "WP1-R2"]);
  assert.deepEqual(state.plans[0]!.openQuestions.map((item) => item.id), ["WP1-Q1", "WP1-Q2"]);
  assert.throws(() => run(state, { action: "revise", planId: "WP1", section: "risks", expectedRevision: 5, rationale: "bad", content: [{ id: "WP1-Q1", description: "r", impact: "i", mitigation: "m" }] }), /STATE_INVALID_LINK/);
});

test("risk and question IDs remain monotonic after section removal", () => {
  let state = create([]);
  state = mutate(state, { action: "record_risk", planId: "WP1", expectedRevision: 1, content: { description: "old risk", impact: "impact", mitigation: "mitigation" } });
  state = mutate(state, { action: "record_question", planId: "WP1", expectedRevision: 2, content: { question: "old question" } });
  state = mutate(state, { action: "revise", planId: "WP1", section: "risks", expectedRevision: 3, rationale: "remove risk", content: [] });
  state = mutate(state, { action: "revise", planId: "WP1", section: "open_questions", expectedRevision: 4, rationale: "remove question", content: [] });
  state = mutate(state, { action: "record_risk", planId: "WP1", expectedRevision: 5, content: { description: "new risk", impact: "impact", mitigation: "mitigation" } });
  state = mutate(state, { action: "record_question", planId: "WP1", expectedRevision: 6, content: { question: "new question" } });
  assert.equal(state.plans[0]!.risks[0]!.id, "WP1-R2");
  assert.equal(state.plans[0]!.openQuestions[0]!.id, "WP1-Q2");
  assert.equal(state.plans[0]!.nextRiskNumber, 3);
  assert.equal(state.plans[0]!.nextQuestionNumber, 3);
});

test("workplan enforces one active plan and exact plan transitions", () => {
  let state = create([]);
  state = mutate(state, { action: "create", content: { title: "Two", objective: "O", approach: "A" } });
  state = mutate(state, { action: "resume", planId: "WP1", rationale: "start", expectedRevision: 1 });
  assert.throws(() => run(state, { action: "resume", planId: "WP2", rationale: "start", expectedRevision: 1 }), /STATE_CONFLICT/);
  assert.throws(() => run(state, { action: "archive", planId: "WP1", rationale: "bad", expectedRevision: 2 }), /STATE_INVALID_TRANSITION/);
  state = mutate(state, { action: "pause", planId: "WP1", rationale: "pause", expectedRevision: 2 });
  state = mutate(state, { action: "resume", planId: "WP2", rationale: "start", expectedRevision: 1 });
  assert.equal(state.plans.find((plan) => plan.id === "WP2")!.status, "active");
});

test("milestone dependency, transition, cycle, and evidence rules are exact", () => {
  let state = create([]);
  state = mutate(state, { action: "add_milestone", planId: "WP1", expectedRevision: 1, content: { title: "one" } });
  state = mutate(state, { action: "add_milestone", planId: "WP1", expectedRevision: 2, content: { title: "two", dependsOn: ["WP1-M1"] } });
  assert.throws(() => run(state, { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M2", expectedRevision: 3, content: { status: "in_progress" } }), /STATE_INVALID_LINK/);
  assert.throws(() => run(state, { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M1", expectedRevision: 3, content: { dependsOn: ["WP1-M2"] } }), /STATE_INVALID_LINK/);
  assert.throws(() => run(state, { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M1", expectedRevision: 3, content: { status: "completed" } }), /STATE_INVALID_TRANSITION/);
  state = mutate(state, { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M1", expectedRevision: 3, content: { status: "in_progress" } });
  assert.throws(() => run(state, { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M1", expectedRevision: 4, content: { status: "completed" } }), /STATE_EVIDENCE_REQUIRED/);
  state = mutate(state, { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M1", expectedRevision: 4, content: { status: "blocked" } });
  state = mutate(state, { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M1", expectedRevision: 5, content: { status: "in_progress" } });
  state = mutate(state, { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M1", expectedRevision: 6, content: { evidence: ["proof"], status: "completed" } });
  assert.throws(() => run(state, { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M1", expectedRevision: 7, content: { title: "edit terminal" } }), /STATE_INVALID_TRANSITION/);
});

test("every permitted and forbidden milestone transition follows the exact matrix", () => {
  const statuses = ["pending", "in_progress", "blocked", "completed"] as const;
  const permitted = new Set([
    "pending->in_progress",
    "in_progress->blocked",
    "in_progress->completed",
    "blocked->in_progress",
    "blocked->completed",
  ]);
  for (const from of statuses) {
    for (const to of statuses) {
      let state = create([]);
      state = mutate(state, { action: "add_milestone", planId: "WP1", expectedRevision: 1, content: { title: "milestone" } });
      const milestone = state.plans[0]!.milestones[0]!;
      milestone.status = from;
      milestone.evidence = from === "completed" ? ["existing evidence"] : [];
      const before = structuredClone(state);
      const input = {
        action: "update_milestone",
        planId: "WP1",
        milestoneId: "WP1-M1",
        expectedRevision: 2,
        content: to === "completed" ? { status: to, evidence: ["completion evidence"] } : { status: to },
      };
      if (permitted.has(`${from}->${to}`)) {
        state = run(state, input).state;
        assert.equal(state.plans[0]!.milestones[0]!.status, to, `${from} -> ${to}`);
      } else {
        assert.throws(() => run(state, input), /STATE_INVALID_TRANSITION/, `${from} -> ${to}`);
        assert.deepEqual(state, before, `${from} -> ${to}`);
      }
    }
  }
});

test("workplan recovery returns durable orientation without mutating state", () => {
  let state = run(emptyWorkplanState(), { action: "create", content: {
    title: "Long project", objective: "Deliver the user-approved system", approach: "Preserve the durable design",
    scope: ["Core behavior"], nonGoals: ["Unrelated cleanup"], constraints: ["Keep rollback"], acceptanceCriteria: ["Works after compaction"], verification: ["Run recovery test"],
  } }).state;
  state = mutate(state, { action: "add_milestone", planId: "WP1", expectedRevision: 1, content: { title: "Implement recovery", description: "Return the current position" } });
  state = mutate(state, { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M1", expectedRevision: 2, content: { status: "in_progress", evidence: ["design approved"] } });
  state = mutate(state, { action: "record_decision", planId: "WP1", expectedRevision: 3, rationale: "Avoid stale summaries", content: { decision: "Recover from event-sourced state" } });
  state = mutate(state, { action: "record_risk", planId: "WP1", expectedRevision: 4, content: { description: "Context loss", impact: "Drift", mitigation: "Call recover" } });
  state = mutate(state, { action: "record_question", planId: "WP1", expectedRevision: 5, content: { question: "Is recovery current?" } });
  state = mutate(state, { action: "checkpoint", planId: "WP1", expectedRevision: 6, content: { summary: "Design complete", currentFocus: "Implement the bounded recovery view", nextActions: ["Add extension tests", "Run typecheck"] } });
  const before = structuredClone(state);
  const operation = run(state, { action: "recover", planId: "WP1" });
  assert.deepEqual(operation.state, before);
  assert.equal(operation.event, undefined);
  const recovery = operation.result as string;
  for (const expected of ["Deliver the user-approved system", "Keep rollback", "Design complete", "Implement the bounded recovery view", "Add extension tests", "Recover from event-sourced state", "Context loss", "Is recovery current?"]) assert.match(recovery, new RegExp(expected));
  assert.doesNotMatch(recovery, /## Revisions/);
  assert.equal(renderWorkplanRecovery(state.plans[0]!), recovery);
  assert.match(renderWorkplan(state.plans[0]!), /Current focus: Implement the bounded recovery view/);
  assert.match(renderWorkplan(state.plans[0]!), /Next actions:\n- Add extension tests/);
  const changed = mutate(state, { action: "record_decision", planId: "WP1", expectedRevision: 7, rationale: "advance", content: { decision: "Checkpoint is now historical" } });
  const changedRecovery = run(changed, { action: "recover", planId: "WP1" }).result as string;
  assert.match(changedRecovery, /WP1-K1 at revision 7 \(plan changed afterward\)/);
  assert.match(changedRecovery, /## Next actions\n- WP1-M1: Implement recovery/);
  assert.doesNotMatch(changedRecovery, /Current focus: Implement the bounded recovery view/);
});

test("completed and archived plans do not consume the open-plan limit", () => {
  let state = emptyWorkplanState();
  for (let index = 1; index <= 20; index++) {
    state = mutate(state, { action: "create", content: { title: `Plan ${index}`, objective: "Objective", approach: "Approach" } });
    state = mutate(state, { action: "archive", planId: `WP${index}`, expectedRevision: 1, rationale: "Retain completed history" });
  }
  assert.equal(state.plans.length, 20);
  assert.ok(state.plans.every((plan) => plan.status === "archived"));
  for (let index = 21; index <= 36; index++) state = mutate(state, { action: "create", content: { title: `Plan ${index}`, objective: "Objective", approach: "Approach" } });
  assert.throws(() => run(state, { action: "create", content: { title: "Plan 37", objective: "Objective", approach: "Approach" } }), /at most 16 open workplans/);
});

test("canonical revise sections are recorded while legacy event sections still replay", () => {
  let state = create([]);
  const operation = run(state, { action: "revise", planId: "WP1", section: "nonGoals", expectedRevision: 1, rationale: "canonical", content: ["Do not drift"] });
  assert.equal(operation.state.plans[0]!.revisions.at(-1)!.section, "nonGoals");
  assert.deepEqual(operation.state.plans[0]!.nonGoals, ["Do not drift"]);
  const legacyEvent = structuredClone(operation.event!);
  (legacyEvent.data as any).section = "non_goals";
  (legacyEvent.data as any).revisionRecord.section = "non_goals";
  assert.deepEqual(applyWorkplanEvent(state, legacyEvent), {
    ...operation.state,
    plans: operation.state.plans.map((plan) => ({ ...plan, revisions: plan.revisions.map((record, index) => index === plan.revisions.length - 1 ? { ...record, section: "non_goals" } : record) })),
  });
});

test("workplan create rejects a non-string background without coercion", () => {
  assert.throws(
    () => run(emptyWorkplanState(), { action: "create", content: { title: "Plan", objective: "Objective", background: 42, approach: "Approach" } }),
    /STATE_INVALID_INPUT: background must be a string/,
  );
});

test("safe workplan errors omit stored and supplied prose", () => {
  const state = run(emptyWorkplanState(), { action: "create", content: { title: "stored-private-title", objective: "stored-private-objective", approach: "stored-private-approach" } }).state;
  const before = structuredClone(state);
  let text = "";
  assert.throws(
    () => run(state, { action: "record_risk", planId: "WP1", expectedRevision: 1, content: { description: "supplied-private-prose", impact: "impact", mitigation: "mitigation", unknown: true } }),
    (error: unknown) => {
      text = String(error);
      return true;
    },
  );
  for (const prose of ["stored-private-title", "stored-private-objective", "stored-private-approach", "supplied-private-prose"]) {
    assert.equal(text.includes(prose), false);
  }
  assert.deepEqual(state, before);
});

test("workplan rejects unknown action fields and nested fields transactionally", () => {
  const state = create([]); const before = structuredClone(state);
  for (const input of [
    { action: "create", planId: "WP1", content: { title: "x", objective: "x", approach: "x" } },
    { action: "add_milestone", planId: "WP1", expectedRevision: 1, content: { title: "x", unknown: true } },
    { action: "record_risk", planId: "WP1", expectedRevision: 1, content: { description: "secret prose", impact: "i", mitigation: "m", unknown: true } },
    { action: "revise", planId: "WP1", section: "title", expectedRevision: 9, rationale: "x", content: "x" },
  ]) assert.throws(() => run(state, input));
  assert.deepEqual(state, before);
});

test("checkpoint evidence blocks criterion removal and plan completion without evidence", () => {
  let state = create(["criterion"]);
  state = mutate(state, { action: "checkpoint", planId: "WP1", expectedRevision: 1, content: { summary: "s", criterionEvidence: [{ criterionId: "WP1-C1", evidence: "proof" }] } });
  assert.throws(() => run(state, { action: "revise", planId: "WP1", section: "acceptance_criteria", expectedRevision: 2, rationale: "remove", content: [] }), /STATE_INVALID_LINK/);
  let noEvidence = create(["criterion"]);
  noEvidence = mutate(noEvidence, { action: "resume", planId: "WP1", rationale: "start", expectedRevision: 1 });
  assert.throws(() => run(noEvidence, { action: "complete", planId: "WP1", rationale: "done", expectedRevision: 2 }), /STATE_EVIDENCE_REQUIRED/);
});

test("complete workplan Markdown golden fixture is byte-exact, LF-only, and indents every multiline continuation", () => {
  const at = "2026-08-01T00:00:00.000Z";
  const fixture = {
    id: "WP1",
    title: "Title first\nTitle second",
    objective: "Objective first\nObjective second",
    background: "Background first\nBackground second",
    scope: ["Scope first\nScope second"],
    nonGoals: ["Non-goal first\nNon-goal second"],
    constraints: ["Constraint first\nConstraint second"],
    approach: "Approach first\nApproach second",
    milestones: [{
      id: "WP1-M1", title: "Milestone first\nMilestone second", description: "Description first\nDescription second",
      dependsOn: [], acceptanceCriteria: ["Milestone criterion first\nMilestone criterion second"], status: "in_progress",
      evidence: ["Milestone evidence first\nMilestone evidence second"], linkedTodoIds: ["T1"], createdAt: at, updatedAt: at,
    }],
    acceptanceCriteria: [{ id: "WP1-C1", text: "Plan criterion first\nPlan criterion second" }],
    verification: ["Verification first\nVerification second"],
    risks: [{ id: "WP1-R1", description: "Risk first\nRisk second", impact: "Impact first\nImpact second", mitigation: "Mitigation first\nMitigation second", status: "open" }],
    openQuestions: [{ id: "WP1-Q1", question: "Question first\nQuestion second", status: "resolved", answer: "Answer first\nAnswer second" }],
    decisions: [{ id: "WP1-D1", decision: "Decision first\nDecision second", rationale: "Decision reason first\nDecision reason second", at }],
    checkpoints: [{ id: "WP1-K1", summary: "Summary first\nSummary second", criterionEvidence: [{ criterionId: "WP1-C1", evidence: "Criterion evidence first\nCriterion evidence second" }], at }],
    revisions: [{
      planRevision: 1, action: "create", addedIds: ["WP1", "WP1-C1"], updatedIds: [], removedIds: [],
      beforeDigest: "a".repeat(64), afterDigest: "b".repeat(64), rationale: "Revision reason first\nRevision reason second", actor: "tool", at,
    }],
    status: "active", revision: 1, createdAt: at, updatedAt: at,
    nextMilestoneNumber: 2, nextCriterionNumber: 2, nextDecisionNumber: 2, nextRiskNumber: 2, nextQuestionNumber: 2, nextCheckpointNumber: 2,
  } as any;
  const golden = `# WP1: Title first
  Title second
Status: active
Revision: 1
Created: 2026-08-01T00:00:00.000Z
Updated: 2026-08-01T00:00:00.000Z

## Objective
Objective first
  Objective second

## Background
Background first
  Background second

## Scope
- Scope first
  Scope second

## Non-goals
- Non-goal first
  Non-goal second

## Constraints
- Constraint first
  Constraint second

## Approach
Approach first
  Approach second

## Milestones
### WP1-M1: Milestone first
  Milestone second
Status: in_progress
Description: Description first
  Description second
Depends on: None
Acceptance criteria:
- Milestone criterion first
  Milestone criterion second
Evidence:
- Milestone evidence first
  Milestone evidence second
Linked todo IDs (unverified external references): T1
Created: 2026-08-01T00:00:00.000Z
Updated: 2026-08-01T00:00:00.000Z

## Acceptance criteria
### WP1-C1
Plan criterion first
  Plan criterion second
Evidence:
- WP1-K1: Criterion evidence first
  Criterion evidence second

## Verification
- Verification first
  Verification second

## Risks
### WP1-R1
Status: open
Description: Risk first
  Risk second
Impact: Impact first
  Impact second
Mitigation: Mitigation first
  Mitigation second

## Open questions
### WP1-Q1
Status: resolved
Question: Question first
  Question second
Answer: Answer first
  Answer second

## Decisions
### WP1-D1
Decision: Decision first
  Decision second
Rationale: Decision reason first
  Decision reason second
At: 2026-08-01T00:00:00.000Z

## Checkpoints
### WP1-K1
Summary: Summary first
  Summary second
Criterion evidence:
- WP1-C1: Criterion evidence first
  Criterion evidence second
At: 2026-08-01T00:00:00.000Z

## Revisions
### Revision 1
Action: create
Section: None
Added IDs: WP1, WP1-C1
Updated IDs: None
Removed IDs: None
Before SHA-256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
After SHA-256: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
Rationale: Revision reason first
  Revision reason second
Actor: tool
At: 2026-08-01T00:00:00.000Z
`;
  const rendered = renderWorkplan(fixture);
  assert.equal(rendered, golden);
  assert.equal(Buffer.compare(Buffer.from(rendered), Buffer.from(golden)), 0);
  assert.equal(rendered.includes("\r"), false);
  assert.equal(rendered.endsWith("\n"), true);
  assert.equal(rendered.endsWith("\n\n"), false);
});

test("workplan events replay exactly and reject skipped or altered revisions", () => {
  const operation = run(emptyWorkplanState(), { action: "create", content: { title: "Plan", objective: "Objective", approach: "Approach" } });
  assert.deepEqual(applyWorkplanEvent(emptyWorkplanState(), operation.event), operation.state);
  const changed = structuredClone(operation.event!); changed.stateRevision = 2;
  assert.throws(() => applyWorkplanEvent(emptyWorkplanState(), changed), /STATE_CORRUPT/);
  const altered = structuredClone(operation.event!); (altered.data.plan as { title: string }).title = "altered prose";
  assert.throws(() => applyWorkplanEvent(emptyWorkplanState(), altered), /STATE_CORRUPT/);
});
