import test from "node:test";
import assert from "node:assert/strict";
import { strictJsonParse, encodeFrame, decodeSingleFrame, validateResponse, validateCapabilities } from "../src/protocol.mjs";

const failure = code => error => error?.code === code;

test("strict JSON rejects duplicates, invalid UTF-8, excessive depth, and trailing data", () => {
  assert.throws(() => strictJsonParse(Buffer.from('{"a":1,"a":2}')), failure("PROTOCOL_ERROR"));
  assert.throws(() => strictJsonParse(Buffer.from([0x7b, 0x80, 0x7d])), failure("PROTOCOL_ERROR"));
  assert.throws(() => strictJsonParse(Buffer.from("[".repeat(21) + "]".repeat(21))), failure("PROTOCOL_ERROR"));
  assert.throws(() => strictJsonParse(Buffer.from("{}x")), failure("PROTOCOL_ERROR"));
});

test("single-frame decoder rejects truncation, declared floods, and trailing frames", () => {
  const valid = encodeFrame({ a: 1 });
  assert.deepEqual({ ...decodeSingleFrame(valid) }, { a: 1 });
  assert.throws(() => decodeSingleFrame(valid.subarray(0, -1)), failure("PROTOCOL_ERROR"));
  assert.throws(() => decodeSingleFrame(Buffer.concat([valid, Buffer.from([0])])), failure("PROTOCOL_ERROR"));
  const huge = Buffer.alloc(4); huge.writeUInt32BE(48 * 1024 * 1024 + 1);
  assert.throws(() => decodeSingleFrame(huge), failure("REMOTE_OUTPUT_LIMIT"));
});

test("response validation enforces exact operation schemas and matching IDs", () => {
  const id = "0123456789abcdef";
  const base = { version: 2, id, ok: true };
  assert.throws(() => validateResponse({ ...base, result: { data: "", empty: true, limitReached: false, truncation: null, extra: true } }, id, "ls"), failure("PROTOCOL_ERROR"));
  assert.throws(() => validateResponse({ ...base, id: "fedcba9876543210", result: { data: "", empty: true, limitReached: false, truncation: null } }, id, "ls"), failure("PROTOCOL_ERROR"));
  assert.deepEqual(validateResponse({ ...base, result: { data: "a", empty: false, limitReached: false, truncation: null } }, id, "ls"), { data: "a", empty: false, limitReached: false, truncation: null });
});

test("capability mismatch is rejected", () => {
  const good = {
    protocol: 2, python: [3, 12], operations: ["read", "ls", "find", "grep", "access", "readRaw", "write", "mkdir", "rollback", "exec"],
    limits: { requestBytes: 12582912, responseBytes: 50331648, readBytes: 51200, readLines: 2000, textSourceBytes: 134217728, results: 1000, scanBytes: 67108864, transferBytes: 8388608, execBytes: 65536 },
    utilities: { rg: "ripgrep 14", fd: "fd 10" }, authorization: "remote-account",
  };
  assert.equal(validateCapabilities(good).protocol, 2);
  assert.throws(() => validateCapabilities({ ...good, operations: ["read"] }), failure("REMOTE_UNSUPPORTED"));
  assert.throws(() => validateCapabilities({ ...good, authorization: "path-prefix" }), failure("REMOTE_UNSUPPORTED"));
});
