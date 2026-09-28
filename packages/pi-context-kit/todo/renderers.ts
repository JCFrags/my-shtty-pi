import { createToolPresentation } from "pi-tool-controls/presentation";

const object = (value: unknown): Record<string, any> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
const text = (value: unknown): string => typeof value === "string" ? value : "";
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const actions = ["list", "add", "update", "start", "done", "block", "remove", "reorder", "clear_done", "replace"];

export const todoPresentation = createToolPresentation({
  call: (args) => `todo ${text(args.action)}${args.id ? ` ${text(args.id)}` : ""}`,
  result(result, options, context) {
    const saved = result.content.filter((part) => part.type === "text").map((part) => text(part.text)).join("\n");
    const excerpt = saved.slice(0, 4096).split("\n").slice(0, 8);
    if (context.isError || options.isPartial) return {
      summary: context.isError ? "Todo error" : "Todo partial result",
      notices: context.isError && options.isPartial ? ["Partial result"] : [],
      lines: excerpt, omitted: true, tone: context.isError ? "error" : "warning",
    };
    const details = object(result.details);
    if (details?.protocol !== "context-kit-todo-result/v1" || !actions.includes(details.action)
      || !count(details.total) || !Array.isArray(details.rows) || !details.rows.every((row: unknown) => typeof row === "string")) {
      return { summary: "Todo saved result · format unknown", lines: excerpt, omitted: true };
    }
    const notices: string[] = [];
    if (typeof details.fullOutputPath === "string") {
      notices.push(`Native result bounded; ${count(details.omittedTasks) ? details.omittedTasks : "unknown"} task rows omitted`);
      notices.push(`Complete native state: ${details.fullOutputPath}`);
    }
    if (details.action !== "list") return {
      summary: saved.slice(0, 1024) || "Todo saved mutation result",
      notices, lines: options.expanded ? details.rows.slice(0, 8) : [],
      omitted: details.rows.length > 0 || saved.length > 1024,
    };
    const tasks = object(details.state)?.tasks;
    if (Array.isArray(tasks) && tasks.length === details.total && tasks.length <= 256 && tasks.every((task) => {
      const value = object(task);
      return value && typeof value.id === "string" && typeof value.text === "string"
        && ["pending", "in_progress", "blocked", "done"].includes(value.status) && Array.isArray(value.blockedBy);
    })) {
      const blocked = tasks.filter((task) => task.status === "blocked").length;
      const waiting = tasks.filter((task) => text(task.waitReason)).length;
      if (blocked || waiting) notices.push(`${blocked} blocked; ${waiting} waiting`);
      const rows = tasks.slice(0, 8).map((task) => `${task.id} [${task.status}] ${text(task.text).slice(0, 1024)}${task.blockedBy.length ? ` [blockedBy: ${task.blockedBy.join(", ")}]` : ""}${task.waitReason ? ` [waiting: ${text(task.waitReason).slice(0, 1024)}]` : ""}`);
      return { summary: `${details.total} task(s)`, notices, lines: options.expanded ? rows : [], omitted: tasks.length > 0 };
    }
    // Large native lists return saved text and a path, not complete task objects.
    if (!details.fullOutputPath) notices.push("Complete task state unavailable in this saved result");
    return { summary: `${details.total} task(s)`, notices, lines: options.expanded ? excerpt.slice(details.fullOutputPath ? 1 : 0) : [], omitted: true };
  },
});
