import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import {
  addTask, clearDone, cloneTaskState, completeTask, refreshBlockedStatuses,
  removeTask, reorderTask, startTask, updateTask, validateTaskState,
  type Task, type TaskState,
} from "@grounded/pi-core/tasks";
import { requireExactObject, requirePlainJson, stableJson, StateToolError, type StateErrorCode } from "@grounded/pi-core/state";

export const TODO_LIMITS = Object.freeze({
  tasks: 256, stateBytes: 1024 * 1024, textBytes: 4096, descriptionBytes: 8192,
  waitReasonBytes: 4096, idBytes: 128, dependencies: 64, resultBytes: 32 * 1024,
});
const Id = () => Type.String({ maxLength: TODO_LIMITS.idBytes });
const Text = () => Type.String({ maxLength: TODO_LIMITS.textBytes });
const Description = () => Type.String({ maxLength: TODO_LIMITS.descriptionBytes });
const WaitReason = () => Type.String({ maxLength: TODO_LIMITS.waitReasonBytes, description: "External condition that must clear before work can continue; use an empty string to clear it" });
const Dependencies = () => Type.Array(Id(), { maxItems: TODO_LIMITS.dependencies });
const ReplacementTaskSchema = Type.Object({
  id: Type.Optional(Id()), text: Text(), description: Type.Optional(Description()),
  status: Type.Optional(StringEnum(["pending", "in_progress", "blocked", "done"] as const)),
  blockedBy: Type.Optional(Dependencies()), waitReason: Type.Optional(WaitReason()),
}, { additionalProperties: false });
export const TodoParams = Type.Object({
  action: StringEnum(["list", "add", "update", "start", "done", "block", "remove", "reorder", "clear_done", "replace"] as const),
  id: Type.Optional(Id()), text: Type.Optional(Text()), description: Type.Optional(Description()),
  blockedBy: Type.Optional(Dependencies()), waitReason: Type.Optional(WaitReason()),
  position: Type.Optional(Type.Number({ minimum: 0, description: "Zero-based target position for reorder" })),
  tasks: Type.Optional(Type.Array(ReplacementTaskSchema, { maxItems: TODO_LIMITS.tasks, description: "Complete desired task list for replace" })),
}, { additionalProperties: false });
export type TodoInput = Static<typeof TodoParams>;
export interface TodoOperation { state: TaskState; message: string; changed: boolean }

function fail(code: StateErrorCode, message: string): never { throw new StateToolError(code, message); }
function textLimit(value: unknown, maximum: number, field: string, code: StateErrorCode): void {
  if (typeof value !== "string") fail(code, `${field} must be a string`);
  if (value.length > maximum || Buffer.byteLength(value, "utf8") > maximum) {
    fail("STATE_LIMIT_EXCEEDED", `${field} exceeds ${maximum} UTF-8 bytes`);
  }
}
function fields(value: Record<string, unknown>, code: StateErrorCode): void {
  for (const [field, maximum] of [["id", TODO_LIMITS.idBytes], ["text", TODO_LIMITS.textBytes],
    ["description", TODO_LIMITS.descriptionBytes], ["waitReason", TODO_LIMITS.waitReasonBytes]] as const) {
    if (value[field] !== undefined) textLimit(value[field], maximum, field, code);
  }
  if (value.blockedBy !== undefined) {
    if (!Array.isArray(value.blockedBy)) fail(code, "blockedBy must be an array");
    if (value.blockedBy.length > TODO_LIMITS.dependencies) fail("STATE_LIMIT_EXCEEDED", "A task can have at most 64 dependencies");
    for (const id of value.blockedBy) textLimit(id, TODO_LIMITS.idBytes, "dependency ID", code);
  }
}
/** Admit bounded shapes before recursive native validation or serialization. */
export function admitTodoInput(value: unknown): asserts value is TodoInput {
  requireExactObject(value, ["action"], ["id", "text", "description", "blockedBy", "waitReason", "position", "tasks"], "input");
  if (!["list", "add", "update", "start", "done", "block", "remove", "reorder", "clear_done", "replace"].includes(value.action as string)) fail("STATE_INVALID_INPUT", "Unknown todo action");
  fields(value, "STATE_INVALID_INPUT");
  if (value.position !== undefined && (typeof value.position !== "number" || !Number.isFinite(value.position) || value.position < 0)) fail("STATE_INVALID_INPUT", "position must be a finite non-negative number");
  if (value.tasks !== undefined) {
    if (!Array.isArray(value.tasks)) fail("STATE_INVALID_INPUT", "tasks must be an array");
    if (value.tasks.length > TODO_LIMITS.tasks) fail("STATE_LIMIT_EXCEEDED", "A branch can contain at most 256 tasks");
    for (const task of value.tasks) {
      requireExactObject(task, ["text"], ["id", "description", "status", "blockedBy", "waitReason"], "replacement task");
      fields(task, "STATE_INVALID_INPUT");
      if (task.status !== undefined && !["pending", "in_progress", "blocked", "done"].includes(task.status as string)) fail("STATE_INVALID_INPUT", "Invalid task status");
    }
  }
  requirePlainJson(value, "todo input");
  if (Buffer.byteLength(stableJson(value), "utf8") > TODO_LIMITS.stateBytes) fail("STATE_LIMIT_EXCEEDED", "Todo input exceeds 1 MiB of canonical JSON");
}

