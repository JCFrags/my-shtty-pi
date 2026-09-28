import { createToolPresentation } from "pi-tool-controls/presentation";

const object = (value: unknown): Record<string, any> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
const text = (value: unknown): string => typeof value === "string" ? value : "";
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function record(value: unknown) {
  const item = object(value);
  return item && item.schemaVersion === 1 && typeof item.memoryId === "string" && count(item.revision)
    && typeof item.text === "string" && typeof item.confidence === "number"
    && (item.kind === "knowledge" ? ["current", "demoted", "superseded"] : item.kind === "proposal" ? ["pending", "accepted", "rejected"] : []).includes(item.state)
    && object(item.validity) && object(item.eventTime) ? item : undefined;
}

export function memoryPresentation(name: string) {
  return createToolPresentation({
    call: (args) => `${name}${args.action ? ` ${text(args.action)}` : ""}${args.memoryId ? ` ${text(args.memoryId)}` : args.query ? ` · ${text(args.query)}` : ""}${args.revision !== undefined ? ` r${args.revision}` : ""}${args.recordedBefore ? ` before ${text(args.recordedBefore)}` : ""}`,
    result(result, options, context) {
      const saved = result.content.filter((part) => part.type === "text").map((part) => text(part.text)).join("\n");
      const excerpt = saved.slice(0, 4096).split("\n").slice(0, 8);
      if (context.isError || options.isPartial) return {
        summary: context.isError ? "Memory error" : "Memory partial result",
        notices: context.isError && options.isPartial ? ["Partial result"] : [],
        lines: excerpt, omitted: true, tone: context.isError ? "error" : "warning",
      };
      const fallback = () => ({ summary: "Memory saved result · format unknown", lines: excerpt, omitted: true });
      if (object(result.details)?.protocol !== "context-memory-result-v1" || saved.length > 32768 || Buffer.byteLength(saved, "utf8") > 32768) return fallback();
      let data: Record<string, any> | undefined;
      try { data = object(JSON.parse(saved)); } catch { return fallback(); }
      if (!data || data.status !== "ready") return fallback();
      if (Array.isArray(data.records) && data.records.length > 0 && data.records.length <= 3
        && ["remember", "update", "forget", "promote", "propose", "accept", "reject"].includes(data.action)
        && data.records.every((item: unknown) => { const row = object(item); return row && typeof row.memoryId === "string" && count(row.revision) && typeof row.revisionHash === "string"; })) {
        const notices = data.action === "propose" || data.action === "reject" ? ["Proposal only; not accepted knowledge"]
          : data.action === "accept" ? ["Knowledge and proposal committed together"] : [];
        // The first receipt record is not necessarily the input proposal or the only change.
        return { summary: `${data.action}: ${data.records.length} committed record(s)`, notices,
          lines: options.expanded ? data.records.map((item: Record<string, any>) => `${item.memoryId} r${item.revision}`) : [], omitted: true };
      }
      const item = record(data.memory ?? data.proposal);
      if (item) {
        const notices: string[] = [];
        if (typeof data.validityNow === "string") notices.push(`Validity at saved read: ${data.validityNow}`);
        else notices.push(`Declared validity: ${text(item.validity.kind) || "unknown"}`);
        notices.push("Confidence declared; truth unverified");
        if (item.kind === "proposal") notices.push("Proposal record, not accepted knowledge");
        const temporal = item.validity.kind === "interval" ? `Declared interval: ${item.validity.from ?? "open"} to ${item.validity.until ?? "open"}` : "Declared validity: unknown";
        const event = item.eventTime.kind === "instant" ? `Declared event time: ${text(item.eventTime.at)}` : "Event time: unknown";
        return { summary: `${item.kind} [${item.state}] ${item.memoryId} r${item.revision}`, notices,
          lines: options.expanded ? [item.text.slice(0, 4096), `Declared confidence: ${item.confidence}`, temporal, event] : [], omitted: true };
      }
      const coverage = object(data.coverage);
      if (Array.isArray(data.memories) && data.memories.length <= 100 && data.memories.every(record)
        && data.count === data.memories.length && coverage && typeof coverage.scanComplete === "boolean"
        && [coverage.scanned, coverage.matched, coverage.excluded].every(count)) {
        const notices = [`Scan ${coverage.scanComplete ? "complete" : "incomplete"}; ${coverage.excluded} excluded${data.nextCursor ? "" : "; no cursor"}`, "Confidence declared; truth unverified"];
        if (data.nextCursor) notices.push("Next cursor available in raw result");
        if (coverage.excluded || !coverage.scanComplete) notices.push("Coverage incomplete despite returned page");
        const kind = name === "memory_proposal" ? "proposal" : "knowledge";
        return { summary: `${data.count} ${kind} record(s) · ${coverage.scanned} scanned`, notices,
          lines: options.expanded ? data.memories.slice(0, 8).map((row: Record<string, any>) => `${row.kind} [${row.state}] ${row.memoryId} r${row.revision}: ${text(row.text).slice(0, 1024)}`) : [], omitted: true };
      }
      return fallback();
    },
  });
}
