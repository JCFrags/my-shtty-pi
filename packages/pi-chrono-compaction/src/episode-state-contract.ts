import {
  isCapsuleCatalogView,
  isScopedBodySourceRef,
  sourceRefWithinViewBounds,
  type CapsuleCatalogView,
  type ScopedBodySourceRef,
  type ScopedRawSourceRef,
} from "./capsule-contract.js";
import { isSearchV3Identity, type SearchV3Identity, type SearchV3Response } from "./search-v3-contract.js";

/** Pure M07 protocol. Importing this module performs no I/O and loads no worker. */
export const EPISODE_STATE_PROTOCOL_VERSION = 1 as const;
export const EPISODE_STATE_SCHEMA_VERSION = 4 as const;
export const EPISODE_STATE_RULESET_VERSION = "episode-state-exact-v4" as const;
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
  rollupFanout: 8,
  rollupLeafMembers: 8,
  rollupLeavesPerJob: 8,
  rollupProtectedPerNode: 32,
  rollupMetadataPerNode: 16,
  rollupNodeUtf8Bytes: 64 * 1024,
  rollupNodesPerRecall: 24,
  rollupNodesPerJob: 64,
  rollupTreeLevels: 32,
  composeProtected: 24,
  composeRestrictions: 16,
  composeOpenWork: 8,
  composeScanPage: 32,
  composeScanPages: 8,
  composeScannedPerCategory: 256,
  largeBodyOverlapUnits: 8 * 1024,
  contextSideUnits: 8 * 1024,
  composeState: 12,
  composeRecentMembers: 12,
  composeUtf8Bytes: 80 * 1024,
});

export type EpisodeStateLevel = "episode" | "resource" | "state";
export type EpisodeRollupRecallLevel = "root" | "child" | "episode" | "source";
export type EpisodeStateKind = "restriction" | "goal" | "openwork" | "blocker" | "decision" | "approval"
  | "reportedimplementation" | "observedverification" | "deployment" | "memory" | "retentionhint";
export type EpisodeStateAuthority = "user" | "verified-tool" | "assistant-report" | "ordinary-memory" | "verified-configured-source";
export type EpisodeStateConfidence = "verified" | "supported" | "qualified" | "advisory";

export interface EpisodeStateAfter {
  readonly eventSeq: number;
  readonly descriptor: number;
  readonly stableKey?: string;
  /** Pins reads so later append/supersession cannot leak into a continued page. */
  readonly generation?: number;
}

export interface EpisodeRollupAfter {
  readonly nodeId: string;
  readonly itemIndex: number;
  readonly generation: number;
  readonly level: EpisodeRollupRecallLevel;
  readonly queryHash: string;
}

export interface EpisodeStateSelectionProposition {
  /** Opaque hash of the one shared exact context representation. */
  readonly representationKey: string;
  readonly stableKey: string;
  readonly propositionKey: string;
  readonly spanKey: string;
  readonly subject: string;
  readonly revision: string;
  readonly kind: EpisodeStateKind;
  readonly authority: EpisodeStateAuthority;
  readonly confidence: EpisodeStateConfidence;
  readonly status: "current" | "unresolved";
  readonly effectiveAtCut: number;
  readonly evidence: unknown;
}

export interface EpisodeStateSelectionItem {
  readonly stableKey: string;
  readonly propositionKey: string;
  readonly spanKey: string;
  readonly subject: string;
  readonly revision: string;
  readonly kind: EpisodeStateKind;
  readonly authority: EpisodeStateAuthority;
  readonly confidence: EpisodeStateConfidence;
  readonly status: "current" | "unresolved";
  readonly effectiveAtCut: number;
  readonly evidence: unknown;
  /** Opaque hash shared by the primary context and its exact proposition clauses. */
  readonly representationKey?: string;
  /** Exact propositions consolidated only when one verified representation covers them. */
  readonly coveredPropositions?: readonly EpisodeStateSelectionProposition[];
}

export interface EpisodeStateSelectionMember {
  readonly episodeKey: string;
  readonly eventSeq: number;
  readonly descriptor: number;
  readonly sourceKey: string;
  readonly source: ScopedBodySourceRef | ScopedRawSourceRef;
  readonly cue: string;
  readonly episode: {
    readonly start: { readonly eventSeq: number; readonly descriptor: number };
    readonly end: { readonly eventSeq: number; readonly descriptor: number };
    readonly open: boolean;
    readonly objective: string;
    readonly objectiveEvidence: unknown;
  };
}

export interface EpisodeRollupCompositionItem {
  readonly nodeId: string;
  readonly nodeType: "episode-fragment" | "rollup";
  readonly path: readonly string[];
  readonly range: {
    readonly start: { readonly eventSeq: number; readonly descriptor: number };
    readonly end: { readonly eventSeq: number; readonly descriptor: number };
  };
  readonly summary: readonly string[];
  /** Adapter-encoded route for bounded child/source expansion and exact recovery. */
  readonly recovery: string;
}

