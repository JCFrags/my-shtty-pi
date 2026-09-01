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
export interface Checkpoint {
  id: string;
  summary: string;
  currentFocus?: string;
  nextActions?: string[];
  criterionEvidence: CriterionEvidence[];
  at: string;
}
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
  | "create" | "list" | "status" | "read" | "recover" | "revise" | "add_milestone"
  | "update_milestone" | "record_decision" | "record_risk" | "record_question"
  | "checkpoint" | "pause" | "resume" | "complete" | "archive";
export type WorkplanMutationAction = Exclude<WorkplanAction, "list" | "status" | "read" | "recover">;
export type WorkplanSection =
  | "title" | "objective" | "background" | "scope" | "nonGoals" | "constraints"
  | "approach" | "acceptanceCriteria" | "verification" | "risks" | "openQuestions"
  | "non_goals" | "acceptance_criteria" | "open_questions";

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
  "create", "list", "status", "read", "recover", "revise", "add_milestone", "update_milestone", "record_decision",
  "record_risk", "record_question", "checkpoint", "pause", "resume", "complete", "archive",
]);
const SECTIONS = new Set<WorkplanSection>([
  "title", "objective", "background", "scope", "nonGoals", "constraints", "approach", "acceptanceCriteria",
  "verification", "risks", "openQuestions", "non_goals", "acceptance_criteria", "open_questions",
]);
const SECTION_ALIASES: Partial<Record<WorkplanSection, WorkplanSection>> = {
  non_goals: "nonGoals",
  acceptance_criteria: "acceptanceCriteria",
  open_questions: "openQuestions",
};
const KIB = 1024;
const MIB = 1024 * KIB;

export const WORKPLAN_LIMITS = Object.freeze({
  retainedPlans: 256,
  openPlans: 64,
  listItems: 1024,
  titleCodePoints: 4 * KIB,
  listItemCodePoints: 16 * KIB,
  narrativeCodePoints: 64 * KIB,
  backgroundBytes: 1 * MIB,
  approachBytes: 4 * MIB,
  milestones: 4096,
  planCriteria: 4096,
  records: 8192,
  checkpoints: 16384,
  milestoneListItems: 4096,
  checkpointNextActions: 256,
  canonicalPlanBytes: 64 * MIB,
});

const PLAN_ID = /^WP([1-9][0-9]*)$/;
const TODO_ID = /^T[1-9][0-9]*$/;
const HEX = /^[0-9a-f]{64}$/;

export function emptyWorkplanState(): WorkplanState { return { plans: [], nextPlanNumber: 1, stateRevision: 0 } }
export function cloneWorkplanState(state: WorkplanState): WorkplanState { return cloneJson(state) }

