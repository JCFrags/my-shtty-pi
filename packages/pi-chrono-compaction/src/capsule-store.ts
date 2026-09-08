import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  CAPSULE_LIMITS,
  CAPSULE_SCHEMA_VERSION,
  CHUNK_SCHEMA_VERSION,
  DERIVED_SCHEMA_VERSION,
  SEGMENT_CONTENT_HASH,
  isCapsuleWorkerRequest,
  isDerivedPublicationReceipt,
  isReducerEnvelope,
  type CapsuleBodyDescriptor,
  type CapsuleCatalogView,
  type CapsuleReadiness,
  type CapsuleWorkerRequest,
  type CapsuleWorkerResponse,
  type DeriveCursor,
  type DerivedPublicationReceipt,
  type LayerReadiness,
  type ReducerEnvelope,
  type ScopedBodySourceRef,
  type SourceBlockReducerBaseInput,
  type CapsuleReductionFeed,
  type CapsuleReductionState,
} from "./capsule-contract.js";
import { CatalogSqlite, type SqlRow, type SqlValue } from "./catalog-sqlite.js";
import { executeCatalogStoreRequest } from "./catalog-store.js";
import type { CatalogResponse } from "./catalog-contract.js";
import { withRuntimeMutex } from "./worker-runtime-mutex.js";
import { beginCapsuleReduction, feedCapsuleReduction, finalizeCapsuleReduction, type CapsuleReducerStreamState } from "./capsule-reducer-stream.js";
import { CAPSULE_REDUCER_DEFAULT_BUDGET, CAPSULE_REDUCER_FAMILY_VERSIONS, type CapsuleReducerOptions } from "./capsule-reducer.js";
import {
  beginBodyDecode,
  bodySource,
  classifyBody,
  feedBodyRaw,
  isOpaqueBody,
  provenance,
  validateStoredBodyDecodeState,
  type CatalogBlockShape,
  type CatalogEventShape,
  type StoredBodyDecodeState,
} from "./capsule-derive.js";
import {
  canonicalJson,
  decodeCapsuleSegment,
  decodeChunkPayload,
  encodeCapsuleSegment,
  encodeChunkSegment,
  encodeManifest,
  encodeReceipt,
  publishImmutable,
  readExactNamed,
  readVerifiedImmutable,
  syncCapsuleDirectory,
  type CapsuleSegmentHooks,
} from "./capsule-segment.js";

const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const number = (row: SqlRow, key: string): number => Number(row[key]);
const string = (row: SqlRow, key: string): string => String(row[key]);
const schema = [
  "CREATE TABLE meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, identity TEXT NOT NULL, derivedRoute TEXT NOT NULL, catalogRoute TEXT NOT NULL, capsuleReady INTEGER NOT NULL, chunkReady INTEGER NOT NULL)",
  "CREATE TABLE artifacts (layer TEXT NOT NULL, eventSeq INTEGER NOT NULL, descriptor INTEGER NOT NULL, chunkIndex INTEGER NOT NULL, source TEXT NOT NULL, record TEXT NOT NULL, manifestHash TEXT NOT NULL, segmentHash TEXT NOT NULL, segmentBytes INTEGER NOT NULL, segmentOffset INTEGER NOT NULL, payloadBytes INTEGER NOT NULL, contentHash TEXT NOT NULL, PRIMARY KEY(layer,eventSeq,descriptor,chunkIndex))",
  "CREATE INDEX artifact_range ON artifacts(layer,eventSeq,descriptor,chunkIndex)",
  "CREATE TABLE markers (eventSeq INTEGER NOT NULL, descriptor INTEGER NOT NULL, layer TEXT NOT NULL, state TEXT NOT NULL, marker TEXT NOT NULL, PRIMARY KEY(eventSeq,descriptor,layer))",
  "CREATE TABLE heads (lineage TEXT PRIMARY KEY, view TEXT NOT NULL, cursor TEXT NOT NULL, privateHash TEXT, privateState TEXT, receiptHash TEXT, capsuleEligible INTEGER NOT NULL, capsuleReady INTEGER NOT NULL, capsuleUnsupported INTEGER NOT NULL, capsuleFailed INTEGER NOT NULL, capsuleExcluded INTEGER NOT NULL, chunkEligible INTEGER NOT NULL, chunkReady INTEGER NOT NULL, chunkUnsupported INTEGER NOT NULL, chunkFailed INTEGER NOT NULL, chunkExcluded INTEGER NOT NULL)",
  "CREATE TABLE readiness (viewHash TEXT PRIMARY KEY, view TEXT NOT NULL, cursor TEXT NOT NULL, receiptHash TEXT, capsuleEligible INTEGER NOT NULL, capsuleReady INTEGER NOT NULL, capsuleUnsupported INTEGER NOT NULL, capsuleFailed INTEGER NOT NULL, capsuleExcluded INTEGER NOT NULL, chunkEligible INTEGER NOT NULL, chunkReady INTEGER NOT NULL, chunkUnsupported INTEGER NOT NULL, chunkFailed INTEGER NOT NULL, chunkExcluded INTEGER NOT NULL)",
  "CREATE TABLE manifests (hash TEXT PRIMARY KEY, layer TEXT NOT NULL, segmentHash TEXT NOT NULL, bytes INTEGER NOT NULL)",
  "CREATE TABLE receipts (hash TEXT PRIMARY KEY, predecessor TEXT, viewHash TEXT NOT NULL, cursor TEXT NOT NULL, bytes INTEGER NOT NULL)",
];