export interface EpisodeRollupCompositionSelection {
  readonly handle: EpisodeRollupHandle;
  readonly representedStartSeq: number;
  readonly representedEndSeq: number;
  readonly publicationComplete: boolean;
  readonly selectionPartial: boolean;
  readonly partialReasons: readonly string[];
  readonly items: readonly EpisodeRollupCompositionItem[];
}

/** One bounded read-only M09 snapshot. Omission flags mean at least one more record exists. */
export interface EpisodeStateSelection {
  readonly stateGeneration: number;
  readonly branchKey: string;
  readonly sourceView: CapsuleCatalogView;
  readonly requestedCut: number;
  readonly processedCut: number;
  readonly processedMemoryCut: number;
  readonly complete: boolean;
  readonly partial: boolean;
  readonly coverage: {
    readonly bodyComplete: boolean;
    readonly metadataComplete: boolean;
    readonly partialMemory: boolean;
    readonly qualifiedReducers: boolean;
    /** Syntactic/source coverage only, never a semantic completeness claim. */
    readonly restrictionsComplete?: boolean;
    readonly openWorkComplete?: boolean;
    /** False when the bounded indexed category scan stopped before exhaustion. */
    readonly restrictionsScanComplete?: boolean;
    readonly openWorkScanComplete?: boolean;
  };
  readonly protected: readonly EpisodeStateSelectionItem[];
  readonly current: readonly EpisodeStateSelectionItem[];
  readonly recent: readonly EpisodeStateSelectionMember[];
  readonly older?: readonly EpisodeStateSelectionMember[];
  readonly rollups?: EpisodeRollupCompositionSelection;
  readonly delta?: {
    readonly verified: boolean;
    readonly throughCut: number;
    readonly reason: string;
    readonly protected: readonly EpisodeStateSelectionItem[];
    readonly current: readonly EpisodeStateSelectionItem[];
    readonly recent: readonly EpisodeStateSelectionMember[];
  };
  readonly omissions: {
    readonly protectedAtLeastOne: boolean;
    readonly openWorkAtLeastOne?: boolean;
    readonly currentAtLeastOne: boolean;
    readonly recentAtLeastOne: boolean;
    readonly responseBudgetAtLeastOne: boolean;
    /** Selection work stopped at an explicit indexed scan or representation bound. */
    readonly restrictionWorkExhausted?: boolean;
    readonly openWorkExhausted?: boolean;
    /** Selected evidence existed but could not fit the serialized response. */
    readonly renderedOverflowAtLeastOne?: boolean;
  };
  readonly metrics: {
    readonly sqliteStatements: number;
    readonly mandatoryRowsScanned?: number;
    readonly mandatoryRowsScanLimit?: number;
    readonly mandatoryScanPageLimit?: number;
    readonly outputUtf8ByteLimit?: number;
  };
}

