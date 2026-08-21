import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { loadTodoDisplayMode, saveTodoDisplayMode, type TodoDisplayMode } from "./settings.ts";
import { Type } from "typebox";
import {
  addTask,
  clearDone,
  cloneTaskState,
  completeTask,
  emptyTaskState,
  refreshBlockedStatuses,
  removeTask,
  reorderTask,
  startTask,
  taskById,
  type Task,
  type TaskState,
  updateTask,
  validateTaskState,
} from "@grounded/pi-core/tasks";

const ReplacementTaskSchema = Type.Object({
  id: Type.Optional(Type.String()),
  text: Type.String(),
  description: Type.Optional(Type.String()),
  status: Type.Optional(StringEnum(["pending", "in_progress", "blocked", "done"] as const)),
  blockedBy: Type.Optional(Type.Array(Type.String())),
  waitReason: Type.Optional(Type.String({ description: "External condition that must clear before work can continue" })),
});

const TodoParams = Type.Object({
  action: StringEnum(["list", "add", "update", "start", "done", "block", "remove", "reorder", "clear_done", "replace"] as const),
  id: Type.Optional(Type.String({ description: "Task id" })),
  text: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  blockedBy: Type.Optional(Type.Array(Type.String())),
  waitReason: Type.Optional(Type.String({ description: "External condition that must clear before work can continue; use an empty string to clear it" })),
  position: Type.Optional(Type.Number({ minimum: 0, description: "Zero-based target position for reorder" })),
  tasks: Type.Optional(Type.Array(ReplacementTaskSchema, { description: "Complete desired task list for replace" })),
});

interface TodoDetails {
  action: string;
  state: TaskState;
}

function formatTask(task: Task): string {
  const marker = task.status === "done" ? "✓" : task.status === "in_progress" ? "●" : task.status === "blocked" ? "⊘" : "○";
  const blockers = task.blockedBy.length ? ` [blockedBy: ${task.blockedBy.join(", ")}]` : "";
  const waiting = task.waitReason ? ` [waiting: ${task.waitReason}]` : "";
  return `${marker} ${task.id} ${task.text}${blockers}${waiting}`;
}

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

