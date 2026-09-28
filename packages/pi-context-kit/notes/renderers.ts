import { createToolPresentation } from "pi-tool-controls/presentation";

const object = (value: unknown): Record<string, any> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
const text = (value: unknown): string => typeof value === "string" ? value : "";
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const note = (value: unknown) => {
  const item = object(value);
  return item && typeof item.id === "string" && typeof item.title === "string" && count(item.revision)
    && ["active", "archived"].includes(item.status) ? item : undefined;
};

export const notesPresentation = createToolPresentation({
  call: (args) => `notes ${text(args.action)}${args.id ? ` ${text(args.id)}` : args.query ? ` · ${text(args.query)}` : ""}`,
  result(result, options, context) {
    const saved = result.content.filter((part) => part.type === "text").map((part) => text(part.text)).join("\n");
    const excerpt = saved.slice(0, 4096).split("\n").slice(0, 8);
    if (context.isError || options.isPartial) return {
      summary: context.isError ? "Notes error" : "Notes partial result",
      notices: context.isError && options.isPartial ? ["Partial result"] : [],
      lines: excerpt, omitted: true, tone: context.isError ? "error" : "warning",
    };
    const details = object(result.details);
    const fallback = () => ({ summary: "Notes saved result · format unknown", lines: excerpt, omitted: true });
    if (details?.protocol !== "grounded-state-result/v1") return fallback();
    const value = object(details.result);
    const notices = typeof details.fullOutputPath === "string" ? [`Native text bounded; full output: ${details.fullOutputPath}`] : [];
    if (details.action === "read") {
      const item = note(value);
      if (!item || typeof item.body !== "string") return fallback();
      return {
        summary: `${item.id} r${item.revision} [${item.status}] ${item.title}`,
        notices, lines: options.expanded ? item.body.slice(0, 4096).split("\n").slice(0, 8) : [], omitted: true,
      };
    }
    if (details.action === "list" || details.action === "search") {
      if (!value || !Array.isArray(value.items) || value.items.length > 100 || !value.items.every(note)
        || !count(value.total) || !count(value.cursor) || !count(value.limit)) return fallback();
      if (value.nextCursor !== undefined) notices.push(`More notes; next cursor ${value.nextCursor}`);
      const rows = value.items.slice(0, 8).flatMap((item: Record<string, any>) => [
        `${item.id} r${item.revision} [${item.status}] ${text(item.title)}`,
        ...(typeof item.match === "string" ? [item.match] : []),
      ]);
      return { summary: `${value.items.length} of ${value.total} note(s) · page at ${value.cursor}`, notices,
        lines: options.expanded ? rows : [], omitted: value.items.length > 0 };
    }
    if (["add", "append", "update", "archive", "remove", "clear_archived"].includes(details.action) && value) {
      return { summary: saved.slice(0, 1024) || "Notes saved mutation result", notices, omitted: saved.length > 1024 };
    }
    return fallback();
  },
});
