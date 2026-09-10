import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCatalogHistory, readCatalogHistoryPage, type CatalogHistoryExecutor, type CatalogHistoryScope } from "../src/catalog-history.js";
import type { CatalogEvent } from "../src/catalog-contract.js";

test("indexed exact recovery scopes IDs before byte reads and preserves split UTF-8 bytes", async () => {
  const scope: CatalogHistoryScope = { catalogDirectory: "/synthetic/catalog", sessionKey: "session", shardKey: "shard", view: { storeKey: "store", sessionKey: "session", generation: 1, branchKey: "branch", eventCut: 3, segments: [{ segment: 1, cut: 3 }] } };
  const bytes = Buffer.from('{"text":"😀"}\n');
  const event: CatalogEvent = { seq: 2, shardKey: "shard", branchKey: "branch", ordinal: 2, rawStart: 100, rawEnd: 100 + bytes.length - 1, endByte: 100 + bytes.length, metadata: { id: "entry" } };
  let sibling = false, reads = 0;
  const execute: CatalogHistoryExecutor = async request => {
    if (request.op === "pin") return { view: { ...scope.view, eventCut: 2 } };
    if (request.op === "page") { assert.equal(request.view, scope.view); assert.equal(request.after, 1); assert.equal(request.limit, 1); return { events: sibling ? [{ ...event, seq: 3 }] : [event] }; }
    assert.equal(request.op, "raw");
    if (request.op !== "raw") throw new Error("unexpected request");
    reads++; assert.equal(request.view, scope.view);
    return { offset: request.offset, length: request.length, encoding: "base64", data: bytes.subarray(request.offset - 100, request.offset - 100 + request.length).toString("base64") };
  };
  assert.equal(await resolveCatalogHistory(scope, "entry", execute), event);
  const recovered: Buffer[] = [];
  let offset = event.rawStart;
  for (;;) {
    const page = await readCatalogHistoryPage(scope, event, execute, offset, 2);
    recovered.push(Buffer.from(String(page.data), "base64"));
    if (page.complete) break;
    offset = Number(page.nextByte);
  }
  assert.deepEqual(Buffer.concat(recovered), bytes);
  const priorReads = reads;
  sibling = true;
  await assert.rejects(resolveCatalogHistory(scope, "sibling", execute), /catalog-history-scope-mismatch/);
  await assert.rejects(readCatalogHistoryPage(scope, event, execute, 99), /catalog-history-range-invalid/);
  assert.equal(reads, priorReads);
});
