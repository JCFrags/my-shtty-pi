import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { isCapsuleCatalogView, isScopedBodySourceRef, sourceRefWithinViewBounds, type CapsuleWorkerResponse, type ReducerEnvelope,
  type ScopedBodySourceRef, type ScopedRawSourceRef } from "./capsule-contract.js";
import { bodySource, type CatalogBlockShape } from "./capsule-derive.js";
import { executeCapsuleRequest } from "./capsule-store.js";
import type { CatalogResponse } from "./catalog-contract.js";
import { executeCatalogStoreRequest } from "./catalog-store.js";
import { canonicalJson } from "./capsule-segment.js";
import { stableStringify } from "./utils.js";
import { CatalogSqlite, type SqlRow, type SqlValue } from "./catalog-sqlite.js";
import {
  EPISODE_STATE_LIMITS,
  EPISODE_STATE_RULESET_VERSION,
  EPISODE_STATE_SCHEMA_VERSION,
  isEpisodeStateRequest,
  type EpisodeStateAfter,
  type EpisodeStateBatchCursor,
  type EpisodeStateBodyCheckpoint,
  type EpisodeStateRequest,
  type EpisodeStateResponse,
  type EpisodeStateSelection,
  type EpisodeStateSelectionItem,
  type EpisodeStateSelectionMember,
} from "./episode-state-contract.js";
import { reduceEpisodeStateEnvelope, type ReducedEpisodeEvent, type VerifiedEventStructuralFacts } from "./episode-state-reducer.js";
import { withRuntimeMutex } from "./worker-runtime-mutex.js";

const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const num = (row: SqlRow, key: string): number => Number(row[key]);
const str = (row: SqlRow, key: string): string => String(row[key]);
const sourceKey = (source: ScopedBodySourceRef | ScopedRawSourceRef): string => sha(canonicalJson(source));
const lineage = (request: EpisodeStateRequest): string => sha(canonicalJson({ branchKey: request.view.branchKey, segments: request.view.segments.map(item => item.segment) }));
const viewHash = (request: EpisodeStateRequest): string => sha(canonicalJson(request.view));
const schema = [
  "CREATE TABLE meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, identity TEXT NOT NULL, searchRoute TEXT NOT NULL, capsuleRoute TEXT NOT NULL, catalogRoute TEXT NOT NULL, ruleset TEXT NOT NULL, generation INTEGER NOT NULL)",
  "CREATE TABLE cuts (lineage TEXT NOT NULL, eventSeq INTEGER NOT NULL, descriptor INTEGER NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY(lineage,eventSeq,descriptor)) WITHOUT ROWID",
  "CREATE TABLE coverage (lineage TEXT NOT NULL, eventSeq INTEGER NOT NULL, descriptor INTEGER NOT NULL, generation INTEGER NOT NULL, restrictionGap INTEGER NOT NULL, openWorkGap INTEGER NOT NULL, optionalGap INTEGER NOT NULL, PRIMARY KEY(lineage,eventSeq,descriptor)) WITHOUT ROWID",
  "CREATE INDEX coverage_restriction ON coverage(lineage,restrictionGap,eventSeq,generation)",
  "CREATE INDEX coverage_work ON coverage(lineage,openWorkGap,eventSeq,generation)",
  "CREATE INDEX coverage_optional ON coverage(lineage,optionalGap,eventSeq,generation)",
  "CREATE TABLE heads (lineage TEXT PRIMARY KEY, view TEXT NOT NULL, afterEventSeq INTEGER NOT NULL, afterDescriptor INTEGER NOT NULL, metadataAfterEventSeq INTEGER NOT NULL, generation INTEGER NOT NULL, complete INTEGER NOT NULL, metadataComplete INTEGER NOT NULL, partialCount INTEGER NOT NULL)",
  "CREATE TABLE episodes (lineage TEXT NOT NULL, episodeKey TEXT NOT NULL, startEventSeq INTEGER NOT NULL, startDescriptor INTEGER NOT NULL, endEventSeq INTEGER NOT NULL, endDescriptor INTEGER NOT NULL, open INTEGER NOT NULL, memberCount INTEGER NOT NULL, objective TEXT NOT NULL, objectiveEvidence TEXT NOT NULL, createdGeneration INTEGER NOT NULL, PRIMARY KEY(lineage,episodeKey,createdGeneration)) WITHOUT ROWID",
  "CREATE INDEX episodes_page ON episodes(lineage,createdGeneration,startEventSeq,startDescriptor,episodeKey)",
  "CREATE TABLE episode_membership (lineage TEXT NOT NULL, episodeKey TEXT NOT NULL, eventSeq INTEGER NOT NULL, descriptor INTEGER NOT NULL, sourceKey TEXT NOT NULL, source TEXT NOT NULL, cue TEXT NOT NULL, createdGeneration INTEGER NOT NULL, PRIMARY KEY(lineage,episodeKey,eventSeq,descriptor,sourceKey)) WITHOUT ROWID",
  "CREATE INDEX episode_member_source ON episode_membership(lineage,sourceKey,episodeKey)",
  "CREATE VIRTUAL TABLE episode_fts USING fts5(lineage UNINDEXED,episodeKey UNINDEXED,body,tokenize='unicode61')",
  "CREATE VIRTUAL TABLE episode_member_fts USING fts5(lineage UNINDEXED,episodeKey UNINDEXED,sourceKey UNINDEXED,body,tokenize='unicode61')",
  "CREATE TABLE state_items (lineage TEXT NOT NULL, stableKey TEXT NOT NULL, propositionKey TEXT NOT NULL, spanKey TEXT NOT NULL, subject TEXT NOT NULL, revision TEXT NOT NULL, kind TEXT NOT NULL, authority TEXT NOT NULL, confidence TEXT NOT NULL, status TEXT NOT NULL, evidence TEXT NOT NULL, eventSeq INTEGER NOT NULL, descriptor INTEGER NOT NULL, createdGeneration INTEGER NOT NULL, supersededGeneration INTEGER, resolutionEvidence TEXT, PRIMARY KEY(lineage,stableKey)) WITHOUT ROWID",
  "CREATE INDEX state_page ON state_items(lineage,createdGeneration,eventSeq,descriptor,stableKey,supersededGeneration)",
  "CREATE INDEX state_transition ON state_items(lineage,propositionKey,authority,status,createdGeneration,supersededGeneration)",
  "CREATE INDEX state_compose ON state_items(lineage,kind,eventSeq DESC,descriptor DESC,stableKey DESC)",
  "CREATE INDEX state_compose_authority ON state_items(lineage,kind,authority,eventSeq DESC,descriptor DESC,stableKey DESC)",
  "CREATE TABLE large_bodies (lineage TEXT PRIMARY KEY, envelope TEXT NOT NULL, structural TEXT NOT NULL, nextDecoded INTEGER NOT NULL, restrictionGap INTEGER NOT NULL, openWorkGap INTEGER NOT NULL, partial INTEGER NOT NULL) WITHOUT ROWID",
  "CREATE VIRTUAL TABLE state_fts USING fts5(lineage UNINDEXED,stableKey UNINDEXED,body,tokenize='unicode61')",
  "CREATE TABLE resources (lineage TEXT NOT NULL, stableKey TEXT NOT NULL, resourceKind TEXT NOT NULL, resourceKey TEXT NOT NULL, relation TEXT NOT NULL, revision TEXT, revisionBasis TEXT NOT NULL, currentRevision TEXT NOT NULL, knownThrough INTEGER NOT NULL, failed INTEGER, executionOutcome TEXT NOT NULL, evidence TEXT NOT NULL, eventSeq INTEGER NOT NULL, descriptor INTEGER NOT NULL, createdGeneration INTEGER NOT NULL, supersededGeneration INTEGER, PRIMARY KEY(lineage,stableKey)) WITHOUT ROWID",
  "CREATE INDEX resource_page ON resources(lineage,createdGeneration,eventSeq,descriptor,stableKey,supersededGeneration)",
  "CREATE INDEX resource_current ON resources(lineage,resourceKey,revision,createdGeneration,supersededGeneration)",
  "CREATE VIRTUAL TABLE resource_fts USING fts5(lineage UNINDEXED,stableKey UNINDEXED,body,tokenize='unicode61')",
  "CREATE TABLE memory_items (lineage TEXT NOT NULL, stableKey TEXT NOT NULL, memoryId TEXT NOT NULL, action TEXT NOT NULL, text TEXT NOT NULL, scope TEXT NOT NULL, confidence REAL NOT NULL, sourceRef TEXT NOT NULL, eventHash TEXT NOT NULL, state TEXT NOT NULL, evidence TEXT NOT NULL, eventSeq INTEGER NOT NULL, createdGeneration INTEGER NOT NULL, supersededGeneration INTEGER, PRIMARY KEY(lineage,stableKey)) WITHOUT ROWID",
  "CREATE INDEX memory_page ON memory_items(lineage,createdGeneration,eventSeq,stableKey,supersededGeneration,state)",
  "CREATE INDEX memory_current ON memory_items(lineage,memoryId,createdGeneration,supersededGeneration)",
  "CREATE VIRTUAL TABLE memory_fts USING fts5(lineage UNINDEXED,stableKey UNINDEXED,body,tokenize='unicode61')",
  "CREATE TABLE retention_hints (lineage TEXT NOT NULL, stableKey TEXT NOT NULL, data TEXT NOT NULL, evidence TEXT NOT NULL, eventSeq INTEGER NOT NULL, createdGeneration INTEGER NOT NULL, PRIMARY KEY(lineage,stableKey)) WITHOUT ROWID",
  "CREATE INDEX retention_page ON retention_hints(lineage,createdGeneration,eventSeq,stableKey)",
  "CREATE VIRTUAL TABLE retention_fts USING fts5(lineage UNINDEXED,stableKey UNINDEXED,body,tokenize='unicode61')",
];

