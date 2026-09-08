import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createCatalogParserState, parseCatalogChunk, CATALOG_PARSER_LIMITS, type CatalogParserState, type CatalogRecordMetadata } from "../src/catalog-parser.js";
import { CATALOG_HASH_CARRY_BYTES, CATALOG_TEXT_HASH } from "../src/catalog-parser-hash.js";

function stream(bytes: Uint8Array, size: number | (() => number), restore = true) {
  let state = createCatalogParserState();
  const records: CatalogRecordMetadata[] = [];
  let maxState = 0;
  for (let at = 0; at < bytes.length;) {
    const end = Math.min(bytes.length, at + (typeof size === "number" ? size : size()));
    const r = parseCatalogChunk(state, bytes.subarray(at, end), 3);
    records.push(...r.records);
    at += r.consumedBytes;
    const json = JSON.stringify(r.state);
    maxState = Math.max(maxState, json.length);
    state = restore ? JSON.parse(json) as CatalogParserState : r.state;
    if (r.error) return { state, records, error: r.error, maxState };
    assert.ok(r.consumedBytes > 0);
  }
  return { state, records, error: state.error, maxState };
}
function referenceHash(text: string) {
  const domain = "chrono/catalog/decoded/v1\0";
  let h = createHash("sha256").update(domain + "seed").digest();
  const bytes = Buffer.from(text, "utf16le");
  for (let n = 0; n < bytes.length; n += 2048) {
    h = createHash("sha256").update(domain + "leaf\0").update(h).update(bytes.subarray(n, n + 2048)).digest();
  }
  return createHash("sha256").update(domain + "end\0").update(h).update(String(text.length)).digest("hex");
}
const jsonl = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");

test("structural Pi header, branch, message and block metadata survive every byte boundary", () => {
  const text = 'é😀中\\\"\n\t' + String.fromCharCode(0xd800) + "x" + String.fromCharCode(0xdc00);
  const values = [
    { type: "session", version: 3, id: "session-id", timestamp: "date", cwd: "/synthetic", parentSession: "/synthetic/parent.jsonl" },
    { type: "message", id: "u", parentId: null, timestamp: "date", message: { role: "user", content: text, timestamp: 123 } },
    { type: "message", id: "a", parentId: "u", timestamp: "date", message: { role: "assistant", content: [
      { type: "text", text }, { type: "thinking", thinking: "plan" },
      { type: "toolCall", id: "pair", name: "read", arguments: { id: "WRONG", name: "history_search", type: "compaction", text: "ignored" } },
    ] } },
    { type: "message", id: "r", parentId: "a", message: { role: "toolResult", toolCallId: "pair", toolName: "read", content: [{ type: "text", text }] } },
    { type: "branch_summary", id: "b", parentId: "r", fromId: "a", summary: text },
    { type: "compaction", id: "c", parentId: "b", firstKeptEntryId: "a", summary: text },
  ];
  const bytes = Buffer.concat(values.map(jsonl));
  const expected = stream(bytes, bytes.length).records;
  for (const size of [1, 2, 3, 7, 31, 2047]) assert.deepEqual(stream(bytes, size).records, expected);
  let seed = 3;
  assert.deepEqual(stream(bytes, () => { seed = (seed * 1664525 + 1013904223) >>> 0; return 1 + seed % 71; }).records, expected);
  assert.equal(expected[0]!.parentSession, "/synthetic/parent.jsonl");
  assert.equal(expected[1]!.messageTimestamp, 123);
  assert.equal(expected[1]!.bodies[0]!.decodedEnd, text.length);
  assert.equal(expected[1]!.bodies[0]!.hash, referenceHash(text));
  assert.equal(expected[2]!.blocks[2]!.id, "pair");
  assert.equal(expected[2]!.blocks[2]!.name, "read");
  assert.equal(expected[3]!.toolCallId, "pair");
  assert.equal(expected[4]!.fromId, "a");
  assert.equal(expected[4]!.provenance, "generated");
  assert.equal(expected[5]!.firstKeptEntryId, "a");
  for (const record of expected) {
    assert.equal(bytes[record.endByte - 1], 10);
    assert.equal(record.rawEnd, record.endByte - 1);
    for (const desc of [...record.bodies, ...record.blocks.flatMap(b => b.bodies)]) {
      const decoded: unknown = JSON.parse(bytes.subarray(desc.rawStart, desc.rawEnd).toString());
      assert.equal(typeof decoded, "string");
      assert.equal(desc.decodedEnd, (decoded as string).length);
      assert.equal(desc.hashAlgorithm, CATALOG_TEXT_HASH);
      assert.equal(desc.hash, referenceHash(decoded as string));
    }
  }
});

