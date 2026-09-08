import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, openSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { executeCatalogRequest } from "../src/catalog-engine.js";
import { CatalogSource, type CatalogSourceSnapshot } from "../src/catalog-source.js";
import { CatalogSqlite } from "../src/catalog-sqlite.js";

const line = (id: string, parentId: string | null, length: number) => JSON.stringify({ type: "message", id, parentId, message: { role: "user", content: [{ type: "text", text: "x".repeat(length) }] } }) + "\n";
function patchByte(path: string, offset: number, byte: string): void {
  const fd = openSync(path, "r+");
  try { writeSync(fd, Buffer.from(byte), 0, 1, offset); } finally { closeSync(fd); }
}
// Inspect the actual controlled native SQLite database, not a mock transaction.
// Compare all ingestion-owned rows, including parser state/hash and source evidence.
function databaseState(path: string): unknown {
  const db = CatalogSqlite.open(path);
  try {
    return ["shards", "spans", "events", "segments", "blocks", "tool_calls"].map(table =>
      [...db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate(1024)]);
  } finally { db.close(); }
}
for (const scenario of ["verified-first", "capture-old-tail", "capture-new-tail", "small-overlap", "giant-old-tail", "giant-new-tail"] as const) {
  test(`engine/native DB handoff rollback: ${scenario}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "chrono-handoff-")), path = join(dir, "synthetic.jsonl");
    const dbPath = join(dir, `catalog-${createHash("sha256").update("synthetic").digest("hex")}.sqlite`);
    const base = { v: 1, catalogDirectory: dir, sessionKey: "synthetic" };
    const ingestRequest = { op: "ingestStep", shardKey: "s", branchKey: "main", shardOrdinal: 0, sourcePath: path };
    let maxBytes = 0;
    const request = (r: Record<string, unknown>) => {
      const result = executeCatalogRequest({ ...base, ...r });
      maxBytes = Math.max(maxBytes, result.sourceBytes);
      assert.ok(result.sourceBytes <= 8 * 1024 * 1024);
      return result;
    };
    const ok = (r: Record<string, unknown>): Record<string, any> => {
      const result = request(r); assert.equal(result.ok, true, JSON.stringify(result));
      return (result as { result: Record<string, any> }).result;
    };
    const giant = scenario.startsWith("giant");
    const initial = line("a", null, giant ? 9 * 1024 * 1024 : scenario === "small-overlap" ? 8000 : 200000);
    const verify = CatalogSource.prototype.verify, snapshot = CatalogSource.prototype.snapshot, read = CatalogSource.prototype.read;
    let fired = false, capturing = false, oldSize = 0, changedOffset = 0;
    try {
      writeFileSync(path, initial, { mode: 0o600 });
      const initialResult = ok(ingestRequest);
      if (giant) {
        assert.equal(initialResult.records, 0); assert.equal(initialResult.committed, 0);
        assert.ok(initialResult.offset > 32768 && initialResult.offset <= 7 * 1024 * 1024);
      } else assert.equal(initialResult.records, 1);
      oldSize = initialResult.offset;
      if (!giant) appendFileSync(path, line("b", "a", scenario === "small-overlap" ? 12000 : 1000));
      const before = databaseState(dbPath);
      const change = (offset: number) => { fired = true; changedOffset = offset; patchByte(path, offset, "y"); };
      CatalogSource.prototype.verify = function(saved: CatalogSourceSnapshot): void {
        verify.call(this, saved);
        if (scenario === "verified-first") change(150);
      };
      CatalogSource.prototype.snapshot = function(size?: number): CatalogSourceSnapshot {
        capturing = true;
        try { return snapshot.call(this, size); } finally { capturing = false; }
      };
      CatalogSource.prototype.read = function(offset: number, length: number): Buffer {
        // These hooks run only during candidate capture, after ingestion accepted
        // and hashed its buffers. Mutate a new tail BEFORE its verifying read.
        if (capturing && !fired && (scenario === "capture-new-tail" || scenario === "giant-new-tail") && offset > 0) change(offset + length - 100);
        const bytes = read.call(this, offset, length);
        // Mutate retiring old evidence AFTER the candidate read. Old/new tail
        // windows overlap on the small append but this byte has just retired.
        if (capturing && !fired && scenario !== "verified-first" && !scenario.endsWith("new-tail")) {
          if (scenario === "small-overlap" && offset === 0) change(150);
          else if (offset > 0) change(oldSize - 16384);
        }
        return bytes;
      };
      const refused = request(ingestRequest);
      assert.equal(fired, true, "deterministic mutation seam reached");
      assert.equal(refused.ok, false);
      assert.equal((refused as { code: string }).code, "catalog-source-changed");
      assert.deepEqual(databaseState(dbPath), before, "all record/span/parser/checkpoint writes rolled back");
      CatalogSource.prototype.verify = verify; CatalogSource.prototype.snapshot = snapshot; CatalogSource.prototype.read = read;
      patchByte(path, changedOffset, "x");
      let finished: Record<string, any> = {};
      for (let i = 0; i < 20; i++) { finished = ok(ingestRequest); if (finished.caughtUp) break; }
      assert.equal(finished.caughtUp, true);
      const leaf = giant ? "a" : "b";
      const view = ok({ op: "pin", branchKey: "main", leaf: { shardKey: "s", eventId: leaf } }).view;
      const page = ok({ op: "page", view });
      assert.deepEqual(page.events.map((event: any) => event.metadata.id), giant ? ["a"] : ["a", "b"]);
      const raw = ok({ op: "raw", view, eventSeq: 1, offset: 150, length: 32 });
      assert.equal(Buffer.from(raw.data, "base64").toString(), initial.slice(150, 182));
      const next = line("c", leaf, 500); appendFileSync(path, next);
      assert.equal(ok(ingestRequest).records, 1);
      const latest = ok({ op: "pin", branchKey: "main", leaf: { shardKey: "s", eventId: "c" } }).view;
      const last = ok({ op: "page", view: latest }).events.at(-1);
      const exact = ok({ op: "raw", view: latest, eventSeq: last.seq, offset: last.rawStart, length: next.length });
      assert.equal(Buffer.from(exact.data, "base64").toString(), next);
      console.log(`handoff ${scenario} maxSourceBytes=${maxBytes}`);
    } finally {
      CatalogSource.prototype.verify = verify; CatalogSource.prototype.snapshot = snapshot; CatalogSource.prototype.read = read;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
