import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CAPSULE_REDUCER_PIPELINE_VERSION, CAPSULE_SCHEMA_VERSION, CHUNK_SCHEMA_VERSION, DERIVED_SCHEMA_VERSION,
  type CapsuleCatalogView, type DerivedStoreIdentity, type ReducerEnvelope, type ScopedBodySourceRef, type ScopedRawSourceRef,
} from "../src/capsule-contract.js";
import { executeCatalogStoreRequest } from "../src/catalog-store.js";
import { executeCapsuleRequest } from "../src/capsule-store.js";
import { reduceEpisodeStateEnvelope } from "../src/episode-state-reducer.js";
import { executeEpisodeStateRequest } from "../src/episode-state-store.js";
import { createMemoryEvent } from "../src/memory-store.js";
import type { SearchV3Identity } from "../src/search-v3-contract.js";

const message = (id: string, parentId: string | null, role: string, text: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: "message", id, parentId, message: { role, ...extra, content: [{ type: "text", text }] } }) + "\n";
const custom = (id: string, parentId: string, customType: string, data: unknown): string =>
  JSON.stringify({ type: "custom", id, parentId, customType, data }) + "\n";

function bodySource(eventSeq = 1, descriptor = 1): ScopedBodySourceRef {
  return { catalogStoreKey: randomUUID(), sessionKey: "reducer", catalogGeneration: 1, shardKey: "s", segment: 1,
    eventSeq, ordinal: eventSeq, descriptor, field: "text", raw: { start: 0, end: 1 }, coordinateKind: "decoded-body",
    decodedUtf16: { start: 0, end: 4096 }, bodyHashAlgorithm: "chrono-utf16le-chain-sha256-v1", bodyHash: "a".repeat(64) };
}
function rawSource(source: ScopedBodySourceRef, field: string): ScopedRawSourceRef {
  return { ...source, field, coordinateKind: "raw-json", rawHashAlgorithm: "sha256-bytes-v1", rawHash: "b".repeat(64) };
}
function envelope(source: ScopedBodySourceRef, role: string): ReducerEnvelope {
  return { v: 1, source, family: "generic", familyVersion: "test", reducerSetVersion: "test", configHash: "c".repeat(64),
    provenance: "original", alternatives: [], omissions: [], metrics: { inputUnits: 0, outputUnits: 0, windows: 1 } } as unknown as ReducerEnvelope;
}

async function deriveAll(capsuleDirectory: string, catalogDirectory: string, identity: DerivedStoreIdentity, view: CapsuleCatalogView): Promise<void> {
  let cursor: unknown;
  for (let page = 0; page < 100; page++) {
    const response = await executeCapsuleRequest({ v: 1, derivedDirectory: capsuleDirectory, catalogDirectory, identity,
      op: "derivePage", view, ...(cursor ? { cursor } : {}), maxEvents: 8, maxDescriptors: 16 });
    assert.equal(response.ok, true, JSON.stringify(response));
    if (!response.ok) return;
    cursor = (response.result as any).cursor;
    if ((response.result as any).complete) return;
  }
  assert.fail("capsule derivation did not complete");
}

