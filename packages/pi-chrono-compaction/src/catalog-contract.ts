/** Pure worker protocol: importing this module never loads SQLite. */
export const CATALOG_PROTOCOL_VERSION = 1;
export const CATALOG_LIMITS = Object.freeze({ wireBytes: 256 * 1024, page: 16, ancestry: 64, sourceDelta: 7 * 1024 * 1024, records: 512, statements: 8192, checkpointBytes: 1536 * 1024, jobMs: 1000 });
export interface CatalogRef { shardKey: string; eventId: string }
export interface CatalogView { generation: number; eventCut: number; branchKey: string; segments: { segment: number; cut: number }[] }
interface Base { v: 1; catalogDirectory: string; sessionKey: string }
export type CatalogRequest = Base & (
  | { op: "ingestStep"; generation?: number; shardKey: string; sourcePath: string; branchKey: string; shardOrdinal: number; parent?: CatalogRef }
  | { op: "status"; generation?: number; shardKey?: string }
  | { op: "pin"; generation?: number; branchKey: string; leaf: CatalogRef }
  | { op: "page"; view: CatalogView; after?: number; limit?: number }
  | { op: "blocks"; view: CatalogView; eventSeq: number; after?: number; limit?: number }
  | { op: "raw"; view: CatalogView; eventSeq: number; offset: number; length: number }
  | { op: "integrityStep"; generation?: number; shardKey: string; after?: number }
  | { op: "rebuildStep"; action: "start"; rebuildKey: string }
  | { op: "rebuildStep"; action: "publish"; generation: number; expectedShards: number }
);
export interface CatalogEvent { seq: number; shardKey: string; branchKey: string; ordinal: number; rawStart: number; rawEnd: number; endByte: number; metadata: Record<string, unknown> }
export type CatalogResponse = { v: 1; ok: true; result: Record<string, unknown>; sourceBytes: number } | { v: 1; ok: false; code: string; sourceBytes: number };
const integer = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) >= 0;
const key = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(x);
const path = (x: unknown): x is string => typeof x === "string" && x.startsWith("/") && x.length <= 4096 && !x.includes("\0");
const ref = (x: any): boolean => !!x && key(x.shardKey) && typeof x.eventId === "string" && x.eventId.length <= 1024;
const view = (x: any): boolean => !!x && integer(x.generation) && x.generation > 0 && integer(x.eventCut) && key(x.branchKey) && Array.isArray(x.segments) && x.segments.length > 0 && x.segments.length <= 64 && x.segments.every((s: any) => integer(s.segment) && integer(s.cut) && s.cut <= x.eventCut);
export function isCatalogRequest(value: unknown): value is CatalogRequest {
  try {
    if (JSON.stringify(value).length > CATALOG_LIMITS.wireBytes / 4) return false;
    const x = value as any;
    if (!x || x.v !== 1 || !path(x.catalogDirectory) || !key(x.sessionKey) || (x.generation !== undefined && (!integer(x.generation) || x.generation < 1))) return false;
    if (x.after !== undefined && !integer(x.after)) return false;
    if (x.limit !== undefined && (!integer(x.limit) || x.limit < 1 || x.limit > 16)) return false;
    switch (x.op) {
      case "status": return x.shardKey === undefined || key(x.shardKey);
      case "ingestStep": return key(x.shardKey) && path(x.sourcePath) && key(x.branchKey) && integer(x.shardOrdinal) && (x.parent === undefined || ref(x.parent));
      case "pin": return key(x.branchKey) && ref(x.leaf);
      case "page": return view(x.view);
      case "blocks": return view(x.view) && integer(x.eventSeq);
      case "raw": return view(x.view) && integer(x.eventSeq) && integer(x.offset) && integer(x.length) && x.length <= 65536;
      case "integrityStep": return key(x.shardKey);
      case "rebuildStep": return x.action === "start" ? key(x.rebuildKey) : x.action === "publish" && integer(x.generation) && integer(x.expectedShards) && x.expectedShards > 0 && x.expectedShards <= 1024;
      default: return false;
    }
  } catch { return false; }
}
