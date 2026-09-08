import assert from "node:assert/strict";
import test from "node:test";
import {
  ADAPTER_ONLY_DECISIONS,
  CAPSULE_LIMITS,
  CAPSULE_TEXT_HASH,
  CHUNK_CONTENT_HASH,
  SEGMENT_CONTENT_HASH,
  SOURCE_REDUCER_FAMILIES,
  isCapsuleBodyDescriptor,
  isCapsuleCatalogView,
  isCapsuleReadiness,
  isCapsuleWorkerRequest,
  isChunkDecodeCursor,
  isDecodedChunkDescriptor,
  isDerivedManifest,
  isDerivedPublicationReceipt,
  isDerivedStoreIdentity,
  isReducerEnvelope,
  isScopedSourceRef,
  isSourceBlockReducerInput,
  sourceRefWithinViewBounds,
  type CapsuleCatalogView,
  type DerivedStoreIdentity,
  type ScopedBodySourceRef,
  type ScopedRawSourceRef,
} from "../src/capsule-contract.js";

const h = (digit: string) => digit.repeat(64);
const catalogStore = "11111111-1111-4111-8111-111111111111";
const derivedStore = "22222222-2222-4222-8222-222222222222";
const identity: DerivedStoreIdentity = {
  storeKey: derivedStore,
  sessionKey: "session-1",
  catalogStoreKey: catalogStore,
  catalogGeneration: 4,
  derivedSchemaVersion: 1,
  capsuleSchemaVersion: 1,
  chunkSchemaVersion: 1,
  reducerSetVersion: "reducers-1",
  configHash: h("a"),
};
const view: CapsuleCatalogView = {
  storeKey: catalogStore,
  sessionKey: "session-1",
  generation: 4,
  eventCut: 9,
  branchKey: "branch-a",
  segments: [{ segment: 2, cut: 5 }, { segment: 7, cut: 9 }],
};
const body: ScopedBodySourceRef = {
  coordinateKind: "decoded-body",
  catalogStoreKey: catalogStore,
  sessionKey: "session-1",
  catalogGeneration: 4,
  shardKey: "shard-0",
  segment: 7,
  eventSeq: 8,
  ordinal: 8,
  descriptor: 3,
  blockIndex: 1,
  field: "text",
  raw: { start: 100, end: 180 },
  decodedUtf16: { start: 0, end: 12 },
  bodyHashAlgorithm: CAPSULE_TEXT_HASH,
  bodyHash: h("b"),
  entryId: "duplicate-prone-display-id",
};
const raw: ScopedRawSourceRef = {
  coordinateKind: "raw-json",
  catalogStoreKey: catalogStore,
  sessionKey: "session-1",
  catalogGeneration: 4,
  shardKey: "shard-0",
  segment: 7,
  eventSeq: 8,
  ordinal: 8,
  descriptor: 2,
  blockIndex: 1,
  field: "arguments",
  raw: { start: 60, end: 99 },
  rawHashAlgorithm: SEGMENT_CONTENT_HASH,
  rawHash: h("c"),
};

const clone = <T>(value: T): T => structuredClone(value);

test("physical identity, pinned ancestry, and body/raw source references stay distinct", () => {
  assert.equal(isDerivedStoreIdentity(identity), true);
  assert.equal(isCapsuleCatalogView(view), true);
  assert.equal(isScopedSourceRef(body), true);
  assert.equal(isScopedSourceRef(raw), true);
  assert.equal(sourceRefWithinViewBounds(body, view), true);

  const wrongStore = { ...body, catalogStoreKey: "33333333-3333-4333-8333-333333333333" };
  assert.equal(sourceRefWithinViewBounds(wrongStore, view), false);
  assert.equal(sourceRefWithinViewBounds({ ...body, segment: 99 }, view), false);
  assert.equal(isScopedSourceRef({ ...raw, coordinateKind: "decoded-body", bodyHash: h("d") }), false);
  assert.equal(isScopedSourceRef({ ...body, entryId: "x".repeat(1025) }), false);

  const duplicateSegment = { ...view, segments: [...view.segments, { segment: 7, cut: 9 }] };
  assert.equal(isCapsuleCatalogView(duplicateSegment), false);
});