test("lifecycle identity requires an explicit same-proposition transition and treats execution conservatively", () => {
  const source = bodySource();
  const restrictions = reduceEpisodeStateEnvelope(envelope(source, "user"),
    "Never deploy /Repo/Foo.ts.\nOnly inspect /Repo/Foo.ts.\nInstead, tests passed for /Repo/Foo.ts.",
    { role: { value: "user", source: rawSource(source, "role") } });
  assert.equal(restrictions.states.filter(item => item.kind === "restriction").length, 2);
  assert.equal(new Set(restrictions.states.map(item => item.propositionKey)).size, restrictions.states.length,
    "same-path claims retain proposition identity");
  assert.equal(new Set(restrictions.states.map(item => item.spanKey)).size, restrictions.states.length,
    "source spans remain distinct");
  assert.equal(restrictions.states.some(item => item.transition), false, "instead/passed never supersede merely by sharing a path");

  const revocation = reduceEpisodeStateEnvelope(envelope(bodySource(2), "user"), "Revoke the restriction: never deploy /Repo/Foo.ts.",
    { role: { value: "user", source: rawSource(bodySource(2), "role") } });
  assert.equal(revocation.states[0]?.transition?.action, "revoke");
  assert.equal(revocation.states[0]?.transition?.targetPropositionKey, restrictions.states[0]?.propositionKey);
  const conditional = reduceEpisodeStateEnvelope(envelope(bodySource(3), "user"), "If approved, revoke the restriction: never deploy /Repo/Foo.ts.",
    { role: { value: "user", source: rawSource(bodySource(3), "role") } });
  assert.equal(conditional.states.some(item => item.transition), false, "conditional revocation preserves both claims");

  const failed = reduceEpisodeStateEnvelope(envelope(bodySource(4), "toolResult"), "Command completed for /Repo/Foo.ts.", {
    role: { value: "toolResult", source: rawSource(bodySource(4), "role") }, toolName: { value: "bash", source: rawSource(bodySource(4), "toolName") },
    exitCode: { value: 2, source: rawSource(bodySource(4), "exitCode") }, isError: { value: false, source: rawSource(bodySource(4), "isError") },
  });
  assert.equal(failed.resources[0]?.executionOutcome, "failed", "nonzero exit overrides isError=false");
  assert.equal(failed.states[0]?.kind, "blocker");
  const succeeded = reduceEpisodeStateEnvelope(envelope(bodySource(5), "toolResult"), "Tests passed for /Repo/Foo.ts.", {
    role: { value: "toolResult", source: rawSource(bodySource(5), "role") }, toolName: { value: "bash", source: rawSource(bodySource(5), "toolName") },
    exitCode: { value: 0, source: rawSource(bodySource(5), "exitCode") }, isError: { value: false, source: rawSource(bodySource(5), "isError") },
  });
  assert.equal(succeeded.resources[0]?.executionOutcome, "completed-without-reported-error");
  assert.equal(succeeded.states.some(item => item.kind === "observedverification"), false, "execution success is not task verification");
});

