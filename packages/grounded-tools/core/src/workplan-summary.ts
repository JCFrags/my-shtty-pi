import type { Checkpoint, Milestone, Workplan, WorkplanEvent, WorkplanState } from "./workplan.ts";

export const WORKPLAN_SUMMARY_REQUEST_EVENT = "pi-workplan:request-summary-v1" as const;
export const WORKPLAN_SUMMARY_EVENT = "pi-workplan:summary-v1" as const;
export const WORKPLAN_SUMMARY_CHANGED_EVENT = "pi-workplan:summary-changed-v1" as const;
export const WORKPLAN_ACTIVITY_EVENT = "pi-workplan:activity-v1" as const;
export const WORKPLAN_SUMMARY_VERSION = 1 as const;

export const WORKPLAN_SUMMARY_LIMITS = Object.freeze({
  idBytes: 128,
  requestIdBytes: 128,
  branchIdBytes: 128,
  titleBytes: 512,
  objectiveBytes: 1024,
  checkpointSummaryBytes: 2048,
  currentFocusBytes: 512,
  nextActionBytes: 512,
  nextActions: 8,
  timestampBytes: 64,
});

export type WorkplanSummaryMilestoneStatus = "pending" | "in_progress" | "blocked";

export interface WorkplanSummaryMilestone {
  id: string;
  title: string;
  status: WorkplanSummaryMilestoneStatus;
}

export interface WorkplanSummaryCheckpoint {
  id: string;
  summary: string;
  currentFocus?: string;
  nextActions?: string[];
  at: string;
}

export interface WorkplanSummaryPlan {
  id: string;
  title: string;
  objective: string;
  revision: number;
  currentMilestone?: WorkplanSummaryMilestone;
  latestCheckpoint?: WorkplanSummaryCheckpoint;
}

export interface WorkplanSummaryV1 {
  version: typeof WORKPLAN_SUMMARY_VERSION;
  activePlan?: WorkplanSummaryPlan;
}

export interface WorkplanSummaryRequestV1 {
  version: typeof WORKPLAN_SUMMARY_VERSION;
  requestId: string;
  branchId?: string;
}

export interface WorkplanSummaryResponseV1 {
  version: typeof WORKPLAN_SUMMARY_VERSION;
  requestId: string;
  branchId?: string;
  summary: WorkplanSummaryV1;
}

export interface WorkplanSummaryChangedV1 {
  version: typeof WORKPLAN_SUMMARY_VERSION;
  branchId?: string;
}

export type WorkplanActivityType =
  | "checkpoint_recorded"
  | "milestone_completed"
  | "plan_completed";

export interface WorkplanActivityV1 {
  version: typeof WORKPLAN_SUMMARY_VERSION;
  id: string;
  type: WorkplanActivityType;
  planId: string;
  milestoneId?: string;
  title?: string;
  summary?: string;
  currentFocus?: string;
  nextActions?: string[];
  at: string;
}

export function workplanBranchId(leafId: string | null | undefined): string {
  if (typeof leafId !== "string" || !leafId || /[\/\\\0]/u.test(leafId) || /[\uD800-\uDFFF]/u.test(leafId) || /\p{Cc}/u.test(leafId) || Buffer.byteLength(leafId, "utf8") > WORKPLAN_SUMMARY_LIMITS.branchIdBytes) return "root";
  return leafId;
}

function exact(value: unknown, required: readonly string[], optional: readonly string[] = [], field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${field}.${key} is not allowed`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${field}.${key} is required`);
}

function boundedContractText(value: unknown, maximumBytes: number, field: string, allowBlank = false): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  if (/[\uD800-\uDFFF]/u.test(value)) throw new Error(`${field} contains an unpaired surrogate`);
  const normalized = value
    .normalize("NFC")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!allowBlank && !normalized) throw new Error(`${field} must not be blank`);
  if (Buffer.byteLength(normalized, "utf8") > maximumBytes) throw new Error(`${field} exceeds ${maximumBytes} UTF-8 bytes`);
  return normalized;
}

function positiveRevision(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${field} must be a positive safe integer`);
  return value as number;
}

function timestamp(value: unknown, field: string): string {
  const result = boundedContractText(value, WORKPLAN_SUMMARY_LIMITS.timestampBytes, field);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${field} must be parseable`);
  return result;
}

function version(value: unknown, field: string): void {
  if (value !== WORKPLAN_SUMMARY_VERSION) throw new Error(`${field}.version is unsupported`);
}

function validateOptionalBranchId(value: unknown): string | undefined {
  return value === undefined ? undefined : boundedContractText(value, WORKPLAN_SUMMARY_LIMITS.branchIdBytes, "branchId");
}

