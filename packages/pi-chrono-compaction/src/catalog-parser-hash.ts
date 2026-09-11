import { createHash } from "node:crypto";

/** Not SHA256(text). v1 hashes UTF-16LE code units, including lone surrogates,
 * in fixed 1024-unit leaves. Boundaries do not depend on ingestion chunks.
 * H0=SHA256(domain+'seed'); Hi=SHA256(domain+'leaf\0'+H(i-1)+leafBytes);
 * result=SHA256(domain+'end\0'+Hi+ASCII(decimal code-unit length)).
 * H values in this definition are 32 raw bytes. Empty text has no leaves.
 */
export const CATALOG_TEXT_HASH = "chrono-utf16le-chain-sha256-v1";
/** At a parser checkpoint, a partial leaf exposes up to 1023 decoded UTF-16
 * units as 2046 reconstructable byte values. This is PRIVATE parser carry,
 * not searchable text, a content cache, or an M05 decoded chunk store. Persist
 * only in the private catalog checkpoint; never log/report its bytes. A full
 * leaf is hashed immediately and completion clears all carry. Catalog shadow
 * activation remains default-off pending project-lead storage/privacy review.
 */
export const CATALOG_HASH_CARRY_BYTES = 2046;
const DOMAIN = "chrono/catalog/decoded/v1\0";
export interface CatalogHashState { chain: string; pending: number[]; units: number }
export function createCatalogHash(): CatalogHashState {
  return { chain: createHash("sha256").update(DOMAIN + "seed").digest("hex"), pending: [], units: 0 };
}
function leaf(state: CatalogHashState): void {
  state.chain = createHash("sha256").update(DOMAIN + "leaf\0").update(Buffer.from(state.chain, "hex"))
    .update(Buffer.from(state.pending)).digest("hex");
  state.pending = [];
}
export function catalogHashUnit(state: CatalogHashState, unit: number): void {
  // The transient 2048-byte full leaf never survives this synchronous call.
  state.pending.push(unit & 255, unit >>> 8);
  state.units++;
  if (state.pending.length === 2048) leaf(state);
}
export function finishCatalogHash(state: CatalogHashState): string {
  if (state.pending.length) leaf(state);
  return createHash("sha256").update(DOMAIN + "end\0").update(Buffer.from(state.chain, "hex"))
    .update(String(state.units)).digest("hex");
}
