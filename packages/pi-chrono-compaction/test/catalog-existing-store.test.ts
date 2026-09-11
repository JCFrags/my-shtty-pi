import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { CatalogSqlite } from "../src/catalog-sqlite.js";
import { executeCatalogRequest } from "../src/catalog-engine.js";
import { executeCatalogStoreRequest, createCatalogStoreExecutor } from "../src/catalog-store.js";
import type { CatalogResponse, CatalogView } from "../src/catalog-contract.js";
const ok = (r: CatalogResponse): Record<string, any> => { assert.equal(r.ok, true, JSON.stringify(r)); return r.ok ? r.result : {}; };
const refused = (r: CatalogResponse): void => { assert.equal(r.ok, false, JSON.stringify(r)); assert.equal(r.sourceBytes, 0); };
const dbName = `catalog-${createHash("sha256").update("synthetic").digest("hex")}.sqlite`;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "chrono-existing-synthetic-"));
  const root = join(dir, "logical"), source = join(dir, "source.jsonl");
  writeFileSync(source, JSON.stringify({ type: "message", id: "a", parentId: null, message: { role: "user", content: [{ type: "text", text: "synthetic" }] } }) + "\n", { mode: 0o600 });
  const base = { v: 1, sessionKey: "synthetic", catalogDirectory: root };
  const ingest = { op: "ingestStep", shardKey: "s", branchKey: "main", shardOrdinal: 0, sourcePath: source };
  const request = (r: Record<string, unknown>) => executeCatalogStoreRequest({ ...base, ...r });
  const metadata = () => [readFileSync(join(root, "active.json")), ...readdirSync(join(root, "refs")).sort().map(n => readFileSync(join(root, "refs", n))), readFileSync(source)];
  const dbPath = (key: string) => join(root, "stores", JSON.parse(readFileSync(join(root, "refs", `${key}.json`), "utf8")).folder, dbName);
  return { dir, root, source, base, ingest, request, metadata, dbPath };
}
for (const sidecars of [false, true]) for (const empty of [false, true]) {
  test(`native existing lookup refuses ${empty ? "empty" : "missing"} DB, sidecars=${sidecars}, without creating storage`, () => {
    const dir = mkdtempSync(join(tmpdir(), "chrono-existing-native-")), path = join(dir, "catalog.sqlite");
    try {
      if (empty) writeFileSync(path, "", { mode: 0o600 });
      if (sidecars) for (const suffix of ["-wal", "-shm", "-journal"]) writeFileSync(path + suffix, "synthetic-survivor", { mode: 0o600 });
      const snapshot = () => readdirSync(dir).sort().map(n => [n, readFileSync(join(dir, n)).toString("hex")]);
      const before = snapshot();
      assert.throws(() => CatalogSqlite.open(path), /catalog-/);
      assert.deepEqual(snapshot(), before);
      if (sidecars || empty) { assert.throws(() => CatalogSqlite.create(path), /catalog-/); assert.deepEqual(snapshot(), before); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
for (const damage of ["missing", "empty", "blank-schema", "wrong-identity", "wrong-schema", "missing-sidecars", "empty-sidecars"]) {
  test(`physical lookup preserves artifacts and pointers on ${damage}`, async () => {
    const f = fixture();
    try {
      ok(await f.request(f.ingest));
      const view = ok(await f.request({ op: "pin", branchKey: "main", leaf: { shardKey: "s", eventId: "a" } })).view as CatalogView;
      const path = f.dbPath(view.storeKey), before = f.metadata();
      if (damage === "wrong-identity" || damage === "wrong-schema") {
        const db = CatalogSqlite.open(path);
        db.prepare(damage === "wrong-identity" ? "UPDATE meta SET store='00000000-0000-4000-8000-000000000000'" : "DROP TABLE spans").run(); db.close();
      } else {
        rmSync(path);
        if (damage.startsWith("empty")) writeFileSync(path, "", { mode: 0o600 });
        if (damage === "blank-schema") { const db = CatalogSqlite.create(path); db.close(); }
        if (damage.endsWith("sidecars")) for (const suffix of ["-wal", "-shm", "-journal"]) writeFileSync(path + suffix, "synthetic-survivor", { mode: 0o600 });
      }
      const artifacts = () => ["", "-wal", "-shm", "-journal"].map(s => existsSync(path + s) ? createHash("sha256").update(readFileSync(path + s)).digest("hex") : null);
      const damaged = artifacts();
      for (const r of [{ op: "status" }, { op: "status", targetStoreKey: view.storeKey }, { op: "page", view }, { op: "blocks", view, eventSeq: 1 }, { op: "raw", view, eventSeq: 1, offset: 0, length: 1 }, f.ingest]) {
        refused(await f.request(r));
        const after = artifacts(); assert.equal(after[0], damaged[0]);
        // Read-only SQLite WAL lookup may create/rebuild its transient WAL index.
        // Missing/zero DB refuses before native open and preserves ALL sidecars.
        if (damage.includes("missing") || damage.includes("empty")) assert.deepEqual(after, damaged);
        else {
          // Native read-only preflight creates an empty WAL and 32 KiB SHM on
          // this pinned Linux SQLite build; no rollback journal is created.
          assert.equal(readFileSync(path + "-wal").length, 0);
          assert.equal(readFileSync(path + "-shm").length, 32768);
          assert.equal(after[3], damaged[3]);
        }
        assert.deepEqual(f.metadata(), before);
      }
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
}
test("native and physical valid committed WAL survives process death and opens without bootstrap", async () => {
  const f = fixture();
  try {
    ok(await f.request(f.ingest));
    const view = ok(await f.request({ op: "pin", branchKey: "main", leaf: { shardKey: "s", eventId: "a" } })).view as CatalogView;
    const path = f.dbPath(view.storeKey), adapter = new URL("../src/catalog-sqlite.js", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import {CatalogSqlite} from ${JSON.stringify(adapter)}; const db=CatalogSqlite.open(${JSON.stringify(path)}); db.prepare("UPDATE generations SET token='synthetic-wal' WHERE g=1").run(); process.kill(process.pid,'SIGKILL');`], { timeout: 10000 });
    assert.equal(child.signal, "SIGKILL", child.stderr.toString()); assert.ok(existsSync(path + "-wal"));
    ok(await f.request({ op: "page", view }));
    const db = CatalogSqlite.open(path); assert.equal(db.prepare("SELECT token FROM generations WHERE g=1").get()?.token, "synthetic-wal"); db.close();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test("explicit recovery resumes commit interruption, publishes safely and retains healthy old pins", async () => {
  const f = fixture();
  try {
    ok(await f.request(f.ingest));
    const view = ok(await f.request({ op: "pin", branchKey: "main", leaf: { shardKey: "s", eventId: "a" } })).view as CatalogView;
    const oldDb = readFileSync(f.dbPath(view.storeKey)), source = readFileSync(f.source);
    const start = { ...f.base, op: "recoverStart", rebuildKey: "restartable" };
    const interrupted = createCatalogStoreExecutor(executeCatalogRequest, { fault(point) { if (point === "after-store-commit") throw new Error("synthetic"); } });
    refused(await interrupted(start));
    const stage = ok(await executeCatalogStoreRequest(start)); assert.deepEqual(ok(await executeCatalogStoreRequest(start)), stage);
    ok(await f.request({ ...f.ingest, targetStoreKey: stage.targetStoreKey, generation: stage.generation }));
    const publish = { op: "recoverPublish", targetStoreKey: stage.targetStoreKey, generation: stage.generation, expectedShards: 1, expectedActiveStoreKey: stage.expectedActiveStoreKey };
    ok(await f.request(publish)); ok(await f.request(publish));
    assert.equal(ok(await f.request({ op: "page", view })).events instanceof Array, true);
    assert.deepEqual(readFileSync(f.dbPath(view.storeKey)), oldDb); assert.deepEqual(readFileSync(f.source), source);
    // A repeated start for a referenced recovery store is lookup, not new allocation.
    const path = f.dbPath(stage.targetStoreKey); rmSync(path);
    refused(await executeCatalogStoreRequest(start)); assert.equal(existsSync(path), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test("lost active pointer does not permit replacement of an already-referenced initial DB", async () => {
  const f = fixture();
  try {
    ok(await f.request(f.ingest));
    const active = JSON.parse(readFileSync(join(f.root, "active.json"), "utf8"));
    const path = f.dbPath(active.storeKey), ref = readFileSync(join(f.root, "refs", `${active.storeKey}.json`)), source = readFileSync(f.source);
    rmSync(join(f.root, "active.json")); rmSync(path);
    refused(await f.request(f.ingest)); assert.equal(existsSync(path), false); assert.equal(existsSync(join(f.root, "active.json")), false);
    assert.deepEqual(readFileSync(join(f.root, "refs", `${active.storeKey}.json`)), ref); assert.deepEqual(readFileSync(f.source), source);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test("legacy recovery intent without UUID refuses without creating physical storage", async () => {
  const f = fixture();
  try {
    ok(await f.request(f.ingest));
    const folder = `recovery-${createHash("sha256").update("synthetic\0legacy").digest("hex")}`;
    const stagePath = join(f.root, "stages", `${folder}.json`);
    writeFileSync(stagePath, JSON.stringify({ v: 1, sessionKey: "synthetic", folder, rebuildKey: "legacy", expectedActiveStoreKey: null }), { mode: 0o600 });
    const before = f.metadata(), stage = readFileSync(stagePath);
    refused(await f.request({ op: "recoverStart", rebuildKey: "legacy" }));
    assert.equal(existsSync(join(f.root, "stores", folder)), false); assert.deepEqual(readFileSync(stagePath), stage); assert.deepEqual(f.metadata(), before);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test("native read-only identity refusal preserves committed WAL and database bytes", async () => {
  const f = fixture();
  try {
    ok(await f.request(f.ingest));
    const active = JSON.parse(readFileSync(join(f.root, "active.json"), "utf8")), path = f.dbPath(active.storeKey);
    const adapter = new URL("../src/catalog-sqlite.js", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import {CatalogSqlite} from ${JSON.stringify(adapter)}; const db=CatalogSqlite.open(${JSON.stringify(path)}); db.prepare("UPDATE meta SET store='00000000-0000-4000-8000-000000000000'").run(); process.kill(process.pid,'SIGKILL');`], { timeout: 10000 });
    assert.equal(child.signal, "SIGKILL", child.stderr.toString());
    const before = [readFileSync(path), readFileSync(path + "-wal")], metadata = f.metadata();
    assert.throws(() => CatalogSqlite.open(path, db => {
      assert.notEqual(db.prepare("SELECT store FROM meta").get()?.store, active.storeKey);
      throw Object.assign(new Error("catalog-store-mismatch"), { code: "catalog-store-mismatch" });
    }), /catalog-store-mismatch/);
    refused(await f.request({ op: "status" }));
    assert.deepEqual([readFileSync(path), readFileSync(path + "-wal")], before); assert.deepEqual(f.metadata(), metadata);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
for (const recovery of [false, true]) test(`${recovery ? "recovery" : "initial"} bootstrap resumes an intent-only commit interruption`, async () => {
  const f = fixture();
  try {
    const request = { ...f.base, ...(recovery ? { op: "recoverStart", rebuildKey: "intent-only" } : f.ingest) };
    const interrupted = createCatalogStoreExecutor(executeCatalogRequest, { fault(point) { if (point === "after-metadata-rename") throw new Error("synthetic"); } });
    refused(await interrupted(request));
    assert.deepEqual(readdirSync(join(f.root, "stores")), []);
    const stagePath = join(f.root, "stages", readdirSync(join(f.root, "stages"))[0]!);
    const stage = readFileSync(stagePath), identity = JSON.parse(stage.toString()).storeKey;
    const resumed = ok(await executeCatalogStoreRequest(request));
    assert.equal(recovery ? resumed.targetStoreKey : ok(await f.request({ op: "status" })).storeKey, identity);
    assert.deepEqual(readFileSync(stagePath), stage);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
for (const recovery of [false, true]) test(`${recovery ? "recovery" : "initial"} used folder with missing ref and DB is not silently reused`, async () => {
  const f = fixture();
  try {
    ok(await f.request(f.ingest));
    const start = { op: "recoverStart", rebuildKey: "lost-ref" };
    const storeKey = recovery ? ok(await f.request(start)).targetStoreKey : ok(await f.request({ op: "status" })).storeKey;
    const path = f.dbPath(storeKey);
    rmSync(join(f.root, "refs", `${storeKey}.json`)); rmSync(path);
    if (!recovery) rmSync(join(f.root, "active.json"));
    const source = readFileSync(f.source), stages = readdirSync(join(f.root, "stages")).sort().map(n => readFileSync(join(f.root, "stages", n)));
    refused(await f.request(recovery ? start : f.ingest));
    assert.equal(existsSync(path), false); assert.equal(existsSync(join(f.root, "refs", `${storeKey}.json`)), false);
    assert.deepEqual(readFileSync(f.source), source); assert.deepEqual(readdirSync(join(f.root, "stages")).sort().map(n => readFileSync(join(f.root, "stages", n))), stages);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
for (const recovery of [false, true]) test(`${recovery ? "recovery" : "initial"} zero-byte reservation without ref refuses instead of bootstrap`, async () => {
  const f = fixture();
  try {
    const request = { ...f.base, ...(recovery ? { op: "recoverStart", rebuildKey: "empty-reservation" } : f.ingest) };
    const interrupted = createCatalogStoreExecutor(executeCatalogRequest, { fault(point) { if (point === "after-store-commit") throw new Error("synthetic"); } });
    refused(await interrupted(request));
    const folder = readdirSync(join(f.root, "stores"))[0]!, path = join(f.root, "stores", folder, dbName);
    writeFileSync(path, "");
    const source = readFileSync(f.source), entries = readdirSync(join(f.root, "stores", folder));
    refused(await executeCatalogStoreRequest(request));
    assert.equal(readFileSync(path).length, 0); assert.deepEqual(readdirSync(join(f.root, "stores", folder)), entries);
    assert.deepEqual(readdirSync(join(f.root, "refs")), []); assert.deepEqual(readFileSync(f.source), source);
    // Explicit different token creates another physical store without repairing the old one.
    ok(await f.request({ op: "recoverStart", rebuildKey: "fresh-after-empty" })); assert.equal(readFileSync(path).length, 0);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
