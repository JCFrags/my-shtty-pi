import { createToolPresentation } from "pi-tool-controls/presentation";

const object = (value: unknown): Record<string, any> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
const text = (value: unknown): string => typeof value === "string" ? value : "";
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export const telemetryPresentation = createToolPresentation({
  call: () => "telemetry_status",
  result(result, options, context) {
    const saved = result.content.filter((part) => part.type === "text").map((part) => text(part.text)).join("\n");
    const excerpt = saved.slice(0, 4096).split("\n").slice(0, 8);
    if (context.isError || options.isPartial) return {
      summary: context.isError ? "Telemetry error" : "Telemetry partial result",
      notices: context.isError && options.isPartial ? ["Partial result"] : [],
      lines: excerpt, omitted: true, tone: context.isError ? "error" : "warning",
    };
    const data = object(result.details), quality = object(data?.quality), storage = object(data?.storage);
    if (data?.version !== 1 || typeof data.active !== "boolean" || !quality || !["unknown", "observed_not_verified"].includes(quality.state)
      || !storage || !["idle", "opening", "recording", "full", "failed", "closed"].includes(storage.state) || typeof storage.error !== "string") {
      return { summary: "Telemetry saved result · format unknown", lines: excerpt, omitted: true };
    }
    const notices = [`Storage ${storage.state}${storage.error !== "none" ? ` (${storage.error})` : ""}`];
    if (count(storage.dropped) && storage.dropped) notices.push(`Dropped records: ${storage.dropped}`);
    if (count(storage.shutdownUnconfirmed) && storage.shutdownUnconfirmed) notices.push(`Shutdown unconfirmed: ${storage.shutdownUnconfirmed}`);
    const runtime = object(data.runtime);
    if (runtime) {
      for (const operation of ["agent", "turn", "tool", "compaction"]) {
        const stats = object(runtime[operation]);
        if (stats && ((count(stats.unpaired) && stats.unpaired) || (count(stats.abandoned) && stats.abandoned))) {
          notices.push(`${operation} gaps: ${count(stats.unpaired) ? stats.unpaired : "unknown"} unpaired; ${count(stats.abandoned) ? stats.abandoned : "unknown"} abandoned`);
        }
      }
      for (const field of ["correlationDrops", "observationErrors"]) if (count(runtime[field]) && runtime[field]) notices.push(`${field}: ${runtime[field]}`);
      const usage = object(runtime.usage);
      for (const source of ["assistant", "tool", "compaction", "branch_summary"]) {
        const stats = object(usage?.[source]);
        if (stats && count(stats.missingOrInvalid) && stats.missingOrInvalid) notices.push(`${source} usage missing/invalid: ${stats.missingOrInvalid}`);
      }
    }
    if (count(quality.rejected) && quality.rejected) notices.push(`Rejected quality observations: ${quality.rejected}`);
    const lines = [`Telemetry ${data.active ? "active" : "inactive"}; runtime is not task success`];
    if (runtime) {
      for (const operation of ["agent", "turn", "tool", "compaction"]) {
        const stats = object(runtime[operation]);
        if (stats && [stats.started, stats.ended, stats.succeeded, stats.failed, stats.aborted].every(count)) {
          lines.push(`${operation}: ${stats.started} started; ${stats.ended} ended; ${stats.succeeded} succeeded; ${stats.failed} failed; ${stats.aborted} aborted`);
        }
      }
      const process = object(runtime.process);
      if (process && count(process.rssBytes) && count(process.heapUsedBytes)) lines.push(`Whole process: RSS ${process.rssBytes} B; heap ${process.heapUsedBytes} B`);
    }
    return { summary: quality.state === "unknown" ? "Quality unknown" : "Quality observed, not verified", tone: "warning", notices,
      lines: options.expanded ? lines : [], omitted: true };
  },
});
