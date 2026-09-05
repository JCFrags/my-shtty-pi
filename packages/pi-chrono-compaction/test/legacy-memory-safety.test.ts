import { appendFile, mkdtemp, rename, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension, { historySearchIndexCacheStatus, SEARCH_INDEX_SOURCE_MAX_BYTES } from "../src/pi-extension.js";
import { parseBranchEntries, readBoundedSessionJsonl } from "../src/jsonl.js";
import { buildLocalSearchIndex, MAX_SEARCH_RESULT_CACHE_ENTRIES, searchLocalHistory, searchResultCacheStatus } from "../src/search-index.js";

function sessionText(payload = "bounded synthetic payload"): string {
  return [
    { type: "session", version: 3, id: "bounded-memory" },
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: payload } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
}

async function temporary(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "chrono-memory-safety-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("bounded session read never follows growth beyond the admitted checkpoint", async (t) => {
  const directory = await temporary(t);
  const path = join(directory, "session.jsonl");
  const initial = sessionText("x".repeat(2048));
  await writeFile(path, initial, { mode: 0o600 });
  let requested = 0;
  let observed = 0;
  await assert.rejects(readBoundedSessionJsonl(path, Buffer.byteLength(initial) + 16, {
    async afterOpened() { await appendFile(path, "y".repeat(4096)); },
    onRead(requestedBytes, bytesRead) { requested += requestedBytes; observed += bytesRead; },
  }), /history-source-changed/);
  assert.equal(requested, Buffer.byteLength(initial));
  assert.equal(observed, Buffer.byteLength(initial));
});

test("bounded session read rejects oversize, replacement, truncation, and short reads before parsing changed bytes", async (t) => {
  const directory = await temporary(t);
  const path = join(directory, "session.jsonl");
  const replacement = join(directory, "replacement.jsonl");
  const initial = sessionText("z".repeat(1024));
  await writeFile(path, initial, { mode: 0o600 });
  let reads = 0;
  await assert.rejects(readBoundedSessionJsonl(path, Buffer.byteLength(initial) - 1, { onRead() { reads += 1; } }), /history-source-too-large/);
  assert.equal(reads, 0);

  await writeFile(replacement, sessionText("r".repeat(1024)), { mode: 0o600 });
  await assert.rejects(readBoundedSessionJsonl(path, Buffer.byteLength(initial), {
    async afterOpened() { await rename(replacement, path); },
  }), /history-source-changed/);

  await writeFile(path, initial, { mode: 0o600 });
  await assert.rejects(readBoundedSessionJsonl(path, Buffer.byteLength(initial), {
    async afterOpened() { await truncate(path, 32); },
  }), /history-source-changed/);
});

test("bounded session read accepts an unchanged file exactly at the limit", async (t) => {
  const directory = await temporary(t);
  const path = join(directory, "session.jsonl");
  const text = sessionText("exact-limit");
  await writeFile(path, text, { mode: 0o600 });
  const result = await readBoundedSessionJsonl(path, Buffer.byteLength(text));
  assert.equal(result.bytesRead, Buffer.byteLength(text));
  assert.equal(result.source.size, Buffer.byteLength(text));
  assert.equal(result.session.entries.length, 1);
});

test("ranked search and recall refuse a valid source above conservative index admission before building", async (t) => {
  const directory = await temporary(t);
  const path = join(directory, "session.jsonl");
  const payload = "term ".repeat(Math.ceil((SEARCH_INDEX_SOURCE_MAX_BYTES + 4096) / 5));
  await writeFile(path, sessionText(payload), { mode: 0o600 });
  const tools = new Map<string, (...args: any[]) => Promise<any>>();
  const pi = { registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) { tools.set(tool.name, tool.execute); }, registerCommand() {}, on() {}, appendEntry() {}, sendMessage() {} };
  extension(pi as unknown as ExtensionAPI);
  const context = { hasUI: false, model: undefined, thinkingLevel: "medium", sessionManager: { getSessionFile: () => path, getEntries: () => [], getBranch: () => [] }, getContextUsage: () => undefined, isIdle: () => true, abort() {}, compact() {}, ui: { notify() {} }, modelRegistry: {} };
  const search = tools.get("history_search"), recall = tools.get("history_recall");
  assert.ok(search && recall);
  const before = historySearchIndexCacheStatus();
  const searched = await search("search", { query: "term", mode: "ranked" }, undefined, undefined, context);
  const recalled = await recall("recall", { query: "term" }, undefined, undefined, context);
  const after = historySearchIndexCacheStatus();
  assert.equal(searched.details.code, "history-index-memory-limit");
  assert.equal(recalled.details.code, "history-index-memory-limit");
  assert.equal(searched.details.maximumBytes, SEARCH_INDEX_SOURCE_MAX_BYTES);
  assert.equal(after.builds, before.builds);
  assert.equal(after.pendingEntries, 0);
  assert.equal(after.pendingBytes, 0);
});

test("per-index query results use a bounded LRU cache", () => {
  const entries = [{ type: "message", id: "u1", parentId: null, message: { role: "user", content: "alpha beta gamma" } }];
  const index = buildLocalSearchIndex(parseBranchEntries(entries));
  for (let value = 0; value <= MAX_SEARCH_RESULT_CACHE_ENTRIES; value += 1) searchLocalHistory(index, `absent-${value}`);
  const full = searchResultCacheStatus(index);
  assert.deepEqual(full, { entries: MAX_SEARCH_RESULT_CACHE_ENTRIES, limit: MAX_SEARCH_RESULT_CACHE_ENTRIES });
  assert.equal(searchLocalHistory(index, "absent-0").cacheHit, false);
  assert.equal(searchLocalHistory(index, `absent-${MAX_SEARCH_RESULT_CACHE_ENTRIES}`).cacheHit, true);
});
