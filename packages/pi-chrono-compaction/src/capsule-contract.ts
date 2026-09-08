/**
 * Pure M05 protocol and persisted-value contract. Importing this module performs
 * no filesystem work, loads no SQLite binding, and starts no worker.
 */
export const CAPSULE_PROTOCOL_VERSION = 1 as const;
export const CAPSULE_SCHEMA_VERSION = 1 as const;
export const DERIVED_SCHEMA_VERSION = 1 as const;
export const CHUNK_SCHEMA_VERSION = 1 as const;
export const MANIFEST_SCHEMA_VERSION = 1 as const;
export const CAPSULE_TEXT_HASH = "chrono-utf16le-chain-sha256-v1" as const;
export const CHUNK_CONTENT_HASH = "sha256-utf16le-v1" as const;
export const SEGMENT_CONTENT_HASH = "sha256-bytes-v1" as const;

export const CAPSULE_LIMITS = Object.freeze({
  requestBytes: 64 * 1024,
  responseBytes: 256 * 1024,
  sourceBytesPerJob: 8 * 1024 * 1024,
  sourceReadBytes: 64 * 1024,
  nativeSqliteBytes: 64 * 1024 * 1024,
  decodedChunkUnits: 32_768,
  decodedChunkBytes: 65_536,
  deriveEvents: 64,
  deriveDescriptors: 256,
  page: 16,
  rangeChunks: 16,
  reducerInputUnits: 32_768,
  reducerAlternatives: 8,
  reducerOutputUnits: 64 * 1024,
  ancestry: 64,
  manifestSegments: 16,
  segmentBytes: 8 * 1024 * 1024,
  workerV8Bytes: 128 * 1024 * 1024,
  workerRssBytes: 256 * 1024 * 1024,
  workerDeadlineMs: 30_000,
});

export type Sha256 = string;
export type StoreUuid = string;
export type CatalogProvenance = "original" | "generated" | "mixed";
export type CapsuleLayer = "capsules" | "chunks";

/** One physical derived.sqlite identity. A new incompatible input gets a new store. */
export interface DerivedStoreIdentity {
  readonly storeKey: StoreUuid;
  readonly sessionKey: string;
  readonly catalogStoreKey: StoreUuid;
  readonly catalogGeneration: number;
  readonly derivedSchemaVersion: typeof DERIVED_SCHEMA_VERSION;
  readonly capsuleSchemaVersion: typeof CAPSULE_SCHEMA_VERSION;
  readonly chunkSchemaVersion: typeof CHUNK_SCHEMA_VERSION;
  readonly reducerSetVersion: string;
  readonly configHash: Sha256;
}

export interface CapsuleCatalogView {
  readonly storeKey: StoreUuid;
  readonly sessionKey: string;
  readonly generation: number;
  readonly eventCut: number;
  readonly branchKey: string;
  /** Ordered root-to-leaf ancestry. A segment occurs exactly once. */
  readonly segments: readonly { readonly segment: number; readonly cut: number }[];
}

export interface CoordinateRange {
  readonly start: number;
  readonly end: number;
}

/** entryId is optional metadata and is never sufficient identity. */
interface ScopedSourceBase {
  readonly catalogStoreKey: StoreUuid;
  readonly sessionKey: string;
  readonly catalogGeneration: number;
  readonly shardKey: string;
  readonly segment: number;
  readonly eventSeq: number;
  readonly ordinal: number;
  readonly descriptor: number;
  readonly blockIndex?: number;
  readonly field: string;
  /** Exact byte coordinates in the shard JSONL, end exclusive. */
  readonly raw: CoordinateRange;
  readonly entryId?: string;
}

/** A catalog JSON-string body, with UTF-16 coordinates and the M04 body hash. */
export interface ScopedBodySourceRef extends ScopedSourceBase {
  readonly coordinateKind: "decoded-body";
  readonly decodedUtf16: CoordinateRange;
  readonly bodyHashAlgorithm: typeof CAPSULE_TEXT_HASH;
  readonly bodyHash: Sha256;
}

/**
 * Exact non-body JSON bytes, for example tool-call arguments or a structural
 * field. They must not masquerade as decoded-body coordinates or a body hash.
 */
export interface ScopedRawSourceRef extends ScopedSourceBase {
  readonly coordinateKind: "raw-json";
  readonly rawHashAlgorithm: typeof SEGMENT_CONTENT_HASH;
  readonly rawHash: Sha256;
}
export type ScopedSourceRef = ScopedBodySourceRef | ScopedRawSourceRef;

export interface CapsuleBodyDescriptor {
  readonly v: 1;
  readonly source: ScopedBodySourceRef;
  /** Coordinates and hash cover the complete decoded body, including empty bodies. */
  readonly decodedUnits: number;
  readonly utf16leBytes: number;
  readonly chunkCount: number;
  readonly bodyHashAlgorithm: typeof CAPSULE_TEXT_HASH;
  readonly bodyHash: Sha256;
  readonly provenance: CatalogProvenance;
  readonly opaque: "none" | "image" | "data";
}

/** Immutable chunk payload bytes are exactly UTF-16LE, never normalized. */
export interface DecodedChunkDescriptor {
  readonly v: 1;
  readonly source: ScopedBodySourceRef;
  readonly chunkIndex: number;
  readonly decodedUtf16: CoordinateRange;
  readonly utf16leBytes: number;
  readonly contentHashAlgorithm: typeof CHUNK_CONTENT_HASH;
  readonly contentHash: Sha256;
  readonly segmentHash: Sha256;
  readonly segmentOffset: number;
}

/**
 * Private SQLite decoder checkpoint. It is not an IPC/log value. Hash pending
 * bytes and the unfinished chunk's exact UTF-16LE bytes are retained, so any
 * raw page or job boundary can resume without replay or unknown carry.
 */
