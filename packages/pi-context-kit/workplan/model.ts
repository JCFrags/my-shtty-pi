import type { ObjectRef } from "@context-kit/state-store";
import {
  applyWorkplanEvent, performWorkplanAction, WORKPLAN_LIMITS,
  type Workplan, type WorkplanEvent, type WorkplanInput, type WorkplanOperation, type WorkplanState, type WorkplanStatus,
} from "@grounded/pi-core/workplan";
import {
  compareNumericIds, requireExactObject, requireSafeInteger, StateToolError,
} from "@grounded/pi-core/state";
import { validateWorkplanSummary, type WorkplanSummaryV1 } from "@grounded/pi-core/workplan-summary";
import { admitWorkplanJson, boundedText, PLAN_OBJECT_BYTES, ROOT_BYTES } from "./admission.ts";

export interface PlanStatusMetadata {
  planId: string;
  status: WorkplanStatus;
  revision: number;
  currentCheckpointId: string | null;
  milestones: { completed: number; total: number };
  blocked: number;
  criterionEvidence: number;
  linkedTodoIds: number;
}
export interface PlanMetadata {
  id: string;
  title: string;
  objective: string;
  status: WorkplanStatus;
  revision: number;
  updatedAt: string;
  omittedFields: string[];
  plan: ObjectRef;
  canonicalBytes: number;
  projection: ObjectRef;
  statusMetadata: PlanStatusMetadata;
}
export interface WorkplanRoot {
  version: 1;
  kind: "workplan-root";
  plans: PlanMetadata[];
  nextPlanNumber: number;
  stateRevision: number;
  summary: WorkplanSummaryV1;
  event?: ObjectRef;
}
export const emptyWorkplanRoot = (): WorkplanRoot => ({
  version: 1, kind: "workplan-root", plans: [], nextPlanNumber: 1, stateRevision: 0, summary: { version: 1 },
});

export function validatePlanRef(ref: ObjectRef, maxBytes = PLAN_OBJECT_BYTES): void {
  requireExactObject(ref, ["version", "providerId", "storeId", "hash", "bytes"], [], "plan object reference", "STATE_CORRUPT");
  if (ref.version !== 1 || ref.providerId !== "workplan" || typeof ref.storeId !== "string" || !ref.storeId || ref.storeId.length > 128
    || typeof ref.hash !== "string" || !/^[0-9a-f]{64}$/u.test(ref.hash)) throw new StateToolError("STATE_CORRUPT", "Workplan object reference is invalid");
  requireSafeInteger(ref.bytes, "object bytes", 1, "STATE_CORRUPT");
  if (ref.bytes > maxBytes) throw new StateToolError("STATE_CORRUPT", "Workplan object exceeds the plan limit");
}

