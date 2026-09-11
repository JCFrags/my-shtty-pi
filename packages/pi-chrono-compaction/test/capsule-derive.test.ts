import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { CAPSULE_LIMITS, CAPSULE_TEXT_HASH, type ScopedBodySourceRef } from "../src/capsule-contract.js";
import { catalogHashUnit, createCatalogHash, finishCatalogHash } from "../src/catalog-parser-hash.js";
import { beginBodyDecode, feedBodyRaw, privateCursor, validateStoredBodyDecodeState } from "../src/capsule-derive.js";

function bodyHash(text: string): string { const state = createCatalogHash(); for (let i = 0; i < text.length; i++) catalogHashUnit(state, text.charCodeAt(i)); return finishCatalogHash(state); }
function sourceFor(text: string, raw: Buffer): ScopedBodySourceRef {
  return { catalogStoreKey: randomUUID(), sessionKey: "synthetic", catalogGeneration: 1, shardKey: "s1", segment: 1, eventSeq: 1,
    ordinal: 1, descriptor: 1, field: "text", raw: { start: 100, end: 100 + raw.length }, coordinateKind: "decoded-body",
    decodedUtf16: { start: 0, end: text.length }, bodyHashAlgorithm: CAPSULE_TEXT_HASH, bodyHash: bodyHash(text) };
}
function decode(text: string, page: number) {
  const raw = Buffer.from(JSON.stringify(text)); const source = sourceFor(text, raw); let state = beginBodyDecode(source); const chunks = [];
  for (let offset = 0; offset < raw.length;) {
    const selected = raw.subarray(offset, Math.min(raw.length, offset + page));
    const result = feedBodyRaw(state, selected); state = result.state; chunks.push(...result.chunks); offset += selected.length;
    assert.ok(Buffer.from(state.chunkCarryBase64, "base64").length < CAPSULE_LIMITS.decodedChunkBytes);
    assert.ok(state.boundedHash.pending.length <= 2046);
  }
  return { raw, source, state, chunks, payload: Buffer.concat(chunks.map(item => item.payload)) };
}

test("streaming decoder preserves escapes, literal Unicode, lone surrogates, CRLF and empty bodies", () => {
  for (const text of ["", "a\\b\n\r\t", "literal café 😀", "escaped \ud800 lone", "line1\r\nline2", "\u0000\uffff"]) {
    const one = decode(text, 65536), bytewise = decode(text, 1);
    assert.equal(one.state.complete, true); assert.equal(bytewise.state.complete, true);
    assert.equal(one.state.bodyHash, one.source.bodyHash); assert.equal(bytewise.state.bodyHash, bytewise.source.bodyHash);
    assert.deepEqual(one.payload, bytewise.payload);
    assert.equal(one.payload.toString("utf16le"), text);
    assert.equal(one.chunks.length, Math.ceil(text.length / CAPSULE_LIMITS.decodedChunkUnits));
    assert.equal(privateCursor(one.state).complete, true);
  }
});

test("fixed chunk partition is independent of raw page size and can split a surrogate pair", () => {
  const text = "x".repeat(CAPSULE_LIMITS.decodedChunkUnits - 1) + "😀" + "tail";
  const a = decode(text, 17), b = decode(text, CAPSULE_LIMITS.sourceReadBytes);
  assert.deepEqual(a.chunks.map(item => [item.descriptor.decodedUtf16, item.descriptor.contentHash]),
    b.chunks.map(item => [item.descriptor.decodedUtf16, item.descriptor.contentHash]));
  assert.equal(a.chunks.length, 2);
  assert.equal(a.chunks[0]!.payload.readUInt16LE(a.chunks[0]!.payload.length - 2), 0xd83d);
  assert.equal(a.chunks[1]!.payload.readUInt16LE(0), 0xde00);
  assert.equal(a.payload.toString("utf16le"), text);
});

test("private restart state stores actual hash pending bytes and exact bounded chunk carry", () => {
  const text = "abc\\n".repeat(9000), raw = Buffer.from(JSON.stringify(text)), source = sourceFor(text, raw);
  let state = beginBodyDecode(source);
  const first = feedBodyRaw(state, raw.subarray(0, 12345)); state = structuredClone(first.state);
  validateStoredBodyDecodeState(state);
  const cursor = privateCursor(state);
  assert.deepEqual(cursor.boundedHash.pendingBytes, state.boundedHash.pending);
  assert.deepEqual(Buffer.from(cursor.chunkCarryUtf16le), Buffer.from(state.chunkCarryBase64, "base64"));
  const chunks = [...first.chunks];
  for (let offset = 12345; offset < raw.length;) { const page = raw.subarray(offset, Math.min(raw.length, offset + 4093)); const result = feedBodyRaw(state, page); state = structuredClone(result.state); chunks.push(...result.chunks); offset += page.length; }
  assert.equal(state.complete, true); assert.equal(state.bodyHash, source.bodyHash);
  assert.equal(Buffer.concat(chunks.map(item => item.payload)).toString("utf16le"), text);
});

test("wrong catalog body length/hash and corrupt private carry refuse without invented completion", () => {
  const text = "synthetic", raw = Buffer.from(JSON.stringify(text));
  const wrong = { ...sourceFor(text, raw), bodyHash: createHash("sha256").update("wrong").digest("hex") };
  assert.throws(() => feedBodyRaw(beginBodyDecode(wrong), raw), /capsule-body-hash-mismatch/);
  const state = beginBodyDecode(sourceFor(text, raw));
  assert.throws(() => validateStoredBodyDecodeState({ ...state, chunkCarryBase64: "not-base64" }), /capsule-checkpoint-corrupt/);
});