test("body and immutable chunk descriptors use exact UTF-16LE units including empty and half-pair cuts", () => {
  assert.equal(isCapsuleBodyDescriptor({
    v: 1, source: body, decodedUnits: 12, utf16leBytes: 24, chunkCount: 1,
    bodyHashAlgorithm: CAPSULE_TEXT_HASH, bodyHash: h("b"), provenance: "original", opaque: "none",
  }), true);
  const empty = { ...body, raw: { start: 20, end: 22 }, decodedUtf16: { start: 0, end: 0 }, bodyHash: h("e") };
  assert.equal(isCapsuleBodyDescriptor({
    v: 1, source: empty, decodedUnits: 0, utf16leBytes: 0, chunkCount: 0,
    bodyHashAlgorithm: CAPSULE_TEXT_HASH, bodyHash: h("e"), provenance: "original", opaque: "none",
  }), true);

  const huge = { ...body, decodedUtf16: { start: 0, end: 65_537 }, raw: { start: 100, end: 90_000 } };
  assert.equal(isDecodedChunkDescriptor({
    v: 1, source: huge, chunkIndex: 0, decodedUtf16: { start: 0, end: 32_768 }, utf16leBytes: 65_536,
    contentHashAlgorithm: CHUNK_CONTENT_HASH, contentHash: h("1"), segmentHash: h("2"), segmentOffset: 0,
  }), true);
  // A chunk boundary is a code-unit boundary. It may split a surrogate pair.
  assert.equal(isDecodedChunkDescriptor({
    v: 1, source: huge, chunkIndex: 1, decodedUtf16: { start: 32_768, end: 65_536 }, utf16leBytes: 65_536,
    contentHashAlgorithm: CHUNK_CONTENT_HASH, contentHash: h("3"), segmentHash: h("2"), segmentOffset: 65_536,
  }), true);
  assert.equal(isDecodedChunkDescriptor({
    v: 1, source: huge, chunkIndex: 1, decodedUtf16: { start: 32_769, end: 65_536 }, utf16leBytes: 65_534,
    contentHashAlgorithm: CHUNK_CONTENT_HASH, contentHash: h("3"), segmentHash: h("2"), segmentOffset: 65_536,
  }), false);
});

test("decoder checkpoints are bounded, resumable, and complete only at exact body end", () => {
  const cursor = {
    v: 1, source: body, rawOffset: 150, decodedOffset: 7, opened: true, jsonEscape: true,
    pendingUnicodeEscape: { value: 0xd8, digits: 2 }, pendingUtf8: null,
    boundedHash: { algorithm: CAPSULE_TEXT_HASH, chain: h("4"), pendingBytes: new Array(14).fill(0), units: 7 },
    chunkCarryUtf16le: new Uint8Array(14), complete: false,
  };
  assert.equal(isChunkDecodeCursor(cursor), true);
  assert.equal(isChunkDecodeCursor({ ...cursor, chunkCarryUtf16le: new Uint8Array(12) }), false);
  assert.equal(isChunkDecodeCursor({ ...cursor, boundedHash: { ...cursor.boundedHash, pendingBytes: new Array(2048).fill(0) } }), false);
  assert.equal(isChunkDecodeCursor({ ...cursor, complete: true }), false);
  assert.equal(isChunkDecodeCursor({
    ...cursor, rawOffset: 180, decodedOffset: 12, jsonEscape: false, pendingUnicodeEscape: null,
    boundedHash: { ...cursor.boundedHash, pendingBytes: [], units: 12 }, chunkCarryUtf16le: new Uint8Array(0), complete: true,
  }), true);
});

test("bounded reducer inputs never admit a giant body as one reducer string", () => {
  const input = {
    v: 1, identity, view, source: body, kind: "assistant-text", provenance: "original", structural: {},
    window: { decodedUtf16: { start: 0, end: 12 }, text: "a".repeat(12), completeBody: true, omittedBeforeUnits: 0, omittedAfterUnits: 0 },
  };
  assert.equal(isSourceBlockReducerInput(input), true);

  const giantSource = { ...body, decodedUtf16: { start: 0, end: CAPSULE_LIMITS.reducerInputUnits + 1 } };
  assert.equal(isSourceBlockReducerInput({
    ...input, source: giantSource,
    window: { decodedUtf16: giantSource.decodedUtf16, text: "a".repeat(CAPSULE_LIMITS.reducerInputUnits + 1), completeBody: true, omittedBeforeUnits: 0, omittedAfterUnits: 0 },
  }), false);
  assert.equal(isSourceBlockReducerInput({
    ...input, source: giantSource,
    window: { decodedUtf16: { start: 0, end: 10 }, text: "a".repeat(10), completeBody: false, omittedBeforeUnits: 0, omittedAfterUnits: giantSource.decodedUtf16.end - 10 },
  }), true);
});