export interface ChunkDecodeCursor {
  readonly v: 1;
  readonly source: ScopedBodySourceRef;
  readonly rawOffset: number;
  readonly decodedOffset: number;
  readonly opened: boolean;
  readonly jsonEscape: boolean;
  readonly pendingUnicodeEscape: { readonly value: number; readonly digits: number } | null;
  readonly pendingUtf8: { readonly value: number; readonly bytesLeft: number; readonly minimum: number } | null;
  readonly boundedHash: {
    readonly algorithm: typeof CAPSULE_TEXT_HASH;
    readonly chain: Sha256;
    readonly pendingBytes: readonly number[];
    readonly units: number;
  };
  /** Exact bytes, even length, strictly smaller than one complete chunk. */
  readonly chunkCarryUtf16le: Uint8Array;
  readonly complete: boolean;
}

export type SourceBlockKind =
  | "user" | "assistant-reasoning" | "assistant-text" | "tool-call"
  | "tool-result" | "bash-execution" | "branch-summary" | "custom-message"
  | "model-change" | "thinking-level-change" | "historical-compaction" | "metadata" | "unknown";

export interface SourceStructuralFacts {
  readonly role?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly exitCode?: number;
  readonly isError?: boolean;
  readonly cancelled?: boolean;
  readonly originallyTruncated?: boolean;
}

/** One bounded reducer input window. Giant bodies are never supplied whole. */
export interface SourceBlockReducerInput {
  readonly v: 1;
  readonly identity: DerivedStoreIdentity;
  /** Read-time authorization only; never part of source-local output identity. */
  readonly view: CapsuleCatalogView;
  readonly source: ScopedBodySourceRef;
  readonly kind: SourceBlockKind;
  readonly provenance: CatalogProvenance;
  readonly structural: SourceStructuralFacts;
  readonly window: {
    readonly decodedUtf16: CoordinateRange;
    readonly text: string;
    readonly completeBody: boolean;
    readonly omittedBeforeUnits: number;
    readonly omittedAfterUnits: number;
  };
}

export type SourceBlockReducerBaseInput = Omit<SourceBlockReducerInput, "window">;
export interface CapsuleReductionOptions {
  readonly family: SourceReducerFamily;
  readonly familyVersion: string;
  readonly reducerSetVersion: string;
  readonly configHash: Sha256;
  readonly budget: ReducerBudget;
}
export interface CapsuleReductionFeed {
  readonly decodedUtf16: CoordinateRange;
  readonly text: string;
}
/** Serializable bounded reducer state. Retained excerpts contain their actual selected bytes. */
export interface CapsuleReductionState {
  readonly v: 1;
  readonly base: SourceBlockReducerBaseInput;
  readonly options: CapsuleReductionOptions;
  readonly nextDecodedOffset: number;
  readonly head: readonly { readonly decodedUtf16: CoordinateRange; readonly text: string }[];
  readonly tail: readonly { readonly decodedUtf16: CoordinateRange; readonly text: string }[];
  readonly protectedCues: readonly ProtectedCue[];
  readonly omissions: readonly CapsuleOmission[];
  readonly complete: boolean;
}

export const SOURCE_REDUCER_FAMILIES = Object.freeze([
  "terminal", "test-output", "git-diff", "generic-text", "assistant-extractive",
  "assistant-cleanup", "lossless-normalizer", "small-json",
] as const);
export type SourceReducerFamily = typeof SOURCE_REDUCER_FAMILIES[number];

/** These decisions need request/cut context and cannot be persisted as source-local reducer output. */
export const ADAPTER_ONLY_DECISIONS = Object.freeze([
  "contextual-relevance", "file-read", "search-results", "llm-semantic",
  "repeat-factoring", "resource-lineage", "current-state", "cut-selection",
] as const);
export type AdapterOnlyDecision = typeof ADAPTER_ONLY_DECISIONS[number];

export interface ReducerBudget {
  readonly maxTokens: number;
  readonly maxUtf16Units: number;
  readonly maxAlternatives: number;
}

export type CapsuleOmission =
  | {
      readonly kind: "exact-range";
      readonly reason: "outside-window" | "middle" | "routine" | "opaque" | "budget" | "unsupported";
      readonly source: ScopedBodySourceRef;
      readonly decodedUtf16: CoordinateRange;
      readonly omittedUnits: number;
      readonly description: string;
    }
  | {
      /** Transformation loss is real but does not claim a fake exact removed range/count. */
      readonly kind: "transformation-loss";
      readonly reason: "repeated" | "normalization";
      readonly affectedSource: ScopedBodySourceRef;
      readonly affectedDecodedUtf16: CoordinateRange;
      readonly omittedUnits: "unknown";
      readonly description: string;
    };

export type ProtectedCueKind =
  | "condition" | "exception" | "negation" | "failure" | "unknown"
  | "cancelled" | "pending-approval" | "restriction" | "identifier";

/** Exact excerpt and coordinates, never a lossy authority statement. */
export interface ProtectedCue {
  readonly kind: ProtectedCueKind;
  readonly source: ScopedBodySourceRef;
  readonly decodedUtf16: CoordinateRange;
  readonly exactText: string;
}

export interface CapsuleFact {
  readonly kind: "structural" | "extractive";
  readonly name: string;
  readonly value: string | number | boolean | null;
  readonly source: ScopedSourceRef;
  readonly decodedUtf16?: CoordinateRange;
}

export type CapsuleOutcome =
  | { readonly status: "unknown" }
  | { readonly status: "supported"; readonly value: "success" | "failure" | "cancelled" | "pending-approval"; readonly facts: readonly number[] };

