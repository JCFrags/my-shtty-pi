import { mkdtemp, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelled, StateToolError } from "@grounded/pi-core/state";
import type { TaskState } from "@grounded/pi-core/tasks";
import { formatTask, TODO_LIMITS, type TodoInput, type TodoOperation } from "./operations.ts";
import type { TodoOwnerMetadata } from "./store.ts";

export interface TodoDetails {
  protocol: "context-kit-todo-result/v1"; action: TodoInput["action"];
  owner: { commitId: string | null; revision: number }; total: number; rows: string[];
  state?: TaskState; fullOutputPath?: string; omittedTasks?: number;
}
async function writeCompleteState(state: TaskState, temporaryRoot: string, signal?: AbortSignal): Promise<string> {
  cancelled(signal);
  const directory = await mkdtemp(join(temporaryRoot, "context-kit-todo-"));
  const path = join(directory, "state.json");
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8"); } finally { await file.close(); }
  cancelled(signal);
  return path;
}
/** Charge the complete result. Full list recovery contains native state, not cards. */
export async function todoResult(input: TodoInput, operation: TodoOperation, owner: TodoOwnerMetadata, signal?: AbortSignal, temporaryRoot = tmpdir()) {
  const details: TodoDetails = { protocol: "context-kit-todo-result/v1", action: input.action,
    owner: { commitId: owner.commitId, revision: owner.recordRevision }, total: operation.state.tasks.length,
    rows: operation.state.tasks.filter((task) => task.status !== "done").slice(0, 5).map((task) => {
      const row = formatTask(task); return row.length <= 240 ? row : `${row.slice(0, 239)}…`;
    }) };
  const result = { content: [{ type: "text" as const, text: operation.message }], details };
  const fits = () => Buffer.byteLength(JSON.stringify(result), "utf8") <= TODO_LIMITS.resultBytes;
  if (input.action === "list") {
    details.rows = [];
    details.state = operation.state;
    if (!fits()) {
      delete details.state;
      const path = await writeCompleteState(operation.state, temporaryRoot, signal);
      details.fullOutputPath = path;
      details.omittedTasks = operation.state.tasks.length;
      const notice = `Complete native Todo state: ${path}. The result limit is 32 KiB; no stored tasks were shortened.`;
      let text = notice;
      result.content[0]!.text = text;
      for (const task of operation.state.tasks) {
        const candidate = `${text}\n${formatTask(task)}`;
        result.content[0]!.text = candidate;
        if (!fits()) { result.content[0]!.text = text; break; }
        text = candidate; details.omittedTasks--;
      }
    }
  }
  while (!fits() && details.rows.length) details.rows.pop();
  if (!fits()) throw new StateToolError("STATE_LIMIT_EXCEEDED", "The complete Todo result exceeds 32 KiB");
  cancelled(signal);
  return result;
}
