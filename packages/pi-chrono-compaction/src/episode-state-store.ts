import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CapsuleWorkerResponse, ReducerEnvelope, ScopedBodySourceRef, ScopedRawSourceRef } from "./capsule-contract.js";
import { executeCapsuleRequest } from "./capsule-store.js";
import type { CatalogResponse } from "./catalog-contract.js";
import { executeCatalogStoreRequest } from "./catalog-store.js";
import { canonicalJson } from "./capsule-segment.js";
import { CatalogSqlite, type SqlRow, type SqlValue } from "./catalog-sqlite.js";
import {
  EPISODE_STATE_LIMITS,
  EPISODE_STATE_RULESET_VERSION,
  EPISODE_STATE_SCHEMA_VERSION,
  isEpisodeStateRequest,
  type EpisodeStateAfter,
  type EpisodeStateRequest,
  type EpisodeStateResponse,
} from "./episode-state-contract.js";
import { reduceEpisodeStateEnvelope, type ReducedEpisodeEvent, type VerifiedEventStructuralFacts } from "./episode-state-reducer.js";
import { withRuntimeMutex } from "./worker-runtime-mutex.js";

const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const num = (row: SqlRow, key: string): number => Number(row[key]);
const str = (row: SqlRow, key: string): string => String(row[key]);
const sourceKey = (source: ScopedBodySourceRef): string => sha(canonicalJson(source));
const lineage = (request: EpisodeStateRequest): string => sha(canonicalJson({ branchKey: request.view.branchKey, segments: request.view.segments.map(item => item.segment) }));
const viewHash = (request: EpisodeStateRequest): string => sha(canonicalJson(request.view));
const schema = [
  "CREATE TABLE meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, identity TEXT NOT NULL, searchRoute TEXT NOT NULL, capsuleRoute TEXT NOT NULL, catalogRoute TEXT NOT NULL, ruleset TEXT NOT NULL, generation INTEGER NOT NULL)",
  "CREATE TABLE cuts (lineage TEXT NOT NULL, eventSeq INTEGER NOT NULL, descriptor INTEGER NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY(lineage,eventSeq,descriptor)) WITHOUT ROWID",
  "CREATE TABLE heads (lineage TEXT PRIMARY KEY, view TEXT NOT NULL, afterEventSeq INTEGER NOT NULL, afterDescriptor INTEGER NOT NULL, generation INTEGER NOT NULL, complete INTEGER NOT NULL, partialCount INTEGER NOT NULL)",
  "CREATE TABLE episodes (lineage TEXT NOT NULL, episodeKey TEXT NOT NULL, startEventSeq INTEGER NOT NULL, startDescriptor INTEGER NOT NULL, endEventSeq INTEGER NOT NULL, endDescriptor INTEGER NOT NULL, open INTEGER NOT NULL, memberCount INTEGER NOT NULL, objective TEXT NOT NULL, objectiveEvidence TEXT NOT NULL, createdGeneration INTEGER NOT NULL, PRIMARY KEY(lineage,episodeKey,createdGeneration)) WITHOUT ROWID",
  "CREATE INDEX episodes_page ON episodes(lineage,createdGeneration,startEventSeq,startDescriptor,episodeKey)",
  "CREATE TABLE episode_membership (lineage TEXT NOT NULL, episodeKey TEXT NOT NULL, eventSeq INTEGER NOT NULL, descriptor INTEGER NOT NULL, sourceKey TEXT NOT NULL, source TEXT NOT NULL, createdGeneration INTEGER NOT NULL, PRIMARY KEY(lineage,episodeKey,eventSeq,descriptor,sourceKey)) WITHOUT ROWID",
  "CREATE INDEX episode_member_source ON episode_membership(lineage,sourceKey,episodeKey)",
  "CREATE VIRTUAL TABLE episode_fts USING fts5(lineage UNINDEXED,episodeKey UNINDEXED,body,tokenize='unicode61')",
  "CREATE TABLE state_items (lineage TEXT NOT NULL, stableKey TEXT NOT NULL, subject TEXT NOT NULL, revision TEXT NOT NULL, kind TEXT NOT NULL, authority TEXT NOT NULL, confidence TEXT NOT NULL, status TEXT NOT NULL, evidence TEXT NOT NULL, eventSeq INTEGER NOT NULL, descriptor INTEGER NOT NULL, createdGeneration INTEGER NOT NULL, supersededGeneration INTEGER, resolutionEvidence TEXT, PRIMARY KEY(lineage,stableKey)) WITHOUT ROWID",
  "CREATE INDEX state_page ON state_items(lineage,createdGeneration,eventSeq,descriptor,stableKey,supersededGeneration)",
  "CREATE INDEX state_transition ON state_items(lineage,subject,revision,authority,status,createdGeneration,supersededGeneration)",
  "CREATE VIRTUAL TABLE state_fts USING fts5(lineage UNINDEXED,stableKey UNINDEXED,body,tokenize='unicode61')",
  "CREATE TABLE resources (lineage TEXT NOT NULL, stableKey TEXT NOT NULL, resourceKind TEXT NOT NULL, resourceKey TEXT NOT NULL, relation TEXT NOT NULL, revision TEXT, revisionBasis TEXT NOT NULL, currentRevision TEXT NOT NULL, knownThrough INTEGER NOT NULL, failed INTEGER, evidence TEXT NOT NULL, eventSeq INTEGER NOT NULL, descriptor INTEGER NOT NULL, createdGeneration INTEGER NOT NULL, supersededGeneration INTEGER, PRIMARY KEY(lineage,stableKey)) WITHOUT ROWID",
  "CREATE INDEX resource_page ON resources(lineage,createdGeneration,eventSeq,descriptor,stableKey,supersededGeneration)",
  "CREATE INDEX resource_current ON resources(lineage,resourceKey,revision,createdGeneration,supersededGeneration)",
  "CREATE VIRTUAL TABLE resource_fts USING fts5(lineage UNINDEXED,stableKey UNINDEXED,body,tokenize='unicode61')",
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
  const length = event.rawEnd - event.rawStart;
  if (length < 1 || length > 64 * 1024) return undefined;
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
  return { ...(role ? { role } : {}), ...(toolName ? { toolName } : {}), ...(isError ? { isError } : {}), ...(exitCode ? { exitCode } : {}) };
}
function extendsView(current: EpisodeStateRequest["view"], old: EpisodeStateRequest["view"]): boolean {
  return current.branchKey === old.branchKey && current.eventCut >= old.eventCut && current.segments.length >= old.segments.length
    && old.segments.every((item, index) => current.segments[index]?.segment === item.segment && current.segments[index]!.cut >= item.cut);
}
function insertReduced(store: Store, request: EpisodeStateRequest, reduced: ReducedEpisodeEvent, generation: number): void {
  const line = lineage(request), eventSeq = reduced.source.eventSeq, descriptor = reduced.source.descriptor;
  if (reduced.startsEpisode) {
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
  } else {
    const open = store.get("SELECT e.* FROM episodes e WHERE e.lineage=? AND e.open=1 AND e.createdGeneration=(SELECT MAX(v.createdGeneration) FROM episodes v WHERE v.lineage=e.lineage AND v.episodeKey=e.episodeKey) ORDER BY e.startEventSeq DESC,e.startDescriptor DESC LIMIT 1", line);
    if (open) {
      if (num(open, "createdGeneration") === generation) store.run("UPDATE episodes SET endEventSeq=?,endDescriptor=?,memberCount=memberCount+1 WHERE lineage=? AND episodeKey=? AND createdGeneration=?",
        eventSeq, descriptor, line, str(open, "episodeKey"), generation);
      else store.run("INSERT INTO episodes VALUES(?,?,?,?,?,?,?,?,?,?,?)", line, str(open, "episodeKey"), num(open, "startEventSeq"), num(open, "startDescriptor"),
        eventSeq, descriptor, 1, num(open, "memberCount") + 1, str(open, "objective"), str(open, "objectiveEvidence"), generation);
    }
  }
  const episode = store.get("SELECT e.episodeKey FROM episodes e WHERE e.lineage=? AND e.open=1 AND e.createdGeneration=(SELECT MAX(v.createdGeneration) FROM episodes v WHERE v.lineage=e.lineage AND v.episodeKey=e.episodeKey) ORDER BY e.startEventSeq DESC,e.startDescriptor DESC LIMIT 1", line);
  if (episode) store.run("INSERT OR IGNORE INTO episode_membership VALUES(?,?,?,?,?,?,?)", line, str(episode, "episodeKey"), eventSeq, descriptor,
    sourceKey(reduced.source), canonicalJson(reduced.source), generation);
  for (const item of reduced.states) {
    if (item.explicitResolution) {
      const old = store.rows("SELECT stableKey,evidence FROM state_items WHERE lineage=? AND subject=? AND revision=? AND authority=? AND (status='unresolved' OR kind=?) AND supersededGeneration IS NULL AND createdGeneration<? ORDER BY eventSeq,descriptor,stableKey LIMIT ?",
        EPISODE_STATE_LIMITS.page, line, item.subject, item.revision, item.authority, item.kind, generation, EPISODE_STATE_LIMITS.page);
      for (const row of old) store.run("UPDATE state_items SET supersededGeneration=?,resolutionEvidence=? WHERE lineage=? AND stableKey=?", generation, canonicalJson(item.evidence), line, str(row, "stableKey"));
    }
    store.run("INSERT OR IGNORE INTO state_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", line, item.stableKey, item.subject, item.revision, item.kind,
      item.authority, item.confidence, item.status, canonicalJson(item.evidence), eventSeq, descriptor, generation, null, null);
    store.run("INSERT INTO state_fts(lineage,stableKey,body) SELECT ?,?,? WHERE changes()>0", line, item.stableKey,
      `${item.kind} ${item.subject} ${item.evidence.exactText}`);
  }
  for (const item of reduced.resources) {
    // An observation never changes current revision without exact revision identity.
    // Retain revision observations as evolution; a later mention is not supersession.
    store.run("INSERT OR IGNORE INTO resources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", line, item.stableKey, item.resourceKind, item.resourceKey, item.relation,
      item.revision, item.revisionBasis, item.currentRevision, item.knownThrough, item.failed === null ? null : item.failed ? 1 : 0,
      canonicalJson(item.evidence), eventSeq, descriptor, generation, null);
    store.run("INSERT INTO resource_fts(lineage,stableKey,body) SELECT ?,?,? WHERE changes()>0", line, item.stableKey,
      `${item.resourceKind} ${item.resourceKey} ${item.relation} ${item.revision ?? "unknown"}`);
  }
}
async function materialize(request: Extract<EpisodeStateRequest, { op: "materializeState" }>, store: Store, executor: CapsuleExecutor,
  catalogExecutor: CatalogExecutor, budget: { bytes: number }): Promise<Record<string, unknown>> {
  const line = lineage(request), head = store.get("SELECT * FROM heads WHERE lineage=?", line);
  if (head) {
    const old = JSON.parse(str(head, "view")) as EpisodeStateRequest["view"];
    if (!extendsView(request.view, old)) fail("search-v3-state-view-incompatible");
  }
  const afterEventSeq = request.after?.eventSeq ?? (head ? num(head, "afterEventSeq") : 0);
  const afterDescriptor = request.after?.descriptor ?? (head ? num(head, "afterDescriptor") : 0);
  if (request.after && head && (afterEventSeq !== num(head, "afterEventSeq") || afterDescriptor !== num(head, "afterDescriptor"))) fail("search-v3-state-cursor-invalid");
  const result = await capsuleCall(request, executor, budget, { op: "capsulePage", view: request.view, afterEventSeq, afterDescriptor,
    limit: Math.min(request.limit ?? EPISODE_STATE_LIMITS.materializeCapsules, EPISODE_STATE_LIMITS.materializeCapsules) });
  const capsules = (result.capsules ?? []) as ReducerEnvelope[], reduced: ReducedEpisodeEvent[] = [];
  for (const envelope of capsules) reduced.push(reduceEpisodeStateEnvelope(envelope, await body(request, envelope, executor, budget),
    await exactStructural(request, envelope, catalogExecutor, budget)));
  const current = num(store.get("SELECT generation FROM meta WHERE singleton=1")!, "generation"), generation = current + capsules.length;
  const nextEventSeq = Number(result.next?.afterEventSeq ?? afterEventSeq), nextDescriptor = Number(result.next?.afterDescriptor ?? afterDescriptor);
  const complete = Boolean(result.complete), partialCount = (head ? num(head, "partialCount") : 0) + reduced.filter(item => item.partial).length;
  store.transaction(() => {
    for (const [index, item] of reduced.entries()) {
      const itemGeneration = current + index + 1;
      insertReduced(store, request, item, itemGeneration);
      store.run("INSERT OR REPLACE INTO cuts VALUES(?,?,?,?)", line, item.source.eventSeq, item.source.descriptor, itemGeneration);
    }
    if (capsules.length) store.run("UPDATE meta SET generation=? WHERE singleton=1", generation);
    store.run("INSERT OR REPLACE INTO heads VALUES(?,?,?,?,?,?,?)", line, canonicalJson(request.view), nextEventSeq, nextDescriptor, generation, complete ? 1 : 0, partialCount);
  });
  // A non-final capsule page can stop between descriptors in nextEventSeq.
  // Report only the preceding event as fully materialized in that case.
  const knownThroughCut = complete ? request.view.eventCut : Math.max(0, Math.min(request.view.eventCut, nextEventSeq - 1));
  return { stateGeneration: generation, branchKey: request.view.branchKey, knownThroughCut, knownThrough: knownThroughCut, partial: !complete || partialCount > 0,
    complete, next: { eventSeq: nextEventSeq, descriptor: nextDescriptor, generation }, metrics: { capsules: capsules.length, partialRecords: reduced.filter(item => item.partial).length,
      sqliteStatements: store.statements } };
}
function pin(request: Extract<EpisodeStateRequest, { op: "recallState" }>, store: Store): number {
  const cut = store.get("SELECT generation FROM cuts WHERE lineage=? AND eventSeq<=? ORDER BY eventSeq DESC,descriptor DESC LIMIT 1", lineage(request), request.view.eventCut);
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
function recall(request: Extract<EpisodeStateRequest, { op: "recallState" }>, store: Store): Record<string, unknown> {
  const generation = pin(request, store), line = lineage(request), level = request.level ?? "state", limit = request.limit ?? EPISODE_STATE_LIMITS.page;
  const after = keyset(request.after, level === "episode" ? "m" : level === "resource" ? "r" : "s", level === "episode" ? "sourceKey" : "stableKey");
  const source = request.source ? sourceKey(request.source) : undefined;
  let rows: SqlRow[], items: Record<string, unknown>[];
  if (level === "episode") {
    const match = request.query ? ftsQuery(request.query) : undefined;
    rows = store.rows(`SELECT m.*,e.startEventSeq,e.startDescriptor,e.endEventSeq,e.endDescriptor,e.open,e.memberCount,e.objective,e.objectiveEvidence FROM episode_membership m JOIN episodes e ON e.lineage=m.lineage AND e.episodeKey=m.episodeKey AND e.createdGeneration=(SELECT MAX(v.createdGeneration) FROM episodes v WHERE v.lineage=e.lineage AND v.episodeKey=e.episodeKey AND v.createdGeneration<=?)${match ? " JOIN episode_fts ON episode_fts.lineage=e.lineage AND episode_fts.episodeKey=e.episodeKey" : ""} WHERE m.lineage=? AND m.createdGeneration<=? AND m.eventSeq<=?${match ? " AND episode_fts MATCH ?" : ""}${source ? " AND m.sourceKey=?" : ""}${after.sql} ORDER BY m.eventSeq,m.descriptor,m.sourceKey LIMIT ?`,
      limit + 1, generation, line, generation, request.view.eventCut, ...(match ? [match] : []), ...(source ? [source] : []), ...after.values, limit + 1);
    items = rows.slice(0, limit).map(row => ({ level, stableKey: str(row, "sourceKey"), episodeKey: str(row, "episodeKey"),
      episode: { start: { eventSeq: num(row, "startEventSeq"), descriptor: num(row, "startDescriptor") }, end: { eventSeq: num(row, "endEventSeq"), descriptor: num(row, "endDescriptor") },
        open: num(row, "open") === 1, memberCount: num(row, "memberCount"), objective: str(row, "objective"), objectiveEvidence: JSON.parse(str(row, "objectiveEvidence")) },
      member: { eventSeq: num(row, "eventSeq"), descriptor: num(row, "descriptor"), source: JSON.parse(str(row, "source")) } }));
  } else if (level === "resource") {
    const match = request.query ? ftsQuery(request.query) : undefined;
    rows = store.rows(`SELECT r.* FROM resources r${match ? " JOIN resource_fts ON resource_fts.lineage=r.lineage AND resource_fts.stableKey=r.stableKey" : ""} WHERE r.lineage=? AND r.createdGeneration<=? AND (r.supersededGeneration IS NULL OR r.supersededGeneration>?)${match ? " AND resource_fts MATCH ?" : ""}${source ? " AND json_extract(r.evidence,'$.source')=?" : ""}${after.sql} ORDER BY r.eventSeq,r.descriptor,r.stableKey LIMIT ?`,
      limit + 1, line, generation, generation, ...(match ? [match] : []), ...(source ? [canonicalJson(request.source)] : []), ...after.values, limit + 1);
    items = rows.slice(0, limit).map(row => ({ level, stableKey: str(row, "stableKey"), resourceKind: str(row, "resourceKind"), resourceKey: str(row, "resourceKey"),
      relation: str(row, "relation"), validationFreshness: "unknown; observation is not full-resource validation", revision: row.revision, revisionBasis: str(row, "revisionBasis"), currentRevision: str(row, "currentRevision"), knownThrough: num(row, "knownThrough"),
      failed: row.failed === null ? null : num(row, "failed") === 1, evidence: JSON.parse(str(row, "evidence")) }));
  } else {
    const match = request.query ? ftsQuery(request.query) : undefined;
    rows = store.rows(`SELECT s.* FROM state_items s${match ? " JOIN state_fts ON state_fts.lineage=s.lineage AND state_fts.stableKey=s.stableKey" : ""} WHERE s.lineage=? AND s.createdGeneration<=? AND (s.supersededGeneration IS NULL OR s.supersededGeneration>?)${match ? " AND state_fts MATCH ?" : ""}${source ? " AND json_extract(s.evidence,'$.source')=?" : ""}${after.sql} ORDER BY s.eventSeq,s.descriptor,s.stableKey LIMIT ?`,
      limit + 1, line, generation, generation, ...(match ? [match] : []), ...(source ? [canonicalJson(request.source)] : []), ...after.values, limit + 1);
    items = rows.slice(0, limit).map(row => ({ level, stableKey: str(row, "stableKey"), subject: str(row, "subject"), revision: str(row, "revision"), kind: str(row, "kind"),
      authority: str(row, "authority"), confidence: str(row, "confidence"), status: str(row, "status"), evidence: JSON.parse(str(row, "evidence")),
      ...(row.resolutionEvidence === null ? {} : { resolutionEvidence: JSON.parse(str(row, "resolutionEvidence")) }) }));
  }
  while (items.length > 1 && Buffer.byteLength(JSON.stringify(items)) > EPISODE_STATE_LIMITS.recallUtf8Bytes) items.pop();
  const selected = rows.slice(0, items.length), last = selected.at(-1), eventColumn = "eventSeq", descriptorColumn = "descriptor",
    keyColumn = level === "episode" ? "sourceKey" : "stableKey";
  const head = store.get("SELECT * FROM heads WHERE lineage=?", line), knownThrough = head ? Math.min(request.view.eventCut, num(head, "afterEventSeq")) : 0;
  return { stateGeneration: generation, branchKey: request.view.branchKey, knownThrough, partial: !head || num(head, "complete") !== 1 || knownThrough < request.view.eventCut || num(head, "partialCount") > 0,
    level, items, ...(rows.length > items.length && last ? { next: { eventSeq: num(last, eventColumn), descriptor: num(last, descriptorColumn), stableKey: str(last, keyColumn), generation } } : {}),
    metrics: { sqliteStatements: store.statements } };
}
function status(request: Extract<EpisodeStateRequest, { op: "stateStatus" }>, store: Store): Record<string, unknown> {
  const generation = num(store.get("SELECT generation FROM meta WHERE singleton=1")!, "generation"), head = store.get("SELECT * FROM heads WHERE lineage=?", lineage(request));
  if (!head) return { identity: request.identity, ruleset: EPISODE_STATE_RULESET_VERSION, stateGeneration: generation, knownThroughCut: 0, knownThrough: 0, partial: true,
    readiness: "missing", requestedView: { branchKey: request.view.branchKey, eventCut: request.view.eventCut, hash: viewHash(request) }, metrics: { sqliteStatements: store.statements } };
  let indexed: EpisodeStateRequest["view"]; try { indexed = JSON.parse(str(head, "view")); } catch { return fail("search-v3-state-checkpoint-corrupt"); }
  const compatible = extendsView(request.view, indexed) || extendsView(indexed, request.view), knownThrough = compatible ? Math.min(request.view.eventCut, num(head, "afterEventSeq")) : 0;
  const complete = compatible && num(head, "complete") === 1 && indexed.eventCut >= request.view.eventCut;
  const knownThroughCut = complete ? request.view.eventCut : Math.max(0, knownThrough - 1);
  const partial = !complete || knownThroughCut < request.view.eventCut || num(head, "partialCount") > 0;
  return { identity: request.identity, ruleset: EPISODE_STATE_RULESET_VERSION, stateGeneration: generation, knownThroughCut, knownThrough: knownThroughCut, complete, partial,
    readiness: compatible ? partial ? "partial" : "ready" : "incompatible", requestedView: { branchKey: request.view.branchKey, eventCut: request.view.eventCut, hash: viewHash(request) },
    indexedView: { branchKey: indexed.branchKey, eventCut: indexed.eventCut, complete: num(head, "complete") === 1 },
    cursor: { eventSeq: num(head, "afterEventSeq"), descriptor: num(head, "afterDescriptor"), generation: num(head, "generation") }, metrics: { sqliteStatements: store.statements } };
}

/** Direct executor for tests and the existing contained search-v3 worker. */
export async function executeEpisodeStateRequest(value: unknown, options: EpisodeStateExecutionOptions = {}): Promise<EpisodeStateResponse> {
  if (!isEpisodeStateRequest(value)) return { v: 1, ok: false, code: "search-v3-state-request-invalid", sourceBytes: 0,
    sqliteNativeLimitBytes: EPISODE_STATE_LIMITS.nativeSqliteBytes, resumable: false };
  const request = value, create = request.op === "materializeState"; let db: CatalogSqlite | undefined; const budget = { bytes: 0 };
  try {
    prepareDirectory(request.searchDirectory);
    // Authorize this exact view and current physical source even for read-only memory.
    await catalogCall(request, options.catalogExecutor ?? executeCatalogStoreRequest, budget, { op: "page", view: request.view, after: request.view.eventCut, limit: 1 });
    const action = async (): Promise<EpisodeStateResponse> => {
      const path = join(request.searchDirectory, "state-v1.sqlite"), validate = (candidate: CatalogSqlite): void => new Store(candidate, request).validate(create);
      db = create ? CatalogSqlite.create(path, validate) : CatalogSqlite.open(path, validate);
      const store = new Store(db, request); if (create) store.initialize(); else store.validate(false);
      const result = request.op === "materializeState" ? await materialize(request, store, options.capsuleExecutor ?? executeCapsuleRequest,
        options.catalogExecutor ?? executeCatalogStoreRequest, budget)
        : request.op === "recallState" ? recall(request, store) : status(request, store);
      const response: EpisodeStateResponse = { v: 1, ok: true, result, sourceBytes: budget.bytes, sqliteNativeLimitBytes: EPISODE_STATE_LIMITS.nativeSqliteBytes };
      if (Buffer.byteLength(JSON.stringify(response)) > EPISODE_STATE_LIMITS.responseBytes) fail("search-v3-state-response-limit");
      try { db.checkpoint(); } catch { /* committed WAL remains authoritative */ }
      return response;
    };
    return create ? await withRuntimeMutex(join(request.searchDirectory, "state-publication.lock"), action) : await action();
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
