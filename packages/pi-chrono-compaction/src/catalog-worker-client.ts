import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { CatalogResponse } from "./catalog-contract.js";
import { isCatalogStoreRequest, type CatalogStoreRequest } from "./catalog-store-contract.js";
import { runBoundedWorker, WorkerRuntimeError } from "./worker-runtime.js";

/** Per-catalog-job bounds, not changes to the shared M03 scheduler policy.
 * Source access has its own stricter 8MiB cumulative cap. The filesystem cap
 * also reserves space for trusted module and binding-provenance reads.
 * Native SQLite I/O is NOT counted by the JavaScript filesystem cap.
 */
export const CATALOG_WORKER_CAPS = Object.freeze({ requestBytes: 64 * 1024, responseBytes: 256 * 1024, sourceBytes: 16 * 1024 * 1024, memoryBytes: 256 * 1024 * 1024, heapMiB: 128, timeoutMs: 30_000 });
export function validateCatalogResponse(value: unknown): CatalogResponse {
  const response = value as { v?: unknown; ok?: unknown; sourceBytes?: unknown; result?: unknown; code?: unknown } | null;
  if (!response || response.v !== 1 || typeof response.ok !== "boolean" || !Number.isSafeInteger(response.sourceBytes) || Number(response.sourceBytes) < 0 || Number(response.sourceBytes) > 8 * 1024 * 1024 || Buffer.byteLength(JSON.stringify(response)) > CATALOG_WORKER_CAPS.responseBytes) throw new Error("catalog-response-invalid");
  if (response.ok) {
    if (!response.result || typeof response.result !== "object" || Array.isArray(response.result) || Object.keys(response).sort().join(",") !== "ok,result,sourceBytes,v") throw new Error("catalog-response-invalid");
  } else if (typeof response.code !== "string" || !/^catalog-[a-z0-9-]{1,80}$/.test(response.code) || Object.keys(response).sort().join(",") !== "code,ok,sourceBytes,v") throw new Error("catalog-response-invalid");
  return response as CatalogResponse;
}
export async function runCatalogWorker(request: CatalogStoreRequest, options: { signal?: AbortSignal; slots?: number; schedulerDirectory?: string } = {}): Promise<CatalogResponse> {
  try {
    const validateRequest = (value: unknown): CatalogStoreRequest => {
      if (!isCatalogStoreRequest(value) || Buffer.byteLength(JSON.stringify(value)) > CATALOG_WORKER_CAPS.requestBytes) throw new Error("catalog-request-invalid");
      return value;
    };
    validateRequest(request);
    const sessionKey = createHash("sha256").update(request.catalogDirectory).update("\0").update(request.sessionKey).digest("hex");
    const { value } = await runBoundedWorker<CatalogStoreRequest, CatalogResponse>({
      entryPath: fileURLToPath(new URL("./catalog-worker-entry.js", import.meta.url)), request,
      identity: { schemaVersion: 1, kind: `catalog-${request.op.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`)}`, sessionKey },
      caps: { deadlineMs: Date.now() + CATALOG_WORKER_CAPS.timeoutMs, sourceBytes: CATALOG_WORKER_CAPS.sourceBytes, responseBytes: CATALOG_WORKER_CAPS.responseBytes, memoryBytes: CATALOG_WORKER_CAPS.memoryBytes, heapMiB: CATALOG_WORKER_CAPS.heapMiB },
      signal: options.signal, slots: options.slots, schedulerDirectory: options.schedulerDirectory, priority: "low", validateRequest, validateResponse: validateCatalogResponse,
    });
    return value;
  } catch (error) {
    const code = error instanceof WorkerRuntimeError && /^[a-z0-9-]{1,64}$/.test(error.code) ? `catalog-${error.code}` : options.signal?.aborted ? "catalog-worker-aborted" : "catalog-worker-failed";
    return { v: 1, ok: false, code, sourceBytes: 0 };
  }
}
