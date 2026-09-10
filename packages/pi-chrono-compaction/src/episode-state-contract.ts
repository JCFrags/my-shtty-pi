import {
  isCapsuleCatalogView,
  isScopedBodySourceRef,
  sourceRefWithinViewBounds,
  type CapsuleCatalogView,
  type ScopedBodySourceRef,
} from "./capsule-contract.js";
import { isSearchV3Identity, type SearchV3Identity, type SearchV3Response } from "./search-v3-contract.js";

/** Pure M07 protocol. Importing this module performs no I/O and loads no worker. */
export const EPISODE_STATE_PROTOCOL_VERSION = 1 as const;
export const EPISODE_STATE_SCHEMA_VERSION = 1 as const;
export const EPISODE_STATE_RULESET_VERSION = "episode-state-exact-v1" as const;
export const EPISODE_STATE_LIMITS = Object.freeze({
  requestBytes: 48 * 1024,
  responseBytes: 96 * 1024,
  sourceBytesPerJob: 8 * 1024 * 1024,
  nativeSqliteBytes: 64 * 1024 * 1024,
  materializeCapsules: 8,
  wholeBodyUtf16Units: 32_768,
  clauseUtf16Units: 1_024,
  recallUtf8Bytes: 8 * 1024,
  page: 12,
  queryUnits: 256,
});

export type EpisodeStateLevel = "episode" | "resource" | "state";
export type EpisodeStateKind = "restriction" | "goal" | "openwork" | "blocker" | "decision" | "approval"
  | "reportedimplementation" | "observedverification" | "deployment";
export type EpisodeStateAuthority = "user" | "verified-tool" | "assistant-report" | "ordinary-memory" | "verified-configured-source";
export type EpisodeStateConfidence = "verified" | "supported" | "qualified" | "advisory";

export interface EpisodeStateAfter {
  readonly eventSeq: number;
  readonly descriptor: number;
  readonly stableKey?: string;
  /** Pins reads so later append/supersession cannot leak into a continued page. */
  readonly generation?: number;
}

interface Base {
  readonly v: 1;
  readonly catalogDirectory: string;
  readonly capsuleDirectory: string;
  readonly searchDirectory: string;
  readonly identity: SearchV3Identity;
  readonly view: CapsuleCatalogView;
}
export type EpisodeStateRequest = Base & (
  | { readonly op: "materializeState"; readonly after?: EpisodeStateAfter; readonly limit?: number }
  | { readonly op: "stateStatus" }
  | { readonly op: "recallState"; readonly query?: string; readonly source?: ScopedBodySourceRef;
      readonly level?: EpisodeStateLevel; readonly limit?: number; readonly after?: EpisodeStateAfter }
);
export type EpisodeStateResponse = SearchV3Response;

const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const integer = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) >= 0;
const positive = (x: unknown): x is number => integer(x) && x > 0;
const path = (x: unknown): x is string => typeof x === "string" && x.startsWith("/") && x.length <= 4096 && !x.includes("\0") && !/[\ud800-\udfff]/u.test(x);
const byteSizeWithin = (x: unknown): boolean => { try { return Buffer.byteLength(JSON.stringify(x)) <= EPISODE_STATE_LIMITS.requestBytes; } catch { return false; } };
function identityMatchesView(identity: SearchV3Identity, view: CapsuleCatalogView): boolean {
  return identity.capsule.sessionKey === view.sessionKey && identity.capsule.catalogStoreKey === view.storeKey
    && identity.capsule.catalogGeneration === view.generation;
}
function after(value: unknown): value is EpisodeStateAfter {
  return object(value) && positive(value.eventSeq) && integer(value.descriptor)
    && (value.stableKey === undefined || typeof value.stableKey === "string" && value.stableKey.length <= 128)
    && (value.generation === undefined || positive(value.generation));
}

export function isEpisodeStateRequest(value: unknown): value is EpisodeStateRequest {
  if (!byteSizeWithin(value) || !object(value) || value.v !== 1 || !path(value.catalogDirectory) || !path(value.capsuleDirectory)
    || !path(value.searchDirectory) || value.catalogDirectory === value.capsuleDirectory || value.catalogDirectory === value.searchDirectory
    || value.capsuleDirectory === value.searchDirectory || !isSearchV3Identity(value.identity) || !isCapsuleCatalogView(value.view)
    || !identityMatchesView(value.identity, value.view)) return false;
  const common = (value.limit === undefined || positive(value.limit) && value.limit <= EPISODE_STATE_LIMITS.page)
    && (value.after === undefined || after(value.after));
  if (!common) return false;
  switch (value.op) {
    case "materializeState": return true;
    case "stateStatus": return value.limit === undefined && value.after === undefined;
    case "recallState": return (value.query === undefined || typeof value.query === "string" && value.query.trim().length > 0
        && value.query.length <= EPISODE_STATE_LIMITS.queryUnits)
      && (value.source === undefined || isScopedBodySourceRef(value.source) && sourceRefWithinViewBounds(value.source, value.view))
      && (value.level === undefined || value.level === "episode" || value.level === "resource" || value.level === "state");
    default: return false;
  }
}
