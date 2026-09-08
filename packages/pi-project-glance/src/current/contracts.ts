export const TODO_SUMMARY_REQUEST_EVENT = "pi-todo:request-summary-v1" as const;
export const TODO_SUMMARY_EVENT = "pi-todo:summary-v1" as const;
export const TODO_SUMMARY_CHANGED_EVENT = "pi-todo:summary-changed-v1" as const;
export const WORKPLAN_SUMMARY_REQUEST_EVENT = "pi-workplan:request-summary-v1" as const;
export const WORKPLAN_SUMMARY_EVENT = "pi-workplan:summary-v1" as const;
export const WORKPLAN_SUMMARY_CHANGED_EVENT = "pi-workplan:summary-changed-v1" as const;

const VERSION = 1;
const ID_BYTES = 128;
const REQUEST_ID_BYTES = 128;
const TASK_TEXT_BYTES = 1024;
const WAIT_REASON_BYTES = 1024;
const PLAN_TITLE_BYTES = 512;
const OBJECTIVE_BYTES = 1024;
const CHECKPOINT_SUMMARY_BYTES = 2048;
const CURRENT_FOCUS_BYTES = 512;
const NEXT_ACTION_BYTES = 512;
const NEXT_ACTIONS = 8;
const TIMESTAMP_BYTES = 64;

export type TodoCurrentTaskStatus = "pending" | "in_progress" | "blocked" | "done";

export interface TodoCurrentTask {
  id?: string;
  text: string;
  status: TodoCurrentTaskStatus;
  waitReason?: string;
}

export interface WorkplanCurrentMilestone {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "blocked";
}

export interface WorkplanCurrentCheckpoint {
  id: string;
  summary: string;
  currentFocus?: string;
  nextActions?: string[];
  at: string;
}

export interface WorkplanCurrentPlan {
  id: string;
  title: string;
  objective: string;
  revision: number;
  currentMilestone?: WorkplanCurrentMilestone;
  latestCheckpoint?: WorkplanCurrentCheckpoint;
}

export interface TodoSummaryEnvelope {
  requestId: string;
  branchId: string;
  task?: TodoCurrentTask;
}

export interface WorkplanSummaryEnvelope {
  requestId: string;
  branchId: string;
  plan?: WorkplanCurrentPlan;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function text(value: unknown, maximumBytes: number, optional = false): string | undefined {
  if (typeof value !== "string" || /[\uD800-\uDFFF]/u.test(value)) return undefined;
  const normalized = value.normalize("NFC").replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim();
  if (!optional && !normalized) return undefined;
  if (!normalized && optional) return undefined;
  return Buffer.byteLength(normalized, "utf8") <= maximumBytes ? normalized : undefined;
}

function opaqueIdentifier(value: unknown, maximumBytes: number, rejectPathSeparators = false): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (/[\uD800-\uDFFF]/u.test(value) || /\p{Cc}/u.test(value)) return undefined;
  if (rejectPathSeparators && /[\/\\\0]/u.test(value)) return undefined;
  return Buffer.byteLength(value, "utf8") <= maximumBytes ? value : undefined;
}

function branch(value: unknown, expected: string): boolean {
  return opaqueIdentifier(value, ID_BYTES, true) === expected;
}

function request(value: unknown, expectedRequestId: string, expectedBranchId: string, payload: "snapshot" | "summary"): Record<string, unknown> | undefined {
  const candidate = record(value);
  if (!candidate || !exact(candidate, ["version", "requestId", "branchId", payload])) return undefined;
  if (candidate.version !== VERSION || opaqueIdentifier(candidate.requestId, REQUEST_ID_BYTES) !== expectedRequestId || !branch(candidate.branchId, expectedBranchId)) return undefined;
  return candidate;
}

export interface TodoSummaryChangedV1 {
  version: typeof VERSION;
  branchId: string;
  snapshot?: { version: typeof VERSION };
}

export interface WorkplanSummaryChangedV1 {
  version: typeof VERSION;
  branchId: string;
}

export function parseTodoSummaryChanged(value: unknown, expectedBranchId: string): TodoSummaryChangedV1 | undefined {
  const candidate = record(value);
  if (!candidate || !exact(candidate, ["version", "branchId"], ["snapshot"])) return undefined;
  if (candidate.version !== VERSION || !branch(candidate.branchId, expectedBranchId)) return undefined;
  if (candidate.snapshot === undefined) return { version: VERSION, branchId: expectedBranchId };
  const snapshot = record(candidate.snapshot);
  if (!snapshot || snapshot.version !== VERSION) return undefined;
  return { version: VERSION, branchId: expectedBranchId, snapshot: { version: VERSION } };
}

export function parseWorkplanSummaryChanged(value: unknown, expectedBranchId: string): WorkplanSummaryChangedV1 | undefined {
  const candidate = record(value);
  if (!candidate || !exact(candidate, ["version", "branchId"])) return undefined;
  return candidate.version === VERSION && branch(candidate.branchId, expectedBranchId)
    ? { version: VERSION, branchId: expectedBranchId }
    : undefined;
}