export function validateWorkplanRoot(root: WorkplanRoot): void {
  admitWorkplanJson(root, ROOT_BYTES, 50_000);
  requireExactObject(root, ["version", "kind", "plans", "nextPlanNumber", "stateRevision", "summary"], ["event"], "workplan root", "STATE_CORRUPT");
  if (root.version !== 1 || root.kind !== "workplan-root" || !Array.isArray(root.plans) || root.plans.length > WORKPLAN_LIMITS.retainedPlans) throw new StateToolError("STATE_CORRUPT", "Workplan root is invalid");
  requireSafeInteger(root.nextPlanNumber, "nextPlanNumber", 1, "STATE_CORRUPT");
  requireSafeInteger(root.stateRevision, "stateRevision", 0, "STATE_CORRUPT");
  const ids = new Set<string>();
  let active = 0, open = 0, maximum = 0;
  for (const plan of root.plans) {
    requireExactObject(plan, ["id", "title", "objective", "status", "revision", "updatedAt", "omittedFields", "plan", "canonicalBytes", "projection", "statusMetadata"], [], "plan metadata", "STATE_CORRUPT");
    if (typeof plan.id !== "string" || !/^WP[1-9][0-9]*$/u.test(plan.id) || ids.has(plan.id)) throw new StateToolError("STATE_CORRUPT", "Workplan IDs are invalid");
    ids.add(plan.id); maximum = Math.max(maximum, Number(plan.id.slice(2)));
    for (const [field, cap] of [["title", 512], ["objective", 1024], ["updatedAt", 128]] as const) {
      if (typeof plan[field] !== "string" || Buffer.byteLength(plan[field], "utf8") > cap) throw new StateToolError("STATE_CORRUPT", "Workplan metadata text is invalid");
    }
    requireSafeInteger(plan.revision, "plan revision", 1, "STATE_CORRUPT");
    if (!["draft", "active", "paused", "completed", "archived"].includes(plan.status)) throw new StateToolError("STATE_CORRUPT", "Workplan metadata status is invalid");
    if (plan.status === "active") active++;
    if (isOpen(plan.status)) open++;
    if (!Array.isArray(plan.omittedFields) || plan.omittedFields.length > 3 || plan.omittedFields.some((field) => !["title", "objective", "updatedAt"].includes(field))) throw new StateToolError("STATE_CORRUPT", "Workplan metadata omissions are invalid");
    validatePlanRef(plan.plan); validatePlanRef(plan.projection);
    requireSafeInteger(plan.canonicalBytes, "canonical plan bytes", 1, "STATE_CORRUPT");
    if (plan.canonicalBytes > WORKPLAN_LIMITS.canonicalPlanBytes || plan.plan.bytes < plan.canonicalBytes || plan.plan.bytes - plan.canonicalBytes > 512) throw new StateToolError("STATE_CORRUPT", "Workplan canonical byte count is invalid");
    if (plan.projection.bytes > 64 * 1024) throw new StateToolError("STATE_CORRUPT", "Workplan projection is too large");
    const status = plan.statusMetadata;
    requireExactObject(status, ["planId", "status", "revision", "currentCheckpointId", "milestones", "blocked", "criterionEvidence", "linkedTodoIds"], [], "status metadata", "STATE_CORRUPT");
    if (status.planId !== plan.id || status.status !== plan.status || status.revision !== plan.revision
      || !(status.currentCheckpointId === null || (typeof status.currentCheckpointId === "string" && new RegExp(`^${plan.id}-K[1-9][0-9]*$`).test(status.currentCheckpointId)))) throw new StateToolError("STATE_CORRUPT", "Workplan status metadata disagrees with the root");
    requireExactObject(status.milestones, ["completed", "total"], [], "milestone counts", "STATE_CORRUPT");
    for (const count of [status.milestones.completed, status.milestones.total, status.blocked, status.criterionEvidence, status.linkedTodoIds]) requireSafeInteger(count, "status count", 0, "STATE_CORRUPT");
    if (status.milestones.total > WORKPLAN_LIMITS.milestones || status.milestones.completed + status.blocked > status.milestones.total || status.criterionEvidence > WORKPLAN_LIMITS.planCriteria) throw new StateToolError("STATE_CORRUPT", "Workplan status counts are invalid");
  }
  if (root.nextPlanNumber <= maximum || active > 1 || open > WORKPLAN_LIMITS.openPlans) throw new StateToolError("STATE_CORRUPT", "Workplan root counters or active plan are invalid");
  if (root.event) validatePlanRef(root.event, WORKPLAN_LIMITS.canonicalPlanBytes + 1024 * 1024);
  validateWorkplanSummary(root.summary);
  if (root.summary.activePlan) {
    const plan = root.plans.find((item) => item.id === root.summary.activePlan!.id);
    if (!plan || plan.status !== "active" || plan.revision !== root.summary.activePlan.revision) throw new StateToolError("STATE_CORRUPT", "Workplan summary has a stale native revision");
  }
}

export function isOpen(status: WorkplanStatus): boolean { return status === "draft" || status === "active" || status === "paused"; }

export function statusMetadata(plan: Workplan): PlanStatusMetadata {
  const criterionIds = new Set<string>(), todoIds = new Set<string>();
  for (const checkpoint of plan.checkpoints) for (const link of checkpoint.criterionEvidence) criterionIds.add(link.criterionId);
  for (const milestone of plan.milestones) for (const id of milestone.linkedTodoIds) todoIds.add(id);
  return {
    planId: plan.id, status: plan.status, revision: plan.revision, currentCheckpointId: plan.checkpoints.at(-1)?.id ?? null,
    milestones: { completed: plan.milestones.filter((item) => item.status === "completed").length, total: plan.milestones.length },
    blocked: plan.milestones.filter((item) => item.status === "blocked").length,
    criterionEvidence: criterionIds.size, linkedTodoIds: todoIds.size,
  };
}

export function metadataFor(plan: Workplan, planRef: ObjectRef, projectionRef: ObjectRef): PlanMetadata {
  const title = boundedText(plan.title, 512), objective = boundedText(plan.objective, 1024), updatedAt = boundedText(plan.updatedAt, 128);
  return {
    id: plan.id, title: title.text, objective: objective.text, updatedAt: updatedAt.text, status: plan.status, revision: plan.revision,
    omittedFields: [...(title.omitted ? ["title"] : []), ...(objective.omitted ? ["objective"] : []), ...(updatedAt.omitted ? ["updatedAt"] : [])],
    plan: planRef, canonicalBytes: admitWorkplanJson(plan), projection: projectionRef, statusMetadata: statusMetadata(plan),
  };
}