export type CapsuleStoreFaultPoint = "before-sqlite-transaction" | "inside-sqlite-transaction" | "after-sqlite-transaction";
export interface CapsuleReducerHooks {
  begin(base: SourceBlockReducerBaseInput): CapsuleReductionState;
  feed(state: CapsuleReductionState, feed: CapsuleReductionFeed): CapsuleReductionState;
  finalize(state: CapsuleReductionState): ReducerEnvelope;
}
export interface CapsuleExecutionOptions {
  readonly catalogExecutor?: (request: unknown) => Promise<CatalogResponse>;
  /** Synthetic override only. Omission uses the real deterministic streaming reducer. */
  readonly reducer?: CapsuleReducerHooks;
  readonly segmentHooks?: CapsuleSegmentHooks;
  readonly fault?: (point: CapsuleStoreFaultPoint) => void;
}
interface Counts { capsuleEligible: number; capsuleReady: number; capsuleUnsupported: number; capsuleFailed: number; capsuleExcluded: number;
  chunkEligible: number; chunkReady: number; chunkUnsupported: number; chunkFailed: number; chunkExcluded: number }
const zeroCounts = (): Counts => ({ capsuleEligible: 0, capsuleReady: 0, capsuleUnsupported: 0, capsuleFailed: 0, capsuleExcluded: 0,
  chunkEligible: 0, chunkReady: 0, chunkUnsupported: 0, chunkFailed: 0, chunkExcluded: 0 });
function familyFor(base: SourceBlockReducerBaseInput): keyof typeof CAPSULE_REDUCER_FAMILY_VERSIONS {
  if (base.kind === "bash-execution" || base.structural.toolName === "bash") return "terminal";
  if (base.kind === "tool-result" && /(?:test|pytest|jest|vitest)/iu.test(base.structural.toolName ?? "")) return "test-output";
  if (base.kind === "assistant-reasoning") return "assistant-cleanup";
  if (base.kind === "assistant-text") return "assistant-extractive";
  return "generic-text";
}
function reductionOptions(base: SourceBlockReducerBaseInput): CapsuleReducerOptions {
  const family = familyFor(base);
  return { family, familyVersion: CAPSULE_REDUCER_FAMILY_VERSIONS[family], reducerSetVersion: base.identity.reducerSetVersion,
    configHash: base.identity.configHash, budget: CAPSULE_REDUCER_DEFAULT_BUDGET };
}
const defaultReducer: CapsuleReducerHooks = {
  begin(base) { return beginCapsuleReduction(base, reductionOptions(base)); },
  feed(state, feed) { return feedCapsuleReduction(state as CapsuleReducerStreamState, feed); },
  finalize(state) { return finalizeCapsuleReduction(state as CapsuleReducerStreamState); },
};

function prepareDirectory(path: string, create: boolean): void {
  const uid = process.getuid?.();
  if (resolve(path) !== path || path === "/" || uid === undefined) fail("capsule-storage-unsafe");
  const parts = path.split("/").filter(Boolean); if (parts.length > 64) fail("capsule-storage-unsafe");
  let at = "", made = 0;
  for (const part of parts) {
    at += `/${part}`;
    try {
      const st = lstatSync(at);
      const final = at === path;
      if (!st.isDirectory() || st.isSymbolicLink() || (st.uid !== 0 && st.uid !== uid)
        || ((st.mode & 0o022) !== 0 && !(st.uid === 0 && (st.mode & 0o1000) !== 0))
        || (final && (st.uid !== uid || (st.mode & 0o7777) !== 0o700))) fail("capsule-storage-unsafe");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create || ++made > 8) throw error;
      mkdirSync(at, { mode: 0o700 });
      const st = lstatSync(at); if (st.uid !== uid || (st.mode & 0o7777) !== 0o700) fail("capsule-storage-unsafe");
      syncCapsuleDirectory(dirname(at));
    }
  }
}
function prepareLayout(root: string, create: boolean): void {
  prepareDirectory(root, create);
  for (const child of ["segments", "segments/capsules", "segments/chunks", "manifests", "receipts"]) prepareDirectory(join(root, child), create);
}

class Store {
  statements = 0;
  constructor(readonly db: CatalogSqlite, readonly request: CapsuleWorkerRequest) {}
  get(sql: string, ...values: SqlValue[]): SqlRow | undefined { this.statements++; return this.db.prepare(sql).get(...values); }
  run(sql: string, ...values: SqlValue[]): void { this.statements++; this.db.prepare(sql).run(...values); }
  rows(sql: string, limit: number, ...values: SqlValue[]): SqlRow[] { this.statements++; return [...this.db.prepare(sql).iterate(limit, ...values)]; }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn); }
  validate(bootstrap: boolean): void {
    const exists = this.get("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'");
    if (!exists) { if (bootstrap && !this.get("SELECT name FROM sqlite_master LIMIT 1")) return; fail("catalog-version-mismatch"); }
    const meta = this.get("SELECT * FROM meta WHERE singleton=1");
    if (!meta || number(meta, "version") !== DERIVED_SCHEMA_VERSION || string(meta, "identity") !== canonicalJson(this.request.identity)
      || string(meta, "derivedRoute") !== this.request.derivedDirectory || string(meta, "catalogRoute") !== this.request.catalogDirectory) fail("catalog-store-mismatch");
    if (number(this.get("SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")!, "count") !== schema.length) fail("catalog-version-mismatch");
    for (const sql of schema) {
      const name = sql.split(" ")[2]!;
      if (this.get("SELECT sql FROM sqlite_master WHERE name=?", name)?.sql !== sql) fail("catalog-version-mismatch");
    }
  }
  initialize(bootstrap: boolean): void {
    this.transaction(() => {
      this.validate(bootstrap);
      if (!this.get("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")) {
        for (const sql of schema) this.run(sql);
        this.run("INSERT INTO meta VALUES(1,?,?,?,?,?,?)", DERIVED_SCHEMA_VERSION, canonicalJson(this.request.identity), this.request.derivedDirectory, this.request.catalogDirectory, 0, 0);
      }
    });
  }
}