type CapsuleExecutor = (request: unknown) => Promise<CapsuleWorkerResponse>;
type CatalogExecutor = (request: unknown) => Promise<CatalogResponse>;
export interface EpisodeStateExecutionOptions { readonly capsuleExecutor?: CapsuleExecutor; readonly catalogExecutor?: CatalogExecutor }
class Store {
  statements = 0;
  constructor(readonly db: CatalogSqlite, readonly request: EpisodeStateRequest) {}
  get(sql: string, ...values: SqlValue[]): SqlRow | undefined { this.statements++; return this.db.prepare(sql).get(...values); }
  run(sql: string, ...values: SqlValue[]): void { this.statements++; this.db.prepare(sql).run(...values); }
  rows(sql: string, maximum: number, ...values: SqlValue[]): SqlRow[] { this.statements++; return [...this.db.prepare(sql).iterate(maximum, ...values)]; }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn); }
  validate(bootstrap: boolean): void {
    const exists = this.get("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'");
    if (!exists) { if (bootstrap && !this.get("SELECT name FROM sqlite_master LIMIT 1")) return; fail("search-v3-state-version-mismatch"); }
    const meta = this.get("SELECT * FROM meta WHERE singleton=1");
    if (!meta || num(meta, "version") !== EPISODE_STATE_SCHEMA_VERSION || str(meta, "identity") !== canonicalJson(this.request.identity)
      || str(meta, "searchRoute") !== this.request.searchDirectory || str(meta, "capsuleRoute") !== this.request.capsuleDirectory
      || str(meta, "catalogRoute") !== this.request.catalogDirectory || str(meta, "ruleset") !== EPISODE_STATE_RULESET_VERSION)
      fail("search-v3-state-store-mismatch");
    for (const sql of schema) {
      const parts = sql.split(" "), name = parts[1] === "VIRTUAL" ? parts[3]! : parts[2]!;
      if (this.get("SELECT sql FROM sqlite_master WHERE name=?", name)?.sql !== sql) fail("search-v3-state-version-mismatch");
    }
  }
  initialize(): void {
    this.transaction(() => {
      this.validate(true);
      if (!this.get("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")) {
        for (const sql of schema) this.run(sql);
        this.run("INSERT INTO meta VALUES(1,?,?,?,?,?,?,0)", EPISODE_STATE_SCHEMA_VERSION, canonicalJson(this.request.identity),
          this.request.searchDirectory, this.request.capsuleDirectory, this.request.catalogDirectory, EPISODE_STATE_RULESET_VERSION);
      }
    });
  }
}
function prepareDirectory(path: string): void {
  const uid = process.getuid?.();
  if (uid === undefined || resolve(path) !== path || path === "/") fail("search-v3-state-storage-unsafe");
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o7777) !== 0o700) fail("search-v3-state-storage-unsafe");
}
async function capsuleCall(request: EpisodeStateRequest, executor: CapsuleExecutor, budget: { bytes: number }, extra: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await executor({ v: 1, derivedDirectory: request.capsuleDirectory, catalogDirectory: request.catalogDirectory,
    identity: request.identity.capsule, ...extra });
  budget.bytes += response.sourceBytes;
  if (budget.bytes > EPISODE_STATE_LIMITS.sourceBytesPerJob) fail("search-v3-state-source-budget");
  if (!response.ok) return fail(response.code === "capsule-source-changed" ? "search-v3-state-source-changed" : "search-v3-state-capsule-unavailable");
  return response.result;
}
async function body(request: EpisodeStateRequest, envelope: ReducerEnvelope, executor: CapsuleExecutor, budget: { bytes: number }): Promise<string | undefined> {
  const length = envelope.source.decodedUtf16.end - envelope.source.decodedUtf16.start;
  if (length > EPISODE_STATE_LIMITS.wholeBodyUtf16Units) return undefined;
  if (length === 0) return "";
  const result = await capsuleCall(request, executor, budget, { op: "chunkRange", view: request.view, source: envelope.source,
    decodedStart: envelope.source.decodedUtf16.start, decodedLength: length, limit: 2 });
  const bytes = Buffer.from(String(result.data), "base64"), text = bytes.toString("utf16le");
  if (bytes.length !== length * 2 || text.length !== length) fail("search-v3-state-source-invalid");
  return text;
}
interface CatalogEventRow { seq: number; shardKey: string; ordinal: number; rawStart: number; rawEnd: number; metadata: Record<string, unknown> }
async function catalogCall(request: EpisodeStateRequest, executor: CatalogExecutor, budget: { bytes: number }, extra: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await executor({ v: 1, catalogDirectory: request.catalogDirectory, sessionKey: request.identity.capsule.sessionKey, ...extra });
  budget.bytes += response.sourceBytes;
  if (budget.bytes > EPISODE_STATE_LIMITS.sourceBytesPerJob) fail("search-v3-state-source-budget");
  if (!response.ok) return fail(response.code === "catalog-source-changed" ? "search-v3-state-source-changed" : "search-v3-state-catalog-unavailable");
  return response.result;
}
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function rawFact(request: EpisodeStateRequest, envelope: ReducerEnvelope, event: CatalogEventRow, rawText: string,
  field: string, value: string | number | boolean): { value: any; source: ScopedRawSourceRef } | undefined {
  const encoded = JSON.stringify(value), expression = new RegExp(`"${escapeRegex(field)}"\\s*:\\s*${escapeRegex(encoded)}`, "gu");
  const matches = [...rawText.matchAll(expression)];
  if (matches.length !== 1) return undefined;
  const tokenAt = matches[0]!.index + matches[0]![0].lastIndexOf(encoded), byteAt = Buffer.byteLength(rawText.slice(0, tokenAt)), tokenBytes = Buffer.from(encoded);
  const segment = (request.view.segments.find(item => envelope.source.eventSeq <= item.cut) ?? fail("search-v3-state-source-invalid")).segment;
  const source: ScopedRawSourceRef = { catalogStoreKey: request.identity.capsule.catalogStoreKey, sessionKey: request.identity.capsule.sessionKey,
    catalogGeneration: request.identity.capsule.catalogGeneration, shardKey: event.shardKey, segment, eventSeq: event.seq, ordinal: event.ordinal,
    descriptor: envelope.source.descriptor, ...(envelope.source.blockIndex === undefined ? {} : { blockIndex: envelope.source.blockIndex }), field,
    raw: { start: event.rawStart + byteAt, end: event.rawStart + byteAt + tokenBytes.length }, coordinateKind: "raw-json",
    rawHashAlgorithm: "sha256-bytes-v1", rawHash: createHash("sha256").update(tokenBytes).digest("hex") };
  return { value, source };
}
async function exactStructural(request: EpisodeStateRequest, envelope: ReducerEnvelope, executor: CatalogExecutor,
  budget: { bytes: number }): Promise<VerifiedEventStructuralFacts | undefined> {
  const page = await catalogCall(request, executor, budget, { op: "page", view: request.view, after: Math.max(0, envelope.source.eventSeq - 1), limit: 1 });
  const candidate = page.events?.[0] as CatalogEventRow | undefined;
  if (!candidate || candidate.seq !== envelope.source.eventSeq || !Number.isSafeInteger(candidate.rawStart) || !Number.isSafeInteger(candidate.rawEnd)) return fail("search-v3-state-source-invalid");
  const event: CatalogEventRow = candidate;
  const catalogFacts = (): VerifiedEventStructuralFacts => ({
    ...(typeof event.metadata.role === "string" ? { role: { value: event.metadata.role } } : {}),
    ...(typeof event.metadata.toolName === "string" ? { toolName: { value: event.metadata.toolName } } : {}),
  });
  const length = event.rawEnd - event.rawStart;
  if (length < 1 || length > 64 * 1024) return Object.keys(catalogFacts()).length ? catalogFacts() : undefined;
  const raw = await catalogCall(request, executor, budget, { op: "raw", view: request.view, eventSeq: event.seq, offset: event.rawStart, length });
  const bytes = Buffer.from(String(raw.data), "base64");
  if (bytes.length !== length) fail("search-v3-state-source-invalid");
  let parsed: any; try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return undefined; }
  const message = parsed?.message;
  if (!message || typeof message !== "object") return undefined;
  const rawText = bytes.toString("utf8"), block = Array.isArray(message.content) && envelope.source.blockIndex !== undefined ? message.content[envelope.source.blockIndex] : undefined;
  const role = typeof message.role === "string" ? rawFact(request, envelope, event, rawText, "role", message.role) : undefined;
  const toolValue = typeof block?.name === "string" ? block.name : typeof message.toolName === "string" ? message.toolName : undefined;
  const toolName = toolValue === undefined ? undefined : rawFact(request, envelope, event, rawText, typeof block?.name === "string" ? "name" : "toolName", toolValue);
  const errorValue = typeof message.isError === "boolean" ? message.isError : typeof block?.isError === "boolean" ? block.isError : undefined;
  const isError = errorValue === undefined ? undefined : rawFact(request, envelope, event, rawText, "isError", errorValue);
  const exitValue = typeof message.exitCode === "number" ? message.exitCode : typeof block?.exitCode === "number" ? block.exitCode : undefined;
  const exitCode = exitValue === undefined ? undefined : rawFact(request, envelope, event, rawText, "exitCode", exitValue);
  const cancelledValue = typeof message.cancelled === "boolean" ? message.cancelled : typeof block?.cancelled === "boolean" ? block.cancelled : undefined;
  const cancelled = cancelledValue === undefined ? undefined : rawFact(request, envelope, event, rawText, "cancelled", cancelledValue);
  const facts = catalogFacts();
  return { ...(facts.role ? { role: facts.role } : {}), ...(facts.toolName ? { toolName: facts.toolName } : {}),
    ...(role ? { role } : {}), ...(toolName ? { toolName } : {}), ...(isError ? { isError } : {}), ...(exitCode ? { exitCode } : {}), ...(cancelled ? { cancelled } : {}) };
}
interface MetadataProgress { afterEventSeq: number; complete: boolean; processedEvents: number; acceptedMemoryEvents: number; acceptedRetentionHints: number; partial: number }
const memoryActions = new Set(["remember", "update", "promote", "touch", "demote", "forget"]);
function rawEventSource(request: EpisodeStateRequest, event: CatalogEventRow, bytes: Buffer): ScopedRawSourceRef {
  const segment = (request.view.segments.find(item => event.seq <= item.cut) ?? fail("search-v3-state-source-invalid")).segment;
  return { catalogStoreKey: request.identity.capsule.catalogStoreKey, sessionKey: request.identity.capsule.sessionKey,
    catalogGeneration: request.identity.capsule.catalogGeneration, shardKey: event.shardKey, segment, eventSeq: event.seq,
    ordinal: event.ordinal, descriptor: 0, field: "data", raw: { start: event.rawStart, end: event.rawEnd }, coordinateKind: "raw-json",
    rawHashAlgorithm: "sha256-bytes-v1", rawHash: createHash("sha256").update(bytes).digest("hex") };
}
function validMemoryEvent(data: any, previousHash: string): boolean {
  if (!data || data.schemaVersion !== 2 || typeof data.eventId !== "string" || typeof data.memoryId !== "string"
    || !memoryActions.has(data.action) || typeof data.timestamp !== "string" || !Number.isSafeInteger(data.turn) || data.turn < 0
    || data.previousEventHash !== previousHash || typeof data.eventHash !== "string" || typeof data.sourceRef !== "string"
    || typeof data.scope !== "string" || data.authority !== "ordinary" || !/^(?:memory-tool|history-recall):[^\s]{1,1024}$/u.test(data.sourceRef) || typeof data.confidence !== "number"
    || !Number.isFinite(data.confidence) || data.confidence < 0 || data.confidence > 1) return false;
  if ((data.action === "remember" || data.action === "update") && (typeof data.text !== "string" || !data.text.trim())) return false;
  const { eventHash, ...payload } = data;
  return createHash("sha256").update(stableStringify(payload)).digest("hex").slice(0, 20) === eventHash;
}
function validRetentionHint(data: any): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const allowed = new Set(["currentUnresolvedWork", "preserveExact", "olderEvidenceLikelyNeeded", "completedRangesSafeToCompress", "abandonedApproaches"]);
  return Object.keys(data).length > 0 && Object.keys(data).every(key => allowed.has(key) && typeof data[key] === "string" && data[key].trim().length > 0 && data[key].length <= 4096);
}
function attachMetadataMember(store: Store, request: EpisodeStateRequest, eventSeq: number, source: ScopedRawSourceRef, cue: string, generation: number): boolean {
  const line = lineage(request);
  const episode = store.get("SELECT e.* FROM episodes e WHERE e.lineage=? AND e.startEventSeq<=? AND e.createdGeneration<=? AND e.createdGeneration=(SELECT MAX(v.createdGeneration) FROM episodes v WHERE v.lineage=e.lineage AND v.episodeKey=e.episodeKey AND v.createdGeneration<=?) ORDER BY e.startEventSeq DESC,e.startDescriptor DESC LIMIT 1", line, eventSeq, generation, generation);
  if (episode) {
    const memberSourceKey = sourceKey(source), episodeKey = str(episode, "episodeKey"), boundedCue = cue.slice(0, 2048);
    const exists = store.get("SELECT 1 AS found FROM episode_membership WHERE lineage=? AND episodeKey=? AND eventSeq=? AND descriptor=0 AND sourceKey=?", line, episodeKey, eventSeq, memberSourceKey);
    if (!exists) {
      store.run("INSERT INTO episode_membership VALUES(?,?,?,?,?,?,?,?)", line, episodeKey, eventSeq, 0, memberSourceKey, canonicalJson(source), boundedCue, generation);
      store.run("INSERT INTO episode_member_fts(lineage,episodeKey,sourceKey,body) VALUES(?,?,?,?)", line, episodeKey, memberSourceKey, boundedCue);
      if (num(episode, "createdGeneration") === generation) store.run("UPDATE episodes SET memberCount=memberCount+1 WHERE lineage=? AND episodeKey=? AND createdGeneration=?", line, episodeKey, generation);
      else store.run("INSERT INTO episodes VALUES(?,?,?,?,?,?,?,?,?,?,?)", line, episodeKey, num(episode, "startEventSeq"), num(episode, "startDescriptor"),
        Math.max(num(episode, "endEventSeq"), eventSeq), num(episode, "endDescriptor"), num(episode, "open"), num(episode, "memberCount") + 1,
        str(episode, "objective"), str(episode, "objectiveEvidence"), generation);
    }
    return true;
  }
  return false;
}
function insertMemoryMetadata(store: Store, request: EpisodeStateRequest, data: any, source: ScopedRawSourceRef, generation: number): boolean {
  const line = lineage(request), prior = store.get("SELECT * FROM memory_items WHERE lineage=? AND memoryId=? AND supersededGeneration IS NULL ORDER BY createdGeneration DESC LIMIT 1", line, data.memoryId);
  if ((data.action === "remember") === Boolean(prior)) return false;
  const text = typeof data.text === "string" ? data.text.trim() : prior ? str(prior, "text") : "";
  const scope = typeof data.scope === "string" ? data.scope : prior ? str(prior, "scope") : "session";
  if (!text && data.action !== "remember") return false;
  if (prior) store.run("UPDATE memory_items SET supersededGeneration=? WHERE lineage=? AND stableKey=?", generation, line, str(prior, "stableKey"));
  if (typeof data.supersedesMemoryId === "string") store.run("UPDATE memory_items SET supersededGeneration=? WHERE lineage=? AND memoryId=? AND supersededGeneration IS NULL", generation, line, data.supersedesMemoryId);
  const state = data.action === "demote" || data.action === "forget" ? "demoted" : data.action === "touch" && prior ? str(prior, "state") : "current";
  const stableKey = sha(`memory\n${data.memoryId}\n${data.eventHash}`);
  store.run("INSERT OR IGNORE INTO memory_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", line, stableKey, data.memoryId, data.action, text, scope,
    data.confidence, data.sourceRef, data.eventHash, state, canonicalJson({ source, exactText: stableStringify(data) }), source.eventSeq, generation, null);
  store.run("INSERT INTO memory_fts(lineage,stableKey,body) SELECT ?,?,? WHERE changes()>0", line, stableKey, `${data.memoryId} ${scope} ${text}`);
  store.run("INSERT OR REPLACE INTO cuts VALUES(?,?,?,?)", line, source.eventSeq, 0, generation);
  attachMetadataMember(store, request, source.eventSeq, source, `memory ${data.action} ${data.memoryId}: ${text}`, generation);
  return true;
}
function insertRetentionMetadata(store: Store, request: EpisodeStateRequest, data: any, source: ScopedRawSourceRef, generation: number): void {
  const line = lineage(request), stableKey = sha(`retention\n${canonicalJson(source)}`);
  store.run("INSERT OR IGNORE INTO retention_hints VALUES(?,?,?,?,?,?)", line, stableKey, canonicalJson(data), canonicalJson({ source, exactText: stableStringify(data) }), source.eventSeq, generation);
  store.run("INSERT INTO retention_fts(lineage,stableKey,body) SELECT ?,?,? WHERE changes()>0", line, stableKey, Object.values(data).join(" "));
  store.run("INSERT OR REPLACE INTO cuts VALUES(?,?,?,?)", line, source.eventSeq, 0, generation);
  attachMetadataMember(store, request, source.eventSeq, source, `retention hint: ${Object.values(data).join(" ")}`, generation);
}
async function materializeMetadata(request: EpisodeStateRequest, store: Store, executor: CatalogExecutor, budget: { bytes: number }, afterEventSeq: number,
  currentGeneration: number, throughEventSeq: number): Promise<MetadataProgress & { generation: number }> {
  const page = await catalogCall(request, executor, budget, { op: "page", view: request.view, after: afterEventSeq, limit: EPISODE_STATE_LIMITS.materializeCapsules });
  const events = ((page.events ?? []) as CatalogEventRow[]).filter(event => event.seq <= throughEventSeq);
  let generation = currentGeneration, acceptedMemoryEvents = 0, acceptedRetentionHints = 0, partial = 0;
  const lastMemory = store.get("SELECT eventHash FROM memory_items WHERE lineage=? ORDER BY createdGeneration DESC LIMIT 1", lineage(request));
  let previousHash = lastMemory ? str(lastMemory, "eventHash") : "0".repeat(64);
  for (const event of events) {
    const customType = event.metadata?.customType ?? event.metadata?.messageCustomType;
    if (customType !== "chrono-memory-v2-event" && customType !== "chrono-compact-retention-hint") continue;
    const length = event.rawEnd - event.rawStart;
    if (length < 1 || length > 64 * 1024) { partial++; continue; }
    const raw = await catalogCall(request, executor, budget, { op: "raw", view: request.view, eventSeq: event.seq, offset: event.rawStart, length });
    const bytes = Buffer.from(String(raw.data), "base64");
    if (bytes.length !== length) fail("search-v3-state-source-invalid");
    let record: any; try { record = JSON.parse(bytes.toString("utf8")); } catch { partial++; continue; }
    if (record?.type !== "custom" || record.customType !== customType) { partial++; continue; }
    const data = record.data;
    const source = rawEventSource(request, event, bytes);
    if (customType === "chrono-memory-v2-event") {
      if (data && typeof data.eventHash === "string" && store.get("SELECT stableKey FROM memory_items WHERE lineage=? AND eventHash=?", lineage(request), data.eventHash)) {
        continue; // A repeated mirror must not rewind the producer hash chain.
      }
      if (!validMemoryEvent(data, previousHash)) { partial++; continue; }
      const nextGeneration = generation + 1;
      let inserted = false;
      store.transaction(() => {
        inserted = insertMemoryMetadata(store, request, data, source, nextGeneration);
        if (inserted) store.run("UPDATE meta SET generation=? WHERE singleton=1", nextGeneration);
      });
      if (!inserted) { partial++; continue; }
      generation = nextGeneration; previousHash = data.eventHash; acceptedMemoryEvents++;
    } else if (validRetentionHint(data)) {
      const stableKey = sha(`retention\n${canonicalJson(source)}`);
      if (store.get("SELECT stableKey FROM retention_hints WHERE lineage=? AND stableKey=?", lineage(request), stableKey)) continue;
      const nextGeneration = generation + 1;
      store.transaction(() => { insertRetentionMetadata(store, request, data, source, nextGeneration); store.run("UPDATE meta SET generation=? WHERE singleton=1", nextGeneration); });
      generation = nextGeneration; acceptedRetentionHints++;
    } else partial++;
  }
  const next = events.length ? events[events.length - 1]!.seq : afterEventSeq;
  const complete = throughEventSeq >= request.view.eventCut && (next >= request.view.eventCut || (page.events ?? []).length < EPISODE_STATE_LIMITS.materializeCapsules);
  return { afterEventSeq: next, complete, processedEvents: events.length, acceptedMemoryEvents, acceptedRetentionHints, partial, generation };
}
function extendsView(current: EpisodeStateRequest["view"], old: EpisodeStateRequest["view"]): boolean {
  return current.branchKey === old.branchKey && current.eventCut >= old.eventCut && current.segments.length >= old.segments.length
    && old.segments.every((item, index) => current.segments[index]?.segment === item.segment && current.segments[index]!.cut >= item.cut);
}
type SupersessionRequest = Extract<EpisodeStateRequest, { op: "supersedeState" }>;

