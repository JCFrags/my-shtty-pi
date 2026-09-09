import { createHash } from "node:crypto";
import {
  CAPSULE_LIMITS,
  CAPSULE_TEXT_HASH,
  CHUNK_CONTENT_HASH,
  type CapsuleCatalogView,
  type CatalogProvenance,
  type ChunkDecodeCursor,
  type DecodedChunkDescriptor,
  type DerivedStoreIdentity,
  type ScopedBodySourceRef,
  type SourceBlockKind,
  type SourceStructuralFacts,
} from "./capsule-contract.js";
import { catalogHashUnit, createCatalogHash, finishCatalogHash, type CatalogHashState } from "./catalog-parser-hash.js";
import { createQuotedJsonStringState, decodeQuotedJsonStringChunk, type QuotedJsonStringState } from "./json-string-decoder.js";

const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** JSON-safe private representation. Carry bytes never cross worker IPC. */
export interface StoredBodyDecodeState {
  v: 1;
  source: ScopedBodySourceRef;
  rawOffset: number;
  decoder: QuotedJsonStringState;
  boundedHash: CatalogHashState;
  chunkCarryBase64: string;
  nextChunkIndex: number;
  complete: boolean;
  bodyHash?: string;
  reducerState?: unknown;
}

export interface DerivedChunk {
  readonly descriptor: Omit<DecodedChunkDescriptor, "segmentHash" | "segmentOffset">;
  readonly payload: Buffer;
}

export function beginBodyDecode(source: ScopedBodySourceRef, reducerState?: unknown): StoredBodyDecodeState {
  if (source.decodedUtf16.start !== 0) fail("capsule-source-invalid");
  return { v: 1, source, rawOffset: source.raw.start, decoder: createQuotedJsonStringState(), boundedHash: createCatalogHash(),
    chunkCarryBase64: "", nextChunkIndex: 0, complete: false, ...(reducerState === undefined ? {} : { reducerState }) };
}

function checkedCarry(value: string): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(CAPSULE_LIMITS.decodedChunkBytes * 4 / 3) + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail("capsule-checkpoint-corrupt");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length >= CAPSULE_LIMITS.decodedChunkBytes || bytes.length % 2 !== 0 || bytes.toString("base64") !== value) fail("capsule-checkpoint-corrupt");
  return bytes;
}

export function validateStoredBodyDecodeState(state: StoredBodyDecodeState): void {
  if (state?.v !== 1 || !Number.isSafeInteger(state.rawOffset) || state.rawOffset < state.source.raw.start || state.rawOffset > state.source.raw.end
    || !Number.isSafeInteger(state.nextChunkIndex) || state.nextChunkIndex < 0 || typeof state.complete !== "boolean") fail("capsule-checkpoint-corrupt");
  const carry = checkedCarry(state.chunkCarryBase64);
  if (state.boundedHash.pending.length > 2046 || state.boundedHash.pending.length % 2 !== 0
    || !/^[0-9a-f]{64}$/.test(state.boundedHash.chain) || !Number.isSafeInteger(state.boundedHash.units)
    || state.boundedHash.units !== state.decoder.decodedUnits || carry.length / 2 !== (state.complete ? 0 : state.decoder.decodedUnits % CAPSULE_LIMITS.decodedChunkUnits)
    || state.nextChunkIndex !== (state.complete ? Math.ceil(state.decoder.decodedUnits / CAPSULE_LIMITS.decodedChunkUnits) : Math.floor(state.decoder.decodedUnits / CAPSULE_LIMITS.decodedChunkUnits))) fail("capsule-checkpoint-corrupt");
  if (state.complete && (!state.decoder.done || state.rawOffset !== state.source.raw.end || state.bodyHash !== state.source.bodyHash || carry.length !== 0)) fail("capsule-checkpoint-corrupt");
}

export interface FeedBodyResult {
  readonly state: StoredBodyDecodeState;
  readonly chunks: readonly DerivedChunk[];
  readonly feeds: readonly { decodedUtf16: { start: number; end: number }; text: string }[];
}

