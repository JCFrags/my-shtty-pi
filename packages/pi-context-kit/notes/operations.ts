import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
export {
  applyNoteEvent, cloneNotesState, emptyNotesState, performNotesAction, renderNoteRead, validateNotesState,
  type Note, type NotesInput, type NotesOperation, type NotesState,
} from "@grounded/pi-core/notes";

export const NotesParams = Type.Object({
  action: StringEnum(["add", "list", "read", "append", "update", "search", "archive", "remove", "clear_archived"] as const),
  id: Type.Optional(Type.String()), title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String({ description: "Required for add/append. update replaces the body. append adds body literally with no separator. Include \\n for a new line." })),
  tags: Type.Optional(Type.Array(Type.String(), { maxItems: 16 })), query: Type.Optional(Type.String()),
  cursor: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 1, description: "Required for append/update/archive/remove. Use the latest revision from read/list/search. Not accepted by other actions." })),
}, { additionalProperties: false });
export const NOTES_DESCRIPTION = "Manage explicit branch-aware scratchpad notes, not memory. add creates a note. list/search return metadata. read returns exact text. append/update/archive/remove require id and expectedRevision. Other actions reject expectedRevision. append adds body literally with no separator, for example {action:\"append\",id:\"N1\",expectedRevision:1,body:\"\\nNext line\"}. archive retains readable notes. remove/clear_archived delete from the retained set, not an undo system.";
export const NOTES_PROMPT_SNIPPET = "Keep explicit scratchpad notes that follow the active session branch";
export const NOTES_GUIDELINES = [
  "Use notes only for explicit session scratchpad state. Notes is not memory or trusted instruction storage. Do not store secrets in notes.",
  "When goals change, update the current scratchpad and archive inactive notes to preserve their IDs and read recovery. list/search include archived metadata. clear_archived and remove delete retained notes. They do not undo writes.",
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