/** Verify catalog role/provenance and exact descriptor identity, not memory labels or capsule prose. */
async function originalUserSource(request: SupersessionRequest, source: ScopedBodySourceRef, executor: CatalogExecutor,
  budget: { bytes: number }): Promise<CatalogEventRow> {
  if (!isScopedBodySourceRef(source) || !sourceRefWithinViewBounds(source, request.view)) fail("search-v3-state-supersession-source-invalid");
  const page = await catalogCall(request, executor, budget, { op: "page", view: request.view, after: source.eventSeq - 1, limit: 1 });
  const event = page.events?.[0] as CatalogEventRow | undefined;
  if (!event || event.seq !== source.eventSeq || event.metadata.type !== "message" || event.metadata.role !== "user"
    || event.metadata.provenance !== "original" || event.metadata.customType !== undefined || event.metadata.messageCustomType !== undefined)
    return fail("search-v3-state-supersession-authority-invalid");
  const blocks = await catalogCall(request, executor, budget, { op: "blocks", view: request.view, eventSeq: source.eventSeq,
    after: source.descriptor, limit: 1 });
  const block = blocks.blocks?.[0] as CatalogBlockShape | undefined;
  const exact = block && bodySource(request.identity.capsule, request.view, event, block);
  if (!block || block.index !== source.descriptor || block.metadata.provenance !== "original"
    || !["text", "content"].includes(source.field) || !exact || canonicalJson(exact) !== canonicalJson(source))
    return fail("search-v3-state-supersession-source-invalid");
  return event;
}

async function supersessionSpan(request: SupersessionRequest, source: ScopedBodySourceRef, span: { start: number; end: number },
  executor: CapsuleExecutor, budget: { bytes: number }): Promise<string> {
  if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < source.decodedUtf16.start
    || span.end > source.decodedUtf16.end || span.end <= span.start || span.end - span.start > EPISODE_STATE_LIMITS.clauseUtf16Units)
    return fail("search-v3-state-supersession-source-invalid");
  const result = await capsuleCall(request, executor, budget, { op: "chunkRange", view: request.view, source,
    decodedStart: span.start, decodedLength: span.end - span.start, limit: 2 });
  const bytes = Buffer.from(String(result.data), "base64"), text = bytes.toString("utf16le");
  if (bytes.length !== (span.end - span.start) * 2 || text.length !== span.end - span.start) fail("search-v3-state-supersession-source-invalid");
  return text;
}

/** Explicit bounded state transition. No extraction, automatic retirement, or coverage certification. */
async function supersedeState(request: SupersessionRequest, store: Store, options: EpisodeStateExecutionOptions,
  budget: { bytes: number }): Promise<Record<string, unknown>> {
  const catalog = options.catalogExecutor ?? executeCatalogStoreRequest, capsules = options.capsuleExecutor ?? executeCapsuleRequest;
  const line = lineage(request), authorization = request.authorization;
  const targets = [...request.targets].sort((a, b) => a.stableKey.localeCompare(b.stableKey));
  const decisionKey = sha(canonicalJson({ contract: "explicit-user-supersession-v1", identity: request.identity, view: request.view,
    expectedGeneration: request.expectedGeneration, authorization, decision: request.decision, targets }));
  const generation = request.expectedGeneration + 1;
  const event = await originalUserSource(request, authorization.source, catalog, budget);
  const rawLength = event.rawEnd - event.rawStart;
  // The existing raw-read ceiling is a refusal boundary, never a whole-file fallback.
  if (!Number.isSafeInteger(rawLength) || rawLength < 1 || rawLength > 64 * 1024) fail("search-v3-state-supersession-source-limit");
  const raw = await catalogCall(request, catalog, budget, { op: "raw", view: request.view, eventSeq: event.seq, offset: event.rawStart, length: rawLength });
  const bytes = Buffer.from(String(raw.data), "base64");
  if (bytes.length !== rawLength || createHash("sha256").update(bytes).digest("hex") !== authorization.rawEventHash)
    fail("search-v3-state-supersession-source-invalid");
  let record: any;
  try { record = JSON.parse(bytes.toString("utf8")); } catch { return fail("search-v3-state-supersession-source-invalid"); }
  const content = record?.message?.content, source = authorization.source;
  const directText = source.blockIndex === undefined && source.field === "content" && typeof content === "string" ? content
    : Array.isArray(content) && source.blockIndex !== undefined && source.field === "text" && content[source.blockIndex]?.type === "text"
      ? content[source.blockIndex].text : undefined;
  if (record?.type !== "message" || record?.message?.role !== "user" || typeof directText !== "string"
    || directText.length !== source.decodedUtf16.end || source.decodedUtf16.start !== 0)
    fail("search-v3-state-supersession-authority-invalid");
  const exactText = await supersessionSpan(request, source, authorization.decodedUtf16, capsules, budget);
  if (directText.slice(authorization.decodedUtf16.start, authorization.decodedUtf16.end) !== exactText
    || createHash("sha256").update(Buffer.from(exactText, "utf16le")).digest("hex") !== authorization.spanHash)
    fail("search-v3-state-supersession-source-invalid");
  const rows: SqlRow[] = [];
  const verifiedSources = new Set<string>([sourceKey(source)]);
  for (const target of targets) {
    const row = store.get("SELECT * FROM state_items WHERE lineage=? AND stableKey=?", line, target.stableKey);
    if (!row || str(row, "propositionKey") !== target.propositionKey || str(row, "spanKey") !== target.spanKey
      || num(row, "createdGeneration") !== target.createdGeneration || sha(str(row, "evidence")) !== target.evidenceHash
      || str(row, "kind") !== target.kind || str(row, "authority") !== target.authority || str(row, "confidence") !== "verified"
      || !["current", "unresolved"].includes(str(row, "status"))) fail("search-v3-state-supersession-target-invalid");
    const exactRow = row!;
    let evidence: any;
    try { evidence = JSON.parse(str(exactRow, "evidence")); } catch { return fail("search-v3-state-supersession-target-invalid"); }
    if (!isScopedBodySourceRef(evidence?.source) || !sourceRefWithinViewBounds(evidence.source, request.view)
      || evidence.source.eventSeq !== num(exactRow, "eventSeq") || evidence.source.descriptor !== num(exactRow, "descriptor")
      || evidence.source.eventSeq >= source.eventSeq || !evidence.decodedUtf16 || typeof evidence.exactText !== "string")
      fail("search-v3-state-supersession-target-invalid");
    const key = sourceKey(evidence.source);
    if (!verifiedSources.has(key)) { await originalUserSource(request, evidence.source, catalog, budget); verifiedSources.add(key); }
    if (await supersessionSpan(request, evidence.source, evidence.decodedUtf16, capsules, budget) !== evidence.exactText)
      fail("search-v3-state-supersession-target-invalid");
    rows.push(exactRow);
  }
  const resolutionEvidence = { contract: "explicit-user-supersession-v1", decisionKey, source,
    decodedUtf16: authorization.decodedUtf16, exactText, spanHash: authorization.spanHash,
    rawSource: rawEventSource(request, event, bytes), decision: request.decision, targets,
    branchKey: request.view.branchKey, lineage: line, viewHash: viewHash(request), effectiveAtCut: request.view.eventCut,
    previousGeneration: request.expectedGeneration, stateGeneration: generation,
    cutDescriptor: Number.MAX_SAFE_INTEGER - generation, semanticCompletion: false };
  const serialized = canonicalJson(resolutionEvidence);
  const result = (alreadyApplied: boolean): Record<string, unknown> => ({ decisionKey, alreadyApplied, stateGeneration: generation,
    branchKey: request.view.branchKey, effectiveAtCut: request.view.eventCut, supersededCount: targets.length,
    resolutionEvidence, resolutionEvidenceHash: sha(serialized), coverageChanged: false, semanticCompletion: false,
    metrics: { sqliteStatements: store.statements, targets: targets.length, targetLimit: EPISODE_STATE_LIMITS.page } });
  // Replays require the entire same decision and target set, not a reused label or partial overlap.
  if (rows.every(row => num(row, "supersededGeneration") === generation && row.resolutionEvidence === serialized)) return result(true);
  if (rows.some(row => row.supersededGeneration !== null || row.resolutionEvidence !== null)) fail("search-v3-state-supersession-stale");
  const current = store.get("SELECT generation FROM meta WHERE singleton=1")!;
  if (num(current, "generation") !== request.expectedGeneration) fail("search-v3-state-supersession-stale");
  const head = store.get("SELECT * FROM heads WHERE lineage=?", line);
  if (!head || str(head, "view") !== canonicalJson(request.view) || num(head, "complete") !== 1 || num(head, "metadataComplete") !== 1
    || num(head, "metadataAfterEventSeq") < request.view.eventCut || store.get("SELECT 1 AS found FROM large_bodies WHERE lineage=?", line))
    fail("search-v3-state-supersession-current-cut-required");
  if (store.get("SELECT 1 AS found FROM cuts WHERE lineage=? AND eventSeq=? AND descriptor=?", line, request.view.eventCut, resolutionEvidence.cutDescriptor))
    fail("search-v3-state-supersession-stale");
  if (Buffer.byteLength(JSON.stringify(result(false))) > EPISODE_STATE_LIMITS.responseBytes - 4096) fail("search-v3-state-response-limit");
  const committed = store.transaction(() => {
    // Recheck every exact row in one SQLite snapshot before the first mutation.
    if (num(store.get("SELECT generation FROM meta WHERE singleton=1")!, "generation") !== request.expectedGeneration
      || canonicalJson(store.get("SELECT * FROM heads WHERE lineage=?", line)) !== canonicalJson(head)
      || rows.some(row => canonicalJson(store.get("SELECT * FROM state_items WHERE lineage=? AND stableKey=?", line, str(row, "stableKey"))) !== canonicalJson(row))) return false;
    for (const target of targets) store.run("UPDATE state_items SET supersededGeneration=?,resolutionEvidence=? WHERE lineage=? AND stableKey=?",
      generation, serialized, line, target.stableKey);
    // Canonical cut values are nonnegative. A generation-derived high descriptor
    // records this operator cut, not a source. Refuse a collision and retain old markers.
    store.run("INSERT INTO cuts VALUES(?,?,?,?)", line, request.view.eventCut, resolutionEvidence.cutDescriptor, generation);
    store.run("UPDATE heads SET generation=? WHERE lineage=?", generation, line);
    store.run("UPDATE meta SET generation=? WHERE singleton=1", generation);
    return true;
  });
  if (!committed) fail("search-v3-state-supersession-stale");
  return result(false);
}

function insertReduced(store: Store, request: EpisodeStateRequest, reduced: ReducedEpisodeEvent, generation: number, stateOnly = false): void {
  const line = lineage(request), eventSeq = reduced.source.eventSeq, descriptor = reduced.source.descriptor;
  if (!stateOnly && reduced.startsEpisode) {
    const previous = store.get("SELECT e.* FROM episodes e WHERE e.lineage=? AND e.open=1 AND e.createdGeneration=(SELECT MAX(v.createdGeneration) FROM episodes v WHERE v.lineage=e.lineage AND v.episodeKey=e.episodeKey) ORDER BY e.startEventSeq DESC,e.startDescriptor DESC LIMIT 1", line);
    if (previous) {
      if (num(previous, "createdGeneration") === generation) store.run("UPDATE episodes SET endEventSeq=?,endDescriptor=?,open=0 WHERE lineage=? AND episodeKey=? AND createdGeneration=?",
        eventSeq, descriptor, line, str(previous, "episodeKey"), generation);
      else store.run("INSERT INTO episodes VALUES(?,?,?,?,?,?,?,?,?,?,?)", line, str(previous, "episodeKey"), num(previous, "startEventSeq"), num(previous, "startDescriptor"),
        eventSeq, descriptor, 0, num(previous, "memberCount"), str(previous, "objective"), str(previous, "objectiveEvidence"), generation);
    }
    const episodeKey = sha(`${line}\n${eventSeq}\n${descriptor}`).slice(0, 32);
    store.run("INSERT OR IGNORE INTO episodes VALUES(?,?,?,?,?,?,?,?,?,?,?)", line, episodeKey, eventSeq, descriptor, eventSeq, descriptor, 1, 1,
      reduced.objective?.exactText ?? "", canonicalJson(reduced.objective ?? { source: reduced.source, partial: true }), generation);
    store.run("INSERT INTO episode_fts(lineage,episodeKey,body) SELECT ?,?,? WHERE changes()>0", line, episodeKey, reduced.objective?.exactText ?? "");
  } else if (!stateOnly) {
    const open = store.get("SELECT e.* FROM episodes e WHERE e.lineage=? AND e.open=1 AND e.createdGeneration=(SELECT MAX(v.createdGeneration) FROM episodes v WHERE v.lineage=e.lineage AND v.episodeKey=e.episodeKey) ORDER BY e.startEventSeq DESC,e.startDescriptor DESC LIMIT 1", line);
    if (open) {
      if (num(open, "createdGeneration") === generation) store.run("UPDATE episodes SET endEventSeq=?,endDescriptor=?,memberCount=memberCount+1 WHERE lineage=? AND episodeKey=? AND createdGeneration=?",
        eventSeq, descriptor, line, str(open, "episodeKey"), generation);
      else store.run("INSERT INTO episodes VALUES(?,?,?,?,?,?,?,?,?,?,?)", line, str(open, "episodeKey"), num(open, "startEventSeq"), num(open, "startDescriptor"),
        eventSeq, descriptor, 1, num(open, "memberCount") + 1, str(open, "objective"), str(open, "objectiveEvidence"), generation);
    }
  }
  const episode = stateOnly ? undefined : store.get("SELECT e.episodeKey FROM episodes e WHERE e.lineage=? AND e.open=1 AND e.createdGeneration=(SELECT MAX(v.createdGeneration) FROM episodes v WHERE v.lineage=e.lineage AND v.episodeKey=e.episodeKey) ORDER BY e.startEventSeq DESC,e.startDescriptor DESC LIMIT 1", line);
  const cue = [reduced.capsuleCue, ...reduced.states.map(item => `${item.kind}: ${item.evidence.exactText}`),
    ...reduced.resources.map(item => `${item.relation} ${item.resourceKey}: ${item.executionOutcome}`)].filter(Boolean).join("\n").slice(0, 2048);
  if (episode) {
    const memberSourceKey = sourceKey(reduced.source);
    store.run("INSERT OR IGNORE INTO episode_membership VALUES(?,?,?,?,?,?,?,?)", line, str(episode, "episodeKey"), eventSeq, descriptor,
      memberSourceKey, canonicalJson(reduced.source), cue, generation);
    store.run("INSERT INTO episode_member_fts(lineage,episodeKey,sourceKey,body) SELECT ?,?,?,? WHERE changes()>0", line, str(episode, "episodeKey"), memberSourceKey, cue);
  }
  for (const item of reduced.states) {
    // Overlapped decoded windows can rediscover one exact span. Do not replay its lifecycle transition.
    if (store.get("SELECT stableKey FROM state_items WHERE lineage=? AND stableKey=?", line, item.stableKey)) continue;
    if (item.transition) {
      const old = store.rows("SELECT stableKey,evidence FROM state_items WHERE lineage=? AND propositionKey=? AND authority=? AND kind='restriction' AND supersededGeneration IS NULL AND createdGeneration<? ORDER BY eventSeq,descriptor,stableKey LIMIT ?",
        EPISODE_STATE_LIMITS.page, line, item.transition.targetPropositionKey, item.authority, generation, EPISODE_STATE_LIMITS.page);
      for (const row of old) store.run("UPDATE state_items SET supersededGeneration=?,resolutionEvidence=? WHERE lineage=? AND stableKey=?", generation, canonicalJson(item.evidence), line, str(row, "stableKey"));
    }
    store.run("INSERT OR IGNORE INTO state_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", line, item.stableKey, item.propositionKey, item.spanKey, item.subject, item.revision, item.kind,
      item.authority, item.confidence, item.status, canonicalJson(item.evidence), eventSeq, descriptor, generation, null, null);
    store.run("INSERT INTO state_fts(lineage,stableKey,body) SELECT ?,?,? WHERE changes()>0", line, item.stableKey,
      `${item.kind} ${item.subject} ${item.evidence.exactText}`);
  }
  for (const item of reduced.resources) {
    // An observation never changes current revision without exact revision identity.
    // Retain revision observations as evolution; a later mention is not supersession.
    store.run("INSERT OR IGNORE INTO resources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", line, item.stableKey, item.resourceKind, item.resourceKey, item.relation,
      item.revision, item.revisionBasis, item.currentRevision, item.knownThrough, item.failed === null ? null : item.failed ? 1 : 0, item.executionOutcome,
      canonicalJson(item.evidence), eventSeq, descriptor, generation, null);
    store.run("INSERT INTO resource_fts(lineage,stableKey,body) SELECT ?,?,? WHERE changes()>0", line, item.stableKey,
      `${item.resourceKind} ${item.resourceKey} ${item.relation} ${item.revision ?? "unknown"}`);
  }
}
const STATE_BATCH_CHECKPOINT = "state-clause-batch-v1";
interface StateBodyCheckpoint {
  readonly format: typeof STATE_BATCH_CHECKPOINT;
  readonly view: EpisodeStateRequest["view"];
  readonly envelope: ReducerEnvelope;
  /** A processed legacy prefix used window-relative span keys and is not repaired here. */
  readonly legacyPrefixUnverified?: true;
  readonly batch?: { readonly cursor: EpisodeStateBatchCursor; readonly start: number; readonly end: number; readonly windowHash: string };
}
function decodeStateCheckpoint(request: EpisodeStateRequest, row: SqlRow, indexed: EpisodeStateRequest["view"]): StateBodyCheckpoint {
  let parsed: any;
  try { parsed = JSON.parse(str(row, "envelope")); } catch { return fail("search-v3-state-checkpoint-corrupt"); }
  // Legacy checkpoints contain a bare envelope. Preserve their already accumulated gaps.
  // New checkpoints deliberately lack .source, so an old writer refuses before its first mutation.
  const checkpoint: StateBodyCheckpoint = parsed?.format === undefined
    ? { format: STATE_BATCH_CHECKPOINT, view: indexed, envelope: parsed } : parsed;
  if (checkpoint?.format !== STATE_BATCH_CHECKPOINT || Object.hasOwn(checkpoint, "source")
    || !isCapsuleCatalogView(checkpoint.view) || !extendsView(request.view, checkpoint.view) || !extendsView(indexed, checkpoint.view)
    || lineage({ ...request, view: checkpoint.view }) !== lineage(request)
    || !isScopedBodySourceRef(checkpoint.envelope?.source)
    || !sourceRefWithinViewBounds(checkpoint.envelope.source, checkpoint.view)) fail("search-v3-state-checkpoint-corrupt");
  const source = checkpoint.envelope.source, nextDecoded = num(row, "nextDecoded");
  if (!Number.isSafeInteger(nextDecoded) || nextDecoded < source.decodedUtf16.start || nextDecoded >= source.decodedUtf16.end)
    fail("search-v3-state-checkpoint-corrupt");
  const batch = checkpoint.batch;
  if (parsed?.format !== undefined && ((!batch && nextDecoded === source.decodedUtf16.start)
    || Object.hasOwn(parsed, "batch") && !batch)) fail("search-v3-state-checkpoint-corrupt");
  if (batch) {
    const start = nextDecoded === source.decodedUtf16.start ? nextDecoded
      : Math.max(source.decodedUtf16.start, nextDecoded - EPISODE_STATE_LIMITS.largeBodyOverlapUnits);
    if (!Number.isSafeInteger(batch.cursor?.afterState) || batch.cursor.afterState < 1
      || batch.cursor.afterState > EPISODE_STATE_LIMITS.wholeBodyUtf16Units
      || batch.cursor.afterState % EPISODE_STATE_LIMITS.stateItemsPerBatch !== 0
      || !/^[a-f0-9]{64}$/u.test(batch.cursor.prefixHash) || !/^[a-f0-9]{64}$/u.test(batch.windowHash)
      || batch.start !== start || batch.end !== Math.min(source.decodedUtf16.end, start + EPISODE_STATE_LIMITS.wholeBodyUtf16Units))
      fail("search-v3-state-checkpoint-corrupt");
  }
  return parsed?.format === undefined && nextDecoded > source.decodedUtf16.start
    ? { ...checkpoint, legacyPrefixUnverified: true } : checkpoint;
}
function bodyCheckpointProgress(checkpoint: StateBodyCheckpoint, nextDecoded: number): EpisodeStateBodyCheckpoint {
  const source = checkpoint.envelope.source;
  return { eventSeq: source.eventSeq, descriptor: source.descriptor, sourceViewHash: sha(canonicalJson(checkpoint.view)),
    nextDecoded, endDecoded: source.decodedUtf16.end, afterState: checkpoint.batch?.cursor.afterState ?? 0 };
}

