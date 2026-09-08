import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { createCatalogParserState, parseCatalogChunk, type CatalogRecordMetadata } from "../src/catalog-parser.js";
import { executeCatalogRequest } from "../src/catalog-engine.js";

const registeredNames = ["history_get", "history_search", "history_recall", "history_range"];
// This history-prefixed tool records advisory metadata; it does not retrieve history.
const nonRetrievalNames = ["history_retention_hint"];
const compatibilityAliases = ["history_read"];
const retrievalNames = [...registeredNames, ...compatibilityAliases];
const line = (id: string, parentId: string | null, message: Record<string, unknown>) =>
  JSON.stringify({ type: "message", id, parentId, message }) + "\n";
const text = (value = "synthetic recalled payload: history_get is not a content classifier") => ({ type: "text", text: value });
const call = (name: string, id = "call") => ({ type: "toolCall", id, name, arguments: { entryId: "historical-source" } });
function parse(raw: string, split?: number): CatalogRecordMetadata {
  const bytes = Buffer.from(raw);
  let state = createCatalogParserState();
  if (split !== undefined) {
    const first = parseCatalogChunk(state, bytes.subarray(0, split));
    assert.equal(first.error, undefined);
    assert.equal(first.records.length, 0);
    state = JSON.parse(JSON.stringify(first.state));
  }
  const result = parseCatalogChunk(state, bytes.subarray(split ?? 0));
  assert.equal(result.error, undefined);
  assert.equal(result.records.length, 1);
  return result.records[0]!;
}

