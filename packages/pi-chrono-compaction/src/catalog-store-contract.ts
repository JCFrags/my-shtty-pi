/** Logical-store protocol. Safe to import in Pi: no filesystem or native imports. */
import { isCatalogRequest, type CatalogRequest } from "./catalog-contract.js";
export type CatalogStoreRequest = (CatalogRequest & { targetStoreKey?: string }) | {
  v: 1; catalogDirectory: string; sessionKey: string;
} & (
  | { op: "recoverStart"; rebuildKey: string }
  | { op: "recoverPublish"; targetStoreKey: string; generation: number; expectedShards: number; expectedActiveStoreKey: string | null }
);
export const isStoreKey = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
export function isCatalogStoreRequest(value: unknown): value is CatalogStoreRequest {
  try {
    const x = value as any;
    if (!x || (x.targetStoreKey !== undefined && !isStoreKey(x.targetStoreKey))) return false;
    if (x.op === "recoverStart") return isCatalogRequest({ ...x, op: "rebuildStep", action: "start" });
    if (x.op === "recoverPublish") return isStoreKey(x.targetStoreKey) && (x.expectedActiveStoreKey === null || isStoreKey(x.expectedActiveStoreKey)) && isCatalogRequest({ ...x, op: "rebuildStep", action: "publish" });
    const target = x.targetStoreKey;
    if (!isCatalogRequest(x)) return false;
    if ("view" in x && (x.view.sessionKey !== x.sessionKey || !isStoreKey(x.view.storeKey) || (target !== undefined && target !== x.view.storeKey))) return false;
    return true;
  } catch { return false; }
}