async function materialize(request: Extract<EpisodeStateRequest, { op: "materializeState" }>, store: Store, executor: CapsuleExecutor,
  catalogExecutor: CatalogExecutor, budget: { bytes: number }): Promise<Record<string, unknown>> {
  const line = lineage(request), head = store.get("SELECT * FROM heads WHERE lineage=?", line);
  const indexed = head ? JSON.parse(str(head, "view")) as EpisodeStateRequest["view"] : request.view;
  if (!extendsView(request.view, indexed)) fail("search-v3-state-view-incompatible");
  const afterEventSeq = request.after?.eventSeq ?? (head ? num(head, "afterEventSeq") : 0);
  const afterDescriptor = request.after?.descriptor ?? (head ? num(head, "afterDescriptor") : 0);
  const metadataAfterEventSeq = head ? num(head, "metadataAfterEventSeq") : 0;
  const priorPartial = head ? num(head, "partialCount") : 0;
  if (request.after && head && (afterEventSeq !== num(head, "afterEventSeq") || afterDescriptor !== num(head, "afterDescriptor")))
    fail("search-v3-state-cursor-invalid");

  const active = store.get("SELECT * FROM large_bodies WHERE lineage=?", line);
  let checkpoint: StateBodyCheckpoint | undefined, verified: VerifiedEventStructuralFacts | undefined;
  let pageComplete = false;
  if (active) {
    checkpoint = decodeStateCheckpoint(request, active, indexed);
    try { verified = JSON.parse(str(active, "structural")); } catch { return fail("search-v3-state-checkpoint-corrupt"); }
  } else {
    const page = await capsuleCall(request, executor, budget, { op: "capsulePage", view: request.view, afterEventSeq, afterDescriptor, limit: 1 });
    const envelope = (page.capsules ?? [])[0] as ReducerEnvelope | undefined;
    pageComplete = page.complete === true;
    if (envelope) {
      verified = await exactStructural(request, envelope, catalogExecutor, budget);
      checkpoint = { format: STATE_BATCH_CHECKPOINT, view: request.view, envelope };
    }
  }

  let generation = num(store.get("SELECT generation FROM meta WHERE singleton=1")!, "generation");
  let nextEventSeq = afterEventSeq, nextDescriptor = afterDescriptor, bodyPartial = 0, stateItems = 0, decodedChunks = 0;
  if (checkpoint) {
    const { envelope, batch } = checkpoint, source = envelope.source;
    if (!isScopedBodySourceRef(source) || !sourceRefWithinViewBounds(source, checkpoint.view)
      || source.eventSeq < afterEventSeq || source.eventSeq === afterEventSeq && source.descriptor <= afterDescriptor
      || metadataAfterEventSeq >= source.eventSeq) fail("search-v3-state-checkpoint-corrupt");
    // This is append continuation, never an implicit repair of an older publication.
    if (store.get("SELECT 1 AS found WHERE EXISTS(SELECT 1 FROM coverage WHERE lineage=? AND eventSeq=? AND descriptor=?) OR EXISTS(SELECT 1 FROM cuts WHERE lineage=? AND eventSeq=? AND descriptor=?)",
      line, source.eventSeq, source.descriptor, line, source.eventSeq, source.descriptor)) fail("search-v3-state-checkpoint-corrupt");
    const sourceStart = source.decodedUtf16.start, sourceEnd = source.decodedUtf16.end;
    const nextDecoded = active ? num(active, "nextDecoded") : sourceStart;
    const decodedStart = nextDecoded === sourceStart ? sourceStart : Math.max(sourceStart, nextDecoded - EPISODE_STATE_LIMITS.largeBodyOverlapUnits);
    const length = Math.min(EPISODE_STATE_LIMITS.wholeBodyUtf16Units, sourceEnd - decodedStart), through = decodedStart + length;
    const chunk = length ? await capsuleCall(request, executor, budget, { op: "chunkRange", view: checkpoint.view, source,
      decodedStart, decodedLength: length, limit: 2 }) : { data: "" };
    const bytes = Buffer.from(String(chunk.data), "base64"), text = bytes.toString("utf16le");
    if (bytes.length !== length * 2 || text.length !== length) fail("search-v3-state-source-invalid");
    const windowHash = createHash("sha256").update(bytes).digest("hex");
    if (batch && batch.windowHash !== windowHash) fail("search-v3-state-checkpoint-corrupt");
    const reduced = reduceEpisodeStateEnvelope(envelope, text, verified, { decodedStart, final: through === sourceEnd, after: batch?.cursor });
    const windowComplete = reduced.nextBatch === undefined, final = through === sourceEnd && windowComplete;
    // A pending batch is not a permanent gap. The final batch repeats the same exact
    // window and retains any intrinsic qualifier. Earlier completed-window gaps stay set.
    const legacyPrefix = checkpoint.legacyPrefixUnverified === true;
    const restrictionGap = active?.restrictionGap === 1 || legacyPrefix || windowComplete && reduced.coverage.restrictionGap;
    const openWorkGap = active?.openWorkGap === 1 || legacyPrefix || windowComplete && reduced.coverage.openWorkGap;
    const partial = active?.partial === 1 || legacyPrefix || windowComplete && reduced.partial;
    const nextCheckpoint: StateBodyCheckpoint = { format: STATE_BATCH_CHECKPOINT, view: checkpoint.view, envelope,
      ...(legacyPrefix ? { legacyPrefixUnverified: true as const } : {}),
      ...(reduced.nextBatch ? { batch: { cursor: reduced.nextBatch, start: decodedStart, end: through, windowHash } } : {}) };
    const nextWindow = windowComplete ? through : nextDecoded;
    generation++; stateItems = reduced.states.length; decodedChunks = length ? 1 : 0; bodyPartial = final && partial ? 1 : 0;
    if (final) { nextEventSeq = source.eventSeq; nextDescriptor = source.descriptor; }
    store.transaction(() => {
      insertReduced(store, request, reduced, generation, nextDecoded !== sourceStart || batch !== undefined);
      store.run("UPDATE meta SET generation=? WHERE singleton=1", generation);
      if (final) {
        store.run("DELETE FROM large_bodies WHERE lineage=?", line);
        store.run("INSERT OR REPLACE INTO coverage VALUES(?,?,?,?,?,?,?)", line, source.eventSeq, source.descriptor,
          generation, restrictionGap ? 1 : 0, openWorkGap ? 1 : 0, partial ? 1 : 0);
        store.run("INSERT OR REPLACE INTO cuts VALUES(?,?,?,?)", line, source.eventSeq, source.descriptor, generation);
      } else store.run("INSERT OR REPLACE INTO large_bodies VALUES(?,?,?,?,?,?,?)", line, JSON.stringify(nextCheckpoint),
        canonicalJson(verified ?? {}), nextWindow, restrictionGap ? 1 : 0, openWorkGap ? 1 : 0, partial ? 1 : 0);
      // Commit the body head with its rows/checkpoint, including the final batch.
      // A later metadata read failure cannot replay the completed envelope.
      store.run("INSERT OR REPLACE INTO heads VALUES(?,?,?,?,?,?,?,?,?)", line, canonicalJson(request.view), nextEventSeq, nextDescriptor,
        metadataAfterEventSeq, generation, 0, 0, priorPartial + bodyPartial);
    });
    if (!final) {
      const known = Math.max(0, Math.min(request.view.eventCut, afterEventSeq - 1, metadataAfterEventSeq));
      return { stateGeneration: generation, branchKey: request.view.branchKey, knownThroughCut: known, knownThrough: known, partial: true, complete: false,
        next: { eventSeq: afterEventSeq, descriptor: afterDescriptor, generation }, metadata: { afterEventSeq: metadataAfterEventSeq, complete: false,
          processedEvents: 0, acceptedMemoryEvents: 0, acceptedRetentionHints: 0 }, bodyCheckpoint: bodyCheckpointProgress(nextCheckpoint, nextWindow),
        ...(sourceEnd - sourceStart > EPISODE_STATE_LIMITS.wholeBodyUtf16Units
          ? { largeBody: { checkpointed: true, nextDecoded: nextWindow, endDecoded: sourceEnd } } : {}),
        metrics: { capsules: 1, decodedChunks, stateItems, stateItemsPerBatch: EPISODE_STATE_LIMITS.stateItemsPerBatch,
          partialRecords: 0, sqliteStatements: store.statements } };
    }
  }

  const bodyComplete = !checkpoint && pageComplete;
  const metadata = await materializeMetadata(request, store, catalogExecutor, budget, metadataAfterEventSeq, generation,
    bodyComplete ? request.view.eventCut : Math.max(0, nextEventSeq - 1));
  generation = metadata.generation;
  const complete = bodyComplete && metadata.complete, partialCount = priorPartial + bodyPartial + metadata.partial;
  store.transaction(() => {
    store.run("UPDATE meta SET generation=? WHERE singleton=1", generation);
    store.run("INSERT OR REPLACE INTO heads VALUES(?,?,?,?,?,?,?,?,?)", line, canonicalJson(request.view), nextEventSeq, nextDescriptor,
      metadata.afterEventSeq, generation, bodyComplete ? 1 : 0, metadata.complete ? 1 : 0, partialCount);
  });
  const knownThroughCut = complete ? request.view.eventCut : Math.max(0, Math.min(request.view.eventCut, nextEventSeq - 1, metadata.afterEventSeq));
  return { stateGeneration: generation, branchKey: request.view.branchKey, knownThroughCut, knownThrough: knownThroughCut, partial: !complete || partialCount > 0,
    complete, next: { eventSeq: nextEventSeq, descriptor: nextDescriptor, generation }, metadata: { afterEventSeq: metadata.afterEventSeq,
      complete: metadata.complete, processedEvents: metadata.processedEvents, acceptedMemoryEvents: metadata.acceptedMemoryEvents,
      acceptedRetentionHints: metadata.acceptedRetentionHints }, metrics: { capsules: checkpoint ? 1 : 0, decodedChunks, stateItems,
      stateItemsPerBatch: EPISODE_STATE_LIMITS.stateItemsPerBatch, partialRecords: bodyPartial + metadata.partial, sqliteStatements: store.statements } };
}
function pin(request: Extract<EpisodeStateRequest, { op: "recallState" }>, store: Store): number {
  const cut = store.get("SELECT MAX(generation) AS generation FROM cuts WHERE lineage=? AND eventSeq<=?", lineage(request), request.view.eventCut);
  const current = cut ? num(cut, "generation") : 0, generation = request.after?.generation ?? current;
  if (!Number.isSafeInteger(generation) || generation < 0 || generation > current) fail("search-v3-state-cursor-invalid");
  return generation;
}
function ftsQuery(text: string): string {
  const terms = (text.toLowerCase().match(/[\p{L}\p{N}_./:+-]{2,}/gu) ?? []).slice(0, 12);
  if (!terms.length) fail("search-v3-state-query-invalid");
  return [...new Set(terms)].map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}
