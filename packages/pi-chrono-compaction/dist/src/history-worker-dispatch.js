import { lstat } from "node:fs/promises";
import { MemoryAdmissionController } from "./memory-admission.js";
import { boundedHistoryValue, HISTORY_FEEDBACK_LIMIT, HISTORY_PARENT_RESERVATION_BYTES, HISTORY_WORKER_CAPS, HISTORY_WORKER_STAGES, LEGACY_HISTORY_MAX_BYTES, SEARCH_INDEX_SOURCE_MAX_BYTES, historyRefusal, historySourceAdmission, validHistoryPromotionEvent, } from "./history-worker-contract.js";
const admission = new MemoryAdmissionController(512 * 1024 * 1024);
let dispatched = 0;
export function historyWorkerAdmissionStatus() { return admission.status(); }
/** Compatibility diagnostic: Pi no longer retains any history index. */
export function historySearchIndexCacheStatus() {
    const status = admission.status();
    return { entries: 0, bytes: 0, byteLimit: 128 * 1024 * 1024, pendingEntries: status.components.pendingLoad / HISTORY_WORKER_CAPS.memoryBytes,
        pendingBytes: status.components.pendingLoad + status.components.queryResults, sourceMaximumBytes: SEARCH_INDEX_SOURCE_MAX_BYTES,
        sourceChargeMultiplier: 32, builds: dispatched, hits: 0, coalesced: 0, admission: status };
}
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function boundedStrings(value) {
    return Array.isArray(value) && value.length <= HISTORY_FEEDBACK_LIMIT && value.every((item) => typeof item === "string" && item.length <= 512);
}
function finite(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER; }
function parseResponse(wire) {
    if (typeof wire !== "string" || wire.length > HISTORY_WORKER_CAPS.responseBytes || Buffer.byteLength(wire) > HISTORY_WORKER_CAPS.responseBytes)
        return historyRefusal("history-output-limit");
    let value;
    try {
        value = JSON.parse(wire);
    }
    catch {
        return historyRefusal("history-response-invalid");
    }
    if (!plain(value))
        return historyRefusal("history-response-invalid");
    if (value.promotionEvents !== undefined && (!Array.isArray(value.promotionEvents) || value.promotionEvents.length > 3 || !value.promotionEvents.every(validHistoryPromotionEvent)))
        return historyRefusal("history-response-invalid");
    if (value.status === "refused" && Object.keys(value).every((key) => ["status", "code", "promotionEvents"].includes(key)) && typeof value.code === "string" && /^history-[a-z-]{1,64}$|^legacy-history-size-limit$/.test(value.code))
        return value;
    if (value.status !== "ok" || Object.keys(value).some((key) => !["status", "text", "details", "feedback", "promotionEvents"].includes(key)) || typeof value.text !== "string" || Buffer.byteLength(value.text) > 50 * 1024 || !plain(value.details))
        return historyRefusal("history-response-invalid");
    const allowedDetails = ["entryId", "blockIndex", "startEntryId", "endEntryId", "query", "mode", "generationHash", "hits", "tokenBudget", "returnedTokens", "level", "items", "renderedTokens", "promotedMemories"];
    if (Object.entries(value.details).some(([key, item]) => !allowedDetails.includes(key) || !(typeof item === "string" && item.length <= 4096 || finite(item) || typeof item === "boolean")))
        return historyRefusal("history-response-invalid");
    const f = value.feedback;
    if (f !== undefined && (!plain(f) || Object.keys(f).some((key) => !["generationHash", "query", "resultCount", "retrievedTokens", "expandedItems", "resourceKeys", "blockIds"].includes(key)) || typeof f.generationHash !== "string" || f.generationHash.length > 128 || typeof f.query !== "string" || f.query.length > 4096 || !finite(f.resultCount) || !finite(f.retrievedTokens) || f.expandedItems !== undefined && !finite(f.expandedItems) || !boundedStrings(f.resourceKeys) || !boundedStrings(f.blockIds)))
        return historyRefusal("history-response-invalid");
    return value;
}
/** Reserve the complete child ceiling plus bounded parent IPC/parse/result space
 * before stat, serialization, load, index, or dispatch. The multiplier is only an
 * early refusal policy; hard OS isolation contains unpredictable expansion. */