const viewHash = (view: CapsuleCatalogView): string => sha256(canonicalJson(view));
const lineageHash = (view: CapsuleCatalogView): string => sha256(canonicalJson({ branchKey: view.branchKey, segments: view.segments.map(item => item.segment) }));
function extendsView(current: CapsuleCatalogView, old: CapsuleCatalogView): boolean {
  return current.branchKey === old.branchKey && current.eventCut >= old.eventCut && current.segments.length >= old.segments.length
    && old.segments.every((item, index) => current.segments[index]?.segment === item.segment && current.segments[index]!.cut >= item.cut);
}
function rowCounts(row?: SqlRow): Counts {
  if (!row) return zeroCounts();
  return { capsuleEligible: number(row, "capsuleEligible"), capsuleReady: number(row, "capsuleReady"), capsuleUnsupported: number(row, "capsuleUnsupported"),
    capsuleFailed: number(row, "capsuleFailed"), capsuleExcluded: number(row, "capsuleExcluded"), chunkEligible: number(row, "chunkEligible"),
    chunkReady: number(row, "chunkReady"), chunkUnsupported: number(row, "chunkUnsupported"), chunkFailed: number(row, "chunkFailed"), chunkExcluded: number(row, "chunkExcluded") };
}
function cursorAt(request: Extract<CapsuleWorkerRequest, { op: "derivePage" }>, head?: SqlRow): { cursor: DeriveCursor; counts: Counts; state?: StoredBodyDecodeState; receipt?: string } {
  if (head) {
    const saved = JSON.parse(string(head, "cursor")) as DeriveCursor;
    const oldView = JSON.parse(string(head, "view")) as CapsuleCatalogView;
    if (!extendsView(request.view, oldView)) fail("capsule-cursor-invalid");
    if (request.cursor && canonicalJson(request.cursor) !== canonicalJson(saved)) fail("capsule-cursor-invalid");
    let state: StoredBodyDecodeState | undefined;
    if (head.privateState !== null) {
      const encoded = string(head, "privateState");
      if (sha256(encoded) !== string(head, "privateHash")) fail("capsule-checkpoint-corrupt");
      state = JSON.parse(encoded) as StoredBodyDecodeState; validateStoredBodyDecodeState(state);
    }
    return { cursor: { ...saved, view: request.view }, counts: rowCounts(head), ...(state ? { state } : {}), ...(head.receiptHash === null ? {} : { receipt: string(head, "receiptHash") }) };
  }
  if (request.cursor) fail("capsule-cursor-invalid");
  return { cursor: { v: 1, identity: request.identity, view: request.view, afterEventSeq: 0, afterDescriptor: 0, bodyRawOffset: 0, bodyDecodedOffset: 0 }, counts: zeroCounts() };
}
function layer(counts: Counts, name: "capsules" | "chunks", cursor: DeriveCursor, marker?: string): LayerReadiness {
  const prefix = name === "capsules" ? "capsule" : "chunk";
  const eligible = counts[`${prefix}Eligible`], ready = counts[`${prefix}Ready`], unsupported = counts[`${prefix}Unsupported`], failed = counts[`${prefix}Failed`], excluded = counts[`${prefix}Excluded`];
  const covered = cursor.partialBody === undefined && cursor.afterEventSeq === cursor.view.eventCut && cursor.afterDescriptor === 0;
  const state = failed ? "failed" : unsupported ? "unsupported" : covered && excluded && !eligible ? "excluded" : covered && ready === eligible ? "ready" : "partial";
  return { layer: name, state, eligible, ready, unsupported, failed, excluded, afterEventSeq: cursor.afterEventSeq,
    afterDescriptor: cursor.afterDescriptor, resumable: state !== "ready", ...(marker ? { marker } : {}) } as LayerReadiness;
}
function readiness(request: CapsuleWorkerRequest, view: CapsuleCatalogView, cursor: DeriveCursor, counts: Counts, catalog: "pinned" | "lagging" | "unavailable" = "pinned", marker?: string): CapsuleReadiness {
  return { v: 1, identity: request.identity, view, catalog, capsules: layer(counts, "capsules", cursor, marker), chunks: layer(counts, "chunks", cursor, marker) };
}