function keyset(after: EpisodeStateAfter | undefined, alias: string, keyColumn = "stableKey"): { sql: string; values: SqlValue[] } {
  if (!after) return { sql: "", values: [] };
  return { sql: ` AND (${alias}.eventSeq>? OR (${alias}.eventSeq=? AND (${alias}.descriptor>? OR (${alias}.descriptor=? AND ${alias}.${keyColumn}>?))))`,
    values: [after.eventSeq, after.eventSeq, after.descriptor, after.descriptor, after.stableKey ?? ""] };
}
function visibleMemberCue(store: Store, row: SqlRow, generation: number, cut: number): string {
  const source = JSON.parse(str(row, "source"));
  if (source.coordinateKind !== "raw-json") return str(row, "cue");
  const memory = store.get("SELECT * FROM memory_items WHERE lineage=? AND eventSeq=? LIMIT 1", str(row, "lineage"), num(row, "eventSeq"));
  if (!memory) return str(row, "cue");
  const active = store.get("SELECT state,stableKey FROM memory_items WHERE lineage=? AND memoryId=? AND createdGeneration<=? AND eventSeq<=? ORDER BY createdGeneration DESC LIMIT 1", str(row, "lineage"), str(memory, "memoryId"), generation, cut);
  return active && str(active, "state") === "current" && str(active, "stableKey") === str(memory, "stableKey")
    ? str(row, "cue") : "Inactive memory metadata; exact archived source remains available.";
}
function recall(request: Extract<EpisodeStateRequest, { op: "recallState" }>, store: Store): Record<string, unknown> {
  const generation = pin(request, store), line = lineage(request), level = request.level ?? "state", limit = request.limit ?? EPISODE_STATE_LIMITS.page;
  const after = keyset(request.after, level === "episode" ? "m" : level === "resource" ? "r" : "s", level === "episode" ? "sourceKey" : "stableKey");
  const source = request.source ? sourceKey(request.source) : undefined;
  let rows: SqlRow[], items: Record<string, unknown>[];
  if (level === "episode") {
    const match = request.query ? ftsQuery(request.query) : undefined;
    let targetEpisode: string | undefined;
    if (source) targetEpisode = store.get("SELECT episodeKey FROM episode_membership WHERE lineage=? AND sourceKey=? AND createdGeneration<=? ORDER BY createdGeneration DESC LIMIT 1", line, source, generation)?.episodeKey as string | undefined;
    else if (match) targetEpisode = store.get("SELECT m.episodeKey FROM episode_member_fts JOIN episode_membership m ON m.lineage=episode_member_fts.lineage AND m.sourceKey=episode_member_fts.sourceKey WHERE m.lineage=? AND m.createdGeneration<=? AND m.eventSeq<=? AND episode_member_fts MATCH ? ORDER BY m.eventSeq,m.descriptor,m.sourceKey LIMIT 1", line, generation, request.view.eventCut, match)?.episodeKey as string | undefined;
    rows = targetEpisode === undefined && (source || match) ? [] : store.rows(`SELECT m.*,e.startEventSeq,e.startDescriptor,e.endEventSeq,e.endDescriptor,e.open,e.memberCount,e.objective,e.objectiveEvidence FROM episode_membership m JOIN episodes e ON e.lineage=m.lineage AND e.episodeKey=m.episodeKey AND e.createdGeneration=(SELECT MAX(v.createdGeneration) FROM episodes v WHERE v.lineage=e.lineage AND v.episodeKey=e.episodeKey AND v.createdGeneration<=? AND v.endEventSeq<=?) WHERE m.lineage=? AND m.createdGeneration<=? AND m.eventSeq<=?${targetEpisode ? " AND m.episodeKey=?" : ""}${after.sql} ORDER BY m.eventSeq,m.descriptor,m.sourceKey LIMIT ?`,
      limit + 1, generation, request.view.eventCut, line, generation, request.view.eventCut, ...(targetEpisode ? [targetEpisode] : []), ...after.values, limit + 1);
    items = rows.slice(0, limit).map(row => ({ level, stableKey: str(row, "sourceKey"), episodeKey: str(row, "episodeKey"),
      episode: { start: { eventSeq: num(row, "startEventSeq"), descriptor: num(row, "startDescriptor") }, end: { eventSeq: num(row, "endEventSeq"), descriptor: num(row, "endDescriptor") },
        open: num(row, "open") === 1, memberCount: num(row, "memberCount"), objective: str(row, "objective"), objectiveEvidence: JSON.parse(str(row, "objectiveEvidence")) },
      member: { eventSeq: num(row, "eventSeq"), descriptor: num(row, "descriptor"), source: JSON.parse(str(row, "source")), cue: visibleMemberCue(store, row, generation, request.view.eventCut) } }));
  } else if (level === "resource") {
    const match = request.query ? ftsQuery(request.query) : undefined;
    rows = store.rows(`SELECT r.* FROM resources r${match ? " JOIN resource_fts ON resource_fts.lineage=r.lineage AND resource_fts.stableKey=r.stableKey" : ""} WHERE r.lineage=? AND r.createdGeneration<=? AND r.eventSeq<=? AND (r.supersededGeneration IS NULL OR r.supersededGeneration>?)${match ? " AND resource_fts MATCH ?" : ""}${source ? " AND json_extract(r.evidence,'$.source')=?" : ""}${after.sql} ORDER BY r.eventSeq,r.descriptor,r.stableKey LIMIT ?`,
      limit + 1, line, generation, request.view.eventCut, generation, ...(match ? [match] : []), ...(source ? [canonicalJson(request.source)] : []), ...after.values, limit + 1);
    items = rows.slice(0, limit).map(row => ({ level, stableKey: str(row, "stableKey"), resourceKind: str(row, "resourceKind"), resourceKey: str(row, "resourceKey"),
      relation: str(row, "relation"), validationFreshness: "unknown; observation is not full-resource validation", revision: row.revision, revisionBasis: str(row, "revisionBasis"), currentRevision: str(row, "currentRevision"), knownThrough: num(row, "knownThrough"),
      failed: row.failed === null ? null : num(row, "failed") === 1, executionOutcome: str(row, "executionOutcome"),
      verification: "not-established-by-execution", evidence: JSON.parse(str(row, "evidence")) }));
  } else {
    const match = request.query ? ftsQuery(request.query) : undefined;
    const stateRows = store.rows(`SELECT s.*,'state' AS metadataKind FROM state_items s${match ? " JOIN state_fts ON state_fts.lineage=s.lineage AND state_fts.stableKey=s.stableKey" : ""} WHERE s.lineage=? AND s.createdGeneration<=? AND s.eventSeq<=? AND (s.supersededGeneration IS NULL OR s.supersededGeneration>? OR COALESCE(json_extract(s.resolutionEvidence,'$.effectiveAtCut'),json_extract(s.resolutionEvidence,'$.source.eventSeq'))>?)${match ? " AND state_fts MATCH ?" : ""}${source ? " AND json_extract(s.evidence,'$.source')=?" : ""}${after.sql} ORDER BY s.eventSeq,s.descriptor,s.stableKey LIMIT ?`,
      limit + 1, line, generation, request.view.eventCut, generation, request.view.eventCut, ...(match ? [match] : []), ...(source ? [canonicalJson(request.source)] : []), ...after.values, limit + 1);
    const metadataAfterSql = (alias: string): string => request.after ? ` AND (${alias}.eventSeq>? OR (${alias}.eventSeq=? AND (0>? OR (0=? AND ${alias}.stableKey>?))))` : "";
    const metadataAfterValues: SqlValue[] = request.after ? [request.after.eventSeq, request.after.eventSeq, request.after.descriptor, request.after.descriptor, request.after.stableKey ?? ""] : [];
    const memoryRows = source ? [] : store.rows(`SELECT m.*,0 AS descriptor,'memory' AS metadataKind FROM memory_items m${match ? " JOIN memory_fts ON memory_fts.lineage=m.lineage AND memory_fts.stableKey=m.stableKey" : ""} WHERE m.lineage=? AND m.createdGeneration<=? AND m.eventSeq<=? AND (m.supersededGeneration IS NULL OR m.supersededGeneration>? OR EXISTS(SELECT 1 FROM memory_items transition WHERE transition.lineage=m.lineage AND transition.createdGeneration=m.supersededGeneration AND transition.eventSeq>?)) AND m.state='current'${match ? " AND memory_fts MATCH ?" : ""}${metadataAfterSql("m")} ORDER BY m.eventSeq,m.stableKey LIMIT ?`,
      limit + 1, line, generation, request.view.eventCut, generation, request.view.eventCut, ...(match ? [match] : []), ...metadataAfterValues, limit + 1);
    const retentionRows = source ? [] : store.rows(`SELECT h.*,0 AS descriptor,'retention-hint' AS metadataKind FROM retention_hints h${match ? " JOIN retention_fts ON retention_fts.lineage=h.lineage AND retention_fts.stableKey=h.stableKey" : ""} WHERE h.lineage=? AND h.createdGeneration<=? AND h.eventSeq<=?${match ? " AND retention_fts MATCH ?" : ""}${metadataAfterSql("h")} ORDER BY h.eventSeq,h.stableKey LIMIT ?`,
      limit + 1, line, generation, request.view.eventCut, ...(match ? [match] : []), ...metadataAfterValues, limit + 1);
    rows = [...stateRows, ...memoryRows, ...retentionRows].sort((a, b) => num(a, "eventSeq") - num(b, "eventSeq") || num(a, "descriptor") - num(b, "descriptor") || str(a, "stableKey").localeCompare(str(b, "stableKey"))).slice(0, limit + 1);
    items = rows.slice(0, limit).map(row => {
      const metadataKind = str(row, "metadataKind");
      if (metadataKind === "memory") return { level, stableKey: str(row, "stableKey"), metadataKind, kind: "memory", subject: `memory:${str(row, "memoryId")}`,
        revision: str(row, "eventHash"), authority: "ordinary-memory", confidence: "advisory", status: "current", memoryId: str(row, "memoryId"),
        action: str(row, "action"), scope: str(row, "scope"), memoryConfidence: Number(row.confidence), text: str(row, "text"), sourceRef: str(row, "sourceRef"), evidence: JSON.parse(str(row, "evidence")) };
      if (metadataKind === "retention-hint") return { level, stableKey: str(row, "stableKey"), metadataKind, kind: "retentionhint", subject: "retention:compaction",
        revision: "advisory", authority: "ordinary-memory", confidence: "advisory", status: "current", hint: JSON.parse(str(row, "data")), evidence: JSON.parse(str(row, "evidence")) };
      return { level, stableKey: str(row, "stableKey"), propositionKey: str(row, "propositionKey"), spanKey: str(row, "spanKey"), subject: str(row, "subject"),
        revision: str(row, "revision"), kind: str(row, "kind"), authority: str(row, "authority"), confidence: str(row, "confidence"), status: str(row, "status"),
        createdGeneration: num(row, "createdGeneration"), evidenceHash: sha(str(row, "evidence")), evidence: JSON.parse(str(row, "evidence")) };
    });
  }
  while (items.length > 1 && Buffer.byteLength(JSON.stringify(items)) > EPISODE_STATE_LIMITS.recallUtf8Bytes) items.pop();
  const selected = rows.slice(0, items.length), last = selected.at(-1), eventColumn = "eventSeq", descriptorColumn = "descriptor",
    keyColumn = level === "episode" ? "sourceKey" : "stableKey";
  const head = store.get("SELECT * FROM heads WHERE lineage=?", line);
  // A cursor can stop inside an event, or pin an earlier materialization generation.
  // Only a completed head visible to that generation certifies its whole view.
  const visibleCut = store.get("SELECT eventSeq FROM cuts WHERE lineage=? AND generation<=? AND eventSeq<=? ORDER BY eventSeq DESC,descriptor DESC LIMIT 1", line, generation, request.view.eventCut);
  const completedView = head && num(head, "complete") === 1 && num(head, "metadataComplete") === 1 && generation >= num(head, "generation")
    ? JSON.parse(str(head, "view")) as EpisodeStateRequest["view"] : undefined;
  const knownThrough = completedView ? Math.min(request.view.eventCut, completedView.eventCut)
    : Math.max(0, Math.min((visibleCut ? num(visibleCut, "eventSeq") : 0) - 1, head ? num(head, "metadataAfterEventSeq") : 0));
  return { stateGeneration: generation, branchKey: request.view.branchKey, knownThrough, partial: !head || !completedView || knownThrough < request.view.eventCut || num(head, "partialCount") > 0,
    level, items, ...(rows.length > items.length && last ? { next: { eventSeq: num(last, eventColumn), descriptor: num(last, descriptorColumn), stableKey: str(last, keyColumn), generation } } : {}),
    metrics: { sqliteStatements: store.statements } };
}
function selectionItem(row: SqlRow, effectiveAtCut: number): EpisodeStateSelectionItem {
  return { stableKey: str(row, "stableKey"), propositionKey: str(row, "propositionKey"), spanKey: str(row, "spanKey"),
    subject: str(row, "subject"), revision: str(row, "revision"), kind: str(row, "kind") as EpisodeStateSelectionItem["kind"],
    authority: str(row, "authority") as EpisodeStateSelectionItem["authority"], confidence: str(row, "confidence") as EpisodeStateSelectionItem["confidence"],
    status: str(row, "status") as EpisodeStateSelectionItem["status"], effectiveAtCut, evidence: JSON.parse(str(row, "evidence")) };
}

/** Page an indexed category with explicit statement and row bounds. */
function boundedCategoryRows(store: Store, line: string, active: string, condition: string, values: readonly SqlValue[],
  stateGeneration: number, processedCut: number, maximumPages: number = EPISODE_STATE_LIMITS.composeScanPages): { rows: SqlRow[]; complete: boolean; pages: number } {
  const rows: SqlRow[] = [];
  let cursor: { eventSeq: number; descriptor: number; stableKey: string } | undefined;
  for (let page = 0; page < maximumPages; page++) {
    const after = cursor ? " AND (eventSeq<? OR (eventSeq=? AND (descriptor<? OR (descriptor=? AND stableKey<?))))" : "";
    const batch = store.rows(`SELECT * FROM state_items WHERE lineage=? AND ${active} AND ${condition}${after}
      ORDER BY eventSeq DESC,descriptor DESC,stableKey DESC LIMIT ?`, EPISODE_STATE_LIMITS.composeScanPage,
      line, stateGeneration, processedCut, stateGeneration, processedCut, ...values,
      ...(cursor ? [cursor.eventSeq, cursor.eventSeq, cursor.descriptor, cursor.descriptor, cursor.stableKey] : []), EPISODE_STATE_LIMITS.composeScanPage);
    rows.push(...batch);
    if (batch.length < EPISODE_STATE_LIMITS.composeScanPage) return { rows, complete: true, pages: page + 1 };
    const last = batch.at(-1)!;
    cursor = { eventSeq: num(last, "eventSeq"), descriptor: num(last, "descriptor"), stableKey: str(last, "stableKey") };
  }
  return { rows: rows.slice(0, EPISODE_STATE_LIMITS.composeScannedPerCategory), complete: false, pages: maximumPages };
}

