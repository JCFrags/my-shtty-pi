import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseHistoricalBlocks } from "../src/blocks.js";
import {
  adaptVerifiedCapsulesToPrecomputedCandidates,
  createVerifiedCapsuleBindings,
  type CapsuleCatalogExecutor,
} from "../src/capsule-compatibility.js";
import type {
  CapsuleAlternative,
  CapsuleCatalogView,
  DerivedStoreIdentity,
  ReducerEnvelope,
  ScopedBodySourceRef,
  ScopedRawSourceRef,
} from "../src/capsule-contract.js";
import { executeCatalogRequest } from "../src/catalog-engine.js";
import type { CatalogResponse, CatalogView } from "../src/catalog-contract.js";
import { createCatalogHash, catalogHashUnit, finishCatalogHash } from "../src/catalog-parser-hash.js";
import { buildCandidateUnits } from "../src/candidates.js";
import { compactEntries, resolveCompactorConfig } from "../src/compactor.js";
import { planCompression } from "../src/planner.js";
import type { HistoricalBlock, SessionEntryLike } from "../src/types.js";

const config = resolveCompactorConfig({ targetTokens: 1_400, enableSemanticCompression: false, mergeEpisodes: false });
const executeCatalog: CapsuleCatalogExecutor = async request => executeCatalogRequest(request);

function textHash(text: string): string {
  const state = createCatalogHash();
  for (let index = 0; index < text.length; index += 1) catalogHashUnit(state, text.charCodeAt(index));
  return finishCatalogHash(state);
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "capsule-compatibility-"));
  const source = join(directory, "source.jsonl");
  const entries: SessionEntryLike[] = [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "Inspect the synthetic test output." } },
    { type: "message", id: "c1", parentId: "u1", message: { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "test", arguments: { path: "synthetic.test.ts" } }] } },
    { type: "message", id: "r1", parentId: "c1", message: { role: "toolResult", toolCallId: "tool-1", toolName: "test", isError: true,
      content: [{ type: "text", text: ["TAP version 13", ...Array.from({ length: 180 }, (_, index) => `not ok ${index} - expected active=${index} received active=${index + 1}`), "1..180"].join("\n") }] } },
  ];
  const wire = entries.map(entry => JSON.stringify(entry) + "\n").join("");
  writeFileSync(source, wire, { mode: 0o600 });
  const base = { v: 1 as const, catalogDirectory: directory, sessionKey: "synthetic" };
  const request = (request: Record<string, unknown>): CatalogResponse => executeCatalogRequest({ ...base, ...request });
  const ok = (requestValue: Record<string, unknown>): Record<string, any> => {
    const response = request(requestValue);
    assert.equal(response.ok, true, JSON.stringify(response));
    return (response as { result: Record<string, any> }).result;
  };
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (ok({ op: "ingestStep", shardKey: "s1", sourcePath: source, branchKey: "main", shardOrdinal: 0 }).caughtUp) break;
  }
  const view = ok({ op: "pin", branchKey: "main", leaf: { shardKey: "s1", eventId: "r1" } }).view as CatalogView;
  const eventPage = ok({ op: "page", view });
  const events = eventPage.events as Array<Record<string, any>>;
  const callEvent = events.find(event => event.metadata.id === "c1")!;
  const resultEvent = events.find(event => event.metadata.id === "r1")!;
  const callDescriptors = ok({ op: "blocks", view, eventSeq: callEvent.seq }).blocks as Array<Record<string, any>>;
  const resultDescriptors = ok({ op: "blocks", view, eventSeq: resultEvent.seq }).blocks as Array<Record<string, any>>;
  const callRow = callDescriptors.find(row => row.metadata.kind === "block")!;
  const bodyRow = resultDescriptors.find(row => row.metadata.kind === "body" && row.metadata.field === "text")!;
  const segment = (eventSeq: number) => view.segments.find(item => eventSeq <= item.cut)!.segment;
  const callBytes = readFileSync(source).subarray(callRow.metadata.rawStart, callRow.metadata.rawEnd);
  const callRef: ScopedRawSourceRef = {
    catalogStoreKey: view.storeKey, sessionKey: view.sessionKey, catalogGeneration: view.generation,
    shardKey: callEvent.shardKey, segment: segment(callEvent.seq), eventSeq: callEvent.seq, ordinal: callEvent.ordinal,
    descriptor: callRow.index, blockIndex: callRow.metadata.index, field: "tool-call", raw: { start: callRow.metadata.rawStart, end: callRow.metadata.rawEnd },
    entryId: "c1", coordinateKind: "raw-json", rawHashAlgorithm: "sha256-bytes-v1",
    rawHash: createHash("sha256").update(callBytes).digest("hex"),
  };
  const bodyRef: ScopedBodySourceRef = {
    catalogStoreKey: view.storeKey, sessionKey: view.sessionKey, catalogGeneration: view.generation,
    shardKey: resultEvent.shardKey, segment: segment(resultEvent.seq), eventSeq: resultEvent.seq, ordinal: resultEvent.ordinal,
    descriptor: bodyRow.index, blockIndex: bodyRow.metadata.blockIndex, field: bodyRow.metadata.field,
    raw: { start: bodyRow.metadata.rawStart, end: bodyRow.metadata.rawEnd }, entryId: "r1", coordinateKind: "decoded-body",
    decodedUtf16: { start: bodyRow.metadata.decodedStart, end: bodyRow.metadata.decodedEnd },
    bodyHashAlgorithm: "chrono-utf16le-chain-sha256-v1", bodyHash: bodyRow.metadata.hash,
  };
  const block = parseHistoricalBlocks(entries).find(candidate => candidate.entryId === "r1")!;
  assert.equal(textHash(block.exactText), bodyRef.bodyHash);
  const capsuleView: CapsuleCatalogView = { ...view, segments: view.segments.map(item => ({ ...item })) };
  const identity: DerivedStoreIdentity = {
    storeKey: randomUUID(), sessionKey: view.sessionKey, catalogStoreKey: view.storeKey, catalogGeneration: view.generation,
    derivedSchemaVersion: 1, capsuleSchemaVersion: 1, chunkSchemaVersion: 1, reducerSetVersion: "synthetic-v1", configHash: "a".repeat(64),
  };
  const envelope = (text: string, family: ReducerEnvelope["family"] = "generic-text", familyVersion = "1.0.0", omissionDescription = "Synthetic omitted tail unit"): ReducerEnvelope => {
    const alternative: CapsuleAlternative = {
      alternative: 0, family, familyVersion, maxTokens: 600, text, lossy: true, facts: [], protectedCues: [],
      omissions: [{ kind: "exact-range", reason: "middle", source: bodyRef,
        decodedUtf16: { start: bodyRef.decodedUtf16.end - 1, end: bodyRef.decodedUtf16.end }, omittedUnits: 1, description: omissionDescription }],
      outcome: { status: "unknown" }, sourceRefs: [callRef, bodyRef],
    };
    return { v: 1, capsuleSchemaVersion: 1, identity, source: bodyRef, provenance: "original", family, familyVersion,
      reducerSetVersion: identity.reducerSetVersion, configHash: identity.configHash,
      budget: { maxTokens: 600, maxUtf16Units: 64 * 1024, maxAlternatives: 1 }, inputHash: "b".repeat(64),
      pair: { kind: "paired-call", verifiedBy: "catalog-view-ancestry-v1", call: callRef, result: bodyRef }, alternatives: [alternative] };
  };
  return { directory, source, entries, view: capsuleView, block, bodyRef, callRef, envelope };
}

