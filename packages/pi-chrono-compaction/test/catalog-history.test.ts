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

test("explicit historical compaction beyond discovery window verifies branch and selected bytes", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { executeCatalogStoreRequest } = await import("../src/catalog-store.js");
  const { resolveCompositionEntry } = await import("../src/catalog-history.js");
  const directory = mkdtempSync(join(tmpdir(), "chrono-explicit-compaction-"));
  const sourcePath = join(directory, "source.jsonl"), catalogDirectory = join(directory, "catalog");
  const compaction = { type: "compaction", id: "target", parentId: "root", summary: "Keep the pending work.", firstKeptEntryId: "e0" };
  const entries: Record<string, unknown>[] = [
    { type: "message", id: "root", parentId: null, message: { role: "user", content: [{ type: "text", text: "Never deploy without approval." }] } },
    compaction, { ...compaction, id: "sibling", parentId: "root" },
  ];
  for (let index = 0; index < 300; index++) entries.push({ type: "message", id: `e${index}`, parentId: index ? `e${index - 1}` : "target",
    message: { role: "assistant", content: [{ type: "text", text: "Pending work remains." }] } });
  writeFileSync(sourcePath, entries.map(entry => JSON.stringify(entry) + "\n").join(""), { mode: 0o600 });
  let rawReads = 0;
  const execute: CatalogHistoryExecutor = async request => {
    if (request.op === "raw") rawReads++;
    const response = await executeCatalogStoreRequest(request);
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.result;
  };
  try {
    await execute({ v: 1, op: "ingestStep", catalogDirectory, sessionKey: "synthetic-session", shardKey: "shard", sourcePath, branchKey: "branch", shardOrdinal: 0 });
    const pinned = await execute({ v: 1, op: "pin", catalogDirectory, sessionKey: "synthetic-session", branchKey: "branch", leaf: { shardKey: "shard", eventId: "e299" } });
    const scope = { catalogDirectory, sessionKey: "synthetic-session", shardKey: "shard", view: pinned.view as CatalogHistoryScope["view"] };
    assert.ok(scope.view.eventCut > 256);
    assert.deepEqual(await resolveCompositionEntry(scope, "target", execute, compaction), compaction);
    const beforeSibling = rawReads;
    await assert.rejects(resolveCompositionEntry(scope, "sibling", execute), /catalog-history-scope-mismatch/);
    assert.equal(rawReads, beforeSibling, "sibling is refused before source bytes are read");
    await assert.rejects(resolveCompositionEntry(scope, "target", execute, { ...compaction, summary: "Changed summary" }), /composition-target-mismatch/);
    await assert.rejects(resolveCompositionEntry(scope, "e299", execute), /composition-target-mismatch/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