function envelope(): any {
  return {
    v: 1,
    capsuleSchemaVersion: 1,
    identity,
    source: body,
    provenance: "original",
    family: "terminal",
    familyVersion: "2.0.0",
    reducerSetVersion: "reducers-1",
    configHash: h("a"),
    budget: { maxTokens: 120, maxUtf16Units: 2048, maxAlternatives: 2 },
    inputHash: h("5"),
    alternatives: [{
      alternative: 0,
      family: "terminal",
      familyVersion: "2.0.0",
      maxTokens: 120,
      text: "failed unless retried",
      lossy: true,
      facts: [{ kind: "structural", name: "isError", value: true, source: raw }],
      protectedCues: [{ kind: "condition", source: body, decodedUtf16: { start: 0, end: 6 }, exactText: "failed" }],
      omissions: [{ kind: "exact-range", reason: "middle", source: body, decodedUtf16: { start: 6, end: 12 }, omittedUnits: 6, description: "routine lines omitted" }],
      outcome: { status: "supported", value: "failure", facts: [0] },
      sourceRefs: [raw, body],
    }],
  };
}

test("capsules are source-local, explicitly lossy, source-linked alternatives with supported outcomes", () => {
  const valid = envelope();
  assert.equal(isReducerEnvelope(valid), true);
  assert.equal("view" in valid, false, "pin and transient cut are not persisted in source-local identity");
  assert.deepEqual(SOURCE_REDUCER_FAMILIES, [
    "terminal", "test-output", "git-diff", "generic-text", "assistant-extractive",
    "assistant-cleanup", "lossless-normalizer", "small-json",
  ]);
  assert.ok(ADAPTER_ONLY_DECISIONS.includes("current-state"));
  assert.equal(isReducerEnvelope({ ...valid, family: "file-read" }), false);

  const inventedOutcome = clone(valid);
  inventedOutcome.alternatives[0]!.outcome = { status: "supported", value: "success", facts: [] };
  assert.equal(isReducerEnvelope(inventedOutcome), false);
  const transformed = clone(valid);
  transformed.alternatives[0]!.omissions = [{
    kind: "transformation-loss", reason: "normalization", affectedSource: body,
    affectedDecodedUtf16: { start: 0, end: 12 }, omittedUnits: "unknown", description: "terminal control transformation",
  }];
  assert.equal(isReducerEnvelope(transformed), true);
  for (const reason of ["routine", "middle", "budget"]) {
    transformed.alternatives[0]!.omissions[0]!.reason = reason;
    assert.equal(isReducerEnvelope(transformed), true);
  }
  for (const provenance of ["original", "generated", "mixed"]) {
    assert.equal(isReducerEnvelope({ ...valid, provenance }), true);
  }
  assert.equal(isReducerEnvelope({ ...valid, provenance: undefined }), false);
  assert.equal(isReducerEnvelope({ ...valid, provenance: "independent-copy" }), false);
  transformed.alternatives[0]!.omissions[0]!.omittedUnits = 2;
  assert.equal(isReducerEnvelope(transformed), false);
  const notLossy = clone(valid);
  notLossy.alternatives[0]!.lossy = false;
  assert.equal(isReducerEnvelope(notLossy), false);
  const lostCueRef = clone(valid);
  lostCueRef.alternatives[0]!.protectedCues[0]!.source = { ...body, bodyHash: h("9") };
  assert.equal(isReducerEnvelope(lostCueRef), false);
});

test("paired joins admit only an earlier catalog-verified source and the exact result", () => {
  const call = { ...raw, segment: 2, eventSeq: 4, ordinal: 4 };
  const valid = envelope();
  valid.pair = { kind: "paired-call", verifiedBy: "catalog-view-ancestry-v1", call, result: body };
  assert.equal(isReducerEnvelope(valid), true);

  const future = clone(valid);
  future.pair!.call.eventSeq = 9;
  assert.equal(isReducerEnvelope(future), false);
  const sameEventOrdered = clone(valid);
  sameEventOrdered.pair!.call = raw;
  assert.equal(isReducerEnvelope(sameEventOrdered), true);
  const sameEventWrongOrder = clone(valid);
  sameEventWrongOrder.pair!.call = { ...raw, descriptor: 4 };
  assert.equal(isReducerEnvelope(sameEventWrongOrder), false);
  const sibling = clone(valid);
  sibling.pair!.call.catalogStoreKey = "33333333-3333-4333-8333-333333333333";
  assert.equal(isReducerEnvelope(sibling), false);
});