export function validateTodoState(state: TaskState): void {
  requireExactObject(state, ["tasks", "nextId"], [], "todo state", "STATE_CORRUPT");
  if (!Array.isArray(state.tasks)) fail("STATE_CORRUPT", "Invalid task array");
  if (state.tasks.length > TODO_LIMITS.tasks) fail("STATE_LIMIT_EXCEEDED", "A branch can contain at most 256 tasks");
  for (const task of state.tasks) {
    requireExactObject(task, ["id", "text", "status", "blockedBy", "createdAt", "updatedAt"], ["description", "waitReason"], "todo task", "STATE_CORRUPT");
    fields(task, "STATE_CORRUPT");
  }
  requirePlainJson(state, "todo state");
  validateTaskState(state);
  if (Buffer.byteLength(stableJson(state), "utf8") > TODO_LIMITS.stateBytes) fail("STATE_LIMIT_EXCEEDED", "Todo state exceeds 1 MiB of canonical JSON");
  let maximum = 0;
  for (const task of state.tasks) if (/^T\d+$/.test(task.id)) maximum = Math.max(maximum, Number(task.id.slice(1)));
  if (state.nextId <= maximum) fail("STATE_CORRUPT", "The next task number is not monotonic");
  const refreshed = cloneTaskState(state);
  refreshBlockedStatuses(refreshed);
  if (refreshed.tasks.some((task, index) => task.status !== state.tasks[index]!.status)) fail("STATE_CORRUPT", "Todo dependency status is inconsistent");
}

export function formatTask(task: Task): string {
  const marker = task.status === "done" ? "✓" : task.status === "in_progress" ? "●" : task.status === "blocked" ? "⊘" : "○";
  const blockers = task.blockedBy.length ? ` [blockedBy: ${task.blockedBy.join(", ")}]` : "";
  return `${marker} ${task.id} ${task.text}${blockers}${task.waitReason ? ` [waiting: ${task.waitReason}]` : ""}`;
}

/** Native task operations. replace deliberately resets the native ID counter. */
export function performTodoAction(current: TaskState, value: unknown, now = Date.now()): TodoOperation {
  admitTodoInput(value);
  validateTodoState(current);
  const input = value;
  let state = cloneTaskState(current);
  let message: string;
  const id = () => {
    if (!input.id) fail("STATE_INVALID_INPUT", `id is required for ${input.action}`);
    return input.id;
  };
  if (input.action === "list") return { state, message: state.tasks.length ? state.tasks.map(formatTask).join("\n") : "No todos", changed: false };
  if (input.action === "add") {
    if (!input.text) fail("STATE_INVALID_INPUT", "text is required for add");
    const task = addTask(state, { text: input.text, ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.blockedBy !== undefined ? { blockedBy: input.blockedBy } : {}), ...(input.waitReason !== undefined ? { waitReason: input.waitReason } : {}) }, now);
    message = `Added ${task.id}: ${task.text}`;
  } else if (input.action === "update" || input.action === "block") {
    const task = updateTask(state, id(), { ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}), ...(input.blockedBy !== undefined ? { blockedBy: input.blockedBy } : {}),
      ...(input.waitReason !== undefined ? { waitReason: input.waitReason } : {}) }, now);
    if (input.action === "block" && task.status !== "blocked") fail("STATE_INVALID_INPUT", "block requires an unfinished dependency in blockedBy or a waitReason");
    message = `Updated ${task.id}: ${task.text}`;
  } else if (input.action === "start" || input.action === "done") {
    const task = input.action === "start" ? startTask(state, id(), now) : completeTask(state, id(), now);
    message = `${input.action === "start" ? "Started" : "Completed"} ${task.id}: ${task.text}`;
  } else if (input.action === "remove") {
    removeTask(state, id()); message = `Removed ${input.id}`;
  } else if (input.action === "reorder") {
    if (input.position === undefined) fail("STATE_INVALID_INPUT", "id and position are required for reorder");
    reorderTask(state, id(), input.position); message = `Moved ${input.id} to position ${input.position}`;
  } else if (input.action === "clear_done") {
    message = `Cleared ${clearDone(state)} completed task(s)`;
  } else {
    if (!input.tasks) fail("STATE_INVALID_INPUT", "tasks is required for replace");
    const ids = input.tasks.map((task, index) => task.id ?? `T${index + 1}`);
    state = { nextId: ids.reduce((max, taskId) => Math.max(max, /^T(\d+)$/.test(taskId) ? Number(taskId.slice(1)) + 1 : 1), 1),
      tasks: input.tasks.map((task, index) => ({ id: ids[index]!, text: task.text.trim(),
        ...(task.description?.trim() ? { description: task.description.trim() } : {}), status: task.status ?? "pending",
        blockedBy: [...(task.blockedBy ?? [])], ...(task.waitReason?.trim() ? { waitReason: task.waitReason.trim() } : {}), createdAt: now, updatedAt: now })) };
    validateTaskState(state);
    const running = state.tasks.find((task) => task.status === "in_progress");
    refreshBlockedStatuses(state);
    if (running) startTask(state, running.id, now);
    message = `Replaced task plan with ${state.tasks.length} task(s)`;
  }
  validateTodoState(state);
  return { state, message, changed: true };
}