function exact(value: unknown, required: readonly string[], optional: readonly string[] = [], field = "content", code: StateErrorCode = "STATE_INVALID_INPUT"): asserts value is Record<string, unknown> {
  requireExactObject(value, required, optional, field, code);
}
function stringValue(value: unknown, field: string, maximum: number = WORKPLAN_LIMITS.narrativeCodePoints, allowBlank = false, code: StateErrorCode = "STATE_INVALID_INPUT"): string {
  requireString(value, field, code);
  const result = normalizeStateText(value);
  if (!allowBlank) requireNonBlank(result, field);
  requireCodePoints(result, maximum, field);
  return result;
}
function stringList(value: unknown, field: string, maximumItems: number = WORKPLAN_LIMITS.listItems, maximumPoints: number = WORKPLAN_LIMITS.listItemCodePoints, code: StateErrorCode = "STATE_INVALID_INPUT"): string[] {
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
function rationale(value: unknown): string { return stringValue(value, "rationale") }
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
  if ([...value.rationale].length > WORKPLAN_LIMITS.narrativeCodePoints || !/\S/u.test(value.rationale)) stateError(code, "A revision rationale is invalid");
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
  if (typeof plan.title !== "string" || !/\S/u.test(plan.title) || [...plan.title].length > WORKPLAN_LIMITS.titleCodePoints) stateError(code, "A workplan title is invalid");
  if (typeof plan.objective !== "string" || !/\S/u.test(plan.objective) || [...plan.objective].length > WORKPLAN_LIMITS.narrativeCodePoints) stateError(code, "A workplan objective is invalid");
  if (plan.background !== undefined && (typeof plan.background !== "string" || Buffer.byteLength(plan.background, "utf8") > WORKPLAN_LIMITS.backgroundBytes)) stateError(code, "A workplan background is invalid");
  if (typeof plan.approach !== "string" || !/\S/u.test(plan.approach) || Buffer.byteLength(plan.approach, "utf8") > WORKPLAN_LIMITS.approachBytes) stateError(code, "A workplan approach is invalid");
  for (const [name, values] of [["scope", plan.scope], ["nonGoals", plan.nonGoals], ["constraints", plan.constraints], ["verification", plan.verification]] as const) {
    if (!Array.isArray(values) || values.length > WORKPLAN_LIMITS.listItems || !values.every((item) => typeof item === "string" && /\S/u.test(item) && [...item].length <= WORKPLAN_LIMITS.listItemCodePoints)) stateError(code, `Workplan ${name} is invalid`);
  }
  if (plan.milestones.length > WORKPLAN_LIMITS.milestones || plan.acceptanceCriteria.length > WORKPLAN_LIMITS.planCriteria || plan.decisions.length > WORKPLAN_LIMITS.records || plan.risks.length > WORKPLAN_LIMITS.records || plan.openQuestions.length > WORKPLAN_LIMITS.records || plan.checkpoints.length > WORKPLAN_LIMITS.checkpoints) stateError(code, "A workplan collection limit is exceeded");

  const childPattern = (kind: string) => new RegExp(`^${plan.id}-${kind}([1-9][0-9]*)$`);
  validateIds(plan.milestones, childPattern("M"), plan.nextMilestoneNumber, "milestone", code);
  validateIds(plan.acceptanceCriteria, childPattern("C"), plan.nextCriterionNumber, "criterion", code);
  validateIds(plan.decisions, childPattern("D"), plan.nextDecisionNumber, "decision", code);
  validateIds(plan.risks, childPattern("R"), plan.nextRiskNumber, "risk", code);
  validateIds(plan.openQuestions, childPattern("Q"), plan.nextQuestionNumber, "question", code);
  validateIds(plan.checkpoints, childPattern("K"), plan.nextCheckpointNumber, "checkpoint", code);

  for (const criterion of plan.acceptanceCriteria) {
    exact(criterion, ["id", "text"], [], "criterion", code);
    if (typeof criterion.text !== "string" || !/\S/u.test(criterion.text) || [...criterion.text].length > WORKPLAN_LIMITS.narrativeCodePoints) stateError(code, "A criterion is invalid");
  }
  for (const milestone of plan.milestones) {
    exact(milestone, ["id", "title", "dependsOn", "acceptanceCriteria", "status", "evidence", "linkedTodoIds", "createdAt", "updatedAt"], ["description"], "milestone", code);
    if (typeof milestone.title !== "string" || !/\S/u.test(milestone.title) || [...milestone.title].length > WORKPLAN_LIMITS.narrativeCodePoints) stateError(code, "A milestone title is invalid");
    if (milestone.description !== undefined && (typeof milestone.description !== "string" || [...milestone.description].length > WORKPLAN_LIMITS.narrativeCodePoints)) stateError(code, "A milestone description is invalid");
    if (!Array.isArray(milestone.dependsOn) || !Array.isArray(milestone.acceptanceCriteria) || !Array.isArray(milestone.evidence) || !Array.isArray(milestone.linkedTodoIds)) stateError(code, "A milestone list is invalid");
    if (milestone.dependsOn.length > WORKPLAN_LIMITS.milestoneListItems || milestone.acceptanceCriteria.length > WORKPLAN_LIMITS.milestoneListItems || milestone.evidence.length > WORKPLAN_LIMITS.milestoneListItems || milestone.linkedTodoIds.length > WORKPLAN_LIMITS.milestoneListItems) stateError(code, "A milestone list limit is exceeded");
    if (!milestone.acceptanceCriteria.every((item) => typeof item === "string" && /\S/u.test(item) && [...item].length <= WORKPLAN_LIMITS.narrativeCodePoints)) stateError(code, "A milestone criterion is invalid");
    if (!milestone.evidence.every((item) => typeof item === "string" && /\S/u.test(item) && [...item].length <= WORKPLAN_LIMITS.narrativeCodePoints)) stateError(code, "Milestone evidence is invalid");
    if (!milestone.linkedTodoIds.every((id) => typeof id === "string" && TODO_ID.test(id))) stateError(code, "A linked todo ID is invalid");
    for (const values of [milestone.acceptanceCriteria, milestone.evidence, milestone.linkedTodoIds]) if (new Set(values).size !== values.length) stateError(code, "A milestone list contains a duplicate");
    if (!["pending", "in_progress", "blocked", "completed"].includes(milestone.status) || typeof milestone.createdAt !== "string" || typeof milestone.updatedAt !== "string") stateError(code, "A milestone status or time is invalid");
    if (milestone.status === "completed" && milestone.evidence.length === 0) stateError(code, "A completed milestone has no evidence");
  }
  validateGraph(plan, code);
  for (const decision of plan.decisions) {
    exact(decision, ["id", "decision", "rationale", "at"], [], "decision", code);
    if (![decision.decision, decision.rationale].every((item) => typeof item === "string" && /\S/u.test(item) && [...item].length <= WORKPLAN_LIMITS.narrativeCodePoints) || typeof decision.at !== "string") stateError(code, "A decision is invalid");
  }
  for (const risk of plan.risks) {
    exact(risk, ["id", "description", "impact", "mitigation", "status"], [], "risk", code);
    if (![risk.description, risk.impact, risk.mitigation].every((item) => typeof item === "string" && /\S/u.test(item) && [...item].length <= WORKPLAN_LIMITS.narrativeCodePoints) || !["open", "mitigated", "accepted"].includes(risk.status)) stateError(code, "A risk is invalid");
  }
  for (const question of plan.openQuestions) {
    exact(question, ["id", "question", "status"], ["answer"], "question", code);
    if (typeof question.question !== "string" || !/\S/u.test(question.question) || [...question.question].length > WORKPLAN_LIMITS.narrativeCodePoints || !["open", "resolved"].includes(question.status)) stateError(code, "A question is invalid");
    if (question.status === "open" && question.answer !== undefined) stateError(code, "An open question has an answer");
    if (question.status === "resolved" && (typeof question.answer !== "string" || !/\S/u.test(question.answer) || [...question.answer].length > WORKPLAN_LIMITS.narrativeCodePoints)) stateError(code, "A resolved question has no valid answer");
  }
  const criterionIds = new Set(plan.acceptanceCriteria.map((item) => item.id));
  for (const checkpoint of plan.checkpoints) {
    exact(checkpoint, ["id", "summary", "criterionEvidence", "at"], ["currentFocus", "nextActions"], "checkpoint", code);
    if (typeof checkpoint.summary !== "string" || !/\S/u.test(checkpoint.summary) || [...checkpoint.summary].length > WORKPLAN_LIMITS.narrativeCodePoints || typeof checkpoint.at !== "string" || !Array.isArray(checkpoint.criterionEvidence) || checkpoint.criterionEvidence.length > WORKPLAN_LIMITS.planCriteria) stateError(code, "A checkpoint is invalid");
    if (checkpoint.currentFocus !== undefined && (typeof checkpoint.currentFocus !== "string" || !/\S/u.test(checkpoint.currentFocus) || [...checkpoint.currentFocus].length > WORKPLAN_LIMITS.narrativeCodePoints)) stateError(code, "A checkpoint current focus is invalid");
    if (checkpoint.nextActions !== undefined && (!Array.isArray(checkpoint.nextActions) || checkpoint.nextActions.length > WORKPLAN_LIMITS.checkpointNextActions || !checkpoint.nextActions.every((item) => typeof item === "string" && /\S/u.test(item) && [...item].length <= WORKPLAN_LIMITS.narrativeCodePoints) || new Set(checkpoint.nextActions).size !== checkpoint.nextActions.length)) stateError(code, "Checkpoint next actions are invalid");
    const links = new Set<string>();
    for (const evidence of checkpoint.criterionEvidence) {
      exact(evidence, ["criterionId", "evidence"], [], "criterion evidence", code);
      if (typeof evidence.criterionId !== "string" || !criterionIds.has(evidence.criterionId) || links.has(evidence.criterionId) || typeof evidence.evidence !== "string" || !/\S/u.test(evidence.evidence) || [...evidence.evidence].length > WORKPLAN_LIMITS.narrativeCodePoints) stateError(code, "Criterion evidence is invalid");
      links.add(evidence.criterionId);
    }
  }
  if (!Array.isArray(plan.revisions) || plan.revisions.length !== plan.revision) stateError(code, "Workplan revision history is incomplete");
  plan.revisions.forEach((record, index) => {
    validateRevisionRecord(record, plan.id, code);
    if (record.planRevision !== index + 1) stateError(code, "Workplan revision history is out of order");
  });
  if (Buffer.byteLength(stableJson(plan), "utf8") > WORKPLAN_LIMITS.canonicalPlanBytes) stateError(code, "The canonical workplan limit is exceeded");
}