export async function dispatchHistoryWorker(path, operation, transport, signal) {
    if (!path)
        return historyRefusal("history-source-unpersisted");
    const reservation = admission.reserve({ pendingLoad: HISTORY_WORKER_CAPS.memoryBytes, queryResults: HISTORY_PARENT_RESERVATION_BYTES });
    if (!reservation)
        return historyRefusal("history-load-memory-limit");
    try {
        if (signal?.aborted)
            return historyRefusal("history-worker-aborted");
        if (!boundedHistoryValue(operation) || typeof path !== "string" || path.length > 4096 || !path.startsWith("/"))
            return historyRefusal("history-request-limit");
        const stat = await lstat(path);
        if (!stat.isFile())
            return historyRefusal("history-source-unsafe-type");
        const refusal = historySourceAdmission(stat.size, operation);
        if (refusal)
            return historyRefusal(refusal);
        if (!transport || transport.isolation !== "os-bounded-child-v1")
            return historyRefusal("history-worker-unavailable");
        const request = { version: 1, path, source: { deviceId: String(stat.dev), inodeId: String(stat.ino), size: stat.size, mtimeMs: stat.mtimeMs }, operation };
        const wire = JSON.stringify(request);
        if (Buffer.byteLength(wire) > HISTORY_WORKER_CAPS.requestBytes)
            return historyRefusal("history-request-limit");
        dispatched++;
        const response = await transport.run(wire, HISTORY_WORKER_CAPS, signal);
        if (signal?.aborted)
            return historyRefusal("history-worker-aborted");
        return parseResponse(response);
    }
    catch {
        return historyRefusal(signal?.aborted ? "history-worker-aborted" : "history-worker-failed");
    }
    finally {
        reservation.release();
    }
}
export function historyWorkerToolResult(response, exact = false) {
    if (exact && response.status === "refused" && response.code === "legacy-history-size-limit")
        return {
            content: [{ type: "text", text: "History unavailable: this session exceeds the legacy-load limit; exact retrieval requires an existing verified source ledger." }],
            details: { status: "unavailable", code: "verified-source-ledger-required" },
        };
    if (response.status === "ok")
        return { content: [{ type: "text", text: response.text }], details: response.details };
    return { content: [{ type: "text", text: `History unavailable: ${response.code}. No unbounded fallback was run.${response.promotionEvents?.length ? ` Mirrored ${response.promotionEvents.length} already committed promotion event(s).` : ""}` }], details: {
            status: "refused", code: response.code,
            ...(response.promotionEvents?.length ? { promotedMemories: response.promotionEvents.length } : {}),
            ...(response.code === "legacy-history-size-limit" ? { maximumBytes: LEGACY_HISTORY_MAX_BYTES } : {}),
            ...(response.code === "history-index-memory-limit" ? { maximumBytes: SEARCH_INDEX_SOURCE_MAX_BYTES } : {}),
        } };
}
/** Idempotent shared-runtime validator. Undefined means ONLY a strictly validated
 * bounded stage frame. Final frames are returned unchanged, never reserialized. */
export function validateHistoryWorkerWire(wire) {
    if (typeof wire !== "string" || wire.length > HISTORY_WORKER_CAPS.responseBytes || Buffer.byteLength(wire) > HISTORY_WORKER_CAPS.responseBytes)
        throw new Error("history-output-limit");
    let value;
    try {
        value = JSON.parse(wire);
    }
    catch {
        throw new Error("history-response-invalid");
    }
    if (plain(value) && value.status === "stage") {
        if (Object.keys(value).length !== 2 || !HISTORY_WORKER_STAGES.includes(value.stage))
            throw new Error("history-response-invalid");
        return undefined;
    }
    const response = parseResponse(wire);
    if (JSON.stringify(response) !== JSON.stringify(value))
        throw new Error("history-response-invalid");
    return wire;
}
/** Per-extension retained feedback envelope (8 sessions, 256 keys per category).
 * Acquired before search/recall and released when the extension shuts down. */
export function createHistoryFeedbackAdmission() {
    let reservation;
    return {
        reserve() {
            reservation ??= admission.reserve({ retainedReferences: 32 * 1024 * 1024 });
            return reservation !== undefined;
        },
        release() { reservation?.release(); reservation = undefined; },
    };
}
//# sourceMappingURL=history-worker-dispatch.js.map