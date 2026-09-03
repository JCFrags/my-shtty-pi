import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { getActiveBranch, getSourceEntriesBefore, parseSessionJsonl, SessionFormatError } from "../src/jsonl.js";

const fixture = resolve("test/fixtures/session.jsonl");

test("parses Pi JSONL and reconstructs the active parent chain", async () => {
  const text = await readFile(fixture, "utf8");
  const session = parseSessionJsonl(text, fixture);
  const branch = getActiveBranch(session);
  assert.equal(session.header.version, 3);
  assert.equal(branch[0]?.id, "e120");
  assert.equal(branch.at(-1)?.id, "e134");
  assert.equal(branch.length, 15);
  assert.equal(session.recordById.get("e124")?.rawLine.includes("activeRequests=3"), true);

  const before = getSourceEntriesBefore(branch, "e133");
  assert.equal(before.at(-1)?.id, "e132");
  assert.equal(before.some((entry) => entry.id === "e133"), false);
});

test("rejects missing parents, duplicate IDs, and cycles", () => {
  const header = JSON.stringify({ type: "session", version: 3 });
  assert.throws(
    () => parseSessionJsonl(`${header}\n${JSON.stringify({ type: "message", id: "x", parentId: "missing" })}\n`),
    (error: unknown) => error instanceof SessionFormatError && /missing parent/.test(error.message),
  );
  assert.throws(
    () =>
      parseSessionJsonl(
        `${header}\n${JSON.stringify({ type: "message", id: "x", parentId: null })}\n${JSON.stringify({ type: "message", id: "x", parentId: null })}\n`,
      ),
    /Duplicate entry id/,
  );
  assert.throws(
    () =>
      parseSessionJsonl(
        `${header}\n${JSON.stringify({ type: "message", id: "a", parentId: "b" })}\n${JSON.stringify({ type: "message", id: "b", parentId: "a" })}\n`,
      ),
    /Cycle detected/,
  );
});