/** M09 selection reads one common body and metadata prefix without materialization or source-body access. */
function composeStateSelection(request: Extract<EpisodeStateRequest, { op: "composeStateSelection" }>, store: Store): EpisodeStateSelection {
  const line = lineage(request), requestedCut = request.view.eventCut;
  const head = store.get("SELECT * FROM heads WHERE lineage=?", line) ?? fail("search-v3-state-not-ready");
  let indexed: EpisodeStateRequest["view"];
  try { indexed = JSON.parse(str(head, "view")); } catch { return fail("search-v3-state-checkpoint-corrupt"); }
  if (!extendsView(indexed, request.view) && !extendsView(request.view, indexed)) fail("search-v3-state-view-incompatible");
  const bodyCut = num(head, "complete") === 1 ? Math.min(requestedCut, indexed.eventCut)
    : Math.max(0, Math.min(requestedCut, num(head, "afterEventSeq") - 1));
  const processedMemoryCut = Math.max(0, Math.min(requestedCut, indexed.eventCut, num(head, "metadataAfterEventSeq")));
  const processedCut = Math.min(bodyCut, processedMemoryCut);
  const generationRow = store.get("SELECT MAX(generation) AS generation FROM cuts WHERE lineage=? AND eventSeq<=?", line, processedCut);
  const stateGeneration = generationRow?.generation === null || generationRow?.generation === undefined ? 0 : num(generationRow, "generation");
  if (stateGeneration > num(head, "generation")) fail("search-v3-state-checkpoint-corrupt");
  const active = "createdGeneration<=? AND eventSeq<=? AND (supersededGeneration IS NULL OR supersededGeneration>? OR COALESCE(json_extract(resolutionEvidence,'$.effectiveAtCut'),json_extract(resolutionEvidence,'$.source.eventSeq'))>?)";
  // Scan each mandatory category before representation packing. Raw rows do not consume the 16+8 representation reservations.
  const restrictionScan = boundedCategoryRows(store, line, active, "kind='restriction'", [], stateGeneration, processedCut);
  // Spend one shared eight-page work bound in authority order. Later tool failures cannot consume the scan before user work.
  const workConditions = ["kind IN ('goal','openwork','blocker') AND authority='user'",
    "kind IN ('goal','openwork','blocker') AND authority='assistant-report'",
    "kind IN ('goal','openwork','blocker') AND authority NOT IN ('user','assistant-report')"];
  const workRows: SqlRow[] = [];
  let workPages = 0, workComplete = true;
  for (const condition of workConditions) {
    const remaining = EPISODE_STATE_LIMITS.composeScanPages - workPages;
    if (remaining <= 0) { workComplete = false; break; }
    const scan = boundedCategoryRows(store, line, active, condition, [], stateGeneration, processedCut, remaining);
    workRows.push(...scan.rows); workPages += scan.pages;
    if (!scan.complete) { workComplete = false; break; }
  }
  const workScan = { rows: workRows.slice(0, EPISODE_STATE_LIMITS.composeScannedPerCategory), complete: workComplete, pages: workPages };
  const restrictionRows = restrictionScan.rows;
  const currentRows = store.rows(`SELECT * FROM state_items WHERE lineage=? AND ${active} AND kind IN ('decision','approval') ORDER BY eventSeq DESC,descriptor DESC,stableKey DESC LIMIT ?`,
    EPISODE_STATE_LIMITS.composeState + 1, line, stateGeneration, processedCut, stateGeneration, processedCut, EPISODE_STATE_LIMITS.composeState + 1);
  // Select successive experience across boundaries, not only the latest episode.
  const latestEpisode = store.get("SELECT startEventSeq FROM episodes WHERE lineage=? AND createdGeneration<=? AND startEventSeq<=? ORDER BY startEventSeq DESC,createdGeneration DESC LIMIT 1", line, stateGeneration, processedCut);
  const recentEnd = store.rows("SELECT * FROM episode_membership WHERE lineage=? AND createdGeneration<=? AND eventSeq<=? ORDER BY eventSeq DESC,descriptor DESC,sourceKey DESC LIMIT ?",
    EPISODE_STATE_LIMITS.composeRecentMembers + 1, line, stateGeneration, processedCut, EPISODE_STATE_LIMITS.composeRecentMembers + 1);
  const recentStartRows = latestEpisode ? store.rows("SELECT * FROM episode_membership WHERE lineage=? AND createdGeneration<=? AND eventSeq>=? AND eventSeq<=? ORDER BY eventSeq,descriptor,sourceKey LIMIT 6",
    6, line, stateGeneration, num(latestEpisode, "startEventSeq"), processedCut) : [];
  const recentBySource = new Map([...recentStartRows, ...recentEnd.slice(0, 6)].map(row => [str(row, "sourceKey"), row]));
  const recentRows = [...recentBySource.values()].sort((a, b) => num(b, "eventSeq") - num(a, "eventSeq") || num(b, "descriptor") - num(a, "descriptor"));
  const member = (row: SqlRow): EpisodeStateSelectionMember => {
    const episode = store.get("SELECT * FROM episodes WHERE lineage=? AND episodeKey=? AND createdGeneration<=? AND endEventSeq<=? ORDER BY createdGeneration DESC LIMIT 1",
      line, str(row, "episodeKey"), stateGeneration, processedCut) ?? fail("search-v3-state-checkpoint-corrupt");
    return { episodeKey: str(row, "episodeKey"), eventSeq: num(row, "eventSeq"), descriptor: num(row, "descriptor"), sourceKey: str(row, "sourceKey"),
      source: JSON.parse(str(row, "source")), cue: visibleMemberCue(store, row, stateGeneration, processedCut), episode: {
        start: { eventSeq: num(episode, "startEventSeq"), descriptor: num(episode, "startDescriptor") },
        end: { eventSeq: num(episode, "endEventSeq"), descriptor: num(episode, "endDescriptor") }, open: num(episode, "open") === 1,
        objective: str(episode, "objective"), objectiveEvidence: JSON.parse(str(episode, "objectiveEvidence")) } };
  };
  // Keep query authority order through representation reservation. Chronology is restored only after packing.
  const protectedItems = [...restrictionRows, ...workRows].map(row => selectionItem(row, processedCut));
  const currentItems = currentRows.slice(0, EPISODE_STATE_LIMITS.composeState).reverse().map(row => selectionItem(row, processedCut));
  const recentItems = recentRows.slice(0, EPISODE_STATE_LIMITS.composeRecentMembers).reverse().map(member);
  // Older experience is selected through existing obligation-to-episode membership,
  // not a new score. It stays historical and remains exactly recoverable.
  const olderItems: EpisodeStateSelectionMember[] = [];
  const seenSources = new Set(recentItems.map(item => item.sourceKey));
  const recentStart = recentItems[0]?.eventSeq ?? processedCut + 1;
  for (const item of protectedItems.slice(0, 3)) {
    const evidence = item.evidence as { source?: ScopedBodySourceRef };
    if (!evidence.source || evidence.source.eventSeq >= recentStart) continue;
    const enclosing = store.get("SELECT episodeKey FROM episode_membership WHERE lineage=? AND sourceKey=? AND createdGeneration<=? LIMIT 1",
      line, sourceKey(evidence.source), stateGeneration);
    if (!enclosing) continue;
    const rows = store.rows("SELECT * FROM episode_membership WHERE lineage=? AND episodeKey=? AND createdGeneration<=? AND eventSeq<? ORDER BY eventSeq DESC,descriptor DESC,sourceKey DESC LIMIT 4",
      4, line, str(enclosing, "episodeKey"), stateGeneration, recentStart);
    for (const row of rows.reverse()) if (!seenSources.has(str(row, "sourceKey"))) {
      seenSources.add(str(row, "sourceKey")); olderItems.push(member(row));
    }
  }
  olderItems.sort((a, b) => a.eventSeq - b.eventSeq || a.descriptor - b.descriptor || a.sourceKey.localeCompare(b.sourceKey));
  let protectedAtLeastOne = !restrictionScan.complete;
  let openWorkAtLeastOne = !workScan.complete;
  let restrictionWorkExhausted = !restrictionScan.complete;
  let openWorkExhausted = !workScan.complete;
  let renderedOverflowAtLeastOne = false;
  let currentAtLeastOne = currentRows.length > EPISODE_STATE_LIMITS.composeState;
  let recentAtLeastOne = recentEnd.length > recentRows.length;
  let responseBudgetAtLeastOne = false;
  const bodyComplete = bodyCut >= requestedCut, metadataComplete = processedMemoryCut >= requestedCut;
  const partialMemory = !metadataComplete;
  const gap = (column: "restrictionGap" | "openWorkGap" | "optionalGap"): boolean => Boolean(store.get(
    `SELECT eventSeq FROM coverage WHERE lineage=? AND ${column}=1 AND eventSeq<=? AND generation<=? LIMIT 1`, line, processedCut, stateGeneration));
  const restrictionsComplete = bodyComplete && metadataComplete && !gap("restrictionGap");
  const openWorkComplete = bodyComplete && metadataComplete && !gap("openWorkGap");
  const qualifiedReducers = gap("optionalGap");
  const build = (): EpisodeStateSelection => {
    const partial = !bodyComplete || !metadataComplete || qualifiedReducers || protectedAtLeastOne || openWorkAtLeastOne || currentAtLeastOne || recentAtLeastOne || responseBudgetAtLeastOne;
    return { stateGeneration, branchKey: request.view.branchKey, sourceView: request.view, requestedCut, processedCut, processedMemoryCut, complete: !partial, partial,
      coverage: { bodyComplete, metadataComplete, partialMemory, qualifiedReducers, restrictionsComplete, openWorkComplete,
        restrictionsScanComplete: !restrictionWorkExhausted, openWorkScanComplete: !openWorkExhausted }, protected: protectedItems, current: currentItems, recent: recentItems, older: olderItems,
      omissions: { protectedAtLeastOne, openWorkAtLeastOne, currentAtLeastOne, recentAtLeastOne, responseBudgetAtLeastOne,
        restrictionWorkExhausted, openWorkExhausted, renderedOverflowAtLeastOne }, metrics: { sqliteStatements: store.statements,
        mandatoryRowsScanned: restrictionRows.length + workRows.length,
        mandatoryRowsScanLimit: EPISODE_STATE_LIMITS.composeScannedPerCategory * 2,
        mandatoryScanPageLimit: EPISODE_STATE_LIMITS.composeScanPages * 2,
        outputUtf8ByteLimit: EPISODE_STATE_LIMITS.composeUtf8Bytes } };
  };
  return build();
}

/** Resolve bounded surrounding context, then charge category quotas to exact representations rather than raw rows. */
async function selectionContext(request: EpisodeStateRequest, selection: EpisodeStateSelection,
  options: EpisodeStateExecutionOptions, budget: { bytes: number }): Promise<EpisodeStateSelection> {
  const cache = new Map<string, { text: string; start: number }>();
  const enrich = async (item: EpisodeStateSelectionItem): Promise<EpisodeStateSelectionItem> => {
    const evidence = item.evidence as { source?: ScopedBodySourceRef; decodedUtf16?: { start: number; end: number }; exactText?: string };
    const source = evidence?.source;
    if (!source || source.coordinateKind !== "decoded-body" || !evidence.decodedUtf16 || typeof evidence.exactText !== "string") return item;
    if (evidence.decodedUtf16.start === source.decodedUtf16.start && evidence.decodedUtf16.end === source.decodedUtf16.end) return item;
    const readStart = Math.max(source.decodedUtf16.start, evidence.decodedUtf16.start - EPISODE_STATE_LIMITS.contextSideUnits);
    const readEnd = Math.min(source.decodedUtf16.end, evidence.decodedUtf16.end + EPISODE_STATE_LIMITS.contextSideUnits);
    const key = `${sourceKey(source)}:${readStart}:${readEnd}`;
    if (!cache.has(key)) {
      const response = await capsuleCall(request, options.capsuleExecutor ?? executeCapsuleRequest, budget, { op: "chunkRange", view: request.view,
        source, decodedStart: readStart, decodedLength: readEnd - readStart, limit: 2 });
      const bytes = Buffer.from(String(response.data), "base64"), text = bytes.toString("utf16le");
      if (bytes.length !== (readEnd - readStart) * 2 || text.length !== readEnd - readStart) fail("search-v3-state-source-invalid");
      cache.set(key, { text, start: readStart });
    }
    const window = cache.get(key)!;
    const clauseStart = evidence.decodedUtf16.start - window.start, clauseEnd = evidence.decodedUtf16.end - window.start;
    if (window.text.slice(clauseStart, clauseEnd) !== evidence.exactText) fail("search-v3-state-source-invalid");
    const before = [...window.text.slice(0, clauseStart).matchAll(/\n[ \t]*\n/gu)].at(-1);
    const after = /\n[ \t]*\n/u.exec(window.text.slice(clauseEnd));
    if (!before && readStart !== source.decodedUtf16.start || !after && readEnd !== source.decodedUtf16.end) return item;
    const start = before ? before.index! + before[0].length : 0, end = after ? clauseEnd + after.index : window.text.length;
    const context = window.text.slice(start, end), absoluteStart = window.start + start, absoluteEnd = window.start + end;
    if (Buffer.byteLength(context) > 16 * 1024) return item;
    return { ...item, evidence: { ...evidence, exactText: context, decodedUtf16: { start: absoluteStart, end: absoluteEnd },
      retainedClause: { exactText: evidence.exactText, decodedUtf16: evidence.decodedUtf16 },
      omissions: [{ beforeUtf16: absoluteStart - source.decodedUtf16.start, afterUtf16: source.decodedUtf16.end - absoluteEnd }], contextComplete: true } };
  };
  const optionalCurrent = [...selection.current], optionalRecent = [...selection.recent], optionalOlder = [...(selection.older ?? [])];
  // Pack mandatory rows first. Bounded optional candidates are refilled only after the final mandatory size is known.
  const result = { ...selection, protected: [] as EpisodeStateSelectionItem[], current: [] as EpisodeStateSelectionItem[],
    recent: [] as EpisodeStateSelectionMember[], older: [] as EpisodeStateSelectionMember[], omissions: { ...selection.omissions },
    coverage: { ...selection.coverage },
    delta: selection.delta ? { ...selection.delta, protected: [...selection.delta.protected], current: [...selection.delta.current] } : undefined };
  const representationKey = (item: EpisodeStateSelectionItem): string => {
    const evidence = item.evidence as { source?: ScopedBodySourceRef; decodedUtf16?: { start: number; end: number }; exactText?: string };
    const category = item.kind === "restriction" ? "restriction" : "work";
    if (evidence.source && evidence.decodedUtf16 && typeof evidence.exactText === "string")
      return sha(canonicalJson({ category, authority: item.authority, status: item.status, source: sourceKey(evidence.source),
        decodedUtf16: evidence.decodedUtf16, exactText: evidence.exactText }));
    return sha(canonicalJson({ category, authority: item.authority, status: item.status, subject: item.subject, revision: item.revision, evidence: item.evidence }));
  };
  const counts = { restriction: new Set<string>(), work: new Set<string>() };
  const represented = { restriction: new Map<string, number>(), work: new Map<string, number>() };
  const selectedSources = { restriction: new Set<string>(), work: new Set<string>() };
  const proposition = (item: EpisodeStateSelectionItem, representationKey: string) => ({ representationKey, stableKey: item.stableKey,
    propositionKey: item.propositionKey, spanKey: item.spanKey, subject: item.subject, revision: item.revision, kind: item.kind,
    authority: item.authority, confidence: item.confidence, status: item.status, effectiveAtCut: item.effectiveAtCut, evidence: item.evidence });
  const workPriority = (item: EpisodeStateSelectionItem): number => item.authority === "user" ? 0
    : item.authority === "assistant-report" && item.kind === "openwork" ? 1
    : item.authority === "assistant-report" ? 2 : item.authority === "verified-tool" ? 4 : 3;
  const ordered = [...selection.protected].sort((a, b) => Number(b.kind === "restriction") - Number(a.kind === "restriction")
    || (a.kind === "restriction" ? 0 : workPriority(a) - workPriority(b)));
  for (const original of ordered) {
    const category = original.kind === "restriction" ? "restriction" : "work";
    const source = (original.evidence as { source?: ScopedBodySourceRef }).source;
    const sourceId = source ? sourceKey(source) : "";
    const limit = category === "restriction" ? EPISODE_STATE_LIMITS.composeRestrictions : EPISODE_STATE_LIMITS.composeOpenWork;
    // Once a category is full, only an already represented source can prove overlap without another source read.
    if (counts[category].size >= limit && sourceId && !selectedSources[category].has(sourceId)) {
      if (category === "restriction") result.omissions.restrictionWorkExhausted = result.omissions.protectedAtLeastOne = true;
      else result.omissions.openWorkExhausted = result.omissions.openWorkAtLeastOne = true;
      continue;
    }
    const item = await enrich(original), key = representationKey(item);
    if (!counts[category].has(key) && counts[category].size >= limit) {
      if (category === "restriction") result.omissions.restrictionWorkExhausted = result.omissions.protectedAtLeastOne = true;
      else result.omissions.openWorkExhausted = result.omissions.openWorkAtLeastOne = true;
      continue;
    }
    const representedAt = represented[category].get(key);
    if (representedAt !== undefined) {
      const existing = result.protected[representedAt]!;
      // The primary item already carries the first proposition. Store only the
      // additional clauses so their exact evidence is not serialized twice.
      result.protected[representedAt] = { ...existing,
        coveredPropositions: [...(existing.coveredPropositions ?? []), proposition(original, key)] };
      continue;
    }
    counts[category].add(key); if (sourceId) selectedSources[category].add(sourceId);
    represented[category].set(key, result.protected.length);
    result.protected.push({ ...item, representationKey: key });
  }
  result.protected.sort((a, b) => {
    const left = (a.evidence as any).source, right = (b.evidence as any).source;
    return Number(left?.eventSeq ?? 0) - Number(right?.eventSeq ?? 0) || Number(left?.descriptor ?? 0) - Number(right?.descriptor ?? 0);
  });
  for (let index = 0; index < optionalCurrent.length; index++) optionalCurrent[index] = await enrich(optionalCurrent[index]!);
  if (result.delta) {
    for (let index = 0; index < result.delta.protected.length; index++) result.delta.protected[index] = await enrich(result.delta.protected[index]!);
    for (let index = 0; index < result.delta.current.length; index++) result.delta.current[index] = await enrich(result.delta.current[index]!);
  }
  result.coverage.restrictionsScanComplete = !result.omissions.restrictionWorkExhausted;
  result.coverage.openWorkScanComplete = !result.omissions.openWorkExhausted;
  while (Buffer.byteLength(JSON.stringify(result)) > EPISODE_STATE_LIMITS.composeUtf8Bytes) {
    result.omissions.responseBudgetAtLeastOne = true; result.omissions.renderedOverflowAtLeastOne = true;
    const removableWork = result.protected.reduce((selected, item, index, all) => {
      if (item.kind === "restriction") return selected;
      if (selected < 0 || workPriority(item) > workPriority(all[selected]!)) return index;
      if (workPriority(item) === workPriority(all[selected]!)
        && Buffer.byteLength(JSON.stringify(item)) > Buffer.byteLength(JSON.stringify(all[selected]!))) return index;
      return selected;
    }, -1);
    if (removableWork >= 0) { result.protected.splice(removableWork, 1); result.omissions.openWorkAtLeastOne = true; continue; }
    if (result.protected.length) { result.protected.pop(); result.omissions.protectedAtLeastOne = true; continue; }
    fail("search-v3-state-response-limit");
  }
  const refill = <T>(candidates: readonly T[], target: T[], omission: "currentAtLeastOne" | "recentAtLeastOne"): void => {
    for (const candidate of candidates) {
      target.push(candidate);
      if (Buffer.byteLength(JSON.stringify(result)) <= EPISODE_STATE_LIMITS.composeUtf8Bytes) continue;
      target.pop(); result.omissions[omission] = true;
      result.omissions.responseBudgetAtLeastOne = true; result.omissions.renderedOverflowAtLeastOne = true;
    }
  };
  // This is the inverse of the former shedding priority: recent chronology, then current state, then older context.
  refill(optionalRecent, result.recent, "recentAtLeastOne");
  refill(optionalCurrent, result.current, "currentAtLeastOne");
  for (const candidate of optionalOlder) {
    result.older.push(candidate);
    if (Buffer.byteLength(JSON.stringify(result)) <= EPISODE_STATE_LIMITS.composeUtf8Bytes) continue;
    result.older.pop(); result.omissions.responseBudgetAtLeastOne = true; result.omissions.renderedOverflowAtLeastOne = true;
  }
  // Omission flags also consume bytes. If the first new flag crosses the boundary, remove only already-refilled optional detail.
  while (Buffer.byteLength(JSON.stringify(result)) > EPISODE_STATE_LIMITS.composeUtf8Bytes) {
    if (result.older.length) { result.older.pop(); continue; }
    if (result.current.length) { result.current.pop(); result.omissions.currentAtLeastOne = true; continue; }
    if (result.recent.length) { result.recent.pop(); result.omissions.recentAtLeastOne = true; continue; }
    fail("search-v3-state-response-limit");
  }
  const loss = Object.values(result.omissions).some(Boolean);
  return { ...result, partial: result.partial || loss, complete: result.complete && !loss };
}

