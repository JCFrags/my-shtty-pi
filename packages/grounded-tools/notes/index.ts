import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  cloneNotesState,
  emptyNotesState,
  performNotesAction,
  renderNoteRead,
  type Note,
  type NotesState,
  applyNoteEvent,
  validateNotesState,
} from "@grounded/pi-core/notes";
import { registerStateCheckpointProvider, restoreStateCheckpoint } from "@grounded/pi-core/state-transfer";
import {
  boundedStateOutput,
  cancelled,
  STATE_EVENT_PROTOCOL,
  STATE_RESULT_PROTOCOL,
  StateToolError,
  type StateToolDetails,
} from "@grounded/pi-core/state";

export const NotesParams = Type.Object({
  action: StringEnum(["add", "list", "read", "append", "update", "search", "archive", "remove", "clear_archived"] as const),
  id: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String(), { maxItems: 16 })),
  query: Type.Optional(Type.String()),
  cursor: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

export const NOTES_DESCRIPTION = "Manage explicit branch-aware scratchpad notes. Notes are session-tree state, not memory. Actions add, list metadata, read exact text, append, update, search, archive, remove, and clear archived notes.";
export const NOTES_PROMPT_SNIPPET = "Keep explicit scratchpad notes that follow the active session branch";
export const NOTES_GUIDELINES = [
  "Use notes only for explicit session scratchpad state. Notes is not memory or trusted instruction storage. Do not store secrets in notes.",
];

interface EntryLike {
  id?: string;
  type?: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string; toolName?: string; details?: unknown };
}

function contextMessage(text: string) {
  return { role: "custom" as const, customType: "grounded-notes-context", content: text, display: false, timestamp: 0 };
}

function renderResult(action: string, result: unknown): string {
  if (action === "add") return `Added ${(result as { id: string }).id} at revision 1`;
  if (action === "append" || action === "update" || action === "archive") {
    const value = result as { id: string; revision: number };
    return `${action} ${value.id} at revision ${value.revision}`;
  }
  if (action === "remove") return `Removed ${(result as { id: string }).id}`;
  if (action === "clear_archived") {
    const ids = (result as { removedIds: string[] }).removedIds;
    return `Removed ${ids.length} archived note(s)${ids.length ? `: ${ids.join(", ")}` : ""}`;
  }
  return JSON.stringify(result, null, 2);
}

export default function groundedNotes(pi: ExtensionAPI) {
  let state = emptyNotesState();
  let corruptEntryId: string | undefined;
  let currentContext: ExtensionContext | undefined;
  let lifecycleEpoch = 0;
  let executing = 0;
  const pendingEvents = new Map<number, string>();
  const removeCheckpointProvider = registerStateCheckpointProvider(pi.events, "notes", () => ({
    state, sessionId: currentContext?.sessionManager.getSessionId(), leafId: currentContext?.sessionManager.getLeafId(),
    corrupt: corruptEntryId !== undefined, pending: executing > 0 || pendingEvents.size > 0,
  }), validateNotesState);

  const restore = (ctx: ExtensionContext) => {
    currentContext = ctx;
    lifecycleEpoch += 1;
    pendingEvents.clear();
    state = emptyNotesState();
    corruptEntryId = undefined;
    let seenState = false;
    for (const raw of ctx.sessionManager.getBranch() as EntryLike[]) {
      try {
        const checkpoint = restoreStateCheckpoint(raw, "notes", validateNotesState);
        if (checkpoint) {
          if (seenState) throw new StateToolError("STATE_CORRUPT", "Notes checkpoint follows existing state");
          state = checkpoint;
          seenState = true;
          continue;
        }
      } catch {
        corruptEntryId = raw.id ?? "unknown";
        break;
      }
      if (raw.type !== "message" || raw.message?.role !== "toolResult" || raw.message.toolName !== "notes") continue;
      const details = raw.message.details;
      if (!details || typeof details !== "object" || Array.isArray(details)) continue;
      const candidate = details as Record<string, unknown>;
      if (candidate.protocol !== STATE_RESULT_PROTOCOL) continue;
      if (!Object.hasOwn(candidate, "event")) continue;
      const event = candidate.event;
      if (!event || typeof event !== "object" || Array.isArray(event)) continue;
      const envelope = event as Record<string, unknown>;
      if (envelope.protocol !== STATE_EVENT_PROTOCOL || envelope.tool !== "notes") continue;
      try {
        state = applyNoteEvent(state, event);
        seenState = true;
      } catch {
        corruptEntryId = raw.id ?? "unknown";
        break;
      }
    }
  };

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", () => {
    lifecycleEpoch += 1;
    pendingEvents.clear();
    currentContext = undefined;
    removeCheckpointProvider();
  });
  pi.on("message_end", (event) => {
    const message = event.message as { role?: string; toolName?: string; details?: StateToolDetails };
    if (message.role !== "toolResult" || message.toolName !== "notes" || message.details?.protocol !== STATE_RESULT_PROTOCOL) return;
    const persisted = message.details.event;
    if (persisted && pendingEvents.get(persisted.stateRevision) === JSON.stringify(persisted)) pendingEvents.delete(persisted.stateRevision);
  });
  pi.on("context", (event) => {
    const text = corruptEntryId
      ? `[notes state] corrupt entry=${corruptEntryId}`
      : state.notes.length
        ? `[notes state] active=${state.notes.filter((note) => note.status === "active").length} archived=${state.notes.filter((note) => note.status === "archived").length}`
        : undefined;
    if (!text) return;
    return { messages: [...event.messages, contextMessage(text)] };
  });

  pi.registerTool({
    name: "notes",
    label: "Notes",
    description: NOTES_DESCRIPTION,
    promptSnippet: NOTES_PROMPT_SNIPPET,
    promptGuidelines: NOTES_GUIDELINES,
    parameters: NotesParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      if (corruptEntryId) throw new StateToolError("STATE_CORRUPT", `Notes state is corrupt at entry ${corruptEntryId}`);
      cancelled(signal);
      const epoch = lifecycleEpoch;
      const operation = performNotesAction(state, params);
      cancelled(signal);
      let text: string;
      if (params.action === "read") text = renderNoteRead(operation.result as Note);
      else text = renderResult(params.action, operation.result);
      let fullOutputPath: string | undefined;
      if (params.action === "read" || params.action === "search") {
        executing += 1;
        try {
          const bounded = await boundedStateOutput(text, "grounded-notes", signal);
          text = bounded.text;
          fullOutputPath = bounded.fullOutputPath;
        } finally {
          executing -= 1;
        }
      }
      cancelled(signal);
      if (epoch !== lifecycleEpoch) throw new StateToolError("STATE_CONFLICT", "Notes branch changed during the operation");
      if (operation.event) {
        state = cloneNotesState(operation.state);
        pendingEvents.set(operation.event.stateRevision, JSON.stringify(operation.event));
      }
      const details: StateToolDetails = {
        protocol: STATE_RESULT_PROTOCOL,
        action: params.action,
        ...(operation.event ? { event: operation.event } : {}),
        result: operation.result,
        ...(operation.page ? { page: {
          cursor: operation.page.cursor,
          limit: operation.page.limit,
          ...(operation.page.nextCursor !== undefined ? { nextCursor: operation.page.nextCursor } : {}),
          total: operation.page.total,
        } } : {}),
        ...(fullOutputPath ? { fullOutputPath } : {}),
      };
      return { content: [{ type: "text" as const, text }], details };
    },
  });
}