async function currentReduction(fixture: ReturnType<typeof setup>) {
  const units = await buildCandidateUnits([fixture.block], config);
  const reduced = units[0]!.candidates.find(candidate => candidate.reducer === "generic-text");
  assert.ok(reduced, "synthetic output must exercise the current generic-text reducer");
  return reduced;
}

test("live M04 binding yields unchanged-seam equivalence while raw and normalized alternatives remain", async t => {
  const fixture = setup();
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }));
  const reduced = await currentReduction(fixture);
  const omission = reduced.omissions[0]!;
  const omissionDetails = [omission.omittedLines === undefined ? "" : `${omission.omittedLines} lines`, omission.omittedBytes === undefined ? "" : `${omission.omittedBytes} bytes`].filter(Boolean).join(", ");
  const established = await createVerifiedCapsuleBindings({ catalogDirectory: fixture.directory, view: fixture.view,
    associations: [{ block: fixture.block, envelope: fixture.envelope(reduced.text, "generic-text", "1.0.0", `${omission.description}${omissionDetails ? ` (${omissionDetails})` : ""}`) }] }, { executeCatalog });
  assert.equal(established.rejected.length, 0);
  assert.equal(established.bindings.length, 1);
  assert.ok(established.sourceBytes > 0 && established.sourceBytes <= 1024 * 1024);
  assert.ok(established.requestedRawBytes > 0 && established.requestedRawBytes <= 2 * 64 * 1024);
  const adapted = adaptVerifiedCapsulesToPrecomputedCandidates([fixture.block], config, established.bindings);
  assert.equal(adapted.accepted, 1);
  const coldUnits = await buildCandidateUnits([fixture.block], config);
  const warmUnits = await buildCandidateUnits([fixture.block], config, undefined, undefined, "", [fixture.block], adapted.records);
  const stableAlternatives = (unit: typeof coldUnits[number]) => unit.candidates.filter(candidate => candidate.level === "raw" || candidate.level === "normalized").map(candidate => [candidate.level, candidate.text]);
  assert.deepEqual(stableAlternatives(warmUnits[0]!), stableAlternatives(coldUnits[0]!));
  assert.deepEqual(warmUnits[0]!.candidates.map(candidate => [candidate.level, candidate.text]), coldUnits[0]!.candidates.map(candidate => [candidate.level, candidate.text]));
  const cold = await compactEntries(fixture.entries, { config });
  const warm = await compactEntries(fixture.entries, { config, precomputedCandidates: adapted.records });
  assert.equal(warm.summary, cold.summary);
  assert.deepEqual(warm.plan.units.map(unit => [unit.id, unit.selected.level, unit.selected.text]), cold.plan.units.map(unit => [unit.id, unit.selected.level, unit.selected.text]));
});