test("hash leaves are ingestion-independent, preserve escaped/literal code units and empty/lone surrogates", () => {
  for (const n of [0, 1, 1023, 1024, 1025, 2048, 3077]) {
    const text = "x".repeat(n) + "😀" + String.fromCharCode(0xd800);
    const line = jsonl({ type: "message", message: { content: text } });
    const a = stream(line, 13).records[0]!.bodies[0]!;
    assert.equal(a.hash, referenceHash(text));
    assert.equal(a.decodedEnd, text.length);
  }
  const raw = Buffer.from('{"type":"message","message":{"content":"\\ud83d\\ude00\\ud800"}}\n');
  assert.equal(stream(raw, 1).records[0]!.bodies[0]!.hash, referenceHash("😀" + String.fromCharCode(0xd800)));
  assert.equal(stream(jsonl({ type: "message", content: "" }), 1).records[0]!.bodies[0]!.hash, referenceHash(""));
});

test("no keyword provenance, mixed blocks cannot launder generated retrieval", () => {
  const r = stream(Buffer.concat([
    jsonl({ type: "message", id: "a", message: { role: "assistant", content: [
      { type: "text", text: "chrono-memory-v2-event compaction history_search completed approved" },
      { type: "toolCall", id: "x", name: "history_search", arguments: { toolName: "read" } },
      { type: "toolCall", id: "y", name: "read", arguments: { name: "history_search" } },
    ] } }),
    jsonl({ type: "message", message: { role: "toolResult", toolName: "history_recall", content: [{ type: "text", text: "recalled" }] } }),
    jsonl({ type: "custom", customType: "chrono-memory-v2-event", data: { type: "message", id: "wrong" } }),
    jsonl({ type: "custom_message", customType: "chrono-compact-context-warning", content: "warning" }),
    jsonl({ type: "message", message: { role: "user", content: "compaction chrono history_search" }, details: { customType: "chrono-any", role: "toolResult", toolName: "history_search", id: "wrong" } }),
  ]), 1).records;
  assert.equal(r[0]!.provenance, "mixed");
  assert.deepEqual(r[0]!.blocks.map(b => b.provenance), ["original", "generated", "original"]);
  assert.equal(r[1]!.provenance, "generated");
  assert.equal(r[1]!.blocks[0]!.provenance, "generated");
  assert.equal(r[2]!.provenance, "generated");
  assert.equal(r[2]!.id, undefined);
  assert.equal(r[3]!.provenance, "generated");
  assert.equal(r[4]!.provenance, "original");
});

test("only LF commits; tails resume inside escape, UTF8, number and after object", () => {
  const bytes = Buffer.from('{"type":"message","message":{"content":"é😀\\ud800\\n","timestamp":-12.5e+3}}\r\n');
  for (let split = 0; split < bytes.length; split++) {
    const first = parseCatalogChunk(createCatalogParserState(), bytes.subarray(0, split));
    assert.equal(first.records.length, 0);
    assert.equal(first.error, undefined);
    const second = parseCatalogChunk(JSON.parse(JSON.stringify(first.state)), bytes.subarray(split));
    assert.equal(second.error, undefined);
    assert.equal(second.records.length, 1);
    assert.equal(second.records[0]!.messageTimestamp, -12500);
  }
});

