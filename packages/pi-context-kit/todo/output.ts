import { mkdtemp, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelled, StateToolError } from "@grounded/pi-core/state";
import type { Task, TaskState } from "@grounded/pi-core/tasks";
import { formatTaskSummary, TODO_LIMITS, type TodoInput, type TodoOperation, type TodoStatusChange } from "./operations.ts";
import type { TodoOwnerMetadata } from "./store.ts";

export interface TodoDetails {
  protocol: "context-kit-todo-result/v1"; action: TodoInput["action"];
  owner: { commitId: string | null; revision: number }; total: number; rows: string[];
  view?: "current" | "all"; retainedDone?: number; tasks?: Task[]; task?: Task; taskId?: string;
  statusChanges?: TodoStatusChange[]; omittedStatusChanges?: number;
  state?: TaskState; fullOutputPath?: string; omittedTasks?: number;
}
async function writeFullOutput(value: unknown, filename: string, temporaryRoot: string, signal?: AbortSignal): Promise<string> {
  cancelled(signal);
  const directory = await mkdtemp(join(temporaryRoot, "context-kit-todo-"));
  const path = join(directory, filename);
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); } finally { await file.close(); }
  cancelled(signal);
  return path;
}
/** Charge the complete result. Only the all view contains complete native state. */
export async function todoResult(input: TodoInput, operation: TodoOperation, owner: TodoOwnerMetadata, signal?: AbortSignal, temporaryRoot = tmpdir()) {
  const details: TodoDetails = { protocol: "context-kit-todo-result/v1", action: input.action,
    owner: { commitId: owner.commitId, revision: owner.recordRevision }, total: operation.state.tasks.length,
    rows: operation.state.tasks.filter((task) => task.status !== "done").slice(0, 5).map(formatTaskSummary),
    ...(operation.statusChanges ? { statusChanges: operation.statusChanges } : {}) };
  const result = { content: [{ type: "text" as const, text: operation.message }], details };
  const fits = () => Buffer.byteLength(JSON.stringify(result), "utf8") <= TODO_LIMITS.resultBytes;
  if (input.action === "read") {
    if (!operation.task) throw new StateToolError("STATE_CORRUPT", "Todo read has no selected task");
    details.rows = [];
    details.taskId = operation.task.id;
    details.task = operation.task;
    if (!fits()) {
      delete details.task;
      const path = await writeFullOutput(operation.task, "task.json", temporaryRoot, signal);
      details.fullOutputPath = path;
      result.content[0]!.text = `Exact Todo task ${operation.task.id}: ${path}. Read this file for all task fields. No stored fields were shortened.`;
    }
  } else if (input.action === "list") {
    details.rows = [];
    details.view = input.view ?? "current";
    details.retainedDone = operation.state.tasks.filter((task) => task.status === "done").length;
    const tasks = details.view === "all" ? operation.state.tasks : operation.state.tasks.filter((task) => task.status !== "done");
    const state = details.view === "all" ? operation.state : { view: "current" as const, tasks, retainedDone: details.retainedDone };
    if (details.view === "all") details.state = operation.state;
    else details.tasks = tasks;
    if (!fits()) {
      delete details.state; delete details.tasks;
      const path = await writeFullOutput(state, "state.json", temporaryRoot, signal);
      details.fullOutputPath = path;
      details.omittedTasks = tasks.length;
      const notice = details.view === "all" ? `Complete native Todo state: ${path}. No stored tasks were shortened.`
        : `Current Todo view: ${path}. ${details.retainedDone} done task(s) retained. Use todo(action=list,view=all) for complete native state.`;
      let text = notice;
      result.content[0]!.text = text;
      for (const task of tasks) {
        const candidate = `${text}\n${formatTaskSummary(task)}`;
        result.content[0]!.text = candidate;
        if (!fits()) { result.content[0]!.text = text; break; }
        text = candidate; details.omittedTasks--;
      }
    }
  }
  while (!fits() && details.rows.length) details.rows.pop();
  if (!fits() && input.action !== "list" && input.action !== "read") {
    const path = await writeFullOutput({ message: operation.message, ...(operation.statusChanges ? { statusChanges: operation.statusChanges } : {}) }, "result.json", temporaryRoot, signal);
    if (details.statusChanges) details.omittedStatusChanges = details.statusChanges.length;
    delete details.statusChanges;
    details.fullOutputPath = path;
    result.content[0]!.text = `${operation.message.split("\n")[0]}\nComplete Todo action result: ${path}. Read this file for all automatic status changes.`;
  }
  if (!fits()) throw new StateToolError("STATE_LIMIT_EXCEEDED", "The complete Todo result exceeds 32 KiB");
  cancelled(signal);
  return result;
}
