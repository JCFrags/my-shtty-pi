import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CAPSULE_TEXT_HASH, CHUNK_CONTENT_HASH, type DerivedStoreIdentity, type ReducerEnvelope, type ScopedBodySourceRef } from "../src/capsule-contract.js";
import { canonicalJson, decodeCapsuleSegment, decodeChunkPayload, encodeCapsuleSegment, encodeChunkSegment, encodeManifest, publishImmutable, readVerifiedImmutable } from "../src/capsule-segment.js";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const identity: DerivedStoreIdentity = { storeKey: randomUUID(), sessionKey: "synthetic", catalogStoreKey: randomUUID(), catalogGeneration: 1,
  derivedSchemaVersion: 1, capsuleSchemaVersion: 1, chunkSchemaVersion: 1, reducerSetVersion: "r1", configHash: hash("config") };
const source: ScopedBodySourceRef = { catalogStoreKey: identity.catalogStoreKey, sessionKey: identity.sessionKey, catalogGeneration: 1,
  shardKey: "s1", segment: 1, eventSeq: 1, ordinal: 1, descriptor: 1, field: "text", raw: { start: 10, end: 14 },
  coordinateKind: "decoded-body", decodedUtf16: { start: 0, end: 1 }, bodyHashAlgorithm: CAPSULE_TEXT_HASH, bodyHash: hash("body") };
function envelope(): ReducerEnvelope {
  return { v: 1, capsuleSchemaVersion: 1, identity, source, family: "generic-text", familyVersion: "1", reducerSetVersion: "r1",
    configHash: identity.configHash, budget: { maxTokens: 32, maxUtf16Units: 1024, maxAlternatives: 1 }, inputHash: hash("input"), provenance: "original",
    alternatives: [{ alternative: 0, family: "generic-text", familyVersion: "1", maxTokens: 32, text: "x\ud800", lossy: true,
      facts: [], protectedCues: [], omissions: [], outcome: { status: "unknown" }, sourceRefs: [source] }] };
}

test("canonical capsule framing is byte deterministic and preserves lone surrogate escaping", () => {
  const a = encodeCapsuleSegment(envelope()), b = encodeCapsuleSegment(structuredClone(envelope()));
  assert.deepEqual(a, b); assert.equal(hash(a.bytes), a.descriptor.hash);
  assert.match(a.bytes.toString("utf8"), /x\\ud800/);
  assert.deepEqual(decodeCapsuleSegment(a.bytes), envelope());
  assert.equal(a.descriptor.records, 1);
});

test("chunk framing omits self locators and returns exact UTF16LE payload location", () => {
  const payload = Buffer.from([0x00, 0xd8, 0x41, 0x00]);
  const chunkSource = { ...source, raw: { start: 10, end: 30 }, decodedUtf16: { start: 0, end: 2 } };
  const encoded = encodeChunkSegment({ v: 1, source: chunkSource, chunkIndex: 0, decodedUtf16: { start: 0, end: 2 }, utf16leBytes: 4,
    contentHashAlgorithm: CHUNK_CONTENT_HASH, contentHash: hash(payload) }, payload);
  assert.equal(hash(encoded.bytes), encoded.descriptor.hash);
  const header = encoded.bytes.subarray(0, encoded.chunk.segmentOffset).toString("utf8");
  assert.doesNotMatch(header, /segmentHash|segmentOffset/);
  assert.deepEqual(decodeChunkPayload(encoded.bytes, encoded.chunk), payload);
  assert.deepEqual(encoded.bytes.subarray(encoded.chunk.segmentOffset, encoded.chunk.segmentOffset + 4), payload);
});

test("canonical one-segment manifest is source local and excludes cursor/view/job identity", () => {
  const segment = encodeCapsuleSegment(envelope()).descriptor;
  const one = encodeManifest(identity, "capsules", segment), two = encodeManifest(identity, "capsules", segment);
  assert.deepEqual(one, two); assert.doesNotMatch(one.bytes.toString(), /cursor|eventCut|predecessor|job|batch/);
  const parsed = JSON.parse(one.bytes.toString()); const { hash: _hash, ...base } = parsed;
  assert.equal(hash(canonicalJson(base)), one.manifest.hash);
});