test("a valid differing capsule is an extra planner alternative, not persisted current-state policy", async t => {
  const fixture = setup();
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }));
  const capsuleText = "not ok: expected active=1 received active=2\nExact synthetic capsule; remaining output omitted.";
  const established = await createVerifiedCapsuleBindings({ catalogDirectory: fixture.directory, view: fixture.view,
    associations: [{ block: fixture.block, envelope: fixture.envelope(capsuleText) }] }, { executeCatalog });
  const adapted = adaptVerifiedCapsulesToPrecomputedCandidates([fixture.block], config, established.bindings);
  const cold = await buildCandidateUnits([fixture.block], config);
  const warm = await buildCandidateUnits([fixture.block], config, undefined, undefined, "", [fixture.block], adapted.records);
  assert.equal(cold[0]!.candidates.some(candidate => candidate.text === capsuleText), false);
  const capsuleCandidate = warm[0]!.candidates.find(candidate => candidate.text === capsuleText)!;
  assert.ok(capsuleCandidate);
  assert.equal(capsuleCandidate.lossy, true);
  assert.match(String(capsuleCandidate.metadata.capsulePhysicalSourceRefs), /catalogStoreKey/);
  assert.deepEqual(warm[0]!.candidates.filter(candidate => ["raw", "normalized"].includes(candidate.level)).map(candidate => candidate.text),
    cold[0]!.candidates.filter(candidate => ["raw", "normalized"].includes(candidate.level)).map(candidate => candidate.text));
  const selected = planCompression(warm, capsuleCandidate.tokens, config).units[0]!.selected;
  assert.equal(selected.text, capsuleText, "the existing planner, not the adapter, makes the contextual choice");
});

test("combined candidate text and source windows stay bounded", async t => {
  const fixture = setup();
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }));
  const large = "synthetic lossy capsule\n".repeat(950).slice(0, 22_000);
  const envelopes = [
    fixture.envelope(large, "generic-text", "1.0.0"),
    fixture.envelope(`${large}terminal`, "terminal", "2.0.0"),
    fixture.envelope(`${large}test`, "test-output", "1.0.0"),
  ];
  const established = await createVerifiedCapsuleBindings({ catalogDirectory: fixture.directory, view: fixture.view,
    associations: envelopes.map(envelope => ({ block: fixture.block, envelope })) }, { executeCatalog });
  assert.equal(established.bindings.length, 3);
  assert.equal(established.requestedRawBytes, fixture.bodyRef.raw.end - fixture.bodyRef.raw.start + fixture.callRef.raw.end - fixture.callRef.raw.start,
    "shared verified refs are counted once in the synthetic window");
  const adapted = adaptVerifiedCapsulesToPrecomputedCandidates([fixture.block], config, established.bindings);
  assert.equal(adapted.accepted, 2);
  assert.equal(adapted.rejected[0]?.reason, "candidate-ceiling");
  const total = [...adapted.records.values()][0]!.candidates.reduce((sum, candidate) => sum + candidate.text.length, 0);
  assert.ok(total <= 64 * 1024);
});

