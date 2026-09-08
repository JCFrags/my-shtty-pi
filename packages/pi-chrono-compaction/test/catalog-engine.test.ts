import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync, statSync, chmodSync, renameSync, truncateSync, openSync, writeSync, closeSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { executeCatalogRequest } from "../src/catalog-engine.js";
import { isCatalogRequest, type CatalogView } from "../src/catalog-contract.js";
import { CatalogSqlite } from "../src/catalog-sqlite.js";
const line = (id: string, parentId: string | null, content = "hello"): string => JSON.stringify({ type: "message", id, parentId, message: { role: "user", content: [{ type: "text", text: content }] } }) + "\n";
function fixture(fn: (f: ReturnType<typeof setup>) => void): void { const f = setup(); try { fn(f); } finally { rmSync(f.dir, { recursive: true, force: true }); } }
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "chrono-engine-")), source = join(dir, "source.jsonl");
  writeFileSync(source, "", { mode: 0o600 });
  const base = { v: 1, catalogDirectory: dir, sessionKey: "synthetic" };
  const metrics = { maxSourceBytes: 0, maxWireBytes: 0 };
  const request = (r: Record<string, unknown>) => {
    const response = executeCatalogRequest({ ...base, ...r });
    metrics.maxSourceBytes = Math.max(metrics.maxSourceBytes, response.sourceBytes);
    metrics.maxWireBytes = Math.max(metrics.maxWireBytes, Buffer.byteLength(JSON.stringify(response)));
    assert.ok(response.sourceBytes <= 8 * 1024 * 1024); assert.ok(metrics.maxWireBytes <= 256 * 1024);
    return response;
  };
  const ok = (r: Record<string, unknown>): Record<string, any> => { const response = request(r); assert.equal(response.ok, true, JSON.stringify(response)); return (response as { result: Record<string, any> }).result; };
  const ingest = (extra = {}) => ok({ op: "ingestStep", shardKey: "s1", branchKey: "main", shardOrdinal: 0, sourcePath: source, ...extra });
  const pin = (id: string, extra = {}): CatalogView => ok({ op: "pin", branchKey: "main", leaf: { shardKey: "s1", eventId: id }, ...extra }).view;
  const dbPath = join(dir, `catalog-${createHash("sha256").update("synthetic").digest("hex")}.sqlite`);
  return { dir, source, request, ok, ingest, pin, dbPath, metrics };
}
test("pure contract rejects oversized and invalid protocol without native loading", () => {
  assert.equal(isCatalogRequest({ v: 2 }), false);
  assert.equal(isCatalogRequest({ v: 1, catalogDirectory: "/tmp", sessionKey: "s", op: "status" }), true);
  assert.equal(isCatalogRequest({ v: 1, catalogDirectory: "/tmp", sessionKey: "../escape", op: "status" }), false);
});
test("initial append/noop, immutable fork pages, normalized blocks, exact bytes and private modes", () => fixture(f => {
  writeFileSync(f.source, line("a", null) + line("b", "a"));
  assert.equal(f.ingest().records, 2);
  const old = f.pin("b");
  appendFileSync(f.source, line("c", "a") + line("d", "c"));
  assert.equal(f.ingest().records, 2); assert.equal(f.ingest().records, 0);
  const oldPage = f.ok({ op: "page", view: old });
  assert.deepEqual(oldPage.events.map((e: any) => e.metadata.id), ["a", "b"]);
  const fork = f.pin("d"), first = f.ok({ op: "page", view: fork, limit: 1 });
  const second = f.ok({ op: "page", view: fork, after: first.after });
  assert.deepEqual([...first.events, ...second.events].map((e: any) => e.metadata.id), ["a", "c", "d"]);
  const blocks = f.ok({ op: "blocks", view: old, eventSeq: 1 });
  assert.equal(blocks.blocks.length, 2);
  const before = readFileSync(f.source);
  const raw = f.ok({ op: "raw", view: old, eventSeq: 1, offset: 0, length: line("a", null).length });
  assert.equal(Buffer.from(raw.data, "base64").toString(), line("a", null));
  assert.deepEqual(readFileSync(f.source), before);
  assert.equal(statSync(f.dir).mode & 0o777, 0o700);
  for (const name of readdirSync(f.dir)) assert.equal(statSync(join(f.dir, name)).mode & 0o777, 0o600);
}));
test("giant record resumes across fresh instances without committing incomplete tail", () => fixture(f => {
  const giant = line("giant", null, "x".repeat(9 * 1024 * 1024));
  writeFileSync(f.source, giant.slice(0, -1));
  let result: Record<string, any> = {};
  for (let i = 0; i < 100; i++) { result = f.ingest(); assert.equal(result.committed, 0); if (result.offset === giant.length - 1) break; }
  assert.equal(result.offset, giant.length - 1); assert.equal(result.incompleteTail, true);
  appendFileSync(f.source, "\n"); assert.equal(f.ingest().records, 1);
  assert.equal(f.ok({ op: "status", shardKey: "s1" }).records, 1);
  const blocks = f.ok({ op: "blocks", view: f.pin("giant"), eventSeq: 1 });
  assert.equal(blocks.blocks[1].metadata.decodedEnd, 9 * 1024 * 1024);
  const range = f.ok({ op: "raw", view: f.pin("giant"), eventSeq: 1, offset: 65537, length: 65536 });
  assert.equal(Buffer.from(range.data, "base64").toString(), "x".repeat(65536));
  const noop = f.request({ op: "ingestStep", shardKey: "s1", sourcePath: f.source, branchKey: "main", shardOrdinal: 0 });
  assert.equal(noop.ok, true); assert.ok(noop.sourceBytes <= 32768);
  console.log(`catalog giant metrics ${JSON.stringify({ ...f.metrics, noopSourceBytes: noop.sourceBytes })}`);
}));
test("malformed tail never skips and preserves earlier committed records", () => fixture(f => {
  writeFileSync(f.source, line("a", null) + '{"id":!}\n' + line("b", "a"));
  const result = f.ingest(); assert.equal(result.records, 1); assert.equal(typeof result.error, "string");
  assert.equal(f.ingest().records, 0);
  assert.deepEqual(f.ok({ op: "page", view: f.pin("a") }).events.map((e: any) => e.metadata.id), ["a"]);
}));
test("sampled anchors detect replace/truncate, selected spans detect unsampled mutation", () => fixture(f => {
  writeFileSync(f.source, line("a", null, "x".repeat(200000)));
  for (let i = 0; i < 20 && !f.ingest().caughtUp; i++) { /* bounded retry */ }
  const view = f.pin("a");
  const fd = openSync(f.source, "r+"); try { writeSync(fd, Buffer.from("y"), 0, 1, 100000); } finally { closeSync(fd); }
  assert.equal(f.ingest().records, 0); // honest sampled-anchor limitation
  assert.deepEqual(f.request({ op: "raw", view, eventSeq: 1, offset: 100000, length: 1 }).ok, false);
  assert.equal(f.request({ op: "integrityStep", shardKey: "s1" }).ok, false);
  renameSync(f.source, `${f.source}.old`); writeFileSync(f.source, readFileSync(`${f.source}.old`), { mode: 0o600 });
  assert.equal(f.request({ op: "ingestStep", shardKey: "s1", sourcePath: f.source, branchKey: "main", shardOrdinal: 0 }).ok, false);
}));
test("truncate and unsafe storage are controlled refusals", () => fixture(f => {
  writeFileSync(f.source, line("a", null)); f.ingest(); truncateSync(f.source, 0);
  assert.equal(f.request({ op: "ingestStep", shardKey: "s1", sourcePath: f.source, branchKey: "main", shardOrdinal: 0 }).ok, false);
  chmodSync(f.dbPath, 0o644); assert.equal(f.request({ op: "status" }).ok, false);
}));
test("duplicate IDs scoped to shard/session; ambiguous same-shard reference refuses", () => fixture(f => {
  writeFileSync(f.source, line("a", null)); f.ingest();
  const other = join(f.dir, "other.jsonl"); writeFileSync(other, line("a", null), { mode: 0o600 });
  f.ingest({ shardKey: "s2", shardOrdinal: 1, sourcePath: other });
  assert.equal(f.ok({ op: "pin", branchKey: "main", leaf: { shardKey: "s2", eventId: "a" } }).view.eventCut, 2);
  appendFileSync(other, line("a", null)); f.ingest({ shardKey: "s2", shardOrdinal: 1, sourcePath: other });
  assert.equal(f.request({ op: "pin", branchKey: "main", leaf: { shardKey: "s2", eventId: "a" } }).ok, false);
  assert.equal(f.ok({ op: "status", sessionKey: "other-session" }).generation, 1);
  assert.equal(f.request({ op: "page", sessionKey: "other-session", view: f.pin("a") }).ok, false);
}));
test("explicit crossshard ancestry and bounded restartable rebuild publication preserve old views", () => fixture(f => {
  writeFileSync(f.source, line("a", null)); f.ingest(); const old = f.pin("a");
  const other = join(f.dir, "other.jsonl"); writeFileSync(other, line("b", "a"), { mode: 0o600 });
  const declaration = { shardKey: "s2", shardOrdinal: 1, sourcePath: other, parent: { shardKey: "s1", eventId: "a" } };
  f.ingest(declaration);
  const view = f.ok({ op: "pin", branchKey: "main", leaf: { shardKey: "s2", eventId: "b" } }).view;
  assert.deepEqual(f.ok({ op: "page", view }).events.map((e: any) => e.metadata.id), ["a", "b"]);
  const rebuild = f.ok({ op: "rebuildStep", action: "start", rebuildKey: "try1" });
  assert.equal(f.ok({ op: "rebuildStep", action: "start", rebuildKey: "try1" }).generation, rebuild.generation);
  assert.equal(f.request({ op: "rebuildStep", action: "publish", generation: rebuild.generation, expectedShards: 2 }).ok, false);
  f.ingest({ generation: rebuild.generation }); f.ingest({ ...declaration, generation: rebuild.generation });
  f.ok({ op: "rebuildStep", action: "publish", generation: rebuild.generation, expectedShards: 2 });
  assert.equal(f.ok({ op: "status" }).generation, rebuild.generation);
  assert.deepEqual(f.ok({ op: "page", view: old }).events.map((e: any) => e.metadata.id), ["a"]);
}));
test("schema and checkpoint corruption refuse instead of implicit rebuilding", () => fixture(f => {
  writeFileSync(f.source, line("a", null)); f.ingest();
  let db = CatalogSqlite.open(f.dbPath); db.prepare("UPDATE shards SET checkpointHash='bad'").run(); db.close();
  assert.equal(f.request({ op: "ingestStep", shardKey: "s1", sourcePath: f.source, branchKey: "main", shardOrdinal: 0 }).ok, false);
  db = CatalogSqlite.open(f.dbPath); db.prepare("UPDATE meta SET version=99").run(); db.close();
  assert.equal(f.request({ op: "status" }).ok, false);
}));

