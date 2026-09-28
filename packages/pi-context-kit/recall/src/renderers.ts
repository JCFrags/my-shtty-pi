import { createToolPresentation } from "pi-tool-controls/presentation";

const object = (value: unknown): Record<string, any> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
const text = (value: unknown): string => typeof value === "string" ? value : "";
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const providers = ["todo", "notes", "workplan", "memory"];
const statuses = ["ok", "tool_inactive", "missing_or_timeout", "malformed", "provider_error", "response_budget", "cancelled", "scope_changed"];
function provider(value: unknown) {
  const item = object(value);
  if (!item || !providers.includes(item.providerId) || !statuses.includes(item.status)) return;
  if (item.status !== "ok") return item.page === undefined ? item : undefined;
  const page = object(item.page), coverage = object(page?.coverage);
  if (!page || !["ready", "unavailable", "pending", "corrupt", "scope_changed"].includes(page.readiness)
    || !coverage || typeof coverage.scanComplete !== "boolean" || ![coverage.scanned, coverage.matched, coverage.excluded].every(count)
    || !Array.isArray(page.cards) || page.cards.length > 16 || !page.cards.every((raw: unknown) => {
      const card = object(raw);
      return card && [card.id, card.revision, card.status, card.category, card.title, card.text].every((field) => typeof field === "string")
        && Array.isArray(card.omittedFields) && card.omittedFields.every((field: unknown) => typeof field === "string");
    })) return;
  return item;
}

export const recallPresentation = createToolPresentation({
  call: (args) => `context_recall${args.query ? ` · ${text(args.query)}` : " · browse"}${Array.isArray(args.providers) ? ` [${args.providers.filter((item) => typeof item === "string").join(", ")}]` : ""}`,
  result(result, options, context) {
    const saved = result.content.filter((part) => part.type === "text").map((part) => text(part.text)).join("\n");
    const excerpt = saved.slice(0, 4096).split("\n").slice(0, 8);
    if (context.isError || options.isPartial) return {
      summary: context.isError ? "Recall error" : "Recall partial result",
      notices: context.isError && options.isPartial ? ["Partial result"] : [],
      lines: excerpt, omitted: true, tone: context.isError ? "error" : "warning",
    };
    const fallback = () => ({ summary: "Recall saved result · format unknown", lines: excerpt, omitted: true });
    if (object(result.details)?.protocol !== "context-kit-recall-v2" || saved.length > 32768 || Buffer.byteLength(saved, "utf8") > 32768) return fallback();
    let data: Record<string, any> | undefined;
    try { data = object(JSON.parse(saved)); } catch { return fallback(); }
    if (!data || data.version !== 2 || typeof data.complete !== "boolean" || !Array.isArray(data.providers)
      || !data.providers.length || data.providers.length > 4 || !data.providers.every(provider)
      || new Set(data.providers.map((item: Record<string, any>) => item.providerId)).size !== data.providers.length) return fallback();
    const notices: string[] = [], rows: string[] = [];
    let cards = 0;
    for (const item of data.providers) {
      if (item.status !== "ok") { notices.push(`${item.providerId}: transport ${item.status}`); continue; }
      const page = item.page, coverage = page.coverage;
      const omitted = page.cards.filter((card: Record<string, any>) => card.omittedFields.length > 0).length;
      if (page.readiness !== "ready" || !coverage.scanComplete || coverage.excluded || omitted) {
        notices.push(`${item.providerId}: ${page.readiness}${!coverage.scanComplete ? "; scan incomplete" : ""}${coverage.excluded ? `; ${coverage.excluded} excluded` : ""}${omitted ? `; ${omitted} card(s) omit fields` : ""}`);
      }
      cards += page.cards.length;
      rows.push(`${item.providerId}: transport ok; ${page.readiness}; ${page.cards.length} card(s)`);
      for (const card of page.cards.slice(0, 2)) rows.push(`${card.category} [${card.status}] ${card.id} r${card.revision}: ${text(card.title)}\n${text(card.text).slice(0, 1024)}`);
    }
    // Four affected providers need all four notice slots. Keep the overall state in
    // the first notice instead of displacing a provider with a summary row.
    const summary = `${cards} current-state card(s) · ${data.complete ? "bounded complete" : "incomplete"}`;
    if (notices.length === 4) notices[0] = `${data.complete ? "Reported complete" : "Incomplete"}; ${notices[0]}`;
    return { summary: notices.length === 4 ? undefined : summary, notices,
      lines: options.expanded ? rows : [], omitted: true };
  },
});
