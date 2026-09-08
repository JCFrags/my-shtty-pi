import { constants, closeSync, lstatSync, openSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { createRequire } from "node:module";
/** Worker-only synchronous native I/O. M03's JS source-read ledger does NOT cover it.
 * Native allocations are outside V8; the M03 controller is the final memory/deadline boundary.
 * SQL is trusted implementation code, never source content. Bind source values as parameters.
 */
export const CATALOG_SQLITE_LIMITS = Object.freeze({ busyMs: 50, cacheKiB: 2048,
    heapBytes: 64 * 1024 * 1024, sqlBytes: 64 * 1024, valueBytes: 2 * 1024 * 1024, rows: 1024 });
const require = createRequire(import.meta.url);
export class CatalogSqliteError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = "CatalogSqliteError";
    }
}
function sanitized(error) {
    if (error instanceof CatalogSqliteError)
        return error;
    const code = error?.code;
    return new CatalogSqliteError(code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" ? "catalog-sqlite-busy" :
        code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB" ? "catalog-sqlite-corrupt" :
            code === "SQLITE_NOMEM" || code === "SQLITE_TOOBIG" || code === "SQLITE_FULL" ? "catalog-sqlite-limit" : "catalog-sqlite-failed");
}
/** Refuse observed links/unsafe permissions; public SQLite API has no fd/O_NOFOLLOW open.
 * This does not eliminate same-UID path replacement races. Require private worker storage.
 */
function validateStorage(path, requireDatabase = false) {
    try {
        if (!isAbsolute(path) || resolve(path) !== path || typeof process.getuid !== "function")
            throw 0;
        let part = parse(path).root;
        for (const component of dirname(path).slice(part.length).split("/").filter(Boolean)) {
            part = join(part, component);
            const st = lstatSync(part);
            if (!st.isDirectory() || st.isSymbolicLink() || (st.uid !== 0 && st.uid !== process.getuid()) ||
                ((st.mode & 0o022) !== 0 && !(st.uid === 0 && (st.mode & 0o1000) !== 0)))
                throw 0;
        }
        const parent = lstatSync(dirname(path));
        if (parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700)
            throw 0;
        for (const name of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
            let st;
            try {
                st = lstatSync(name);
            }
            catch (e) {
                if (e.code === "ENOENT" && !(requireDatabase && name === path))
                    continue;
                throw e;
            }
            if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o600)
                throw 0;
        }
    }
    catch {
        throw new CatalogSqliteError("catalog-storage-unsafe");
    }
}
function bounded(values) {
    let bytes = 0;
    for (const value of values)
        bytes += typeof value === "string" ? Buffer.byteLength(value) : Buffer.isBuffer(value) ? value.length : 8;
    if (bytes > CATALOG_SQLITE_LIMITS.valueBytes)
        throw new CatalogSqliteError("catalog-sqlite-limit");
}
export class CatalogSqlite {
    path;
    db;
    constructor(path, db) {
        this.path = path;
        this.db = db;
    }
    static open(path) {
        validateStorage(path);
        // Reserve the initial database with owner-only permissions, without truncating existing data.
        try {
            const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
            closeSync(fd);
        }
        catch (e) {
            if (e.code !== "EEXIST")
                throw new CatalogSqliteError("catalog-storage-unsafe");
        }
        validateStorage(path, true);
        let Constructor;
        try {
            Constructor = require("better-sqlite3");
        }
        catch {
            throw new CatalogSqliteError("catalog-sqlite-unavailable");
        }
        let db;
        try {
            db = new Constructor(path, { timeout: CATALOG_SQLITE_LIMITS.busyMs, fileMustExist: true });
            db.pragma("hard_heap_limit=67108864"); // Process-global, may only lower an existing limit.
            db.pragma("cache_size=-2048");
            db.pragma("mmap_size=0");
            db.pragma("temp_store=MEMORY");
            db.pragma("busy_timeout=50");
            db.pragma("journal_mode=WAL");
            db.pragma("synchronous=FULL");
            db.pragma("wal_autocheckpoint=256");
            db.pragma("journal_size_limit=1048576");
            db.pragma("trusted_schema=OFF");
            db.pragma("foreign_keys=ON");
            const result = new CatalogSqlite(path, db);
            result.capabilities();
            validateStorage(path, true);
            return result;
        }
        catch (e) {
            try {
                db?.close();
            }
            catch { /* retain sanitized original error */ }
            throw sanitized(e);
        }
    }
    call(fn) {
        validateStorage(this.path, true);
        try {
            return fn();
        }
        catch (e) {
            throw sanitized(e);
        }
    }
    prepare(sql) {
        if (Buffer.byteLength(sql) > CATALOG_SQLITE_LIMITS.sqlBytes)
            throw new CatalogSqliteError("catalog-sqlite-limit");
        const stmt = this.call(() => this.db.prepare(sql));
        const call = (values, fn) => { bounded(values); return this.call(fn); };
        return {
            get: (...values) => call(values, () => { const row = stmt.get(...values); if (row)
                bounded(Object.values(row)); return row; }),
            run: (...values) => call(values, () => stmt.run(...values)),
            iterate: (maxRows, ...values) => {
                if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > CATALOG_SQLITE_LIMITS.rows)
                    throw new CatalogSqliteError("catalog-sqlite-limit");
                bounded(values);
                const owner = this;
                return (function* () {
                    const iterator = call(values, () => stmt.iterate(...values));
                    try {
                        for (let i = 0; i < maxRows; i++) {
                            const next = owner.call(() => iterator.next());
                            if (next.done)
                                return;
                            bounded(Object.values(next.value));
                            yield next.value;
                        }
                    }
                    finally {
                        owner.call(() => iterator.return?.());
                    }
                })();
            },
        };
    }
    transaction(fn) {
        return this.call(() => this.db.transaction(() => {
            const value = fn();
            if (value && typeof value.then === "function")
                throw new CatalogSqliteError("catalog-sqlite-capability");
            return value;
        })());
    }
    /** Passive maintenance never waits for readers. A retained reader can prevent truncation;
     * journal_size_limit is not a hard WAL quota. Caller must bound transaction size/read lifetime.
     */
    checkpoint() {
        return this.call(() => this.db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get());
    }
    capabilities() {
        return this.call(() => {
            const p = (name) => this.db.pragma(name, { simple: true });
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
                }
                finally {
                    this.db.prepare("DROP TABLE temp.chrono_capability_probe").run();
                }
            }
            catch {
                throw new CatalogSqliteError("catalog-sqlite-capability");
            }
            return { sqliteVersion: String(this.db.prepare("SELECT sqlite_version() AS version").get()?.version),
                journalMode: "wal", synchronous: 2, busyTimeout: 50, cacheSize: -2048, mmapSize: 0, hardHeapLimit: heap, tempStore: 2, fts5: true };
        });
    }
    close() { try {
        this.db.close();
    }
    catch (e) {
        throw sanitized(e);
    } }
}
//# sourceMappingURL=catalog-sqlite.js.map