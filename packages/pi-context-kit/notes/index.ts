import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerContextProvider, sameScope, type ProviderPage } from "@context-kit/protocol";
import { registerStateTransferProvider, StateTransferError } from "@context-kit/protocol/transfer";
import { projectNotesPage } from "@grounded/pi-core/context-adapters";
import { boundedStateOutput, cancelled, STATE_RESULT_PROTOCOL, StateToolError, type StateToolDetails } from "@grounded/pi-core/state";
import { NotesParams, NOTES_DESCRIPTION, NOTES_GUIDELINES, NOTES_PROMPT_SNIPPET, renderNoteRead, renderNotesResult, type Note } from "./operations.ts";
import { NotesStore } from "./store.ts";

export { NotesParams, NOTES_DESCRIPTION, NOTES_GUIDELINES, NOTES_PROMPT_SNIPPET };
export { NotesStore } from "./store.ts";
export interface NotesOptions { storeRoot?: string; outputRoot?: string }
const refusal = (readiness: ProviderPage["readiness"]): ProviderPage => ({ readiness, cards: [], coverage: { scanned: 0, matched: 0, excluded: 0, scanComplete: false } });

export default function contextNotes(pi: ExtensionAPI, options: NotesOptions = {}) {
  const store = new NotesStore({ ...(options.storeRoot ? { storeRoot: options.storeRoot } : {}) });
  let context: ExtensionContext | undefined;
  let lifecycleEpoch = 0;
  const removers: Array<() => void> = [];
  const scope = () => context ? { sessionId: context.sessionManager.getSessionId(), leafId: context.sessionManager.getLeafId() } : undefined;
  try {
    removers.push(registerContextProvider(pi.events, "notes", (request) => {
      const current = scope();
      if (!current || !pi.getActiveTools().includes("notes")) return refusal("unavailable");
      if (!sameScope(current, request.scope)) return refusal("scope_changed");
      const state = store.stateView();
      if (!state) return refusal(store.readiness());
      const page = projectNotesPage(request, state);
      const after = scope();
      if (!after || !sameScope(after, request.scope)) return refusal("scope_changed");
      if (store.readiness() !== "ready") return refusal(store.readiness());
      return pi.getActiveTools().includes("notes") ? page : refusal("unavailable");
    }));
  } catch { /* Optional Context transport cannot prevent native notes use. */ }
  try { removers.push(registerStateTransferProvider(pi.events, "notes", async (_request, signal) => {
    if (store.readiness() !== "ready") throw new StateTransferError(store.readiness() === "corrupt" ? "state-checkpoint-corrupt" : "state-checkpoint-pending");
    try {
      const captured = await store.checkpoint(signal);
      const source = scope();
      if (!source) throw new StateTransferError("state-checkpoint-scope");
      return [
        { customType: "grounded-state-checkpoint-v1", data: { version: 1, provider: "notes", sourceSessionId: source.sessionId, sourceLeafId: source.leafId, state: captured.state } },
        { customType: "context-kit:owner-binding:v1", data: { version: 1, provider: "notes", sourceSessionId: source.sessionId, sourceLeafId: source.leafId, binding: captured.owner } },
      ];
    } catch (error) {
      if (error instanceof StateTransferError) throw error;
      throw new StateTransferError(error instanceof StateToolError && error.code === "STATE_LIMIT_EXCEEDED" ? "state-checkpoint-budget" : store.readiness() === "corrupt" ? "state-checkpoint-corrupt" : "state-checkpoint-pending");
    }
  }, scope)); } catch { /* A missing transfer response makes rollover refuse, not native writes. */ }
  const bind = async (ctx: ExtensionContext) => {
    context = ctx; lifecycleEpoch++;
    try { await store.open({ sessionManager: ctx.sessionManager, appendEntry: (type, data) => pi.appendEntry(type, data) }); }
    catch (error) { if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : "Notes restore failed", "error"); }
  };
  pi.on("session_start", async (_event, ctx) => bind(ctx));
  pi.on("session_tree", async (_event, ctx) => bind(ctx));
  pi.on("agent_settled", async () => { try { await store.refresh(); } catch { /* Native reads expose pending/corrupt recovery. */ } });
  pi.on("session_shutdown", () => {
    lifecycleEpoch++; store.close(); context = undefined;
    for (const remove of removers) { try { remove(); } catch { /* Cleanup cannot fail session shutdown. */ } }
  });
  pi.on("context", (event) => {
    const state = store.stateView();
    const readiness = store.readiness();
    const text = readiness !== "ready" ? `[notes state] ${readiness}${store.isLegacy() ? "; explicit /notes-import required" : ""}`
      : state?.notes.length ? `[notes state] active=${state.notes.filter((note) => note.status === "active").length} archived=${state.notes.filter((note) => note.status === "archived").length}` : undefined;
    if (text) return { messages: [...event.messages, { role: "custom" as const, customType: "grounded-notes-context", content: text, display: false, timestamp: 0 }] };
  });
  pi.registerTool({
    name: "notes", label: "Notes", description: NOTES_DESCRIPTION, promptSnippet: NOTES_PROMPT_SNIPPET, promptGuidelines: NOTES_GUIDELINES,
    parameters: NotesParams, executionMode: "sequential",
    async execute(_id, input, signal, _update, ctx) {
      if (!context || ctx.sessionManager !== context.sessionManager) throw new StateToolError("STATE_CONFLICT", "Notes session changed");
      const epoch = lifecycleEpoch;
      const operation = await store.execute(input, signal);
      let text = input.action === "read" ? renderNoteRead(operation.result as Note) : renderNotesResult(input.action, operation.result);
      let fullOutputPath: string | undefined;
      if (input.action === "read" || input.action === "search") {
        const output = await boundedStateOutput(text, "grounded-notes", signal, options.outputRoot ? { temporaryRoot: options.outputRoot } : {});
        text = output.text; fullOutputPath = output.fullOutputPath;
      }
      cancelled(signal);
      if (epoch !== lifecycleEpoch) throw new StateToolError("STATE_CONFLICT", "Notes branch changed during the operation");
      const details: StateToolDetails & { ownership: "context-kit-notes/v1"; owner: { commitId: string | null; revision: number } } = {
        protocol: STATE_RESULT_PROTOCOL, action: input.action,
        ...(operation.event ? { event: operation.event } : {}), result: operation.result,
        ...(operation.page ? { page: { cursor: operation.page.cursor, limit: operation.page.limit,
          ...(operation.page.nextCursor !== undefined ? { nextCursor: operation.page.nextCursor } : {}), total: operation.page.total } } : {}),
        ...(fullOutputPath ? { fullOutputPath } : {}),
        ownership: "context-kit-notes/v1", owner: { commitId: operation.owner.commitId, revision: operation.owner.recordRevision },
      };
      return { content: [{ type: "text" as const, text }], details };
    },
  });
  pi.registerCommand("notes-import", {
    description: "Import the selected legacy Notes branch, one bounded source or replay page per invocation",
    handler: async (_args, ctx) => {
      if (!context || ctx.sessionManager !== context.sessionManager) throw new StateToolError("STATE_CONFLICT", "Notes session changed");
      try {
        const result = await store.importStep();
        ctx.ui.notify(result.complete ? "Notes owned state is ready" : `Notes import pending: ${result.phase}, ${result.scannedEntries ?? 0} source entries. Run /notes-import again`, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Notes import failed; source state is unchanged", "error"); }
    },
  });
}