export interface EpisodeRollupHandle {
  readonly schemaVersion: 1;
  /** Absent handles remain bound to the immutable legacy rollup-v3.sqlite store. */
  readonly storeId?: string;
  readonly ruleset: "episode-rollup-exact-v3";
  readonly branchKey: string;
  /** Common body-plus-metadata cut represented by this immutable publication. */
  readonly eventCut: number;
  readonly stateGeneration: number;
  readonly rollupGeneration: number;
  readonly rootNodeId: string;
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
  | { readonly op: "composeStateSelection" }
  | { readonly op: "recallState"; readonly query?: string; readonly source?: ScopedBodySourceRef;
      readonly level?: EpisodeStateLevel; readonly limit?: number; readonly after?: EpisodeStateAfter }
  | { readonly op: "materializeRollup"; readonly limit?: number }
  | { readonly op: "rollupStatus" }
  | { readonly op: "repairRollup"; readonly action: "start" | "step" | "status" | "publish";
      readonly repairId: string; readonly limit?: number; readonly expectedActiveStoreId?: string | null }
  | { readonly op: "composeRollupSelection"; readonly query: string; readonly beforeEventSeq: number;
      readonly limit?: number; readonly handle: EpisodeRollupHandle }
  | { readonly op: "recallRollup"; readonly query?: string; readonly nodeId?: string; readonly path?: readonly string[];
      readonly level?: EpisodeRollupRecallLevel; readonly limit?: number; readonly generation?: number;
      readonly after?: EpisodeRollupAfter; readonly handle?: EpisodeRollupHandle }
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
function rollupAfter(value: unknown): value is EpisodeRollupAfter {
  return object(value) && typeof value.nodeId === "string" && /^[a-f0-9]{64}$/u.test(value.nodeId)
    && integer(value.itemIndex) && value.itemIndex <= EPISODE_STATE_LIMITS.rollupNodesPerRecall && positive(value.generation)
    && (value.level === "root" || value.level === "child" || value.level === "episode" || value.level === "source")
    && typeof value.queryHash === "string" && /^[a-f0-9]{64}$/u.test(value.queryHash);
}
function rollupHandle(value: unknown): value is EpisodeRollupHandle {
  return object(value) && value.schemaVersion === 1 && value.ruleset === "episode-rollup-exact-v3"
    && (value.storeId === undefined || typeof value.storeId === "string" && /^[a-f0-9]{64}$/u.test(value.storeId))
    && typeof value.branchKey === "string" && value.branchKey.length > 0 && value.branchKey.length <= 256
    && integer(value.eventCut) && positive(value.stateGeneration) && positive(value.rollupGeneration)
    && typeof value.rootNodeId === "string" && /^[a-f0-9]{64}$/u.test(value.rootNodeId);
}

export function isEpisodeStateRequest(value: unknown): value is EpisodeStateRequest {
  if (!byteSizeWithin(value) || !object(value) || value.v !== 1 || !path(value.catalogDirectory) || !path(value.capsuleDirectory)
    || !path(value.searchDirectory) || value.catalogDirectory === value.capsuleDirectory || value.catalogDirectory === value.searchDirectory
    || value.capsuleDirectory === value.searchDirectory || !isSearchV3Identity(value.identity) || !isCapsuleCatalogView(value.view)
    || !identityMatchesView(value.identity, value.view)) return false;
  const stateCommon = (value.limit === undefined || positive(value.limit) && value.limit <= EPISODE_STATE_LIMITS.page)
    && (value.after === undefined || after(value.after));
  switch (value.op) {
    case "materializeState": return stateCommon;
    case "stateStatus": return value.limit === undefined && value.after === undefined;
    case "composeStateSelection": return value.limit === undefined && value.after === undefined;
    case "recallState": return stateCommon && (value.query === undefined || typeof value.query === "string" && value.query.trim().length > 0
        && value.query.length <= EPISODE_STATE_LIMITS.queryUnits)
      && (value.source === undefined || isScopedBodySourceRef(value.source) && sourceRefWithinViewBounds(value.source, value.view))
      && (value.level === undefined || value.level === "episode" || value.level === "resource" || value.level === "state");
    case "materializeRollup": return value.after === undefined
      && (value.limit === undefined || positive(value.limit) && value.limit <= EPISODE_STATE_LIMITS.rollupLeavesPerJob);
    case "rollupStatus": return value.limit === undefined && value.after === undefined;
    case "repairRollup": return typeof value.repairId === "string" && /^[A-Za-z0-9_.:-]{1,64}$/u.test(value.repairId)
      && (value.action === "step" ? value.limit === undefined || positive(value.limit) && value.limit <= EPISODE_STATE_LIMITS.rollupLeavesPerJob : value.limit === undefined)
      && (value.action === "publish" ? value.expectedActiveStoreId === null || typeof value.expectedActiveStoreId === "string" && /^[a-f0-9]{64}$/u.test(value.expectedActiveStoreId) : value.expectedActiveStoreId === undefined);
    case "composeRollupSelection": return rollupHandle(value.handle) && value.handle.branchKey === value.view.branchKey
      && value.handle.eventCut <= value.view.eventCut && typeof value.query === "string" && value.query.trim().length > 0
      && value.query.length <= EPISODE_STATE_LIMITS.queryUnits && positive(value.beforeEventSeq)
      && value.beforeEventSeq <= value.view.eventCut + 1
      && (value.limit === undefined || positive(value.limit) && value.limit <= EPISODE_STATE_LIMITS.page);
    case "recallRollup": return (positive(value.generation) || rollupHandle(value.handle))
      && (value.limit === undefined || positive(value.limit) && value.limit <= EPISODE_STATE_LIMITS.page)
      && (value.query === undefined || typeof value.query === "string" && value.query.trim().length > 0 && value.query.length <= EPISODE_STATE_LIMITS.queryUnits)
      && (value.nodeId === undefined || typeof value.nodeId === "string" && /^[a-f0-9]{64}$/u.test(value.nodeId))
      && (value.path === undefined || Array.isArray(value.path) && value.path.length <= EPISODE_STATE_LIMITS.rollupTreeLevels
        && value.path.every(item => typeof item === "string" && /^[a-f0-9]{64}$/u.test(item)))
      && (value.level === undefined || value.level === "root" || value.level === "child" || value.level === "episode" || value.level === "source")
      && (value.generation === undefined || positive(value.generation)) && (value.after === undefined || rollupAfter(value.after))
      && (value.handle === undefined || rollupHandle(value.handle) && value.handle.branchKey === value.view.branchKey && value.handle.eventCut <= value.view.eventCut)
      && (value.generation === undefined || value.handle === undefined || value.generation === value.handle.rollupGeneration)
      && (value.after === undefined || value.generation === undefined || value.after.generation === value.generation);
    default: return false;
  }
}
