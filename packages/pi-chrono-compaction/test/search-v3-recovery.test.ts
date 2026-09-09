import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CAPSULE_LIMITS, CAPSULE_REDUCER_PIPELINE_VERSION, CAPSULE_SCHEMA_VERSION, CHUNK_SCHEMA_VERSION, DERIVED_SCHEMA_VERSION,
  type CapsuleCatalogView, type DerivedStoreIdentity,
} from "../src/capsule-contract.js";
import { executeCapsuleRequest } from "../src/capsule-store.js";
import { executeCatalogStoreRequest } from "../src/catalog-store.js";
import { runSearchV3Worker } from "../src/search-v3-worker-client.js";
import type { SearchV3Identity, SearchV3Request } from "../src/search-v3-contract.js";
import { line, setupCapsuleFixture } from "./capsule-storage-fixture.js";

async function deriveAll(fixture: ReturnType<typeof setupCapsuleFixture>, view: CapsuleCatalogView): Promise<void> {
  let cursor: any;
  for (let page = 0; page < 300; page++) {
    const result = await fixture.ok(view, { op: "derivePage", ...(cursor ? { cursor } : {}) });
    cursor = result.cursor;
    if (result.complete) return;
  }
  assert.fail("capsule derivation did not complete");
}
async function searchAll(fixture: ReturnType<typeof setupCapsuleFixture>, view: CapsuleCatalogView, identity: SearchV3Identity, searchDirectory: string, schedulerDirectory: string): Promise<void> {
  for (let page = 0; page < 300; page++) {
    const response = await runSearchV3Worker({ v: 1, searchDirectory, capsuleDirectory: fixture.derivedDirectory,
      catalogDirectory: fixture.catalogDirectory, identity, op: "ingestPage", view, maxSources: 2, maxChunks: 2 }, { schedulerDirectory, slots: 1 });
    assert.equal(response.ok, true, JSON.stringify(response));
    if (response.ok && (response.result as any).complete) return;
  }
  assert.fail("search ingestion did not complete");
}

test("literal search finds capsule-omitted text and recall recovers the exact source", async () => {
  const phrase = "violet marmalade station";
  const text = `${"head ordinary words ".repeat(2_400)}${phrase}${" tail ordinary words".repeat(2_400)}`;
  assert.ok(text.length > CAPSULE_LIMITS.reducerInputUnits);
  const fixture = setupCapsuleFixture(line("a", null, text));
  try {
    const view = await fixture.initialize();
    await deriveAll(fixture, view);
    const capsule = (await fixture.ok(view, { op: "capsulePage", limit: 1 })).capsules[0];
    assert.equal(capsule.alternatives[0].text.includes(phrase), false, "fixture must prove cue reduction omitted the phrase");
    const searchDirectory = join(fixture.directory, "search"); mkdirSync(searchDirectory, { mode: 0o700 });
    const identity: SearchV3Identity = { storeKey: randomUUID(), capsule: fixture.identity, schemaVersion: 1,
      configHash: createHash("sha256").update("search-config").digest("hex") };
    const schedulerDirectory = join(fixture.directory, "scheduler"); mkdirSync(schedulerDirectory, { mode: 0o700 });
    const run = (request: SearchV3Request) => runSearchV3Worker(request, { schedulerDirectory, slots: 1 });
    await searchAll(fixture, view, identity, searchDirectory, schedulerDirectory);
    const found = await run({ v: 1, searchDirectory, capsuleDirectory: fixture.derivedDirectory,
      catalogDirectory: fixture.catalogDirectory, identity, op: "query", view, query: phrase, mode: "literal", limit: 2 });
    assert.equal(found.ok, true, JSON.stringify(found));
    if (!found.ok) return;
    const hit = (found.result as any).hits[0];
    assert.equal(hit.independentEvidence, true);
    assert.equal(hit.handle.evidence, "raw-source");
    const recalled = await run({ v: 1, searchDirectory, capsuleDirectory: fixture.derivedDirectory,
      catalogDirectory: fixture.catalogDirectory, identity, op: "recall", view, handle: hit.handle });
    assert.equal(recalled.ok, true, JSON.stringify(recalled));
    if (recalled.ok) assert.ok((recalled.result as any).text.includes(phrase));
    const sourceLookup = await run({ v: 1, searchDirectory, capsuleDirectory: fixture.derivedDirectory, catalogDirectory: fixture.catalogDirectory,
      identity, op: "sources", view, eventSeq: hit.handle.source.eventSeq, blockIndex: hit.handle.source.blockIndex, limit: 2 });
    assert.equal(sourceLookup.ok, true, JSON.stringify(sourceLookup));
    if (sourceLookup.ok) assert.deepEqual((sourceLookup.result as any).sources[0].handle.source, hit.handle.source);
    const implicitRegex = await run({ v: 1, searchDirectory, capsuleDirectory: fixture.derivedDirectory, catalogDirectory: fixture.catalogDirectory,
      identity, op: "query", view, query: "violet|absent", mode: "regex", limit: 2 });
    assert.equal(implicitRegex.ok, false); if (!implicitRegex.ok) assert.equal(implicitRegex.code, "search-v3-scan-required");
    const explicitRegex = await run({ v: 1, searchDirectory, capsuleDirectory: fixture.derivedDirectory, catalogDirectory: fixture.catalogDirectory,
      identity, op: "query", view, query: "violet|absent", mode: "regex", limit: 2, scan: { maxChunks: 8, maxMs: 250 } });
    assert.equal(explicitRegex.ok, true, JSON.stringify(explicitRegex));
    if (explicitRegex.ok) assert.equal((explicitRegex.result as any).hits.length, 1);
  } finally { fixture.cleanup(); }
});

