export const HISTORY_WORKER_CAPS = Object.freeze({
    memoryBytes: 128 * 1024 * 1024,
    heapMiB: 80,
    requestBytes: 64 * 1024,
    responseBytes: 256 * 1024,
    timeoutMs: 30_000,
});
export const HISTORY_PARENT_RESERVATION_BYTES = 16 * 1024 * 1024;
export const LEGACY_HISTORY_MAX_BYTES = 64 * 1024 * 1024;
export const SEARCH_INDEX_SOURCE_MAX_BYTES = 16 * 1024 * 1024;
export const HISTORY_FEEDBACK_LIMIT = 64;
export const HISTORY_WORKER_STAGES = ["validate", "admit", "read", "index", "query", "promotion", "respond"];
export const HISTORY_STRING_LIMIT = 4096;
export function historyRefusal(code) { return { status: "refused", code }; }
export function historySourceAdmission(sourceBytes, operation) {
    if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0)
        return "history-source-limit-invalid";
    if (sourceBytes > LEGACY_HISTORY_MAX_BYTES)
        return "legacy-history-size-limit";
    const indexed = operation.kind === "search" || operation.kind === "recall";
    if (indexed && sourceBytes > SEARCH_INDEX_SOURCE_MAX_BYTES)
        return "history-index-memory-limit";
    // A measured refusal threshold, NOT a universal expansion bound. The child OS
    // limit remains mandatory even for a tiny input with pathological expansion.
    if (sourceBytes * (indexed ? 32 : 8) > HISTORY_WORKER_CAPS.memoryBytes)
        return indexed ? "history-index-memory-limit" : "history-load-memory-limit";
    return undefined;
}
/** Bounded-shape validation before serialization. No enumeration or copying of
 * unknown object graphs. Requests contain only scalar options and tiny arrays. */
export function boundedHistoryValue(value, depth = 0, budget = { nodes: 0 }) {
    if (++budget.nodes > 256 || depth > 5)
        return false;
    if (value === undefined || value === null || typeof value === "boolean")
        return true;
    if (typeof value === "string")
        return value.length <= HISTORY_STRING_LIMIT;
    if (typeof value === "number")
        return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
    if (typeof value !== "object")
        return false;
    if (Array.isArray(value)) {
        if (value.length > 16)
            return false;
        for (const item of value)
            if (!boundedHistoryValue(item, depth + 1, budget))
                return false;
        return true;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
        return false;
    let count = 0;
    for (const key in value) {
        if (++count > 32 || key.length > 64)
            return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !boundedHistoryValue(descriptor.value, depth + 1, budget))
            return false;
    }
    return true;
}
/** Strict bounded request validator for shared-runtime preflight. */
export function validateHistoryWorkerRequestWire(wire) {
    if (typeof wire !== "string" || wire.length > HISTORY_WORKER_CAPS.requestBytes || Buffer.byteLength(wire) > HISTORY_WORKER_CAPS.requestBytes)
        throw new Error("history-request-limit");
    let value;
    try {
        value = JSON.parse(wire);
    }
    catch {
        throw new Error("history-request-invalid");
    }
    if (!boundedHistoryValue(value) || !value || value.version !== 1 || typeof value.path !== "string" || !value.path.startsWith("/") || !value.source || !value.operation || !["get", "range", "legacy-search", "search", "recall"].includes(value.operation.kind) || typeof value.source.deviceId !== "string" || typeof value.source.inodeId !== "string" || !Number.isFinite(value.source.mtimeMs) || !Number.isSafeInteger(value.source.size) || value.source.size < 0)
        throw new Error("history-request-invalid");
}
/** Commit receipts must fit independently of the recall result so an unavailable
 * response can still mirror every completed append. Only ordinary touch/promote
 * records created by the memory store are allowed across this boundary. */
export function validHistoryPromotionEvent(value) {
    if (!boundedHistoryValue(value) || value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const event = value;
    const keys = ["schemaVersion", "eventId", "memoryId", "action", "timestamp", "turn", "previousEventHash", "eventHash", "sourceRef", "scope", "authority", "confidence", "text", "reason", "supersedesMemoryId"];
    if (Object.keys(event).some((key) => !keys.includes(key)) || event.schemaVersion !== 2 || !["touch", "promote"].includes(event.action) || event.authority !== "ordinary")
        return false;
    for (const key of ["eventId", "memoryId", "timestamp", "previousEventHash", "eventHash", "sourceRef", "scope"])
        if (typeof event[key] !== "string")
            return false;
    for (const key of ["text", "reason", "supersedesMemoryId"])
        if (event[key] !== undefined && typeof event[key] !== "string")
            return false;
    return typeof event.eventHash === "string" && /^[a-f0-9]{20}$/.test(event.eventHash)
        && Number.isSafeInteger(event.turn) && event.turn >= 0
        && typeof event.confidence === "number" && event.confidence >= 0 && event.confidence <= 1
        && Buffer.byteLength(JSON.stringify(event)) <= 16 * 1024;
}
//# sourceMappingURL=history-worker-contract.js.map