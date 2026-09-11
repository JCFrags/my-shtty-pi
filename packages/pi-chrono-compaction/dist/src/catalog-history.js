const fail = (code) => { throw Object.assign(new Error(code), { code }); };
/** Resolve one ID through the existing indexed catalog, then authorize it against
 * the current branch before reading bytes. A sibling pin never grants access. */
export async function resolveCatalogHistory(scope, entryId, execute) {
    const base = { v: 1, catalogDirectory: scope.catalogDirectory, sessionKey: scope.sessionKey };
    const pinned = await execute({ ...base, op: "pin", generation: scope.view.generation, branchKey: scope.view.branchKey, leaf: { shardKey: scope.shardKey, eventId: entryId } });
    const view = pinned.view;
    if (!view || !Number.isSafeInteger(view.eventCut) || view.eventCut < 1 || view.eventCut > scope.view.eventCut)
        fail("catalog-history-scope-mismatch");
    const page = await execute({ ...base, op: "page", view: scope.view, after: view.eventCut - 1, limit: 1 });
    const event = page.events?.[0];
    if (!event || event.seq !== view.eventCut || event.shardKey !== scope.shardKey)
        return fail("catalog-history-scope-mismatch");
    return event;
}
/** Raw recovery is byte-paged, never a whole-record JSON parse. Base64 preserves
 * exact bytes even when a page cuts a UTF-8 character or a JSON escape. */
export async function readCatalogHistoryPage(scope, event, execute, offset = event.rawStart, maxBytes = 8192) {
    if (!Number.isSafeInteger(offset) || offset < event.rawStart || offset > event.endByte || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32768)
        fail("catalog-history-range-invalid");
    const length = Math.min(maxBytes, event.endByte - offset);
    const raw = await execute({ v: 1, op: "raw", catalogDirectory: scope.catalogDirectory, sessionKey: scope.sessionKey, view: scope.view, eventSeq: event.seq, offset, length });
    if (raw.encoding !== "base64" || raw.offset !== offset || raw.length !== length || typeof raw.data !== "string" || Buffer.from(raw.data, "base64").length !== length)
        fail("catalog-history-response-invalid");
    return { eventSeq: event.seq, metadata: event.metadata, offset, length, encoding: "base64", data: raw.data, complete: offset + length === event.endByte, ...(offset + length < event.endByte ? { nextByte: offset + length } : {}) };
}
//# sourceMappingURL=catalog-history.js.map