test("mismatched cuts, hashes, protected blocks, and unsupported families fall back without a record", async t => {
  const fixture = setup();
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }));
  const reduced = (await currentReduction(fixture)).text;
  const futureView = { ...fixture.view, eventCut: fixture.callRef.eventSeq,
    segments: fixture.view.segments.map(segment => ({ ...segment, cut: Math.min(segment.cut, fixture.callRef.eventSeq) })) };
  const future = await createVerifiedCapsuleBindings({ catalogDirectory: fixture.directory, view: futureView,
    associations: [{ block: fixture.block, envelope: fixture.envelope(reduced) }] }, { executeCatalog });
  assert.equal(future.bindings.length, 0);

  const badEnvelope = { ...fixture.envelope(reduced), source: { ...fixture.bodyRef, bodyHash: "f".repeat(64) } } as ReducerEnvelope;
  const badHash = await createVerifiedCapsuleBindings({ catalogDirectory: fixture.directory, view: fixture.view,
    associations: [{ block: fixture.block, envelope: badEnvelope }] }, { executeCatalog });
  assert.equal(badHash.bindings.length, 0);

  const wrongProvenance = { ...fixture.envelope(reduced), provenance: "generated" as const };
  const provenanceResult = await createVerifiedCapsuleBindings({ catalogDirectory: fixture.directory, view: fixture.view,
    associations: [{ block: fixture.block, envelope: wrongProvenance }] }, { executeCatalog });
  assert.equal(provenanceResult.bindings.length, 0);
  assert.equal(provenanceResult.rejected[0]?.reason, "provenance-mismatch");

  const protectedBlock = { ...fixture.block, protectedExact: true } as HistoricalBlock;
  const protectedResult = await createVerifiedCapsuleBindings({ catalogDirectory: fixture.directory, view: fixture.view,
    associations: [{ block: protectedBlock, envelope: fixture.envelope(reduced) }] }, { executeCatalog });
  assert.equal(protectedResult.bindings.length, 0);

  const unsupported = await createVerifiedCapsuleBindings({ catalogDirectory: fixture.directory, view: fixture.view,
    associations: [{ block: fixture.block, envelope: fixture.envelope(reduced, "lossless-normalizer", "1.0.0") }] }, { executeCatalog });
  assert.equal(unsupported.bindings.length, 1, "M04 validity is independent from compactor compatibility");
  const adapted = adaptVerifiedCapsulesToPrecomputedCandidates([fixture.block], config, unsupported.bindings);
  assert.equal(adapted.records.size, 0);
  assert.equal(adapted.rejected[0]?.reason, "unsupported-reducer");

  const cold = await buildCandidateUnits([fixture.block], config);
  const fallback = await buildCandidateUnits([fixture.block], config, undefined, undefined, "", [fixture.block], adapted.records);
  assert.deepEqual(fallback, cold);
});

test("factory performs exact raw verification and enforces explicit aggregate read and window bounds", async t => {
  const fixture = setup();
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }));
  const reduced = (await currentReduction(fixture)).text;
  const bounded = await createVerifiedCapsuleBindings({ catalogDirectory: fixture.directory, view: fixture.view,
    maxTotalSourceBytes: 1, associations: [{ block: fixture.block, envelope: fixture.envelope(reduced) }] }, { executeCatalog });
  assert.equal(bounded.bindings.length, 0);
  assert.equal(bounded.sourceBytes, 0, "the aggregate raw-range bound is enforced before catalog I/O");
  assert.equal(bounded.rejected[0]?.reason, "total-source-read-limit");
  await assert.rejects(() => createVerifiedCapsuleBindings({ catalogDirectory: fixture.directory, view: fixture.view,
    associations: Array.from({ length: 17 }, () => ({ block: fixture.block, envelope: fixture.envelope(reduced) })) }, { executeCatalog }), /capsule-binding-limit/);

  const original = readFileSync(fixture.source);
  const patched = Buffer.from(original);
  patched[fixture.bodyRef.raw.start + 1] = patched[fixture.bodyRef.raw.start + 1] === 120 ? 121 : 120;
  writeFileSync(fixture.source, patched);
  const tampered = await createVerifiedCapsuleBindings({ catalogDirectory: fixture.directory, view: fixture.view,
    associations: [{ block: fixture.block, envelope: fixture.envelope(reduced) }] }, { executeCatalog });
  assert.equal(tampered.bindings.length, 0);
  assert.match(tampered.rejected[0]?.reason ?? "", /^catalog-/);
});