test("real SIGKILL rolls back record/checkpoint and generation publication; retry is idempotent", () => fixture(f => {
  writeFileSync(f.source, line("a", null)); f.ingest();
  appendFileSync(f.source, line("b", "a"));
  const base = { v: 1, catalogDirectory: f.dir, sessionKey: "synthetic" };
  const killDuring = (operation: Record<string, unknown>, match: string) => {
    const script = `import {CatalogSqlite} from ${JSON.stringify(new URL("../src/catalog-sqlite.js", import.meta.url).href)};
      import {executeCatalogRequest} from ${JSON.stringify(new URL("../src/catalog-engine.js", import.meta.url).href)};
      const original=CatalogSqlite.prototype.prepare;
      CatalogSqlite.prototype.prepare=function(sql){const statement=original.call(this,sql); if(sql.startsWith(${JSON.stringify(match)})){const run=statement.run;statement.run=(...v)=>{const result=run(...v);process.kill(process.pid,'SIGKILL');return result;};}return statement;};
      executeCatalogRequest(${JSON.stringify({ ...base, ...operation })});`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15000 });
    assert.equal(child.signal, "SIGKILL", child.stderr);
  };
  killDuring({ op: "ingestStep", shardKey: "s1", sourcePath: f.source, branchKey: "main", shardOrdinal: 0 }, "INSERT INTO events");
  assert.equal(f.ok({ op: "status", shardKey: "s1" }).records, 1);
  assert.equal(f.ingest().records, 1); assert.equal(f.ingest().records, 0);
  const generation = f.ok({ op: "rebuildStep", action: "start", rebuildKey: "kill" }).generation;
  f.ingest({ generation });
  killDuring({ op: "rebuildStep", action: "publish", generation, expectedShards: 1 }, "UPDATE meta SET active=?");
  assert.equal(f.ok({ op: "status" }).generation, 1);
  f.ok({ op: "rebuildStep", action: "publish", generation, expectedShards: 1 });
  assert.equal(f.ok({ op: "status" }).generation, generation);
}));

