import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { cloneTaskState, type Task, type TaskState } from "@grounded/pi-core/tasks";
import { loadTodoDisplayMode, saveTodoDisplayMode, type TodoDisplayMode } from "./settings.ts";
import { type TodoInput } from "./operations.ts";

function taskMarker(task: Task, theme: Theme): string {
  if (task.status === "done") return theme.fg("success", "✓");
  if (task.status === "in_progress") return theme.fg("accent", "●");
  if (task.status === "blocked") return theme.fg("warning", "⊘");
  return theme.fg("dim", "○");
}

function taskStateText(task: Task): string {
  const parts: string[] = [];
  if (task.blockedBy.length) parts.push(`needs ${task.blockedBy.join(", ")}`);
  if (task.waitReason) parts.push(`wait: ${task.waitReason}`);
  return parts.length ? ` — ${parts.join(" • ")}` : "";
}

function renderTaskRow(task: Task, theme: Theme, width: number): string {
  const line = `${taskMarker(task, theme)} ${theme.fg("dim", task.id)} ${task.text}${theme.fg("warning", taskStateText(task))}`;
  return truncateToWidth(line, Math.max(1, width));
}

export class TodoListView {
  private scrollOffset = 0;
  private pageSize = 1;

  constructor(
    private readonly state: TaskState,
    private readonly theme: Theme,
    private readonly terminalRows: () => number,
    private readonly requestRender: () => void,
    private readonly close: () => void,
  ) {}

  handleInput(data: string) {
    const last = Math.max(0, this.state.tasks.length - this.pageSize);
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.close();
      return;
    }
    if (matchesKey(data, Key.up)) this.scrollOffset -= 1;
    else if (matchesKey(data, Key.down)) this.scrollOffset += 1;
    else if (matchesKey(data, Key.pageUp)) this.scrollOffset -= this.pageSize;
    else if (matchesKey(data, Key.pageDown)) this.scrollOffset += this.pageSize;
    else if (matchesKey(data, Key.home)) this.scrollOffset = 0;
    else if (matchesKey(data, Key.end)) this.scrollOffset = last;
    else return;
    this.scrollOffset = Math.max(0, Math.min(last, this.scrollOffset));
    this.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const done = this.state.tasks.filter((task) => task.status === "done").length;
    const active = this.state.tasks.filter((task) => task.status === "in_progress").length;
    const blocked = this.state.tasks.filter((task) => task.status === "blocked").length;
    const maxRows = Math.max(6, Math.floor(this.terminalRows() * 0.9) - 2);
    this.pageSize = Math.max(1, maxRows - 3);
    const last = Math.max(0, this.state.tasks.length - this.pageSize);
    this.scrollOffset = Math.max(0, Math.min(last, this.scrollOffset));
    const visible = this.state.tasks.slice(this.scrollOffset, this.scrollOffset + this.pageSize);
    const range = this.state.tasks.length
      ? `${this.scrollOffset + 1}-${this.scrollOffset + visible.length}/${this.state.tasks.length}`
      : "0/0";
    const lines = [
      this.theme.fg("accent", `Todos ${done}/${this.state.tasks.length}`)
        + this.theme.fg("dim", ` • ${range} • active ${active} • blocked ${blocked}`),
      ...(visible.length ? visible.map((task) => renderTaskRow(task, this.theme, safeWidth)) : [this.theme.fg("dim", "No todos")]),
      this.theme.fg("dim", "↑/↓ scroll • PgUp/PgDn page • Home/End jump • Esc close • Ctrl+Shift+U size"),
    ];
    return lines.slice(0, maxRows).map((line) => truncateToWidth(line, safeWidth));
  }

  invalidate() {}
}