test("malformed complete records fail safely and preserve separate earlier records", () => {
  const bad = [
    '{"type":"x",}', '{"type":"x","x":[1,]}', '{"type":"x"}false',
    '{"type":"x","x":01}', '{"type":"x","x":1.}', '{"type":"x","x":1e+}',
    '{"type":"x","x":tru}', '{"type":"x","x":"\\q"}', '{"type":"x","x":"\\u12xz"}',
    '{"type":"x","x":"raw\tcontrol"}', '{"type":"x","x":NaN}', '{"type":"x"',
    '[]', '42', '{}', '{"type":"x","id":"a","id":"b"}', '{"type":"x","id":{"id":"wrong"}}',
  ];
  for (const line of bad) {
    const bytes = Buffer.concat([jsonl({ type: "session" }), Buffer.from(line + "\n")]);
    const result = stream(bytes, bytes.length);
    assert.ok(result.error, line);
    assert.equal(result.records.length, 1, line);
    assert.equal(result.records[0]!.type, "session");
    assert.ok(result.error.byteOffset < bytes.length);
    const again = parseCatalogChunk(result.state, Buffer.from("\n"));
    assert.equal(again.consumedBytes, 0);
    assert.deepEqual(again.error, result.error);
  }
  for (const invalid of [[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x28, 0xa1], [0x80]]) {
    const bytes = Buffer.concat([Buffer.from('{"type":"x","unknown":"'), Buffer.from(invalid), Buffer.from('"}\n')]);
    assert.equal(stream(bytes, 1).error?.code, "catalog-invalid-utf8");
  }
});

test("fixed metadata/depth/block limits, giant unknown keys skip without identity confusion", () => {
  assert.equal(stream(jsonl({ type: "x", id: "a".repeat(1025) }), 5).error?.code, "catalog-metadata-limit");
  assert.equal(stream(jsonl({ type: "x", id: "a".repeat(1024) }), 5).error, undefined);
  const nested = '{"type":"x","unknown":' + '['.repeat(64) + '0' + ']'.repeat(64) + '}\n';
  assert.equal(stream(Buffer.from(nested), 1).error?.code, "catalog-depth-limit");
  const content = Array.from({ length: 257 }, () => ({ type: "text", text: "x" }));
  assert.equal(stream(jsonl({ type: "message", message: { content } }), 100).error?.code, "catalog-block-limit");
  const huge = jsonl({ type: "x", ["id" + "x".repeat(20000)]: "y".repeat(20000), id: "correct", unknown: { id: "wrong" } });
  const r = stream(huge, 97);
  assert.equal(r.error, undefined); assert.equal(r.records[0]!.id, "correct"); assert.ok(r.maxState < 2000);
  assert.throws(() => parseCatalogChunk(createCatalogParserState(), huge, 0), /emission-limit/);
  assert.equal(CATALOG_PARSER_LIMITS.depth, 64);
});

test("private hash carry has its exact cap, clears on completion, and cannot retain a whole giant body", () => {
  const state = createCatalogParserState();
  const prefix = Buffer.from('{"type":"message","content":"');
  assert.equal(parseCatalogChunk(state, prefix).error, undefined);
  const syntheticBody = "z".repeat(4095);
  assert.equal(parseCatalogChunk(state, Buffer.from(syntheticBody)).error, undefined);
  assert.equal(state.token!.hash!.pending.length, CATALOG_HASH_CARRY_BYTES);
  assert.equal(CATALOG_HASH_CARRY_BYTES, 2046);
  assert.equal(state.token!.capture, "");
  assert.equal(state.token!.hash!.units, syntheticBody.length);
  assert.equal(JSON.stringify(state).includes(syntheticBody), false);
  const carry = state.token!.hash!;
  assert.equal(parseCatalogChunk(state, Buffer.from('"')).error, undefined);
  assert.equal(state.token, undefined);
  assert.deepEqual(carry.pending, []);
  const saved = JSON.stringify(state);
  assert.equal(saved.includes('"pending"'), false);
  assert.equal(saved.includes(syntheticBody), false);
  assert.equal(parseCatalogChunk(state, Buffer.from('}\n')).records.length, 1);
  assert.equal(state.record, undefined);
  const malformed = parseCatalogChunk(createCatalogParserState(), Buffer.from('{"type":"x","content":"SYNTHETIC-PRIVATE\\q'));
  assert.ok(malformed.error);
  assert.equal(JSON.stringify(malformed.error).includes("SYNTHETIC-PRIVATE"), false);
  assert.deepEqual(Object.keys(malformed.error!).sort(), ["byteOffset", "code"]);
});