/** A generated, explicitly lossy chronological alternative; never semantic state. */
export interface CapsuleAlternative {
  readonly alternative: number;
  readonly family: SourceReducerFamily;
  readonly familyVersion: string;
  readonly maxTokens: number;
  readonly text: string;
  readonly lossy: true;
  readonly facts: readonly CapsuleFact[];
  readonly protectedCues: readonly ProtectedCue[];
  readonly omissions: readonly CapsuleOmission[];
  readonly outcome: CapsuleOutcome;
  readonly sourceRefs: readonly ScopedSourceRef[];
}

export interface PairedCallContext {
  readonly kind: "paired-call";
  readonly verifiedBy: "catalog-view-ancestry-v1";
  readonly call: ScopedSourceRef;
  readonly result: ScopedBodySourceRef;
}

export interface ReducerEnvelope {
  readonly v: 1;
  readonly capsuleSchemaVersion: typeof CAPSULE_SCHEMA_VERSION;
  readonly identity: DerivedStoreIdentity;
  /** Stable source-local identity. Pins, cuts and batch boundaries are absent. */
  readonly source: ScopedBodySourceRef;
  readonly family: SourceReducerFamily;
  readonly familyVersion: string;
  readonly reducerSetVersion: string;
  readonly configHash: Sha256;
  readonly budget: ReducerBudget;
  readonly inputHash: Sha256;
  readonly pair?: PairedCallContext;
  readonly alternatives: readonly CapsuleAlternative[];
}

export interface DeriveCursor {
  readonly v: 1;
  readonly identity: DerivedStoreIdentity;
  readonly view: CapsuleCatalogView;
  readonly afterEventSeq: number;
  readonly afterDescriptor: number;
  readonly bodyRawOffset: number;
  readonly bodyDecodedOffset: number;
  /** Private state is loaded by this hash; the large carry never crosses IPC. */
  readonly partialBody?: { readonly source: ScopedBodySourceRef; readonly stateHash: Sha256 };
}

export interface CapsuleSegmentDescriptor {
  readonly kind: "capsules";
  readonly schemaVersion: typeof CAPSULE_SCHEMA_VERSION;
  readonly hashAlgorithm: typeof SEGMENT_CONTENT_HASH;
  readonly hash: Sha256;
  readonly bytes: number;
  readonly records: number;
  readonly first: { readonly eventSeq: number; readonly descriptor: number };
  readonly last: { readonly eventSeq: number; readonly descriptor: number };
}

export interface ChunkSegmentDescriptor {
  readonly kind: "chunks";
  readonly schemaVersion: typeof CHUNK_SCHEMA_VERSION;
  readonly hashAlgorithm: typeof SEGMENT_CONTENT_HASH;
  readonly hash: Sha256;
  readonly bytes: number;
  readonly chunks: number;
  readonly first: { readonly eventSeq: number; readonly descriptor: number; readonly chunkIndex: number };
  readonly last: { readonly eventSeq: number; readonly descriptor: number; readonly chunkIndex: number };
}

/** Canonical content manifest. It contains no view, cursor, predecessor, job, or batch identity. */
export interface DerivedManifest {
  readonly v: 1;
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  readonly identity: DerivedStoreIdentity;
  readonly layer: CapsuleLayer;
  readonly segment: CapsuleSegmentDescriptor | ChunkSegmentDescriptor;
  readonly hashAlgorithm: typeof SEGMENT_CONTENT_HASH;
  readonly hash: Sha256;
}

/** Job-partition-dependent publication metadata; never a canonical content byte claim. */
export interface DerivedPublicationReceipt {
  readonly v: 1;
  readonly identity: DerivedStoreIdentity;
  readonly view: CapsuleCatalogView;
  readonly predecessorReceiptHash?: Sha256;
  readonly manifestHashes: readonly Sha256[];
  readonly cursor: DeriveCursor;
  readonly hashAlgorithm: typeof SEGMENT_CONTENT_HASH;
  readonly receiptHash: Sha256;
  readonly publication: "durable";
}

export type LayerReadinessState = "ready" | "partial" | "unsupported" | "failed" | "excluded";
export interface LayerReadiness {
  readonly layer: CapsuleLayer;
  readonly state: LayerReadinessState;
  readonly eligible: number;
  readonly ready: number;
  readonly unsupported: number;
  readonly failed: number;
  readonly excluded: number;
  readonly afterEventSeq: number;
  readonly afterDescriptor: number;
  readonly resumable: boolean;
  readonly marker?: string;
}

export interface CapsuleReadiness {
  readonly v: 1;
  readonly identity: DerivedStoreIdentity;
  readonly view: CapsuleCatalogView;
  /** Informational only. It neither raises nor lowers the two derived layers. */
  readonly catalog: "pinned" | "lagging" | "unavailable";
  readonly capsules: LayerReadiness;
  readonly chunks: LayerReadiness;
}

interface WorkerBase {
  readonly v: 1;
  readonly derivedDirectory: string;
  /** Explicit authoritative M04 logical route. Never infer a path from a UUID. */
  readonly catalogDirectory: string;
  readonly identity: DerivedStoreIdentity;
}
export type CapsuleWorkerRequest = WorkerBase & (
  | { readonly op: "status"; readonly view?: CapsuleCatalogView }
  | { readonly op: "derivePage"; readonly view: CapsuleCatalogView; readonly cursor?: DeriveCursor; readonly maxEvents?: number; readonly maxDescriptors?: number }
  | { readonly op: "capsulePage"; readonly view: CapsuleCatalogView; readonly afterEventSeq?: number; readonly afterDescriptor?: number; readonly limit?: number }
  | { readonly op: "chunkRange"; readonly view: CapsuleCatalogView; readonly source: ScopedSourceRef; readonly decodedStart: number; readonly decodedLength: number; readonly limit?: number }
);

