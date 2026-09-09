import { SEARCH_V3_LIMITS, isSearchV3Request } from "./search-v3-contract.js";
import { executeSearchV3Request } from "./search-v3-store.js";
import { observeCatalogWorker } from "./catalog-worker-observation.js";
process.once("message", async (request) => {
    const failure = (code, sourceBytes = 0) => ({ v: 1, ok: false, code, sourceBytes,
        sqliteNativeLimitBytes: SEARCH_V3_LIMITS.nativeSqliteBytes, resumable: true });
    let response;
    try {
        response = isSearchV3Request(request) && Buffer.byteLength(JSON.stringify(request)) <= SEARCH_V3_LIMITS.requestBytes
            ? await executeSearchV3Request(request) : failure("search-v3-request-invalid");
        if (response.ok)
            response.result.workerObservation = observeCatalogWorker();
        if (Buffer.byteLength(JSON.stringify(response)) > SEARCH_V3_LIMITS.responseBytes)
            response = failure("search-v3-response-limit", response.sourceBytes);
    }
    catch {
        response = failure("search-v3-worker-failed");
    }
    if (!process.send) {
        process.exitCode = 1;
        return;
    }
    process.send(response, () => process.disconnect());
});
//# sourceMappingURL=search-v3-worker-entry.js.map