test("worst-case escaped metadata checkpoint remains under the documented fixed JSON bound", (t) => {
  // Deliberately synthetic control-code metadata maximizes JSON's six-byte
  // escape expansion. All per-record block/body/string caps are saturated.
  const m = "\u0000".repeat(CATALOG_PARSER_LIMITS.metadataUnits);
  const value = {
    type: m, id: m, parentId: m, timestamp: m, cwd: m, parentSession: m,
    customType: m, firstKeptEntryId: m, fromId: m,
    message: { role: m, toolCallId: m, toolName: m, customType: m, timestamp: m,
      content: Array.from({ length: 256 }, () => ({ type: m, id: m, name: m, text: "", thinking: "" })) },
  };
  const bytes = Buffer.from(JSON.stringify(value)); // no LF: checkpoint retains metadata
  const state = createCatalogParserState();
  for (let n = 0; n < bytes.length; n += 65536) {
    const r = parseCatalogChunk(state, bytes.subarray(n, n + 65536), 1);
    assert.equal(r.error, undefined); assert.equal(r.records.length, 0);
  }
  const serialized = Buffer.byteLength(JSON.stringify(state));
  assert.equal(state.record!.blocks.length, 256);
  assert.equal(state.bodyCount, 512);
  assert.ok(serialized < CATALOG_PARSER_LIMITS.checkpointJsonBytesUpperBound);
  t.diagnostic(JSON.stringify({ maximumMetadataFixtureCheckpointBytes: serialized, documentedBound: CATALOG_PARSER_LIMITS.checkpointJsonBytesUpperBound }));
});

test("synthetic small-value grammar agrees with JSON.parse under deterministic mutations", () => {
  let seed = 71;
  const next = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  function value(depth: number): unknown {
    const scalar = [null, true, false, next(500) / 13, 'é😀\\"\\\\\\n', "", String.fromCharCode(0xd800)];
    if (!depth || next(3) === 0) return scalar[next(scalar.length)];
    return next(2) ? Array.from({ length: next(4) }, () => value(depth - 1))
      : Object.fromEntries(Array.from({ length: next(4) }, (_, i) => ["key" + i, value(depth - 1)]));
  }
  for (let i = 0; i < 500; i++) {
    let fragment = JSON.stringify(value(4));
    if (i % 2 && fragment.length) {
      const at = next(fragment.length);
      fragment = fragment.slice(0, at) + ["", ",", "}", "[", "\\\\", "0", ":"][next(7)] + fragment.slice(at + 1);
    }
    const line = '{"type":"x","unknown":' + fragment + '}';
    let valid = true;
    try { JSON.parse(line); } catch { valid = false; }
    const r = stream(Buffer.from(line + "\n"), 1 + next(17));
    assert.equal(!r.error, valid, line);
    assert.equal(r.records.length, valid ? 1 : 0, line);
  }
});

test("many tiny records cap emissions and exact consumed suffix, blank lines and offsets", () => {
  const bytes = Buffer.from(' \r\n' + '{"type":"x"}\n'.repeat(10000));
  let state = createCatalogParserState(123), at = 0, count = 0;
  while (at < bytes.length) {
    const r = parseCatalogChunk(state, bytes.subarray(at), 2);
    assert.equal(r.error, undefined); assert.ok(r.records.length <= 2); assert.ok(r.consumedBytes > 0);
    for (const record of r.records) assert.equal(bytes[record.endByte - 124], 10);
    at += r.consumedBytes; count += r.records.length;
    state = JSON.parse(JSON.stringify(r.state));
    assert.ok(JSON.stringify(state).length < 200);
  }
  assert.equal(count, 10000); assert.equal(state.byteOffset, bytes.length + 123);
});