test("locked immutable publication reuses exact bytes, refuses corruption and strict unsafe links", () => {
  const root = mkdtempSync(join(tmpdir(), "capsule-segment-"));
  try {
    chmodSync(root, 0o700); const dir = join(root, "segments"); mkdirSync(dir, { mode: 0o700 });
    const encoded = encodeCapsuleSegment(envelope());
    const path = publishImmutable(dir, encoded.descriptor.hash, encoded.bytes, "capsule");
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readVerifiedImmutable(path, encoded.descriptor.hash, encoded.bytes.length), encoded.bytes);
    publishImmutable(dir, encoded.descriptor.hash, encoded.bytes, "capsule");
    writeFileSync(path, Buffer.alloc(encoded.bytes.length, 1), { mode: 0o600 });
    assert.throws(() => publishImmutable(dir, encoded.descriptor.hash, encoded.bytes, "capsule"), /capsule-content-corrupt/);
    writeFileSync(path, encoded.bytes, { mode: 0o600 }); linkSync(path, `${path}.alias`);
    assert.throws(() => publishImmutable(dir, encoded.descriptor.hash, encoded.bytes, "capsule"), /capsule-storage-unsafe/);
    assert.deepEqual(readFileSync(path), encoded.bytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("atomic no-replace preserves a target created at the publication seam", () => {
  const root = mkdtempSync(join(tmpdir(), "capsule-segment-race-"));
  try {
    chmodSync(root, 0o700); const dir = join(root, "segments"); mkdirSync(dir, { mode: 0o700 });
    const encoded = encodeCapsuleSegment(envelope()), path = join(dir, encoded.descriptor.hash);
    const owner = Buffer.alloc(encoded.bytes.length, 0x5a);
    assert.throws(() => publishImmutable(dir, encoded.descriptor.hash, encoded.bytes, "capsule", {
      fault(point) { if (point === "before-file-rename") writeFileSync(path, owner, { mode: 0o600, flag: "wx" }); },
    }));
    assert.deepEqual(readFileSync(path), owner, "publication must not replace a raced target");
    rmSync(path);
    let racedInode = 0;
    publishImmutable(dir, encoded.descriptor.hash, encoded.bytes, "capsule", {
      fault(point) { if (point === "before-file-rename") { writeFileSync(path, encoded.bytes, { mode: 0o600, flag: "wx" }); racedInode = lstatSync(path).ino; } },
    });
    assert.equal(lstatSync(path).ino, racedInode, "matching raced bytes are validated and reused, not replaced");
    rmSync(path);
    assert.throws(() => publishImmutable(dir, encoded.descriptor.hash, encoded.bytes, "capsule", {
      fault(point) { if (point === "before-file-rename") writeFileSync(path, encoded.bytes, { mode: 0o644, flag: "wx" }); },
    }), /capsule-storage-unsafe/);
    assert.equal(lstatSync(path).mode & 0o777, 0o644, "unsafe raced target remains intact");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rename and directory-sync fault seams never expose partial bytes as valid", () => {
  const root = mkdtempSync(join(tmpdir(), "capsule-segment-fault-"));
  try {
    chmodSync(root, 0o700); const dir = join(root, "segments"); mkdirSync(dir, { mode: 0o700 });
    const encoded = encodeCapsuleSegment(envelope());
    assert.throws(() => publishImmutable(dir, encoded.descriptor.hash, encoded.bytes, "capsule", { fault(point) { if (point === "before-file-rename") throw Object.assign(new Error("EIO"), { code: "EIO" }); } }));
    assert.equal(readdirSync(dir).length, 0);
    publishImmutable(dir, encoded.descriptor.hash, encoded.bytes, "capsule");
    assert.deepEqual(readVerifiedImmutable(join(dir, encoded.descriptor.hash), encoded.descriptor.hash, encoded.bytes.length), encoded.bytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
