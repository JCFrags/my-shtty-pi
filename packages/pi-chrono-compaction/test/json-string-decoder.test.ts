import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  createQuotedJsonStringState,
  decodeQuotedJsonStringChunk,
  type QuotedJsonStringState,
} from "../src/json-string-decoder.js";
import { createCatalogParserState, parseCatalogChunk } from "../src/catalog-parser.js";

function appendUnit(output: number[], unit: number): void {
  output.push(unit);
}
function decodeInChunks(bytes: Uint8Array, chunkSize: number, restore: boolean) {
  let state = createQuotedJsonStringState();
  const units: number[] = [];
  let at = 0;
  while (at < bytes.length && !state.done && !state.error) {
    const result = decodeQuotedJsonStringChunk(state, bytes.subarray(at, at + chunkSize), appendUnit, units);
    at += result.consumedBytes;
    state = restore ? JSON.parse(JSON.stringify(result.state)) as QuotedJsonStringState : result.state;
    if (!result.consumedBytes && !result.error && !result.state.done) throw new Error("decoder made no progress");
  }
  return { state, units, consumedBytes: at };
}

const fromUnits = (units: number[]) => String.fromCharCode(...units);

test("quoted streaming decoder matches JSON.parse across batches and every-byte restarts", () => {
  const quoted = [
    '""',
    '"plain"',
    '"\\\"\\\\\\/\\b\\f\\n\\r\\t"',
    '"\\u0041\\u00e9\\ud83d\\ude00\\ud800x\\udc00"',
    JSON.stringify("é中😀"),
  ];
  for (const source of quoted) {
    const bytes = Buffer.from(source + "\r\n");
    const expected = JSON.parse(source) as string;
    for (const size of [1, 2, 3, 4, 7, bytes.length]) {
      const decoded = decodeInChunks(bytes, size, true);
      assert.equal(decoded.state.error, undefined, source);
      assert.equal(decoded.state.done, true, source);
      assert.equal(decoded.state.decodedUnits, expected.length, source);
      assert.equal(fromUnits(decoded.units), expected, source);
      assert.equal(decoded.consumedBytes, Buffer.byteLength(source), source);
      assert.equal(decoded.state.rawBytes, Buffer.byteLength(source), source);
      assert.equal(decoded.state.decoder.escape, false);
      assert.equal(decoded.state.decoder.unicodeLeft, 0);
      assert.equal(decoded.state.decoder.utfLeft, 0);
    }
  }
});

test("decoder preserves split UTF-8 and escaped surrogate code units without retaining output", () => {
  const source = '"é中😀\\ud83d\\ude00\\ud800\\udc00"';
  const bytes = Buffer.from(source);
  const output: number[] = [];
  let state = createQuotedJsonStringState();
  for (const byte of bytes) {
    const result = decodeQuotedJsonStringChunk(state, Uint8Array.of(byte), appendUnit, output);
    assert.equal(result.error, undefined);
    state = JSON.parse(JSON.stringify(result.state)) as QuotedJsonStringState;
    assert.ok(JSON.stringify(state).length < 220);
  }
  const expected = JSON.parse(source) as string;
  assert.equal(fromUnits(output), expected);
  assert.deepEqual(output, Array.from({ length: expected.length }, (_, index) => expected.charCodeAt(index)));
  assert.equal("decoded" in state, false);
});

