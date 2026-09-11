import { isCatalogStoreRequest } from "./catalog-store-contract.js";
import { executeCatalogStoreRequest } from "./catalog-store.js";
import { observeCatalogWorker } from "./catalog-worker-observation.js";
process.once("message", async (request) => {
    let response;
    try {
        response = isCatalogStoreRequest(request) && Buffer.byteLength(JSON.stringify(request)) <= 64 * 1024
            ? await executeCatalogStoreRequest(request)
            : { v: 1, ok: false, code: "catalog-request-invalid", sourceBytes: 0 };
        if (response.ok)
            response.result.workerObservation = observeCatalogWorker();
        if (Buffer.byteLength(JSON.stringify(response)) > 256 * 1024)
            response = { v: 1, ok: false, code: "catalog-response-limit", sourceBytes: response.sourceBytes };
    }
    catch {
        response = { v: 1, ok: false, code: "catalog-worker-failed", sourceBytes: 0 };
    }
    if (!process.send) {
        process.exitCode = 1;
        return;
    }
    process.send(response, () => { process.disconnect(); });
});
//# sourceMappingURL=catalog-worker-entry.js.map