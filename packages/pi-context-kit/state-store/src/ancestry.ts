import type { AncestryPage, AncestryPageOptions, SessionEntryView, StateScope, StateSessionManager } from "./types.ts";
import { canonicalJson, checkSignal, fail, hashText, identifier, integer, sameScope, scope, STATE_STORE_LIMITS, StateStoreError } from "./validation.ts";

export function currentScope(manager: StateSessionManager): StateScope {
  const value = { sessionId: manager.getSessionId(), leafId: manager.getLeafId() };
  scope(value);
  return value;
}
export function checkedEntry(manager: StateSessionManager, id: string): SessionEntryView {
  identifier(id);
  const entry = manager.getEntry(id);
  if (!entry || entry.id !== id || typeof entry.type !== "string" || !entry.type || entry.type.length > 128) fail("state-store-corrupt");
  if (entry.parentId !== null) identifier(entry.parentId);
  if (entry.parentId === id) fail("state-store-corrupt");
  return entry;
}
/** Providers own forward replay and checkpoint validation. This function returns whole source entries only. */
export function readAncestryPage(manager: StateSessionManager, options: AncestryPageOptions): AncestryPage {
  checkSignal(options.signal);
  const view = currentScope(manager);
  const maximumEntries = options.maxEntries ?? STATE_STORE_LIMITS.ancestryEntries;
  const maximumBytes = options.maxBytes ?? STATE_STORE_LIMITS.ancestryBytes;
  integer(maximumEntries, 1, STATE_STORE_LIMITS.maxAncestryEntries);
  integer(maximumBytes, 1, STATE_STORE_LIMITS.objectBytes);
  let next = options.fromEntryId;
  if (next !== null) identifier(next);
  const entries: SessionEntryView[] = [], visited = new Set<string>();
  const digests: string[] = [];
  let bytes = 0;
  while (next !== null && entries.length < maximumEntries) {
    checkSignal(options.signal);
    if (visited.has(next)) fail("state-store-corrupt");
    visited.add(next);
    const entry = checkedEntry(manager, next);
    if (bytes === maximumBytes) break;
    let encoded: string;
    // Pi keeps absent optional fields as undefined in memory and omits them in JSONL.
    try { encoded = canonicalJson(entry, maximumBytes - bytes, true); }
    catch (error) {
      if (entries.length && error instanceof StateStoreError && error.code === "state-store-budget") break;
      throw error;
    }
    const length = Buffer.byteLength(encoded);
    entries.push(JSON.parse(encoded) as SessionEntryView);
    digests.push(hashText(encoded));
    bytes += length;
    next = entry.parentId;
  }
  if (!sameScope(view, currentScope(manager))) fail("state-store-scope-changed");
  return { scope: view, entries, nextEntryId: next, complete: next === null,
    scanned: entries.length, bytes, digest: hashText(canonicalJson(digests, STATE_STORE_LIMITS.recordBytes)) };
}
