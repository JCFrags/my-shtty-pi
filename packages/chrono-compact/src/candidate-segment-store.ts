import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseHistoricalBlocks } from "./blocks.js";
import { precomputeCandidateRepresentations, type CandidatePrecomputeRecord } from "./candidates.js";
import { REDUCER_VERSIONS } from "./reducers/index.js";
import { readExactSourceEntry, readSourceEntryRange, sourceLedgerPath, updateSourceLedger, type SourceLedger, type SourceLedgerTransition } from "./source-ledger.js";
import type { CompactorConfig, HistoricalBlock, SessionEntryLike } from "./types.js";
import { hashText, stableStringify } from "./utils.js";
import { acquireDerivedStoreLock } from "./derived-store-lock.js";

export const CANDIDATE_SEGMENT_STORE_SUFFIX = ".chrono-candidate-segments-v1";
export const CANDIDATE_SEGMENT_SCHEMA_VERSION = 1;
export const DEFAULT_CANDIDATE_SEGMENT_SOURCE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_CANDIDATE_SEGMENT_ENTRIES = 2_048;
export const DEFAULT_CANDIDATE_SEGMENT_RECORDS = 4_096;
export const DEFAULT_CANDIDATE_SEGMENT_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_OPEN_PAIRS = 256;

export type CandidateStoreTransition = "new" | "exact-hit" | "append" | "rebuild-source-replacement" | "rebuild-source-truncation" | "rebuild-source-tail-rewrite" | "rebuild-config-change" | "rebuild-reducer-change" | "rebuild-store-corruption" | "recover-orphan-segments" | "stale-ready-snapshot";

export interface CandidateSegmentDescriptor {
  readonly sequence: number; readonly fileName: string; readonly sourceStartByte: number; readonly sourceEndByte: number;
  readonly firstSourceLine: number; readonly lastSourceLine: number; readonly sourceEntryCount: number; readonly sourceBlockCount: number;
  readonly persistentCandidateRecordCount: number; readonly segmentByteSize: number; readonly segmentContentHash: string;
  readonly firstSourceEntryId: string; readonly lastSourceEntryId: string; readonly safeBoundary: boolean;
}

export interface CandidateSegmentManifest {
  readonly schemaVersion: 1; readonly sourceFileIdentity: { readonly deviceId: string; readonly inodeId: string };
  readonly sourceSessionIdentity: string | null; readonly sourceLedgerSchemaVersion: 1; readonly sourceLedgerIntegrityState: string;
  readonly sourceBytePositionCovered: number; readonly sourceLinePositionCovered: number; readonly sourceEntryCountCovered: number;
  readonly candidateConfigHash: string; readonly reducerVersionHash: string;
  readonly segmentTargets: { readonly sourceBytes: number; readonly sourceEntries: number; readonly candidateRecords: number };
  readonly segments: readonly CandidateSegmentDescriptor[]; readonly openPairEntryIds: readonly string[];
  readonly manifestGeneration: number; readonly lastTransition: CandidateStoreTransition; readonly createdAt: string; readonly updatedAt: string;
  readonly manifestIntegrityHash: string;
}

interface CandidateSegmentFile {
  readonly schemaVersion: 1; readonly segmentIdentity: string; readonly sourceStartByte: number; readonly sourceEndByte: number;
  readonly firstSourceLine: number; readonly lastSourceLine: number; readonly records: readonly CandidatePrecomputeRecord[];
  readonly contentHash: string;
}