test("concurrent writer has bounded busy refusal and caller retry succeeds", () => fixture(f => {
  writeFileSync(f.source, line("a", null)); f.ingest();
  const db = CatalogSqlite.open(f.dbPath);
  try {
    db.transaction(() => {
      db.prepare("UPDATE meta SET active=active").run();
      const script = `import {executeCatalogRequest} from ${JSON.stringify(new URL("../src/catalog-engine.js", import.meta.url).href)};console.log(JSON.stringify(executeCatalogRequest(${JSON.stringify({ v: 1, catalogDirectory: f.dir, sessionKey: "synthetic", op: "ingestStep", shardKey: "s1", sourcePath: f.source, branchKey: "main", shardOrdinal: 0 })})));`;
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15000 });
      assert.equal(child.status, 0, child.stderr); const response = JSON.parse(child.stdout);
      assert.equal(response.ok, false); assert.equal(response.code, "catalog-sqlite-busy");
    });
  } finally { db.close(); }
  assert.equal(f.ingest().records, 0);
}));

test("synthetic ENOSPC/EIO statement failures roll back committed data, not source", () => fixture(f => {
  writeFileSync(f.source, line("a", null)); f.ingest(); appendFileSync(f.source, line("b", "a"));
  const before = readFileSync(f.source), original = CatalogSqlite.prototype.prepare;
  for (const code of ["ENOSPC", "EIO"]) {
    CatalogSqlite.prototype.prepare = function(sql) {
      const statement = original.call(this, sql);
      if (sql.startsWith("INSERT INTO spans")) statement.run = () => { throw Object.assign(new Error("synthetic fault"), { code }); };
      return statement;
    };
    try { assert.equal(f.request({ op: "ingestStep", shardKey: "s1", sourcePath: f.source, branchKey: "main", shardOrdinal: 0 }).ok, false); }
    finally { CatalogSqlite.prototype.prepare = original; }
    assert.equal(f.ok({ op: "status", shardKey: "s1" }).records, 1);
    assert.deepEqual(readFileSync(f.source), before);
  }
  assert.equal(f.ingest().records, 1);
}));

