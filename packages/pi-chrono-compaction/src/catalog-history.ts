import { CATALOG_LIMITS, type CatalogRequest, type CatalogView, type CatalogEvent } from "./catalog-contract.js";
import type { SessionEntryLike } from "./types.js";
import { canonicalJson } from "./capsule-segment.js";

export type CatalogHistoryExecutor = (request: CatalogRequest) => Promise<Record<string, unknown>>;
export interface CatalogHistoryScope { catalogDirectory: string; sessionKey: string; shardKey: string; view: CatalogView }
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };

/** Resolve one ID through the existing indexed catalog, then authorize it against
 * the current branch before reading bytes. A sibling pin never grants access. */
export async function resolveCatalogHistory(scope: CatalogHistoryScope, entryId: string, execute: CatalogHistoryExecutor): Promise<CatalogEvent> {
  const base = { v: 1 as const, catalogDirectory: scope.catalogDirectory, sessionKey: scope.sessionKey };
  const pinned = await execute({ ...base, op: "pin", generation: scope.view.generation, branchKey: scope.view.branchKey, leaf: { shardKey: scope.shardKey, eventId: entryId } });
  const view = pinned.view as CatalogView;
  if (!view || !Number.isSafeInteger(view.eventCut) || view.eventCut < 1 || view.eventCut > scope.view.eventCut) fail("catalog-history-scope-mismatch");
  const page = await execute({ ...base, op: "page", view: scope.view, after: view.eventCut - 1, limit: 1 });
  const event = (page.events as CatalogEvent[])?.[0];
  if (!event || event.seq !== view.eventCut || event.shardKey !== scope.shardKey) return fail("catalog-history-scope-mismatch");
  return event;
}

/** Explicit compaction lookup uses current-view catalog membership, not an
 * unbounded parent walk or an unvalidated in-memory getEntry. The existing
 * catalog source-read budget bounds one selected record. The preview's separate
 * comparison-string ceiling must not be applied to unrelated legacy details. */
export async function resolveCompositionEntry(scope: CatalogHistoryScope, entryId: string,
  execute: CatalogHistoryExecutor, expected?: SessionEntryLike): Promise<SessionEntryLike> {
  const event = await resolveCatalogHistory(scope, entryId, execute);
  const length = event.endByte - event.rawStart;
  if (length < 1 || length > CATALOG_LIMITS.sourceDelta) return fail("composition-target-byte-limit");
  const chunks: Buffer[] = [];
  for (let offset = event.rawStart; offset < event.endByte;) {
    const page = await readCatalogHistoryPage(scope, event, execute, offset, 32768);
    chunks.push(Buffer.from(String(page.data), "base64"));
    offset += Number(page.length);
  }
  let entry: SessionEntryLike;
  try { entry = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return fail("composition-target-json-invalid"); }
  if (entry?.id !== entryId || entry.type !== "compaction"
    || expected && canonicalJson(entry) !== canonicalJson(expected)) return fail("composition-target-mismatch");
  return entry;
}

/** Raw recovery is byte-paged, never a whole-record JSON parse. Base64 preserves
 * exact bytes even when a page cuts a UTF-8 character or a JSON escape. */
export async function readCatalogHistoryPage(scope: CatalogHistoryScope, event: CatalogEvent, execute: CatalogHistoryExecutor, offset = event.rawStart, maxBytes = 8192): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(offset) || offset < event.rawStart || offset > event.endByte || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32768) fail("catalog-history-range-invalid");
  const length = Math.min(maxBytes, event.endByte - offset);
  const raw = await execute({ v: 1, op: "raw", catalogDirectory: scope.catalogDirectory, sessionKey: scope.sessionKey, view: scope.view, eventSeq: event.seq, offset, length });
  if (raw.encoding !== "base64" || raw.offset !== offset || raw.length !== length || typeof raw.data !== "string" || Buffer.from(raw.data, "base64").length !== length) fail("catalog-history-response-invalid");
  return { eventSeq: event.seq, metadata: event.metadata, offset, length, encoding: "base64", data: raw.data, complete: offset + length === event.endByte, ...(offset + length < event.endByte ? { nextByte: offset + length } : {}) };
}