export interface CandidateStoreMetrics {
  readonly transition: CandidateStoreTransition; readonly sourceLedgerTransition: SourceLedgerTransition;
  readonly sourceBytesRead: number; readonly ledgerBytesRead: number; readonly ledgerBytesWritten: number;
  readonly entriesParsed: number; readonly blocksParsed: number; readonly segmentsCreated: number; readonly segmentsReused: number;
  readonly segmentsLoaded: number; readonly segmentBytesRead: number; readonly segmentBytesWritten: number;
  readonly persistentCandidateRecordsCreated: number; readonly persistentCandidateRecordsReused: number; readonly persistentCandidateRecordsLoaded: number;
  readonly candidateHits: number; readonly candidateMisses: number; readonly candidateIntegrityRejections: number;
  readonly futureSensitiveCandidatesComputed: number; readonly protectedBlocksSkipped: number; readonly updateElapsedMs: number;
  readonly maximumUpdateTimerDelayMs: number; readonly manifestGeneration: number; readonly sourceBytePositionCovered: number;
  readonly staleSourceEntries: number;
}

export interface CandidateSegmentStore {
  readonly sessionPath: string; readonly storePath: string; readonly ledgerPath: string; ledger?: SourceLedger;
  manifest?: CandidateSegmentManifest; readonly cache: Map<string, { bytes: number; records: readonly CandidatePrecomputeRecord[] }>;
  cacheBytes: number; readonly cacheByteLimit: number; metrics: CandidateStoreMetrics;
}

export interface CandidateStoreOptions {
  readonly storePath?: string; readonly ledgerPath?: string; readonly cacheBytes?: number;
  readonly targetSourceBytes?: number; readonly targetEntries?: number; readonly targetRecords?: number;
  readonly signal?: AbortSignal; readonly lockAcquired?: () => void | Promise<void>; readonly yieldNow?: () => Promise<void>;
}

function sha(value: Uint8Array | string): string { return createHash("sha256").update(value).digest("hex"); }
function manifestHash(value: Omit<CandidateSegmentManifest, "manifestIntegrityHash">): string { return sha(stableStringify(value)); }
function segmentHash(value: Omit<CandidateSegmentFile, "contentHash">): string { return sha(stableStringify(value)); }
function configHash(config: CompactorConfig): string { return hashText(stableStringify({ semanticMaxTokens: config.semanticMaxTokens, emergencyAllowAbsent: config.emergencyAllowAbsent })); }
function reducerHash(): string { return hashText(stableStringify({ schema: 1, reducers: REDUCER_VERSIONS, persistentCandidateSchema: 2 })); }
function emptyMetrics(transition: CandidateStoreTransition = "new", ledgerTransition: SourceLedgerTransition = "new"): CandidateStoreMetrics {
  return { transition, sourceLedgerTransition: ledgerTransition, sourceBytesRead: 0, ledgerBytesRead: 0, ledgerBytesWritten: 0,
    entriesParsed: 0, blocksParsed: 0, segmentsCreated: 0, segmentsReused: 0, segmentsLoaded: 0, segmentBytesRead: 0,
    segmentBytesWritten: 0, persistentCandidateRecordsCreated: 0, persistentCandidateRecordsReused: 0,
    persistentCandidateRecordsLoaded: 0, candidateHits: 0, candidateMisses: 0, candidateIntegrityRejections: 0,
    futureSensitiveCandidatesComputed: 0, protectedBlocksSkipped: 0, updateElapsedMs: 0, maximumUpdateTimerDelayMs: 0,
    manifestGeneration: 0, sourceBytePositionCovered: 0, staleSourceEntries: 0 };
}
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Candidate segment update aborted"); }
export function candidateSegmentStorePath(sessionPath: string): string { return `${sessionPath}${CANDIDATE_SEGMENT_STORE_SUFFIX}`; }
export function createCandidateSegmentStore(sessionPath: string, options: CandidateStoreOptions = {}): CandidateSegmentStore {
  return { sessionPath, storePath: options.storePath ?? candidateSegmentStorePath(sessionPath), ledgerPath: options.ledgerPath ?? sourceLedgerPath(sessionPath),
    cache: new Map(), cacheBytes: 0, cacheByteLimit: Math.max(1, Math.floor(options.cacheBytes ?? DEFAULT_CANDIDATE_SEGMENT_CACHE_BYTES)), metrics: emptyMetrics() };
}