export const TODO_SUMMARY_REQUEST_EVENT = "pi-todo:request-summary-v1";
export const TODO_SUMMARY_EVENT = "pi-todo:summary-v1";
export const TODO_SUMMARY_CHANGED_EVENT = "pi-todo:summary-changed-v1";
export const TODO_ACTION_REQUEST_EVENT = "pi-todo:request-action-v1";
export const TODO_ACTION_RESPONSE_EVENT = "pi-todo:action-response-v1";
export interface TodoActionRequest { version: 1; requestId: string; action: "start" | "done" | "clear_wait"; taskId: string }
export interface TodoActionResponse { version: 1; requestId: string; ok: boolean; action: TodoActionRequest["action"]; taskId: string; message?: string; error?: string }
export interface TodoTaskSummary { id: string; text: string; status: Task["status"]; waitReason?: string }
export interface TodoSummarySnapshot {
  version: 1; currentUsefulTask?: TodoTaskSummary; unfinishedTasks: TodoTaskSummary[];
  countsByState: Record<Task["status"], number>; externalWaits: Array<{ id: string; reason: string }>; planSize: number;
}
function bounded(value: string, limit: number): string { return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`; }
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && Buffer.byteLength(value, "utf8") <= 128;
}
function branchId(value: string | null): string { return value && identifier(value) && !/[\/\\\0\p{Cc}\uD800-\uDFFF]/u.test(value) ? value : "root"; }
function taskSummary(task: Task): TodoTaskSummary {
  return { id: task.id, text: bounded(task.text, 240), status: task.status, ...(task.waitReason ? { waitReason: bounded(task.waitReason, 240) } : {}) };
}
export function summarizeTodos(state: TaskState): TodoSummarySnapshot {
  const unfinished = state.tasks.filter((task) => task.status !== "done");
  const countsByState = { pending: 0, in_progress: 0, blocked: 0, done: 0 };
  for (const task of state.tasks) countsByState[task.status]++;
  const current = unfinished.find((task) => task.status === "in_progress") ?? unfinished.find((task) => task.status === "pending") ?? unfinished[0];
  return { version: 1, ...(current ? { currentUsefulTask: taskSummary(current) } : {}), unfinishedTasks: unfinished.slice(0, 5).map(taskSummary),
    countsByState, externalWaits: unfinished.filter((task) => task.waitReason).slice(0, 5).map((task) => ({ id: task.id, reason: bounded(task.waitReason!, 240) })), planSize: state.tasks.length };
}
interface TodoUiOwner {
  state(): TaskState | undefined;
  execute(input: TodoInput, ctx: ExtensionContext): Promise<{ message: string }>;
  list(ctx: ExtensionContext): Promise<string>;
}
/** UI is optional. All task writes use the same owner operation as the native tool. */
export function registerTodoUi(pi: ExtensionAPI, owner: TodoUiOwner, settingsPath?: string) {
  let context: ExtensionContext | undefined;
  let currentBranchId = "root";
  let mode: TodoDisplayMode = "compact";
  const removers: Array<() => void> = [];
  const emit = (name: string, value: unknown) => { try { pi.events.emit(name, value); } catch { /* Optional Glance consumers cannot fail a committed write. */ } };
  const summary = (name: string, requestId?: string) => {
    const state = owner.state();
    if (state) emit(name, { version: 1, ...(requestId ? { requestId } : {}), branchId: currentBranchId, snapshot: summarizeTodos(state) });
  };
  const render = () => {
    if (!context?.hasUI) return;
    const state = owner.state();
    const unfinished = state?.tasks.filter((task) => task.status !== "done") ?? [];
    try {
      if (!state || !unfinished.length) { context.ui.setWidget("grounded-tasks", undefined); return; }
      context.ui.setWidget("grounded-tasks", (_tui, theme) => ({
        render(width: number) {
          const safeWidth = Math.max(1, width);
          const done = state.tasks.filter((task) => task.status === "done").length;
          const blocked = unfinished.filter((task) => task.status === "blocked").length;
          const current = unfinished.find((task) => task.status === "in_progress") ?? unfinished.find((task) => task.status === "pending") ?? unfinished[0]!;
          if (mode === "compact" || safeWidth < 36) {
            const line = `${theme.fg("accent", "Todos")} ${done}/${state.tasks.length}`
              + (blocked ? theme.fg("warning", ` • ${blocked} blocked`) : "") + theme.fg("dim", " • /todos")
              + ` • ${taskMarker(current, theme)} ${current.text}`;
            return [truncateToWidth(line, safeWidth)];
          }
          const visible = unfinished.slice(0, 5);
          const hidden = unfinished.length - visible.length;
          const header = `${theme.fg("accent", "Todos")} ${done}/${state.tasks.length}`
            + (blocked ? theme.fg("warning", ` • ${blocked} blocked`) : "") + theme.fg("dim", " • Ctrl+Shift+U size • /todos full");
          const lines = [header, ...visible.map((task) => renderTaskRow(task, theme, safeWidth))];
          if (hidden) lines.push(theme.fg("dim", `… ${hidden} more • /todos full`));
          return lines.map((line) => truncateToWidth(line, safeWidth));
        }, invalidate() {},
      }));
    } catch { /* A UI failure cannot change native state. */ }
  };
  const setMode = (next: TodoDisplayMode) => { saveTodoDisplayMode(next, settingsPath); mode = next; render(); };
  const notifyError = (ctx: ExtensionContext, error: unknown) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  try {
    removers.push(pi.events.on(TODO_SUMMARY_REQUEST_EVENT, (value: unknown) => {
      const request = value && typeof value === "object" ? value as { version?: number; requestId?: string; branchId?: string } : {};
      if (request.version !== undefined && request.version !== 1) return;
      if (request.branchId !== undefined && request.branchId !== currentBranchId) return;
      summary(TODO_SUMMARY_EVENT, typeof request.requestId === "string" ? bounded(request.requestId, 128) : undefined);
    }));
    removers.push(pi.events.on(TODO_ACTION_REQUEST_EVENT, (value: unknown) => {
      const request = value && typeof value === "object" ? value as Partial<TodoActionRequest> : {};
      const { action, taskId, requestId } = request;
      if ((request.version !== undefined && request.version !== 1) || !identifier(requestId) || !identifier(taskId)
        || (action !== "start" && action !== "done" && action !== "clear_wait")) return;
      void (async () => {
        try {
          if (!context) throw new Error("Todo is unavailable");
          const result = await owner.execute(action === "clear_wait" ? { action: "update", id: taskId, waitReason: "" } : { action, id: taskId }, context);
          emit(TODO_ACTION_RESPONSE_EVENT, { version: 1, requestId, ok: true, action, taskId,
            message: action === "clear_wait" ? `Cleared external wait for ${taskId}` : result.message } satisfies TodoActionResponse);
        } catch (error) {
          emit(TODO_ACTION_RESPONSE_EVENT, { version: 1, requestId, ok: false, action, taskId,
            error: bounded(error instanceof Error ? error.message : String(error), 240) } satisfies TodoActionResponse);
        }
      })();
    }));
  } catch { /* Glance is not required to register native commands. */ }
  pi.registerCommand("todos", {
    description: "Open all todos, or set widget size: /todos [full|compact|plan]",
    handler: async (args, ctx) => {
      const choice = args.trim().toLowerCase();
      try {
        if (choice === "compact" || choice === "plan") { setMode(choice); ctx.ui.notify(`Todo widget: ${choice}`, "info"); return; }
        if (choice && choice !== "full") { ctx.ui.notify("Usage: /todos [full|compact|plan]", "warning"); return; }
        if (ctx.mode !== "tui") { ctx.ui.notify(await owner.list(ctx), "info"); return; }
        await owner.list(ctx);
        const state = owner.state();
        if (!state) throw new Error("Todo state is pending or unavailable");
        await ctx.ui.custom<void>((tui, theme, _keys, done) => {
          const terminal = tui as typeof tui & { terminal?: { rows?: number } };
          return new TodoListView(cloneTaskState(state), theme, () => terminal.terminal?.rows ?? 24, () => tui.requestRender(), () => done());
        }, { overlay: true, overlayOptions: { width: "96%", minWidth: 20, maxHeight: "90%", anchor: "center", margin: 1 } });
      } catch (error) { notifyError(ctx, error); }
    },
  });
  pi.registerShortcut("ctrl+shift+u", {
    description: "Toggle compact and plan todo widget sizes",
    handler: async (ctx) => { try { const next = mode === "compact" ? "plan" : "compact"; setMode(next); ctx.ui.notify(`Todo widget: ${next}`, "info"); } catch (error) { notifyError(ctx, error); } },
  });
  pi.registerCommand("todo-add", {
    description: "Add a task manually: /todo-add <text>",
    handler: async (args, ctx) => {
      if (!args.trim()) { ctx.ui.notify("Usage: /todo-add <text>", "warning"); return; }
      try { ctx.ui.notify((await owner.execute({ action: "add", text: args }, ctx)).message, "info"); } catch (error) { notifyError(ctx, error); }
    },
  });
  return {
    bind(ctx: ExtensionContext) { context = ctx; currentBranchId = branchId(ctx.sessionManager.getLeafId()); mode = loadTodoDisplayMode(settingsPath); render(); summary(TODO_SUMMARY_EVENT); },
    changed() { render(); summary(TODO_SUMMARY_CHANGED_EVENT); },
    close() { try { context?.ui.setWidget("grounded-tasks", undefined); } catch {} context = undefined; for (const remove of removers) { try { remove(); } catch {} } },
  };
}
