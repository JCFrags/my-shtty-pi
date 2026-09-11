import { SEARCH_V3_LIMITS, isSearchV3Request, type SearchV3Response } from "./search-v3-contract.js";
import { isEpisodeStateRequest } from "./episode-state-contract.js";
import { executeEpisodeStateRequest } from "./episode-state-store.js";
import { executeSearchV3Request } from "./search-v3-store.js";
import { observeCatalogWorker } from "./catalog-worker-observation.js";

process.once("message", async (request: unknown) => {
  const failure = (code: string, sourceBytes = 0): SearchV3Response => ({ v: 1, ok: false, code, sourceBytes,
    sqliteNativeLimitBytes: SEARCH_V3_LIMITS.nativeSqliteBytes, resumable: true });
  let response: SearchV3Response;
  try {
    if (Buffer.byteLength(JSON.stringify(request) ?? "") > SEARCH_V3_LIMITS.requestBytes) response = failure("search-v3-request-invalid");
    else if (isEpisodeStateRequest(request)) response = await executeEpisodeStateRequest(request);
    else response = isSearchV3Request(request) ? await executeSearchV3Request(request) : failure("search-v3-request-invalid");
    if (response.ok) response.result.workerObservation = observeCatalogWorker();
    if (Buffer.byteLength(JSON.stringify(response)) > SEARCH_V3_LIMITS.responseBytes) response = failure("search-v3-response-limit", response.sourceBytes);
  } catch { response = failure("search-v3-worker-failed"); }
  if (!process.send) { process.exitCode = 1; return; }
  process.send(response, () => process.disconnect());
});
