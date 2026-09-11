import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CAPSULE_LIMITS, isCapsuleWorkerRequest } from "./capsule-contract.js";
import { runBoundedWorker, WorkerRuntimeError } from "./worker-runtime.js";
/** Reuses M03 admission and containment. The filesystem allowance includes
 * trusted module/provenance reads; M05 separately enforces 8 MiB source work.
 * Neither JavaScript filesystem accounting nor this configured native limit
 * measures native I/O, native allocation, RSS, or actual OS enforcement.
 */
export const CAPSULE_WORKER_CAPS = Object.freeze({
    requestBytes: CAPSULE_LIMITS.requestBytes, responseBytes: CAPSULE_LIMITS.responseBytes,
    sourceBytes: 16 * 1024 * 1024, memoryBytes: CAPSULE_LIMITS.workerRssBytes,
    heapMiB: 128, timeoutMs: CAPSULE_LIMITS.workerDeadlineMs,
});
export function validateCapsuleResponse(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("capsule-response-invalid");
    const response = value;
    if (response.v !== 1 || typeof response.ok !== "boolean"
        || !Number.isSafeInteger(response.sourceBytes) || Number(response.sourceBytes) < 0
        || Number(response.sourceBytes) > CAPSULE_LIMITS.sourceBytesPerJob
        || response.sqliteNativeLimitBytes !== CAPSULE_LIMITS.nativeSqliteBytes
        || Buffer.byteLength(JSON.stringify(response)) > CAPSULE_WORKER_CAPS.responseBytes)
        throw new Error("capsule-response-invalid");
    if (response.ok) {
        if (!response.result || typeof response.result !== "object" || Array.isArray(response.result)
            || Object.keys(response).sort().join(",") !== "ok,result,sourceBytes,sqliteNativeLimitBytes,v")
            throw new Error("capsule-response-invalid");
    }
    else if (typeof response.code !== "string" || !/^capsule-[a-z0-9-]{1,80}$/.test(response.code)
        || typeof response.resumable !== "boolean"
        || Object.keys(response).sort().join(",") !== "code,ok,resumable,sourceBytes,sqliteNativeLimitBytes,v")
        throw new Error("capsule-response-invalid");
    return value;
}
export async function runCapsuleWorker(request, options = {}) {
    try {
        const validateRequest = (value) => {
            if (!isCapsuleWorkerRequest(value) || Buffer.byteLength(JSON.stringify(value)) > CAPSULE_WORKER_CAPS.requestBytes)
                throw new Error("capsule-request-invalid");
            return value;
        };
        validateRequest(request);
        // Share one logical-session admission identity across M05 physical stores.
        const sessionKey = createHash("sha256").update(request.catalogDirectory).update("\0").update(request.identity.sessionKey).digest("hex");
        const { value } = await runBoundedWorker({
            entryPath: fileURLToPath(new URL("./capsule-worker-entry.js", import.meta.url)), request,
            identity: { schemaVersion: 1, kind: `capsule-${request.op.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, sessionKey },
            caps: { deadlineMs: Date.now() + CAPSULE_WORKER_CAPS.timeoutMs, sourceBytes: CAPSULE_WORKER_CAPS.sourceBytes,
                responseBytes: CAPSULE_WORKER_CAPS.responseBytes, memoryBytes: CAPSULE_WORKER_CAPS.memoryBytes, heapMiB: CAPSULE_WORKER_CAPS.heapMiB },
            signal: options.signal, slots: options.slots, schedulerDirectory: options.schedulerDirectory,
            priority: "low", validateRequest, validateResponse: validateCapsuleResponse,
        });
        return value;
    }
    catch (error) {
        const code = error instanceof WorkerRuntimeError && /^[a-z0-9-]{1,64}$/.test(error.code)
            ? `capsule-${error.code}` : options.signal?.aborted ? "capsule-worker-aborted" : "capsule-worker-failed";
        return { v: 1, ok: false, code, sourceBytes: 0, sqliteNativeLimitBytes: CAPSULE_LIMITS.nativeSqliteBytes, resumable: true };
    }
}
//# sourceMappingURL=capsule-worker-client.js.map