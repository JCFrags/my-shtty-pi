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
import { executeSearchV3Request } from "../src/search-v3-store.js";
import { executeCatalogStoreRequest } from "../src/catalog-store.js";
import { CatalogSqlite } from "../src/catalog-sqlite.js";
import { runSearchV3Worker } from "../src/search-v3-worker-client.js";
import { isSearchV3Handle, type SearchV3Identity, type SearchV3Request } from "../src/search-v3-contract.js";
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

test("ingest bounds empty noncomplete enumeration pages and persists their cursor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chrono-search-enumeration-"));
  const catalogStoreKey = randomUUID(), capsuleStoreKey = randomUUID();
  const view: CapsuleCatalogView = { storeKey: catalogStoreKey, sessionKey: "enumeration-fixture", generation: 1, eventCut: 1,
    branchKey: "main", segments: [{ segment: 1, cut: 1 }] };
  const capsuleIdentity: DerivedStoreIdentity = { storeKey: capsuleStoreKey, sessionKey: view.sessionKey, catalogStoreKey, catalogGeneration: 1,
    derivedSchemaVersion: DERIVED_SCHEMA_VERSION, capsuleSchemaVersion: CAPSULE_SCHEMA_VERSION, chunkSchemaVersion: CHUNK_SCHEMA_VERSION,
    reducerSetVersion: CAPSULE_REDUCER_PIPELINE_VERSION, configHash: createHash("sha256").update("enumeration-capsule").digest("hex") };
  const identity: SearchV3Identity = { storeKey: randomUUID(), capsule: capsuleIdentity, schemaVersion: 1,
    configHash: createHash("sha256").update("enumeration-search").digest("hex") };
  let calls = 0;
  const capsuleExecutor = async (request: any): Promise<any> => {
    calls++;
    assert.equal(request.op, "chunkSourcePage"); assert.equal(request.maxDescriptors, 64);
    return { v: 1, ok: true, result: { sources: [], next: { afterEventSeq: 1, afterDescriptor: (request.afterDescriptor ?? 0) + 64 }, complete: false },
      sourceBytes: 0, sqliteNativeLimitBytes: CAPSULE_LIMITS.nativeSqliteBytes };
  };
  try {
    const base = { v: 1 as const, searchDirectory: join(directory, "search"), capsuleDirectory: join(directory, "capsules"),
      catalogDirectory: join(directory, "catalog"), identity, op: "ingestPage" as const, view, maxSources: 1, maxChunks: 1 };
    const first = await executeSearchV3Request(base, { capsuleExecutor });
    assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(calls, 4);
    if (!first.ok) return;
    assert.equal((first.result as any).complete, false); assert.equal((first.result as any).cursor.afterDescriptor, 256);
    assert.equal((first.result as any).metrics.enumerationDescriptorsLimit, 256);
    const second = await executeSearchV3Request(base, { capsuleExecutor });
    assert.equal(second.ok, true, JSON.stringify(second)); assert.equal(calls, 8);
    if (second.ok) assert.equal((second.result as any).cursor.afterDescriptor, 512);
    const db = CatalogSqlite.open(join(directory, "search", "search.sqlite"));
    try {
      const plan = [...db.prepare("EXPLAIN QUERY PLAN SELECT d.sourceKey FROM raw_fts JOIN chunks c ON c.sourceKey=raw_fts.sourceKey AND c.chunkIndex=raw_fts.chunkIndex JOIN documents d ON d.sourceKey=c.sourceKey WHERE raw_fts MATCH ? LIMIT ?")
        .iterate(16, "needle", 129)].map(row => String(row.detail)).join(" | ");
      assert.match(plan, /VIRTUAL TABLE INDEX/); assert.doesNotMatch(plan, /TEMP B-TREE/);
    } finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("chunk-source traversal bounds visited empty events as well as descriptors", async () => {
  const records: string[] = [];
  for (let index = 0; index < CAPSULE_LIMITS.deriveEvents * 2; index++) records.push(JSON.stringify({ type: "message", id: `e${index}`,
    parentId: index ? `e${index - 1}` : null, message: { role: "user", content: [] } }) + "\n");
  const fixture = setupCapsuleFixture(records.join(""));
  try {
    const view = await fixture.initialize(`e${records.length - 1}`);
    await deriveAll(fixture, view);
    const page = await fixture.ok(view, { op: "chunkSourcePage", limit: 1, maxDescriptors: CAPSULE_LIMITS.deriveDescriptors });
    assert.equal(page.sources.length, 0);
    assert.equal(page.complete, false);
    assert.equal(page.readiness.visitedEvents, CAPSULE_LIMITS.deriveEvents);
    assert.equal(page.readiness.scannedDescriptors, 0);
    assert.equal(page.next.afterEventSeq, CAPSULE_LIMITS.deriveEvents);
  } finally { fixture.cleanup(); }
});

test("literal search finds capsule-omitted text and recall recovers the exact source", async () => {
  const phrase = "violet marmalade station", path = "/Repo/SRC/Foo.ts", identifier = "BuildIdentifierAlpha";
  let text = `${path} ${identifier} ${"head ordinary words ".repeat(2_400)}İ${phrase}${" tail ordinary words".repeat(2_400)}`;
  text = `${text.slice(0, CAPSULE_LIMITS.decodedChunkUnits - 1)}AB${text.slice(CAPSULE_LIMITS.decodedChunkUnits + 1)}`;
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
    assert.equal(isSearchV3Handle(hit.handle), true);
    assert.equal(hit.independentEvidence, true);
    assert.equal(hit.handle.evidence, "raw-source");
    assert.equal(hit.handle.decodedUtf16.start, text.indexOf(phrase), "case folding must not shift UTF-16 source coordinates");
    const indexedSubstring = await run({ v: 1, searchDirectory, capsuleDirectory: fixture.derivedDirectory, catalogDirectory: fixture.catalogDirectory,
      identity, op: "query", view, query: "iolet", mode: "literal", limit: 2 });
    assert.equal(indexedSubstring.ok, true, JSON.stringify(indexedSubstring));
    if (indexedSubstring.ok) {
      assert.equal((indexedSubstring.result as any).hits.length, 0);
      assert.equal((indexedSubstring.result as any).complete, false);
      assert.equal((indexedSubstring.result as any).coverage, "indexed-token-candidates");
    }
    const scannedSubstring = await run({ v: 1, searchDirectory, capsuleDirectory: fixture.derivedDirectory, catalogDirectory: fixture.catalogDirectory,
      identity, op: "query", view, query: "iolet", mode: "literal", limit: 2, scan: { maxChunks: 8, maxMs: 250 } });
    assert.equal(scannedSubstring.ok, true, JSON.stringify(scannedSubstring));
    if (scannedSubstring.ok) assert.equal((scannedSubstring.result as any).hits[0].handle.decodedUtf16.start, text.indexOf("iolet"));
    const recalled = await run({ v: 1, searchDirectory, capsuleDirectory: fixture.derivedDirectory,
      catalogDirectory: fixture.catalogDirectory, identity, op: "recall", view, handle: { ...hit.handle, evidence: "generated-cue" } });
    assert.equal(recalled.ok, true, JSON.stringify(recalled));
    if (recalled.ok) {
      assert.ok((recalled.result as any).text.includes(phrase));
      assert.equal((recalled.result as any).independentEvidence, true, "stored provenance, not the mutable handle label, controls recall evidence");
      assert.equal((recalled.result as any).generatedRetrieval, false);
    }
    const ranked = await run({ v: 1, searchDirectory, capsuleDirectory: fixture.derivedDirectory, catalogDirectory: fixture.catalogDirectory,
      identity, op: "query", view, query: `${identifier} absent`, mode: "ranked", limit: 2 });
    assert.equal(ranked.ok, true, JSON.stringify(ranked));
    if (ranked.ok) for (const item of (ranked.result as any).hits) {
      assert.equal(isSearchV3Handle(item.handle), true);
      const span = item.handle.decodedUtf16;
      if (span) assert.match(text.slice(span.start, span.end), /BuildIdentifierAlpha/iu, "ranked spans must identify actual source text");
    }
    const filtered = await run({ v: 1, searchDirectory, capsuleDirectory: fixture.derivedDirectory, catalogDirectory: fixture.catalogDirectory,
      identity, op: "query", view, query: phrase, mode: "ranked", filters: { kinds: [hit.kind], path: "src\\foo.ts", identifier: identifier.toLowerCase() }, limit: 2 });
    assert.equal(filtered.ok, true, JSON.stringify(filtered));
    if (filtered.ok) assert.equal((filtered.result as any).hits.length, 1);
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
    const internalEndAnchor = await run({ v: 1, searchDirectory, capsuleDirectory: fixture.derivedDirectory, catalogDirectory: fixture.catalogDirectory,
      identity, op: "query", view, query: "A$", mode: "regex", limit: 2, scan: { maxChunks: 8, maxMs: 250 } });
    assert.equal(internalEndAnchor.ok, true, JSON.stringify(internalEndAnchor));
    if (internalEndAnchor.ok) assert.equal((internalEndAnchor.result as any).hits.length, 0, "an internal decoded chunk end is not a source end");
    const unsupportedBoundary = await run({ v: 1, searchDirectory, capsuleDirectory: fixture.derivedDirectory, catalogDirectory: fixture.catalogDirectory,
      identity, op: "query", view, query: "\\bA", mode: "regex", limit: 2, scan: { maxChunks: 8, maxMs: 250 } });
    assert.equal(unsupportedBoundary.ok, false);
    if (!unsupportedBoundary.ok) assert.equal(unsupportedBoundary.code, "search-v3-regex-unsupported");
    const arbitraryRegex = await run({ v: 1, searchDirectory, capsuleDirectory: fixture.derivedDirectory, catalogDirectory: fixture.catalogDirectory,
      identity, op: "query", view, query: "violet.*station", mode: "regex", limit: 2, scan: { maxChunks: 8, maxMs: 250 } });
    assert.equal(arbitraryRegex.ok, true, JSON.stringify(arbitraryRegex));
    if (arbitraryRegex.ok) {
      assert.equal((arbitraryRegex.result as any).exhaustive, false);
      assert.equal((arbitraryRegex.result as any).coverage, "explicit-bounded-regex-windows-nonexhaustive");
    }
    const status = await run({ v: 1, searchDirectory, capsuleDirectory: fixture.derivedDirectory, catalogDirectory: fixture.catalogDirectory,
      identity, op: "status", view });
    assert.equal(status.ok, true, JSON.stringify(status));
    if (status.ok) {
      assert.equal((status.result as any).readiness.raw, "ready");
      assert.equal((status.result as any).requestedView.eventCut, view.eventCut);
      assert.equal((status.result as any).indexedView.eventCut, view.eventCut);
    }
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
    const lagging = await run({ v: 1, searchDirectory, capsuleDirectory, catalogDirectory, identity: searchIdentity,
      op: "status", view: newMain });
    assert.equal(lagging.ok, true, JSON.stringify(lagging));
    if (lagging.ok) {
      assert.equal((lagging.result as any).readiness.raw, "partial");
      assert.equal((lagging.result as any).indexedView.eventCut, oldMain.eventCut);
      assert.equal((lagging.result as any).requestedView.eventCut, newMain.eventCut);
      assert.equal((lagging.result as any).error, "search-v3-index-lag");
    }
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
      op: "range", view: fork, limit: 2 });
    assert.equal(chronology.ok, true, JSON.stringify(chronology));
    if (chronology.ok) {
      assert.equal(typeof (chronology.result as any).nextCursor, "string");
      const continued = await run({ v: 1, searchDirectory, capsuleDirectory, catalogDirectory, identity: searchIdentity,
        op: "range", view: fork, limit: 2, cursor: (chronology.result as any).nextCursor });
      assert.equal(continued.ok, true, JSON.stringify(continued));
      if (continued.ok) {
        const all = [...(chronology.result as any).items, ...(continued.result as any).items];
        assert.deepEqual(all.map((item: any) => item.handle.source.entryId), ["a", "c1", "c2"]);
        for (const item of all) {
          assert.equal(isSearchV3Handle(item.handle), true);
          const exact = await run({ v: 1, searchDirectory, capsuleDirectory, catalogDirectory, identity: searchIdentity,
            op: "recall", view: fork, handle: item.handle, decodedStart: item.handle.source.decodedUtf16.start, decodedLength: 1 });
          assert.equal(exact.ok, true, JSON.stringify(exact));
          if (exact.ok) assert.equal((exact.result as any).exact, true);
        }
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