export type CapsuleWorkerResponse =
  | { readonly v: 1; readonly ok: true; readonly result: Record<string, unknown>; readonly sourceBytes: number; readonly sqliteNativeLimitBytes: number }
  | { readonly v: 1; readonly ok: false; readonly code: string; readonly sourceBytes: number; readonly sqliteNativeLimitBytes: number; readonly resumable: boolean };

const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const integer = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) >= 0;
const positive = (x: unknown): x is number => integer(x) && Number(x) > 0;
const key = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(x);
const version = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/.test(x);
const uuid = (x: unknown): x is StoreUuid => typeof x === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
const hash = (x: unknown): x is Sha256 => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
const path = (x: unknown): x is string => typeof x === "string" && x.startsWith("/") && x.length <= 4096 && !x.includes("\0") && !/[\ud800-\udfff]/u.test(x);
const range = (x: unknown): x is CoordinateRange => object(x) && integer(x.start) && integer(x.end) && x.start <= x.end;
const boundedText = (x: unknown, units: number): x is string => typeof x === "string" && x.length <= units;
const enumValue = <T extends readonly string[]>(values: T, x: unknown): x is T[number] => typeof x === "string" && values.includes(x);
const byteSizeWithin = (value: unknown, limit: number): boolean => {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= limit; } catch { return false; }
};

export function isDerivedStoreIdentity(value: unknown): value is DerivedStoreIdentity {
  if (!object(value)) return false;
  return uuid(value.storeKey) && key(value.sessionKey) && uuid(value.catalogStoreKey) && positive(value.catalogGeneration)
    && value.derivedSchemaVersion === DERIVED_SCHEMA_VERSION && value.capsuleSchemaVersion === CAPSULE_SCHEMA_VERSION
    && value.chunkSchemaVersion === CHUNK_SCHEMA_VERSION && version(value.reducerSetVersion) && hash(value.configHash);
}

export function isCapsuleCatalogView(value: unknown): value is CapsuleCatalogView {
  if (!object(value) || !uuid(value.storeKey) || !key(value.sessionKey) || !positive(value.generation)
    || !positive(value.eventCut) || !key(value.branchKey) || !Array.isArray(value.segments)
    || value.segments.length < 1 || value.segments.length > CAPSULE_LIMITS.ancestry) return false;
  const seen = new Set<number>();
  for (const segment of value.segments) {
    if (!object(segment) || !positive(segment.segment) || !positive(segment.cut) || segment.cut > value.eventCut || seen.has(segment.segment)) return false;
    seen.add(segment.segment);
  }
  return true;
}

function identitiesMatch(identity: DerivedStoreIdentity, view: CapsuleCatalogView): boolean {
  return identity.sessionKey === view.sessionKey && identity.catalogStoreKey === view.storeKey && identity.catalogGeneration === view.generation;
}

export function isScopedSourceRef(value: unknown): value is ScopedSourceRef {
  if (!object(value) || !uuid(value.catalogStoreKey) || !key(value.sessionKey) || !positive(value.catalogGeneration)
    || !key(value.shardKey) || !positive(value.segment) || !positive(value.eventSeq) || !positive(value.ordinal)
    || !integer(value.descriptor) || (value.blockIndex !== undefined && !integer(value.blockIndex))
    || typeof value.field !== "string" || value.field.length < 1 || value.field.length > 64 || !range(value.raw)
    || (value.entryId !== undefined && (typeof value.entryId !== "string" || value.entryId.length > 1024))) return false;
  if (value.coordinateKind === "decoded-body") {
    return range(value.decodedUtf16) && value.bodyHashAlgorithm === CAPSULE_TEXT_HASH && hash(value.bodyHash);
  }
  return value.coordinateKind === "raw-json" && value.rawHashAlgorithm === SEGMENT_CONTENT_HASH && hash(value.rawHash);
}

export function isScopedBodySourceRef(value: unknown): value is ScopedBodySourceRef {
  return isScopedSourceRef(value) && value.coordinateKind === "decoded-body";
}

/** Structural bound check only. The worker must still select the ref through M04 CatalogView. */
export function sourceRefWithinViewBounds(source: ScopedSourceRef, view: CapsuleCatalogView): boolean {
  if (source.catalogStoreKey !== view.storeKey || source.sessionKey !== view.sessionKey || source.catalogGeneration !== view.generation || source.eventSeq > view.eventCut) return false;
  const segment = view.segments.find((candidate) => candidate.segment === source.segment);
  return segment !== undefined && source.eventSeq <= segment.cut;
}

function sameSource(a: ScopedSourceRef, b: ScopedSourceRef): boolean {
  if (a.coordinateKind !== b.coordinateKind) return false;
  const base = a.catalogStoreKey === b.catalogStoreKey && a.sessionKey === b.sessionKey && a.catalogGeneration === b.catalogGeneration
    && a.shardKey === b.shardKey && a.segment === b.segment && a.eventSeq === b.eventSeq && a.ordinal === b.ordinal
    && a.descriptor === b.descriptor && a.blockIndex === b.blockIndex && a.field === b.field
    && a.raw.start === b.raw.start && a.raw.end === b.raw.end;
  return base && (a.coordinateKind === "decoded-body"
    ? b.coordinateKind === "decoded-body" && a.decodedUtf16.start === b.decodedUtf16.start && a.decodedUtf16.end === b.decodedUtf16.end && a.bodyHash === b.bodyHash
    : b.coordinateKind === "raw-json" && a.rawHash === b.rawHash);
}
function sameEventScope(a: ScopedSourceRef, b: ScopedSourceRef): boolean {
  return a.catalogStoreKey === b.catalogStoreKey && a.sessionKey === b.sessionKey && a.catalogGeneration === b.catalogGeneration
    && a.shardKey === b.shardKey && a.segment === b.segment && a.eventSeq === b.eventSeq && a.ordinal === b.ordinal;
}