test("derive cursors are branch-lineage scoped but can resume into a compatible append view", () => {
  const oldView = { ...view, eventCut: 8, segments: [{ segment: 2, cut: 5 }, { segment: 7, cut: 8 }] };
  const cursor = {
    v: 1, identity, view: oldView, afterEventSeq: 8, afterDescriptor: 3,
    bodyRawOffset: 0, bodyDecodedOffset: 0,
  };
  assert.equal(isCapsuleWorkerRequest({
    v: 1, derivedDirectory: "/tmp/synthetic-derived", catalogDirectory: "/tmp/synthetic-catalog", identity, op: "derivePage", view, cursor,
  }), true);
  assert.equal(isCapsuleWorkerRequest({
    v: 1, derivedDirectory: "/tmp/synthetic-derived", catalogDirectory: "/tmp/synthetic-catalog", identity, op: "derivePage",
    view: { ...view, branchKey: "branch-sibling" }, cursor,
  }), false);
  assert.equal(isCapsuleWorkerRequest({
    v: 1, derivedDirectory: "/tmp/synthetic-derived", catalogDirectory: "/tmp/synthetic-catalog", identity, op: "derivePage",
    view: { ...view, segments: [{ segment: 2, cut: 5 }, { segment: 8, cut: 9 }] }, cursor,
  }), false);
});

test("bounded requests reject full-body and oversized routes", () => {
  assert.equal(isCapsuleWorkerRequest({
    v: 1, derivedDirectory: "/tmp/synthetic-derived", catalogDirectory: "/tmp/synthetic-catalog", identity, op: "chunkRange", view, source: body,
    decodedStart: 0, decodedLength: 12, limit: 1,
  }), true);
  assert.equal(isCapsuleWorkerRequest({
    v: 1, derivedDirectory: "/tmp/synthetic-derived", catalogDirectory: "/tmp/synthetic-catalog", identity, op: "chunkRange", view, source: raw,
    decodedStart: 0, decodedLength: 12,
  }), false);
  assert.equal(isCapsuleWorkerRequest({
    v: 1, derivedDirectory: "/tmp/synthetic-derived", catalogDirectory: "/tmp/synthetic-catalog", identity, op: "chunkRange", view, source: body,
    decodedStart: 0, decodedLength: 65_536,
  }), false);
  assert.equal(isCapsuleWorkerRequest({
    v: 1, derivedDirectory: "/tmp/synthetic-derived", catalogDirectory: "/tmp/synthetic-catalog", identity, op: "capsulePage", view, limit: 17,
  }), false);
});

test("capsule and chunk readiness remain independent and exclusions do not count as reduced", () => {
  const readiness = {
    v: 1, identity, view, catalog: "lagging",
    capsules: { layer: "capsules", state: "ready", eligible: 7, ready: 7, unsupported: 0, failed: 0, excluded: 2, afterEventSeq: 9, afterDescriptor: 0, resumable: false },
    chunks: { layer: "chunks", state: "failed", eligible: 7, ready: 4, unsupported: 1, failed: 1, excluded: 2, afterEventSeq: 8, afterDescriptor: 3, resumable: true, marker: "bounded-regeneration-required" },
  };
  assert.equal(isCapsuleReadiness(readiness), true);
  assert.equal(isCapsuleReadiness({ ...readiness, capsules: { ...readiness.capsules, ready: 9 } }), false);
  assert.equal(isCapsuleReadiness({ ...readiness, chunks: { ...readiness.chunks, state: "ready" } }), false);
});

test("canonical content manifests exclude job cursors while receipts bind durable checkpoint publication", () => {
  const segment = { kind: "capsules", schemaVersion: 1, hashAlgorithm: SEGMENT_CONTENT_HASH, hash: h("6"), bytes: 200, records: 2,
    first: { eventSeq: 4, descriptor: 0 }, last: { eventSeq: 8, descriptor: 3 } };
  const manifest = { v: 1, schemaVersion: 1, identity, layer: "capsules", segment, hashAlgorithm: SEGMENT_CONTENT_HASH, hash: h("8") };
  assert.equal(isDerivedManifest(manifest), true);
  assert.equal("view" in manifest, false);
  assert.equal("cursor" in manifest, false);
  assert.equal(isDerivedManifest({ ...manifest, segment: { ...segment, last: { eventSeq: 3, descriptor: 0 } } }), false);

  const cursor = { v: 1, identity, view, afterEventSeq: 9, afterDescriptor: 0, bodyRawOffset: 0, bodyDecodedOffset: 0 };
  const receipt = {
    v: 1, identity, view, manifestHashes: [h("8")], cursor,
    hashAlgorithm: SEGMENT_CONTENT_HASH, receiptHash: h("9"), publication: "durable",
  };
  assert.equal(isDerivedPublicationReceipt(receipt), true);
  assert.equal(isDerivedPublicationReceipt({ ...receipt, publication: "staged" }), false);
});