/** Native reducers receive only the selected plan. Global constraints stay here. */
export function reduceTarget(root: WorkplanRoot, plan: Workplan | undefined, input: WorkplanInput, now?: number): WorkplanOperation {
  admitWorkplanJson(input);
  checkRootMutation(root, input.action, input.planId, false);
  const current: WorkplanState = { plans: plan ? [plan] : [], nextPlanNumber: root.nextPlanNumber, stateRevision: root.stateRevision };
  return performWorkplanAction(current, input, now);
}

export function applyTargetEvent(root: WorkplanRoot, plan: Workplan | undefined, event: WorkplanEvent): WorkplanOperation {
  admitWorkplanJson(event, WORKPLAN_LIMITS.canonicalPlanBytes + 1024 * 1024);
  const planId = event.action === "create" ? undefined : event.data.planId;
  checkRootMutation(root, event.action, typeof planId === "string" ? planId : undefined, true);
  const current: WorkplanState = { plans: plan ? [plan] : [], nextPlanNumber: root.nextPlanNumber, stateRevision: root.stateRevision };
  return { state: applyWorkplanEvent(current, event), event, result: undefined };
}

function checkRootMutation(root: WorkplanRoot, action: string, planId: string | undefined, replay: boolean): void {
  if (action === "create") {
    if (root.plans.length >= WORKPLAN_LIMITS.retainedPlans || root.plans.filter((item) => isOpen(item.status)).length >= WORKPLAN_LIMITS.openPlans) throw new StateToolError(replay ? "STATE_CORRUPT" : "STATE_LIMIT_EXCEEDED", "Workplan retained or open plan limit reached");
  } else if (action === "resume" && root.plans.some((item) => item.id !== planId && item.status === "active")) {
    throw new StateToolError(replay ? "STATE_CORRUPT" : "STATE_CONFLICT", "Another workplan is active");
  }
}

export function renderMetadataList(root: WorkplanRoot): string {
  const lines = ["# Workplans"];
  if (!root.plans.length) lines.push("None");
  for (const plan of root.plans.slice().sort((a, b) => compareNumericIds(a.id, b.id))) {
    lines.push("", `## ${plan.id}: ${plan.title}`, `Status: ${plan.status}`, `Revision: ${plan.revision}`, `Objective: ${plan.objective}`, `Updated: ${plan.updatedAt}`);
    if (plan.omittedFields.length) lines.push(`[Metadata omits complete ${plan.omittedFields.join(", ")}; use workplan read for ${plan.id}]`);
  }
  return `${lines.join("\n")}\n`;
}

export function metadataContextLine(root: WorkplanRoot, recovered?: { planId: string; revision: number }): string | undefined {
  if (!root.plans.length) return undefined;
  const active = root.plans.find((plan) => plan.status === "active");
  const recovery = (plan: PlanMetadata) => recovered?.planId === plan.id && recovered.revision === plan.revision
    ? "current" : `required:workplan(action=recover,planId=${plan.id})`;
  if (active) {
    const { milestones, blocked } = active.statusMetadata;
    return `[workplan state] active=${active.id} status=${active.status} rev=${active.revision} milestones=${milestones.completed}/${milestones.total} blocked=${blocked} recovery=${recovery(active)}`;
  }
  const open = root.plans.filter((plan) => plan.status === "draft" || plan.status === "paused").sort((a, b) => compareNumericIds(a.id, b.id));
  const completed = root.plans.filter((plan) => plan.status === "completed").length, archived = root.plans.filter((plan) => plan.status === "archived").length;
  if (!open.length) return `[workplan state] active=none open=none openCount=0 retained=${root.plans.length} completed=${completed} archived=${archived}`;
  const candidate = open.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || compareNumericIds(b.id, a.id))[0]!;
  const visible = open.slice(0, 4).map((plan) => `${plan.id}:${plan.status}@rev${plan.revision}`);
  if (open.length > visible.length) visible.push(`+${open.length - visible.length}`);
  return `[workplan state] active=none open=${visible.join(",")} openCount=${open.length} retained=${root.plans.length} completed=${completed} archived=${archived} recovery=${recovery(candidate)}`;
}