/** Consume one exact contiguous M04 raw page. It never creates a whole-body string. */
export function feedBodyRaw(prior: StoredBodyDecodeState, raw: Uint8Array): FeedBodyResult {
  validateStoredBodyDecodeState(prior);
  if (prior.complete || raw.length > CAPSULE_LIMITS.sourceReadBytes || raw.length > prior.source.raw.end - prior.rawOffset) fail("capsule-source-range");
  const state: StoredBodyDecodeState = structuredClone(prior);
  const priorCarry = checkedCarry(state.chunkCarryBase64);
  let carry = Buffer.allocUnsafe(CAPSULE_LIMITS.decodedChunkBytes), carryBytes = priorCarry.length;
  priorCarry.copy(carry);
  const chunks: DerivedChunk[] = [];
  const feeds: { decodedUtf16: { start: number; end: number }; text: string }[] = [];
  let feedStart = state.decoder.decodedUnits;
  let feedUnits: number[] = [];
  const flushFeed = (): void => {
    if (!feedUnits.length) return;
    const text = String.fromCharCode(...feedUnits);
    feeds.push({ decodedUtf16: { start: feedStart, end: feedStart + text.length }, text });
    feedStart += text.length; feedUnits = [];
  };
  const sink = (_: undefined, unit: number): void => {
    catalogHashUnit(state.boundedHash, unit);
    carry.writeUInt16LE(unit, carryBytes); carryBytes += 2;
    feedUnits.push(unit);
    if (feedUnits.length === CAPSULE_LIMITS.reducerInputUnits) flushFeed();
    if (carryBytes === CAPSULE_LIMITS.decodedChunkBytes) {
      const chunkIndex = chunks.length + prior.nextChunkIndex;
      const start = chunkIndex * CAPSULE_LIMITS.decodedChunkUnits;
      const payload = Buffer.from(carry);
      chunks.push({ payload, descriptor: { v: 1, source: prior.source, chunkIndex,
        decodedUtf16: { start, end: start + CAPSULE_LIMITS.decodedChunkUnits }, utf16leBytes: payload.length,
        contentHashAlgorithm: CHUNK_CONTENT_HASH, contentHash: sha256(payload) } });
      carry = Buffer.allocUnsafe(CAPSULE_LIMITS.decodedChunkBytes); carryBytes = 0;
    }
  };
  const result = decodeQuotedJsonStringChunk(state.decoder, raw, sink, undefined);
  if (result.error) fail("capsule-source-invalid");
  state.rawOffset += result.consumedBytes;
  if (result.consumedBytes !== raw.length && !state.decoder.done) fail("capsule-source-invalid");
  flushFeed();
  let complete = false, bodyHash: string | undefined;
  if (state.decoder.done) {
    if (state.rawOffset !== state.source.raw.end || result.consumedBytes !== raw.length) fail("capsule-source-range");
    if (carryBytes) {
      const chunkIndex = chunks.length + prior.nextChunkIndex;
      const start = chunkIndex * CAPSULE_LIMITS.decodedChunkUnits;
      const payload = Buffer.from(carry.subarray(0, carryBytes));
      chunks.push({ payload, descriptor: { v: 1, source: prior.source, chunkIndex,
        decodedUtf16: { start, end: start + payload.length / 2 }, utf16leBytes: payload.length,
        contentHashAlgorithm: CHUNK_CONTENT_HASH, contentHash: sha256(payload) } });
      carry = Buffer.allocUnsafe(CAPSULE_LIMITS.decodedChunkBytes); carryBytes = 0;
    }
    bodyHash = finishCatalogHash(state.boundedHash);
    if (state.decoder.decodedUnits !== state.source.decodedUtf16.end || bodyHash !== state.source.bodyHash) fail("capsule-body-hash-mismatch");
    complete = true;
  }
  const next: StoredBodyDecodeState = { ...state, chunkCarryBase64: carry.subarray(0, carryBytes).toString("base64"),
    nextChunkIndex: prior.nextChunkIndex + chunks.length, complete, ...(bodyHash ? { bodyHash } : {}) };
  validateStoredBodyDecodeState(next);
  return { state: next, chunks, feeds };
}

