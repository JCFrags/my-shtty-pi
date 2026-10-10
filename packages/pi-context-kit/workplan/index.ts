import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { registerContextProvider, type ProviderPage } from "@context-kit/protocol";
import { registerStateTransferProvider, StateTransferError, type StateTransferEntry } from "@context-kit/protocol/transfer";
import type { ObjectRef, StateAnchorHost } from "@context-kit/state-store";
import { boundedStateOutput, STATE_RESULT_PROTOCOL, StateToolError } from "@grounded/pi-core/state";
import {
  validateWorkplanSummaryRequest, workplanBranchId, WORKPLAN_ACTIVITY_EVENT,
  WORKPLAN_SUMMARY_CHANGED_EVENT, WORKPLAN_SUMMARY_EVENT, WORKPLAN_SUMMARY_REQUEST_EVENT,
} from "@grounded/pi-core/workplan-summary";
import { bootstrapWorkplanCheckpoint, finishWorkplanImport, importWorkplanStep, WORKPLAN_OWNED_RESULT } from "./legacy.ts";
import { metadataContextLine } from "./model.ts";
import {
  prepareWorkplanArguments, WORKPLAN_DESCRIPTION, WORKPLAN_GUIDELINES, WORKPLAN_PROMPT_SNIPPET, WorkplanParams,
} from "./schema.ts";
import { WorkplanStore } from "./store.ts";
import { workplanPresentation } from "./renderers.ts";
import { contextMessage, latestVisibleRecovery } from "./ui.ts";

export { WorkplanStore } from "./store.ts";
export { WorkplanParams, prepareWorkplanArguments } from "./schema.ts";
export { bootstrapWorkplanCheckpoint, importWorkplanStep, finishWorkplanImport } from "./legacy.ts";

const refusal = (readiness: ProviderPage["readiness"]): ProviderPage => ({ readiness, cards: [], coverage: { scanned: 0, matched: 0, excluded: 0, scanComplete: false } });

// Keep passive notices outside the correlated compaction summary exchange.
function isCompactionSummaryTurn(event: TurnEndEvent & { outcome?: string }): boolean {
  if (event.outcome !== "completed" || event.message.role !== "assistant" || event.toolResults.length !== 1) return false;
  const calls = event.message.content.filter((block) => block.type === "toolCall");
  const call = calls[0];
  const result = event.toolResults[0];
  if (calls.length !== 1 || call?.name !== "request_compaction" || result?.toolName !== call.name
    || result.toolCallId !== call.id || result.isError !== false) return false;
  const details = result.details;
  if (!details || typeof details.requestId !== "string" || !details.requestId) return false;
  return details.status === "summary-requested" ? Object.keys(call.arguments).length === 0
    : details.status === "accepted" && call.arguments.requestId === details.requestId;
}

/** Independent extension entrypoint. Native reducers and contracts are shared,
 * but the old extension factory and its tool-result replay lifecycle are not.
 */