interface CatalogBudget { bytes: number }
async function catalogCall(request: CapsuleWorkerRequest, executor: (value: unknown) => Promise<CatalogResponse>, budget: CatalogBudget, value: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await executor({ v: 1, catalogDirectory: request.catalogDirectory, sessionKey: request.identity.sessionKey, targetStoreKey: request.identity.catalogStoreKey, ...value });
  budget.bytes += response.sourceBytes;
  if (budget.bytes > CAPSULE_LIMITS.sourceBytesPerJob) fail("capsule-source-budget");
  if (!response.ok) fail(response.code === "catalog-source-changed" ? "capsule-source-changed" : "capsule-catalog-unavailable");
  return (response as Extract<CatalogResponse, { ok: true }>).result;
}
async function eventAt(request: Extract<CapsuleWorkerRequest, { op: "derivePage" }>, executor: (value: unknown) => Promise<CatalogResponse>, budget: CatalogBudget, cursor: DeriveCursor): Promise<CatalogEventShape | undefined> {
  const after = cursor.partialBody || cursor.afterDescriptor > 0 ? Math.max(0, cursor.afterEventSeq - 1) : cursor.afterEventSeq;
  const result = await catalogCall(request, executor, budget, { op: "page", view: request.view, after, limit: 1 });
  const event = result.events?.[0];
  if (!event) return undefined;
  if (cursor.partialBody || cursor.afterDescriptor > 0) { if (event.seq !== cursor.afterEventSeq) fail("capsule-cursor-invalid"); }
  return event as CatalogEventShape;
}
async function blockAt(request: CapsuleWorkerRequest, executor: (value: unknown) => Promise<CatalogResponse>, budget: CatalogBudget, eventSeq: number, descriptor: number): Promise<CatalogBlockShape | undefined> {
  const result = await catalogCall(request, executor, budget, { op: "blocks", view: "view" in request ? request.view : undefined, eventSeq, after: descriptor, limit: 1 });
  const block = result.blocks?.[0];
  return block?.index === descriptor ? block as CatalogBlockShape : undefined;
}
function sameSource(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
function verifyReceipt(request: CapsuleWorkerRequest, store: Store, row: SqlRow): void {
  if (row.receiptHash === null) return;
  const hash = string(row, "receiptHash");
  const receiptRow = store.get("SELECT * FROM receipts WHERE hash=?", hash) ?? fail("capsule-content-missing");
  const bytes = readExactNamed(join(request.derivedDirectory, "receipts"), hash, number(receiptRow, "bytes"));
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { fail("capsule-content-corrupt"); }
  if (!isDerivedPublicationReceipt(value) || value.receiptHash !== hash) fail("capsule-content-corrupt");
  const parsed = value as DerivedPublicationReceipt;
  const { receiptHash: _hash, ...base } = parsed;
  const encoded = encodeReceipt(base);
  if (!encoded.bytes.equals(bytes) || encoded.receipt.receiptHash !== hash) fail("capsule-content-corrupt");
}
function verifyArtifactManifest(request: CapsuleWorkerRequest, store: Store, artifact: SqlRow): void {
  const row = store.get("SELECT * FROM manifests WHERE hash=?", string(artifact, "manifestHash")) ?? fail("capsule-content-missing");
  if (string(row, "segmentHash") !== string(artifact, "segmentHash") || string(row, "layer") !== string(artifact, "layer")) fail("capsule-content-corrupt");
  const bytes = readExactNamed(join(request.derivedDirectory, "manifests"), string(row, "hash"), number(row, "bytes"));
  let parsed: any;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { fail("capsule-content-corrupt"); }
  const encoded = encodeManifest(request.identity, string(row, "layer") as "capsules" | "chunks", parsed.segment);
  if (encoded.manifest.hash !== string(row, "hash") || !encoded.bytes.equals(bytes) || parsed.hash !== encoded.manifest.hash) fail("capsule-content-corrupt");
}

interface PendingArtifact { layer: "capsules" | "chunks"; eventSeq: number; descriptor: number; chunkIndex: number; source: string; record: string;
  manifestHash: string; manifestBytes: number; segmentHash: string; segmentBytes: number; segmentOffset: number; payloadBytes: number; contentHash: string }
async function derive(request: Extract<CapsuleWorkerRequest, { op: "derivePage" }>, store: Store, options: CapsuleExecutionOptions, executor: (value: unknown) => Promise<CatalogResponse>, budget: CatalogBudget): Promise<Record<string, unknown>> {
  const reducer = options.reducer ?? defaultReducer;
  const lineage = lineageHash(request.view), head = store.get("SELECT * FROM heads WHERE lineage=?", lineage);
  let current = cursorAt(request, head), cursor = current.cursor, counts = current.counts, state = current.state;
  const artifacts: PendingArtifact[] = [], manifestHashes: string[] = [];
  const markers: { eventSeq: number; descriptor: number; layer: string; state: string; marker: string }[] = [];
  let descriptors = 0, events = 0, marker: string | undefined, exhausted = false, completedBody: CapsuleBodyDescriptor | undefined;
  while (descriptors < (request.maxDescriptors ?? CAPSULE_LIMITS.deriveDescriptors) && events < (request.maxEvents ?? CAPSULE_LIMITS.deriveEvents)) {
    const event = await eventAt(request, executor, budget, cursor);
    if (!event) { exhausted = true; break; }
    const descriptor = cursor.partialBody ? cursor.afterDescriptor : cursor.afterDescriptor;
    const block = await blockAt(request, executor, budget, event.seq, descriptor);
    if (!block) { cursor = { ...cursor, afterEventSeq: event.seq, afterDescriptor: 0, bodyRawOffset: 0, bodyDecodedOffset: 0, partialBody: undefined }; events++; continue; }
    descriptors++;
    const source = bodySource(request.identity, request.view, event, block);
    if (!source) {
      counts = { ...counts, capsuleEligible: counts.capsuleEligible + 1, capsuleUnsupported: counts.capsuleUnsupported + 1, chunkExcluded: counts.chunkExcluded + 1 };
      markers.push({ eventSeq: event.seq, descriptor: block.index, layer: "capsules", state: "unsupported", marker: "capsule-body-required" },
        { eventSeq: event.seq, descriptor: block.index, layer: "chunks", state: "excluded", marker: "chunk-body-required" });
      cursor = { ...cursor, afterEventSeq: event.seq, afterDescriptor: block.index + 1, bodyRawOffset: 0, bodyDecodedOffset: 0, partialBody: undefined }; continue;
    }
    if (isOpaqueBody(block) !== "none") {
      counts = { ...counts, capsuleExcluded: counts.capsuleExcluded + 1, chunkExcluded: counts.chunkExcluded + 1 };
      markers.push({ eventSeq: event.seq, descriptor: block.index, layer: "capsules", state: "excluded", marker: "capsule-opaque" },
        { eventSeq: event.seq, descriptor: block.index, layer: "chunks", state: "excluded", marker: "chunk-opaque" });
      cursor = { ...cursor, afterEventSeq: event.seq, afterDescriptor: block.index + 1, bodyRawOffset: 0, bodyDecodedOffset: 0, partialBody: undefined }; continue;
    }
    const priorChunk = store.get("SELECT state FROM markers WHERE eventSeq=? AND descriptor=? AND layer='chunks'", event.seq, block.index);
    if (!state && priorChunk?.state === "ready") {
      const priorCapsule = store.get("SELECT state FROM markers WHERE eventSeq=? AND descriptor=? AND layer='capsules'", event.seq, block.index);
      counts = { ...counts, chunkEligible: counts.chunkEligible + 1, chunkReady: counts.chunkReady + 1, capsuleEligible: counts.capsuleEligible + 1,
        capsuleReady: counts.capsuleReady + (priorCapsule?.state === "ready" ? 1 : 0), capsuleUnsupported: counts.capsuleUnsupported + (priorCapsule?.state === "ready" ? 0 : 1) };
      cursor = { ...cursor, afterEventSeq: event.seq, afterDescriptor: block.index + 1, bodyRawOffset: 0, bodyDecodedOffset: 0, partialBody: undefined }; continue;
    }
    if (!state) {
      const classified = classifyBody(event, block);
      // M04 descriptor metadata is not an exact raw fact reference. Until the
      // bounded raw-reference path supplies one, keep structural facts empty.
      const base: SourceBlockReducerBaseInput = { v: 1, identity: request.identity, view: request.view, source,
        kind: classified.kind, structural: {}, provenance: provenance(block) };
      state = beginBodyDecode(source, reducer.begin(base));
    } else if (!sameSource(state.source, source)) fail("capsule-checkpoint-corrupt");
    if (budget.bytes > CAPSULE_LIMITS.sourceBytesPerJob - 192 * 1024) { marker = "capsule-source-budget-resume"; break; }
    const length = Math.min(CAPSULE_LIMITS.sourceReadBytes, source.raw.end - state.rawOffset);
    const rawResult = await catalogCall(request, executor, budget, { op: "raw", view: request.view, eventSeq: event.seq, offset: state.rawOffset, length });
    const raw = Buffer.from(String(rawResult.data), "base64");
    if (raw.length !== length || rawResult.offset !== state.rawOffset) fail("capsule-source-range");
    const fed = feedBodyRaw(state, raw); state = fed.state;
    if (state.reducerState) for (const feed of fed.feeds) state.reducerState = reducer.feed(state.reducerState as CapsuleReductionState, feed);
    for (const item of fed.chunks) {
      const encoded = encodeChunkSegment(item.descriptor, item.payload);
      publishImmutable(join(request.derivedDirectory, "segments/chunks"), encoded.descriptor.hash, encoded.bytes, "chunk", options.segmentHooks);
      const manifest = encodeManifest(request.identity, "chunks", encoded.descriptor);
      publishImmutable(join(request.derivedDirectory, "manifests"), manifest.manifest.hash, manifest.bytes, "manifest", options.segmentHooks, false);
      manifestHashes.push(manifest.manifest.hash);
      artifacts.push({ layer: "chunks", eventSeq: event.seq, descriptor: block.index, chunkIndex: encoded.chunk.chunkIndex,
        source: canonicalJson(source), record: canonicalJson(encoded.chunk), manifestHash: manifest.manifest.hash, manifestBytes: manifest.bytes.length, segmentHash: encoded.descriptor.hash,
        segmentBytes: encoded.descriptor.bytes, segmentOffset: encoded.chunk.segmentOffset, payloadBytes: encoded.chunk.utf16leBytes, contentHash: encoded.chunk.contentHash });
    }
    if (state.complete) {
      completedBody = { v: 1, source, decodedUnits: source.decodedUtf16.end, utf16leBytes: source.decodedUtf16.end * 2,
        chunkCount: Math.ceil(source.decodedUtf16.end / CAPSULE_LIMITS.decodedChunkUnits), bodyHashAlgorithm: source.bodyHashAlgorithm,
        bodyHash: source.bodyHash, provenance: provenance(block), opaque: "none" };
      counts = { ...counts, chunkEligible: counts.chunkEligible + 1, chunkReady: counts.chunkReady + 1, capsuleEligible: counts.capsuleEligible + 1 };
      markers.push({ eventSeq: event.seq, descriptor: block.index, layer: "chunks", state: "ready", marker: "chunk-body-complete" });
      if (state.reducerState) {
        const envelope = reducer.finalize(state.reducerState as CapsuleReductionState);
        if (!isReducerEnvelope(envelope) || !sameSource(envelope.source, source)) fail("capsule-reducer-invalid");
        const encoded = encodeCapsuleSegment(envelope);
        publishImmutable(join(request.derivedDirectory, "segments/capsules"), encoded.descriptor.hash, encoded.bytes, "capsule", options.segmentHooks);
        const manifest = encodeManifest(request.identity, "capsules", encoded.descriptor);
        publishImmutable(join(request.derivedDirectory, "manifests"), manifest.manifest.hash, manifest.bytes, "manifest", options.segmentHooks, false);
        manifestHashes.push(manifest.manifest.hash); counts = { ...counts, capsuleReady: counts.capsuleReady + 1 };
        markers.push({ eventSeq: event.seq, descriptor: block.index, layer: "capsules", state: "ready", marker: "capsule-envelope-complete" });
        artifacts.push({ layer: "capsules", eventSeq: event.seq, descriptor: block.index, chunkIndex: 0, source: canonicalJson(source), record: canonicalJson(envelope),
          manifestHash: manifest.manifest.hash, manifestBytes: manifest.bytes.length, segmentHash: encoded.descriptor.hash, segmentBytes: encoded.descriptor.bytes, segmentOffset: 0,
          payloadBytes: encoded.descriptor.bytes, contentHash: encoded.descriptor.hash });
      } else {
        counts = { ...counts, capsuleUnsupported: counts.capsuleUnsupported + 1 }; marker = "capsule-reducer-unavailable";
        markers.push({ eventSeq: event.seq, descriptor: block.index, layer: "capsules", state: "unsupported", marker });
      }
      state = undefined;
      cursor = { ...cursor, afterEventSeq: event.seq, afterDescriptor: block.index + 1, bodyRawOffset: 0, bodyDecodedOffset: 0, partialBody: undefined };
    } else {
      const encodedState = canonicalJson(state), stateHash = sha256(encodedState);
      cursor = { ...cursor, afterEventSeq: event.seq, afterDescriptor: block.index, bodyRawOffset: state.rawOffset,
        bodyDecodedOffset: state.decoder.decodedUnits, partialBody: { source, stateHash } };
    }
    break; // Commit every raw page: bounded restart state and at most a few durable objects.
  }
  const stateText = state ? canonicalJson(state) : undefined;
  if (stateText && Buffer.byteLength(stateText) > 512 * 1024) fail("capsule-reducer-state-limit");
  const stateHash = stateText ? sha256(stateText) : undefined;
  let receipt: DerivedPublicationReceipt | undefined;
  if (manifestHashes.length) {
    const encoded = encodeReceipt({ v: 1, identity: request.identity, view: request.view, ...(current.receipt ? { predecessorReceiptHash: current.receipt } : {}),
      manifestHashes, cursor, hashAlgorithm: SEGMENT_CONTENT_HASH, publication: "durable" });
    publishImmutable(join(request.derivedDirectory, "receipts"), encoded.receipt.receiptHash, encoded.bytes, "receipt", options.segmentHooks, false);
    receipt = encoded.receipt;
  }
  const carriedReceipt = receipt?.receiptHash ?? (head && string(head, "view") === canonicalJson(request.view) ? current.receipt : undefined);
  options.fault?.("before-sqlite-transaction");
  store.transaction(() => {
    for (const item of markers) store.run("INSERT OR IGNORE INTO markers VALUES(?,?,?,?,?)", item.eventSeq, item.descriptor, item.layer, item.state, item.marker);
    for (const item of artifacts) {
      const prior = store.get("SELECT * FROM artifacts WHERE layer=? AND eventSeq=? AND descriptor=? AND chunkIndex=?", item.layer, item.eventSeq, item.descriptor, item.chunkIndex);
      const expected = [item.layer, item.eventSeq, item.descriptor, item.chunkIndex, item.source, item.record, item.manifestHash, item.segmentHash,
        item.segmentBytes, item.segmentOffset, item.payloadBytes, item.contentHash].map(String);
      if (prior) {
        const actual = ["layer", "eventSeq", "descriptor", "chunkIndex", "source", "record", "manifestHash", "segmentHash", "segmentBytes", "segmentOffset", "payloadBytes", "contentHash"].map(key => String(prior[key]));
        if (canonicalJson(actual) !== canonicalJson(expected)) fail("capsule-artifact-conflict");
      } else store.run("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", item.layer, item.eventSeq, item.descriptor, item.chunkIndex, item.source, item.record,
        item.manifestHash, item.segmentHash, item.segmentBytes, item.segmentOffset, item.payloadBytes, item.contentHash);
      store.run("INSERT OR IGNORE INTO manifests VALUES(?,?,?,?)", item.manifestHash, item.layer, item.segmentHash, item.manifestBytes);
    }
    const values: SqlValue[] = [lineage, canonicalJson(request.view), canonicalJson(cursor), stateHash ?? null, stateText ?? null, carriedReceipt ?? null,
      counts.capsuleEligible, counts.capsuleReady, counts.capsuleUnsupported, counts.capsuleFailed, counts.capsuleExcluded,
      counts.chunkEligible, counts.chunkReady, counts.chunkUnsupported, counts.chunkFailed, counts.chunkExcluded];
    store.run("INSERT OR REPLACE INTO heads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", ...values);
    store.run("INSERT OR REPLACE INTO readiness VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", viewHash(request.view), canonicalJson(request.view), canonicalJson(cursor), carriedReceipt ?? null,
      counts.capsuleEligible, counts.capsuleReady, counts.capsuleUnsupported, counts.capsuleFailed, counts.capsuleExcluded,
      counts.chunkEligible, counts.chunkReady, counts.chunkUnsupported, counts.chunkFailed, counts.chunkExcluded);
    if (receipt) store.run("INSERT OR IGNORE INTO receipts VALUES(?,?,?,?,?)", receipt.receiptHash, receipt.predecessorReceiptHash ?? null, viewHash(request.view), canonicalJson(cursor), Buffer.byteLength(canonicalJson(receipt) + "\n"));
    options.fault?.("inside-sqlite-transaction");
  });
  options.fault?.("after-sqlite-transaction");
  return { complete: exhausted && !state, cursor, readiness: readiness(request, request.view, cursor, counts, "pinned", marker),
    ...(completedBody ? { body: completedBody } : {}), metrics: { events, descriptors, manifestsPublished: manifestHashes.length, sqliteStatements: store.statements } };
}

async function authorizeBodyRef(request: Extract<CapsuleWorkerRequest, { op: "chunkRange" | "capsulePage" }>, sourceRef: ScopedBodySourceRef,
  executor: (value: unknown) => Promise<CatalogResponse>, budget: CatalogBudget): Promise<void> {
  let after = 0;
  for (let page = 0; page < Math.ceil(256 / CAPSULE_LIMITS.page); page++) {
    const result = await catalogCall(request, executor, budget, { op: "blocks", view: request.view, eventSeq: sourceRef.eventSeq, after, limit: CAPSULE_LIMITS.page });
    for (const candidate of result.blocks ?? []) {
      if (candidate.index !== sourceRef.descriptor) continue;
      const eventPage = await catalogCall(request, executor, budget, { op: "page", view: request.view, after: Math.max(0, sourceRef.eventSeq - 1), limit: 1 });
      const event = eventPage.events?.[0] as CatalogEventShape | undefined;
      const source = event && bodySource(request.identity, request.view, event, candidate as CatalogBlockShape);
      if (!source || !sameSource(source, sourceRef)) fail("capsule-source-ref-invalid");
      return;
    }
    if (result.after === after || !(result.blocks?.length)) break;
    after = Number(result.after);
  }
  fail("capsule-source-ref-invalid");
}

async function execute(request: CapsuleWorkerRequest, store: Store, options: CapsuleExecutionOptions, executor: (value: unknown) => Promise<CatalogResponse>, budget: CatalogBudget): Promise<Record<string, unknown>> {
  if (request.op === "derivePage") return derive(request, store, options, executor, budget);
  if (request.op === "status") {
    if (!request.view) return { identity: request.identity, marker: "capsule-view-required", metrics: { sqliteStatements: store.statements } };
    await catalogCall(request, executor, budget, { op: "page", view: request.view, after: request.view.eventCut, limit: 1 }); // bounded M04 view authorization
    const row = store.get("SELECT * FROM readiness WHERE viewHash=?", viewHash(request.view));
    if (!row || string(row, "view") !== canonicalJson(request.view)) {
      const cursor: DeriveCursor = { v: 1, identity: request.identity, view: request.view, afterEventSeq: 0, afterDescriptor: 0, bodyRawOffset: 0, bodyDecodedOffset: 0 };
      return { readiness: readiness(request, request.view, cursor, zeroCounts(), "pinned", "capsule-view-not-derived"), statements: store.statements };
    }
    verifyReceipt(request, store, row);
    const cursor = JSON.parse(string(row, "cursor")) as DeriveCursor;
    return { readiness: readiness(request, request.view, cursor, rowCounts(row)), metrics: { sqliteStatements: store.statements } };
  }
  if (request.op === "capsulePage") {
    const afterEvent = request.afterEventSeq ?? 0, afterDescriptor = request.afterDescriptor ?? 0;
    const rows = store.rows("SELECT * FROM artifacts WHERE layer='capsules' AND (eventSeq>? OR (eventSeq=? AND descriptor>?)) ORDER BY eventSeq,descriptor LIMIT ?",
      request.limit ?? CAPSULE_LIMITS.page, afterEvent, afterEvent, afterDescriptor, request.limit ?? CAPSULE_LIMITS.page);
    const capsules: ReducerEnvelope[] = [];
    for (const row of rows) {
      const storedSource = JSON.parse(string(row, "source")) as ScopedBodySourceRef;
      await authorizeBodyRef(request, storedSource, executor, budget);
      verifyArtifactManifest(request, store, row);
      const bytes = readVerifiedImmutable(join(request.derivedDirectory, "segments/capsules", string(row, "segmentHash")), string(row, "segmentHash"), number(row, "segmentBytes"));
      const envelope = decodeCapsuleSegment(bytes);
      if (canonicalJson(envelope.source) !== string(row, "source")) fail("capsule-content-corrupt");
      capsules.push(envelope);
      if (Buffer.byteLength(JSON.stringify({ capsules })) > CAPSULE_LIMITS.responseBytes - 4096) { capsules.pop(); break; }
    }
    const last = capsules.at(-1)?.source;
    return { capsules, next: { afterEventSeq: last?.eventSeq ?? afterEvent, afterDescriptor: last?.descriptor ?? afterDescriptor },
      complete: rows.length < (request.limit ?? CAPSULE_LIMITS.page), metrics: { sqliteStatements: store.statements } };
  }
  const requestedSource = request.source as ScopedBodySourceRef;
  await authorizeBodyRef(request, requestedSource, executor, budget);
  const firstChunk = Math.floor(request.decodedStart / CAPSULE_LIMITS.decodedChunkUnits);
  const rows = store.rows("SELECT * FROM artifacts WHERE layer='chunks' AND eventSeq=? AND descriptor=? AND chunkIndex>=? ORDER BY chunkIndex LIMIT ?",
    request.limit ?? CAPSULE_LIMITS.rangeChunks, request.source.eventSeq, request.source.descriptor, firstChunk, request.limit ?? CAPSULE_LIMITS.rangeChunks);
  const wantedEnd = request.decodedStart + request.decodedLength;
  const output = Buffer.alloc(request.decodedLength * 2); let copiedUnits = 0;
  for (const row of rows) {
    verifyArtifactManifest(request, store, row);
    const descriptor = JSON.parse(string(row, "record"));
    const start = Number(descriptor.decodedUtf16.start), end = Number(descriptor.decodedUtf16.end);
    if (start >= wantedEnd) break;
    const bytes = readVerifiedImmutable(join(request.derivedDirectory, "segments/chunks", string(row, "segmentHash")), string(row, "segmentHash"), number(row, "segmentBytes"));
    const payload = decodeChunkPayload(bytes, descriptor);
    const from = Math.max(start, request.decodedStart), to = Math.min(end, wantedEnd);
    if (to > from) { payload.copy(output, (from - request.decodedStart) * 2, (from - start) * 2, (to - start) * 2); copiedUnits += to - from; }
  }
  if (copiedUnits !== request.decodedLength) fail("capsule-chunk-missing");
  return { source: requestedSource, decodedUtf16: { start: request.decodedStart, end: wantedEnd }, encoding: "base64-utf16le",
    data: output.toString("base64"), complete: true, metrics: { chunksRead: rows.length, sqliteStatements: store.statements } };
}

/** Contained-worker entry. It creates no worker and performs no provider/model work. */
export async function executeCapsuleRequest(value: unknown, options: CapsuleExecutionOptions = {}): Promise<CapsuleWorkerResponse> {
  if (!isCapsuleWorkerRequest(value)) return { v: 1, ok: false, code: "capsule-request-invalid", sourceBytes: 0,
    sqliteNativeLimitBytes: CAPSULE_LIMITS.nativeSqliteBytes, resumable: false };
  const request = value, create = request.op === "derivePage";
  let db: CatalogSqlite | undefined;
  const budget = { bytes: 0 };
  try {
    prepareLayout(request.derivedDirectory, create);
    return await withRuntimeMutex(join(request.derivedDirectory, "publication.lock"), async () => {
      const dbPath = join(request.derivedDirectory, "derived.sqlite");
      const validate = (connection: CatalogSqlite): void => new Store(connection, request).validate(create);
      db = create ? CatalogSqlite.create(dbPath, validate) : CatalogSqlite.open(dbPath, validate);
      const store = new Store(db, request); store.initialize(create);
      const result = await execute(request, store, options, options.catalogExecutor ?? executeCatalogStoreRequest, budget);
      const response: CapsuleWorkerResponse = { v: 1, ok: true, result, sourceBytes: budget.bytes, sqliteNativeLimitBytes: CAPSULE_LIMITS.nativeSqliteBytes };
      if (Buffer.byteLength(JSON.stringify(response)) > CAPSULE_LIMITS.responseBytes) fail("capsule-response-limit");
      try { db.checkpoint(); } catch { /* committed WAL remains authoritative */ }
      return response;
    });
  } catch (error) {
    const candidate = (error as { code?: string }).code;
    const mapped: Record<string, string> = { "catalog-storage-unsafe": "capsule-storage-unsafe", "catalog-store-mismatch": "capsule-store-mismatch",
      "catalog-version-mismatch": "capsule-version-mismatch", "catalog-sqlite-busy": "capsule-store-busy",
      "catalog-sqlite-corrupt": "capsule-store-corrupt", "catalog-sqlite-capability": "capsule-store-capability",
      "catalog-sqlite-limit": "capsule-store-limit", "catalog-sqlite-failed": "capsule-store-failed" };
    const code = candidate?.startsWith("capsule-") ? candidate : candidate && mapped[candidate] ? mapped[candidate]! : candidate === "ENOSPC" ? "capsule-storage-full" : "capsule-storage-io";
    return { v: 1, ok: false, code, sourceBytes: budget.bytes, sqliteNativeLimitBytes: CAPSULE_LIMITS.nativeSqliteBytes,
      resumable: !["capsule-request-invalid", "capsule-store-mismatch", "capsule-version-mismatch", "capsule-storage-unsafe"].includes(code) };
  } finally { try { db?.close(); } catch { /* preserve bounded result */ } }
}
