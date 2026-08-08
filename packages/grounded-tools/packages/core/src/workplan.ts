import { createHash } from "node:crypto";
import {
  cloneJson,
  compareNumericIds,
  makeStateEvent,
  normalizeStateText,
  requireCodePoints,
  requireExactObject,
  requireNonBlank,
  requirePlainJson,
  requireSafeInteger,
  requireString,
  requireStringArray,
  requireUnique,
  requireUtf8,
  stableJson,
  stateError,
  type StateEvent,
  type StateErrorCode,
  validateStateEventEnvelope,
} from "./state.ts";

export type WorkplanStatus = "draft" | "active" | "paused" | "completed" | "archived";
export type MilestoneStatus = "pending" | "in_progress" | "blocked" | "completed";
export type RiskStatus = "open" | "mitigated" | "accepted";
export type QuestionStatus = "open" | "resolved";

export interface PlanCriterion { id: string; text: string }
export interface Milestone {
  id: string;
  title: string;
  description?: string;
  dependsOn: string[];
  acceptanceCriteria: string[];
  status: MilestoneStatus;
  evidence: string[];
  linkedTodoIds: string[];
  createdAt: string;
  updatedAt: string;
}
export interface Decision { id: string; decision: string; rationale: string; at: string }
export interface Risk { id: string; description: string; impact: string; mitigation: string; status: RiskStatus }
export interface Question { id: string; question: string; status: QuestionStatus; answer?: string }
export interface CriterionEvidence { criterionId: string; evidence: string }
export interface Checkpoint { id: string; summary: string; criterionEvidence: CriterionEvidence[]; at: string }
export interface PlanRevision {
  planRevision: number;
  action: WorkplanMutationAction;
  section?: WorkplanSection;
  addedIds: string[];
  updatedIds: string[];
  removedIds: string[];
  beforeDigest: string;
  afterDigest: string;
  rationale: string;
  actor: "tool";
  at: string;
}

export interface Workplan {
  id: string;
  title: string;
  objective: string;
  background?: string;
  scope: string[];
  nonGoals: string[];
  constraints: string[];
  approach: string;
  milestones: Milestone[];
  acceptanceCriteria: PlanCriterion[];
  verification: string[];
  risks: Risk[];
  openQuestions: Question[];
  decisions: Decision[];
  checkpoints: Checkpoint[];
  revisions: PlanRevision[];
  status: WorkplanStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  nextMilestoneNumber: number;
  nextCriterionNumber: number;
  nextDecisionNumber: number;
  nextRiskNumber: number;
  nextQuestionNumber: number;
  nextCheckpointNumber: number;
}

export interface WorkplanState { plans: Workplan[]; nextPlanNumber: number; stateRevision: number }

export type WorkplanAction =
  | "create" | "list" | "status" | "read" | "revise" | "add_milestone"
  | "update_milestone" | "record_decision" | "record_risk" | "record_question"
  | "checkpoint" | "pause" | "resume" | "complete" | "archive";
export type WorkplanMutationAction = Exclude<WorkplanAction, "list" | "status" | "read">;
export type WorkplanSection =
  | "title" | "objective" | "background" | "scope" | "non_goals" | "constraints"
  | "approach" | "acceptance_criteria" | "verification" | "risks" | "open_questions";

export interface WorkplanInput {
  action: WorkplanAction;
  planId?: string;
  section?: WorkplanSection;
  milestoneId?: string;
  content?: unknown;
  rationale?: string;
  expectedRevision?: number;
}

export type WorkplanEvent = StateEvent<WorkplanMutationAction, Record<string, unknown>>;
export interface WorkplanOperation { state: WorkplanState; event?: WorkplanEvent; result: unknown }

const ACTIONS = new Set<WorkplanAction>([
  "create", "list", "status", "read", "revise", "add_milestone", "update_milestone", "record_decision",
  "record_risk", "record_question", "checkpoint", "pause", "resume", "complete", "archive",
]);
const SECTIONS = new Set<WorkplanSection>([
  "title", "objective", "background", "scope", "non_goals", "constraints", "approach", "acceptance_criteria",
  "verification", "risks", "open_questions",
]);
const PLAN_ID = /^WP([1-9][0-9]*)$/;
const TODO_ID = /^T[1-9][0-9]*$/;
const HEX = /^[0-9a-f]{64}$/;

export function emptyWorkplanState(): WorkplanState { return { plans: [], nextPlanNumber: 1, stateRevision: 0 } }
export function cloneWorkplanState(state: WorkplanState): WorkplanState { return cloneJson(state) }