test("a checkpoint resumes in a new OS process mid-UTF8 after a partial hash leaf", () => {
  const module = new URL("../src/catalog-parser.js", import.meta.url).href;
  const bytes = jsonl({ type: "message", message: { content: "a".repeat(1111) + "😀é" } });
  const split = bytes.indexOf(Buffer.from("😀")) + 2;
  const first = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createCatalogParserState, parseCatalogChunk } from ${JSON.stringify(module)};
    const r = parseCatalogChunk(createCatalogParserState(), Buffer.from(${JSON.stringify(bytes.subarray(0, split).toString("base64"))}, 'base64'));
    console.log(JSON.stringify(r));
  `], { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  const partial = JSON.parse(first.stdout);
  assert.equal(partial.records.length, 0);
  const second = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { parseCatalogChunk } from ${JSON.stringify(module)};
    import { readFileSync } from 'node:fs';
    const state = JSON.parse(readFileSync(0, 'utf8'));
    const r = parseCatalogChunk(state, Buffer.from(${JSON.stringify(bytes.subarray(split).toString("base64"))}, 'base64'));
    console.log(JSON.stringify(r));
  `], { encoding: "utf8", input: JSON.stringify(partial.state) });
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout).records, stream(bytes, bytes.length).records);
});

test("valid unknown JSON values have constant token memory and malformed numbers fail", () => {
  const valid = [null, true, false, 0, -0, 0.05, -4e-20, [1, {}, false], { arbitrary: "v" }];
  for (const v of valid) assert.equal(stream(jsonl({ type: "x", unknown: v }), 1).error, undefined);
  const giantNumber = Buffer.from('{"type":"x","unknown":' + "9".repeat(50000) + '}\n');
  const parsed = stream(giantNumber, 311);
  assert.equal(parsed.error, undefined); assert.ok(parsed.maxState < 2000);
  for (const v of ["-", "00", "-.1", "+1", "1e", "1e-", ".1", "1.2.3", "truefalse"]) {
    assert.ok(stream(Buffer.from('{"type":"x","unknown":' + v + '}\n'), 1).error, v);
  }
  const duplicateEscaped = Buffer.from('{"type":"x","id":"a","\\u0069d":"b"}\n');
  assert.equal(stream(duplicateEscaped, 1).error?.code, "catalog-duplicate-field");
  const manyBodies = { type: "message", content: Array.from({ length: 171 }, () => ({ type: "text", text: "", thinking: "", data: "" })) };
  assert.equal(stream(jsonl(manyBodies), 23).error?.code, "catalog-body-limit");
});

test("giant escaped Unicode body streams in a separate fixed-heap process without retained text", { timeout: 120000 }, (t) => {
  const module = new URL("../src/catalog-parser.js", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--max-old-space-size=32", "--input-type=module", "-e", `
    import { createCatalogParserState, parseCatalogChunk } from ${JSON.stringify(module)};
    let state = createCatalogParserState(); let largest = 0; let records = [];
    function feed(bytes) {
      const r = parseCatalogChunk(state, bytes);
      if (r.error || r.consumedBytes !== bytes.length) throw Error(JSON.stringify(r.error));
      const saved = JSON.stringify(r.state); largest = Math.max(largest, saved.length);
      if (r.state.token?.hash?.pending.length > 2046 || r.state.token?.capture) throw Error('carry bound');
      if (r.records.some(record => JSON.stringify(record).includes('"pending"'))) throw Error('retained hash carry');
      state = JSON.parse(saved); records.push(...r.records);
    }
    feed(Buffer.from('{"type":"message","id":"giant","message":{"role":"toolResult","toolName":"read","toolCallId":"pair","content":[{"type":"text","text":"'));
    const fragment = Buffer.from('\\\\ud83d\\\\ude00é\\\\n'.repeat(4099));
    for (let i = 0; i < 1024; i++) feed(fragment);
    feed(Buffer.from('"}]}}\\n'));
    if (records.length !== 1 || records[0].blocks[0].bodies[0].decodedEnd !== 4099 * 1024 * 4) throw Error('length');
    if (largest > 15000) throw Error('checkpoint bound ' + largest);
    console.log(JSON.stringify({ rawBytes: state.byteOffset, largest, units: records[0].blocks[0].bodies[0].decodedEnd }));
  `], { encoding: "utf8", timeout: 110000, maxBuffer: 10000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const measured = JSON.parse(result.stdout);
  t.diagnostic(JSON.stringify(measured));
  assert.ok(measured.rawBytes > 64 * 1024 * 1024);
  assert.ok(measured.largest < 15000);
});