function parseTodoTask(value: unknown): TodoCurrentTask | undefined {
  const candidate = record(value);
  if (!candidate || !exact(candidate, ["text", "status"], ["id", "waitReason"])) return undefined;
  if (candidate.status !== "pending" && candidate.status !== "in_progress" && candidate.status !== "blocked" && candidate.status !== "done") return undefined;
  const taskText = text(candidate.text, TASK_TEXT_BYTES);
  if (!taskText) return undefined;
  const id = candidate.id === undefined ? undefined : text(candidate.id, ID_BYTES);
  if (candidate.id !== undefined && !id) return undefined;
  const waitReason = candidate.waitReason === undefined ? undefined : text(candidate.waitReason, WAIT_REASON_BYTES);
  if (candidate.waitReason !== undefined && !waitReason) return undefined;
  return { ...(id ? { id } : {}), text: taskText, status: candidate.status, ...(waitReason ? { waitReason } : {}) };
}

export function parseTodoSummary(value: unknown, expectedRequestId: string, expectedBranchId: string): TodoSummaryEnvelope | undefined {
  const candidate = request(value, expectedRequestId, expectedBranchId, "snapshot");
  if (!candidate) return undefined;
  const snapshot = record(candidate.snapshot);
  if (!snapshot || snapshot.version !== VERSION) return undefined;
  if (snapshot.currentUsefulTask === undefined) return { requestId: expectedRequestId, branchId: expectedBranchId };
  const task = parseTodoTask(snapshot.currentUsefulTask);
  return task ? { requestId: expectedRequestId, branchId: expectedBranchId, task } : undefined;
}

function parseTimestamp(value: unknown): string | undefined {
  const candidate = text(value, TIMESTAMP_BYTES);
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : undefined;
}

function parseWorkplanMilestone(value: unknown): WorkplanCurrentMilestone | undefined {
  const candidate = record(value);
  if (!candidate || !exact(candidate, ["id", "title", "status"])) return undefined;
  if (candidate.status !== "pending" && candidate.status !== "in_progress" && candidate.status !== "blocked") return undefined;
  const id = text(candidate.id, ID_BYTES);
  const title = text(candidate.title, PLAN_TITLE_BYTES);
  return id && title ? { id, title, status: candidate.status } : undefined;
}

function parseWorkplanCheckpoint(value: unknown): WorkplanCurrentCheckpoint | undefined {
  const candidate = record(value);
  if (!candidate || !exact(candidate, ["id", "summary", "at"], ["currentFocus", "nextActions"])) return undefined;
  const id = text(candidate.id, ID_BYTES);
  const summary = text(candidate.summary, CHECKPOINT_SUMMARY_BYTES);
  const at = parseTimestamp(candidate.at);
  if (!id || !summary || !at) return undefined;
  const currentFocus = candidate.currentFocus === undefined ? undefined : text(candidate.currentFocus, CURRENT_FOCUS_BYTES);
  if (candidate.currentFocus !== undefined && !currentFocus) return undefined;
  let nextActions: string[] | undefined;
  if (candidate.nextActions !== undefined) {
    if (!Array.isArray(candidate.nextActions) || candidate.nextActions.length > NEXT_ACTIONS) return undefined;
    const parsedActions = candidate.nextActions.map((item) => text(item, NEXT_ACTION_BYTES));
    if (parsedActions.some((item) => item === undefined)) return undefined;
    nextActions = parsedActions as string[];
  }
  return { id, summary, ...(currentFocus ? { currentFocus } : {}), ...(nextActions ? { nextActions } : {}), at };
}

function parseWorkplanPlan(value: unknown): WorkplanCurrentPlan | undefined {
  const candidate = record(value);
  if (!candidate || !exact(candidate, ["id", "title", "objective", "revision"], ["currentMilestone", "latestCheckpoint"])) return undefined;
  const id = text(candidate.id, ID_BYTES);
  const title = text(candidate.title, PLAN_TITLE_BYTES);
  const objective = text(candidate.objective, OBJECTIVE_BYTES);
  const revision = candidate.revision;
  if (!id || !title || !objective || !Number.isSafeInteger(revision) || (revision as number) < 1) return undefined;
  const currentMilestone = candidate.currentMilestone === undefined ? undefined : parseWorkplanMilestone(candidate.currentMilestone);
  if (candidate.currentMilestone !== undefined && !currentMilestone) return undefined;
  const latestCheckpoint = candidate.latestCheckpoint === undefined ? undefined : parseWorkplanCheckpoint(candidate.latestCheckpoint);
  if (candidate.latestCheckpoint !== undefined && !latestCheckpoint) return undefined;
  return { id, title, objective, revision: revision as number, ...(currentMilestone ? { currentMilestone } : {}), ...(latestCheckpoint ? { latestCheckpoint } : {}) };
}

export function parseWorkplanSummary(value: unknown, expectedRequestId: string, expectedBranchId: string): WorkplanSummaryEnvelope | undefined {
  const candidate = request(value, expectedRequestId, expectedBranchId, "summary");
  if (!candidate) return undefined;
  const summary = record(candidate.summary);
  if (!summary || summary.version !== VERSION) return undefined;
  if (summary.activePlan === undefined) return { requestId: expectedRequestId, branchId: expectedBranchId };
  const plan = parseWorkplanPlan(summary.activePlan);
  return plan ? { requestId: expectedRequestId, branchId: expectedBranchId, plan } : undefined;
}