export function validateWorkplanState(state: WorkplanState): void {
  requirePlainJson(state, "workplan state");
  exact(state, ["plans", "nextPlanNumber", "stateRevision"], [], "workplan state", "STATE_CORRUPT");
  if (!Array.isArray(state.plans) || state.plans.length > WORKPLAN_LIMITS.retainedPlans) stateError("STATE_CORRUPT", "The retained workplan count is invalid");
  const openPlans = state.plans.filter((plan) => plan.status === "draft" || plan.status === "active" || plan.status === "paused");
  if (openPlans.length > WORKPLAN_LIMITS.openPlans) stateError("STATE_CORRUPT", "The open workplan count is invalid");
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

function canonicalSection(section: WorkplanSection): WorkplanSection { return SECTION_ALIASES[section] ?? section }

function setSection(plan: Workplan, sectionValue: WorkplanSection, value: unknown): void {
  const section = canonicalSection(sectionValue);
  if (section === "title" || section === "objective" || section === "approach") plan[section] = value as string;
  else if (section === "background") plan.background = value as string;
  else if (section === "scope") plan.scope = cloneJson(value as string[]);
  else if (section === "nonGoals") plan.nonGoals = cloneJson(value as string[]);
  else if (section === "constraints") plan.constraints = cloneJson(value as string[]);
  else if (section === "verification") plan.verification = cloneJson(value as string[]);
  else if (section === "acceptanceCriteria") plan.acceptanceCriteria = cloneJson(value as PlanCriterion[]);
  else if (section === "risks") plan.risks = cloneJson(value as Risk[]);
  else plan.openQuestions = cloneJson(value as Question[]);
}

export function applyWorkplanEvent(current: WorkplanState, value: unknown): WorkplanState {
  validateWorkplanState(current);
  validateStateEventEnvelope(value, "workplan", current.stateRevision);
  if (!ACTIONS.has(value.action as WorkplanAction) || ["list", "status", "read", "recover"].includes(value.action)) stateError("STATE_CORRUPT", "The workplan event action is invalid");
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
      const canonical = canonicalSection(revisedSection);
      setSection(next, canonical, data.value);
      if (canonical === "acceptanceCriteria") {
        next.nextCriterionNumber = Math.max(next.nextCriterionNumber, ...next.acceptanceCriteria.map((item) => idNumber(item.id) + 1));
      } else if (canonical === "risks") {
        next.nextRiskNumber = Math.max(next.nextRiskNumber, ...next.risks.map((item) => idNumber(item.id) + 1));
      } else if (canonical === "openQuestions") {
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
  if (!Array.isArray(value) || value.length > WORKPLAN_LIMITS.planCriteria) stateError("STATE_INVALID_INPUT", `${field} must be an array with at most ${WORKPLAN_LIMITS.planCriteria} items`);
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
  if (!Array.isArray(value) || value.length > WORKPLAN_LIMITS.records) stateError("STATE_INVALID_INPUT", `risks must be an array with at most ${WORKPLAN_LIMITS.records} items`);
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
  if (!Array.isArray(value) || value.length > WORKPLAN_LIMITS.records) stateError("STATE_INVALID_INPUT", `open_questions must be an array with at most ${WORKPLAN_LIMITS.records} items`);
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
  if (!Array.isArray(criteriaRaw) || criteriaRaw.length > WORKPLAN_LIMITS.planCriteria || !criteriaRaw.every((item) => typeof item === "string")) stateError("STATE_INVALID_INPUT", `acceptanceCriteria must be an array of at most ${WORKPLAN_LIMITS.planCriteria} strings`);
  let background: string | undefined;
  if (content.background !== undefined) {
    requireString(content.background, "background");
    background = normalizeStateText(content.background);
    requireUtf8(background, WORKPLAN_LIMITS.backgroundBytes, "background");
  }
  let criterion = 1;
  const plan: Workplan = {
    id,
    title: stringValue(content.title, "title", WORKPLAN_LIMITS.titleCodePoints),
    objective: stringValue(content.objective, "objective"),
    ...(background !== undefined ? { background } : {}),
    scope: content.scope === undefined ? [] : stringList(content.scope, "scope"),
    nonGoals: content.nonGoals === undefined ? [] : stringList(content.nonGoals, "nonGoals"),
    constraints: content.constraints === undefined ? [] : stringList(content.constraints, "constraints"),
    approach: stringValue(content.approach, "approach", WORKPLAN_LIMITS.approachBytes),
    milestones: [],
    acceptanceCriteria: criteriaRaw.map((text) => ({ id: `${id}-C${criterion++}`, text: stringValue(text, "criterion") })),
    verification: content.verification === undefined ? [] : stringList(content.verification, "verification"),
    risks: [], openQuestions: [], decisions: [], checkpoints: [], revisions: [], status: "draft", revision: 1,
    createdAt: at, updatedAt: at, nextMilestoneNumber: 1, nextCriterionNumber: criterion, nextDecisionNumber: 1,
    nextRiskNumber: 1, nextQuestionNumber: 1, nextCheckpointNumber: 1,
  };
  requireUtf8(plan.approach, WORKPLAN_LIMITS.approachBytes, "approach");
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
  if (input.action === "status" || input.action === "read" || input.action === "recover") {
    allowed(input, ["planId"]);
    if (typeof input.planId !== "string" || !PLAN_ID.test(input.planId)) stateError("STATE_INVALID_INPUT", "planId must be a workplan ID");
    const plan = planById(current, input.planId);
    if (input.action === "read") return { state: current, result: renderWorkplan(plan) };
    if (input.action === "recover") return { state: current, result: renderWorkplanRecovery(plan) };
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
    const openPlans = current.plans.filter((plan) => plan.status === "draft" || plan.status === "active" || plan.status === "paused");
    if (openPlans.length >= WORKPLAN_LIMITS.openPlans) stateError("STATE_LIMIT_EXCEEDED", `The branch can contain at most ${WORKPLAN_LIMITS.openPlans} open workplans; complete or archive one before creating another`);
    if (current.plans.length >= WORKPLAN_LIMITS.retainedPlans) stateError("STATE_LIMIT_EXCEEDED", `The branch can retain at most ${WORKPLAN_LIMITS.retainedPlans} workplans`);
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
      section = canonicalSection(input.section);
      if (section === "title") setSection(next, section, stringValue(input.content, "title", WORKPLAN_LIMITS.titleCodePoints));
      else if (section === "objective") setSection(next, section, stringValue(input.content, "objective"));
      else if (section === "background") { const text = stringValue(input.content, "background", WORKPLAN_LIMITS.backgroundBytes, true); requireUtf8(text, WORKPLAN_LIMITS.backgroundBytes, "background"); setSection(next, section, text); }
      else if (section === "approach") { const text = stringValue(input.content, "approach", WORKPLAN_LIMITS.approachBytes); requireUtf8(text, WORKPLAN_LIMITS.approachBytes, "approach"); setSection(next, section, text); }
      else if (["scope", "nonGoals", "constraints", "verification"].includes(section)) setSection(next, section, stringList(input.content, section));
      else if (section === "acceptanceCriteria") { const change = criteriaInput(input.content, next); setSection(next, section, change.values); ids = change; }
      else if (section === "risks") { const change = risksInput(input.content, next); setSection(next, section, change.values); ids = change; }
      else { const change = questionsInput(input.content, next); setSection(next, section, change.values); ids = change; }
      const record = recordFor(original, next, input.action, at, reason, ids, section); addRecord(next, record);
      data = { planId: next.id, baseRevision: original.revision, revision: next.revision, section, value: cloneJson(section === "nonGoals" ? next.nonGoals : section === "acceptanceCriteria" ? next.acceptanceCriteria : section === "openQuestions" ? next.openQuestions : next[section as keyof Workplan]), revisionRecord: record };
    } else if (input.action === "add_milestone") {
      const content = contentObject(input.content, ["title"], ["description", "dependsOn", "acceptanceCriteria"]);
      if (next.milestones.length >= WORKPLAN_LIMITS.milestones) stateError("STATE_LIMIT_EXCEEDED", `A workplan can contain at most ${WORKPLAN_LIMITS.milestones} milestones`);
      const id = `${next.id}-M${next.nextMilestoneNumber}`;
      const dependencies = content.dependsOn === undefined ? [] : stringList(content.dependsOn, "dependsOn", WORKPLAN_LIMITS.milestoneListItems, 100);
      requireUnique(dependencies, "dependsOn");
      if (dependencies.includes(id) || dependencies.some((dependency) => !next.milestones.some((item) => item.id === dependency))) stateError("STATE_INVALID_LINK", "A milestone dependency is unknown or self-referential");
      const milestone: Milestone = { id, title: stringValue(content.title, "milestone title"), ...(content.description !== undefined ? { description: stringValue(content.description, "description", WORKPLAN_LIMITS.narrativeCodePoints, true) } : {}), dependsOn: dependencies, acceptanceCriteria: content.acceptanceCriteria === undefined ? [] : stringList(content.acceptanceCriteria, "acceptanceCriteria", WORKPLAN_LIMITS.milestoneListItems, WORKPLAN_LIMITS.narrativeCodePoints), status: "pending", evidence: [], linkedTodoIds: [], createdAt: at, updatedAt: at };
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
        else { milestone.description = stringValue(content.description, "description", WORKPLAN_LIMITS.narrativeCodePoints, true); changes.description = milestone.description; }
      }
      if (content.dependsOn !== undefined) { const values = stringList(content.dependsOn, "dependsOn", WORKPLAN_LIMITS.milestoneListItems, 100); milestone.dependsOn = validateDependencies(next, milestone.id, values); changes.dependsOn = [...values]; }
      if (content.evidence !== undefined) { const values = stringList(content.evidence, "evidence", WORKPLAN_LIMITS.milestoneListItems, WORKPLAN_LIMITS.narrativeCodePoints); requireUnique(values, "evidence", "STATE_INVALID_INPUT"); milestone.evidence = values; changes.evidence = [...values]; }
      if (content.linkedTodoIds !== undefined) { const values = stringList(content.linkedTodoIds, "linkedTodoIds", WORKPLAN_LIMITS.milestoneListItems, 100); if (values.some((id) => !TODO_ID.test(id))) stateError("STATE_INVALID_LINK", "A linked todo ID is invalid"); requireUnique(values, "linkedTodoIds"); milestone.linkedTodoIds = values; changes.linkedTodoIds = [...values]; }
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
      const content = contentObject(input.content, ["summary"], ["currentFocus", "nextActions", "criterionEvidence"]); const raw = content.criterionEvidence ?? [];
      if (!Array.isArray(raw) || raw.length > WORKPLAN_LIMITS.planCriteria) stateError("STATE_INVALID_INPUT", `criterionEvidence must be an array with at most ${WORKPLAN_LIMITS.planCriteria} items`);
      const links: CriterionEvidence[] = raw.map((item) => { exact(item, ["criterionId", "evidence"], [], "criterion evidence"); requireString(item.criterionId, "criterionId"); if (!next.acceptanceCriteria.some((criterion) => criterion.id === item.criterionId)) stateError("STATE_INVALID_LINK", "Criterion evidence names an unknown criterion"); return { criterionId: item.criterionId, evidence: stringValue(item.evidence, "evidence") }; });
      const nextActions = content.nextActions === undefined ? undefined : stringList(content.nextActions, "nextActions", WORKPLAN_LIMITS.checkpointNextActions, WORKPLAN_LIMITS.narrativeCodePoints);
      if (nextActions) requireUnique(nextActions, "nextActions", "STATE_INVALID_INPUT");
      requireUnique(links.map((item) => item.criterionId), "criterionEvidence");
      const checkpoint: Checkpoint = {
        id: `${next.id}-K${next.nextCheckpointNumber}`,
        summary: stringValue(content.summary, "summary"),
        ...(content.currentFocus !== undefined ? { currentFocus: stringValue(content.currentFocus, "currentFocus") } : {}),
        ...(nextActions ? { nextActions } : {}),
        criterionEvidence: links,
        at,
      };
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

function planSummaryLines(plan: Workplan): string[] {
  const completed = plan.milestones.filter((item) => item.status === "completed").length;
  const blocked = plan.milestones.filter((item) => item.status === "blocked").length;
  const evidenced = new Set(plan.checkpoints.flatMap((item) => item.criterionEvidence.map((link) => link.criterionId))).size;
  return [
    ...continued("Plan: ", `${plan.id}: ${plan.title}`),
    ...labeled("Objective", plan.objective),
    `Status: ${plan.status}`,
    `Revision: ${plan.revision}`,
    `Milestones: ${completed}/${plan.milestones.length} completed; ${blocked} blocked`,
    `Plan criteria with evidence: ${evidenced}/${plan.acceptanceCriteria.length}`,
  ];
}

function milestoneLines(item: Milestone): string[] {
  return [
    ...continued(`### ${item.id}: `, item.title),
    `Status: ${item.status}`,
    ...labeled("Description", item.description ?? "None"),
    `Depends on: ${item.dependsOn.length ? item.dependsOn.join(", ") : "None"}`,
    "Acceptance criteria:", ...listLines(item.acceptanceCriteria),
    "Evidence:", ...listLines(item.evidence),
    `Linked todo IDs (unverified external references): ${item.linkedTodoIds.length ? item.linkedTodoIds.join(", ") : "None"}`,
    `Created: ${item.createdAt}`,
    `Updated: ${item.updatedAt}`,
  ];
}

function checkpointLines(item: Checkpoint): string[] {
  return [
    `### ${item.id}`,
    ...labeled("Summary", item.summary),
    ...labeled("Current focus", item.currentFocus ?? "None"),
    "Next actions:", ...listLines(item.nextActions ?? []),
    "Criterion evidence:", ...listLines(item.criterionEvidence.map((link) => `${link.criterionId}: ${link.evidence}`)),
    `At: ${item.at}`,
  ];
}

function mutationPlan(state: WorkplanState, event: WorkplanEvent): Workplan {
  const value = event.action === "create" ? (event.data.plan as { id?: unknown } | undefined)?.id : event.data.planId;
  if (typeof value !== "string") stateError("STATE_CORRUPT", "A workplan mutation result has no plan ID");
  return planById(state, value);
}

function revisedSectionLines(plan: Workplan, section: WorkplanSection): string[] {
  const canonical = canonicalSection(section);
  if (canonical === "title") return block(plan.title);
  if (canonical === "objective") return block(plan.objective);
  if (canonical === "background") return plan.background ? block(plan.background) : ["None"];
  if (canonical === "approach") return block(plan.approach);
  if (canonical === "scope") return listLines(plan.scope);
  if (canonical === "nonGoals") return listLines(plan.nonGoals);
  if (canonical === "constraints") return listLines(plan.constraints);
  if (canonical === "verification") return listLines(plan.verification);
  if (canonical === "acceptanceCriteria") return plan.acceptanceCriteria.length ? sorted(plan.acceptanceCriteria).flatMap((item) => [`### ${item.id}`, ...block(item.text), ""]) : ["None"];
  if (canonical === "risks") return plan.risks.length ? sorted(plan.risks).flatMap((item) => [`### ${item.id}`, `Status: ${item.status}`, ...labeled("Description", item.description), ...labeled("Impact", item.impact), ...labeled("Mitigation", item.mitigation), ""]) : ["None"];
  return plan.openQuestions.length ? sorted(plan.openQuestions).flatMap((item) => [`### ${item.id}`, `Status: ${item.status}`, ...labeled("Question", item.question), ...labeled("Answer", item.answer ?? "None"), ""]) : ["None"];
}

export function renderWorkplanList(state: WorkplanState): string {
  const lines = ["# Workplans"];
  if (!state.plans.length) lines.push("None");
  for (const plan of sorted(state.plans)) lines.push("", ...continued(`## ${plan.id}: `, plan.title), `Status: ${plan.status}`, `Revision: ${plan.revision}`, ...labeled("Objective", plan.objective), `Updated: ${plan.updatedAt}`);
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

export function renderWorkplanStatus(plan: Workplan): string {
  const latestCheckpoint = sorted(plan.checkpoints).at(-1);
  const lines = [`# Workplan status`, ...planSummaryLines(plan), "", "## Milestones"];
  if (!plan.milestones.length) lines.push("None");
  for (const item of sorted(plan.milestones)) lines.push(`- ${item.id} [${item.status}]: ${item.title}`);
  lines.push("", "## Latest checkpoint", ...(latestCheckpoint ? checkpointLines(latestCheckpoint) : ["None"]));
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

export function renderWorkplanMutation(state: WorkplanState, event: WorkplanEvent): string {
  const plan = mutationPlan(state, event);
  if (event.action === "create") return `# Workplan created\n\n${renderWorkplan(plan)}`;
  const revision = plan.revisions.find((item) => item.planRevision === plan.revision);
  if (!revision) stateError("STATE_CORRUPT", "A workplan mutation result has no matching revision record");
  const lines = ["# Workplan updated", `Action: ${event.action}`, ...planSummaryLines(plan), ...labeled("Rationale", revision.rationale), "", "## What changed"];
  if (event.action === "add_milestone") {
    const id = revision.addedIds.find((value) => /^WP[1-9][0-9]*-M[1-9][0-9]*$/.test(value));
    const item = plan.milestones.find((value) => value.id === id);
    if (!item) stateError("STATE_CORRUPT", "The added milestone is unavailable");
    lines.push(...milestoneLines(item));
  } else if (event.action === "update_milestone") {
    const id = event.data.milestoneId;
    const item = typeof id === "string" ? plan.milestones.find((value) => value.id === id) : undefined;
    if (!item) stateError("STATE_CORRUPT", "The updated milestone is unavailable");
    const changes = event.data.changes && typeof event.data.changes === "object" && !Array.isArray(event.data.changes) ? Object.keys(event.data.changes) : [];
    lines.push(`Changed fields: ${changes.length ? changes.join(", ") : "None"}`, ...milestoneLines(item));
  } else if (event.action === "record_decision") {
    const id = revision.addedIds.find((value) => /^WP[1-9][0-9]*-D[1-9][0-9]*$/.test(value));
    const item = plan.decisions.find((value) => value.id === id);
    if (!item) stateError("STATE_CORRUPT", "The recorded decision is unavailable");
    lines.push(`### ${item.id}`, ...labeled("Decision", item.decision), ...labeled("Rationale", item.rationale), `At: ${item.at}`);
  } else if (event.action === "record_risk") {
    const id = revision.addedIds.find((value) => /^WP[1-9][0-9]*-R[1-9][0-9]*$/.test(value));
    const item = plan.risks.find((value) => value.id === id);
    if (!item) stateError("STATE_CORRUPT", "The recorded risk is unavailable");
    lines.push(`### ${item.id}`, `Status: ${item.status}`, ...labeled("Description", item.description), ...labeled("Impact", item.impact), ...labeled("Mitigation", item.mitigation));
  } else if (event.action === "record_question") {
    const id = revision.addedIds.find((value) => /^WP[1-9][0-9]*-Q[1-9][0-9]*$/.test(value));
    const item = plan.openQuestions.find((value) => value.id === id);
    if (!item) stateError("STATE_CORRUPT", "The recorded question is unavailable");
    lines.push(`### ${item.id}`, `Status: ${item.status}`, ...labeled("Question", item.question), ...labeled("Answer", item.answer ?? "None"));
  } else if (event.action === "checkpoint") {
    const id = revision.addedIds.find((value) => /^WP[1-9][0-9]*-K[1-9][0-9]*$/.test(value));
    const item = plan.checkpoints.find((value) => value.id === id);
    if (!item) stateError("STATE_CORRUPT", "The recorded checkpoint is unavailable");
    lines.push(...checkpointLines(item));
  } else if (event.action === "revise") {
    if (!revision.section) stateError("STATE_CORRUPT", "The revised section is unavailable");
    lines.push(`Section: ${canonicalSection(revision.section)}`, ...revisedSectionLines(plan, revision.section));
  } else {
    lines.push(`Status transition: ${String(event.data.from)} -> ${String(event.data.to)}`);
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

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
  for (const item of sorted(plan.checkpoints)) lines.push(`### ${item.id}`, ...labeled("Summary", item.summary), ...(item.currentFocus ? labeled("Current focus", item.currentFocus) : []), ...(item.nextActions ? ["Next actions:", ...listLines(item.nextActions)] : []), "Criterion evidence:", ...listLines(item.criterionEvidence.map((link) => `${link.criterionId}: ${link.evidence}`)), `At: ${item.at}`, "");
  lines.push("## Revisions");
  for (const item of plan.revisions.slice().sort((a, b) => a.planRevision - b.planRevision)) lines.push(`### Revision ${item.planRevision}`, `Action: ${item.action}`, `Section: ${item.section ?? "None"}`, `Added IDs: ${item.addedIds.length ? item.addedIds.join(", ") : "None"}`, `Updated IDs: ${item.updatedIds.length ? item.updatedIds.join(", ") : "None"}`, `Removed IDs: ${item.removedIds.length ? item.removedIds.join(", ") : "None"}`, `Before SHA-256: ${item.beforeDigest}`, `After SHA-256: ${item.afterDigest}`, ...labeled("Rationale", item.rationale), `Actor: ${item.actor}`, `At: ${item.at}`, "");
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function recoveryText(value: string, maximum = 2000): string {
  if ([...value].length <= maximum) return value;
  return `${[...value].slice(0, maximum).join("")}\n[truncated in recovery view; use workplan read for complete text]`;
}

function recoveryList(values: string[], maximumItems: number, maximumPoints = 1000): string[] {
  const visible = values.slice(0, maximumItems).map((value) => recoveryText(value, maximumPoints));
  if (values.length > maximumItems) visible.push(`[${values.length - maximumItems} more item(s); use workplan read for the complete list]`);
  return visible;
}

export function renderWorkplanRecovery(plan: Workplan): string {
  const orderedMilestones = sorted(plan.milestones);
  const activeMilestones = orderedMilestones.filter((item) => item.status === "in_progress" || item.status === "blocked");
  const readyMilestones = orderedMilestones.filter((item) => item.status === "pending" && item.dependsOn.every((id) => milestoneById(plan, id).status === "completed"));
  const currentMilestones = (activeMilestones.length ? activeMilestones : readyMilestones.slice(0, 1)).slice(0, 12);
  const latestCheckpoint = sorted(plan.checkpoints).at(-1);
  const checkpointRevision = latestCheckpoint
    ? plan.revisions.find((record) => record.addedIds.includes(latestCheckpoint.id))?.planRevision
    : undefined;
  const checkpointCurrent = checkpointRevision === plan.revision;
  const checkpointActions = checkpointCurrent ? latestCheckpoint?.nextActions ?? [] : [];
  const inferredActions = currentMilestones.map((item) => `${item.id}: ${item.title}`);
  const nextActions = checkpointActions.length ? checkpointActions : inferredActions;
  const evidenced = new Set(plan.checkpoints.flatMap((item) => item.criterionEvidence.map((link) => link.criterionId)));
  const outstandingCriteria = plan.acceptanceCriteria.filter((item) => !evidenced.has(item.id));
  const relevantRisks = plan.risks.filter((item) => item.status !== "mitigated").slice(0, 12);
  const openQuestions = plan.openQuestions.filter((item) => item.status === "open").slice(0, 12);
  const decisions = sorted(plan.decisions).slice(-12);
  const completed = orderedMilestones.filter((item) => item.status === "completed").length;
  const lines: string[] = [
    `# Recovery for ${plan.id}: ${recoveryText(plan.title, 500)}`,
    `Status: ${plan.status}`,
    `Revision: ${plan.revision}`,
    `Updated: ${plan.updatedAt}`,
    "",
    "## Goal",
    ...block(recoveryText(plan.objective)),
    "",
    "## Scope",
    ...listLines(recoveryList(plan.scope, 12)),
    "",
    "## Non-goals",
    ...listLines(recoveryList(plan.nonGoals, 12)),
    "",
    "## Constraints",
    ...listLines(recoveryList(plan.constraints, 16)),
    "",
    "## Approach",
    ...block(recoveryText(plan.approach, 6000)),
    "",
    "## Current position",
    `Milestones completed: ${completed}/${orderedMilestones.length}`,
    ...labeled("Latest checkpoint", latestCheckpoint ? `${latestCheckpoint.id} at revision ${checkpointRevision ?? "unknown"}${checkpointCurrent ? " (current)" : " (plan changed afterward)"}: ${recoveryText(latestCheckpoint.summary)}` : "None"),
    ...labeled("Current focus", checkpointCurrent && latestCheckpoint?.currentFocus ? recoveryText(latestCheckpoint.currentFocus) : "Use the current milestone state below"),
    "",
    "## Current milestones",
  ];
  if (!currentMilestones.length) lines.push("None");
  for (const item of currentMilestones) {
    lines.push(`### ${item.id}: ${recoveryText(item.title, 500)}`, `Status: ${item.status}`, ...labeled("Description", item.description ? recoveryText(item.description) : "None"), `Depends on: ${item.dependsOn.length ? item.dependsOn.join(", ") : "None"}`, "Evidence:", ...listLines(recoveryList(item.evidence.slice(-4), 4)), "");
  }
  lines.push("## Next actions", ...listLines(recoveryList(nextActions, 8)), "", "## Outstanding acceptance criteria", ...listLines(recoveryList(outstandingCriteria.map((item) => `${item.id}: ${item.text}`), 12)), "", "## Open or accepted risks");
  if (!relevantRisks.length) lines.push("None");
  for (const item of relevantRisks) lines.push(`- ${item.id} [${item.status}]: ${recoveryText(item.description, 700)} Mitigation: ${recoveryText(item.mitigation, 700)}`);
  lines.push("", "## Open questions");
  if (!openQuestions.length) lines.push("None");
  for (const item of openQuestions) lines.push(`- ${item.id}: ${recoveryText(item.question, 1000)}`);
  lines.push("", "## Key decisions");
  if (!decisions.length) lines.push("None");
  for (const item of decisions) lines.push(`- ${item.id}: ${recoveryText(item.decision, 1000)} Rationale: ${recoveryText(item.rationale, 1000)}`);
  lines.push("", "## Verification", ...listLines(recoveryList(plan.verification, 12)), "", "Use workplan read for the complete immutable plan and revision history.");
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

export function workplanContextLine(state: WorkplanState, recovered?: { planId: string; revision: number }): string | undefined {
  if (!state.plans.length) return undefined;
  const active = state.plans.find((plan) => plan.status === "active");
  if (!active) {
    const open = sorted(state.plans.filter((plan) => plan.status === "draft" || plan.status === "paused"));
    const completedPlans = state.plans.filter((plan) => plan.status === "completed").length;
    const archivedPlans = state.plans.filter((plan) => plan.status === "archived").length;
    if (!open.length) return `[workplan state] active=none open=none openCount=0 retained=${state.plans.length} completed=${completedPlans} archived=${archivedPlans}`;
    const candidate = open.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || compareNumericIds(right.id, left.id))[0]!;
    const visible = open.slice(0, 4).map((plan) => `${plan.id}:${plan.status}@rev${plan.revision}`);
    if (open.length > visible.length) visible.push(`+${open.length - visible.length}`);
    const recovery = recovered?.planId === candidate.id && recovered.revision === candidate.revision
      ? "current"
      : `required:workplan(action=recover,planId=${candidate.id})`;
    return `[workplan state] active=none open=${visible.join(",")} openCount=${open.length} retained=${state.plans.length} completed=${completedPlans} archived=${archivedPlans} recovery=${recovery}`;
  }
  const completed = active.milestones.filter((item) => item.status === "completed").length;
  const blocked = active.milestones.filter((item) => item.status === "blocked").length;
  const recovery = recovered?.planId === active.id && recovered.revision === active.revision
    ? "current"
    : `required:workplan(action=recover,planId=${active.id})`;
  return `[workplan state] active=${active.id} status=${active.status} rev=${active.revision} milestones=${completed}/${active.milestones.length} blocked=${blocked} recovery=${recovery}`;
}