test("append restart keeps a cursor generation pinned and real fork views isolated", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chrono-search-branch-"));
  const catalogDirectory = join(directory, "catalog"), capsuleDirectory = join(directory, "capsules"), searchDirectory = join(directory, "search");
  const rootPath = join(directory, "root.jsonl"), mainPath = join(directory, "main.jsonl"), forkPath = join(directory, "fork.jsonl");
  const schedulerDirectory = join(directory, "scheduler"); mkdirSync(schedulerDirectory, { mode: 0o700 });
  const sessionKey = "search-branch-fixture", phrase = "amber compass";
  writeFileSync(rootPath, line("a", null, "root"), { mode: 0o600 });
  writeFileSync(mainPath, line("b1", "a", `${phrase} main one`) + line("b2", "b1", `${phrase} main two`), { mode: 0o600 });
  writeFileSync(forkPath, line("c1", "a", `${phrase} fork one`) + line("c2", "c1", `${phrase} fork two`), { mode: 0o600 });
  const catalog = async (extra: Record<string, unknown>): Promise<Record<string, any>> => {
    const response = await executeCatalogStoreRequest({ v: 1, catalogDirectory, sessionKey, ...extra });
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.ok ? response.result : {};
  };
  const ingestRoot = () => catalog({ op: "ingestStep", shardKey: "s0", sourcePath: rootPath, branchKey: "root", shardOrdinal: 0 });
  const ingestMain = () => catalog({ op: "ingestStep", shardKey: "s1", sourcePath: mainPath, branchKey: "main", shardOrdinal: 1, parent: { shardKey: "s0", eventId: "a" } });
  const ingestFork = () => catalog({ op: "ingestStep", shardKey: "s2", sourcePath: forkPath, branchKey: "fork", shardOrdinal: 2, parent: { shardKey: "s0", eventId: "a" } });
  const pin = async (branchKey: string, shardKey: string, eventId: string): Promise<CapsuleCatalogView> => (await catalog({ op: "pin", branchKey, leaf: { shardKey, eventId } })).view;
  try {
    await ingestRoot(); await ingestMain();
    const oldMain = await pin("main", "s1", "b2");
    const capsuleIdentity: DerivedStoreIdentity = { storeKey: randomUUID(), sessionKey, catalogStoreKey: oldMain.storeKey,
      catalogGeneration: oldMain.generation, derivedSchemaVersion: DERIVED_SCHEMA_VERSION, capsuleSchemaVersion: CAPSULE_SCHEMA_VERSION,
      chunkSchemaVersion: CHUNK_SCHEMA_VERSION, reducerSetVersion: CAPSULE_REDUCER_PIPELINE_VERSION,
      configHash: createHash("sha256").update("branch-capsules").digest("hex") };
    const searchIdentity: SearchV3Identity = { storeKey: randomUUID(), capsule: capsuleIdentity, schemaVersion: 1,
      configHash: createHash("sha256").update("branch-search").digest("hex") };
    const derive = async (view: CapsuleCatalogView): Promise<void> => {
      let cursor: any;
      for (let page = 0; page < 100; page++) {
        const response = await executeCapsuleRequest({ v: 1, derivedDirectory: capsuleDirectory, catalogDirectory, identity: capsuleIdentity,
          op: "derivePage", view, ...(cursor ? { cursor } : {}), maxEvents: 2, maxDescriptors: 4 });
        assert.equal(response.ok, true, JSON.stringify(response));
        if (!response.ok) return;
        cursor = (response.result as any).cursor;
        if ((response.result as any).complete) return;
      }
      assert.fail("branch capsules did not complete");
    };
    const run = (request: SearchV3Request) => runSearchV3Worker(request, { schedulerDirectory, slots: 1 });
    const ingestSearch = async (view: CapsuleCatalogView): Promise<Record<string, any>> => {
      for (let page = 0; page < 100; page++) {
        const response = await run({ v: 1, searchDirectory, capsuleDirectory, catalogDirectory, identity: searchIdentity,
          op: "ingestPage", view, maxSources: 2, maxChunks: 2 });
        assert.equal(response.ok, true, JSON.stringify(response));
        if (response.ok && (response.result as any).complete) return response.result as Record<string, any>;
      }
      return assert.fail("branch search did not complete");
    };
    await derive(oldMain); await ingestSearch(oldMain);
    const first = await run({ v: 1, searchDirectory, capsuleDirectory, catalogDirectory, identity: searchIdentity,
      op: "query", view: oldMain, query: phrase, mode: "literal", limit: 1 });
    assert.equal(first.ok, true, JSON.stringify(first)); if (!first.ok) return;
    const firstResult = first.result as any; assert.equal(firstResult.hits.length, 1); assert.equal(typeof firstResult.nextCursor, "string");
    const pinnedGeneration = firstResult.indexGeneration;

    appendFileSync(mainPath, line("b3", "b2", `${phrase} main appended`));
    await ingestMain(); await ingestFork();
    const fork = await pin("fork", "s2", "c2"), newMain = await pin("main", "s1", "b3");
    await derive(fork);
    const forkCapsules = await executeCapsuleRequest({ v: 1, derivedDirectory: capsuleDirectory, catalogDirectory, identity: capsuleIdentity,
      op: "capsulePage", view: fork, limit: 12 });
    assert.equal(forkCapsules.ok, true, JSON.stringify(forkCapsules));
    if (forkCapsules.ok) assert.deepEqual((forkCapsules.result as any).capsules.map((item: any) => item.source.entryId), ["a", "c1", "c2"]);
    const forkIngest = await ingestSearch(fork);
    assert.ok(forkIngest.readiness.cueReady >= 3 && forkIngest.readiness.rawReady >= 3, JSON.stringify(forkIngest));
    await derive(newMain); await ingestSearch(newMain);

    const resumed = await run({ v: 1, searchDirectory, capsuleDirectory, catalogDirectory, identity: searchIdentity,
      op: "query", view: oldMain, query: phrase, mode: "literal", limit: 1, cursor: firstResult.nextCursor });
    assert.equal(resumed.ok, true, JSON.stringify(resumed)); if (!resumed.ok) return;
    assert.equal((resumed.result as any).indexGeneration, pinnedGeneration);
    assert.equal((resumed.result as any).hits.length, 1);
    assert.ok(["b1", "b2"].includes((resumed.result as any).hits[0].handle.source.entryId));

    const forkResult = await run({ v: 1, searchDirectory, capsuleDirectory, catalogDirectory, identity: searchIdentity,
      op: "query", view: fork, query: phrase, mode: "literal", limit: 12 });
    assert.equal(forkResult.ok, true, JSON.stringify(forkResult)); if (!forkResult.ok) return;
    assert.deepEqual(new Set((forkResult.result as any).hits.map((item: any) => item.handle.source.entryId)), new Set(["c1", "c2"]), JSON.stringify(forkResult.result));
    const chronology = await run({ v: 1, searchDirectory, capsuleDirectory, catalogDirectory, identity: searchIdentity,
      op: "range", view: fork, limit: 12 });
    assert.equal(chronology.ok, true, JSON.stringify(chronology));
    if (chronology.ok) assert.deepEqual((chronology.result as any).items.map((item: any) => item.handle.source.entryId), ["a", "c1", "c2"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
