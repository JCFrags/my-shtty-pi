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
  const sourcePath = join(directory, "main.jsonl"), oldStore = join(searchDirectory, "state-v1.sqlite"),
    oldRollup = join(searchDirectory, "rollup-v0.sqlite");
  mkdirSync(searchDirectory, { mode: 0o700 });
  writeFileSync(oldStore, "legacy-state-v1-must-remain", { mode: 0o600 });
  writeFileSync(oldRollup, "legacy-rollup-v0-must-remain", { mode: 0o600 });
  const remembered = createMemoryEvent([], { action: "remember", memoryId: "mem-1", timestamp: "2026-09-09T00:00:00.000Z", turn: 1,
    sourceRef: "memory-tool:remember", scope: "project", authority: "ordinary", confidence: 0.8, text: "Preserve the parser evidence." });
  const forgotten = createMemoryEvent([remembered], { action: "forget", memoryId: "mem-1", timestamp: "2026-09-09T00:01:00.000Z", turn: 2,
    sourceRef: "memory-tool:forget", authority: "ordinary", confidence: 0.8, reason: "not active" });
  const hint = { currentUnresolvedWork: "Finish parser identity", preserveExact: "Keep the raw producer event" };
  writeFileSync(sourcePath, message("u1", null, "user", "Implement /Repo/Parser.ts without deployment.")
    + custom("m1", "u1", "chrono-memory-v2-event", remembered)
    + custom("h1", "m1", "chrono-compact-retention-hint", hint)
    + Array.from({ length: 9 }, (_, index) => message(`a${index + 1}`, index === 0 ? "h1" : `a${index}`, "assistant", `Parser evidence detail ${index + 1}.`)).join("")
    + message("u2", "a9", "user", "Continue parser checks without deployment."), { mode: 0o600 });
  const sessionKey = "state-metadata";
  const catalog = async (extra: Record<string, unknown>): Promise<Record<string, any>> => {
    const response = await executeCatalogStoreRequest({ v: 1, catalogDirectory, sessionKey, ...extra });
    assert.equal(response.ok, true, JSON.stringify(response)); return response.ok ? response.result : {};
  };
  try {
    await catalog({ op: "ingestStep", shardKey: "main", sourcePath, branchKey: "main", shardOrdinal: 0 });
    const oldView = (await catalog({ op: "pin", branchKey: "main", leaf: { shardKey: "main", eventId: "u2" } })).view as CapsuleCatalogView;
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

    const materializeRollup = async (view: CapsuleCatalogView): Promise<any> => {
      for (let page = 0; page < 20; page++) {
        const response = await run(view, { op: "materializeRollup", limit: 1 });
        assert.equal(response.ok, true, JSON.stringify(response));
        if (response.ok && (response.result as any).complete) return response.result;
      }
      assert.fail("rollup materialization did not complete");
    };
    const firstRollup = await run(oldView, { op: "materializeRollup", limit: 1 });
    assert.equal(firstRollup.ok, true, JSON.stringify(firstRollup)); if (!firstRollup.ok) return;
    assert.equal((firstRollup.result as any).complete, false, "the first bounded fragment publishes without full fanout");
    assert.ok((firstRollup.result as any).handle, "a partial frontier is an immutable publication");
    const pinnedStateGeneration = (firstRollup.result as any).stateGeneration;
    const pinnedProcessedCut = (firstRollup.result as any).processedCut;

    appendFileSync(sourcePath, custom("m2", "u2", "chrono-memory-v2-event", forgotten));
    await catalog({ op: "ingestStep", shardKey: "main", sourcePath, branchKey: "main", shardOrdinal: 0 });
    const newView = (await catalog({ op: "pin", branchKey: "main", leaf: { shardKey: "main", eventId: "m2" } })).view as CapsuleCatalogView;
    await deriveAll(capsuleDirectory, catalogDirectory, capsuleIdentity, newView);
    const oldRollupResult = await materializeRollup(newView);
    assert.equal(oldRollupResult.stateGeneration, pinnedStateGeneration, "continuation remains on one state snapshot across append");
    assert.equal(oldRollupResult.processedCut, pinnedProcessedCut, "later pending memory cannot move the publication cut");
    assert.equal(oldRollupResult.requestedCut, oldView.eventCut, "the source view remains pinned across continuation");
    assert.equal(oldRollupResult.closedIntervalsOnly, true);
    assert.equal(oldRollupResult.excludedOpenTail, true, "the current open episode is outside closed-interval coverage");
    const root = await run(oldView, { op: "recallRollup", level: "root", limit: 1, handle: oldRollupResult.handle });
    assert.equal(root.ok, true, JSON.stringify(root));
    if (root.ok) assert.equal((root.result as any).items.length, 1, "root expansion obeys the request page cap");
    const episodeRollup = await run(oldView, { op: "recallRollup", level: "episode", query: "parser", limit: 1,
      handle: oldRollupResult.handle });
    assert.equal(episodeRollup.ok, true, JSON.stringify(episodeRollup)); if (!episodeRollup.ok) return;
    const rolledEpisode = (episodeRollup.result as any).items[0];
    const episodeReference = rolledEpisode.reference;
    assert.equal(episodeReference.closure, "next-episode-boundary", "a closed interval is not reported as task completion");
    assert.ok(rolledEpisode.metadataHints.every((item: any) => item.temporalStatus === "historical"),
      "immutable hints never claim current effect after later demotion or forgetting");
    const sourceRollup = await run(oldView, { op: "recallRollup", level: "source", nodeId: episodeReference.nodeId,
      path: episodeReference.path, limit: 1, handle: oldRollupResult.handle });
    assert.equal(sourceRollup.ok, true, JSON.stringify(sourceRollup));
    if (sourceRollup.ok) {
      assert.equal((sourceRollup.result as any).items.length, 1, "exact sources page individually");
      assert.ok((sourceRollup.result as any).items[0].source.coordinateKind);
    }
    const missing = await run(oldView, { op: "recallRollup", level: "child", nodeId: "f".repeat(64),
      path: [oldRollupResult.handle.rootNodeId, "f".repeat(64)], limit: 1, handle: oldRollupResult.handle });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, "search-v3-rollup-path-invalid", "foreign nodes are refused under the pinned root");

    await materializeAll(newView);
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
    const pinnedRollup = await run(newView, { op: "recallRollup", level: "root", limit: 1, handle: oldRollupResult.handle });
    assert.equal(pinnedRollup.ok, true, JSON.stringify(pinnedRollup));
    assert.equal(readFileSync(oldStore, "utf8"), "legacy-state-v1-must-remain");
    assert.equal(readFileSync(oldRollup, "utf8"), "legacy-rollup-v0-must-remain");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