function position(source: ScopedSourceRef, view: CapsuleCatalogView): readonly [number, number, number] | undefined {
  const rank = view.segments.findIndex((candidate) => candidate.segment === source.segment);
  return rank < 0 ? undefined : [rank, source.eventSeq, source.descriptor];
}

function before(a: ScopedSourceRef, b: ScopedSourceRef, view: CapsuleCatalogView): boolean {
  const pa = position(a, view); const pb = position(b, view);
  if (!pa || !pb) return false;
  return pa[0] < pb[0] || (pa[0] === pb[0] && (pa[1] < pb[1] || (pa[1] === pb[1] && pa[2] < pb[2])));
}

export function isCapsuleBodyDescriptor(value: unknown): value is CapsuleBodyDescriptor {
  if (!object(value) || value.v !== 1 || !isScopedBodySourceRef(value.source) || !integer(value.decodedUnits)
    || value.utf16leBytes !== value.decodedUnits * 2 || !integer(value.chunkCount)
    || value.chunkCount !== Math.ceil(value.decodedUnits / CAPSULE_LIMITS.decodedChunkUnits)
    || value.bodyHashAlgorithm !== CAPSULE_TEXT_HASH || value.bodyHash !== value.source.bodyHash
    || value.decodedUnits !== value.source.decodedUtf16.end || !enumValue(["original", "generated", "mixed"] as const, value.provenance)
    || !enumValue(["none", "image", "data"] as const, value.opaque)) return false;
  return value.source.decodedUtf16.start === 0;
}

export function isDecodedChunkDescriptor(value: unknown): value is DecodedChunkDescriptor {
  if (!object(value) || value.v !== 1 || !isScopedBodySourceRef(value.source) || !integer(value.chunkIndex)
    || !range(value.decodedUtf16) || value.decodedUtf16.start !== value.chunkIndex * CAPSULE_LIMITS.decodedChunkUnits
    || value.decodedUtf16.end > value.source.decodedUtf16.end
    || value.decodedUtf16.end - value.decodedUtf16.start > CAPSULE_LIMITS.decodedChunkUnits
    || value.utf16leBytes !== (value.decodedUtf16.end - value.decodedUtf16.start) * 2
    || value.contentHashAlgorithm !== CHUNK_CONTENT_HASH || !hash(value.contentHash) || !hash(value.segmentHash) || !integer(value.segmentOffset)) return false;
  return value.decodedUtf16.end > value.decodedUtf16.start;
}

export function isChunkDecodeCursor(value: unknown): value is ChunkDecodeCursor {
  if (!object(value) || value.v !== 1 || !isScopedBodySourceRef(value.source) || !integer(value.rawOffset) || !integer(value.decodedOffset)
    || value.rawOffset < value.source.raw.start || value.rawOffset > value.source.raw.end
    || value.decodedOffset < value.source.decodedUtf16.start || value.decodedOffset > value.source.decodedUtf16.end
    || typeof value.opened !== "boolean" || typeof value.jsonEscape !== "boolean" || !object(value.boundedHash) || value.boundedHash.algorithm !== CAPSULE_TEXT_HASH
    || !hash(value.boundedHash.chain) || !Array.isArray(value.boundedHash.pendingBytes) || value.boundedHash.pendingBytes.length > 2046
    || value.boundedHash.pendingBytes.length % 2 !== 0 || !value.boundedHash.pendingBytes.every((byte) => integer(byte) && byte <= 255)
    || !integer(value.boundedHash.units) || value.boundedHash.units !== value.decodedOffset
    || value.boundedHash.pendingBytes.length !== (value.complete ? 0 : (value.boundedHash.units % 1024) * 2)
    || !(value.chunkCarryUtf16le instanceof Uint8Array) || value.chunkCarryUtf16le.byteLength >= CAPSULE_LIMITS.decodedChunkBytes
    || value.chunkCarryUtf16le.byteLength % 2 !== 0 || typeof value.complete !== "boolean"
    || value.chunkCarryUtf16le.byteLength / 2 !== (value.complete ? 0 : value.decodedOffset % CAPSULE_LIMITS.decodedChunkUnits)) return false;
  if (value.pendingUnicodeEscape !== null && (!object(value.pendingUnicodeEscape) || !integer(value.pendingUnicodeEscape.value)
    || !integer(value.pendingUnicodeEscape.digits) || value.pendingUnicodeEscape.digits > 3 || value.pendingUnicodeEscape.value > 0xffff)) return false;
  if (value.pendingUtf8 !== null && (!object(value.pendingUtf8) || !integer(value.pendingUtf8.value)
    || !integer(value.pendingUtf8.bytesLeft) || value.pendingUtf8.bytesLeft < 1 || value.pendingUtf8.bytesLeft > 3
    || !integer(value.pendingUtf8.minimum) || value.pendingUtf8.minimum > 0x10000)) return false;
  return !value.complete || (value.opened && value.rawOffset === value.source.raw.end && value.decodedOffset === value.source.decodedUtf16.end
    && !value.jsonEscape && value.pendingUnicodeEscape === null && value.pendingUtf8 === null && value.chunkCarryUtf16le.byteLength === 0);
}

