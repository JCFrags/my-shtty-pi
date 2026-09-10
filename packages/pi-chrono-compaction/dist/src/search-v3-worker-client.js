import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SEARCH_V3_LIMITS, isSearchV3Request } from "./search-v3-contract.js";
import { isEpisodeStateRequest } from "./episode-state-contract.js";
import { runBoundedWorker, WorkerRuntimeError } from "./worker-runtime.js";
export const SEARCH_V3_WORKER_CAPS = Object.freeze({
    requestBytes: SEARCH_V3_LIMITS.requestBytes,
    responseBytes: SEARCH_V3_LIMITS.responseBytes,
    sourceBytes: 16 * 1024 * 1024,
    memoryBytes: SEARCH_V3_LIMITS.workerRssBytes,
    heapMiB: 128,
    timeoutMs: SEARCH_V3_LIMITS.workerDeadlineMs,
});
export function validateSearchV3Response(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("search-v3-response-invalid");
    const response = value;
    if (response.v !== 1 || typeof response.ok !== "boolean" || !Number.isSafeInteger(response.sourceBytes) || Number(response.sourceBytes) < 0
        || Number(response.sourceBytes) > SEARCH_V3_LIMITS.sourceBytesPerJob || response.sqliteNativeLimitBytes !== SEARCH_V3_LIMITS.nativeSqliteBytes
        || Buffer.byteLength(JSON.stringify(response)) > SEARCH_V3_LIMITS.responseBytes)
        throw new Error("search-v3-response-invalid");
    if (response.ok) {
        if (!response.result || typeof response.result !== "object" || Array.isArray(response.result)
            || Object.keys(response).sort().join(",") !== "ok,result,sourceBytes,sqliteNativeLimitBytes,v")
            throw new Error("search-v3-response-invalid");
    }
    else if (typeof response.code !== "string" || !/^search-v3-[a-z0-9-]{1,80}$/.test(response.code) || typeof response.resumable !== "boolean"
        || Object.keys(response).sort().join(",") !== "code,ok,resumable,sourceBytes,sqliteNativeLimitBytes,v")
        throw new Error("search-v3-response-invalid");
    return value;
}
export async function runSearchV3Worker(request, options = {}) {
    try {
        const validateRequest = (value) => {
            if ((!isSearchV3Request(value) && !isEpisodeStateRequest(value)) || Buffer.byteLength(JSON.stringify(value)) > SEARCH_V3_WORKER_CAPS.requestBytes)
                throw new Error("search-v3-request-invalid");
            return value;
        };
        validateRequest(request);
        const sessionKey = createHash("sha256").update(request.catalogDirectory).update("\0").update(request.identity.capsule.sessionKey).digest("hex");
        const { value } = await runBoundedWorker({
            entryPath: fileURLToPath(new URL("./search-v3-worker-entry.js", import.meta.url)), request,
            identity: { schemaVersion: 1, kind: `search-v3-${request.op.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, sessionKey },
            caps: { deadlineMs: Date.now() + SEARCH_V3_WORKER_CAPS.timeoutMs, sourceBytes: SEARCH_V3_WORKER_CAPS.sourceBytes,
                responseBytes: SEARCH_V3_WORKER_CAPS.responseBytes, memoryBytes: SEARCH_V3_WORKER_CAPS.memoryBytes, heapMiB: SEARCH_V3_WORKER_CAPS.heapMiB },
            signal: options.signal, slots: options.slots, schedulerDirectory: options.schedulerDirectory, priority: request.op === "ingestPage" || request.op === "materializeState" ? "low" : "high",
            validateRequest, validateResponse: validateSearchV3Response,
        });
        return value;
    }
    catch (error) {
        const code = error instanceof WorkerRuntimeError && /^[a-z0-9-]{1,64}$/.test(error.code) ? `search-v3-${error.code}`
            : options.signal?.aborted ? "search-v3-worker-aborted" : "search-v3-worker-failed";
        return { v: 1, ok: false, code, sourceBytes: 0, sqliteNativeLimitBytes: SEARCH_V3_LIMITS.nativeSqliteBytes, resumable: true };
    }
}
//# sourceMappingURL=search-v3-worker-client.js.map