function validManifest(value: unknown): value is CandidateSegmentManifest {
  if (!value || typeof value !== "object") return false; const item = value as Partial<CandidateSegmentManifest>;
  if (item.schemaVersion !== 1 || !item.sourceFileIdentity || typeof item.sourceFileIdentity.deviceId !== "string"
    || typeof item.sourceFileIdentity.inodeId !== "string" || !Array.isArray(item.segments) || typeof item.manifestIntegrityHash !== "string") return false;
  const { manifestIntegrityHash, ...base } = item as CandidateSegmentManifest;
  return manifestHash(base) === manifestIntegrityHash && item.segments.every((segment) => typeof segment.fileName === "string" && !segment.fileName.includes("/") && /^[a-f0-9]{64}$/.test(segment.segmentContentHash));
}

export async function loadCandidateSegmentManifest(store: CandidateSegmentStore): Promise<CandidateSegmentManifest | undefined> {
  try { const parsed = JSON.parse(await readFile(join(store.storePath, "manifest.json"), "utf8")) as unknown; if (!validManifest(parsed)) return undefined; store.manifest = parsed; return parsed; }
  catch { return undefined; }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700);
  return acquireDerivedStoreLock(join(path, ".writer.lock"));
}
async function atomicPrivateWrite(path: string, text: string): Promise<number> {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`; await writeFile(temp, text, { mode: 0o600 }); await chmod(temp, 0o600);
  try { await rename(temp, path); } finally { await rm(temp, { force: true }); } await chmod(path, 0o600); return Buffer.byteLength(text);
}
function entryToolCalls(entry: SessionEntryLike): string[] {
  const content = (entry as { message?: { content?: unknown } }).message?.content; if (!Array.isArray(content)) return [];
  return content.flatMap((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "toolCall" && typeof (part as { id?: unknown }).id === "string" ? [(part as { id: string }).id] : []);
}
function resultToolCall(entry: SessionEntryLike): string | undefined { const value = (entry as { message?: { toolCallId?: unknown } }).message?.toolCallId; return typeof value === "string" ? value : undefined; }
function reconcileOpenPairs(open: Map<string, string>, entries: readonly SessionEntryLike[]): void {
  for (const entry of entries) { for (const id of entryToolCalls(entry)) if (typeof entry.id === "string") open.set(id, entry.id); const result = resultToolCall(entry); if (result) open.delete(result); }
  while (open.size > MAX_OPEN_PAIRS) open.delete(open.keys().next().value as string);
}
async function contextEntries(store: CandidateSegmentStore, ids: readonly string[]): Promise<SessionEntryLike[]> {
  if (!store.ledger) return []; const output: SessionEntryLike[] = [];
  for (const id of ids.slice(-MAX_OPEN_PAIRS)) { try { output.push(JSON.parse((await readExactSourceEntry(store.sessionPath, store.ledger, id)).text) as SessionEntryLike); } catch {} }
  return output;
}
function withGlobalIndexes(blocks: readonly HistoricalBlock[], indexByEntry: ReadonlyMap<string, number>): HistoricalBlock[] {
  return blocks.map((block) => Object.freeze({ ...block, entryIndex: indexByEntry.get(block.entryId) ?? block.entryIndex }));
}
async function buildOneSegment(store: CandidateSegmentStore, config: CompactorConfig, start: number, end: number, sequence: number,
  openPairs: Map<string, string>, captured: ReadonlyMap<string, string>, signal?: AbortSignal): Promise<{ descriptor: CandidateSegmentDescriptor; openPairs: Map<string, string>; metrics: Partial<CandidateStoreMetrics> }> {
  throwIfAborted(signal); const selected = store.ledger!.sourceOrder.slice(start, end); const capturedAll = selected.every((item) => captured.has(item.entryId));
  const range = capturedAll ? { entries: selected.map((ledger) => ({ ledger, text: captured.get(ledger.entryId)! })), bytesRead: 0 }
    : await readSourceEntryRange(store.sessionPath, store.ledger!, start, end);
  const entries = range.entries.map((item) => JSON.parse(item.text) as SessionEntryLike); const context = await contextEntries(store, [...openPairs.values()]);
  const entryIds = new Set(entries.map((entry) => entry.id).filter((id): id is string => typeof id === "string"));
  const indexByEntry = new Map(store.ledger!.sourceOrder.map((entry, index) => [entry.entryId, index]));
  const parsed = withGlobalIndexes(parseHistoricalBlocks([...context, ...entries], { includeHistoricalCompactions: false, includeMetadata: false })
    .filter((block) => entryIds.has(block.entryId)), indexByEntry);
  const precomputed = await precomputeCandidateRepresentations(parsed, config, new Map(), signal); reconcileOpenPairs(openPairs, entries);
  const records = [...precomputed.records.values()]; const first = store.ledger!.sourceOrder[start]!; const last = store.ledger!.sourceOrder[end - 1]!;
  const identityBase = { schemaVersion: 1 as const, segmentIdentity: `${sequence}:${first.lineNumber}:${last.lineNumber}`,
    sourceStartByte: first.sourceByteOffset, sourceEndByte: last.nextSourceByteOffset, firstSourceLine: first.lineNumber,
    lastSourceLine: last.lineNumber, records };
  const contentHash = segmentHash(identityBase); const file: CandidateSegmentFile = { ...identityBase, contentHash };
  const text = `${stableStringify(file)}\n`; const fileName = `segment-${String(sequence).padStart(6, "0")}-${contentHash.slice(0, 16)}.json`;
  const segmentPath = join(store.storePath, fileName); let segmentBytesWritten = Buffer.byteLength(text);
  try { await writeFile(segmentPath, text, { mode: 0o600, flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(segmentPath, "utf8").catch(() => "");
    if (existing === text) segmentBytesWritten = 0;
    else {
      await rename(segmentPath, `${segmentPath}.corrupt-${randomBytes(6).toString("hex")}`);
      await writeFile(segmentPath, text, { mode: 0o600, flag: "wx" });
    }
  }
  await chmod(segmentPath, 0o600);
  return { descriptor: { sequence, fileName, sourceStartByte: first.sourceByteOffset, sourceEndByte: last.nextSourceByteOffset,
    firstSourceLine: first.lineNumber, lastSourceLine: last.lineNumber, sourceEntryCount: end - start, sourceBlockCount: parsed.length,
    persistentCandidateRecordCount: records.length, segmentByteSize: Buffer.byteLength(text), segmentContentHash: contentHash,
    firstSourceEntryId: first.entryId, lastSourceEntryId: last.entryId, safeBoundary: openPairs.size === 0 }, openPairs,
    metrics: { sourceBytesRead: range.bytesRead, entriesParsed: entries.length, blocksParsed: parsed.length, segmentsCreated: 1,
      segmentBytesWritten, persistentCandidateRecordsCreated: records.length, protectedBlocksSkipped: precomputed.skippedProtected } };
}
function addMetrics(base: CandidateStoreMetrics, patch: Partial<CandidateStoreMetrics>): CandidateStoreMetrics {
  const additive = new Set(["sourceBytesRead","ledgerBytesRead","ledgerBytesWritten","entriesParsed","blocksParsed","segmentsCreated","segmentsReused","segmentsLoaded","segmentBytesRead","segmentBytesWritten","persistentCandidateRecordsCreated","persistentCandidateRecordsReused","persistentCandidateRecordsLoaded","candidateHits","candidateMisses","candidateIntegrityRejections","futureSensitiveCandidatesComputed","protectedBlocksSkipped"]);
  const output = { ...base } as Record<string, unknown>; for (const [key, value] of Object.entries(patch)) output[key] = additive.has(key) ? Number(output[key] ?? 0) + Number(value ?? 0) : value;
  return output as unknown as CandidateStoreMetrics;
}
function transitionFromLedger(value: SourceLedgerTransition): CandidateStoreTransition { if (value === "rebuild-truncation") return "rebuild-source-truncation"; if (value === "rebuild-tail-rewrite") return "rebuild-source-tail-rewrite"; if (value === "rebuild-replacement") return "rebuild-source-replacement"; return value === "append" ? "append" : value === "exact-hit" ? "exact-hit" : "new"; }

export async function updateCandidateSegmentStore(store: CandidateSegmentStore, config: CompactorConfig, options: CandidateStoreOptions = {}): Promise<CandidateStoreMetrics> {
  const started = performance.now(); const scheduled = performance.now(); let timerAt = scheduled; const timer = new Promise<void>((resolve) => setTimeout(() => { timerAt = performance.now(); resolve(); }, 0));
  const release = await acquireLock(store.storePath); try {
    await options.lockAcquired?.(); throwIfAborted(options.signal); const old = store.manifest ?? await loadCandidateSegmentManifest(store);
    const captured = new Map<string,string>();
    store.ledger = await updateSourceLedger(store.sessionPath, store.ledger, { sidecarPath: store.ledgerPath,
      entryParsed: (entry) => captured.set(entry.entryId, entry.text) }); const lm = store.ledger.metrics;
    let transition = transitionFromLedger(lm.transition); const desiredConfig = configHash(config); const desiredReducers = reducerHash();
    if (old && old.candidateConfigHash !== desiredConfig) transition = "rebuild-config-change";
    else if (old && old.reducerVersionHash !== desiredReducers) transition = "rebuild-reducer-change";
    else if (old && store.metrics.candidateIntegrityRejections > 0) transition = "rebuild-store-corruption";
    else if (old && (old.sourceFileIdentity.deviceId !== store.ledger.sourceIdentity.deviceId || old.sourceFileIdentity.inodeId !== store.ledger.sourceIdentity.inodeId)) transition = "rebuild-source-replacement";
    const exact = old && transition === "exact-hit" && old.sourceBytePositionCovered === store.ledger.checkpoint.sourceBytePosition && old.sourceEntryCountCovered === store.ledger.sourceOrder.length;
    if (exact) { store.manifest = old; await timer; store.metrics = { ...emptyMetrics("exact-hit", lm.transition), sourceBytesRead: lm.sourceBytesRead,
      ledgerBytesRead: lm.ledgerBytesRead, ledgerBytesWritten: lm.ledgerBytesWritten, segmentsReused: old.segments.length,
      persistentCandidateRecordsReused: old.segments.reduce((sum, item) => sum + item.persistentCandidateRecordCount, 0), updateElapsedMs: performance.now() - started,
      maximumUpdateTimerDelayMs: Math.max(0, timerAt - scheduled), manifestGeneration: old.manifestGeneration, sourceBytePositionCovered: old.sourceBytePositionCovered, staleSourceEntries: 0 }; return store.metrics; }
    const append = old && transition === "append" && old.sourceEntryCountCovered <= store.ledger.sourceOrder.length;
    // Keep the last published manifest and its immutable segments readable while a rebuild is in progress.
    // Orphan cleanup is an explicit maintenance action after readers have released old snapshots.
    const existing = append ? [...old.segments] : []; const startIndex = append ? old.sourceEntryCountCovered : 0;
    const targets = { sourceBytes: Math.max(1, Math.floor(options.targetSourceBytes ?? DEFAULT_CANDIDATE_SEGMENT_SOURCE_BYTES)),
      sourceEntries: Math.max(1, Math.floor(options.targetEntries ?? DEFAULT_CANDIDATE_SEGMENT_ENTRIES)), candidateRecords: Math.max(1, Math.floor(options.targetRecords ?? DEFAULT_CANDIDATE_SEGMENT_RECORDS)) };
    const openPairs = new Map<string,string>(); if (append) for (const entryId of old.openPairEntryIds) { try { const entry = JSON.parse((await readExactSourceEntry(store.sessionPath, store.ledger, entryId)).text) as SessionEntryLike; for (const id of entryToolCalls(entry)) openPairs.set(id, entryId); } catch {} }
    let metrics = { ...emptyMetrics(append ? "append" : transition, lm.transition), sourceBytesRead: lm.sourceBytesRead,
      ledgerBytesRead: lm.ledgerBytesRead, ledgerBytesWritten: lm.ledgerBytesWritten, segmentsReused: existing.length,
      persistentCandidateRecordsReused: existing.reduce((sum, item) => sum + item.persistentCandidateRecordCount, 0) };
    const created: CandidateSegmentDescriptor[] = []; let cursor = startIndex; let sequence = existing.length + 1;
    while (cursor < store.ledger.sourceOrder.length) {
      throwIfAborted(options.signal); let end = cursor + 1; const first = store.ledger.sourceOrder[cursor]!;
      while (end < store.ledger.sourceOrder.length && end - cursor < targets.sourceEntries
        && store.ledger.sourceOrder[end]!.nextSourceByteOffset - first.sourceByteOffset <= targets.sourceBytes) end += 1;
      const built = await buildOneSegment(store, config, cursor, end, sequence, openPairs, captured, options.signal); created.push(built.descriptor); metrics = addMetrics(metrics, built.metrics);
      cursor = end; sequence += 1; await (options.yieldNow ?? (() => new Promise<void>((resolve) => setImmediate(resolve))))();
    }
    const now = new Date().toISOString(); const base: Omit<CandidateSegmentManifest,"manifestIntegrityHash"> = { schemaVersion: 1,
      sourceFileIdentity: store.ledger.sourceIdentity, sourceSessionIdentity: store.ledger.sourceSessionIdentity, sourceLedgerSchemaVersion: 1,
      sourceLedgerIntegrityState: store.ledger.integrityChainState, sourceBytePositionCovered: store.ledger.checkpoint.sourceBytePosition,
      sourceLinePositionCovered: store.ledger.sourceOrder.at(-1)?.lineNumber ?? 1, sourceEntryCountCovered: store.ledger.sourceOrder.length,
      candidateConfigHash: desiredConfig, reducerVersionHash: desiredReducers, segmentTargets: targets, segments: [...existing, ...created],
      openPairEntryIds: [...openPairs.values()], manifestGeneration: (old?.manifestGeneration ?? 0) + 1, lastTransition: append ? "append" : transition,
      createdAt: old?.createdAt ?? now, updatedAt: now };
    const manifest: CandidateSegmentManifest = { ...base, manifestIntegrityHash: manifestHash(base) };
    await atomicPrivateWrite(join(store.storePath,"manifest.json"), `${stableStringify(manifest,2)}\n`); store.manifest = manifest; await timer;
    metrics = { ...metrics, updateElapsedMs: performance.now() - started, maximumUpdateTimerDelayMs: Math.max(0,timerAt-scheduled),
      manifestGeneration: manifest.manifestGeneration, sourceBytePositionCovered: manifest.sourceBytePositionCovered,
      staleSourceEntries: Math.max(0,store.ledger.sourceOrder.length-manifest.sourceEntryCountCovered) }; store.metrics = metrics; return metrics;
  } finally { await release(); }
}

function validSegment(value: unknown, descriptor: CandidateSegmentDescriptor): value is CandidateSegmentFile {
  if (!value || typeof value !== "object") return false; const item = value as Partial<CandidateSegmentFile>;
  if (item.schemaVersion !== 1 || !Array.isArray(item.records) || item.contentHash !== descriptor.segmentContentHash) return false;
  const { contentHash, ...base } = item as CandidateSegmentFile; if (segmentHash(base) !== contentHash) return false;
  return item.records.every((record) => record && typeof record.blockId === "string" && typeof record.key === "string" && typeof record.integrityHash === "string" && record.integrityHash.length > 0
    && (record.dependency === "source-local" || record.dependency === "pairing-dependent") && Array.isArray(record.candidates)
    && record.candidates.every((candidate: CandidatePrecomputeRecord["candidates"][number]) => candidate.level !== "raw" && candidate.level !== "normalized" && candidate.level !== "semantic" && candidate.reducer !== "llm-semantic"));
}
async function loadSegment(store: CandidateSegmentStore, descriptor: CandidateSegmentDescriptor): Promise<readonly CandidatePrecomputeRecord[] | undefined> {
  const cached = store.cache.get(descriptor.fileName); if (cached) { store.cache.delete(descriptor.fileName); store.cache.set(descriptor.fileName,cached); return cached.records; }
  try { const text = await readFile(join(store.storePath,descriptor.fileName),"utf8"); const parsed = JSON.parse(text) as unknown;
    if (!validSegment(parsed,descriptor)) { store.metrics = addMetrics(store.metrics,{candidateIntegrityRejections:1}); return undefined; }
    const bytes = Buffer.byteLength(text); while (store.cacheBytes + bytes > store.cacheByteLimit && store.cache.size > 0) { const first = store.cache.entries().next().value as [string,{bytes:number}]|undefined; if (!first) break; store.cache.delete(first[0]); store.cacheBytes -= first[1].bytes; }
    if (bytes <= store.cacheByteLimit) { store.cache.set(descriptor.fileName,{bytes,records:parsed.records}); store.cacheBytes += bytes; }
    store.metrics = addMetrics(store.metrics,{segmentsLoaded:1,segmentBytesRead:bytes,persistentCandidateRecordsLoaded:parsed.records.length}); return parsed.records;
  } catch { store.metrics = addMetrics(store.metrics,{candidateIntegrityRejections:1}); return undefined; }
}

export async function loadCandidateSegmentRecords(store: CandidateSegmentStore, descriptor: CandidateSegmentDescriptor): Promise<readonly CandidatePrecomputeRecord[] | undefined> {
  return loadSegment(store, descriptor);
}

export async function loadCandidateRecordsForBranch(store: CandidateSegmentStore, branchEntryIds: readonly string[]): Promise<ReadonlyMap<string,CandidatePrecomputeRecord>> {
  const manifest = store.manifest ?? await loadCandidateSegmentManifest(store); if (!manifest || !store.ledger) return new Map();
  const wanted = new Set(branchEntryIds); const indexes = branchEntryIds.flatMap((id) => { const item=store.ledger!.entryById.get(id); return item ? [item.lineNumber] : []; });
  if (indexes.length===0) return new Map(); const first=Math.min(...indexes), last=Math.max(...indexes); const result=new Map<string,CandidatePrecomputeRecord>();
  for (const descriptor of manifest.segments) { if (descriptor.lastSourceLine<first || descriptor.firstSourceLine>last) continue; const records=await loadSegment(store,descriptor); if (!records) continue;
    for (const record of records) { const refs=record.candidates[0]?.sourceRefs ?? []; if (refs.some((ref)=>wanted.has(ref.entryId))) result.set(record.blockId,record); }
  }
  store.metrics=addMetrics(store.metrics,{candidateHits:result.size,candidateMisses:Math.max(0,branchEntryIds.length-result.size)}); return result;
}

export async function cleanupOrphanCandidateSegments(store: CandidateSegmentStore): Promise<number> {
  const release = await acquireLock(store.storePath); try {
    const manifest = await loadCandidateSegmentManifest(store); if (!manifest) return 0;
    const keep=new Set(manifest.segments.map((item)=>item.fileName)); let removed=0;
    for (const name of await readdir(store.storePath)) if (name.startsWith("segment-")&&!keep.has(name)) { await rm(join(store.storePath,name),{force:true}); removed+=1; }
    return removed;
  } finally { await release(); }
}

export async function candidateStoreBytes(store: CandidateSegmentStore): Promise<number> { let total=0; try { for (const name of await readdir(store.storePath)) { try { total+=(await stat(join(store.storePath,name))).size; } catch {} } } catch {} return total; }
