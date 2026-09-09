import {
  isCapsuleCatalogView,
  isDerivedStoreIdentity,
  isScopedBodySourceRef,
  sourceRefWithinViewBounds,
  type CapsuleCatalogView,
  type DerivedStoreIdentity,
  type ScopedBodySourceRef,
} from "./capsule-contract.js";

/** Pure M06 protocol. Importing it loads neither SQLite nor a worker. */
export const SEARCH_V3_PROTOCOL_VERSION = 1 as const;
export const SEARCH_V3_SCHEMA_VERSION = 1 as const;
export const SEARCH_V3_LIMITS = Object.freeze({
  requestBytes: 48 * 1024,
  responseBytes: 96 * 1024,
  sourceBytesPerJob: 8 * 1024 * 1024,
  nativeSqliteBytes: 64 * 1024 * 1024,
  ingestSources: 4,
  ingestChunks: 8,
  page: 12,
  candidates: 128,
  cueUnits: 8_192,
  queryUnits: 512,
  recallUnits: 8_192,
  cacheBytes: 64 * 1024,
  cacheEntryBytes: 16 * 1024,
  scanChunks: 64,
  scanMs: 250,
  workerRssBytes: 256 * 1024 * 1024,
  workerDeadlineMs: 30_000,
});

export interface SearchV3Identity {
  readonly storeKey: string;
  readonly capsule: DerivedStoreIdentity;
  readonly schemaVersion: typeof SEARCH_V3_SCHEMA_VERSION;
  readonly configHash: string;
}
export type SearchV3View = CapsuleCatalogView;
export type SearchV3Mode = "ranked" | "literal" | "regex";
export interface SearchV3Filters {
  readonly kinds?: readonly string[];
  readonly provenance?: readonly ("original" | "mixed" | "generated")[];
  readonly shardKeys?: readonly string[];
  readonly toolNames?: readonly string[];
  readonly error?: boolean;
  /** M07 owns unresolved-state materialization. */
  readonly unresolved?: boolean;
  readonly path?: string;
  readonly identifier?: string;
  /** M07 owns this materialization. M06 returns search-v3-filter-unsupported. */
  readonly currentState?: "current" | "superseded" | "any";
}
export interface SearchV3ScanBudget { readonly maxChunks: number; readonly maxMs: number }
export interface SearchV3Handle {
  readonly v: 1;
  readonly searchStoreKey: string;
  readonly capsuleStoreKey: string;
  readonly catalogStoreKey: string;
  readonly catalogGeneration: number;
  readonly sessionKey: string;
  readonly branchKey: string;
  readonly eventCut: number;
  readonly indexGeneration: number;
  readonly source: ScopedBodySourceRef;
  readonly evidence: "raw-source" | "generated-cue";
  readonly decodedUtf16?: { readonly start: number; readonly end: number };
}
interface Base {
  readonly v: 1;
  readonly searchDirectory: string;
  readonly capsuleDirectory: string;
  readonly catalogDirectory: string;
  readonly identity: SearchV3Identity;
}
export type SearchV3Request = Base & (
  | { readonly op: "ingestPage"; readonly view: SearchV3View; readonly maxSources?: number; readonly maxChunks?: number }
  | { readonly op: "status"; readonly view?: SearchV3View }
  | { readonly op: "query"; readonly view: SearchV3View; readonly query: string; readonly mode?: SearchV3Mode; readonly caseSensitive?: boolean; readonly filters?: SearchV3Filters;
      readonly cursor?: string; readonly limit?: number; readonly scan?: SearchV3ScanBudget }
  | { readonly op: "recall"; readonly view: SearchV3View; readonly handle: SearchV3Handle; readonly decodedStart?: number; readonly decodedLength?: number }
  | { readonly op: "sources"; readonly view: SearchV3View; readonly eventSeq: number; readonly blockIndex?: number; readonly afterDescriptor?: number; readonly limit?: number }
  | { readonly op: "range"; readonly view: SearchV3View; readonly cursor?: string; readonly limit?: number }
);
export type SearchV3Response =
  | { readonly v: 1; readonly ok: true; readonly result: Record<string, unknown>; readonly sourceBytes: number; readonly sqliteNativeLimitBytes: number }
  | { readonly v: 1; readonly ok: false; readonly code: string; readonly sourceBytes: number; readonly sqliteNativeLimitBytes: number; readonly resumable: boolean };

const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const integer = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) >= 0;
const positive = (x: unknown): x is number => integer(x) && x > 0;
const key = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(x);
const uuid = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
const hash = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
const path = (x: unknown): x is string => typeof x === "string" && x.startsWith("/") && x.length <= 4096 && !x.includes("\0") && !/[\ud800-\udfff]/u.test(x);
const bytesWithin = (x: unknown, limit: number): boolean => { try { return Buffer.byteLength(JSON.stringify(x)) <= limit; } catch { return false; } };
const smallStrings = (x: unknown, maximum: number, length = 128): x is readonly string[] => Array.isArray(x) && x.length <= maximum
  && x.every(value => typeof value === "string" && value.length > 0 && value.length <= length);

