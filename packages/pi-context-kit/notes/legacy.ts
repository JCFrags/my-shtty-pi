import { createHash } from "node:crypto";
import { applyNoteEvent, emptyNotesState, validateNotesState, type NotesState } from "@grounded/pi-core/notes";
import { STATE_EVENT_PROTOCOL, STATE_RESULT_PROTOCOL, StateToolError } from "@grounded/pi-core/state";
import { restoreStateCheckpoint, STATE_CHECKPOINT_ENTRY } from "@grounded/pi-core/state-transfer";
import { readAncestryPage, type ImportReceiptInput, type ObjectRef, type OwnedObjectStore, type SessionEntryView, type StateAnchorHost } from "@context-kit/state-store";

function nativeEvent(entry: SessionEntryView): unknown {
  if (entry.type !== "message") return undefined;
  const message = entry.message as { role?: string; toolName?: string; details?: unknown } | undefined;
  if (message?.role !== "toolResult" || message.toolName !== "notes") return undefined;
  const details = message.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const result = details as { protocol?: string; event?: unknown; ownership?: string };
  if (result.ownership === "context-kit-notes/v1") return undefined;
  if (result.protocol !== STATE_RESULT_PROTOCOL || !Object.hasOwn(result, "event")) return undefined;
  const event = result.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
  const envelope = event as { protocol?: string; tool?: string };
  return envelope.protocol === STATE_EVENT_PROTOCOL && envelope.tool === "notes" ? event : undefined;
}
export function isLegacyNotesEntry(entry: SessionEntryView): boolean {
  if (entry.type === "custom" && entry.customType === STATE_CHECKPOINT_ENTRY) {
    const data = entry.data as { provider?: string } | undefined;
    return !data?.provider || data.provider === "notes";
  }
  return nativeEvent(entry) !== undefined;
}
export interface NotesLegacyState { state: NotesState; providerEntries: number; checkpointOnly: boolean }
export function restoreLegacyNotes(entries: readonly SessionEntryView[], previous?: NotesLegacyState): NotesLegacyState {
  let state = previous?.state ?? emptyNotesState();
  let providerEntries = previous?.providerEntries ?? 0;
  let seenState = providerEntries > 0, checkpointOnly = previous?.checkpointOnly ?? true;
  for (const entry of entries) {
    const checkpoint = restoreStateCheckpoint(entry, "notes", validateNotesState);
    if (checkpoint) {
      if (seenState) throw new StateToolError("STATE_CORRUPT", "Notes checkpoint follows existing state");
      state = checkpoint; seenState = true; providerEntries++; continue;
    }
    const event = nativeEvent(entry);
    if (event !== undefined) { state = applyNoteEvent(state, event); seenState = true; providerEntries++; checkpointOnly = false; }
  }
  validateNotesState(state);
  return { state, providerEntries, checkpointOnly: seenState && checkpointOnly };
}
export const NOTES_IMPORT_LIMITS = Object.freeze({ pageEntries: 128, pageBytes: 8 * 1024 * 1024 });
interface SourcePage { version: 1; page: Awaited<ReturnType<typeof readAncestryPage>>; newer: ObjectRef | null }
export interface NotesImportCursor {
  version: 1; provider: "notes"; source: { sessionId: string; leafId: string | null }; sourceFile: string | null;
  phase: "collect" | "replay" | "commit";
  nextEntryId: string | null; nextPage: ObjectRef | null; sourcePages: ObjectRef | null;
  scannedEntries: number; sourceDigest: string; native: NotesLegacyState;
}
/** One explicit import invocation collects or replays one bounded immutable page. */
export async function advanceNotesImport(host: StateAnchorHost, objects: OwnedObjectStore, current?: NotesImportCursor, signal?: AbortSignal): Promise<NotesImportCursor> {
  const source = { sessionId: host.sessionManager.getSessionId(), leafId: host.sessionManager.getLeafId() };
  const sourceFile = host.sessionManager.getSessionFile() ?? null;
  const cursor: NotesImportCursor = current ? structuredClone(current) : { version: 1, provider: "notes", source, sourceFile,
    phase: "collect", nextEntryId: source.leafId, nextPage: null, sourcePages: null,
    scannedEntries: 0, sourceDigest: createHash("sha256").update("normalized-native-entry-pages/v1").digest("hex"),
    native: { state: emptyNotesState(), providerEntries: 0, checkpointOnly: true },
  };
  const recheck = () => {
    if (cursor.version !== 1 || cursor.provider !== "notes" || cursor.source.sessionId !== host.sessionManager.getSessionId()
      || cursor.source.leafId !== host.sessionManager.getLeafId() || cursor.sourceFile !== (host.sessionManager.getSessionFile() ?? null)) {
      throw new StateToolError("STATE_CONFLICT", "Notes import source changed");
    }
    if (signal?.aborted) throw new StateToolError("STATE_CANCELLED", "The import was cancelled");
  };
  recheck();
  if (cursor.phase === "collect") {
    const page = await readAncestryPage(host.sessionManager, { fromEntryId: cursor.nextEntryId,
      maxEntries: NOTES_IMPORT_LIMITS.pageEntries, maxBytes: NOTES_IMPORT_LIMITS.pageBytes, signal });
    recheck();
    const reference = await objects.publish<SourcePage>({ version: 1, page, newer: cursor.nextPage }, { maxBytes: NOTES_IMPORT_LIMITS.pageBytes + 64 * 1024, signal });
    cursor.nextPage = reference;
    cursor.sourcePages = reference;
    cursor.nextEntryId = page.nextEntryId;
    cursor.scannedEntries += page.scanned;
    if (!Number.isSafeInteger(cursor.scannedEntries)) throw new StateToolError("STATE_LIMIT_EXCEEDED", "The import count cannot increase safely");
    cursor.sourceDigest = createHash("sha256").update(cursor.sourceDigest).update(page.digest).digest("hex");
    if (page.complete) cursor.phase = "replay";
  } else if (cursor.phase === "replay") {
    if (!cursor.nextPage) cursor.phase = "commit";
    else {
      const page = await objects.read<SourcePage>(cursor.nextPage, { maxBytes: NOTES_IMPORT_LIMITS.pageBytes + 64 * 1024, signal });
      if (page.version !== 1 || page.page.scope.sessionId !== cursor.source.sessionId || page.page.scope.leafId !== cursor.source.leafId) throw new StateToolError("STATE_CORRUPT", "Invalid import source page");
      cursor.native = restoreLegacyNotes(page.page.entries.slice().reverse(), cursor.native);
      cursor.nextPage = page.newer;
      if (!cursor.nextPage) cursor.phase = "commit";
    }
  } else if (cursor.phase !== "commit") throw new StateToolError("STATE_CORRUPT", "Invalid import phase");
  validateNotesState(cursor.native.state);
  recheck();
  return cursor;
}
export async function notesImportReceipt(cursor: NotesImportCursor, objects: OwnedObjectStore, signal?: AbortSignal): Promise<ImportReceiptInput> {
  if (cursor.phase !== "commit") throw new StateToolError("STATE_CONFLICT", "The import is not complete");
  const evidence = await objects.publish({ version: 1, provider: "notes", source: cursor.source, sourceFile: cursor.sourceFile,
    digestKind: "normalized-native-entry-pages/v1", pageOrder: "oldest-page-first; entries-newest-first", pages: cursor.sourcePages,
  }, { maxBytes: 64 * 1024, signal });
  return { importer: "context-kit-notes/1", source: cursor.source, coverage: { scannedEntries: cursor.scannedEntries,
    providerEntries: cursor.native.providerEntries, complete: true, sourceDigest: cursor.sourceDigest }, evidence };
}