export function isSourceBlockReducerInput(value: unknown): value is SourceBlockReducerInput {
  if (!object(value) || value.v !== 1 || !isDerivedStoreIdentity(value.identity) || !isCapsuleCatalogView(value.view)
    || !identitiesMatch(value.identity, value.view) || !isScopedBodySourceRef(value.source) || !sourceRefWithinViewBounds(value.source, value.view)
    || !enumValue(["user", "assistant-reasoning", "assistant-text", "tool-call", "tool-result", "bash-execution", "branch-summary", "custom-message", "model-change", "thinking-level-change", "historical-compaction", "metadata", "unknown"] as const, value.kind)
    || !enumValue(["original", "generated", "mixed"] as const, value.provenance) || !object(value.structural) || !object(value.window)
    || !range(value.window.decodedUtf16) || value.window.decodedUtf16.start < value.source.decodedUtf16.start
    || value.window.decodedUtf16.end > value.source.decodedUtf16.end || !boundedText(value.window.text, CAPSULE_LIMITS.reducerInputUnits)
    || value.window.text.length !== value.window.decodedUtf16.end - value.window.decodedUtf16.start
    || typeof value.window.completeBody !== "boolean" || !integer(value.window.omittedBeforeUnits) || !integer(value.window.omittedAfterUnits)
    || value.window.omittedBeforeUnits !== value.window.decodedUtf16.start - value.source.decodedUtf16.start
    || value.window.omittedAfterUnits !== value.source.decodedUtf16.end - value.window.decodedUtf16.end) return false;
  if (value.window.completeBody !== (value.window.omittedBeforeUnits === 0 && value.window.omittedAfterUnits === 0)) return false;
  if (value.window.completeBody && value.source.decodedUtf16.end - value.source.decodedUtf16.start > CAPSULE_LIMITS.reducerInputUnits) return false;
  const s = value.structural;
  return (s.role === undefined || boundedText(s.role, 64)) && (s.toolName === undefined || boundedText(s.toolName, 128))
    && (s.toolCallId === undefined || boundedText(s.toolCallId, 1024)) && (s.exitCode === undefined || Number.isSafeInteger(s.exitCode))
    && (s.isError === undefined || typeof s.isError === "boolean") && (s.cancelled === undefined || typeof s.cancelled === "boolean")
    && (s.originallyTruncated === undefined || typeof s.originallyTruncated === "boolean");
}

function sourceRangeWithin(child: CoordinateRange, source: ScopedBodySourceRef): boolean {
  return child.start >= source.decodedUtf16.start && child.end <= source.decodedUtf16.end;
}

function isFact(value: unknown, capsuleSource: ScopedBodySourceRef): value is CapsuleFact {
  if (!object(value) || !enumValue(["structural", "extractive"] as const, value.kind) || typeof value.name !== "string" || value.name.length < 1 || value.name.length > 64
    || (!["string", "number", "boolean"].includes(typeof value.value) && value.value !== null)
    || !isScopedSourceRef(value.source) || !sameEventScope(value.source, capsuleSource)) return false;
  if (value.kind === "structural") return value.decodedUtf16 === undefined;
  return isScopedBodySourceRef(value.source) && range(value.decodedUtf16) && sourceRangeWithin(value.decodedUtf16, value.source);
}
function isCue(value: unknown, source: ScopedBodySourceRef): value is ProtectedCue {
  return object(value) && enumValue(["condition", "exception", "negation", "failure", "unknown", "cancelled", "pending-approval", "restriction", "identifier"] as const, value.kind)
    && isScopedBodySourceRef(value.source) && sameSource(value.source, source) && range(value.decodedUtf16)
    && sourceRangeWithin(value.decodedUtf16, source) && boundedText(value.exactText, 8192)
    && value.exactText.length === value.decodedUtf16.end - value.decodedUtf16.start;
}
function isOmission(value: unknown, source: ScopedBodySourceRef): value is CapsuleOmission {
  if (!object(value) || !boundedText(value.description, 512)) return false;
  if (value.kind === "exact-range") {
    return enumValue(["outside-window", "middle", "routine", "opaque", "budget", "unsupported"] as const, value.reason)
      && isScopedBodySourceRef(value.source) && sameSource(value.source, source) && range(value.decodedUtf16)
      && sourceRangeWithin(value.decodedUtf16, source) && positive(value.omittedUnits)
      && value.omittedUnits === value.decodedUtf16.end - value.decodedUtf16.start;
  }
  return value.kind === "transformation-loss" && enumValue(["repeated", "normalization"] as const, value.reason)
    && isScopedBodySourceRef(value.affectedSource) && sameSource(value.affectedSource, source)
    && range(value.affectedDecodedUtf16) && sourceRangeWithin(value.affectedDecodedUtf16, source)
    && value.omittedUnits === "unknown";
}