// Inspect actual registerTool calls without loading an extension, reading user
// configuration, starting workers, or changing activation. This fails if the
// registered history contract changes without corresponding provenance coverage.
test("provenance cases cover every actual registered history tool", () => {
  const source = ts.createSourceFile("pi-extension.ts", readFileSync(new URL("../../src/pi-extension.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const inspect = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(source) === "pi" && node.expression.name.text === "registerTool") {
      const definition = node.arguments[0];
      assert.ok(definition && ts.isObjectLiteralExpression(definition));
      const name = definition.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(source) === "name");
      assert.ok(name && ts.isPropertyAssignment(name) && ts.isStringLiteral(name.initializer));
      if (name.initializer.text.startsWith("history_")) names.push(name.initializer.text);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  assert.deepEqual(names.sort(), [...registeredNames, ...nonRetrievalNames].sort());
});

for (const name of retrievalNames) {
  test(`parser structurally classifies ${name}, preserves mixed blocks and resumes checkpoints`, () => {
    const raw = line("mixed", null, { role: "assistant", content: [text("Current independent prose."), call(name)] });
    const expected = parse(raw);
    assert.equal(expected.provenance, "mixed");
    assert.deepEqual(expected.blocks.map(b => b.provenance), ["original", "generated"]);
    assert.equal(expected.blocks[1]!.name, name);
    assert.equal(expected.endByte, Buffer.byteLength(raw));
    const split = raw.indexOf(name) + 3;
    assert.deepEqual(parse(raw, split), expected);
    assert.deepEqual(parse(raw, Buffer.byteLength(raw) - 1), expected); // restart before committing LF
    assert.equal(parse(line("call-only", null, { role: "assistant", content: [call(name)] })).provenance, "generated");
    for (const content of [[text(), { type: "image", data: "c3ludGhldGlj" }], "synthetic exact old JSONL"]) {
      const result = parse(line("result", "mixed", { role: "toolResult", toolCallId: "call", toolName: name, content }));
      assert.equal(result.provenance, "generated");
      assert.ok(result.blocks.every(b => b.provenance === "generated"));
    }
  });
}

test("payload keywords, unregistered names and non-call blocks never imply retrieval provenance", () => {
  for (const name of [...nonRetrievalNames, "bash", "history_get_extra", "history_delete", "History_get", "functions.history_get", ""]) {
    const r = parse(line("ordinary", null, { role: "assistant", content: [text(), call(name)] }));
    assert.equal(r.provenance, "original");
    assert.ok(r.blocks.every(b => b.provenance === "original"));
    assert.equal(parse(line("ordinary-result", "ordinary", { role: "toolResult", toolName: name, content: [text()] })).provenance, "original");
  }
  assert.equal(parse(line("user", null, { role: "user", content: [text(), call("history_get")] })).provenance, "original");
  assert.equal(parse(line("not-call", null, { role: "assistant", content: [{ type: "text", name: "history_get", text: "history_recall" }] })).provenance, "original");
  // Only the engine has indexed ancestry. The parser must not guess this join.
  assert.equal(parse(line("unresolved", null, { role: "toolResult", toolCallId: "history_get", content: [text()] })).provenance, "original");
});

function fixture(fn: (f: ReturnType<typeof setup>) => void): void {
  const f = setup();
  try { fn(f); } finally { rmSync(f.dir, { recursive: true, force: true }); }
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "chrono-history-provenance-"));
  const source = join(dir, "synthetic.jsonl");
  writeFileSync(source, "", { mode: 0o600 });
  const base = { v: 1, catalogDirectory: dir, sessionKey: "synthetic" };
  const ingestRequest = { op: "ingestStep", shardKey: "s1", branchKey: "main", shardOrdinal: 0, sourcePath: source };
  const request = (r: Record<string, unknown>) => executeCatalogRequest({ ...base, ...r });
  const ok = (r: Record<string, unknown>): Record<string, any> => {
    const response = request(r);
    assert.equal(response.ok, true, JSON.stringify(response));
    return (response as { result: Record<string, any> }).result;
  };
  const ingest = () => ok(ingestRequest);
  const restartIngest = () => {
    const script = `import {executeCatalogRequest} from ${JSON.stringify(new URL("../src/catalog-engine.js", import.meta.url).href)};console.log(JSON.stringify(executeCatalogRequest(${JSON.stringify({ ...base, ...ingestRequest })})));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15000 });
    assert.equal(child.status, 0, child.stderr);
    const response = JSON.parse(child.stdout);
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.result as Record<string, any>;
  };
  const pin = (eventId: string) => ok({ op: "pin", branchKey: "main", leaf: { shardKey: "s1", eventId } }).view;
  return { dir, source, request, ok, ingest, restartIngest, pin };
}

for (const name of retrievalNames) {
  test(`native engine retains ${name} chronology/raw bytes without independent original payload, across restart and forks`, () => fixture(f => {
    const root = line("root", null, { role: "user", content: [text("Original source: synthetic fact Ω.")] });
    const mixed = line("mixed", "root", { role: "assistant", content: [text("I will recall the old source."), call(name)] });
    writeFileSync(f.source, root + mixed);
    assert.equal(f.ingest().records, 2);
    const old = f.pin("mixed");
    const inferred = line("inferred", "mixed", { role: "toolResult", toolCallId: "call", content: [text("Original source: synthetic fact Ω.")] });
    appendFileSync(f.source, inferred.slice(0, -1));
    assert.equal(f.ingest().records, 0); // unfinished result checkpoint persisted
    appendFileSync(f.source, "\n");
    assert.equal(f.restartIngest().records, 1); // no lifetime call map or parser state
    const explicit = line("explicit", "inferred", { role: "toolResult", toolName: name, toolCallId: "explicit-call", content: "Original source: synthetic fact Ω." });
    appendFileSync(f.source, explicit);
    assert.equal(f.ingest().records, 1);
    const view = f.pin("explicit");
    const events = f.ok({ op: "page", view }).events;
    assert.deepEqual(events.map((e: any) => e.metadata.id), ["root", "mixed", "inferred", "explicit"]);
    assert.deepEqual(events.map((e: any) => e.metadata.provenance), ["original", "mixed", "generated", "generated"]);
    assert.equal(events[2].metadata.toolName, name);
    assert.deepEqual(events[2].metadata.toolCallSource, { shardKey: "s1", ordinal: 2, blockIndex: 1 });
    const mixedBlocks = f.ok({ op: "blocks", view, eventSeq: events[1].seq }).blocks;
    assert.deepEqual(mixedBlocks.map((b: any) => b.metadata.provenance), ["original", "original", "generated"]);
    for (const event of events.slice(2)) {
      const descriptors = f.ok({ op: "blocks", view, eventSeq: event.seq }).blocks;
      assert.ok(descriptors.length > 0);
      assert.ok(descriptors.every((b: any) => b.metadata.provenance === "generated"));
    }
    const archive = Buffer.from(root + mixed + inferred + explicit);
    for (const event of events) {
      const { rawStart, endByte } = event.metadata;
      const raw = f.ok({ op: "raw", view, eventSeq: event.seq, offset: rawStart, length: endByte - rawStart });
      assert.deepEqual(Buffer.from(raw.data, "base64"), archive.subarray(rawStart, endByte));
    }
    assert.deepEqual(readFileSync(f.source), archive);

    // Reuse the call ID on a sibling branch for a non-retrieval call. The join
    // must use this block, not the generated call in the other branch.
    appendFileSync(f.source, line("fork", "root", { role: "assistant", content: [call("history_retention_hint")] })
      + line("fork-result", "fork", { role: "toolResult", toolCallId: "call", content: [text()] }));
    assert.equal(f.restartIngest().records, 2);
    const fork = f.pin("fork-result");
    const forkEvents = f.ok({ op: "page", view: fork }).events;
    assert.deepEqual(forkEvents.map((e: any) => e.metadata.id), ["root", "fork", "fork-result"]);
    assert.equal(forkEvents[2].metadata.toolName, "history_retention_hint");
    assert.equal(forkEvents[2].metadata.provenance, "original");
    assert.deepEqual(forkEvents[2].metadata.toolCallSource, { shardKey: "s1", ordinal: 5, blockIndex: 0 });
    assert.ok(f.ok({ op: "blocks", view: fork, eventSeq: forkEvents[2].seq }).blocks.every((b: any) => b.metadata.provenance === "original"));
    assert.deepEqual(f.ok({ op: "page", view: old }).events.map((e: any) => e.metadata.id), ["root", "mixed"]);
    assert.deepEqual(f.ok({ op: "page", view }).events, events);
    assert.equal(f.request({ op: "blocks", view: fork, eventSeq: events[2].seq }).ok, false);
    assert.equal(f.request({ op: "page", sessionKey: "other-session", view }).ok, false);

    // A result at the root cut cannot reach either descendant's call ID.
    appendFileSync(f.source, line("unlinked", "root", { role: "toolResult", toolCallId: "call", content: [text()] }));
    const refusal = f.request({ op: "ingestStep", shardKey: "s1", branchKey: "main", shardOrdinal: 0, sourcePath: f.source });
    assert.equal(refusal.ok, false);
    if (!refusal.ok) assert.equal(refusal.code, "catalog-tool-call-missing");
  }));
}