export function validateWorkplanSummaryRequest(value: unknown): WorkplanSummaryRequestV1 {
  exact(value, ["version", "requestId"], ["branchId"], "workplan summary request");
  version(value.version, "workplan summary request");
  const requestId = boundedContractText(value.requestId, WORKPLAN_SUMMARY_LIMITS.requestIdBytes, "requestId");
  const branchId = validateOptionalBranchId(value.branchId);
  return { version: WORKPLAN_SUMMARY_VERSION, requestId, ...(branchId ? { branchId } : {}) };
}

export function validateWorkplanSummaryChanged(value: unknown): WorkplanSummaryChangedV1 {
  exact(value, ["version"], ["branchId"], "workplan summary changed");
  version(value.version, "workplan summary changed");
  const branchId = validateOptionalBranchId(value.branchId);
  return { version: WORKPLAN_SUMMARY_VERSION, ...(branchId ? { branchId } : {}) };
}

function validateMilestone(value: unknown): WorkplanSummaryMilestone {
  exact(value, ["id", "title", "status"], [], "summary milestone");
  const status = value.status;
  if (status !== "pending" && status !== "in_progress" && status !== "blocked") throw new Error("summary milestone.status is invalid");
  return {
    id: boundedContractText(value.id, WORKPLAN_SUMMARY_LIMITS.idBytes, "summary milestone.id"),
    title: boundedContractText(value.title, WORKPLAN_SUMMARY_LIMITS.titleBytes, "summary milestone.title"),
    status,
  };
}

function validateCheckpoint(value: unknown): WorkplanSummaryCheckpoint {
  exact(value, ["id", "summary", "at"], ["currentFocus", "nextActions"], "summary checkpoint");
  const currentFocus = value.currentFocus === undefined
    ? undefined
    : boundedContractText(value.currentFocus, WORKPLAN_SUMMARY_LIMITS.currentFocusBytes, "summary checkpoint.currentFocus");
  let nextActions: string[] | undefined;
  if (value.nextActions !== undefined) {
    if (!Array.isArray(value.nextActions) || value.nextActions.length > WORKPLAN_SUMMARY_LIMITS.nextActions) throw new Error("summary checkpoint.nextActions is invalid");
    nextActions = value.nextActions.map((item, index) => boundedContractText(item, WORKPLAN_SUMMARY_LIMITS.nextActionBytes, `summary checkpoint.nextActions[${index}]`));
  }
  return {
    id: boundedContractText(value.id, WORKPLAN_SUMMARY_LIMITS.idBytes, "summary checkpoint.id"),
    summary: boundedContractText(value.summary, WORKPLAN_SUMMARY_LIMITS.checkpointSummaryBytes, "summary checkpoint.summary"),
    ...(currentFocus ? { currentFocus } : {}),
    ...(nextActions ? { nextActions } : {}),
    at: timestamp(value.at, "summary checkpoint.at"),
  };
}

function validatePlan(value: unknown): WorkplanSummaryPlan {
  exact(value, ["id", "title", "objective", "revision"], ["currentMilestone", "latestCheckpoint"], "summary activePlan");
  const currentMilestone = value.currentMilestone === undefined ? undefined : validateMilestone(value.currentMilestone);
  const latestCheckpoint = value.latestCheckpoint === undefined ? undefined : validateCheckpoint(value.latestCheckpoint);
  return {
    id: boundedContractText(value.id, WORKPLAN_SUMMARY_LIMITS.idBytes, "summary activePlan.id"),
    title: boundedContractText(value.title, WORKPLAN_SUMMARY_LIMITS.titleBytes, "summary activePlan.title"),
    objective: boundedContractText(value.objective, WORKPLAN_SUMMARY_LIMITS.objectiveBytes, "summary activePlan.objective"),
    revision: positiveRevision(value.revision, "summary activePlan.revision"),
    ...(currentMilestone ? { currentMilestone } : {}),
    ...(latestCheckpoint ? { latestCheckpoint } : {}),
  };
}

export function validateWorkplanSummary(value: unknown): WorkplanSummaryV1 {
  exact(value, ["version"], ["activePlan"], "workplan summary");
  version(value.version, "workplan summary");
  const activePlan = value.activePlan === undefined ? undefined : validatePlan(value.activePlan);
  return { version: WORKPLAN_SUMMARY_VERSION, ...(activePlan ? { activePlan } : {}) };
}