/** Read a small committed capsule delta, never derive missing capsules or replay lifetime state. */
async function selectionDelta(request: Extract<EpisodeStateRequest, { op: "composeStateSelection" }>, selection: EpisodeStateSelection,
  options: EpisodeStateExecutionOptions, budget: { bytes: number }): Promise<EpisodeStateSelection> {
  const start = selection.processedCut, end = selection.requestedCut;
  const empty = (reason: string): EpisodeStateSelection => ({ ...selection, delta: { verified: start === end, throughCut: start,
    reason, protected: [], current: [], recent: [] } });
  if (start === end) return empty("already-processed");
  const catalog = options.catalogExecutor ?? executeCatalogStoreRequest, capsules = options.capsuleExecutor ?? executeCapsuleRequest;
  if (end - start > 64) {
    // Independent recent experience can be useful despite an unbridgeable state lag.
    // It does not certify or reconstruct the gap between memory and this suffix.
    try {
      const page = await capsuleCall(request, capsules, budget, { op: "capsulePage", view: request.view,
        afterEventSeq: Math.max(start, end - EPISODE_STATE_LIMITS.composeRecentMembers), afterDescriptor: Number.MAX_SAFE_INTEGER, limit: 8 });
      const recent: EpisodeStateSelectionMember[] = [];
      for (const envelope of (page.capsules ?? []) as ReducerEnvelope[]) {
        if (envelope.source.eventSeq <= start || envelope.source.eventSeq > end) fail("search-v3-state-source-invalid");
        const reduced = reduceEpisodeStateEnvelope(envelope, undefined);
        if (reduced.capsuleCue) recent.push({ episodeKey: `recent-capsule:${envelope.source.eventSeq}`, eventSeq: envelope.source.eventSeq,
          descriptor: envelope.source.descriptor, sourceKey: sourceKey(envelope.source), source: envelope.source, cue: reduced.capsuleCue,
          episode: { start: { eventSeq: envelope.source.eventSeq, descriptor: envelope.source.descriptor },
            end: { eventSeq: envelope.source.eventSeq, descriptor: envelope.source.descriptor }, open: true, objective: "", objectiveEvidence: null } });
      }
      const result = { ...selection, delta: { verified: false, throughCut: start, reason: "lag-exceeds-bounded-delta; recent-window-only",
        protected: [], current: [], recent } };
      return Buffer.byteLength(JSON.stringify(result)) <= EPISODE_STATE_LIMITS.composeUtf8Bytes ? result : empty("recent-response-budget-exceeded");
    } catch (error) {
      if ((error as { code?: string }).code === "search-v3-state-capsule-unavailable") return empty("lag-exceeds-bounded-delta; recent-capsules-unavailable");
      throw error;
    }
  }
  const events = await catalogCall(request, catalog, budget, { op: "page", view: request.view, after: start, limit: 64 });
  const metadata = (events.events ?? []) as CatalogEventRow[];
  // Metadata writers require their maintained reducer/checkpoint, not an ad-hoc overlay.
  if (metadata.some(event => ["chrono-memory-v2-event", "chrono-compact-retention-hint"].includes(String(event.metadata?.customType))))
    return empty("delta-requires-metadata-materialization");
  const protectedItems: EpisodeStateSelectionItem[] = [], current: EpisodeStateSelectionItem[] = [], recent: EpisodeStateSelectionMember[] = [];
  let afterEventSeq = start, afterDescriptor = Number.MAX_SAFE_INTEGER, complete = false, qualified = false;
  for (let pageIndex = 0; pageIndex < 8 && !complete; pageIndex++) {
    const page = await capsuleCall(request, capsules, budget, { op: "capsulePage", view: request.view, afterEventSeq, afterDescriptor, limit: 8 });
    for (const envelope of (page.capsules ?? []) as ReducerEnvelope[]) {
      if (envelope.source.eventSeq <= start || envelope.source.eventSeq > end) fail("search-v3-state-source-invalid");
      const reduced = reduceEpisodeStateEnvelope(envelope, await body(request, envelope, capsules, budget),
        await exactStructural(request, envelope, catalog, budget));
      qualified ||= reduced.partial || reduced.states.some(item => !!item.transition);
      for (const item of reduced.states) {
        const selected = { ...item, effectiveAtCut: end };
        if (["restriction", "openwork", "blocker"].includes(item.kind)) protectedItems.push(selected);
        else if (["goal", "decision"].includes(item.kind)) current.push(selected);
      }
      if (reduced.capsuleCue) recent.push({ episodeKey: `delta:${envelope.source.eventSeq}`, eventSeq: envelope.source.eventSeq,
        descriptor: envelope.source.descriptor, sourceKey: sourceKey(envelope.source), source: envelope.source, cue: reduced.capsuleCue,
        episode: { start: { eventSeq: envelope.source.eventSeq, descriptor: envelope.source.descriptor },
          end: { eventSeq: envelope.source.eventSeq, descriptor: envelope.source.descriptor }, open: true,
          objective: reduced.objective?.exactText ?? "", objectiveEvidence: reduced.objective ?? null } });
    }
    complete = page.complete === true;
    if (!complete && (!page.next || (page.next.afterEventSeq === afterEventSeq && page.next.afterDescriptor === afterDescriptor)))
      fail("search-v3-state-cursor-invalid");
    afterEventSeq = Number(page.next?.afterEventSeq ?? afterEventSeq); afterDescriptor = Number(page.next?.afterDescriptor ?? afterDescriptor);
  }
  if (protectedItems.length + current.length + recent.length > 64) return empty("delta-row-budget-exceeded");
  const delta = { verified: complete && !qualified && metadata.at(-1)?.seq === end, throughCut: complete ? end : start,
    reason: !complete ? "delta-capsules-incomplete" : qualified ? "delta-extraction-qualified" : "bounded-committed-delta",
    protected: protectedItems, current, recent };
  const result = { ...selection, delta };
  if (Buffer.byteLength(JSON.stringify(result)) > EPISODE_STATE_LIMITS.composeUtf8Bytes) return empty("delta-response-budget-exceeded");
  return result;
}

function status(request: Extract<EpisodeStateRequest, { op: "stateStatus" }>, store: Store): Record<string, unknown> {
  const generation = num(store.get("SELECT generation FROM meta WHERE singleton=1")!, "generation"), head = store.get("SELECT * FROM heads WHERE lineage=?", lineage(request));
  if (!head) return { identity: request.identity, ruleset: EPISODE_STATE_RULESET_VERSION, stateGeneration: generation, knownThroughCut: 0, knownThrough: 0, partial: true,
    readiness: "missing", metadata: { afterEventSeq: 0, complete: false }, requestedView: { branchKey: request.view.branchKey, eventCut: request.view.eventCut, hash: viewHash(request) }, metrics: { sqliteStatements: store.statements } };
  let indexed: EpisodeStateRequest["view"]; try { indexed = JSON.parse(str(head, "view")); } catch { return fail("search-v3-state-checkpoint-corrupt"); }
  const compatible = extendsView(request.view, indexed) || extendsView(indexed, request.view), knownThrough = compatible ? Math.min(request.view.eventCut, num(head, "afterEventSeq")) : 0;
  const complete = compatible && num(head, "complete") === 1 && num(head, "metadataComplete") === 1 && indexed.eventCut >= request.view.eventCut;
  const knownThroughCut = complete ? request.view.eventCut : Math.max(0, Math.min(knownThrough - 1, num(head, "metadataAfterEventSeq")));
  const partial = !complete || knownThroughCut < request.view.eventCut || num(head, "partialCount") > 0;
  const active = store.get("SELECT * FROM large_bodies WHERE lineage=?", lineage(request));
  const checkpoint = active && compatible ? decodeStateCheckpoint({ ...request, view: indexed }, active, indexed) : undefined;
  return { identity: request.identity, ruleset: EPISODE_STATE_RULESET_VERSION, stateGeneration: generation, knownThroughCut, knownThrough: knownThroughCut, complete, partial,
    readiness: compatible ? partial ? "partial" : "ready" : "incompatible", requestedView: { branchKey: request.view.branchKey, eventCut: request.view.eventCut, hash: viewHash(request) },
    indexedView: { branchKey: indexed.branchKey, eventCut: indexed.eventCut, complete },
    cursor: { eventSeq: num(head, "afterEventSeq"), descriptor: num(head, "afterDescriptor"), generation: num(head, "generation") },
    ...(checkpoint && sourceRefWithinViewBounds(checkpoint.envelope.source, request.view)
      ? { bodyCheckpoint: bodyCheckpointProgress(checkpoint, num(active!, "nextDecoded")) } : {}),
    metadata: { afterEventSeq: num(head, "metadataAfterEventSeq"), complete: num(head, "metadataComplete") === 1 }, metrics: { sqliteStatements: store.statements } };
}

export interface EpisodeRollupInputCursor {
  readonly episodeStartEventSeq: number;
  readonly episodeStartDescriptor: number;
  readonly episodeKey: string;
  readonly memberEventSeq: number;
  readonly memberDescriptor: number;
  readonly memberSourceKey: string;
  readonly episodeComplete: boolean;
  readonly fragmentIndex: number;
  /** One immutable state/source snapshot is retained across every leaf page in a publication cycle. */
  readonly snapshot?: {
    readonly stateGeneration: number;
    readonly requestedCut: number;
    readonly processedCut: number;
    readonly processedMemoryCut: number;
    readonly sourceView: EpisodeStateRequest["view"];
  };
}
export interface EpisodeRollupProtectedInput {
  readonly stableKey: string;
  readonly kind: string;
  readonly status: string;
  readonly authority: string;
  readonly confidence: string;
  readonly evidence: unknown;
}
export interface EpisodeRollupMetadataInput {
  readonly stableKey: string;
  readonly kind: "memory" | "retention-hint";
  readonly effectiveAuthority: "ordinary-memory";
  readonly effectiveConfidence: "advisory";
  /** Historical records remain recoverable but are never presented as effective current hints. */
  readonly temporalStatus: "current" | "historical";
  readonly data: unknown;
  readonly evidence: unknown;
}
export interface EpisodeRollupMemberInput {
  readonly eventSeq: number;
  readonly descriptor: number;
  readonly sourceKey: string;
  readonly source: ScopedBodySourceRef | ScopedRawSourceRef;
  readonly cue: string;
  readonly exactBody?: string;
  readonly exactBodyOmitted?: "bounded-source";
}
export interface EpisodeRollupInputPage {
  readonly stateGeneration: number;
  readonly requestedCut: number;
  readonly processedCut: number;
  readonly processedMemoryCut: number;
  /** Compatibility alias for processedCut. */
  readonly knownThroughCut: number;
  readonly complete: boolean;
  readonly next?: EpisodeRollupInputCursor;
  readonly episode?: {
    readonly episodeKey: string;
    readonly start: { readonly eventSeq: number; readonly descriptor: number };
    readonly end: { readonly eventSeq: number; readonly descriptor: number };
    /** This is only a closed chronological interval, never inferred task completion. */
    readonly closure: "next-episode-boundary";
    readonly memberCount: number;
    readonly objective: string;
    readonly objectiveEvidence: unknown;
    readonly fragmentIndex: number;
    readonly episodeFragment: boolean;
    readonly members: readonly EpisodeRollupMemberInput[];
    readonly protected: readonly EpisodeRollupProtectedInput[];
    readonly omittedProtectedCount: number;
    readonly metadata: readonly EpisodeRollupMetadataInput[];
    readonly omittedMetadataCount: number;
  };
}

