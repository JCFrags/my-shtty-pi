import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, linkSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { CatalogSqlite, CatalogSqliteError } from "../src/catalog-sqlite.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "chrono-sqlite-synthetic-")); chmodSync(dir, 0o700);
  return { dir, path: join(dir, "catalog.sqlite"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function code(expected: string) { return (e: unknown) => e instanceof CatalogSqliteError && e.code === expected && e.message === expected; }

test("WAL/FULL, heap/cache/temp readbacks, FTS5 bound MATCH, transactions and checkpoint", () => {
  const f = fixture(); const db = CatalogSqlite.open(f.path);
  try {
    assert.deepEqual(db.capabilities(), { sqliteVersion: "3.53.0", journalMode: "wal", synchronous: 2, busyTimeout: 50,
      cacheSize: -2048, mmapSize: 0, hardHeapLimit: 67108864, tempStore: 2, fts5: true });
    db.prepare("CREATE TABLE synthetic (value TEXT)").run();
    assert.throws(() => db.transaction(() => { db.prepare("INSERT INTO synthetic VALUES (?)").run("rollback"); throw new Error("private marker"); }), code("catalog-sqlite-failed"));
    assert.equal(db.prepare("SELECT count(*) AS n FROM synthetic").get()?.n, 0);
    db.transaction(() => db.prepare("INSERT INTO synthetic VALUES (?)").run("commit"));
    assert.equal(db.prepare("SELECT value FROM synthetic").get()?.value, "commit");
    assert.equal(db.checkpoint().busy, 0);
    for (const path of [f.path, `${f.path}-wal`, `${f.path}-shm`]) assert.equal(lstatSync(path).mode & 0o777, 0o600);
    db.prepare("CREATE VIRTUAL TABLE search USING fts5(body)").run();
    db.prepare("INSERT INTO search VALUES (?)").run("synthetic telescope");
    assert.equal(db.prepare("SELECT rowid FROM search WHERE search MATCH ? LIMIT 1").get('"telescope"')?.rowid, 1);
    assert.throws(() => db.prepare("SELECT * FROM private_schema_marker"), code("catalog-sqlite-failed"));
    assert.throws(() => db.transaction(() => Promise.resolve(1)), code("catalog-sqlite-capability"));
    db.prepare("PRAGMA synchronous=OFF").run();
    assert.throws(() => db.capabilities(), code("catalog-sqlite-capability"));
    db.prepare("PRAGMA synchronous=FULL").run();
  } finally { db.close(); f.cleanup(); }
});

test("two connections isolate uncommitted writes, reader snapshot, and bounded writer lock", () => {
  const f = fixture(); const writer = CatalogSqlite.open(f.path); const reader = CatalogSqlite.open(f.path);
  try {
    writer.prepare("CREATE TABLE synthetic (n INTEGER)").run(); writer.prepare("INSERT INTO synthetic VALUES (1)").run();
    writer.transaction(() => {
      writer.prepare("INSERT INTO synthetic VALUES (2)").run();
      assert.equal(reader.prepare("SELECT count(*) AS n FROM synthetic").get()?.n, 1);
      const start = performance.now();
      assert.throws(() => reader.prepare("INSERT INTO synthetic VALUES (3)").run(), code("catalog-sqlite-busy"));
      const elapsed = performance.now() - start;
      assert.ok(elapsed >= 35 && elapsed < 500, `lock waited ${elapsed}ms`);
    });
    reader.transaction(() => {
      assert.equal(reader.prepare("SELECT count(*) AS n FROM synthetic").get()?.n, 2);
      writer.prepare("INSERT INTO synthetic VALUES (4)").run();
      assert.equal(reader.prepare("SELECT count(*) AS n FROM synthetic").get()?.n, 2);
      const checkpoint = writer.checkpoint(); assert.ok(checkpoint.log > checkpoint.checkpointed);
    });
    const checkpoint = writer.checkpoint(); assert.equal(checkpoint.log, checkpoint.checkpointed);
    assert.equal(reader.prepare("SELECT count(*) AS n FROM synthetic").get()?.n, 3);
    assert.equal([...reader.prepare("SELECT n FROM synthetic").iterate(2)].length, 2);
    for (const _row of reader.prepare("SELECT n FROM synthetic").iterate(10)) break;
    reader.prepare("INSERT INTO synthetic VALUES (5)").run(); // early return released native iterator
    assert.throws(() => reader.prepare("SELECT 1").iterate(1025), code("catalog-sqlite-limit"));
    const checkpointJson = JSON.stringify({ synthetic: "x".repeat(1024 * 1024) });
    reader.prepare("CREATE TABLE synthetic_checkpoint (body TEXT)").run();
    reader.transaction(() => reader.prepare("INSERT INTO synthetic_checkpoint VALUES (?)").run(checkpointJson));
    assert.equal(reader.prepare("SELECT body FROM synthetic_checkpoint LIMIT 1").get()?.body, checkpointJson);
    assert.throws(() => reader.prepare("SELECT ?").get("x".repeat(2097153)), code("catalog-sqlite-limit"));
  } finally { reader.close(); writer.close(); f.cleanup(); }
});

test("committed WAL survives actual subprocess SIGKILL; later uncommitted write disappears", async () => {
  const f = fixture();
  const moduleUrl = new URL("../src/catalog-sqlite.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    const { CatalogSqlite } = await import(${JSON.stringify(moduleUrl)});
    const db = CatalogSqlite.open(${JSON.stringify(f.path)});
    db.prepare('CREATE TABLE synthetic(n INTEGER)').run();
    db.transaction(() => db.prepare('INSERT INTO synthetic VALUES (1)').run());
    db.prepare('BEGIN IMMEDIATE').run(); db.prepare('INSERT INTO synthetic VALUES (2)').run();
    process.send('committed'); setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error("child exited before commit"); })]);
    const exit = once(child, "exit"); child.kill("SIGKILL"); assert.equal((await exit)[1], "SIGKILL");
    const db = CatalogSqlite.open(f.path);
    try { assert.deepEqual([...db.prepare("SELECT n FROM synthetic").iterate(10)], [{ n: 1 }]); assert.equal(db.checkpoint().busy, 0); }
    finally { db.close(); }
  } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGKILL"); await exit; } f.cleanup(); }
});

