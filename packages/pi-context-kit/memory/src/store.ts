import { DatabaseSync } from "node:sqlite";
import { constants, closeSync, fsyncSync, lstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { at, canonical, decodeRecord, fail, integer, LIMITS, plain, safeError, sha, text, type MemoryRecord } from "./contracts.ts";
import { privateDirectory, privateFile, processIdentity, syncDirectory, verifyAnchor, type Anchor, type SourceTicket } from "./files.ts";

type Row = Record<string, any>;
export interface Meta { namespaceId: string; storeId: string; revision: number; dataset: string; pending: string | null; lastRecordedAt: string; recordedSequence: number }
export interface Change { records?: MemoryRecord[]; importDataset?: string; importReceipt?: Record<string, unknown> }
export interface CommitReceipt { operationId: string; storeId: string; storeRevision: number; anchor: { entryId: string; digest: string }; records: { memoryId: string; revision: number; revisionHash: string }[]; importReceipt?: Record<string, unknown> }
export interface PageInput { kind?: "knowledge" | "proposal"; query?: string; scope?: string; state?: string; includeDemoted?: boolean; limit?: number; scan?: number; cursor?: string }
export interface MemoryPage { records: MemoryRecord[]; storeRevision: number; coverage: { scanned: number; matched: number; excluded: number; scanComplete: boolean }; nextCursor?: string }
export interface ExportSnapshot {
  meta: Meta;
  records: MemoryRecord[];
  imported?: { id: string; identity: string; digest: string; bytes: Buffer; receipt: Record<string, unknown> };
}
const SCHEMA = [
  "CREATE TABLE meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),namespaceId TEXT NOT NULL,storeId TEXT NOT NULL,revision INTEGER NOT NULL,dataset TEXT NOT NULL,pending TEXT,lastRecordedAt TEXT NOT NULL,recordedSequence INTEGER NOT NULL)",
  "CREATE TABLE revisions(dataset TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,recordedAt TEXT NOT NULL,sequence INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(dataset,id,revision)) WITHOUT ROWID",
  "CREATE INDEX revisions_time ON revisions(dataset,id,recordedAt DESC,sequence DESC)",
  "CREATE TABLE heads(dataset TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(dataset,id)) WITHOUT ROWID",
  "CREATE INDEX heads_page ON heads(dataset,kind,id)",
  "CREATE TABLE operations(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL,anchor TEXT NOT NULL,ticket TEXT NOT NULL,pid INTEGER NOT NULL,start TEXT,receipt TEXT) WITHOUT ROWID",
  "CREATE TABLE imports(id TEXT PRIMARY KEY,identity TEXT NOT NULL,digest TEXT NOT NULL,bytes BLOB NOT NULL,receipt TEXT NOT NULL,state TEXT NOT NULL,progress INTEGER NOT NULL) WITHOUT ROWID",
];
export function namespaceDirectory(root: string, namespaceId: string): string {
  if (!/^[a-f0-9]{32}$/.test(namespaceId)) fail("namespace-invalid");
  return join(root, "stores", namespaceId);
}
export class MemoryStore {
  private readonly db: DatabaseSync;
  readonly path: string;
  readonly namespaceId: string;
  private ownedPending?: string;
  private closed = false;
  private identity!: { dev: number; ino: number };
  constructor(root: string, namespaceId: string, create = false) {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major !== 24 || minor! < 18) fail("node-version-unsupported");
    this.namespaceId = namespaceId;
    const directory = namespaceDirectory(root, namespaceId);
    privateDirectory(root, create); privateDirectory(join(root, "stores"), create); privateDirectory(directory, create);
    this.path = join(directory, "memory.sqlite");
    const exists = privateFile(this.path, true);
    if (!exists && !create) fail("store-missing");
    if (exists && create) fail("store-exists");
    if (!exists) closeSync(openSync(this.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
    for (const suffix of ["-journal", "-wal", "-shm"]) privateFile(this.path + suffix, true);
    this.identity = lstatSync(this.path);
    let database: DatabaseSync | undefined;
    try {
      const options = { timeout: 50, defensive: true, allowExtension: false };
      if (exists) {
        const reader = new DatabaseSync(this.path, { ...options, readOnly: true });
        try { this.validate(reader); } finally { reader.close(); }
      }
      database = new DatabaseSync(this.path, options);
      database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=50; PRAGMA cache_size=-2048; PRAGMA mmap_size=0; PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA max_page_count=65536;");
      this.db = database;
      if (!exists) this.transaction(() => {
        for (const statement of SCHEMA) this.db.exec(statement);
        this.db.prepare("INSERT INTO meta VALUES(1,?,?,0,'native',NULL,?,0)").run(namespaceId, randomUUID(), "1970-01-01T00:00:00.000Z");
        this.db.exec("PRAGMA user_version=1");
      });
      this.validate(database);
      if (!exists) {
        const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { fsyncSync(fd); } finally { closeSync(fd); }
        syncDirectory(directory);
      }
    } catch (error) { database?.close(); throw safeError(error); }
  }
  private validate(db: DatabaseSync): void {
    if (db.prepare("PRAGMA user_version").get()?.user_version !== 1) fail("store-schema");
    for (const statement of SCHEMA) {
      const name = statement.match(/^CREATE (?:TABLE|INDEX) ([^( ]+)/)![1]!;
      if (db.prepare("SELECT sql FROM sqlite_master WHERE name=? LIMIT 1").get(name)?.sql !== statement) fail("store-schema");
    }
    if (db.prepare("SELECT namespaceId FROM meta WHERE singleton=1").get()?.namespaceId !== this.namespaceId) fail("store-identity");
  }
  private guard(): void {
    if (this.closed) fail("store-closed");
    privateFile(this.path);
    const current = lstatSync(this.path);
    if (current.dev !== this.identity.dev || current.ino !== this.identity.ino) fail("store-replaced");
    for (const suffix of ["-journal", "-wal", "-shm"]) privateFile(this.path + suffix, true);
  }
  private transaction<T>(fn: () => T): T {
    this.guard(); this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch { /* Retain the first failure. */ } throw safeError(error); }
  }
  meta(): Meta {
    this.guard();
    const row = this.db.prepare("SELECT namespaceId,storeId,revision,dataset,pending,lastRecordedAt,recordedSequence FROM meta WHERE singleton=1").get() as Row;
    if (!row || row.namespaceId !== this.namespaceId) fail("store-corrupt");
    integer(row.revision, 0); at(row.lastRecordedAt);
    return { namespaceId: row.namespaceId, storeId: row.storeId, revision: row.revision, dataset: row.dataset, pending: row.pending, lastRecordedAt: row.lastRecordedAt, recordedSequence: integer(row.recordedSequence, 0) };
  }
  /** Only a dead/released owner can be recovered. No timeout steals a live writer. */
  ready(): Meta {
    const meta = this.meta();
    if (meta.pending) fail("pending");
    return meta;
  }
  recover(): Meta {
    const meta = this.meta();
    if (!meta.pending) return meta;
    const op = this.db.prepare("SELECT * FROM operations WHERE id=?").get(meta.pending) as Row | undefined;
    if (!op || op.state !== "prepared") fail("store-corrupt");
    if (op.pid && processIdentity(Number(op.pid)) === op.start) fail("pending");
    const found = verifyAnchor(JSON.parse(op.ticket), JSON.parse(op.anchor));
    if (found) this.commit(op.id, found);
    else this.transaction(() => {
      this.db.prepare("UPDATE operations SET state='unbound' WHERE id=? AND state='prepared'").run(op.id);
      this.db.prepare("UPDATE meta SET pending=NULL WHERE singleton=1 AND pending=?").run(op.id);
    });
    return this.meta();
  }
  get(memoryId: string, options: { revision?: number; recordedBefore?: string } = {}): MemoryRecord | undefined {
    text(memoryId); const meta = this.ready();
    if (options.revision !== undefined && options.recordedBefore !== undefined) fail("read-selector-invalid");
    let row;
    if (options.revision !== undefined) row = this.db.prepare("SELECT body FROM revisions WHERE dataset=? AND id=? AND revision=?").get(meta.dataset, memoryId, integer(options.revision));
    else if (options.recordedBefore !== undefined) row = this.db.prepare("SELECT body FROM revisions WHERE dataset=? AND id=? AND recordedAt<=? ORDER BY recordedAt DESC,sequence DESC LIMIT 1").get(meta.dataset, memoryId, at(options.recordedBefore));
    else row = this.db.prepare("SELECT body FROM heads WHERE dataset=? AND id=?").get(meta.dataset, memoryId);
    if (this.meta().revision !== meta.revision) fail("revision-conflict");
    return row ? decodeRecord(row.body) : undefined;
  }
  page(raw: PageInput = {}): MemoryPage {
    const input = objectPage(plain(raw)), meta = this.ready(), kind = input.kind ?? "knowledge";
    const limit = integer(input.limit ?? 20, 1, LIMITS.results), scan = integer(input.scan ?? 128, 1, LIMITS.scan);
    const query = text(input.query ?? "", LIMITS.query, true).toLowerCase();
    const terms = [...new Set(query.match(/[\p{L}\p{N}_./-]+/gu) ?? [])];
    if (terms.length > 16) fail("query-terms-limit");
    const filter = sha(canonical({ kind, query, scope: input.scope ?? null, state: input.state ?? null, includeDemoted: input.includeDemoted ?? false }));
    let after = "";
    if (input.cursor !== undefined) {
      let cursor: any;
      try { cursor = JSON.parse(Buffer.from(text(input.cursor, 2048), "base64url").toString("utf8")); } catch { fail("cursor-invalid"); }
      if (cursor.namespaceId !== this.namespaceId || cursor.revision !== meta.revision || cursor.filter !== filter) fail("cursor-stale");
      after = text(cursor.after, 128, true);
    }
    const rows = this.db.prepare("SELECT id,body FROM heads WHERE dataset=? AND kind=? AND id>? ORDER BY id LIMIT ?").all(meta.dataset, kind, after, scan + 1) as Row[];
    const admitted = rows.slice(0, scan), selected: { record: MemoryRecord; score: number }[] = [];
    let matched = 0;
    for (const row of admitted) {
      const record = decodeRecord(row.body);
      if (input.scope !== undefined && record.scope !== input.scope || input.state !== undefined && record.state !== input.state
        || kind === "knowledge" && input.state === undefined && !input.includeDemoted && record.state !== "current") continue;
      const body = `${record.text}\n${record.scope}\n${record.sourceRef}`.toLowerCase();
      const score = terms.reduce((count, term) => count + (body.includes(term) ? 1 : 0), 0);
      if (terms.length && !score) continue;
      matched++; selected.push({ record, score });
    }
    const boosted = (record: MemoryRecord) => Number(record.state === "current" && (record.promotedUntilSequence ?? -1) >= meta.recordedSequence);
    selected.sort((a, b) => b.score - a.score || boosted(b.record) - boosted(a.record) || a.record.memoryId.localeCompare(b.record.memoryId));
    const records = selected.slice(0, limit).map(item => item.record), complete = rows.length <= scan;
    if (this.meta().revision !== meta.revision) fail("revision-conflict");
    return { records, storeRevision: meta.revision,
      coverage: { scanned: admitted.length, matched, excluded: matched - records.length, scanComplete: complete },
      ...(!complete ? { nextCursor: Buffer.from(JSON.stringify({ namespaceId: this.namespaceId, revision: meta.revision, filter, after: admitted.at(-1)!.id })).toString("base64url") } : {}) };
  }
  execute(operationId: string, fingerprint: string, ticket: SourceTicket, build: (meta: Meta) => Change, bind: (anchor: Anchor) => void): CommitReceipt {
    text(operationId); text(fingerprint);
    const current = this.recover();
    const existing = this.db.prepare("SELECT fingerprint,state,receipt FROM operations WHERE id=?").get(operationId) as Row | undefined;
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail("operation-conflict");
      if (existing.state === "committed") return JSON.parse(existing.receipt);
      fail("operation-unbound");
    }
    let anchor!: Anchor;
    this.transaction(() => {
      const meta = this.meta();
      if (meta.pending || meta.revision !== current.revision) fail("revision-conflict");
      const change = build(meta), payload = canonical(change);
      if (Buffer.byteLength(payload) > LIMITS.record * 3 || (change.records?.length ?? 0) > 3) fail("transaction-limit");
      anchor = { version: 1, namespaceId: this.namespaceId, storeId: meta.storeId, operationId, storeRevision: meta.revision + 1, payloadHash: sha(payload) };
      this.db.prepare("INSERT INTO operations VALUES(?,?,'prepared',?,?,?,?,?,NULL)").run(operationId, fingerprint, payload, canonical(anchor), canonical(ticket), process.pid, processIdentity() ?? fail("owner-unverifiable"));
      this.db.prepare("UPDATE meta SET pending=? WHERE singleton=1").run(operationId);
    });
    this.ownedPending = operationId;
    try {
      bind(anchor);
      const proof = verifyAnchor(ticket, anchor);
      if (!proof) fail("anchor-unpersisted");
      return this.commit(operationId, proof);
    } finally {
      // A failed anchor remains prepared, but the current call no longer owns it.
      if (this.meta().pending === operationId) this.transaction(() => this.db.prepare("UPDATE operations SET pid=0,start=NULL WHERE id=?").run(operationId));
      this.ownedPending = undefined;
    }
  }
  private insertRecord(dataset: string, record: MemoryRecord): void {
    const body = canonical(record); decodeRecord(body);
    this.db.prepare("INSERT INTO revisions VALUES(?,?,?,?,?,?)").run(dataset, record.memoryId, record.revision, record.recordedAt, record.recordedSequence, body);
    this.db.prepare("INSERT INTO heads VALUES(?,?,?,?,?) ON CONFLICT(dataset,id) DO UPDATE SET revision=excluded.revision,body=excluded.body").run(dataset, record.kind, record.memoryId, record.revision, body);
  }
  private commit(operationId: string, proof: { entryId: string; digest: string }): CommitReceipt {
    return this.transaction(() => {
      const meta = this.meta(), op = this.db.prepare("SELECT * FROM operations WHERE id=?").get(operationId) as Row;
      if (meta.pending !== operationId || !op || op.state !== "prepared") fail("revision-conflict");
      const anchor = JSON.parse(op.anchor) as Anchor;
      if (sha(op.payload) !== anchor.payloadHash || anchor.storeRevision !== meta.revision + 1) fail("store-corrupt");
      const change = JSON.parse(op.payload) as Change;
      for (const record of change.records ?? []) this.insertRecord(meta.dataset, record);
      let dataset = meta.dataset;
      if (change.importDataset) {
        const staged = this.db.prepare("SELECT state FROM imports WHERE id=?").get(change.importDataset);
        if (staged?.state !== "staged" || this.db.prepare("SELECT id FROM heads WHERE dataset=? LIMIT 1").get(meta.dataset)) fail("import-conflict");
        dataset = change.importDataset;
        this.db.prepare("UPDATE imports SET state='committed',receipt=? WHERE id=?").run(JSON.stringify({ ...change.importReceipt, storeId: meta.storeId, storeRevision: anchor.storeRevision }), dataset);
      }
      const receipt: CommitReceipt = { operationId, storeId: meta.storeId, storeRevision: anchor.storeRevision, anchor: proof,
        records: (change.records ?? []).map(record => ({ memoryId: record.memoryId, revision: record.revision, revisionHash: record.revisionHash })),
        ...(change.importReceipt ? { importReceipt: change.importReceipt } : {}) };
      const importedAt = change.importReceipt?.lastRecordedAt;
      const startAt = typeof importedAt === "string" && importedAt > meta.lastRecordedAt ? at(importedAt) : meta.lastRecordedAt;
      const lastAt = (change.records ?? []).reduce((latest, record) => record.recordedAt > latest ? record.recordedAt : latest, startAt);
      const lastSequence = Math.max(meta.recordedSequence, Number(change.importReceipt?.recordedSequence ?? 0), ...(change.records ?? []).map(record => record.recordedSequence));
      this.db.prepare("UPDATE meta SET revision=?,dataset=?,pending=NULL,lastRecordedAt=?,recordedSequence=? WHERE singleton=1").run(anchor.storeRevision, dataset, lastAt, lastSequence);
      this.db.prepare("UPDATE operations SET state='committed',pid=0,start=NULL,receipt=? WHERE id=?").run(JSON.stringify(receipt), operationId);
      return receipt;
    });
  }
  async stageImport(input: { id: string; identity: string; digest: string; bytes: Buffer; receipt: Record<string, unknown>; records: MemoryRecord[] }): Promise<Record<string, unknown>> {
    const meta = this.ready();
    if (input.bytes.length > LIMITS.importBytes || input.records.length > LIMITS.importEvents * 2 || sha(input.bytes) !== input.digest) fail("import-limit");
    const existing = this.db.prepare("SELECT digest,state,progress,receipt FROM imports WHERE id=?").get(input.id);
    if (existing) {
      if (existing.digest !== input.digest) fail("import-conflict");
      if (existing.state === "staged" || existing.state === "committed") return JSON.parse(String(existing.receipt));
      if (existing.state !== "preparing") fail("import-incomplete");
    }
    if (this.db.prepare("SELECT id FROM heads WHERE dataset=? LIMIT 1").get(meta.dataset)) fail("import-requires-empty-store");
    if (!existing) this.transaction(() => this.db.prepare("INSERT INTO imports VALUES(?,?,?,?,?,'preparing',0)").run(input.id, input.identity, input.digest, input.bytes, JSON.stringify(input.receipt)));
    for (let offset = Number(existing?.progress ?? 0); offset < input.records.length; offset += 64) {
      this.transaction(() => {
        const progress = this.db.prepare("SELECT progress FROM imports WHERE id=?").get(input.id)?.progress;
        if (progress !== offset) fail("import-conflict");
        for (const record of input.records.slice(offset, offset + 64)) this.insertRecord(input.id, record);
        this.db.prepare("UPDATE imports SET progress=? WHERE id=?").run(Math.min(input.records.length, offset + 64), input.id);
      });
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    this.transaction(() => this.db.prepare("UPDATE imports SET state='staged' WHERE id=?").run(input.id));
    return existing ? JSON.parse(String(existing.receipt)) : input.receipt;
  }
  imported(id: string): Record<string, unknown> | undefined {
    this.ready(); const row = this.db.prepare("SELECT receipt FROM imports WHERE id=? AND state='committed'").get(id);
    return row ? JSON.parse(String(row.receipt)) : undefined;
  }
  importBytes(id: string, offset = 0, length = 32768): { bytes: Buffer; nextOffset?: number; digest: string } {
    integer(offset, 0, LIMITS.importBytes); integer(length, 1, 32768); this.ready();
    const row = this.db.prepare("SELECT substr(bytes,?,?) AS chunk,length(bytes) AS size,digest FROM imports WHERE id=? AND state='committed'").get(offset + 1, length, text(id, 128)) as Row | undefined;
    if (!row) fail("import-missing");
    if (offset > row.size) fail("offset-invalid");
    const bytes = Buffer.from(row.chunk);
    return { bytes, digest: row.digest, ...(offset + bytes.length < row.size ? { nextOffset: offset + bytes.length } : {}) };
  }
  /** Operator export only. The synchronous callback holds a reserved transaction through publication. */
  withExportSnapshot<T>(expectedStoreId: string, expectedStoreRevision: number, publish: (snapshot: ExportSnapshot) => T, signal?: AbortSignal): T {
    text(expectedStoreId); integer(expectedStoreRevision, 0);
    const check = () => { if (signal?.aborted) fail("cancelled"); };
    check(); this.ready();
    return this.transaction(() => {
      const meta = this.ready();
      if (meta.storeId !== expectedStoreId || meta.revision !== expectedStoreRevision) fail("export-cut-conflict");
      const records: MemoryRecord[] = [];
      let id = "", revision = 0, admittedBytes = 0;
      while (true) {
        check();
        const page = this.db.prepare("SELECT id,revision,length(CAST(body AS BLOB)) AS bytes FROM revisions WHERE dataset=? AND (id,revision)>(?,?) ORDER BY id,revision LIMIT 64").all(meta.dataset, id, revision) as Row[];
        if (!page.length) break;
        for (const row of page) {
          if (records.length >= 4096) fail("export-row-limit");
          if (!Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > LIMITS.record) fail("store-corrupt");
          admittedBytes += row.bytes;
          if (admittedBytes > LIMITS.importBytes) fail("export-companion-limit");
          const body = this.db.prepare("SELECT body FROM revisions WHERE dataset=? AND id=? AND revision=?").get(meta.dataset, row.id, row.revision)?.body;
          const record = decodeRecord(body);
          if (record.memoryId !== row.id || record.revision !== row.revision) fail("store-corrupt");
          const prior = records.at(-1);
          if (prior?.memoryId === record.memoryId ? record.revision !== prior.revision + 1 || record.previousHash !== prior.revisionHash || record.recordedSequence < prior.recordedSequence
            : record.revision !== 1 || record.previousHash !== null) fail("export-revision-chain");
          records.push(record); id = row.id; revision = row.revision;
        }
      }
      let headCount = 0;
      for (let index = 0; index < records.length; index++) {
        const record = records[index]!;
        if (records[index + 1]?.memoryId === record.memoryId) continue;
        const head = this.get(record.memoryId);
        if (!head || head.revisionHash !== record.revisionHash) fail("export-head-mismatch");
        headCount++;
      }
      // A bounded lookahead detects heads that have no admitted revision chain.
      const heads = this.db.prepare("SELECT id FROM heads WHERE dataset=? ORDER BY id LIMIT 4097").all(meta.dataset);
      if (heads.length !== headCount) fail("export-head-mismatch");
      const imports = this.db.prepare("SELECT id,identity,digest,length(bytes) AS size,length(CAST(receipt AS BLOB)) AS receiptBytes FROM imports WHERE state='committed' LIMIT 2").all() as Row[];
      let imported: ExportSnapshot["imported"];
      if (imports.length) {
        const row = imports[0]!;
        if (imports.length !== 1 || row.id !== meta.dataset || row.size > LIMITS.importBytes || row.receiptBytes > 8192) fail("export-import-unsupported");
        const chunks: Buffer[] = [];
        let offset = 0;
        do {
          check(); const page = this.importBytes(row.id, offset); chunks.push(page.bytes);
          if (page.nextOffset === undefined) break;
          offset = page.nextOffset;
        } while (true);
        const bytes = Buffer.concat(chunks);
        if (bytes.length !== row.size || sha(bytes) !== row.digest) fail("export-import-integrity");
        imported = { id: row.id, identity: row.identity, digest: row.digest, bytes, receipt: this.imported(row.id)! };
      } else if (meta.dataset !== "native") fail("export-import-missing");
      check(); const result = publish({ meta, records, ...(imported ? { imported } : {}) });
      if (result && typeof (result as any).then === "function") fail("export-callback-must-be-synchronous");
      check(); return result;
    });
  }
  close(): void {
    if (this.closed) return;
    if (this.ownedPending) this.transaction(() => this.db.prepare("UPDATE operations SET pid=0,start=NULL WHERE id=?").run(this.ownedPending!));
    this.db.close(); this.closed = true;
  }
}
function objectPage(input: any): PageInput {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["kind", "query", "scope", "state", "includeDemoted", "limit", "scan", "cursor"].includes(key))) fail("page-invalid");
  if (input.kind !== undefined && !["knowledge", "proposal"].includes(input.kind)) fail("page-invalid");
  if (input.scope !== undefined) text(input.scope, 256);
  if (input.state !== undefined) text(input.state, 32);
  if (input.includeDemoted !== undefined && typeof input.includeDemoted !== "boolean") fail("page-invalid");
  return input;
}