test("deep fork ancestry refuses explicitly; block pages stay below wire ceiling", () => fixture(f => {
  let content = line("root", null), parent = "root";
  for (let i = 0; i < 65; i++) { content += line(`dummy${i}`, parent) + line(`chosen${i}`, parent); parent = `chosen${i}`; }
  writeFileSync(f.source, content);
  for (let i = 0; i < 30 && !f.ingest().caughtUp; i++) { /* cooperative job cuts */ }
  assert.equal(f.request({ op: "pin", branchKey: "main", leaf: { shardKey: "s1", eventId: "chosen64" } }).ok, false);
  assert.ok(f.pin("chosen60").segments.length <= 64);
  const blocks = Array.from({ length: 32 }, (_, i) => ({ type: "text", id: "\0".repeat(1024), name: "\0".repeat(1024), text: String(i) }));
  appendFileSync(f.source, JSON.stringify({ type: "message", id: "wide", parentId: "root", message: { role: "user", content: blocks } }) + "\n");
  for (let i = 0; i < 30 && !f.ingest().caughtUp; i++) { /* cooperative job cuts */ }
  const view = f.pin("wide"), seq = view.eventCut;
  let after = 0, count = 0;
  for (let i = 0; i < 100; i++) {
    const page = f.ok({ op: "blocks", view, eventSeq: seq, after });
    if (!page.blocks.length) break;
    count += page.blocks.length; after = page.after;
  }
  assert.equal(count, 64); assert.ok(f.metrics.maxWireBytes <= 256 * 1024);
}));

test("corrupt SQLite bytes never trigger source rewrite or implicit rebuild", () => fixture(f => {
  writeFileSync(f.source, line("a", null)); f.ingest(); const before = readFileSync(f.source);
  writeFileSync(f.dbPath, Buffer.from("not sqlite"));
  const response = f.request({ op: "status" });
  assert.equal(response.ok, false); assert.deepEqual(readFileSync(f.source), before);
}));

