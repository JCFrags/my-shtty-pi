import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OVERVIEW_CHECKS } from "../src/audits.ts";
import { collect, loadedIdentity } from "../src/collect.ts";
import { Parameters, Output } from "../src/schema.ts";
import { boundReport, checkCatalog } from "../src/render.ts";
import { showDiagnostics } from "../src/ui.ts";
import type { Topic, View } from "../src/types.ts";

/** Registration only. No startup messages, collection timers, stores, or control actions. */
export default function diagnostics(pi: ExtensionAPI): void {
  const loaded = loadedIdentity(new URL(import.meta.url));
  pi.registerTool({
    name: "pi_diagnostics",
    label: "Pi diagnostics",
    description: "Read bounded evidence for this Pi process/session. status gives an overview; inspect requests catalog topics; list_checks discovers predefined audits; audit runs only selected check IDs. Native session totals, active-context estimates, Telemetry collector-run metrics, quality observations, and loaded identities stay separate. Missing evidence is unavailable, not healthy. Does not reload, repair, compact, install, initialize stores, open remote sessions, call models, or save/publish reports.",
    promptSnippet: "Inspect current Pi evidence and predefined read-only checks",
    parameters: Parameters,
    outputSchema: Output,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) {
      const report = boundReport(params.action === "list_checks" ? checkCatalog(params.offset, params.limit) : await collect(pi, ctx, loaded,
        params.action === "status" ? { topics: ["runtime", "session", "telemetry", "components"], checkIds: OVERVIEW_CHECKS, view: "summary" }
          : params.action === "inspect" ? { topics: params.topics as Topic[], view: params.view as View | undefined, offset: params.offset, limit: params.limit }
          : { topics: [], checkIds: params.checkIds, view: params.view as View | undefined, offset: params.offset, limit: params.limit }, signal));
      const structuredContent = JSON.parse(JSON.stringify(report));
      return { content: [{ type: "text", text: JSON.stringify(report) }], details: report, structuredContent };
    },
  });
  pi.registerCommand("diagnostics", {
    description: "Inspect Pi diagnostics and save an explicit private local report",
    async handler(_args, ctx) {
      await showDiagnostics(ctx, async request => boundReport(await collect(pi, ctx, loaded, request)));
    },
  });
}
