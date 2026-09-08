// Loaded only after M03 establishes the contained process tree and its limits.
// Native SQLite work is synchronous here, never on Pi's interactive event loop.
import type { CatalogResponse } from "./catalog-contract.js";
import { isCatalogStoreRequest } from "./catalog-store-contract.js";
import { executeCatalogStoreRequest } from "./catalog-store.js";
import { observeCatalogWorker } from "./catalog-worker-observation.js";
process.once("message", async (request: unknown) => {
  let response: CatalogResponse;
  try {
    response = isCatalogStoreRequest(request) && Buffer.byteLength(JSON.stringify(request)) <= 64 * 1024
      ? await executeCatalogStoreRequest(request)
      : { v: 1, ok: false, code: "catalog-request-invalid", sourceBytes: 0 };
    if (response.ok) response.result.workerObservation = observeCatalogWorker();
    if (Buffer.byteLength(JSON.stringify(response)) > 256 * 1024) response = { v: 1, ok: false, code: "catalog-response-limit", sourceBytes: response.sourceBytes };
  } catch { response = { v: 1, ok: false, code: "catalog-worker-failed", sourceBytes: 0 }; }
  if (!process.send) { process.exitCode = 1; return; }
  process.send(response, () => { process.disconnect(); });
});