export function validateWorkplanSummaryResponse(value: unknown): WorkplanSummaryResponseV1 {
  exact(value, ["version", "requestId", "summary"], ["branchId"], "workplan summary response");
  version(value.version, "workplan summary response");
  const requestId = boundedContractText(value.requestId, WORKPLAN_SUMMARY_LIMITS.requestIdBytes, "requestId");
  const branchId = validateOptionalBranchId(value.branchId);
  return {
    version: WORKPLAN_SUMMARY_VERSION,
    requestId,
    ...(branchId ? { branchId } : {}),
    summary: validateWorkplanSummary(value.summary),
  };
}

export function validateWorkplanActivity(value: unknown): WorkplanActivityV1 {
  exact(value, ["version", "id", "type", "planId", "at"], ["milestoneId", "title", "summary", "currentFocus", "nextActions"], "workplan activity");
  version(value.version, "workplan activity");
  if (value.type !== "checkpoint_recorded" && value.type !== "milestone_completed" && value.type !== "plan_completed") throw new Error("workplan activity.type is invalid");
  const milestoneId = value.milestoneId === undefined ? undefined : boundedContractText(value.milestoneId, WORKPLAN_SUMMARY_LIMITS.idBytes, "workplan activity.milestoneId");
  const title = value.title === undefined ? undefined : boundedContractText(value.title, WORKPLAN_SUMMARY_LIMITS.titleBytes, "workplan activity.title");
  const summary = value.summary === undefined ? undefined : boundedContractText(value.summary, WORKPLAN_SUMMARY_LIMITS.checkpointSummaryBytes, "workplan activity.summary");
  const currentFocus = value.currentFocus === undefined ? undefined : boundedContractText(value.currentFocus, WORKPLAN_SUMMARY_LIMITS.currentFocusBytes, "workplan activity.currentFocus");
  let nextActions: string[] | undefined;
  if (value.nextActions !== undefined) {
    if (!Array.isArray(value.nextActions) || value.nextActions.length > WORKPLAN_SUMMARY_LIMITS.nextActions) throw new Error("workplan activity.nextActions is invalid");
    nextActions = value.nextActions.map((item, index) => boundedContractText(item, WORKPLAN_SUMMARY_LIMITS.nextActionBytes, `workplan activity.nextActions[${index}]`));
  }
  return {
    version: WORKPLAN_SUMMARY_VERSION,
    id: boundedContractText(value.id, WORKPLAN_SUMMARY_LIMITS.idBytes, "workplan activity.id"),
    type: value.type,
    planId: boundedContractText(value.planId, WORKPLAN_SUMMARY_LIMITS.idBytes, "workplan activity.planId"),
    ...(milestoneId ? { milestoneId } : {}),
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(currentFocus ? { currentFocus } : {}),
    ...(nextActions ? { nextActions } : {}),
    at: timestamp(value.at, "workplan activity.at"),
  };
}

function safeText(value: unknown, maximumBytes: number): string | undefined {
  try {
    return boundedContractText(value, maximumBytes, "value");
  } catch {
    return undefined;
  }
}

function safeId(value: unknown): string | undefined {
  return safeText(value, WORKPLAN_SUMMARY_LIMITS.idBytes);
}

function safeTimestamp(value: unknown): string | undefined {
  try {
    return timestamp(value, "timestamp");
  } catch {
    return undefined;
  }
}

function selectedMilestone(plan: Workplan): Milestone | undefined {
  const inProgress = plan.milestones.find((item) => item.status === "in_progress");
  if (inProgress) return inProgress;
  const byId = new Map(plan.milestones.map((item) => [item.id, item]));
  const ready = plan.milestones.find((item) => item.status === "pending" && item.dependsOn.every((id) => byId.get(id)?.status === "completed"));
  if (ready) return ready;
  return plan.milestones.find((item) => item.status === "blocked");
}

function selectedCheckpoint(plan: Workplan): Checkpoint | undefined {
  return plan.checkpoints.at(-1);
}

function projectMilestone(value: Milestone | undefined): WorkplanSummaryMilestone | undefined {
  if (!value || (value.status !== "pending" && value.status !== "in_progress" && value.status !== "blocked")) return undefined;
  const id = safeId(value.id);
  const title = safeText(value.title, WORKPLAN_SUMMARY_LIMITS.titleBytes);
  return id && title ? { id, title, status: value.status } : undefined;
}

function projectCheckpoint(value: Checkpoint | undefined): WorkplanSummaryCheckpoint | undefined {
  if (!value) return undefined;
  const id = safeId(value.id);
  const summary = safeText(value.summary, WORKPLAN_SUMMARY_LIMITS.checkpointSummaryBytes);
  const at = safeTimestamp(value.at);
  if (!id || !summary || !at) return undefined;
  const currentFocus = value.currentFocus === undefined ? undefined : safeText(value.currentFocus, WORKPLAN_SUMMARY_LIMITS.currentFocusBytes);
  const nextActions = value.nextActions === undefined
    ? undefined
    : value.nextActions.slice(0, WORKPLAN_SUMMARY_LIMITS.nextActions)
      .map((item) => safeText(item, WORKPLAN_SUMMARY_LIMITS.nextActionBytes))
      .filter((item): item is string => Boolean(item));
  return {
    id,
    summary,
    ...(currentFocus ? { currentFocus } : {}),
    ...(nextActions?.length ? { nextActions } : {}),
    at,
  };
}

