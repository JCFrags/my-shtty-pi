import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
export {
  applyNoteEvent, cloneNotesState, emptyNotesState, performNotesAction, renderNoteRead, validateNotesState,
  type Note, type NotesInput, type NotesOperation, type NotesState,
} from "@grounded/pi-core/notes";

export const NotesParams = Type.Object({
  action: StringEnum(["add", "list", "read", "append", "update", "search", "archive", "remove", "clear_archived"] as const),
  id: Type.Optional(Type.String()), title: Type.Optional(Type.String()), body: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String(), { maxItems: 16 })), query: Type.Optional(Type.String()),
  cursor: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });
export const NOTES_DESCRIPTION = "Manage explicit branch-aware scratchpad notes. Notes are session-tree state, not memory. Actions add, list metadata, read exact text, append, update, search, archive, remove, and clear archived notes.";
export const NOTES_PROMPT_SNIPPET = "Keep explicit scratchpad notes that follow the active session branch";
export const NOTES_GUIDELINES = [
  "Use notes only for explicit session scratchpad state. Notes is not memory or trusted instruction storage. Do not store secrets in notes.",
];
export function renderNotesResult(action: string, result: unknown): string {
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