test("effective native heap enforcement, not merely PRAGMA readback", () => {
  const f = fixture();
  try {
    const moduleUrl = new URL("../src/catalog-sqlite.js", import.meta.url).href;
    // Lowering the process-global limit is permanent through SQL, so isolate this check.
    const child = spawnSync(process.execPath, ["--max-old-space-size=32", "--input-type=module", "-e", `
      const { CatalogSqlite } = await import(${JSON.stringify(moduleUrl)});
      const db = CatalogSqlite.open(${JSON.stringify(f.path)});
      try {
        db.prepare('PRAGMA hard_heap_limit=1048576').get();
        try { db.prepare('SELECT length(randomblob(2097152)) AS n').get(); process.exitCode = 2; }
        catch (e) { if (e.code !== 'catalog-sqlite-limit') process.exitCode = 3; }
      } finally { db.close(); }
    `], { encoding: "utf8", timeout: 5000, maxBuffer: 4096 });
    assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 0, "native allocation must refuse");
  } finally { f.cleanup(); }
});

test("corruption is sanitized, not a whole-file fallback or schema recreation", () => {
  const f = fixture();
  try {
    writeFileSync(f.path, "synthetic private corruption marker".repeat(100), { mode: 0o600 });
    assert.throws(() => CatalogSqlite.open(f.path), code("catalog-sqlite-corrupt"));
    assert.equal(lstatSync(f.path).size, 3500);
  } finally { f.cleanup(); }
});

test("owner-only directory and DB/WAL/SHM: reject unsafe modes, symlinks and hardlinks", () => {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    for (const hazard of ["mode", "symlink", "hardlink"]) {
      const f = fixture();
      try {
        const target = join(f.dir, "synthetic-target"); writeFileSync(target, "", { mode: 0o600 });
        const path = f.path + suffix;
        if (hazard === "mode") writeFileSync(path, "", { mode: 0o644 });
        if (hazard === "symlink") symlinkSync(target, path);
        if (hazard === "hardlink") linkSync(target, path);
        assert.throws(() => CatalogSqlite.open(f.path), code("catalog-storage-unsafe"));
      } finally { f.cleanup(); }
    }
  }
  const f = fixture();
  try {
    chmodSync(f.dir, 0o755); assert.throws(() => CatalogSqlite.open(f.path), code("catalog-storage-unsafe"));
    chmodSync(f.dir, 0o700); symlinkSync(f.dir, join(f.dir, "alias"));
    assert.throws(() => CatalogSqlite.open(join(f.dir, "alias", "catalog.sqlite")), code("catalog-storage-unsafe"));
    assert.throws(() => CatalogSqlite.open(":memory:"), code("catalog-storage-unsafe"));
    const db = CatalogSqlite.open(f.path);
    try {
      chmodSync(f.path, 0o644);
      assert.throws(() => db.prepare("SELECT 1"), code("catalog-storage-unsafe"));
    } finally { chmodSync(f.path, 0o600); db.close(); }
  } finally { f.cleanup(); }
});

test("native SQLite reads bypass JS readSync source accounting (disclosure regression)", () => {
  const f = fixture(); let db = CatalogSqlite.open(f.path); const original = fs.readSync;
  try {
    db.prepare("CREATE TABLE synthetic (n INTEGER)").run(); db.prepare("INSERT INTO synthetic VALUES (7)").run(); db.checkpoint(); db.close();
    fs.readSync = (() => { throw new Error("JS source read forbidden"); }) as typeof fs.readSync;
    db = CatalogSqlite.open(f.path); // new native connection must read the persisted database
    assert.equal(db.prepare("SELECT n FROM synthetic").get()?.n, 7);
  } finally { fs.readSync = original; db.close(); f.cleanup(); }
});