/** Bounded read-only export for M08. It never creates or mutates state-v4.sqlite. */
export async function readEpisodeRollupInputPage(request: EpisodeStateRequest, cursor: EpisodeRollupInputCursor | undefined,
  options: EpisodeStateExecutionOptions = {}, budget: { bytes: number } = { bytes: 0 }): Promise<EpisodeRollupInputPage> {
  let db: CatalogSqlite | undefined;
  try {
    prepareDirectory(request.searchDirectory);
    const path = join(request.searchDirectory, "state-v4.sqlite");
    db = CatalogSqlite.open(path, candidate => new Store(candidate, request).validate(false));
    const store = new Store(db, request), line = lineage(request), head = store.get("SELECT * FROM heads WHERE lineage=?", line);
    const headRow = head ?? fail("search-v3-rollup-state-not-ready");
    const indexed = JSON.parse(str(headRow, "view")) as EpisodeStateRequest["view"];
    if (!extendsView(indexed, request.view) && !extendsView(request.view, indexed)) fail("search-v3-rollup-state-not-ready");
    const priorSnapshot = cursor?.snapshot;
    if (priorSnapshot && (!extendsView(request.view, priorSnapshot.sourceView) || priorSnapshot.requestedCut !== priorSnapshot.sourceView.eventCut
      || priorSnapshot.processedCut > priorSnapshot.requestedCut || priorSnapshot.processedMemoryCut > priorSnapshot.requestedCut
      || priorSnapshot.stateGeneration > num(headRow, "generation"))) fail("search-v3-rollup-state-snapshot-invalid");
    const requestedCut = priorSnapshot?.requestedCut ?? request.view.eventCut;
    const bodyCut = num(headRow, "complete") === 1 ? Math.min(requestedCut, indexed.eventCut)
      : Math.max(0, Math.min(requestedCut, num(headRow, "afterEventSeq") - 1));
    const processedMemoryCut = priorSnapshot?.processedMemoryCut
      ?? Math.max(0, Math.min(requestedCut, num(headRow, "metadataAfterEventSeq")));
    const processedCut = priorSnapshot?.processedCut ?? Math.min(bodyCut, processedMemoryCut);
    const stateGeneration = priorSnapshot?.stateGeneration ?? num(headRow, "generation");
    const sourceView = priorSnapshot?.sourceView ?? request.view;
    const snapshot = { stateGeneration, requestedCut, processedCut, processedMemoryCut, sourceView };
    const sourceRequest = { ...request, view: sourceView } as EpisodeStateRequest;
    const same = Boolean(cursor && !cursor.episodeComplete);
    const episode = same
      ? store.get("SELECT e.* FROM episodes e WHERE e.lineage=? AND e.episodeKey=? AND e.createdGeneration=(SELECT MAX(v.createdGeneration) FROM episodes v WHERE v.lineage=e.lineage AND v.episodeKey=e.episodeKey AND v.createdGeneration<=?) AND e.open=0 AND e.endEventSeq<=?", line, cursor!.episodeKey, stateGeneration, processedCut)
      : store.get("SELECT e.* FROM episodes e WHERE e.lineage=? AND e.createdGeneration=(SELECT MAX(v.createdGeneration) FROM episodes v WHERE v.lineage=e.lineage AND v.episodeKey=e.episodeKey AND v.createdGeneration<=?) AND e.open=0 AND e.endEventSeq<=? AND (e.startEventSeq>? OR (e.startEventSeq=? AND (e.startDescriptor>? OR (e.startDescriptor=? AND e.episodeKey>?)))) ORDER BY e.startEventSeq,e.startDescriptor,e.episodeKey LIMIT 1", line, stateGeneration, processedCut,
        cursor?.episodeStartEventSeq ?? 0, cursor?.episodeStartEventSeq ?? 0, cursor?.episodeStartDescriptor ?? 0,
        cursor?.episodeStartDescriptor ?? 0, cursor?.episodeKey ?? "");
    if (!episode) return { stateGeneration, requestedCut, processedCut, processedMemoryCut, knownThroughCut: processedCut, complete: true,
      next: cursor ? { ...cursor, snapshot } : { episodeStartEventSeq: 0, episodeStartDescriptor: 0, episodeKey: "", memberEventSeq: 0,
        memberDescriptor: 0, memberSourceKey: "", episodeComplete: true, fragmentIndex: 0, snapshot } };
    const episodeKey = str(episode, "episodeKey"), afterEvent = same ? cursor!.memberEventSeq : 0,
      afterDescriptor = same ? cursor!.memberDescriptor : 0, afterSource = same ? cursor!.memberSourceKey : "";
    const rows = store.rows("SELECT * FROM episode_membership WHERE lineage=? AND episodeKey=? AND createdGeneration<=? AND eventSeq<=? AND (eventSeq>? OR (eventSeq=? AND (descriptor>? OR (descriptor=? AND sourceKey>?)))) ORDER BY eventSeq,descriptor,sourceKey LIMIT ?",
      EPISODE_STATE_LIMITS.rollupLeafMembers + 1, line, episodeKey, stateGeneration, processedCut, afterEvent, afterEvent, afterDescriptor, afterDescriptor, afterSource,
      EPISODE_STATE_LIMITS.rollupLeafMembers + 1);
    const selected = rows.slice(0, EPISODE_STATE_LIMITS.rollupLeafMembers), members: EpisodeRollupMemberInput[] = [];
    for (const row of selected) {
      const source = JSON.parse(str(row, "source")) as ScopedBodySourceRef | ScopedRawSourceRef;
      if (source.coordinateKind === "decoded-body") {
        const exact = await body(sourceRequest, { source } as ReducerEnvelope, options.capsuleExecutor ?? executeCapsuleRequest, budget);
        members.push({ eventSeq: num(row, "eventSeq"), descriptor: num(row, "descriptor"), sourceKey: str(row, "sourceKey"), source,
          cue: visibleMemberCue(store, row, stateGeneration, processedCut), ...(exact === undefined ? { exactBodyOmitted: "bounded-source" as const } : { exactBody: exact }) });
      } else members.push({ eventSeq: num(row, "eventSeq"), descriptor: num(row, "descriptor"), sourceKey: str(row, "sourceKey"), source,
        cue: visibleMemberCue(store, row, stateGeneration, processedCut) });
    }
    if (!members.length) fail("search-v3-rollup-input-invalid");
    const protectedRows = store.rows("SELECT stableKey,kind,status,authority,confidence,evidence FROM state_items WHERE lineage=? AND createdGeneration<=? AND eventSeq>=? AND eventSeq<=? AND kind IN ('restriction','blocker','openwork') AND (supersededGeneration IS NULL OR supersededGeneration>? OR COALESCE(json_extract(resolutionEvidence,'$.effectiveAtCut'),json_extract(resolutionEvidence,'$.source.eventSeq'))>?) ORDER BY eventSeq,descriptor,stableKey LIMIT ?",
      EPISODE_STATE_LIMITS.rollupProtectedPerNode + 1, line, stateGeneration, num(episode, "startEventSeq"), num(episode, "endEventSeq"), stateGeneration, processedCut, EPISODE_STATE_LIMITS.rollupProtectedPerNode + 1);
    const memoryRows = store.rows("SELECT stableKey,'memory' AS kind,text AS data,evidence FROM memory_items WHERE lineage=? AND createdGeneration<=? AND eventSeq>=? AND eventSeq<=? ORDER BY eventSeq,stableKey LIMIT ?",
      EPISODE_STATE_LIMITS.rollupMetadataPerNode + 1, line, stateGeneration, num(episode, "startEventSeq"), num(episode, "endEventSeq"), EPISODE_STATE_LIMITS.rollupMetadataPerNode + 1);
    const retentionRows = store.rows("SELECT stableKey,'retention-hint' AS kind,data,evidence FROM retention_hints WHERE lineage=? AND createdGeneration<=? AND eventSeq>=? AND eventSeq<=? ORDER BY eventSeq,stableKey LIMIT ?",
      EPISODE_STATE_LIMITS.rollupMetadataPerNode + 1, line, stateGeneration, num(episode, "startEventSeq"), num(episode, "endEventSeq"), EPISODE_STATE_LIMITS.rollupMetadataPerNode + 1);
    const metadataRows = [...memoryRows, ...retentionRows].sort((a, b) => str(a, "stableKey").localeCompare(str(b, "stableKey")));
    const last = selected.at(-1), episodeComplete = rows.length <= EPISODE_STATE_LIMITS.rollupLeafMembers;
    const next = last ? { episodeStartEventSeq: num(episode, "startEventSeq"), episodeStartDescriptor: num(episode, "startDescriptor"), episodeKey,
      memberEventSeq: num(last, "eventSeq"), memberDescriptor: num(last, "descriptor"), memberSourceKey: str(last, "sourceKey"), episodeComplete,
      fragmentIndex: same ? cursor!.fragmentIndex + 1 : 0, snapshot } : undefined;
    return { stateGeneration, requestedCut, processedCut, processedMemoryCut, knownThroughCut: processedCut, complete: false, ...(next ? { next } : {}), episode: { episodeKey,
      start: { eventSeq: num(episode, "startEventSeq"), descriptor: num(episode, "startDescriptor") },
      end: { eventSeq: num(episode, "endEventSeq"), descriptor: num(episode, "endDescriptor") }, closure: "next-episode-boundary",
      memberCount: num(episode, "memberCount"), objective: str(episode, "objective"), objectiveEvidence: JSON.parse(str(episode, "objectiveEvidence")),
      fragmentIndex: same ? cursor!.fragmentIndex + 1 : 0,
      episodeFragment: !episodeComplete || same, members,
      protected: protectedRows.slice(0, EPISODE_STATE_LIMITS.rollupProtectedPerNode).map(row => ({ stableKey: str(row, "stableKey"), kind: str(row, "kind"), status: str(row, "status"), authority: str(row, "authority"), confidence: str(row, "confidence"), evidence: JSON.parse(str(row, "evidence")) })),
      omittedProtectedCount: Math.max(0, protectedRows.length - EPISODE_STATE_LIMITS.rollupProtectedPerNode),
      metadata: metadataRows.slice(0, EPISODE_STATE_LIMITS.rollupMetadataPerNode).map(row => {
        const kind = str(row, "kind") as "memory" | "retention-hint";
        // Immutable leaves can outlive later demotion/forget events, so their hints are always historical records.
        return { stableKey: str(row, "stableKey"), kind, effectiveAuthority: "ordinary-memory" as const, effectiveConfidence: "advisory" as const,
          temporalStatus: "historical" as const, data: kind === "retention-hint" ? JSON.parse(str(row, "data")) : str(row, "data"),
          evidence: JSON.parse(str(row, "evidence")) };
      }),
      omittedMetadataCount: Math.max(0, metadataRows.length - EPISODE_STATE_LIMITS.rollupMetadataPerNode) } };
  } finally { try { db?.close(); } catch { /* read-only close */ } }
}

/** Direct executor for tests and the existing contained search-v3 worker. */
export async function executeEpisodeStateRequest(value: unknown, options: EpisodeStateExecutionOptions = {}): Promise<EpisodeStateResponse> {
  if (!isEpisodeStateRequest(value)) return { v: 1, ok: false, code: "search-v3-state-request-invalid", sourceBytes: 0,
    sqliteNativeLimitBytes: EPISODE_STATE_LIMITS.nativeSqliteBytes, resumable: false };
  const request = value;
  if (request.op === "materializeRollup" || request.op === "rollupStatus" || request.op === "repairRollup" || request.op === "composeRollupSelection" || request.op === "recallRollup") {
    const { executeEpisodeRollupRequest } = await import("./episode-rollup-store.js");
    return executeEpisodeRollupRequest(request, options);
  }
  const create = request.op === "materializeState", mutate = create || request.op === "supersedeState";
  let db: CatalogSqlite | undefined; const budget = { bytes: 0 };
  try {
    prepareDirectory(request.searchDirectory);
    // Authorize this exact view and current physical source even for read-only memory.
    await catalogCall(request, options.catalogExecutor ?? executeCatalogStoreRequest, budget, { op: "page", view: request.view, after: request.view.eventCut, limit: 1 });
    const action = async (): Promise<EpisodeStateResponse> => {
      const path = join(request.searchDirectory, "state-v4.sqlite"), validate = (candidate: CatalogSqlite): void => new Store(candidate, request).validate(create);
      if (request.op === "stateStatus" || request.op === "composeStateSelection") {
        try { lstatSync(path); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("search-v3-state-store-missing");
          throw error;
        }
      }
      db = create ? CatalogSqlite.create(path, validate) : CatalogSqlite.open(path, validate);
      const store = new Store(db, request); if (create) store.initialize(); else store.validate(false);
      const result = request.op === "materializeState" ? await materialize(request, store, options.capsuleExecutor ?? executeCapsuleRequest,
        options.catalogExecutor ?? executeCatalogStoreRequest, budget)
        : request.op === "supersedeState" ? await supersedeState(request, store, options, budget)
        : request.op === "recallState" ? recall(request, store)
        : request.op === "composeStateSelection" ? await selectionContext(request, await selectionDelta(request, composeStateSelection(request, store), options, budget), options, budget) : status(request, store);
      const response: EpisodeStateResponse = { v: 1, ok: true, result: { ...result,
        coverageScope: "Body capsules plus structurally validated ordinary writer metadata. Custom type and hash-chain checks are not producer authentication; no metadata gains instruction authority.",
      }, sourceBytes: budget.bytes, sqliteNativeLimitBytes: EPISODE_STATE_LIMITS.nativeSqliteBytes };
      if (Buffer.byteLength(JSON.stringify(response)) > EPISODE_STATE_LIMITS.responseBytes) fail("search-v3-state-response-limit");
      if (mutate) try { db.checkpoint(); } catch { /* committed WAL remains authoritative */ }
      return response;
    };
    return mutate ? await withRuntimeMutex(join(request.searchDirectory, "state-publication.lock"), action) : await action();
  } catch (error) {
    const candidate = (error as { code?: string }).code;
    const mapped: Record<string, string> = { "catalog-storage-unsafe": "search-v3-state-storage-unsafe", "catalog-sqlite-busy": "search-v3-state-store-busy",
      "catalog-sqlite-corrupt": "search-v3-state-store-corrupt", "catalog-sqlite-capability": "search-v3-state-store-capability", "catalog-sqlite-limit": "search-v3-state-store-limit",
      "catalog-sqlite-failed": "search-v3-state-store-failed", "catalog-sqlite-unavailable": "search-v3-state-store-capability" };
    const code = candidate?.startsWith("search-v3-state-") ? candidate : candidate && mapped[candidate] ? mapped[candidate]! : candidate === "ENOSPC" ? "search-v3-state-storage-full" : "search-v3-state-storage-io";
    return { v: 1, ok: false, code, sourceBytes: budget.bytes, sqliteNativeLimitBytes: EPISODE_STATE_LIMITS.nativeSqliteBytes,
      resumable: !["search-v3-state-request-invalid", "search-v3-state-store-mismatch", "search-v3-state-version-mismatch", "search-v3-state-storage-unsafe"].includes(code) };
  } finally { try { db?.close(); } catch { /* preserve bounded response */ } }
}