test("tool-result provenance resolves indexed ancestor calls and preserves surrogate identities", () => fixture(f => {
  const first = "\ud800", second = "\ud801";
  const call = { type: "message", id: first, parentId: null, message: { role: "assistant", content: [{ type: "toolCall", id: second, name: "history_read", arguments: {} }] } };
  const result = { type: "message", id: second, parentId: first, message: { role: "toolResult", toolCallId: second, content: [{ type: "text", text: "recalled synthetic material" }] } };
  writeFileSync(f.source, JSON.stringify(call) + "\n" + JSON.stringify(result) + "\n");
  f.ingest(); const view = f.pin(second), page = f.ok({ op: "page", view });
  assert.deepEqual(page.events.map((e: any) => e.metadata.id), [first, second]);
  assert.equal(page.events[1].metadata.toolName, "history_read");
  assert.equal(page.events[1].metadata.provenance, "generated");
  assert.deepEqual(page.events[1].metadata.toolCallSource, { shardKey: "s1", ordinal: 1, blockIndex: 0 });
  const descriptors = f.ok({ op: "blocks", view, eventSeq: 2 });
  assert.equal(descriptors.blocks[0].metadata.provenance, "generated");
}));

test("explicit new-directory recovery leaves corrupt store untouched and binds physical view identity", () => fixture(f => {
  writeFileSync(f.source, line("a", null)); f.ingest(); const oldView = f.pin("a");
  writeFileSync(f.dbPath, Buffer.from("corrupt old synthetic store")); const corrupt = readFileSync(f.dbPath);
  const catalogDirectory = join(f.dir, "new-root", "new-store");
  assert.equal(f.request({ op: "status", catalogDirectory }).ok, false);
  const generation = f.ok({ op: "rebuildStep", action: "start", rebuildKey: "recovery", catalogDirectory }).generation;
  f.ingest({ generation, catalogDirectory });
  f.ok({ op: "rebuildStep", action: "publish", generation, expectedShards: 1, catalogDirectory });
  assert.deepEqual(readFileSync(f.dbPath), corrupt);
  assert.equal(statSync(join(f.dir, "new-root")).mode & 0o777, 0o700);
  assert.equal(statSync(catalogDirectory).mode & 0o777, 0o700);
  assert.equal(f.request({ op: "page", catalogDirectory, view: oldView }).ok, false);
  const view = f.pin("a", { catalogDirectory });
  assert.notEqual(view.storeKey, oldView.storeKey);
  assert.equal(f.ok({ op: "page", catalogDirectory, view }).events[0].metadata.id, "a");
}));

test("engine explicitly refuses checkpoint metadata beyond its smaller supported cap", () => fixture(f => {
  writeFileSync(f.source, line("a", null)); f.ingest();
  const m = "\0".repeat(1024);
  appendFileSync(f.source, JSON.stringify({ type: "message", id: "wide-incomplete", parentId: "a", message: { role: "assistant", content: Array.from({ length: 128 }, () => ({ type: m, id: m, name: m, text: "", thinking: "" })) } }));
  let refused = false;
  for (let i = 0; i < 30; i++) {
    const response = f.request({ op: "ingestStep", shardKey: "s1", sourcePath: f.source, branchKey: "main", shardOrdinal: 0 });
    if (!response.ok) { assert.equal(response.code, "catalog-checkpoint-limit"); refused = true; break; }
  }
  assert.equal(refused, true); assert.equal(f.ok({ op: "status", shardKey: "s1" }).records, 1);
}));

test("scoped ordinal pins recover id-less roots and disambiguate duplicate source IDs", () => fixture(f => {
  const root = JSON.stringify({ type: "custom", customType: "synthetic", data: { note: "not retained" } }) + "\n";
  writeFileSync(f.source, root + line("duplicate", null) + line("duplicate", null)); f.ingest();
  const view = f.ok({ op: "pin", branchKey: "main", leaf: { shardKey: "s1", ordinal: 1 } }).view;
  const page = f.ok({ op: "page", view });
  assert.equal(page.events[0].metadata.id, undefined); assert.equal(page.events[0].ordinal, 1);
  assert.equal(Buffer.from(f.ok({ op: "raw", view, eventSeq: 1, offset: 0, length: root.length }).data, "base64").toString(), root);
  assert.equal(f.ok({ op: "pin", branchKey: "main", leaf: { shardKey: "s1", ordinal: 3 } }).view.eventCut, 3);
  assert.equal(f.request({ op: "pin", branchKey: "main", leaf: { shardKey: "s1", ordinal: 3, eventId: "duplicate" } }).ok, false);
}));
