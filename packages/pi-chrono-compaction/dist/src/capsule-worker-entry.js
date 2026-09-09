// Loaded only after M03 establishes containment and resource limits.
// Synchronous SQLite and source decoding never run on Pi's interactive thread.
import { CAPSULE_LIMITS, isCapsuleWorkerRequest } from "./capsule-contract.js";
import { executeCapsuleRequest } from "./capsule-store.js";
import { observeCatalogWorker } from "./catalog-worker-observation.js";
process.once("message", async (request) => {
    const failure = (code, sourceBytes = 0) => ({
        v: 1, ok: false, code, sourceBytes, sqliteNativeLimitBytes: CAPSULE_LIMITS.nativeSqliteBytes, resumable: true,
    });
    let response;
    try {
        response = isCapsuleWorkerRequest(request) && Buffer.byteLength(JSON.stringify(request)) <= CAPSULE_LIMITS.requestBytes
            ? await executeCapsuleRequest(request)
            : failure("capsule-request-invalid");
        if (response.ok)
            response.result.workerObservation = observeCatalogWorker();
        if (Buffer.byteLength(JSON.stringify(response)) > CAPSULE_LIMITS.responseBytes)
            response = failure("capsule-response-limit", response.sourceBytes);
    }
    catch {
        response = failure("capsule-worker-failed");
    }
    if (!process.send) {
        process.exitCode = 1;
        return;
    }
    process.send(response, () => { process.disconnect(); });
});
//# sourceMappingURL=capsule-worker-entry.js.map