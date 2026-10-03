import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerContextProvider, sameScope, type ProviderPage } from "@context-kit/protocol";
import { registerStateTransferProvider, StateTransferError } from "@context-kit/protocol/transfer";
import { projectTodoPage } from "@grounded/pi-core/context-adapters";
import { StateToolError } from "@grounded/pi-core/state";
import { TodoParams, validateTodoState, type TodoInput } from "./operations.ts";
import { todoResult } from "./output.ts";
import { todoPresentation } from "./renderers.ts";
import { TodoStore } from "./store.ts";
import { registerTodoUi } from "./ui.ts";

export { TodoParams, validateTodoState };
export { TodoStore } from "./store.ts";
export interface TodoOptions { storeRoot?: string; settingsPath?: string; outputRoot?: string }
const refusal = (readiness: ProviderPage["readiness"]): ProviderPage => ({ readiness, cards: [], coverage: { scanned: 0, matched: 0, excluded: 0, scanComplete: false } });

/** Independent state owner. Importing the module does not open a store. */
export default function contextTodo(pi: ExtensionAPI, options: TodoOptions = {}) {
  const store = new TodoStore({ ...(options.storeRoot ? { storeRoot: options.storeRoot } : {}) });
  let context: ExtensionContext | undefined;
  const scope = () => context ? { sessionId: context.sessionManager.getSessionId(), leafId: context.sessionManager.getLeafId() } : undefined;
  const removers: Array<() => void> = [];
  const requireContext = (ctx: ExtensionContext) => {
    if (!context || ctx.sessionManager !== context.sessionManager) throw new StateToolError("STATE_CONFLICT", "Todo session changed");
  };
  const execute = async (input: TodoInput, ctx: ExtensionContext, signal?: AbortSignal) => {
    requireContext(ctx);
    try { return await store.execute(input, signal); } finally { ui.changed(); }
  };
  const ui = registerTodoUi(pi, {
    state: () => store.stateView(), execute,
    list: async (ctx) => {
      const operation = await execute({ action: "list" }, ctx);
      return (await todoResult({ action: "list" }, operation, operation.owner, undefined, options.outputRoot)).content[0]!.text;
    },
  }, options.settingsPath);
  try {
    removers.push(registerContextProvider(pi.events, "todo", (request) => {
      const current = scope();
      if (!current || !pi.getActiveTools().includes("todo")) return refusal("unavailable");
      if (!sameScope(current, request.scope)) return refusal("scope_changed");
      const state = store.stateView();
      if (!state) return refusal(store.readiness());
      const page = projectTodoPage(request, state, (task) => store.revisionForTask(task.id));
      const after = scope();
      if (!after || !sameScope(after, request.scope)) return refusal("scope_changed");
      if (store.readiness() !== "ready") return refusal(store.readiness());
      return pi.getActiveTools().includes("todo") ? page : refusal("unavailable");
    }));
  } catch { /* Context is an optional read-only consumer. */ }
  try { removers.push(registerStateTransferProvider(pi.events, "todo", async (_request, signal) => {
    if (store.readiness() !== "ready") throw new StateTransferError(store.readiness() === "corrupt" ? "state-checkpoint-corrupt" : "state-checkpoint-pending");
    try {
      const captured = await store.checkpoint(signal);
      const source = scope();
      if (!source) throw new StateTransferError("state-checkpoint-scope");
      return [
        { customType: "grounded-state-checkpoint-v1", data: { version: 1, provider: "todo", sourceSessionId: source.sessionId, sourceLeafId: source.leafId, state: captured.state } },
        { customType: "context-kit:owner-binding:v1", data: { version: 1, provider: "todo", sourceSessionId: source.sessionId, sourceLeafId: source.leafId, binding: captured.owner } },
      ];
    } catch (error) {
      if (error instanceof StateTransferError) throw error;
      throw new StateTransferError(error instanceof StateToolError && error.code === "STATE_LIMIT_EXCEEDED" ? "state-checkpoint-budget" : store.readiness() === "corrupt" ? "state-checkpoint-corrupt" : "state-checkpoint-pending");
    }
  }, scope)); } catch { /* A missing transfer response makes rollover refuse, not native writes. */ }
  const bind = async (ctx: ExtensionContext) => {
    context = ctx;
    try { await store.open({ sessionManager: ctx.sessionManager, appendEntry: (type, data) => pi.appendEntry(type, data) }); }
    catch (error) { if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : "Todo restore failed", "error"); }
    ui.bind(ctx);
  };
  pi.on("session_start", async (_event, ctx) => bind(ctx));
  pi.on("session_tree", async (_event, ctx) => bind(ctx));
  pi.on("agent_settled", async () => { try { await store.refresh(); } catch { /* Native reads expose pending/corrupt recovery. */ } ui.changed(); });
  pi.on("session_shutdown", () => {
    store.close(); ui.close(); context = undefined;
    for (const remove of removers) { try { remove(); } catch { /* Idempotent optional cleanup. */ } }
  });
  pi.registerTool({
    name: "todo", label: "Todo",
    description: "Manage a visible, branch-aware task plan. Supports valid task dependencies, external wait reasons, one in-progress task, completion, blocking, reordering, and complete replacement. Up to 256 tasks and 1 MiB canonical state. list defaults to current tasks and hides done tasks without removal; view=all returns complete retained native state. Results are bounded to 32 KiB; large lists provide a file for the selected view.",
    promptSnippet: "Track multi-step work in a branch-aware task plan",
    promptGuidelines: ["Use todo for immediate executable steps, not an append-only task log. Revise, reorder, or remove obsolete tasks when direction changes. Do not create todos for trivial one-step requests.", "Mark a todo done only after implementation and relevant verification are complete. Done tasks leave the default current view but remain available with list view=all. Use clear_done/remove only when the current task set should change."],
    parameters: TodoParams, executionMode: "sequential",
    async execute(_id, input, signal, _update, ctx) {
      const operation = await execute(input, ctx, signal);
      return todoResult(input, operation, operation.owner, signal, options.outputRoot);
    },
    ...todoPresentation,
  });
  pi.registerCommand("todo-import", {
    description: "Import the selected legacy Todo branch, one bounded source or replay page per invocation",
    handler: async (_args, ctx) => {
      requireContext(ctx);
      try {
        const result = await store.importStep();
        ctx.ui.notify(result.complete ? "Todo owned state is ready" : `Todo import pending: ${result.phase}, ${result.scannedEntries ?? 0} source entries. Run /todo-import again`, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Todo import failed; source state is unchanged", "error"); }
      ui.changed();
    },
  });
}
