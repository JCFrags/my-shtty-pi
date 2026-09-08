import { constants, closeSync, lstatSync, openSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { createRequire } from "node:module";

/** Worker-only synchronous native I/O. M03's JS source-read ledger does NOT cover it.
 * Native allocations are outside V8; the M03 controller is the final memory/deadline boundary.
 * SQL is trusted implementation code, never source content. Bind source values as parameters.
 */
export const CATALOG_SQLITE_LIMITS = Object.freeze({ busyMs: 50, cacheKiB: 2048,
  heapBytes: 64 * 1024 * 1024, sqlBytes: 64 * 1024, valueBytes: 2 * 1024 * 1024, rows: 1024 });
export type SqlValue = string | number | bigint | Buffer | null;
export type SqlRow = Record<string, SqlValue>;
type NativeStatement = { get(...values: SqlValue[]): SqlRow | undefined;
  run(...values: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
  iterate(...values: SqlValue[]): IterableIterator<SqlRow> };
type NativeDatabase = { prepare(sql: string): NativeStatement; pragma(sql: string, options?: { simple: boolean }): unknown;
  transaction<T>(fn: () => T): (() => T); close(): void };
type NativeConstructor = new (path: string, options: { timeout: number; fileMustExist: boolean; readonly?: boolean }) => NativeDatabase;
const require = createRequire(import.meta.url);
export class CatalogSqliteError extends Error {
  constructor(readonly code: "catalog-storage-unsafe" | "catalog-sqlite-unavailable" | "catalog-sqlite-busy" |
    "catalog-sqlite-corrupt" | "catalog-sqlite-capability" | "catalog-sqlite-limit" | "catalog-sqlite-failed") {
    super(code); this.name = "CatalogSqliteError";
  }
}
function sanitized(error: unknown): CatalogSqliteError {
  if (error instanceof CatalogSqliteError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  return new CatalogSqliteError(code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" ? "catalog-sqlite-busy" :
    code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB" ? "catalog-sqlite-corrupt" :
    code === "SQLITE_NOMEM" || code === "SQLITE_TOOBIG" || code === "SQLITE_FULL" ? "catalog-sqlite-limit" : "catalog-sqlite-failed");
}
/** Refuse observed links/unsafe permissions; public SQLite API has no fd/O_NOFOLLOW open.
 * This does not eliminate same-UID path replacement races. Require private worker storage.
 */
function validateStorage(path: string, requireDatabase = false): void {
  try {
    if (!isAbsolute(path) || resolve(path) !== path || typeof process.getuid !== "function") throw 0;
    let part = parse(path).root;
    for (const component of dirname(path).slice(part.length).split("/").filter(Boolean)) {
      part = join(part, component);
      const st = lstatSync(part);
      if (!st.isDirectory() || st.isSymbolicLink() || (st.uid !== 0 && st.uid !== process.getuid()) ||
        ((st.mode & 0o022) !== 0 && !(st.uid === 0 && (st.mode & 0o1000) !== 0))) throw 0;
    }
    const parent = lstatSync(dirname(path));
    if (parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700) throw 0;
    for (const name of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
      let st;
      try { st = lstatSync(name); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT" && !(requireDatabase && name === path)) continue;
        throw e;
      }
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o600) throw 0;
    }
  } catch { throw new CatalogSqliteError("catalog-storage-unsafe"); }
}
function bounded(values: SqlValue[]): void {
  let bytes = 0;
  for (const value of values) bytes += typeof value === "string" ? Buffer.byteLength(value) : Buffer.isBuffer(value) ? value.length : 8;
  if (bytes > CATALOG_SQLITE_LIMITS.valueBytes) throw new CatalogSqliteError("catalog-sqlite-limit");
}
export interface CatalogStatement {
  get(...values: SqlValue[]): SqlRow | undefined;
  run(...values: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
  /** Always consume within one synchronous worker turn; early exit closes the reader. */
  iterate(maxRows: number, ...values: SqlValue[]): IterableIterator<SqlRow>;
}
export interface CatalogCapabilities { sqliteVersion: string; journalMode: "wal"; synchronous: 2;
  busyTimeout: 50; cacheSize: -2048; mmapSize: 0; hardHeapLimit: number; tempStore: 2; fts5: true }
export class CatalogSqlite {
  private constructor(private readonly path: string, private readonly db: NativeDatabase) {}
  /** Existing lookup never reserves a replacement DB or initializes a blank file.
   * Validation uses a read-only connection before WAL setup or writable close. */
  static open(path: string, validate?: (db: CatalogSqlite) => void): CatalogSqlite {
    return this.connect(path, false, validate);
  }
  /** Explicit fresh bootstrap / valid-store resume boundary. Blank files and
   * orphan sidecars never authorize creation; use a fresh physical location. */
  static create(path: string, validate?: (db: CatalogSqlite) => void): CatalogSqlite {
    return this.connect(path, true, validate);
  }
  private static connect(path: string, create: boolean, validate?: (db: CatalogSqlite) => void): CatalogSqlite {
    validateStorage(path, !create);
    let size = 0, exists = true;
    try { size = lstatSync(path).size; }
    catch (e) { if (!create || (e as NodeJS.ErrnoException).code !== "ENOENT") throw new CatalogSqliteError("catalog-storage-unsafe"); exists = false; }
    if (!size) {
      if (!create || exists) throw new CatalogSqliteError("catalog-sqlite-corrupt");
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        try { lstatSync(`${path}${suffix}`); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw new CatalogSqliteError("catalog-storage-unsafe"); }
        throw new CatalogSqliteError("catalog-storage-unsafe");
      }
      try { const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); closeSync(fd); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new CatalogSqliteError("catalog-storage-unsafe"); }
    }
    validateStorage(path, true);
    let Constructor: NativeConstructor;
    try { Constructor = require("better-sqlite3") as NativeConstructor; }
    catch { throw new CatalogSqliteError("catalog-sqlite-unavailable"); }
    // Read-only open still supports SQLite's legitimate committed WAL recovery.
    // Same-UID pathname replacement races are outside this observed-path boundary.
    if (validate && lstatSync(path).size > 0) {
      let reader: NativeDatabase | undefined;
      try {
        reader = new Constructor(path, { timeout: CATALOG_SQLITE_LIMITS.busyMs, fileMustExist: true, readonly: true });
        reader.pragma("hard_heap_limit=67108864"); reader.pragma("cache_size=-2048");
        reader.pragma("mmap_size=0"); reader.pragma("temp_store=MEMORY"); reader.pragma("trusted_schema=OFF");
        validate(new CatalogSqlite(path, reader));
      } catch (e) {
        if (/^catalog-[a-z0-9-]+$/.test(String((e as { code?: unknown })?.code))) throw e;
        throw sanitized(e);
      } finally { try { reader?.close(); } catch { /* preserve validation refusal */ } }
    }
    let db: NativeDatabase | undefined;
    try {
      db = new Constructor(path, { timeout: CATALOG_SQLITE_LIMITS.busyMs, fileMustExist: true });
      db.pragma("hard_heap_limit=67108864"); // Process-global, may only lower an existing limit.
      db.pragma("cache_size=-2048"); db.pragma("mmap_size=0"); db.pragma("temp_store=MEMORY");
      db.pragma("busy_timeout=50"); db.pragma("journal_mode=WAL"); db.pragma("synchronous=FULL");
      db.pragma("wal_autocheckpoint=256"); db.pragma("journal_size_limit=1048576");
      db.pragma("trusted_schema=OFF"); db.pragma("foreign_keys=ON");
      const result = new CatalogSqlite(path, db);
      result.capabilities(); validateStorage(path, true); return result;
    } catch (e) { try { db?.close(); } catch { /* retain sanitized original error */ } throw sanitized(e); }
  }
  private call<T>(fn: () => T): T {
    validateStorage(this.path, true);
    try { return fn(); } catch (e) { throw sanitized(e); }
  }
  prepare(sql: string): CatalogStatement {
    if (Buffer.byteLength(sql) > CATALOG_SQLITE_LIMITS.sqlBytes) throw new CatalogSqliteError("catalog-sqlite-limit");
    const stmt = this.call(() => this.db.prepare(sql));
    const call = <T>(values: SqlValue[], fn: () => T): T => { bounded(values); return this.call(fn); };
    return {
      get: (...values) => call(values, () => { const row = stmt.get(...values); if (row) bounded(Object.values(row)); return row; }),
      run: (...values) => call(values, () => stmt.run(...values)),
      iterate: (maxRows, ...values) => {
        if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > CATALOG_SQLITE_LIMITS.rows) throw new CatalogSqliteError("catalog-sqlite-limit");
        bounded(values);
        const owner = this;
        return (function* () {
          const iterator = call(values, () => stmt.iterate(...values));
          try {
            for (let i = 0; i < maxRows; i++) {
              const next = owner.call(() => iterator.next()); if (next.done) return;
              bounded(Object.values(next.value)); yield next.value;
            }
          } finally { owner.call(() => iterator.return?.()); }
        })();
      },
    };
  }
  transaction<T>(fn: () => T): T {
    return this.call(() => this.db.transaction(() => {
      const value = fn();
      if (value && typeof (value as { then?: unknown }).then === "function") throw new CatalogSqliteError("catalog-sqlite-capability");
      return value;
    })());
  }
  /** Passive maintenance never waits for readers. A retained reader can prevent truncation;
   * journal_size_limit is not a hard WAL quota. Caller must bound transaction size/read lifetime.
   */
  checkpoint(): { busy: number; log: number; checkpointed: number } {
    return this.call(() => this.db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as unknown as { busy: number; log: number; checkpointed: number });
  }
  capabilities(): CatalogCapabilities {
    return this.call(() => {
      const p = (name: string) => this.db.pragma(name, { simple: true });
      const heap = Number(p("hard_heap_limit"));
      // Upstream prebuilds disable memory accounting: a successful limit readback alone is false assurance.
      if (this.db.prepare("SELECT sqlite_compileoption_used('DEFAULT_MEMSTATUS=0') AS disabled").get()?.disabled !== 0)
        throw new CatalogSqliteError("catalog-sqlite-capability");
      if (p("journal_mode") !== "wal" || p("synchronous") !== 2 || p("busy_timeout") !== 50 ||
        p("cache_size") !== -2048 || p("mmap_size") !== 0 || p("temp_store") !== 2 || !Number.isSafeInteger(heap) || heap <= 0 || heap > CATALOG_SQLITE_LIMITS.heapBytes)
        throw new CatalogSqliteError("catalog-sqlite-capability");
      try {
        this.db.prepare("CREATE VIRTUAL TABLE temp.chrono_capability_probe USING fts5(body)").run();
        try {
          this.db.prepare("INSERT INTO temp.chrono_capability_probe(body) VALUES (?)").run("synthetic capability");
          if (this.db.prepare("SELECT rowid FROM temp.chrono_capability_probe WHERE body MATCH ? LIMIT 1").get("synthetic")?.rowid !== 1)
            throw 0;
        } finally { this.db.prepare("DROP TABLE temp.chrono_capability_probe").run(); }
      } catch { throw new CatalogSqliteError("catalog-sqlite-capability"); }
      return { sqliteVersion: String(this.db.prepare("SELECT sqlite_version() AS version").get()?.version),
        journalMode: "wal", synchronous: 2, busyTimeout: 50, cacheSize: -2048, mmapSize: 0, hardHeapLimit: heap, tempStore: 2, fts5: true };
    });
  }
  close(): void { try { this.db.close(); } catch (e) { throw sanitized(e); } }
}