class TodoListView {
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

interface GroundedTasksOptions {
  settingsPath?: string;
}

export default function groundedTasks(pi: ExtensionAPI, options: GroundedTasksOptions = {}) {
  let state = emptyTaskState();
  let currentContext: ExtensionContext | undefined;
  let displayMode: TodoDisplayMode = "compact";

  const snapshot = () => cloneTaskState(state);

  const restore = (ctx: ExtensionContext) => {
    state = emptyTaskState();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo") {
        const details = entry.message.details as TodoDetails | undefined;
        if (details?.state) state = cloneTaskState(details.state);
      } else if (entry.type === "custom" && entry.customType === "grounded-tasks-state") {
        const candidate = entry.data as TaskState;
        try {
          validateTaskState(candidate);
          state = cloneTaskState(candidate);
        } catch {
          // Ignore malformed historical snapshots.
        }
      }
    }
    refreshBlockedStatuses(state);
  };

  const renderWidget = () => {
    if (!currentContext?.hasUI) return;
    const unfinished = state.tasks.filter((task) => task.status !== "done");
    if (!unfinished.length) {
      currentContext.ui.setWidget("grounded-tasks", undefined);
      return;
    }
    currentContext.ui.setWidget("grounded-tasks", (_tui, theme) => ({
      render(width: number) {
        const safeWidth = Math.max(1, width);
        const done = state.tasks.filter((task) => task.status === "done").length;
        const blocked = unfinished.filter((task) => task.status === "blocked").length;
        const current = unfinished.find((task) => task.status === "in_progress")
          ?? unfinished.find((task) => task.status === "pending")
          ?? unfinished[0]!;
        if (displayMode === "compact" || safeWidth < 36) {
          const summary = `${theme.fg("accent", "Todos")} ${done}/${state.tasks.length}`
            + (blocked ? theme.fg("warning", ` • ${blocked} blocked`) : "")
            + theme.fg("dim", " • /todos")
            + ` • ${taskMarker(current, theme)} ${current.text}`;
          return [truncateToWidth(summary, safeWidth)];
        }
        const visible = unfinished.slice(0, 5);
        const hidden = unfinished.length - visible.length;
        const header = `${theme.fg("accent", "Todos")} ${done}/${state.tasks.length}`
          + (blocked ? theme.fg("warning", ` • ${blocked} blocked`) : "")
          + theme.fg("dim", " • Ctrl+Shift+U size • /todos full");
        const lines = [header, ...visible.map((task) => renderTaskRow(task, theme, safeWidth))];
        if (hidden) lines.push(theme.fg("dim", `… ${hidden} more • /todos full`));
        return lines.map((line) => truncateToWidth(line, safeWidth));
      },
      invalidate() {},
    }));
  };

  const setDisplayMode = (mode: TodoDisplayMode) => {
    saveTodoDisplayMode(mode, options.settingsPath);
    displayMode = mode;
    renderWidget();
  };

  pi.on("session_start", (_event, ctx) => {
    currentContext = ctx;
    displayMode = loadTodoDisplayMode(options.settingsPath);
    restore(ctx);
    renderWidget();
  });
  pi.on("session_tree", (_event, ctx) => {
    currentContext = ctx;
    restore(ctx);
    renderWidget();
  });
  pi.on("session_shutdown", () => {
    currentContext?.ui.setWidget("grounded-tasks", undefined);
    currentContext = undefined;
  });

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Manage a visible, branch-aware task plan. Supports valid task dependencies, external wait reasons, one in-progress task, completion, blocking, reordering, and complete replacement.",
    promptSnippet: "Track multi-step work in a branch-aware task plan",
    promptGuidelines: [
      "Use todo for work with multiple meaningful steps; do not create todos for trivial one-step requests.",
      "Mark a todo done only after implementation and relevant verification are complete.",
    ],
    parameters: TodoParams,
    executionMode: "sequential",
    async execute(_id, params) {
      let message: string;
      let working = cloneTaskState(state);
      if (params.action === "list") {
        message = state.tasks.length ? state.tasks.map(formatTask).join("\n") : "No todos";
      } else if (params.action === "add") {
        if (!params.text) throw new Error("text is required for add");
        const task = addTask(working, {
          text: params.text,
          ...(params.description !== undefined ? { description: params.description } : {}),
          ...(params.blockedBy !== undefined ? { blockedBy: params.blockedBy } : {}),
          ...(params.waitReason !== undefined ? { waitReason: params.waitReason } : {}),
        });
        message = `Added ${task.id}: ${task.text}`;
      } else if (params.action === "update" || params.action === "block") {
        if (!params.id) throw new Error(`id is required for ${params.action}`);
        const task = updateTask(working, params.id, {
          ...(params.text !== undefined ? { text: params.text } : {}),
          ...(params.description !== undefined ? { description: params.description } : {}),
          ...(params.blockedBy !== undefined ? { blockedBy: params.blockedBy } : {}),
          ...(params.waitReason !== undefined ? { waitReason: params.waitReason } : {}),
        });
        if (params.action === "block" && task.status !== "blocked") {
          throw new Error("block requires an unfinished dependency in blockedBy or a waitReason");
        }
        message = `Updated ${task.id}: ${task.text}`;
      } else if (params.action === "start") {
        if (!params.id) throw new Error("id is required for start");
        const task = startTask(working, params.id);
        message = `Started ${task.id}: ${task.text}`;
      } else if (params.action === "done") {
        if (!params.id) throw new Error("id is required for done");
        const task = completeTask(working, params.id);
        message = `Completed ${task.id}: ${task.text}`;
      } else if (params.action === "remove") {
        if (!params.id) throw new Error("id is required for remove");
        removeTask(working, params.id);
        message = `Removed ${params.id}`;
      } else if (params.action === "reorder") {
        if (!params.id || params.position === undefined) throw new Error("id and position are required for reorder");
        reorderTask(working, params.id, params.position);
        message = `Moved ${params.id} to position ${params.position}`;
      } else if (params.action === "clear_done") {
        message = `Cleared ${clearDone(working)} completed task(s)`;
      } else {
        if (!params.tasks) throw new Error("tasks is required for replace");
        const now = Date.now();
        const ids = params.tasks.map((task, index) => task.id ?? `T${index + 1}`);
        working = {
          nextId: ids.reduce((max, id) => Math.max(max, /^T(\d+)$/.test(id) ? Number(id.slice(1)) + 1 : 1), 1),
          tasks: params.tasks.map((replacement, index) => ({
            id: ids[index]!,
            text: replacement.text.trim(),
            ...(replacement.description?.trim() ? { description: replacement.description.trim() } : {}),
            status: replacement.status ?? "pending",
            blockedBy: [...(replacement.blockedBy ?? [])],
            ...(replacement.waitReason?.trim() ? { waitReason: replacement.waitReason.trim() } : {}),
            createdAt: now,
            updatedAt: now,
          })),
        };
        validateTaskState(working);
        const inProgress = working.tasks.filter((task) => task.status === "in_progress");
        if (inProgress.length > 1) throw new Error("replace accepts at most one in_progress task");
        refreshBlockedStatuses(working);
        if (inProgress[0]) startTask(working, inProgress[0].id);
        message = `Replaced task plan with ${working.tasks.length} task(s)`;
      }
      if (params.action !== "list") state = working;
      renderWidget();
      return { content: [{ type: "text", text: message }], details: { action: params.action, state: snapshot() } satisfies TodoDetails };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action) + (args.id ? ` ${theme.fg("accent", args.id)}` : ""), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as TodoDetails | undefined;
      if (!details) return new Text("", 0, 0);
      const first = result.content[0];
      const message = first?.type === "text" ? first.text : "";
      if (details.action === "list") return new Text(`${theme.fg("success", "✓")} ${message}`, 0, 0);
      const tasks = expanded ? details.state.tasks : details.state.tasks.filter((task) => task.status !== "done").slice(0, 5);
      return new Text(`${theme.fg("success", "✓")} ${message}${tasks.length ? `\n${tasks.map(formatTask).join("\n")}` : ""}`, 0, 0);
    },
  });

  pi.registerCommand("todos", {
    description: "Open all todos, or set widget size: /todos [full|compact|plan]",
    handler: async (args, ctx) => {
      const choice = args.trim().toLowerCase();
      if (choice === "compact" || choice === "plan") {
        try {
          setDisplayMode(choice);
          ctx.ui.notify(`Todo widget: ${choice}`, "info");
        } catch (error) {
          ctx.ui.notify(`Could not save todo widget size: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      if (choice && choice !== "full") {
        ctx.ui.notify("Usage: /todos [full|compact|plan]", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify(state.tasks.length ? state.tasks.map(formatTask).join("\n") : "No todos", "info");
        return;
      }
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const terminal = tui as typeof tui & { terminal?: { rows?: number } };
        return new TodoListView(
          snapshot(),
          theme,
          () => terminal.terminal?.rows ?? 24,
          () => tui.requestRender(),
          () => done(),
        );
      }, {
        overlay: true,
        overlayOptions: { width: "96%", minWidth: 20, maxHeight: "90%", anchor: "center", margin: 1 },
      });
    },
  });

  pi.registerShortcut("ctrl+shift+u", {
    description: "Toggle compact and plan todo widget sizes",
    handler: async (ctx) => {
      const next = displayMode === "compact" ? "plan" : "compact";
      try {
        setDisplayMode(next);
        ctx.ui.notify(`Todo widget: ${next}`, "info");
      } catch (error) {
        ctx.ui.notify(`Could not save todo widget size: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("todo-add", {
    description: "Add a task manually: /todo-add <text>",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /todo-add <text>", "warning");
        return;
      }
      const task = addTask(state, { text: args });
      pi.appendEntry("grounded-tasks-state", snapshot());
      renderWidget();
      ctx.ui.notify(`Added ${task.id}: ${task.text}`, "info");
    },
  });
}