export function createWorkplanExtension(pi: ExtensionAPI, options: { storeRoot?: string; ancestryPageEntries?: number } = {}): WorkplanStore {
  const store = new WorkplanStore(options);
  let context: ExtensionContext | undefined;
  let branchId = "root";
  let epoch = 0;
  let readingContext = false;
  const contextJobs = new Set<AbortController>();
  const host = (ctx: ExtensionContext = context!): StateAnchorHost => ({
    sessionManager: ctx.sessionManager,
    appendEntry: (type, data) => pi.appendEntry(type, data),
  });
  const scope = () => context ? { sessionId: context.sessionManager.getSessionId(), leafId: context.sessionManager.getLeafId() } : undefined;
  const changed = () => {
    try { pi.events.emit(WORKPLAN_SUMMARY_CHANGED_EVENT, { version: 1, branchId }); } catch { /* Optional listeners cannot undo a native commit. */ }
  };

  const restore = async (ctx: ExtensionContext) => {
    context = ctx; epoch++; store.invalidate();
    branchId = workplanBranchId(ctx.sessionManager.getLeafId());
    try {
      const resolved = await store.exclusive(() => store.resolve(host(ctx), ctx.signal));
      if (resolved.status === "legacy") await bootstrapWorkplanCheckpoint(store, host(ctx), ctx.signal);
    } catch {
      // Keep explicit unresolved/corrupt status. Never substitute empty state.
    }
    // Restoration invalidates summaries but never replays activity notifications.
    changed();
  };

  const removeSummary = pi.events.on(WORKPLAN_SUMMARY_REQUEST_EVENT, (raw: unknown) => {
    let request;
    try { request = validateWorkplanSummaryRequest(raw); } catch { return; }
    if (request.branchId !== undefined && request.branchId !== branchId) return;
    pi.events.emit(WORKPLAN_SUMMARY_EVENT, {
      version: 1, requestId: request.requestId, ...(request.branchId === undefined ? {} : { branchId }),
      summary: store.pending || store.corrupt ? { version: 1 } : store.root?.summary ?? { version: 1 },
    });
  });
  const removeContext = registerContextProvider(pi.events, "workplan", async (request) => {
    if (!context || !pi.getActiveTools().includes("workplan")) return refusal("unavailable");
    if (readingContext) return refusal("pending");
    readingContext = true;
    const controller = new AbortController(); contextJobs.add(controller);
    const timer = setTimeout(() => controller.abort(), Math.max(1, request.deadlineMs - Date.now()));
    try {
      const page = await store.contextPage(host(), request, controller.signal);
      return pi.getActiveTools().includes("workplan") ? page : refusal("unavailable");
    } finally { clearTimeout(timer); contextJobs.delete(controller); readingContext = false; }
  });
  const removeTransfer = registerStateTransferProvider(pi.events, "workplan", async (request, signal) => {
    if (!context) throw new StateTransferError("state-checkpoint-pending");
    try {
      const captured = await store.capture(host(), request.maxBytes, signal);
      const source = { sourceSessionId: request.scope.sessionId, sourceLeafId: request.scope.leafId };
      const entries: StateTransferEntry[] = [{ customType: "grounded-state-checkpoint-v1", data: {
        version: 1, provider: "workplan", ...source, state: captured.state,
      } }];
      if (captured.owner) entries.push({ customType: "context-kit:owner-binding:v1", data: {
        version: 1, provider: "workplan", ...source, binding: captured.owner,
      } });
      return entries;
    } catch (error) {
      if (error instanceof StateToolError) throw new StateTransferError(error.code === "STATE_LIMIT_EXCEEDED" ? "state-checkpoint-budget"
        : error.code === "STATE_CONFLICT" || error.code === "STATE_CANCELLED" ? "state-checkpoint-pending" : "state-checkpoint-corrupt");
      throw error;
    }
  }, scope);

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_before_tree", () => {
    epoch++; store.invalidate(); for (const job of contextJobs) job.abort();
  });
  pi.on("session_shutdown", () => {
    epoch++; for (const job of contextJobs) job.abort();
    context = undefined; store.close(); removeSummary(); removeContext(); removeTransfer();
  });
  const stateNotice = async (ctx: ExtensionContext) => {
    context = ctx;
    if (!store.pending || store.resolutionStatus === "pending" || store.resolutionStatus === "unresolved") {
      try { await store.exclusive(() => store.resolve(host(ctx), ctx.signal)); } catch { /* Explicit status below. */ }
    }
    const messages = ctx.sessionManager.buildSessionContext().messages;
    const previous = messages.findLast((message) => message.role === "custom" && message.customType === "grounded-workplan-context");
    const text = store.corrupt ? "[workplan state] corrupt; native recovery is unavailable"
      : store.pending ? `[workplan state] ${store.resolutionStatus}; no complete native plan is selected`
        : store.root ? metadataContextLine(store.root, latestVisibleRecovery(messages))
          ?? (previous ? "[workplan state] active=none open=none openCount=0 retained=0 completed=0 archived=0" : undefined) : undefined;
    return text && (previous?.role !== "custom" || previous.content !== text) ? contextMessage(text) : undefined;
  };
  // Persist changes once. Earlier notices stay in place across requests and reloads.
  pi.on("before_agent_start", async (_event, ctx) => {
    const message = await stateNotice(ctx);
    return message ? { message } : undefined;
  });
  pi.on("turn_end", async (event, ctx) => {
    if (isCompactionSummaryTurn(event)) return;
    const message = await stateNotice(ctx);
    if (message) pi.sendMessage(message, { triggerTurn: false });
  });

  pi.registerCommand("workplan-import", {
    description: "Advance one bounded Workplan legacy-import page, or finish a completed import. Progress survives restart at the same source cut.",
    handler: async (args, ctx) => {
      context = ctx;
      let cursor: ObjectRef | undefined;
      if (args.trim()) {
        if (Buffer.byteLength(args, "utf8") > 4096) throw new StateToolError("STATE_INVALID_INPUT", "Workplan import cursor is too large");
        try { cursor = JSON.parse(args); } catch { throw new StateToolError("STATE_INVALID_INPUT", "Workplan import cursor must be its complete JSON object reference"); }
      }
      const resolved = await store.exclusive(() => store.resolve(host(ctx), ctx.signal));
      if (resolved.status === "ready") { ctx.ui.notify("Workplan already has a selected owned root.", "info"); return; }
      if (resolved.status === "pending") { ctx.ui.notify("Workplan ancestry lookup advanced one page. Run /workplan-import again.", "info"); return; }
      const progress = await importWorkplanStep(store, host(ctx), cursor, ctx.signal);
      if (progress.status === "complete") {
        await finishWorkplanImport(store, host(ctx), progress.cursor, ctx.signal); changed();
        ctx.ui.notify("Complete Workplan native state imported and durably bound.", "info");
      } else {
        ctx.ui.notify(`Workplan import ${progress.phase}: ${progress.scannedEntries} source entries, ${progress.providerEntries} native entries. Run /workplan-import again.`, "info");
      }
    },
  });

  pi.registerTool({
    name: "workplan", label: "Workplan", description: WORKPLAN_DESCRIPTION,
    promptSnippet: WORKPLAN_PROMPT_SNIPPET, promptGuidelines: WORKPLAN_GUIDELINES,
    parameters: WorkplanParams, prepareArguments: prepareWorkplanArguments, executionMode: "sequential",
    ...workplanPresentation,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      context = ctx;
      const operationEpoch = epoch;
      // Fresh native checkpoints can also bootstrap after a deferred initial file write.
      if (store.resolutionStatus === "legacy") await bootstrapWorkplanCheckpoint(store, host(ctx), signal);
      const operation = await store.execute(host(ctx), params, signal);
      if (operationEpoch !== epoch) throw new StateToolError("STATE_CONFLICT", "Workplan branch changed during the operation");
      if (operation.eventRef) {
        if (operation.activity) {
          try { pi.events.emit(WORKPLAN_ACTIVITY_EVENT, operation.activity); } catch { /* State is already durable. */ }
        }
        changed();
      }
      const bounded = await boundedStateOutput(operation.text, "grounded-workplan", signal,
        params.action === "read" ? {} : { maxBytes: 48 * 1024, maxLines: 1500 });
      if (operationEpoch !== epoch) throw new StateToolError("STATE_CONFLICT", "Workplan branch changed while rendering output");
      return { content: [{ type: "text" as const, text: bounded.text }], details: {
        protocol: STATE_RESULT_PROTOCOL, ownerProtocol: WORKPLAN_OWNED_RESULT, action: params.action,
        ...(operation.event ? { event: operation.event } : {}), ...(operation.eventRef ? { eventRef: operation.eventRef } : {}),
        ...(operation.activity ? { activity: operation.activity } : {}), ...(operation.recovery ? { recovery: operation.recovery } : {}),
        ...(operation.owner ? { owner: operation.owner } : {}),
        result: operation.result ?? bounded.text,
        ...(operation.metadataOmissions?.length ? { metadataOmissions: operation.metadataOmissions } : {}),
        ...(bounded.fullOutputPath ? { fullOutputPath: bounded.fullOutputPath } : {}),
      } };
    },
  });
  return store;
}

export default function workplan(pi: ExtensionAPI): void { createWorkplanExtension(pi); }