test("decoder refuses malformed strings with stable codes and catalog translation keeps byte offsets", () => {
  const cases: Array<{ raw: number[]; code: string; catalogCode: string }> = [
    { raw: [34, 92, 113], code: "json-string-invalid-escape", catalogCode: "catalog-invalid-escape" },
    { raw: [34, 92, 117, 49, 50, 120], code: "json-string-invalid-escape", catalogCode: "catalog-invalid-escape" },
    { raw: [34, 9], code: "json-string-invalid-string", catalogCode: "catalog-invalid-string" },
    { raw: [34, 0xc0], code: "json-string-invalid-utf8", catalogCode: "catalog-invalid-utf8" },
    { raw: [34, 0xe2, 0x28], code: "json-string-invalid-utf8", catalogCode: "catalog-invalid-utf8" },
    { raw: [34, 0xed, 0xa0, 0x80], code: "json-string-invalid-utf8", catalogCode: "catalog-invalid-utf8" },
    { raw: [34, 0xf4, 0x90, 0x80, 0x80], code: "json-string-invalid-utf8", catalogCode: "catalog-invalid-utf8" },
  ];
  const catalogPrefix = Buffer.from('{"type":"x","content":');
  for (const fixture of cases) {
    const bytes = Uint8Array.from(fixture.raw);
    const direct = decodeInChunks(bytes, 1, true);
    assert.equal(direct.state.error?.code, fixture.code);
    assert.equal(direct.state.error?.byteOffset, fixture.raw.length - 1);
    assert.equal(direct.consumedBytes, fixture.raw.length - 1);
    const catalog = parseCatalogChunk(createCatalogParserState(), Buffer.concat([catalogPrefix, bytes]));
    assert.equal(catalog.error?.code, fixture.catalogCode);
    assert.equal(catalog.error?.byteOffset, catalogPrefix.length + fixture.raw.length - 1);
    assert.equal(catalog.consumedBytes, catalog.error?.byteOffset);
  }
  const opening = decodeQuotedJsonStringChunk(createQuotedJsonStringState(), Buffer.from("x"));
  assert.deepEqual(opening.error, { code: "json-string-opening-quote-expected", byteOffset: 0 });
  assert.equal(opening.consumedBytes, 0);
});

test("32 MiB fixed-heap synthetic escaped Unicode source has bounded restart state", { timeout: 120000 }, (t) => {
  const decoderModule = new URL("../src/json-string-decoder.js", import.meta.url).href;
  const hashModule = new URL("../src/catalog-parser-hash.js", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--max-old-space-size=32", "--input-type=module", "-e", `
    import { createQuotedJsonStringState, decodeQuotedJsonStringChunk } from ${JSON.stringify(decoderModule)};
    import { catalogHashUnit, createCatalogHash, finishCatalogHash } from ${JSON.stringify(hashModule)};
    let state = createQuotedJsonStringState();
    const hash = createCatalogHash();
    let largest = 0;
    const sink = (target, unit) => catalogHashUnit(target, unit);
    function feed(bytes) {
      const result = decodeQuotedJsonStringChunk(state, bytes, sink, hash);
      if (result.error || result.consumedBytes !== bytes.length) throw Error(JSON.stringify(result.error));
      const saved = JSON.stringify(result.state);
      largest = Math.max(largest, Buffer.byteLength(saved));
      if (saved.includes('pending') || saved.includes('decodedText')) throw Error('retained output');
      state = JSON.parse(saved);
    }
    feed(Buffer.from('"'));
    const repetitionsPerChunk = 4096;
    const chunks = 512;
    const fragment = '\\\\ud83d\\\\ude00é\\\\n';
    const sourceChunk = Buffer.from(fragment.repeat(repetitionsPerChunk));
    for (let index = 0; index < chunks; index++) feed(sourceChunk);
    feed(Buffer.from('"'));
    const expectedUnits = repetitionsPerChunk * chunks * 4;
    if (!state.done || state.decodedUnits !== expectedUnits || hash.units !== expectedUnits) throw Error('count');
    console.log(JSON.stringify({
      rawBytes: state.rawBytes,
      decodedUnits: state.decodedUnits,
      hash: finishCatalogHash(hash),
      largestStateBytes: largest,
      sourceChunkBytes: sourceChunk.length,
      chunks,
    }));
  `], { encoding: "utf8", timeout: 110000, maxBuffer: 10000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const measured = JSON.parse(result.stdout) as { rawBytes: number; decodedUnits: number; hash: string; largestStateBytes: number };
  assert.ok(measured.rawBytes >= 32 * 1024 * 1024);
  assert.equal(measured.decodedUnits, 4096 * 512 * 4);
  assert.equal(measured.hash, "07d02bc92e8618c10de61fd6157807852c57d5f281a3f2ed6090773a90669bb8");
  assert.ok(measured.largestStateBytes < 256);
  t.diagnostic(JSON.stringify(measured));
});