export function isReducerEnvelope(value: unknown): value is ReducerEnvelope {
  if (!object(value) || value.v !== 1 || value.capsuleSchemaVersion !== CAPSULE_SCHEMA_VERSION
    || !isDerivedStoreIdentity(value.identity) || !isScopedBodySourceRef(value.source)
    || value.source.catalogStoreKey !== value.identity.catalogStoreKey || value.source.sessionKey !== value.identity.sessionKey
    || value.source.catalogGeneration !== value.identity.catalogGeneration || !enumValue(SOURCE_REDUCER_FAMILIES, value.family)
    || !version(value.familyVersion) || value.reducerSetVersion !== value.identity.reducerSetVersion || value.configHash !== value.identity.configHash
    || !object(value.budget) || !positive(value.budget.maxTokens) || !positive(value.budget.maxUtf16Units)
    || value.budget.maxUtf16Units > CAPSULE_LIMITS.reducerOutputUnits || !positive(value.budget.maxAlternatives)
    || value.budget.maxAlternatives > CAPSULE_LIMITS.reducerAlternatives || !hash(value.inputHash)
    || !Array.isArray(value.alternatives) || value.alternatives.length < 1 || value.alternatives.length > value.budget.maxAlternatives) return false;
  const source = value.source;
  const budget = value.budget;
  if (value.pair !== undefined) {
    const pair = value.pair;
    if (!object(pair) || pair.kind !== "paired-call" || pair.verifiedBy !== "catalog-view-ancestry-v1"
      || !isScopedSourceRef(pair.call) || !isScopedBodySourceRef(pair.result) || !sameSource(pair.result, source)
      || pair.call.catalogStoreKey !== source.catalogStoreKey || pair.call.sessionKey !== source.sessionKey
      || pair.call.catalogGeneration !== source.catalogGeneration
      || !(pair.call.eventSeq < pair.result.eventSeq || pair.call.eventSeq === pair.result.eventSeq && pair.call.descriptor < pair.result.descriptor)) return false;
  }
  const pairedCall = value.pair !== undefined && object(value.pair) && isScopedSourceRef(value.pair.call) ? value.pair.call : undefined;
  const alternatives = value.alternatives as unknown[];
  for (let index = 0; index < alternatives.length; index += 1) {
    const item = alternatives[index];
    if (!object(item) || item.alternative !== index || item.family !== value.family || item.familyVersion !== value.familyVersion
      || item.maxTokens !== budget.maxTokens || item.lossy !== true || !boundedText(item.text, budget.maxUtf16Units as number)
      || !Array.isArray(item.facts) || !item.facts.every((fact) => isFact(fact, source))
      || !Array.isArray(item.protectedCues) || !item.protectedCues.every((cue) => isCue(cue, source))
      || !Array.isArray(item.omissions) || !item.omissions.every((omission) => isOmission(omission, source))
      || !Array.isArray(item.sourceRefs) || item.sourceRefs.length < 1
      || !item.sourceRefs.every((candidate) => isScopedSourceRef(candidate) && (sameEventScope(candidate, source)
        || pairedCall !== undefined && sameSource(candidate, pairedCall)))
      || !item.sourceRefs.some((candidate) => isScopedSourceRef(candidate) && sameSource(candidate, source)) || !object(item.outcome)) return false;
    const facts = item.facts as unknown[];
    if (item.outcome.status === "unknown") {
      if (Object.keys(item.outcome).length !== 1) return false;
    } else if (item.outcome.status === "supported") {
      if (!enumValue(["success", "failure", "cancelled", "pending-approval"] as const, item.outcome.value)
        || !Array.isArray(item.outcome.facts) || item.outcome.facts.length < 1
        || !(item.outcome.facts as unknown[]).every((factIndex) => typeof factIndex === "number" && integer(factIndex) && factIndex < facts.length)) return false;
    } else return false;
  }
  return byteSizeWithin(value, CAPSULE_LIMITS.responseBytes);
}

export function isDeriveCursor(value: unknown): value is DeriveCursor {
  if (!object(value) || value.v !== 1 || !isDerivedStoreIdentity(value.identity) || !isCapsuleCatalogView(value.view)
    || !identitiesMatch(value.identity, value.view) || !integer(value.afterEventSeq) || value.afterEventSeq > value.view.eventCut
    || !integer(value.afterDescriptor) || !integer(value.bodyRawOffset) || !integer(value.bodyDecodedOffset)) return false;
  if (value.afterEventSeq === 0 && value.afterDescriptor !== 0) return false;
  if (value.partialBody !== undefined) {
    if (!object(value.partialBody) || !isScopedBodySourceRef(value.partialBody.source) || !hash(value.partialBody.stateHash)
      || !sourceRefWithinViewBounds(value.partialBody.source, value.view) || value.afterEventSeq !== value.partialBody.source.eventSeq
      || value.afterDescriptor !== value.partialBody.source.descriptor || value.bodyRawOffset < value.partialBody.source.raw.start
      || value.bodyRawOffset > value.partialBody.source.raw.end || value.bodyDecodedOffset < value.partialBody.source.decodedUtf16.start
      || value.bodyDecodedOffset > value.partialBody.source.decodedUtf16.end) return false;
  } else if (value.bodyRawOffset !== 0 || value.bodyDecodedOffset !== 0) return false;
  return true;
}

function order3(a: { eventSeq: number; descriptor: number; chunkIndex?: number }, b: { eventSeq: number; descriptor: number; chunkIndex?: number }): boolean {
  return a.eventSeq < b.eventSeq || (a.eventSeq === b.eventSeq && (a.descriptor < b.descriptor
    || (a.descriptor === b.descriptor && (a.chunkIndex ?? 0) <= (b.chunkIndex ?? 0))));
}
function isCapsuleSegment(value: unknown): value is CapsuleSegmentDescriptor {
  return object(value) && value.kind === "capsules" && value.schemaVersion === CAPSULE_SCHEMA_VERSION && value.hashAlgorithm === SEGMENT_CONTENT_HASH
    && hash(value.hash) && positive(value.bytes) && value.bytes <= CAPSULE_LIMITS.segmentBytes && positive(value.records) && object(value.first) && object(value.last)
    && positive(value.first.eventSeq) && integer(value.first.descriptor) && positive(value.last.eventSeq) && integer(value.last.descriptor)
    && order3(value.first as any, value.last as any);
}
function isChunkSegment(value: unknown): value is ChunkSegmentDescriptor {
  return object(value) && value.kind === "chunks" && value.schemaVersion === CHUNK_SCHEMA_VERSION && value.hashAlgorithm === SEGMENT_CONTENT_HASH
    && hash(value.hash) && positive(value.bytes) && value.bytes <= CAPSULE_LIMITS.segmentBytes && positive(value.chunks) && object(value.first) && object(value.last)
    && positive(value.first.eventSeq) && integer(value.first.descriptor) && integer(value.first.chunkIndex)
    && positive(value.last.eventSeq) && integer(value.last.descriptor) && integer(value.last.chunkIndex)
    && order3(value.first as any, value.last as any);
}