export function privateCursor(state: StoredBodyDecodeState): ChunkDecodeCursor {
  validateStoredBodyDecodeState(state);
  const d = state.decoder.decoder;
  return { v: 1, source: state.source, rawOffset: state.rawOffset, decodedOffset: state.decoder.decodedUnits,
    opened: state.decoder.opened, jsonEscape: d.escape,
    pendingUnicodeEscape: d.unicodeLeft ? { value: d.unicode, digits: 4 - d.unicodeLeft } : null,
    pendingUtf8: d.utfLeft ? { value: d.utfValue, bytesLeft: d.utfLeft, minimum: d.utfMin } : null,
    boundedHash: { algorithm: CAPSULE_TEXT_HASH, chain: state.boundedHash.chain, pendingBytes: [...state.boundedHash.pending], units: state.boundedHash.units },
    chunkCarryUtf16le: new Uint8Array(checkedCarry(state.chunkCarryBase64)), complete: state.complete };
}

export interface CatalogEventShape {
  readonly seq: number; readonly shardKey: string; readonly ordinal: number; readonly metadata: Record<string, unknown>;
}
export interface CatalogBlockShape { readonly index: number; readonly metadata: Record<string, unknown> }

export function segmentForEvent(view: CapsuleCatalogView, eventSeq: number): number {
  return (view.segments.find(item => eventSeq <= item.cut) ?? fail("capsule-event-outside-view")).segment;
}

export function bodySource(identity: DerivedStoreIdentity, view: CapsuleCatalogView, event: CatalogEventShape, block: CatalogBlockShape): ScopedBodySourceRef | undefined {
  const m = block.metadata;
  if (m.kind !== "body" || typeof m.field !== "string" || !Number.isSafeInteger(m.rawStart) || !Number.isSafeInteger(m.rawEnd)
    || !Number.isSafeInteger(m.decodedStart) || !Number.isSafeInteger(m.decodedEnd) || m.hashAlgorithm !== CAPSULE_TEXT_HASH
    || typeof m.hash !== "string" || !/^[0-9a-f]{64}$/.test(m.hash) || m.decodedStart !== 0) return undefined;
  const entryId = typeof event.metadata.id === "string" ? event.metadata.id : undefined;
  return { catalogStoreKey: identity.catalogStoreKey, sessionKey: identity.sessionKey, catalogGeneration: identity.catalogGeneration,
    shardKey: event.shardKey, segment: segmentForEvent(view, event.seq), eventSeq: event.seq, ordinal: event.ordinal,
    descriptor: block.index, ...(Number.isSafeInteger(m.blockIndex) ? { blockIndex: Number(m.blockIndex) } : {}), field: m.field,
    raw: { start: Number(m.rawStart), end: Number(m.rawEnd) }, ...(entryId === undefined ? {} : { entryId }), coordinateKind: "decoded-body",
    decodedUtf16: { start: 0, end: Number(m.decodedEnd) }, bodyHashAlgorithm: CAPSULE_TEXT_HASH, bodyHash: m.hash };
}

export function provenance(block: CatalogBlockShape): CatalogProvenance {
  const value = block.metadata.provenance;
  return value === "generated" || value === "mixed" ? value : "original";
}
export function isOpaqueBody(block: CatalogBlockShape): "none" | "image" | "data" {
  if (block.metadata.field === "data") return "data";
  return "none";
}
export function classifyBody(event: CatalogEventShape, block: CatalogBlockShape): { kind: SourceBlockKind; structural: SourceStructuralFacts } {
  const m = event.metadata, b = block.metadata;
  const role = typeof m.role === "string" ? m.role : undefined;
  const toolName = typeof m.toolName === "string" ? m.toolName : typeof b.name === "string" ? b.name : undefined;
  let kind: SourceBlockKind = "unknown";
  if (role === "user") kind = "user";
  else if (role === "toolResult") kind = toolName === "bash" ? "bash-execution" : "tool-result";
  else if (role === "assistant") kind = b.field === "thinking" ? "assistant-reasoning" : "assistant-text";
  else if (m.type === "branch_summary") kind = "branch-summary";
  else if (m.type === "compaction") kind = "historical-compaction";
  // Kind selection is classification, not a persisted fact. Structural values
  // remain absent until a caller supplies exact verified ScopedRawSourceRefs.
  return { kind, structural: {} };
}
