import { cloneTaskState, emptyTaskState, type TaskState } from "@grounded/pi-core/tasks";
import { StateToolError } from "@grounded/pi-core/state";
import { restoreStateCheckpoint, STATE_CHECKPOINT_ENTRY } from "@grounded/pi-core/state-transfer";
import { readAncestryPage, type ImportReceiptInput, type ObjectRef, type OwnedObjectStore, type SessionEntryView, type StateAnchorHost } from "@context-kit/state-store";
import { createHash } from "node:crypto";
import { validateTodoState } from "./operations.ts";

export function isLegacyTodoEntry(entry: SessionEntryView): boolean {
  if (entry.type === "custom" && entry.customType === STATE_CHECKPOINT_ENTRY) {
    const data = entry.data as { provider?: string } | undefined;
    return !data?.provider || data.provider === "todo";
  }
  if (entry.type === "custom" && entry.customType === "grounded-tasks-state") return true;
  const message = entry.message as { role?: string; toolName?: string; details?: { state?: unknown; protocol?: string } } | undefined;
  if (message?.details?.protocol === "context-kit-todo-result/v1") return false;
  return entry.type === "message" && message?.role === "toolResult" && message.toolName === "todo" && message.details?.state !== undefined;
}
export interface TodoLegacyState { state: TaskState; providerEntries: number; checkpointOnly: boolean }
export function restoreLegacyTodo(entries: readonly SessionEntryView[], previous?: TodoLegacyState): TodoLegacyState {
  let state = previous?.state ?? emptyTaskState();
  let providerEntries = previous?.providerEntries ?? 0;
  let seenState = providerEntries > 0, checkpointOnly = previous?.checkpointOnly ?? true;
  for (const entry of entries) {
    const checkpoint = restoreStateCheckpoint(entry, "todo", validateTodoState);
    if (checkpoint) {
      if (seenState) throw new StateToolError("STATE_CORRUPT", "Todo checkpoint follows existing state");
      state = checkpoint; seenState = true; providerEntries++; continue;
    }
    if (!isLegacyTodoEntry(entry)) continue;
    const message = entry.message as { details?: { state?: TaskState } } | undefined;
    const candidate = entry.type === "custom" ? entry.data as TaskState : message?.details?.state;
    if (candidate !== undefined) {
      validateTodoState(candidate);
      state = cloneTaskState(candidate); seenState = true; providerEntries++; checkpointOnly = false;
    }
  }
  validateTodoState(state);
  return { state, providerEntries, checkpointOnly: seenState && checkpointOnly };
}

export const TODO_IMPORT_LIMITS = Object.freeze({ pageEntries: 128, pageBytes: 8 * 1024 * 1024 });
interface SourcePage { version: 1; page: Awaited<ReturnType<typeof readAncestryPage>>; newer: ObjectRef | null }
export interface TodoImportCursor {
  version: 1; provider: "todo"; source: { sessionId: string; leafId: string | null }; sourceFile: string | null;
  phase: "collect" | "replay" | "commit";
  nextEntryId: string | null; nextPage: ObjectRef | null; sourcePages: ObjectRef | null;
  scannedEntries: number; sourceDigest: string; native: TodoLegacyState;
}
/** One explicit import invocation collects or replays one bounded immutable page. */
export async function advanceTodoImport(host: StateAnchorHost, objects: OwnedObjectStore, current?: TodoImportCursor, signal?: AbortSignal): Promise<TodoImportCursor> {
  const source = { sessionId: host.sessionManager.getSessionId(), leafId: host.sessionManager.getLeafId() };
  const sourceFile = host.sessionManager.getSessionFile() ?? null;
  const cursor: TodoImportCursor = current ? structuredClone(current) : { version: 1, provider: "todo", source, sourceFile,
    phase: "collect", nextEntryId: source.leafId, nextPage: null, sourcePages: null,
    scannedEntries: 0, sourceDigest: createHash("sha256").update("normalized-native-entry-pages/v1").digest("hex"),
    native: { state: emptyTaskState(), providerEntries: 0, checkpointOnly: true },
  };
  const recheck = () => {
    if (cursor.version !== 1 || cursor.provider !== "todo" || cursor.source.sessionId !== host.sessionManager.getSessionId()
      || cursor.source.leafId !== host.sessionManager.getLeafId() || cursor.sourceFile !== (host.sessionManager.getSessionFile() ?? null)) {
      throw new StateToolError("STATE_CONFLICT", "Todo import source changed");
    }
    if (signal?.aborted) throw new StateToolError("STATE_CANCELLED", "The import was cancelled");
  };
  recheck();
  if (cursor.phase === "collect") {
    const page = await readAncestryPage(host.sessionManager, { fromEntryId: cursor.nextEntryId,
      maxEntries: TODO_IMPORT_LIMITS.pageEntries, maxBytes: TODO_IMPORT_LIMITS.pageBytes, signal });
    recheck();
    const reference = await objects.publish<SourcePage>({ version: 1, page, newer: cursor.nextPage }, { maxBytes: TODO_IMPORT_LIMITS.pageBytes + 64 * 1024, signal });
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
      const page = await objects.read<SourcePage>(cursor.nextPage, { maxBytes: TODO_IMPORT_LIMITS.pageBytes + 64 * 1024, signal });
      if (page.version !== 1 || page.page.scope.sessionId !== cursor.source.sessionId || page.page.scope.leafId !== cursor.source.leafId) throw new StateToolError("STATE_CORRUPT", "Invalid import source page");
      cursor.native = restoreLegacyTodo(page.page.entries.slice().reverse(), cursor.native);
      cursor.nextPage = page.newer;
      if (!cursor.nextPage) cursor.phase = "commit";
    }
  } else if (cursor.phase !== "commit") throw new StateToolError("STATE_CORRUPT", "Invalid import phase");
  validateTodoState(cursor.native.state);
  recheck();
  return cursor;
}
export async function todoImportReceipt(cursor: TodoImportCursor, objects: OwnedObjectStore, signal?: AbortSignal): Promise<ImportReceiptInput> {
  if (cursor.phase !== "commit") throw new StateToolError("STATE_CONFLICT", "The import is not complete");
  const evidence = await objects.publish({ version: 1, provider: "todo", source: cursor.source, sourceFile: cursor.sourceFile,
    digestKind: "normalized-native-entry-pages/v1", pageOrder: "oldest-page-first; entries-newest-first", pages: cursor.sourcePages,
  }, { maxBytes: 64 * 1024, signal });
  return { importer: "context-kit-todo/1", source: cursor.source, coverage: { scannedEntries: cursor.scannedEntries,
    providerEntries: cursor.native.providerEntries, complete: true, sourceDigest: cursor.sourceDigest }, evidence };
}
