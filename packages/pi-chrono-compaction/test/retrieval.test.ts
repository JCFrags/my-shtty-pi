import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { parseSessionJsonl, readSessionJsonl } from "../src/jsonl.js";
import { historyGet, historyRange, historySearch } from "../src/retrieval.js";

const fixture = resolve("test/fixtures/session.jsonl");

test("history_get returns exact source content and neighboring context", async () => {
  const session = await readSessionJsonl(fixture);
  const output = historyGet(session, "e124", { blockIndex: 0, contextBefore: 1, contextAfter: 1 });
  assert.match(output, /Exact block 0:/);
  assert.match(output, /AssertionError: expected activeRequests=1/);
  assert.match(output, /received activeRequests=3/);
  assert.match(output, /Use history_get\("e124"\) for exact record slices/);
  assert.match(output, /\* \[line 6\] e124 message/);
});

test("history_search locates omitted evidence in immutable JSONL", async () => {
  const session = await readSessionJsonl(fixture);
  const output = historySearch(session, "activeRequests", { limit: 10, contextChars: 90 });
  assert.match(output, /Matching entries: 2/);
  assert.match(output, /Returned matches 1–2/);
  assert.match(output, /\[e124 \| line 6 \| message\/toolResult\]/);
  assert.match(output, /\[e125 \| line 7 \| message\/assistant\]/);
});

test("history_range follows the exact parent-chain sequence and supports continuation", async () => {
  const session = await readSessionJsonl(fixture);
  const output = historyRange(session, "e120", "e124");
  assert.match(output, /Bounded JSONL range/);
  assert.match(output, /Traversal: parent-chain chronological path/);
  for (const id of ["e120", "e121", "e123"]) assert.match(output, new RegExp(`\\"id\\":\\"${id}\\"`));
  assert.match(output, /\[e122 \| JSONL line 4 has/);
  assert.match(output, /Continue with history_range\("e124", "e124"\)/);
  assert.doesNotMatch(output, /\"id\":\"e125\"/);

  const capped = historyRange(session, "e120", "e124", { maxEntries: 3 });
  assert.match(capped, /Returned entries: 3/);
  assert.match(capped, /Continue with history_range\("e123", "e124"\)/);
});

test("history retrieval stays below the Pi tool-output limit and provides continuation", () => {
  const entries = [
    {
      type: "message",
      id: "large",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "needle " + "x".repeat(100_000) }] },
    },
    ...Array.from({ length: 30 }, (_, index) => ({
      type: "message",
      id: `entry-${index}`,
      parentId: index === 0 ? "large" : `entry-${index - 1}`,
      message: { role: "user", content: [{ type: "text", text: `needle result ${index} ${"y".repeat(600)}` }] },
    })),
  ];
  const text = [
    JSON.stringify({ type: "session", version: 3 }),
    ...entries.map((entry) => JSON.stringify(entry)),
  ].join("\n");
  const session = parseSessionJsonl(text);

  const getOutput = historyGet(session, "large", { maxChars: 500_000 });
  assert.ok(new TextEncoder().encode(getOutput).byteLength < 50_000);
  assert.match(getOutput, /Continue exact retrieval: history_get\("large", startChar=12000/);

  const searchOutput = historySearch(session, "needle", { limit: 200, contextChars: 2_000 });
  assert.ok(new TextEncoder().encode(searchOutput).byteLength < 50_000);
  assert.match(searchOutput, /Continue search: history_search with startMatch=20/);

  const rangeOutput = historyRange(session, "large", "entry-29", { maxEntries: 2_000 });
  assert.ok(new TextEncoder().encode(rangeOutput).byteLength < 50_000);
  assert.match(rangeOutput, /Use history_get\("large"\) for exact slices/);
  assert.match(rangeOutput, /Range output reached a safety limit/);
});
