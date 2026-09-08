import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, linkSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { CatalogSqlite } from "../src/catalog-sqlite.js";
import { executeCapsuleRequest } from "../src/capsule-store.js";
import { setupCapsuleFixture, line } from "./capsule-storage-fixture.js";

const storeModuleUrl = new URL("../src/capsule-store.js", import.meta.url).href;
async function killedDerive(request: unknown): Promise<{ signal: string | null; stderr: string }> {
  const script = `import {executeCapsuleRequest} from ${JSON.stringify(storeModuleUrl)}; await executeCapsuleRequest(${JSON.stringify(request)},{segmentHooks:{fault(point,kind){if(point==='after-file-rename'&&kind==='chunk')process.kill(process.pid,'SIGKILL')}}});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] }); let stderr = "";
  child.stderr.on("data", bytes => { stderr += bytes; });
  return await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("capsule-child-timeout")); }, 25_000);
    child.once("error", reject); child.once("close", (_code, signal) => { clearTimeout(timer); resolve({ signal, stderr }); }); });
}

async function deriveToEnd(f: ReturnType<typeof setupCapsuleFixture>, view: any, options?: any) {
  let cursor: any, body: any, last: any;
  for (let i = 0; i < 200; i++) {
    const response = await f.request(view, { op: "derivePage", ...(cursor ? { cursor } : {}) }, options);
    assert.equal(response.ok, true, JSON.stringify(response));
    if (!response.ok) throw new Error("capsule-derive-refused");
    last = response.result; cursor = last.cursor; body ??= last.body;
    assert.ok(response.sourceBytes <= 8 * 1024 * 1024);
    if (last.complete) return { ...last, body: body ?? last.body };
  }
  assert.fail("derive did not complete");
}

test("incremental derive publishes exact chunks before SQLite and restart/noop is byte-identical", async () => {
  const text = "x".repeat(70_000) + "😀tail", f = setupCapsuleFixture(line("a", null, text));
  try {
    const view = await f.initialize();
    const first = await deriveToEnd(f, view);
    assert.equal(first.complete, true); assert.equal(first.readiness.chunks.ready, 1); assert.equal(first.readiness.capsules.ready, 1);
    assert.ok(first.readiness.capsules.unsupported >= 1, "bodyless structural descriptors remain honestly unsupported");
    const segmentFiles = readdirSync(join(f.derivedDirectory, "segments/chunks")).sort();
    assert.equal(segmentFiles.length, 3);
    const before = segmentFiles.map(name => [name, lstatSync(join(f.derivedDirectory, "segments/chunks", name)).size]);
    const noop = await deriveToEnd(f, view); assert.equal(noop.complete, true);
    assert.deepEqual(readdirSync(join(f.derivedDirectory, "segments/chunks")).sort().map(name => [name, lstatSync(join(f.derivedDirectory, "segments/chunks", name)).size]), before);
    const range = await f.ok(view, { op: "chunkRange", source: first.body.source, decodedStart: 69_999, decodedLength: 3 });
    assert.equal(Buffer.from(range.data, "base64").toString("utf16le"), text.slice(69_999, 70_002));
    assert.equal(range.complete, true);
    const capsules = await f.ok(view, { op: "capsulePage", limit: 2 });
    assert.equal(capsules.capsules.length, 1); assert.equal(capsules.capsules[0].source.bodyHash, first.body.bodyHash);
    assert.ok(capsules.capsules[0].alternatives.every((alternative: any) => alternative.outcome.status === "unknown"));
    assert.ok(capsules.capsules[0].alternatives.flatMap((alternative: any) => alternative.facts).every((fact: any) => fact.source.coordinateKind !== "raw-json"));
    for (const child of ["", "segments", "segments/chunks", "segments/capsules", "manifests", "receipts"]) assert.equal(lstatSync(join(f.derivedDirectory, child)).mode & 0o777, 0o700);
    for (const name of ["derived.sqlite", "publication.lock"]) assert.equal(lstatSync(join(f.derivedDirectory, name)).mode & 0o777, 0o600);
    const db = CatalogSqlite.open(join(f.derivedDirectory, "derived.sqlite"));
    const receiptHash = String(db.prepare("SELECT receiptHash FROM readiness WHERE receiptHash IS NOT NULL LIMIT 1").get()!.receiptHash); db.close();
    rmSync(join(f.derivedDirectory, "receipts", receiptHash));
    const degraded = await f.request(view, { op: "status" }); assert.equal(degraded.ok, false);
    if (!degraded.ok) { assert.equal(degraded.code, "capsule-content-missing"); assert.equal(degraded.resumable, true); }
  } finally { f.cleanup(); }
});

test("partial giant-body checkpoint never reports chunk ready, while empty and opaque bodies keep independent counts", async () => {
  const giant = setupCapsuleFixture(line("a", null, "z".repeat(200_000)));
  try {
    const view = await giant.initialize();
    const first = await giant.ok(view, { op: "derivePage" });
    assert.equal(first.complete, false); assert.equal(first.readiness.chunks.state, "partial"); assert.equal(first.readiness.chunks.ready, 0);
    assert.ok(first.cursor.partialBody); assert.ok(first.cursor.bodyRawOffset > first.cursor.partialBody.source.raw.start);
  } finally { giant.cleanup(); }
  const empty = setupCapsuleFixture(line("a", null, ""));
  try {
    const view = await empty.initialize(), done = await deriveToEnd(empty, view);
    assert.equal(done.body.chunkCount, 0); assert.equal(done.readiness.chunks.ready, 1);
    assert.equal(readdirSync(join(empty.derivedDirectory, "segments/chunks")).length, 0);
    assert.equal(done.readiness.capsules.ready, 1);
  } finally { empty.cleanup(); }
  const opaqueLine = JSON.stringify({ type: "message", id: "a", parentId: null, message: { role: "user", content: [{ type: "image", data: "opaque-data" }] } }) + "\n";
  const opaque = setupCapsuleFixture(opaqueLine);
  try {
    const view = await opaque.initialize(), done = await deriveToEnd(opaque, view);
    assert.equal(done.readiness.chunks.ready, 0); assert.ok(done.readiness.chunks.excluded >= 1);
    assert.equal(readdirSync(join(opaque.derivedDirectory, "segments/chunks")).length, 0);
  } finally { opaque.cleanup(); }
});

test("same-branch append reuses its checkpoint while an old exact pin retains receipt-scoped readiness", async () => {
  const f = setupCapsuleFixture();
  try {
    const old = await f.initialize(); await deriveToEnd(f, old);
    const oldStatus = await f.ok(old, { op: "status" });
    f.append(line("b", "a", "second")); await f.ingest();
    const next = (await f.catalog({ op: "pin", branchKey: "main", leaf: { shardKey: "s1", eventId: "b" } })).view;
    const appended = await deriveToEnd(f, next);
    assert.equal(appended.readiness.chunks.ready, 2);
    const retained = await f.ok(old, { op: "status" });
    assert.deepEqual(retained.readiness, oldStatus.readiness);
    assert.ok(retained.metrics.sqliteStatements < 64, "status must use one exact indexed receipt, not aggregate history");
  } finally { f.cleanup(); }
});

test("fork capsule pages filter selected ancestry before limit and old-pin continuation remains stable", async () => {
  const f = setupCapsuleFixture(line("a", null, "ancestor") + line("b", "a", "sibling-b"));
  const page = async (view: any, cursor?: any) => f.ok(view, { op: "capsulePage", limit: 1, ...(cursor ?? {}) });
  try {
    const bView = await f.initialize("b"); await deriveToEnd(f, bView);
    const b1 = await page(bView), b2 = await page(bView, b1.next);
    assert.deepEqual(b1.capsules.map((item: any) => item.source.eventSeq), [1]);
    assert.deepEqual(b2.capsules.map((item: any) => item.source.eventSeq), [2]);
    assert.equal(b1.complete, false); assert.equal(b2.complete, true);

    f.append(line("c", "a", "fork-c")); await f.ingest();
    const cView = (await f.catalog({ op: "pin", branchKey: "main", leaf: { shardKey: "s1", eventId: "c" } })).view;
    const c = await deriveToEnd(f, cView);
    assert.equal(c.readiness.chunks.ready, 2, "ancestor and fork event are selected; sibling b is excluded");
    const c1 = await page(cView), c2 = await page(cView, c1.next);
    assert.deepEqual(c1.capsules.map((item: any) => item.source.eventSeq), [1]);
    assert.deepEqual(c2.capsules.map((item: any) => item.source.eventSeq), [3]);
    assert.equal(c1.complete, false); assert.equal(c2.complete, true);

    const retained1 = await page(bView), retained2 = await page(bView, retained1.next);
    assert.deepEqual(retained1.capsules, b1.capsules); assert.deepEqual(retained2.capsules, b2.capsules);
    assert.equal(retained2.complete, true);
  } finally { f.cleanup(); }
});

test("SQLite commit fault leaves durable files invisible; retry publishes lookup without overwrite", async () => {
  const f = setupCapsuleFixture(line("a", null, "durable ordering"));
  try {
    const view = await f.initialize(); let fired = false;
    const failed = await f.request(view, { op: "derivePage" }, { fault(point) { if (!fired && point === "inside-sqlite-transaction") { fired = true; throw Object.assign(new Error("synthetic"), { code: "ENOSPC" }); } } });
    assert.equal(failed.ok, false); assert.equal(failed.code, "capsule-store-failed");
    assert.ok(readdirSync(join(f.derivedDirectory, "segments/chunks")).length > 0, "durable orphan remains");
    const absent = await f.ok(view, { op: "status" }); assert.equal(absent.readiness.chunks.ready, 0);
    const recovered = await deriveToEnd(f, view); assert.equal(recovered.readiness.chunks.ready, 1);
    assert.equal(readdirSync(join(f.derivedDirectory, "segments/chunks")).length, 1);
  } finally { f.cleanup(); }
});

test("actual SIGKILL after segment rename releases the mutex and retry finishes durable publication", async () => {
  const f = setupCapsuleFixture(line("a", null, "actual subprocess crash"));
  try {
    const view = await f.initialize();
    const request = { v: 1, derivedDirectory: f.derivedDirectory, catalogDirectory: f.catalogDirectory, identity: f.identity, view, op: "derivePage" };
    const dead = await killedDerive(request); assert.equal(dead.signal, "SIGKILL", dead.stderr);
    assert.equal(readdirSync(join(f.derivedDirectory, "segments/chunks")).length, 1);
    const recovered = await deriveToEnd(f, view); assert.equal(recovered.readiness.chunks.ready, 1);
    assert.equal(readdirSync(join(f.derivedDirectory, "segments/chunks")).length, 1);
  } finally { f.cleanup(); }
});

test("missing/corrupt/unsafe selected content degrades explicitly and never scans for replacement", async () => {
  const f = setupCapsuleFixture();
  try {
    const view = await f.initialize(), done = await deriveToEnd(f, view), chunks = join(f.derivedDirectory, "segments/chunks");
    const name = readdirSync(chunks)[0]!, path = join(chunks, name);
    rmSync(path); let response = await f.request(view, { op: "chunkRange", source: done.body.source, decodedStart: 0, decodedLength: 1 });
    assert.equal(response.ok, false); if (!response.ok) { assert.equal(response.code, "capsule-content-missing"); assert.equal(response.resumable, true); }
    writeFileSync(path, Buffer.alloc(100, 1), { mode: 0o600 });
    response = await f.request(view, { op: "chunkRange", source: done.body.source, decodedStart: 0, decodedLength: 1 }); assert.equal(response.ok, false);
    rmSync(path); writeFileSync(path, Buffer.alloc(100, 1), { mode: 0o600 }); linkSync(path, `${path}.alias`);
    response = await f.request(view, { op: "chunkRange", source: done.body.source, decodedStart: 0, decodedLength: 1 }); assert.equal(response.ok, false);
  } finally { f.cleanup(); }
});

test("read-only requests never recreate a missing publication lock and the valid store remains reusable", async () => {
  const f = setupCapsuleFixture(line("a", null, "lock boundary"));
  try {
    const view = await f.initialize(), done = await deriveToEnd(f, view), lock = join(f.derivedDirectory, "publication.lock");
    rmSync(lock);
    for (const operation of [{ op: "status" }, { op: "capsulePage", limit: 1 },
      { op: "chunkRange", source: done.body.source, decodedStart: 0, decodedLength: 1 }]) {
      const response = await f.request(view, operation); assert.equal(response.ok, false); assert.equal(existsSync(lock), false);
    }
    writeFileSync(lock, "", { mode: 0o600 });
    const status = await f.ok(view, { op: "status" }); assert.equal(status.readiness.chunks.ready, 1);
    const range = await f.ok(view, { op: "chunkRange", source: done.body.source, decodedStart: 0, decodedLength: 1 });
    assert.equal(Buffer.from(range.data, "base64").toString("utf16le"), "l");
  } finally { f.cleanup(); }
});

test("derived schema v1 requests and stores refuse without mutation while a fresh v2 store works", async () => {
  const f = setupCapsuleFixture();
  try {
    const view = await f.initialize(); await deriveToEnd(f, view);
    const dbPath = join(f.derivedDirectory, "derived.sqlite");
    const valid = await f.request(view, { op: "status" }); assert.equal(valid.ok, true, JSON.stringify(valid));

    let before = readFileSync(dbPath);
    let response = await executeCapsuleRequest({ v: 1, derivedDirectory: f.derivedDirectory, catalogDirectory: f.catalogDirectory,
      identity: { ...f.identity, derivedSchemaVersion: 1 }, op: "status", view });
    assert.equal(response.ok, false); if (!response.ok) assert.equal(response.code, "capsule-request-invalid");
    assert.deepEqual(readFileSync(dbPath), before, "an explicit v1 request must not touch the v2 store");

    const db = CatalogSqlite.open(dbPath); db.prepare("UPDATE meta SET version=1").run(); db.close();
    before = readFileSync(dbPath);
    response = await f.request(view, { op: "status" });
    assert.equal(response.ok, false); if (!response.ok) assert.equal(response.code, "capsule-store-mismatch");
    assert.deepEqual(readFileSync(dbPath), before, "a v1 physical store must be refused without mutation");
  } finally { f.cleanup(); }
});

test("physical identity, route, schema and unsafe database bytes refuse without recreating", async () => {
  const f = setupCapsuleFixture();
  try {
    const view = await f.initialize(); await deriveToEnd(f, view);
    const dbPath = join(f.derivedDirectory, "derived.sqlite"), before = lstatSync(dbPath).size;
    let response = await executeCapsuleRequest({ v: 1, derivedDirectory: f.derivedDirectory, catalogDirectory: f.catalogDirectory,
      identity: { ...f.identity, storeKey: randomUUID() }, op: "status", view });
    assert.equal(response.ok, false); if (!response.ok) assert.equal(response.code, "capsule-store-mismatch");
    response = await executeCapsuleRequest({ v: 1, derivedDirectory: f.derivedDirectory, catalogDirectory: `${f.catalogDirectory}-other`, identity: f.identity, op: "status", view });
    assert.equal(response.ok, false);
    let db = CatalogSqlite.open(dbPath); db.prepare("UPDATE meta SET version=99").run(); db.close();
    response = await f.request(view, { op: "status" }); assert.equal(response.ok, false); assert.equal(lstatSync(dbPath).size, before);
    db = CatalogSqlite.open(dbPath); db.prepare("UPDATE meta SET version=2").run(); db.close(); chmodSync(dbPath, 0o644);
    response = await f.request(view, { op: "status" }); assert.equal(response.ok, false);
  } finally { f.cleanup(); }
});