function exact(value: unknown, required: readonly string[], optional: readonly string[] = [], field = "content", code: StateErrorCode = "STATE_INVALID_INPUT"): asserts value is Record<string, unknown> {
  requireExactObject(value, required, optional, field, code);
}
function stringValue(value: unknown, field: string, maximum = 2000, allowBlank = false, code: StateErrorCode = "STATE_INVALID_INPUT"): string {
  requireString(value, field, code);
  const result = normalizeStateText(value);
  if (!allowBlank) requireNonBlank(result, field);
  requireCodePoints(result, maximum, field);
  return result;
}
function stringList(value: unknown, field: string, maximumItems = 64, maximumPoints = 1000, code: StateErrorCode = "STATE_INVALID_INPUT"): string[] {
  requireStringArray(value, field, code);
  if (value.length > maximumItems) stateError("STATE_LIMIT_EXCEEDED", `${field} has ${value.length} items; maximum is ${maximumItems}`);
  return value.map((item, index) => stringValue(item, `${field}[${index}]`, maximumPoints, false, code));
}
function idNumber(id: string): number { return Number(id.match(/(\d+)(?!.*\d)/)?.[1] ?? 0) }
function hash(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex") }
function planDigest(plan: Workplan): string { return hash(plan) }
function sorted<T extends { id: string }>(values: T[]): T[] { return values.slice().sort((a, b) => compareNumericIds(a.id, b.id)) }
function planById(state: WorkplanState, id: string): Workplan {
  const plan = state.plans.find((candidate) => candidate.id === id);
  if (!plan) stateError("STATE_NOT_FOUND", `Workplan ${id} does not exist on the current branch`);
  return plan;
}
function milestoneById(plan: Workplan, id: string): Milestone {
  const milestone = plan.milestones.find((candidate) => candidate.id === id);
  if (!milestone) stateError("STATE_NOT_FOUND", `Milestone ${id} does not exist in ${plan.id}`);
  return milestone;
}
function expected(plan: Workplan, revision: number): void {
  if (plan.revision !== revision) stateError("STATE_REVISION_MISMATCH", `Workplan ${plan.id} is revision ${plan.revision}; expected ${revision}`);
}
function rationale(value: unknown): string { return stringValue(value, "rationale", 2000) }
function fixedReason(action: WorkplanMutationAction): string { return `Explicit ${action} operation`; }

function validateIds<T extends { id: string }>(items: T[], pattern: RegExp, next: number, field: string, code: StateErrorCode): void {
  const ids = items.map((item) => item.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => !pattern.test(id))) stateError(code, `${field} IDs are invalid`);
  const maximum = ids.reduce((value, id) => Math.max(value, idNumber(id)), 0);
  if (!Number.isSafeInteger(next) || next < 1 || next <= maximum) stateError(code, `${field} counter is not monotonic`);
}
function validateGraph(plan: Workplan, code: StateErrorCode): void {
  const ids = new Set(plan.milestones.map((item) => item.id));
  const byId = new Map(plan.milestones.map((item) => [item.id, item]));
  for (const milestone of plan.milestones) {
    if (new Set(milestone.dependsOn).size !== milestone.dependsOn.length) stateError(code, `Milestone ${milestone.id} has duplicate dependencies`);
    for (const dependency of milestone.dependsOn) {
      if (dependency === milestone.id || !ids.has(dependency)) stateError(code, `Milestone ${milestone.id} has an invalid dependency`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) stateError(code, `Milestone dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}

function validateRevisionRecord(value: PlanRevision, planId: string, code: StateErrorCode): void {
  exact(value, ["planRevision", "action", "addedIds", "updatedIds", "removedIds", "beforeDigest", "afterDigest", "rationale", "actor", "at"], ["section"], "revision record", code);
  if (!Number.isSafeInteger(value.planRevision) || value.planRevision < 1 || !ACTIONS.has(value.action)) stateError(code, "A revision record is invalid");
  if (value.section !== undefined && !SECTIONS.has(value.section)) stateError(code, "A revision section is invalid");
  for (const [field, values] of [["addedIds", value.addedIds], ["updatedIds", value.updatedIds], ["removedIds", value.removedIds]] as const) {
    if (!Array.isArray(values) || !values.every((item) => typeof item === "string") || new Set(values).size !== values.length) stateError(code, `Revision ${field} is invalid`);
  }
  if (!HEX.test(value.beforeDigest) || !HEX.test(value.afterDigest) || value.actor !== "tool" || typeof value.rationale !== "string" || typeof value.at !== "string") {
    stateError(code, "A revision record field is invalid");
  }
  if ([...value.rationale].length > 2000 || !/\S/u.test(value.rationale)) stateError(code, "A revision rationale is invalid");
  for (const id of [...value.addedIds, ...value.updatedIds, ...value.removedIds]) {
    if (!id.startsWith(planId)) stateError(code, "A revision ID belongs to another plan");
  }
}

export function validateWorkplan(plan: Workplan, code: StateErrorCode = "STATE_CORRUPT"): void {
  exact(plan, [
    "id", "title", "objective", "scope", "nonGoals", "constraints", "approach", "milestones", "acceptanceCriteria",
    "verification", "risks", "openQuestions", "decisions", "checkpoints", "revisions", "status", "revision", "createdAt",
    "updatedAt", "nextMilestoneNumber", "nextCriterionNumber", "nextDecisionNumber", "nextRiskNumber", "nextQuestionNumber",
    "nextCheckpointNumber",
  ], ["background"], "workplan", code);
  if (!PLAN_ID.test(plan.id) || !["draft", "active", "paused", "completed", "archived"].includes(plan.status)) stateError(code, "A workplan identity or status is invalid");
  if (!Number.isSafeInteger(plan.revision) || plan.revision < 1 || typeof plan.createdAt !== "string" || typeof plan.updatedAt !== "string") stateError(code, "A workplan revision or time is invalid");
  if (typeof plan.title !== "string" || !/\S/u.test(plan.title) || [...plan.title].length > 200) stateError(code, "A workplan title is invalid");
  if (typeof plan.objective !== "string" || !/\S/u.test(plan.objective) || [...plan.objective].length > 2000) stateError(code, "A workplan objective is invalid");
  if (plan.background !== undefined && (typeof plan.background !== "string" || Buffer.byteLength(plan.background, "utf8") > 8192)) stateError(code, "A workplan background is invalid");
  if (typeof plan.approach !== "string" || !/\S/u.test(plan.approach) || Buffer.byteLength(plan.approach, "utf8") > 16384) stateError(code, "A workplan approach is invalid");
  for (const [name, values] of [["scope", plan.scope], ["nonGoals", plan.nonGoals], ["constraints", plan.constraints], ["verification", plan.verification]] as const) {
    if (!Array.isArray(values) || values.length > 64 || !values.every((item) => typeof item === "string" && /\S/u.test(item) && [...item].length <= 1000)) stateError(code, `Workplan ${name} is invalid`);
  }
  if (plan.milestones.length > 64 || plan.acceptanceCriteria.length > 64 || plan.decisions.length > 128 || plan.risks.length > 128 || plan.openQuestions.length > 128 || plan.checkpoints.length > 256) stateError(code, "A workplan collection limit is exceeded");

  const childPattern = (kind: string) => new RegExp(`^${plan.id}-${kind}([1-9][0-9]*)$`);
  validateIds(plan.milestones, childPattern("M"), plan.nextMilestoneNumber, "milestone", code);
  validateIds(plan.acceptanceCriteria, childPattern("C"), plan.nextCriterionNumber, "criterion", code);
  validateIds(plan.decisions, childPattern("D"), plan.nextDecisionNumber, "decision", code);
  validateIds(plan.risks, childPattern("R"), plan.nextRiskNumber, "risk", code);
  validateIds(plan.openQuestions, childPattern("Q"), plan.nextQuestionNumber, "question", code);
  validateIds(plan.checkpoints, childPattern("K"), plan.nextCheckpointNumber, "checkpoint", code);

  for (const criterion of plan.acceptanceCriteria) {
    exact(criterion, ["id", "text"], [], "criterion", code);
    if (typeof criterion.text !== "string" || !/\S/u.test(criterion.text) || [...criterion.text].length > 2000) stateError(code, "A criterion is invalid");
  }
  for (const milestone of plan.milestones) {
    exact(milestone, ["id", "title", "dependsOn", "acceptanceCriteria", "status", "evidence", "linkedTodoIds", "createdAt", "updatedAt"], ["description"], "milestone", code);
    if (typeof milestone.title !== "string" || !/\S/u.test(milestone.title) || [...milestone.title].length > 2000) stateError(code, "A milestone title is invalid");
    if (milestone.description !== undefined && (typeof milestone.description !== "string" || [...milestone.description].length > 2000)) stateError(code, "A milestone description is invalid");
    if (!Array.isArray(milestone.dependsOn) || !Array.isArray(milestone.acceptanceCriteria) || !Array.isArray(milestone.evidence) || !Array.isArray(milestone.linkedTodoIds)) stateError(code, "A milestone list is invalid");
    if (!milestone.acceptanceCriteria.every((item) => typeof item === "string" && /\S/u.test(item) && [...item].length <= 2000)) stateError(code, "A milestone criterion is invalid");
    if (!milestone.evidence.every((item) => typeof item === "string" && /\S/u.test(item) && [...item].length <= 2000)) stateError(code, "Milestone evidence is invalid");
    if (!milestone.linkedTodoIds.every((id) => typeof id === "string" && TODO_ID.test(id))) stateError(code, "A linked todo ID is invalid");
    for (const values of [milestone.acceptanceCriteria, milestone.evidence, milestone.linkedTodoIds]) if (new Set(values).size !== values.length) stateError(code, "A milestone list contains a duplicate");
    if (!["pending", "in_progress", "blocked", "completed"].includes(milestone.status) || typeof milestone.createdAt !== "string" || typeof milestone.updatedAt !== "string") stateError(code, "A milestone status or time is invalid");
    if (milestone.status === "completed" && milestone.evidence.length === 0) stateError(code, "A completed milestone has no evidence");
  }
  validateGraph(plan, code);
  for (const decision of plan.decisions) {
    exact(decision, ["id", "decision", "rationale", "at"], [], "decision", code);
    if (![decision.decision, decision.rationale].every((item) => typeof item === "string" && /\S/u.test(item) && [...item].length <= 2000) || typeof decision.at !== "string") stateError(code, "A decision is invalid");
  }
  for (const risk of plan.risks) {
    exact(risk, ["id", "description", "impact", "mitigation", "status"], [], "risk", code);
    if (![risk.description, risk.impact, risk.mitigation].every((item) => typeof item === "string" && /\S/u.test(item) && [...item].length <= 2000) || !["open", "mitigated", "accepted"].includes(risk.status)) stateError(code, "A risk is invalid");
  }
  for (const question of plan.openQuestions) {
    exact(question, ["id", "question", "status"], ["answer"], "question", code);
    if (typeof question.question !== "string" || !/\S/u.test(question.question) || [...question.question].length > 2000 || !["open", "resolved"].includes(question.status)) stateError(code, "A question is invalid");
    if (question.status === "open" && question.answer !== undefined) stateError(code, "An open question has an answer");
    if (question.status === "resolved" && (typeof question.answer !== "string" || !/\S/u.test(question.answer) || [...question.answer].length > 2000)) stateError(code, "A resolved question has no valid answer");
  }
  const criterionIds = new Set(plan.acceptanceCriteria.map((item) => item.id));
  for (const checkpoint of plan.checkpoints) {
    exact(checkpoint, ["id", "summary", "criterionEvidence", "at"], [], "checkpoint", code);
    if (typeof checkpoint.summary !== "string" || !/\S/u.test(checkpoint.summary) || [...checkpoint.summary].length > 2000 || typeof checkpoint.at !== "string" || !Array.isArray(checkpoint.criterionEvidence)) stateError(code, "A checkpoint is invalid");
    const links = new Set<string>();
    for (const evidence of checkpoint.criterionEvidence) {
      exact(evidence, ["criterionId", "evidence"], [], "criterion evidence", code);
      if (typeof evidence.criterionId !== "string" || !criterionIds.has(evidence.criterionId) || links.has(evidence.criterionId) || typeof evidence.evidence !== "string" || !/\S/u.test(evidence.evidence) || [...evidence.evidence].length > 2000) stateError(code, "Criterion evidence is invalid");
      links.add(evidence.criterionId);
    }
  }
  if (!Array.isArray(plan.revisions) || plan.revisions.length !== plan.revision) stateError(code, "Workplan revision history is incomplete");
  plan.revisions.forEach((record, index) => {
    validateRevisionRecord(record, plan.id, code);
    if (record.planRevision !== index + 1) stateError(code, "Workplan revision history is out of order");
  });
  if (Buffer.byteLength(stableJson(plan), "utf8") > 256 * 1024) stateError(code, "The canonical workplan limit is exceeded");
}

export function validateWorkplanState(state: WorkplanState): void {
  requirePlainJson(state, "workplan state");
  exact(state, ["plans", "nextPlanNumber", "stateRevision"], [], "workplan state", "STATE_CORRUPT");
  if (!Array.isArray(state.plans) || state.plans.length > 16) stateError("STATE_CORRUPT", "The live workplan count is invalid");
  requireSafeInteger(state.nextPlanNumber, "nextPlanNumber", 1, "STATE_CORRUPT");
  requireSafeInteger(state.stateRevision, "stateRevision", 0, "STATE_CORRUPT");
  validateIds(state.plans, PLAN_ID, state.nextPlanNumber, "workplan", "STATE_CORRUPT");
  state.plans.forEach((plan) => validateWorkplan(plan));
  if (state.plans.filter((plan) => plan.status === "active").length > 1) stateError("STATE_CORRUPT", "More than one workplan is active");
}

function recordFor(before: Workplan | null, afterWithoutRecord: Workplan, action: WorkplanMutationAction, at: string, reason: string, ids: { added?: string[]; updated?: string[]; removed?: string[] }, section?: WorkplanSection): PlanRevision {
  const beforeDigest = hash(before);
  const afterDigest = planDigest(afterWithoutRecord);
  return {
    planRevision: afterWithoutRecord.revision,
    action,
    ...(section ? { section } : {}),
    addedIds: [...(ids.added ?? [])].sort(compareNumericIds),
    updatedIds: [...(ids.updated ?? [])].sort(compareNumericIds),
    removedIds: [...(ids.removed ?? [])].sort(compareNumericIds),
    beforeDigest,
    afterDigest,
    rationale: reason,
    actor: "tool",
    at,
  };
}

function mutationBase(plan: Workplan, at: string): Workplan {
  const next = cloneJson(plan);
  next.revision++;
  next.updatedAt = at;
  return next;
}
function addRecord(plan: Workplan, record: PlanRevision): Workplan { plan.revisions.push(record); return plan }
function verifyRecord(before: Workplan | null, next: Workplan, record: PlanRevision, eventAt: string, action: WorkplanMutationAction): void {
  validateRevisionRecord(record, next.id, "STATE_CORRUPT");
  if (record.planRevision !== next.revision || record.action !== action || record.at !== eventAt || record.beforeDigest !== hash(before) || record.afterDigest !== planDigest(next)) {
    stateError("STATE_CORRUPT", "The workplan revision record does not match the event");
  }
}

function eventShape(action: WorkplanMutationAction, data: unknown): asserts data is Record<string, unknown> {
  if (action === "create") exact(data, ["plan"], [], "event data", "STATE_CORRUPT");
  else if (action === "revise") exact(data, ["planId", "baseRevision", "revision", "section", "value", "revisionRecord"], [], "event data", "STATE_CORRUPT");
  else if (action === "add_milestone") exact(data, ["planId", "baseRevision", "revision", "milestone", "revisionRecord"], [], "event data", "STATE_CORRUPT");
  else if (action === "update_milestone") exact(data, ["planId", "baseRevision", "revision", "milestoneId", "changes", "revisionRecord"], [], "event data", "STATE_CORRUPT");
  else if (action === "record_decision") exact(data, ["planId", "baseRevision", "revision", "decision", "revisionRecord"], [], "event data", "STATE_CORRUPT");
  else if (action === "record_risk") exact(data, ["planId", "baseRevision", "revision", "risk", "revisionRecord"], [], "event data", "STATE_CORRUPT");
  else if (action === "record_question") exact(data, ["planId", "baseRevision", "revision", "question", "revisionRecord"], [], "event data", "STATE_CORRUPT");
  else if (action === "checkpoint") exact(data, ["planId", "baseRevision", "revision", "checkpoint", "criterionLinks", "revisionRecord"], [], "event data", "STATE_CORRUPT");
  else exact(data, ["planId", "baseRevision", "revision", "from", "to", "revisionRecord"], [], "event data", "STATE_CORRUPT");
}

function setSection(plan: Workplan, section: WorkplanSection, value: unknown): void {
  if (section === "title" || section === "objective" || section === "approach") plan[section] = value as string;
  else if (section === "background") plan.background = value as string;
  else if (section === "scope") plan.scope = cloneJson(value as string[]);
  else if (section === "non_goals") plan.nonGoals = cloneJson(value as string[]);
  else if (section === "constraints") plan.constraints = cloneJson(value as string[]);
  else if (section === "verification") plan.verification = cloneJson(value as string[]);
  else if (section === "acceptance_criteria") plan.acceptanceCriteria = cloneJson(value as PlanCriterion[]);
  else if (section === "risks") plan.risks = cloneJson(value as Risk[]);
  else plan.openQuestions = cloneJson(value as Question[]);
}

export function applyWorkplanEvent(current: WorkplanState, value: unknown): WorkplanState {
  validateWorkplanState(current);
  validateStateEventEnvelope(value, "workplan", current.stateRevision);
  if (!ACTIONS.has(value.action as WorkplanAction) || ["list", "status", "read"].includes(value.action)) stateError("STATE_CORRUPT", "The workplan event action is invalid");
  const action = value.action as WorkplanMutationAction;
  eventShape(action, value.data);
  const data = value.data;
  const state = cloneWorkplanState(current);
  if (action === "create") {
    const plan = cloneJson(data.plan) as Workplan;
    validateWorkplan(plan);
    if (plan.id !== `WP${state.nextPlanNumber}` || plan.revision !== 1 || plan.revisions.length !== 1 || plan.createdAt !== value.at || plan.updatedAt !== value.at || plan.status !== "draft") stateError("STATE_CORRUPT", "The created workplan is invalid");
    const without = cloneJson(plan); const record = without.revisions.pop()!;
    verifyRecord(null, without, record, value.at, action);
    state.plans.push(plan); state.nextPlanNumber++;
  } else {
    requireString(data.planId, "planId", "STATE_CORRUPT");
    requireSafeInteger(data.baseRevision, "baseRevision", 1, "STATE_CORRUPT");
    requireSafeInteger(data.revision, "revision", 2, "STATE_CORRUPT");
    const original = cloneJson(planById(state, data.planId));
    if (original.revision !== data.baseRevision || data.revision !== original.revision + 1) stateError("STATE_CORRUPT", "The workplan revision chain is invalid");
    const next = mutationBase(original, value.at);
    const record = cloneJson(data.revisionRecord) as PlanRevision;
    if (action === "revise") {
      requireString(data.section, "section", "STATE_CORRUPT");
      if (!SECTIONS.has(data.section as WorkplanSection)) stateError("STATE_CORRUPT", "The revised section is invalid");
      const revisedSection = data.section as WorkplanSection;
      setSection(next, revisedSection, data.value);
      if (revisedSection === "acceptance_criteria") {
        next.nextCriterionNumber = Math.max(next.nextCriterionNumber, ...next.acceptanceCriteria.map((item) => idNumber(item.id) + 1));
      } else if (revisedSection === "risks") {
        next.nextRiskNumber = Math.max(next.nextRiskNumber, ...next.risks.map((item) => idNumber(item.id) + 1));
      } else if (revisedSection === "open_questions") {
        next.nextQuestionNumber = Math.max(next.nextQuestionNumber, ...next.openQuestions.map((item) => idNumber(item.id) + 1));
      }
    } else if (action === "add_milestone") {
      next.milestones.push(cloneJson(data.milestone) as Milestone); next.nextMilestoneNumber++;
    } else if (action === "update_milestone") {
      requireString(data.milestoneId, "milestoneId", "STATE_CORRUPT");
      const milestone = milestoneById(next, data.milestoneId);
      exact(data.changes, [], ["title", "description", "dependsOn", "status", "evidence", "linkedTodoIds", "updatedAt"], "milestone changes", "STATE_CORRUPT");
      if (Object.keys(data.changes).length === 0) stateError("STATE_CORRUPT", "Milestone changes are empty");
      Object.assign(milestone, cloneJson(data.changes));
      if (Object.hasOwn(data.changes, "description") && data.changes.description === null) delete milestone.description;
    } else if (action === "record_decision") { next.decisions.push(cloneJson(data.decision) as Decision); next.nextDecisionNumber++; }
    else if (action === "record_risk") { next.risks.push(cloneJson(data.risk) as Risk); next.nextRiskNumber++; }
    else if (action === "record_question") { next.openQuestions.push(cloneJson(data.question) as Question); next.nextQuestionNumber++; }
    else if (action === "checkpoint") {
      const checkpoint = cloneJson(data.checkpoint) as Checkpoint;
      if (stableJson(checkpoint.criterionEvidence) !== stableJson(data.criterionLinks)) stateError("STATE_CORRUPT", "Checkpoint criterion links do not match");
      next.checkpoints.push(checkpoint); next.nextCheckpointNumber++;
    } else {
      requireString(data.from, "from", "STATE_CORRUPT"); requireString(data.to, "to", "STATE_CORRUPT");
      if (next.status !== data.from) stateError("STATE_CORRUPT", "The workplan transition source is invalid");
      const from = data.from as WorkplanStatus;
      const to = data.to as WorkplanStatus;
      const valid = action === "pause" ? from === "active" && to === "paused"
        : action === "resume" ? (from === "draft" || from === "paused") && to === "active"
          : action === "complete" ? (from === "active" || from === "paused") && to === "completed"
            : ["draft", "paused", "completed"].includes(from) && to === "archived";
      if (!valid) stateError("STATE_CORRUPT", "The workplan transition is invalid");
      if (action === "resume" && state.plans.some((plan) => plan.id !== next.id && plan.status === "active")) stateError("STATE_CORRUPT", "More than one workplan would be active");
      if (action === "complete") {
        if (next.milestones.some((item) => item.status !== "completed")) stateError("STATE_CORRUPT", "A completed workplan has an incomplete milestone");
        const evidenced = new Set(next.checkpoints.flatMap((item) => item.criterionEvidence.map((link) => link.criterionId)));
        if (next.acceptanceCriteria.some((item) => !evidenced.has(item.id))) stateError("STATE_CORRUPT", "A completed workplan lacks criterion evidence");
      }
      next.status = to;
    }
    verifyRecord(original, next, record, value.at, action);
    next.revisions.push(record);
    const index = state.plans.findIndex((plan) => plan.id === next.id); state.plans[index] = next;
  }
  state.stateRevision = value.stateRevision;
  validateWorkplanState(state);
  return state;
}

function allowed(input: WorkplanInput, fields: readonly (keyof WorkplanInput)[]): void {
  const keys = new Set<keyof WorkplanInput>(["action", ...fields]);
  const invalid = Object.keys(input).find((key) => !keys.has(key as keyof WorkplanInput));
  if (invalid) stateError("STATE_INVALID_INPUT", `Field ${invalid} is not valid for action ${input.action}`);
}
function planInput(state: WorkplanState, input: WorkplanInput): Workplan {
  if (typeof input.planId !== "string" || !PLAN_ID.test(input.planId)) stateError("STATE_INVALID_INPUT", "planId must be a workplan ID");
  const plan = planById(state, input.planId);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision! < 1) stateError("STATE_INVALID_INPUT", "expectedRevision must be a positive safe integer");
  expected(plan, input.expectedRevision!);
  return plan;
}
function contentObject(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> { exact(value, required, optional); return value; }

function criteriaInput(value: unknown, plan: Workplan, field = "acceptanceCriteria"): { values: PlanCriterion[]; added: string[]; updated: string[]; removed: string[] } {
  if (!Array.isArray(value) || value.length > 64) stateError("STATE_INVALID_INPUT", `${field} must be an array with at most 64 items`);
  const existing = new Map(plan.acceptanceCriteria.map((item) => [item.id, item]));
  let next = plan.nextCriterionNumber; const used = new Set<string>(); const values: PlanCriterion[] = []; const added: string[] = []; const updated: string[] = [];
  for (const raw of value) {
    exact(raw, ["text"], ["id"], "criterion");
    const text = stringValue(raw.text, "criterion text");
    let id: string;
    if (raw.id === undefined) { id = `${plan.id}-C${next++}`; added.push(id); }
    else {
      requireString(raw.id, "criterion id");
      if (!existing.has(raw.id) || !new RegExp(`^${plan.id}-C`).test(raw.id) || used.has(raw.id)) stateError("STATE_INVALID_LINK", "A criterion ID is unknown, duplicated, or belongs to another plan");
      id = raw.id; if (existing.get(id)!.text !== text) updated.push(id);
    }
    if (used.has(id)) stateError("STATE_INVALID_LINK", "A criterion ID is duplicated");
    used.add(id); values.push({ id, text });
  }
  const removed = [...existing.keys()].filter((id) => !used.has(id));
  const evidenced = new Set(plan.checkpoints.flatMap((item) => item.criterionEvidence.map((link) => link.criterionId)));
  if (removed.some((id) => evidenced.has(id))) stateError("STATE_INVALID_LINK", "A criterion with checkpoint evidence cannot be removed");
  plan.nextCriterionNumber = next;
  return { values, added, updated, removed };
}

function risksInput(value: unknown, plan: Workplan): { values: Risk[]; added: string[]; updated: string[]; removed: string[] } {
  if (!Array.isArray(value) || value.length > 128) stateError("STATE_INVALID_INPUT", "risks must be an array with at most 128 items");
  const existing = new Map(plan.risks.map((item) => [item.id, item])); let next = plan.nextRiskNumber; const used = new Set<string>(); const values: Risk[] = []; const added: string[] = []; const updated: string[] = [];
  for (const raw of value) {
    exact(raw, ["description", "impact", "mitigation"], ["id", "status"], "risk");
    const item = {
      description: stringValue(raw.description, "risk description"), impact: stringValue(raw.impact, "risk impact"), mitigation: stringValue(raw.mitigation, "risk mitigation"),
      status: (raw.status ?? "open") as RiskStatus,
    };
    if (!["open", "mitigated", "accepted"].includes(item.status)) stateError("STATE_INVALID_INPUT", "Risk status is invalid");
    let id: string;
    if (raw.id === undefined) { id = `${plan.id}-R${next++}`; added.push(id); }
    else { requireString(raw.id, "risk id"); if (!existing.has(raw.id) || used.has(raw.id)) stateError("STATE_INVALID_LINK", "A risk ID is unknown or duplicated"); id = raw.id; if (stableJson(existing.get(id)) !== stableJson({ id, ...item })) updated.push(id); }
    if (used.has(id)) stateError("STATE_INVALID_LINK", "A risk ID is duplicated"); used.add(id); values.push({ id, ...item });
  }
  const removed = [...existing.keys()].filter((id) => !used.has(id)); plan.nextRiskNumber = next; return { values, added, updated, removed };
}

function questionsInput(value: unknown, plan: Workplan): { values: Question[]; added: string[]; updated: string[]; removed: string[] } {
  if (!Array.isArray(value) || value.length > 128) stateError("STATE_INVALID_INPUT", "open_questions must be an array with at most 128 items");
  const existing = new Map(plan.openQuestions.map((item) => [item.id, item])); let next = plan.nextQuestionNumber; const used = new Set<string>(); const values: Question[] = []; const added: string[] = []; const updated: string[] = [];
  for (const raw of value) {
    exact(raw, ["question"], ["id", "status", "answer"], "question");
    const status = (raw.status ?? "open") as QuestionStatus;
    if (status !== "open" && status !== "resolved") stateError("STATE_INVALID_INPUT", "Question status is invalid");
    const base = { question: stringValue(raw.question, "question"), status };
    let answer: string | undefined;
    if (status === "resolved") answer = stringValue(raw.answer, "answer");
    else if (raw.answer !== undefined) stateError("STATE_INVALID_INPUT", "An open question cannot have an answer");
    let id: string;
    if (raw.id === undefined) { id = `${plan.id}-Q${next++}`; added.push(id); }
    else { requireString(raw.id, "question id"); if (!existing.has(raw.id) || used.has(raw.id)) stateError("STATE_INVALID_LINK", "A question ID is unknown or duplicated"); id = raw.id; const candidate = { id, ...base, ...(answer ? { answer } : {}) }; if (stableJson(existing.get(id)) !== stableJson(candidate)) updated.push(id); }
    if (used.has(id)) stateError("STATE_INVALID_LINK", "A question ID is duplicated"); used.add(id); values.push({ id, ...base, ...(answer ? { answer } : {}) });
  }
  const removed = [...existing.keys()].filter((id) => !used.has(id)); plan.nextQuestionNumber = next; return { values, added, updated, removed };
}

function validateDependencies(plan: Workplan, milestoneId: string, values: string[]): string[] {
  requireUnique(values, "dependsOn");
  if (values.includes(milestoneId) || values.some((id) => !plan.milestones.some((item) => item.id === id))) stateError("STATE_INVALID_LINK", "A milestone dependency is unknown or self-referential");
  const candidate = cloneJson(plan); const item = milestoneById(candidate, milestoneId); item.dependsOn = [...values];
  validateGraph(candidate, "STATE_INVALID_LINK"); return [...values];
}
function incompleteDependency(plan: Workplan, milestone: Milestone): string | undefined { return milestone.dependsOn.find((id) => milestoneById(plan, id).status !== "completed") }
function transitionAllowed(from: MilestoneStatus, to: MilestoneStatus): boolean {
  return (from === "pending" && to === "in_progress") || (from === "in_progress" && (to === "blocked" || to === "completed")) || (from === "blocked" && (to === "in_progress" || to === "completed"));
}

function makeCreatePlan(content: Record<string, unknown>, id: string, at: string): Workplan {
  const criteriaRaw = content.acceptanceCriteria ?? [];
  if (!Array.isArray(criteriaRaw) || criteriaRaw.length > 64 || !criteriaRaw.every((item) => typeof item === "string")) stateError("STATE_INVALID_INPUT", "acceptanceCriteria must be an array of strings");
  let background: string | undefined;
  if (content.background !== undefined) {
    requireString(content.background, "background");
    background = normalizeStateText(content.background);
    requireUtf8(background, 8192, "background");
  }
  let criterion = 1;
  const plan: Workplan = {
    id,
    title: stringValue(content.title, "title", 200),
    objective: stringValue(content.objective, "objective"),
    ...(background !== undefined ? { background } : {}),
    scope: content.scope === undefined ? [] : stringList(content.scope, "scope"),
    nonGoals: content.nonGoals === undefined ? [] : stringList(content.nonGoals, "nonGoals"),
    constraints: content.constraints === undefined ? [] : stringList(content.constraints, "constraints"),
    approach: stringValue(content.approach, "approach", 16384),
    milestones: [],
    acceptanceCriteria: criteriaRaw.map((text) => ({ id: `${id}-C${criterion++}`, text: stringValue(text, "criterion") })),
    verification: content.verification === undefined ? [] : stringList(content.verification, "verification"),
    risks: [], openQuestions: [], decisions: [], checkpoints: [], revisions: [], status: "draft", revision: 1,
    createdAt: at, updatedAt: at, nextMilestoneNumber: 1, nextCriterionNumber: criterion, nextDecisionNumber: 1,
    nextRiskNumber: 1, nextQuestionNumber: 1, nextCheckpointNumber: 1,
  };
  requireUtf8(plan.approach, 16384, "approach");
  const record = recordFor(null, plan, "create", at, fixedReason("create"), { added: [id, ...plan.acceptanceCriteria.map((item) => item.id)] });
  plan.revisions.push(record); validateWorkplan(plan, "STATE_LIMIT_EXCEEDED"); return plan;
}

export function performWorkplanAction(current: WorkplanState, inputValue: unknown, now = Date.now()): WorkplanOperation {
  validateWorkplanState(current); requirePlainJson(inputValue, "input");
  exact(inputValue, ["action"], ["planId", "section", "milestoneId", "content", "rationale", "expectedRevision"], "input");
  const input = inputValue as unknown as WorkplanInput;
  if (!ACTIONS.has(input.action)) stateError("STATE_INVALID_INPUT", "action is not a workplan action");
  const at = new Date(now).toISOString();
  if (input.action === "list") {
    allowed(input, []);
    return { state: current, result: sorted(current.plans).map((plan) => ({ id: plan.id, title: plan.title, status: plan.status, revision: plan.revision, updatedAt: plan.updatedAt })) };
  }
  if (input.action === "status" || input.action === "read") {
    allowed(input, ["planId"]);
    if (typeof input.planId !== "string" || !PLAN_ID.test(input.planId)) stateError("STATE_INVALID_INPUT", "planId must be a workplan ID");
    const plan = planById(current, input.planId);
    if (input.action === "read") return { state: current, result: renderWorkplan(plan) };
    const completed = plan.milestones.filter((item) => item.status === "completed").length;
    const evidenceIds = new Set(plan.checkpoints.flatMap((item) => item.criterionEvidence.map((link) => link.criterionId)));
    return { state: current, result: {
      planId: plan.id, status: plan.status, revision: plan.revision, currentCheckpointId: plan.checkpoints.at(-1)?.id ?? null,
      milestones: { completed, total: plan.milestones.length }, blocked: plan.milestones.filter((item) => item.status === "blocked").length,
      criterionEvidence: evidenceIds.size, linkedTodoIds: new Set(plan.milestones.flatMap((item) => item.linkedTodoIds)).size,
    } };
  }

  let data: Record<string, unknown>;
  if (input.action === "create") {
    allowed(input, ["content"]);
    const content = contentObject(input.content, ["title", "objective", "approach"], ["background", "scope", "nonGoals", "constraints", "acceptanceCriteria", "verification"]);
    if (current.plans.length >= 16) stateError("STATE_LIMIT_EXCEEDED", "The branch can contain at most 16 live workplans");
    const plan = makeCreatePlan(content, `WP${current.nextPlanNumber}`, at); data = { plan };
  } else {
    const fields: (keyof WorkplanInput)[] = ["planId", "expectedRevision"];
    if (["revise", "add_milestone", "update_milestone", "record_decision", "record_risk", "record_question", "checkpoint"].includes(input.action)) fields.push("content");
    if (["revise", "record_decision", "pause", "resume", "complete", "archive"].includes(input.action)) fields.push("rationale");
    if (input.action === "revise") fields.push("section");
    if (input.action === "update_milestone") fields.push("milestoneId");
    allowed(input, fields);
    const original = planInput(current, input); const next = mutationBase(original, at);
    let ids: { added?: string[]; updated?: string[]; removed?: string[] } = { updated: [original.id] };
    let reason = ["revise", "record_decision", "pause", "resume", "complete", "archive"].includes(input.action) ? rationale(input.rationale) : fixedReason(input.action);
    let section: WorkplanSection | undefined;

    if (input.action === "revise") {
      if (typeof input.section !== "string" || !SECTIONS.has(input.section)) stateError("STATE_INVALID_INPUT", "section is invalid");
      section = input.section;
      if (section === "title") setSection(next, section, stringValue(input.content, "title", 200));
      else if (section === "objective") setSection(next, section, stringValue(input.content, "objective"));
      else if (section === "background") { const text = stringValue(input.content, "background", 8192, true); requireUtf8(text, 8192, "background"); setSection(next, section, text); }
      else if (section === "approach") { const text = stringValue(input.content, "approach", 16384); requireUtf8(text, 16384, "approach"); setSection(next, section, text); }
      else if (["scope", "non_goals", "constraints", "verification"].includes(section)) setSection(next, section, stringList(input.content, section));
      else if (section === "acceptance_criteria") { const change = criteriaInput(input.content, next); setSection(next, section, change.values); ids = change; }
      else if (section === "risks") { const change = risksInput(input.content, next); setSection(next, section, change.values); ids = change; }
      else { const change = questionsInput(input.content, next); setSection(next, section, change.values); ids = change; }
      const record = recordFor(original, next, input.action, at, reason, ids, section); addRecord(next, record);
      data = { planId: next.id, baseRevision: original.revision, revision: next.revision, section, value: cloneJson(section === "non_goals" ? next.nonGoals : section === "acceptance_criteria" ? next.acceptanceCriteria : section === "open_questions" ? next.openQuestions : next[section as keyof Workplan]), revisionRecord: record };
    } else if (input.action === "add_milestone") {
      const content = contentObject(input.content, ["title"], ["description", "dependsOn", "acceptanceCriteria"]);
      if (next.milestones.length >= 64) stateError("STATE_LIMIT_EXCEEDED", "A workplan can contain at most 64 milestones");
      const id = `${next.id}-M${next.nextMilestoneNumber}`;
      const dependencies = content.dependsOn === undefined ? [] : stringList(content.dependsOn, "dependsOn", 64, 100);
      requireUnique(dependencies, "dependsOn");
      if (dependencies.includes(id) || dependencies.some((dependency) => !next.milestones.some((item) => item.id === dependency))) stateError("STATE_INVALID_LINK", "A milestone dependency is unknown or self-referential");
      const milestone: Milestone = { id, title: stringValue(content.title, "milestone title"), ...(content.description !== undefined ? { description: stringValue(content.description, "description", 2000, true) } : {}), dependsOn: dependencies, acceptanceCriteria: content.acceptanceCriteria === undefined ? [] : stringList(content.acceptanceCriteria, "acceptanceCriteria", 64, 2000), status: "pending", evidence: [], linkedTodoIds: [], createdAt: at, updatedAt: at };
      next.milestones.push(milestone); next.nextMilestoneNumber++; ids = { added: [id], updated: [next.id] };
      const record = recordFor(original, next, input.action, at, reason, ids); addRecord(next, record);
      data = { planId: next.id, baseRevision: original.revision, revision: next.revision, milestone, revisionRecord: record };
    } else if (input.action === "update_milestone") {
      if (typeof input.milestoneId !== "string") stateError("STATE_INVALID_INPUT", "milestoneId is required");
      const milestone = milestoneById(next, input.milestoneId);
      if (milestone.status === "completed") stateError("STATE_INVALID_TRANSITION", `Milestone ${milestone.id} is completed and terminal`);
      const content = contentObject(input.content, [], ["title", "description", "dependsOn", "status", "evidence", "linkedTodoIds"]);
      if (Object.keys(content).length === 0) stateError("STATE_INVALID_INPUT", "update_milestone requires at least one content field");
      const changes: Record<string, unknown> = {};
      if (content.title !== undefined) { milestone.title = stringValue(content.title, "milestone title"); changes.title = milestone.title; }
      if (Object.hasOwn(content, "description")) {
        if (content.description === "") { delete milestone.description; changes.description = null; }
        else { milestone.description = stringValue(content.description, "description", 2000, true); changes.description = milestone.description; }
      }
      if (content.dependsOn !== undefined) { const values = stringList(content.dependsOn, "dependsOn", 64, 100); milestone.dependsOn = validateDependencies(next, milestone.id, values); changes.dependsOn = [...values]; }
      if (content.evidence !== undefined) { const values = stringList(content.evidence, "evidence", 64, 2000); requireUnique(values, "evidence", "STATE_INVALID_INPUT"); milestone.evidence = values; changes.evidence = [...values]; }
      if (content.linkedTodoIds !== undefined) { const values = stringList(content.linkedTodoIds, "linkedTodoIds", 64, 100); if (values.some((id) => !TODO_ID.test(id))) stateError("STATE_INVALID_LINK", "A linked todo ID is invalid"); requireUnique(values, "linkedTodoIds"); milestone.linkedTodoIds = values; changes.linkedTodoIds = [...values]; }
      if (content.status !== undefined) {
        requireString(content.status, "status"); const target = content.status as MilestoneStatus;
        if (!transitionAllowed(milestone.status, target)) stateError("STATE_INVALID_TRANSITION", `Milestone transition ${milestone.status} -> ${target} is not permitted`);
        if ((target === "in_progress" || target === "completed") && incompleteDependency(next, milestone)) stateError("STATE_INVALID_LINK", `Milestone ${milestone.id} has an incomplete dependency`);
        if (target === "completed" && milestone.evidence.length === 0) stateError("STATE_EVIDENCE_REQUIRED", `Milestone ${milestone.id} needs evidence before completion`);
        milestone.status = target; changes.status = target;
      }
      milestone.updatedAt = at; changes.updatedAt = at; ids = { updated: [next.id, milestone.id] };
      const record = recordFor(original, next, input.action, at, reason, ids); addRecord(next, record);
      data = { planId: next.id, baseRevision: original.revision, revision: next.revision, milestoneId: milestone.id, changes, revisionRecord: record };
    } else if (input.action === "record_decision") {
      const content = contentObject(input.content, ["decision"]); const decision: Decision = { id: `${next.id}-D${next.nextDecisionNumber}`, decision: stringValue(content.decision, "decision"), rationale: reason, at };
      next.decisions.push(decision); next.nextDecisionNumber++; ids = { added: [decision.id], updated: [next.id] }; const record = recordFor(original, next, input.action, at, reason, ids); addRecord(next, record);
      data = { planId: next.id, baseRevision: original.revision, revision: next.revision, decision, revisionRecord: record };
    } else if (input.action === "record_risk") {
      const content = contentObject(input.content, ["description", "impact", "mitigation"], ["status"]); const status = (content.status ?? "open") as RiskStatus;
      if (!["open", "mitigated", "accepted"].includes(status)) stateError("STATE_INVALID_INPUT", "Risk status is invalid");
      const risk: Risk = { id: `${next.id}-R${next.nextRiskNumber}`, description: stringValue(content.description, "risk description"), impact: stringValue(content.impact, "risk impact"), mitigation: stringValue(content.mitigation, "risk mitigation"), status };
      next.risks.push(risk); next.nextRiskNumber++; ids = { added: [risk.id], updated: [next.id] }; const record = recordFor(original, next, input.action, at, reason, ids); addRecord(next, record);
      data = { planId: next.id, baseRevision: original.revision, revision: next.revision, risk, revisionRecord: record };
    } else if (input.action === "record_question") {
      const content = contentObject(input.content, ["question"], ["status", "answer"]); const status = (content.status ?? "open") as QuestionStatus;
      if (status !== "open" && status !== "resolved") stateError("STATE_INVALID_INPUT", "Question status is invalid");
      if (status === "open" && content.answer !== undefined) stateError("STATE_INVALID_INPUT", "An open question cannot have an answer");
      const question: Question = { id: `${next.id}-Q${next.nextQuestionNumber}`, question: stringValue(content.question, "question"), status, ...(status === "resolved" ? { answer: stringValue(content.answer, "answer") } : {}) };
      next.openQuestions.push(question); next.nextQuestionNumber++; ids = { added: [question.id], updated: [next.id] }; const record = recordFor(original, next, input.action, at, reason, ids); addRecord(next, record);
      data = { planId: next.id, baseRevision: original.revision, revision: next.revision, question, revisionRecord: record };
    } else if (input.action === "checkpoint") {
      const content = contentObject(input.content, ["summary"], ["criterionEvidence"]); const raw = content.criterionEvidence ?? [];
      if (!Array.isArray(raw) || raw.length > 64) stateError("STATE_INVALID_INPUT", "criterionEvidence must be an array with at most 64 items");
      const links: CriterionEvidence[] = raw.map((item) => { exact(item, ["criterionId", "evidence"], [], "criterion evidence"); requireString(item.criterionId, "criterionId"); if (!next.acceptanceCriteria.some((criterion) => criterion.id === item.criterionId)) stateError("STATE_INVALID_LINK", "Criterion evidence names an unknown criterion"); return { criterionId: item.criterionId, evidence: stringValue(item.evidence, "evidence") }; });
      requireUnique(links.map((item) => item.criterionId), "criterionEvidence"); const checkpoint: Checkpoint = { id: `${next.id}-K${next.nextCheckpointNumber}`, summary: stringValue(content.summary, "summary"), criterionEvidence: links, at };
      next.checkpoints.push(checkpoint); next.nextCheckpointNumber++; ids = { added: [checkpoint.id], updated: [next.id, ...links.map((item) => item.criterionId)] }; const record = recordFor(original, next, input.action, at, reason, ids); addRecord(next, record);
      data = { planId: next.id, baseRevision: original.revision, revision: next.revision, checkpoint, criterionLinks: links, revisionRecord: record };
    } else {
      const from = next.status; let to: WorkplanStatus;
      if (input.action === "pause") { if (from !== "active") stateError("STATE_INVALID_TRANSITION", "Only an active workplan can pause"); to = "paused"; }
      else if (input.action === "resume") { if (from !== "draft" && from !== "paused") stateError("STATE_INVALID_TRANSITION", "Only a draft or paused workplan can resume"); if (current.plans.some((plan) => plan.id !== next.id && plan.status === "active")) stateError("STATE_CONFLICT", "Another workplan is active"); to = "active"; }
      else if (input.action === "complete") {
        if (from !== "active" && from !== "paused") stateError("STATE_INVALID_TRANSITION", "Only an active or paused workplan can complete");
        if (next.milestones.some((item) => item.status !== "completed")) stateError("STATE_EVIDENCE_REQUIRED", "Every milestone must be completed before workplan completion");
        const evidenced = new Set(next.checkpoints.flatMap((item) => item.criterionEvidence.map((link) => link.criterionId)));
        if (next.acceptanceCriteria.some((item) => !evidenced.has(item.id))) stateError("STATE_EVIDENCE_REQUIRED", "Every plan criterion needs checkpoint evidence before completion"); to = "completed";
      } else { if (from === "active" || !["draft", "paused", "completed"].includes(from)) stateError("STATE_INVALID_TRANSITION", "An active workplan must pause before archive"); to = "archived"; }
      next.status = to; const record = recordFor(original, next, input.action, at, reason, { updated: [next.id] }); addRecord(next, record);
      data = { planId: next.id, baseRevision: original.revision, revision: next.revision, from, to, revisionRecord: record };
    }
    validateWorkplan(next, "STATE_LIMIT_EXCEEDED");
  }
  const event = makeStateEvent("workplan", input.action as WorkplanMutationAction, current.stateRevision, at, data) as WorkplanEvent;
  const state = applyWorkplanEvent(current, event);
  const planId = input.action === "create" ? (data.plan as Workplan).id : data.planId;
  return { state, event, result: { planId, revision: input.action === "create" ? 1 : data.revision, action: input.action } };
}

function continued(prefix: string, value: string): string[] {
  const [first = "", ...rest] = value.split("\n");
  return [`${prefix}${first}`, ...rest.map((line) => `  ${line}`)];
}
function block(value: string): string[] { return continued("", value); }
function labeled(label: string, value: string): string[] { return continued(`${label}: `, value); }
function listLines(values: string[]): string[] {
  return values.length
    ? values.flatMap((value) => {
      const [first = "", ...rest] = value.split("\n");
      return [`- ${first}`, ...rest.map((line) => `  ${line}`)];
    })
    : ["None"];
}
function heading(lines: string[], name: string, values: string[]): void { lines.push(`## ${name}`, ...listLines(values), ""); }

export function renderWorkplan(plan: Workplan): string {
  const lines: string[] = [
    ...continued(`# ${plan.id}: `, plan.title),
    `Status: ${plan.status}`,
    `Revision: ${plan.revision}`,
    `Created: ${plan.createdAt}`,
    `Updated: ${plan.updatedAt}`,
    "",
    "## Objective", ...block(plan.objective), "",
    "## Background", ...(plan.background !== undefined && plan.background !== "" ? block(plan.background) : ["None"]), "",
  ];
  heading(lines, "Scope", plan.scope); heading(lines, "Non-goals", plan.nonGoals); heading(lines, "Constraints", plan.constraints);
  lines.push("## Approach", ...block(plan.approach), "", "## Milestones");
  if (!plan.milestones.length) lines.push("None");
  for (const item of sorted(plan.milestones)) {
    lines.push(...continued(`### ${item.id}: `, item.title), `Status: ${item.status}`, ...labeled("Description", item.description ?? "None"), `Depends on: ${item.dependsOn.length ? item.dependsOn.join(", ") : "None"}`, "Acceptance criteria:", ...listLines(item.acceptanceCriteria), "Evidence:", ...listLines(item.evidence), `Linked todo IDs (unverified external references): ${item.linkedTodoIds.length ? item.linkedTodoIds.join(", ") : "None"}`, `Created: ${item.createdAt}`, `Updated: ${item.updatedAt}`, "");
  }
  lines.push("## Acceptance criteria");
  if (!plan.acceptanceCriteria.length) lines.push("None");
  for (const item of sorted(plan.acceptanceCriteria)) {
    const links = sorted(plan.checkpoints).flatMap((checkpoint) => checkpoint.criterionEvidence.filter((link) => link.criterionId === item.id).map((link) => `${checkpoint.id}: ${link.evidence}`));
    lines.push(`### ${item.id}`, ...block(item.text), "Evidence:", ...listLines(links), "");
  }
  heading(lines, "Verification", plan.verification);
  lines.push("## Risks");
  if (!plan.risks.length) lines.push("None");
  for (const item of sorted(plan.risks)) lines.push(`### ${item.id}`, `Status: ${item.status}`, ...labeled("Description", item.description), ...labeled("Impact", item.impact), ...labeled("Mitigation", item.mitigation), "");
  lines.push("## Open questions");
  if (!plan.openQuestions.length) lines.push("None");
  for (const item of sorted(plan.openQuestions)) lines.push(`### ${item.id}`, `Status: ${item.status}`, ...labeled("Question", item.question), ...labeled("Answer", item.answer ?? "None"), "");
  lines.push("## Decisions");
  if (!plan.decisions.length) lines.push("None");
  for (const item of sorted(plan.decisions)) lines.push(`### ${item.id}`, ...labeled("Decision", item.decision), ...labeled("Rationale", item.rationale), `At: ${item.at}`, "");
  lines.push("## Checkpoints");
  if (!plan.checkpoints.length) lines.push("None");
  for (const item of sorted(plan.checkpoints)) lines.push(`### ${item.id}`, ...labeled("Summary", item.summary), "Criterion evidence:", ...listLines(item.criterionEvidence.map((link) => `${link.criterionId}: ${link.evidence}`)), `At: ${item.at}`, "");
  lines.push("## Revisions");
  for (const item of plan.revisions.slice().sort((a, b) => a.planRevision - b.planRevision)) lines.push(`### Revision ${item.planRevision}`, `Action: ${item.action}`, `Section: ${item.section ?? "None"}`, `Added IDs: ${item.addedIds.length ? item.addedIds.join(", ") : "None"}`, `Updated IDs: ${item.updatedIds.length ? item.updatedIds.join(", ") : "None"}`, `Removed IDs: ${item.removedIds.length ? item.removedIds.join(", ") : "None"}`, `Before SHA-256: ${item.beforeDigest}`, `After SHA-256: ${item.afterDigest}`, ...labeled("Rationale", item.rationale), `Actor: ${item.actor}`, `At: ${item.at}`, "");
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

export function workplanContextLine(state: WorkplanState): string | undefined {
  if (!state.plans.length) return undefined;
  const active = state.plans.find((plan) => plan.status === "active");
  if (!active) return "[workplan state] active=none status=none rev=0 milestones=0/0 blocked=0";
  const completed = active.milestones.filter((item) => item.status === "completed").length;
  const blocked = active.milestones.filter((item) => item.status === "blocked").length;
  return `[workplan state] active=${active.id} status=${active.status} rev=${active.revision} milestones=${completed}/${active.milestones.length} blocked=${blocked}`;
}