export function isDerivedManifest(value: unknown): value is DerivedManifest {
  if (!object(value) || value.v !== 1 || value.schemaVersion !== MANIFEST_SCHEMA_VERSION || !isDerivedStoreIdentity(value.identity)
    || !enumValue(["capsules", "chunks"] as const, value.layer) || value.hashAlgorithm !== SEGMENT_CONTENT_HASH || !hash(value.hash)) return false;
  return value.layer === "capsules" ? isCapsuleSegment(value.segment) : isChunkSegment(value.segment);
}

export function isDerivedPublicationReceipt(value: unknown): value is DerivedPublicationReceipt {
  if (!object(value) || value.v !== 1 || !isDerivedStoreIdentity(value.identity) || !isCapsuleCatalogView(value.view)
    || !identitiesMatch(value.identity, value.view) || (value.predecessorReceiptHash !== undefined && !hash(value.predecessorReceiptHash))
    || !Array.isArray(value.manifestHashes) || value.manifestHashes.length < 1 || value.manifestHashes.length > CAPSULE_LIMITS.manifestSegments
    || !value.manifestHashes.every(hash) || !isDeriveCursor(value.cursor) || value.hashAlgorithm !== SEGMENT_CONTENT_HASH
    || !hash(value.receiptHash) || value.publication !== "durable") return false;
  return value.cursor.identity.storeKey === value.identity.storeKey && value.cursor.view.eventCut === value.view.eventCut
    && value.cursor.view.branchKey === value.view.branchKey;
}

function isLayerReadiness(value: unknown, layer: CapsuleLayer, cut: number): value is LayerReadiness {
  if (!object(value) || value.layer !== layer || !enumValue(["ready", "partial", "unsupported", "failed", "excluded"] as const, value.state)
    || !integer(value.eligible) || !integer(value.ready) || !integer(value.unsupported) || !integer(value.failed) || !integer(value.excluded)
    || value.ready + value.unsupported + value.failed > value.eligible
    || !integer(value.afterEventSeq) || value.afterEventSeq > cut || !integer(value.afterDescriptor) || typeof value.resumable !== "boolean"
    || (value.marker !== undefined && !boundedText(value.marker, 256))) return false;
  if (value.state === "ready" && (value.ready !== value.eligible || value.unsupported !== 0 || value.failed !== 0)) return false;
  if (value.state === "unsupported" && value.unsupported < 1) return false;
  if (value.state === "failed" && value.failed < 1) return false;
  if (value.state === "excluded" && value.excluded < 1) return false;
  return true;
}

export function isCapsuleReadiness(value: unknown): value is CapsuleReadiness {
  return object(value) && value.v === 1 && isDerivedStoreIdentity(value.identity) && isCapsuleCatalogView(value.view)
    && identitiesMatch(value.identity, value.view) && enumValue(["pinned", "lagging", "unavailable"] as const, value.catalog)
    && isLayerReadiness(value.capsules, "capsules", value.view.eventCut) && isLayerReadiness(value.chunks, "chunks", value.view.eventCut);
}

function viewExtendsCursor(view: CapsuleCatalogView, cursor: DeriveCursor): boolean {
  if (view.branchKey !== cursor.view.branchKey || view.eventCut < cursor.view.eventCut || view.segments.length < cursor.view.segments.length) return false;
  return cursor.view.segments.every((old, index) => {
    const current = view.segments[index];
    return current !== undefined && current.segment === old.segment && current.cut >= old.cut;
  });
}

export function isCapsuleWorkerRequest(value: unknown): value is CapsuleWorkerRequest {
  if (!byteSizeWithin(value, CAPSULE_LIMITS.requestBytes) || !object(value) || value.v !== 1 || !path(value.derivedDirectory)
    || !path(value.catalogDirectory) || value.catalogDirectory === value.derivedDirectory || !isDerivedStoreIdentity(value.identity)) return false;
  const identity = value.identity;
  const matches = (candidate: unknown): candidate is CapsuleCatalogView => isCapsuleCatalogView(candidate) && identitiesMatch(identity, candidate);
  switch (value.op) {
    case "status": return value.view === undefined || matches(value.view);
    case "derivePage": return matches(value.view) && (value.cursor === undefined || isDeriveCursor(value.cursor)
      && value.cursor.identity.storeKey === identity.storeKey && viewExtendsCursor(value.view, value.cursor))
      && (value.maxEvents === undefined || positive(value.maxEvents) && value.maxEvents <= CAPSULE_LIMITS.deriveEvents)
      && (value.maxDescriptors === undefined || positive(value.maxDescriptors) && value.maxDescriptors <= CAPSULE_LIMITS.deriveDescriptors);
    case "capsulePage": return matches(value.view) && (value.afterEventSeq === undefined || integer(value.afterEventSeq) && value.afterEventSeq <= value.view.eventCut)
      && (value.afterDescriptor === undefined || integer(value.afterDescriptor)) && (value.limit === undefined || positive(value.limit) && value.limit <= CAPSULE_LIMITS.page);
    case "chunkRange": return matches(value.view) && isScopedBodySourceRef(value.source) && sourceRefWithinViewBounds(value.source, value.view)
      && integer(value.decodedStart) && positive(value.decodedLength) && value.decodedLength <= CAPSULE_LIMITS.decodedChunkUnits
      && value.decodedStart >= value.source.decodedUtf16.start && value.decodedStart + value.decodedLength <= value.source.decodedUtf16.end
      && (value.limit === undefined || positive(value.limit) && value.limit <= CAPSULE_LIMITS.rangeChunks);
    default: return false;
  }
}