export function isSearchV3Identity(value: unknown): value is SearchV3Identity {
  return object(value) && uuid(value.storeKey) && isDerivedStoreIdentity(value.capsule)
    && value.schemaVersion === SEARCH_V3_SCHEMA_VERSION && hash(value.configHash);
}
function identityMatchesView(identity: SearchV3Identity, view: SearchV3View): boolean {
  return identity.capsule.sessionKey === view.sessionKey && identity.capsule.catalogStoreKey === view.storeKey
    && identity.capsule.catalogGeneration === view.generation;
}
function isFilters(value: unknown): value is SearchV3Filters {
  if (!object(value) || Object.keys(value).some(name => !["kinds", "provenance", "shardKeys", "toolNames", "error", "unresolved", "path", "identifier", "currentState"].includes(name))) return false;
  return (value.kinds === undefined || smallStrings(value.kinds, 16, 64))
    && (value.provenance === undefined || Array.isArray(value.provenance) && value.provenance.length <= 3
      && value.provenance.every(item => item === "original" || item === "mixed" || item === "generated"))
    && (value.shardKeys === undefined || smallStrings(value.shardKeys, 16))
    && (value.toolNames === undefined || smallStrings(value.toolNames, 16))
    && (value.error === undefined || typeof value.error === "boolean")
    && (value.unresolved === undefined || typeof value.unresolved === "boolean")
    && (value.path === undefined || typeof value.path === "string" && value.path.length <= 512)
    && (value.identifier === undefined || typeof value.identifier === "string" && value.identifier.length <= 256)
    && (value.currentState === undefined || ["current", "superseded", "any"].includes(String(value.currentState)));
}
export function isSearchV3Handle(value: unknown): value is SearchV3Handle {
  if (!object(value) || value.v !== 1 || !uuid(value.searchStoreKey) || !uuid(value.capsuleStoreKey) || !uuid(value.catalogStoreKey)
    || !positive(value.catalogGeneration) || !key(value.sessionKey) || !key(value.branchKey) || !positive(value.eventCut)
    || !positive(value.indexGeneration) || !isScopedBodySourceRef(value.source)
    || (value.evidence !== "raw-source" && value.evidence !== "generated-cue")) return false;
  if (value.decodedUtf16 !== undefined && (!object(value.decodedUtf16) || !integer(value.decodedUtf16.start)
    || !integer(value.decodedUtf16.end) || value.decodedUtf16.start > value.decodedUtf16.end
    || value.decodedUtf16.start < value.source.decodedUtf16.start || value.decodedUtf16.end > value.source.decodedUtf16.end)) return false;
  return value.catalogStoreKey === value.source.catalogStoreKey && value.catalogGeneration === value.source.catalogGeneration
    && value.sessionKey === value.source.sessionKey && value.source.eventSeq <= value.eventCut;
}
export function isSearchV3Request(value: unknown): value is SearchV3Request {
  if (!bytesWithin(value, SEARCH_V3_LIMITS.requestBytes) || !object(value) || value.v !== 1 || !path(value.searchDirectory)
    || !path(value.capsuleDirectory) || !path(value.catalogDirectory) || value.searchDirectory === value.capsuleDirectory
    || value.searchDirectory === value.catalogDirectory || value.capsuleDirectory === value.catalogDirectory || !isSearchV3Identity(value.identity)) return false;
  const view = (candidate: unknown): candidate is SearchV3View => isCapsuleCatalogView(candidate) && identityMatchesView(value.identity as SearchV3Identity, candidate);
  switch (value.op) {
    case "status": return value.view === undefined || view(value.view);
    case "ingestPage": return view(value.view)
      && (value.maxSources === undefined || positive(value.maxSources) && value.maxSources <= SEARCH_V3_LIMITS.ingestSources)
      && (value.maxChunks === undefined || positive(value.maxChunks) && value.maxChunks <= SEARCH_V3_LIMITS.ingestChunks);
    case "query": return view(value.view) && typeof value.query === "string" && value.query.trim().length > 0 && value.query.length <= SEARCH_V3_LIMITS.queryUnits
      && (value.mode === undefined || ["ranked", "literal", "regex"].includes(String(value.mode))) && (value.caseSensitive === undefined || typeof value.caseSensitive === "boolean")
      && (value.filters === undefined || isFilters(value.filters))
      && (value.cursor === undefined || typeof value.cursor === "string" && value.cursor.length <= 4096)
      && (value.limit === undefined || positive(value.limit) && value.limit <= SEARCH_V3_LIMITS.page)
      && (value.scan === undefined || object(value.scan) && positive(value.scan.maxChunks) && value.scan.maxChunks <= SEARCH_V3_LIMITS.scanChunks
        && positive(value.scan.maxMs) && value.scan.maxMs <= SEARCH_V3_LIMITS.scanMs);
    case "recall": return view(value.view) && isSearchV3Handle(value.handle) && sourceRefWithinViewBounds(value.handle.source, value.view)
      && (value.decodedStart === undefined || integer(value.decodedStart))
      && (value.decodedLength === undefined || positive(value.decodedLength) && value.decodedLength <= SEARCH_V3_LIMITS.recallUnits);
    case "sources": return view(value.view) && positive(value.eventSeq) && value.eventSeq <= value.view.eventCut
      && (value.blockIndex === undefined || integer(value.blockIndex)) && (value.afterDescriptor === undefined || integer(value.afterDescriptor))
      && (value.limit === undefined || positive(value.limit) && value.limit <= SEARCH_V3_LIMITS.page);
    case "range": return view(value.view) && (value.cursor === undefined || typeof value.cursor === "string" && value.cursor.length <= 4096)
      && (value.limit === undefined || positive(value.limit) && value.limit <= SEARCH_V3_LIMITS.page);
    default: return false;
  }
}