export function buildWorkplanSummary(state: WorkplanState): WorkplanSummaryV1 {
  try {
    if (!state || !Array.isArray(state.plans)) return { version: WORKPLAN_SUMMARY_VERSION };
    const plan = state.plans.find((item) => item?.status === "active");
    if (!plan) return { version: WORKPLAN_SUMMARY_VERSION };
    const id = safeId(plan.id);
    const title = safeText(plan.title, WORKPLAN_SUMMARY_LIMITS.titleBytes);
    const objective = safeText(plan.objective, WORKPLAN_SUMMARY_LIMITS.objectiveBytes);
    const revision = Number.isSafeInteger(plan.revision) && plan.revision >= 1 ? plan.revision : undefined;
    if (!id || !title || !objective || revision === undefined) return { version: WORKPLAN_SUMMARY_VERSION };
    const currentMilestone = projectMilestone(selectedMilestone(plan));
    const latestCheckpoint = projectCheckpoint(selectedCheckpoint(plan));
    return {
      version: WORKPLAN_SUMMARY_VERSION,
      activePlan: {
        id,
        title,
        objective,
        revision,
        ...(currentMilestone ? { currentMilestone } : {}),
        ...(latestCheckpoint ? { latestCheckpoint } : {}),
      },
    };
  } catch {
    return { version: WORKPLAN_SUMMARY_VERSION };
  }
}

function eventPlanId(event: WorkplanEvent): string | undefined {
  if (event.action === "create") return safeId((event.data.plan as { id?: unknown } | undefined)?.id);
  return safeId(event.data.planId);
}

function eventRevision(event: WorkplanEvent): number | undefined {
  if (event.action === "create") return 1;
  return Number.isSafeInteger(event.data.revision) && (event.data.revision as number) >= 1 ? event.data.revision as number : undefined;
}

function eventAt(event: WorkplanEvent): string | undefined {
  return safeTimestamp(event.at);
}

export function buildWorkplanActivity(event: WorkplanEvent, state: WorkplanState): WorkplanActivityV1 | undefined {
  try {
    const planId = eventPlanId(event);
    const revision = eventRevision(event);
    const at = eventAt(event);
    if (!planId || revision === undefined || !at) return undefined;
    let type: WorkplanActivityType;
    if (event.action === "checkpoint") type = "checkpoint_recorded";
    else if (event.action === "complete" && event.data.to === "completed") type = "plan_completed";
    else if (event.action === "update_milestone" && (event.data.changes as Record<string, unknown> | undefined)?.status === "completed") type = "milestone_completed";
    else return undefined;

    const plan = state.plans.find((candidate) => candidate.id === planId);
    const payload: WorkplanActivityV1 = {
      version: WORKPLAN_SUMMARY_VERSION,
      id: `workplan:${planId}:${revision}:${type}`,
      type,
      planId,
      ...(safeText(plan?.title, WORKPLAN_SUMMARY_LIMITS.titleBytes) ? { title: safeText(plan?.title, WORKPLAN_SUMMARY_LIMITS.titleBytes) } : {}),
      at,
    };
    if (type === "checkpoint_recorded") {
      const checkpoint = event.data.checkpoint as Checkpoint | undefined;
      const projected = projectCheckpoint(checkpoint);
      if (!projected) return undefined;
      payload.summary = projected.summary;
      if (projected.currentFocus) payload.currentFocus = projected.currentFocus;
      if (projected.nextActions) payload.nextActions = projected.nextActions;
    } else if (type === "milestone_completed") {
      const milestoneId = safeId(event.data.milestoneId);
      const milestone = plan?.milestones.find((candidate) => candidate.id === event.data.milestoneId);
      const title = safeText(milestone?.title, WORKPLAN_SUMMARY_LIMITS.titleBytes);
      if (!milestoneId || !title) return undefined;
      payload.milestoneId = milestoneId;
      payload.title = title;
    }
    return validateWorkplanActivity(payload);
  } catch {
    return undefined;
  }
}

export function matchesWorkplanRequest(response: WorkplanSummaryResponseV1, request: WorkplanSummaryRequestV1): boolean {
  return response.requestId === request.requestId && response.branchId === request.branchId;
}