test("persisted metadata lifecycle, historical pin, and episode-source recall remain source exact", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chrono-state-metadata-"));
  const catalogDirectory = join(directory, "catalog"), capsuleDirectory = join(directory, "capsules"), searchDirectory = join(directory, "search");
  const sourcePath = join(directory, "main.jsonl"), oldStore = join(searchDirectory, "state-v1.sqlite");
  mkdirSync(searchDirectory, { mode: 0o700 });
  writeFileSync(oldStore, "legacy-state-v1-must-remain", { mode: 0o600 });
  const remembered = createMemoryEvent([], { action: "remember", memoryId: "mem-1", timestamp: "2026-09-09T00:00:00.000Z", turn: 1,
    sourceRef: "memory-tool:remember", scope: "project", authority: "ordinary", confidence: 0.8, text: "Preserve the parser evidence." });
  const forgotten = createMemoryEvent([remembered], { action: "forget", memoryId: "mem-1", timestamp: "2026-09-09T00:01:00.000Z", turn: 2,
    sourceRef: "memory-tool:forget", authority: "ordinary", confidence: 0.8, reason: "not active" });
  const hint = { currentUnresolvedWork: "Finish parser identity", preserveExact: "Keep the raw producer event" };
  writeFileSync(sourcePath, message("u1", null, "user", "Implement /Repo/Parser.ts without deployment.")
    + custom("m1", "u1", "chrono-memory-v2-event", remembered)
    + custom("h1", "m1", "chrono-compact-retention-hint", hint), { mode: 0o600 });
  const sessionKey = "state-metadata";
  const catalog = async (extra: Record<string, unknown>): Promise<Record<string, any>> => {
    const response = await executeCatalogStoreRequest({ v: 1, catalogDirectory, sessionKey, ...extra });
    assert.equal(response.ok, true, JSON.stringify(response)); return response.ok ? response.result : {};
  };
  try {
    await catalog({ op: "ingestStep", shardKey: "main", sourcePath, branchKey: "main", shardOrdinal: 0 });
    const oldView = (await catalog({ op: "pin", branchKey: "main", leaf: { shardKey: "main", eventId: "h1" } })).view as CapsuleCatalogView;
    const capsuleIdentity: DerivedStoreIdentity = { storeKey: randomUUID(), sessionKey, catalogStoreKey: oldView.storeKey, catalogGeneration: oldView.generation,
      derivedSchemaVersion: DERIVED_SCHEMA_VERSION, capsuleSchemaVersion: CAPSULE_SCHEMA_VERSION, chunkSchemaVersion: CHUNK_SCHEMA_VERSION,
      reducerSetVersion: CAPSULE_REDUCER_PIPELINE_VERSION, configHash: createHash("sha256").update("state-capsules").digest("hex") };
    const identity: SearchV3Identity = { storeKey: randomUUID(), capsule: capsuleIdentity, schemaVersion: 1,
      configHash: createHash("sha256").update("state-search").digest("hex") };
    const run = (view: CapsuleCatalogView, extra: Record<string, unknown>) => executeEpisodeStateRequest({ v: 1, catalogDirectory, capsuleDirectory,
      searchDirectory, identity, view, ...extra });
    const materializeAll = async (view: CapsuleCatalogView): Promise<any> => {
      for (let page = 0; page < 100; page++) {
        const response = await run(view, { op: "materializeState", limit: 3 });
        assert.equal(response.ok, true, JSON.stringify(response));
        if (response.ok && (response.result as any).complete) return response.result;
      }
      assert.fail("state materialization did not complete");
    };
    await deriveAll(capsuleDirectory, catalogDirectory, capsuleIdentity, oldView);
    const oldReady = await materializeAll(oldView);
    assert.equal(oldReady.metadata.complete, true);
    assert.equal(oldReady.metadata.acceptedMemoryEvents + oldReady.metadata.acceptedRetentionHints > 0, true);
    const oldGeneration = oldReady.stateGeneration;
    const oldState = await run(oldView, { op: "recallState", level: "state", limit: 12 });
    assert.equal(oldState.ok, true, JSON.stringify(oldState)); if (!oldState.ok) return;
    const activeMemory = (oldState.result as any).items.find((item: any) => item.metadataKind === "memory");
    const activeHint = (oldState.result as any).items.find((item: any) => item.metadataKind === "retention-hint");
    assert.equal(activeMemory.memoryId, "mem-1");
    assert.equal(activeMemory.authority, "ordinary-memory", "authority-like source strings never grant instruction authority");
    assert.equal(activeMemory.evidence.source.coordinateKind, "raw-json");
    assert.deepEqual(activeHint.hint, hint);

    const episodes = await run(oldView, { op: "recallState", level: "episode", query: "parser identity", limit: 12 });
    assert.equal(episodes.ok, true, JSON.stringify(episodes)); if (!episodes.ok) return;
    const bodyMember = (episodes.result as any).items.find((item: any) => item.member.source.coordinateKind === "decoded-body");
    const episodePage = await run(oldView, { op: "recallState", level: "episode", source: bodyMember.member.source, limit: 12 });
    assert.equal(episodePage.ok, true, JSON.stringify(episodePage));
    if (episodePage.ok) assert.ok((episodePage.result as any).items.some((item: any) => item.member.source.coordinateKind === "raw-json"),
      "a source handle resolves the episode and pages all members");

    appendFileSync(sourcePath, custom("m2", "h1", "chrono-memory-v2-event", forgotten));
    await catalog({ op: "ingestStep", shardKey: "main", sourcePath, branchKey: "main", shardOrdinal: 0 });
    const newView = (await catalog({ op: "pin", branchKey: "main", leaf: { shardKey: "main", eventId: "m2" } })).view as CapsuleCatalogView;
    await deriveAll(capsuleDirectory, catalogDirectory, capsuleIdentity, newView); await materializeAll(newView);
    const current = await run(newView, { op: "recallState", level: "state", query: "parser evidence", limit: 12 });
    assert.equal(current.ok, true, JSON.stringify(current));
    if (current.ok) assert.equal((current.result as any).items.some((item: any) => item.metadataKind === "memory"), false, "forget changes visibility, not archive");
    const historical = await run(oldView, { op: "recallState", level: "state", limit: 12,
      after: { eventSeq: 1, descriptor: 0, stableKey: "", generation: oldGeneration } });
    assert.equal(historical.ok, true, JSON.stringify(historical));
    if (historical.ok) {
      const item = (historical.result as any).items.find((candidate: any) => candidate.metadataKind === "memory");
      assert.equal(item.memoryId, "mem-1");
      assert.equal("resolutionEvidence" in item, false, "future transition references do not leak into a historical pin");
    }
    assert.equal(readFileSync(oldStore, "utf8"), "legacy-state-v1-must-remain");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
