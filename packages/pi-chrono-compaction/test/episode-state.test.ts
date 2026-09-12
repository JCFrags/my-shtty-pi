import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CAPSULE_REDUCER_PIPELINE_VERSION, CAPSULE_SCHEMA_VERSION, CHUNK_SCHEMA_VERSION, DERIVED_SCHEMA_VERSION,
  type CapsuleCatalogView, type DerivedStoreIdentity, type ReducerEnvelope, type ScopedBodySourceRef, type ScopedRawSourceRef,
} from "../src/capsule-contract.js";
import { executeCatalogStoreRequest } from "../src/catalog-store.js";
import { CATALOG_LIMITS, isCatalogRequest } from "../src/catalog-contract.js";
import { CatalogSqlite, CatalogSqliteError } from "../src/catalog-sqlite.js";
import { executeCapsuleRequest } from "../src/capsule-store.js";
import { reduceEpisodeStateEnvelope } from "../src/episode-state-reducer.js";
import { executeEpisodeStateRequest } from "../src/episode-state-store.js";
import { createMemoryEvent } from "../src/memory-store.js";
import { composeStoredSelection, persistPrivateCompositionArtifact } from "../src/context-composer.js";
import { EPISODE_STATE_LIMITS, type EpisodeStateSelection } from "../src/episode-state-contract.js";
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
    const invalidRepairAction = await run(oldView, { op: "repairRollup", action: "arbitrary", repairId: "invalid-action" });
    assert.equal(invalidRepairAction.ok, false);
    if (!invalidRepairAction.ok) assert.equal(invalidRepairAction.code, "search-v3-state-request-invalid");
    const materializeAll = async (view: CapsuleCatalogView): Promise<any> => {
      let acceptedMetadata = 0;
      for (let page = 0; page < 100; page++) {
        const response = await run(view, { op: "materializeState", limit: 3 });
        assert.equal(response.ok, true, JSON.stringify(response));
        if (response.ok) {
          const result = response.result as any;
          // These are per-job metrics, not lifetime counts on the final page.
          acceptedMetadata += result.metadata.acceptedMemoryEvents + result.metadata.acceptedRetentionHints;
          if (result.complete) return { ...result, acceptedMetadata };
        }
      }
      assert.fail("state materialization did not complete");
    };
    await deriveAll(capsuleDirectory, catalogDirectory, capsuleIdentity, oldView);
    const oldReady = await materializeAll(oldView);
    assert.equal(oldReady.metadata.complete, true);
    assert.equal(oldReady.acceptedMetadata > 0, true);
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
    const composedRollup = await run(oldView, { op: "composeRollupSelection", query: "parser",
      beforeEventSeq: oldView.eventCut + 1, limit: 2, handle: oldRollupResult.handle });
    assert.equal(composedRollup.ok, true, JSON.stringify(composedRollup));
    if (composedRollup.ok) {
      const selected = (composedRollup.result as any).items;
      assert.ok(selected.length > 0, "query-time composition selects an actual older rollup node");
      assert.ok(selected.every((item: any) => item.range.end.eventSeq < oldView.eventCut + 1));
      assert.ok(selected.every((item: any) => item.reference.path[0] === oldRollupResult.handle.rootNodeId
        && item.reference.path.at(-1) === item.nodeId), "selected nodes retain a verified pinned expansion path");
      assert.ok((composedRollup.result as any).metrics.nodesRead <= 24, "top-down selection counts every node load against the existing ceiling");
      assert.ok((composedRollup.result as any).metrics.nodesVisited <= (composedRollup.result as any).metrics.nodesRead);
    }
    const noHit = await run(oldView, { op: "composeRollupSelection", query: "definitely-absent-term",
      beforeEventSeq: oldView.eventCut + 1, limit: 2, handle: oldRollupResult.handle });
    assert.equal(noHit.ok, true, JSON.stringify(noHit));
    if (noHit.ok) assert.equal((noHit.result as any).noQueryHit, true, "no query hit is not a global coverage refusal");

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
    const sourceBeforeRepair = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
    const repairId = "m08-resumable-repair";
    const repairStart = await run(oldView, { op: "repairRollup", action: "start", repairId });
    assert.equal(repairStart.ok, true, JSON.stringify(repairStart)); if (!repairStart.ok) return;
    assert.equal((repairStart.result as any).expectedActiveStoreId, null);
    const repairPartial = await run(oldView, { op: "repairRollup", action: "step", repairId, limit: 1 });
    assert.equal(repairPartial.ok, true, JSON.stringify(repairPartial)); if (!repairPartial.ok) return;
    assert.equal((repairPartial.result as any).complete, false, "one finite repair step persists a partial target");
    const repairRestart = await run(oldView, { op: "repairRollup", action: "start", repairId });
    assert.equal(repairRestart.ok, true, JSON.stringify(repairRestart));
    const repairResumed = await run(oldView, { op: "repairRollup", action: "status", repairId });
    assert.equal(repairResumed.ok, true, JSON.stringify(repairResumed));
    if (repairResumed.ok) assert.equal((repairResumed.result as any).rollupGeneration,
      (repairPartial.result as any).rollupGeneration, "a start retry validates and resumes rather than resetting its target");
    const incompletePublish = await run(oldView, { op: "repairRollup", action: "publish", repairId, expectedActiveStoreId: null });
    assert.equal(incompletePublish.ok, false);
    if (!incompletePublish.ok) assert.equal(incompletePublish.code, "search-v3-rollup-repair-incomplete");
    let repaired: any = repairPartial.result;
    for (let page = 0; page < 20 && !repaired.complete; page++) {
      const response = await run(oldView, { op: "repairRollup", action: "step", repairId, limit: 1 });
      assert.equal(response.ok, true, JSON.stringify(response)); if (!response.ok) return;
      repaired = response.result;
    }
    assert.equal(repaired.complete, true, "bounded repair steps reach a complete validated replacement");

    const corruptId = "m08-corrupt-target";
    const corruptStart = await run(oldView, { op: "repairRollup", action: "start", repairId: corruptId });
    assert.equal(corruptStart.ok, true, JSON.stringify(corruptStart)); if (!corruptStart.ok) return;
    const corruptStore = join(searchDirectory, "rollup-repair-v1", "stores", `rollup-${(corruptStart.result as any).targetStoreId}.sqlite`);
    writeFileSync(corruptStore, "corrupt-target", { mode: 0o600 });
    const corruptPublish = await run(oldView, { op: "repairRollup", action: "publish", repairId: corruptId, expectedActiveStoreId: null });
    assert.equal(corruptPublish.ok, false, "a corrupt replacement cannot change the active route");

    const repairPublish = await run(oldView, { op: "repairRollup", action: "publish", repairId, expectedActiveStoreId: null });
    assert.equal(repairPublish.ok, true, JSON.stringify(repairPublish)); if (!repairPublish.ok) return;
    assert.equal((repairPublish.result as any).handle.storeId, (repairStart.result as any).targetStoreId);
    const routedStatus = await run(oldView, { op: "rollupStatus" });
    assert.equal(routedStatus.ok, true, JSON.stringify(routedStatus));
    if (routedStatus.ok) assert.equal((routedStatus.result as any).handle.storeId, (repairStart.result as any).targetStoreId);
    const pinnedRollup = await run(newView, { op: "recallRollup", level: "root", limit: 1, handle: oldRollupResult.handle });
    assert.equal(pinnedRollup.ok, true, JSON.stringify(pinnedRollup));
    if (pinnedRollup.ok) assert.equal((pinnedRollup.result as any).handle.storeId, undefined,
      "a legacy handle remains bound to rollup-v3.sqlite after route publication");
    assert.equal(createHash("sha256").update(readFileSync(sourcePath)).digest("hex"), sourceBeforeRepair,
      "repair and publication do not mutate the source archive");

    const capacityRestrictions = Array.from({ length: 32 }, (_, index) =>
      `Never deploy /Repo/Capacity-${index}.ts without approval. ${"x".repeat(700)}`).join("\n");
    appendFileSync(sourcePath, message("u3", "m2", "user", capacityRestrictions)
      + message("u4", "u3", "user", "Continue after preserving every capacity restriction."));
    await catalog({ op: "ingestStep", shardKey: "main", sourcePath, branchKey: "main", shardOrdinal: 0 });
    const capacityView = (await catalog({ op: "pin", branchKey: "main", leaf: { shardKey: "main", eventId: "u4" } })).view as CapsuleCatalogView;
    await deriveAll(capsuleDirectory, catalogDirectory, capsuleIdentity, capacityView);
    await materializeAll(capacityView);
    const capacityRollup = await materializeRollup(capacityView);
    assert.ok(capacityRollup.rollupGeneration > oldRollupResult.rollupGeneration, "a completed frontier continues into a later generation");
    assert.equal(capacityRollup.complete, true);
    const historicalIndexedStatus = await run(oldView, { op: "rollupStatus" });
    assert.equal(historicalIndexedStatus.ok, true, JSON.stringify(historicalIndexedStatus));
    if (historicalIndexedStatus.ok) {
      assert.equal((historicalIndexedStatus.result as any).processedMemoryCut, (historicalIndexedStatus.result as any).handle.eventCut,
        "historical indexed status does not borrow the current head metadata cut");
      assert.equal("cursor" in historicalIndexedStatus.result, false, "historical indexed status omits the current head cursor");
    }
    const pinnedComposition = await run(capacityView, { op: "composeRollupSelection", query: "parser",
      beforeEventSeq: oldView.eventCut + 1, limit: 1, handle: oldRollupResult.handle });
    assert.equal(pinnedComposition.ok, true, JSON.stringify(pinnedComposition));
    if (pinnedComposition.ok) assert.equal((pinnedComposition.result as any).handle.rollupGeneration,
      oldRollupResult.handle.rollupGeneration, "a newer publication does not invalidate an older valid composition pin");
    let boundedEpisode: any, capacityAfter: unknown;
    for (let page = 0; page < 4 && !boundedEpisode; page++) {
      const capacityEpisodes = await run(capacityView, { op: "recallRollup", level: "episode", limit: 12,
        handle: capacityRollup.handle, ...(capacityAfter ? { after: capacityAfter } : {}) });
      assert.equal(capacityEpisodes.ok, true, JSON.stringify(capacityEpisodes)); if (!capacityEpisodes.ok) return;
      boundedEpisode = (capacityEpisodes.result as any).items.find((item: any) => item.omittedProtectedCount > 0);
      capacityAfter = (capacityEpisodes.result as any).next;
      if (!capacityAfter) break;
    }
    assert.ok(boundedEpisode, "oversized optional protected copies become an explicit omission instead of blocking publication");
    assert.equal(boundedEpisode.remainingDetail, "reachable-through-sources");
    const boundedSources = await run(capacityView, { op: "recallRollup", level: "source", nodeId: boundedEpisode.reference.nodeId,
      path: boundedEpisode.reference.path, limit: 12, handle: capacityRollup.handle });
    assert.equal(boundedSources.ok, true, JSON.stringify(boundedSources));
    if (boundedSources.ok) assert.ok((boundedSources.result as any).items.length > 0, "capacity reduction preserves exact source recovery");

    const errorDb = CatalogSqlite.create(join(searchDirectory, "rollup-error-sanitization.sqlite"));
    try {
      assert.throws(() => errorDb.transaction(() => { throw Object.assign(new Error("private semantic detail"),
        { code: "search-v3-rollup-node-limit" }); }), error => (error as Error & { code?: string }).code === "search-v3-rollup-node-limit"
          && (error as Error).message === "search-v3-rollup-node-limit", "an allowlisted rollback preserves only its safe semantic code");
      assert.throws(() => errorDb.transaction(() => { throw Object.assign(new Error("private unknown detail"),
        { code: "search-v3-rollup-unrecognized" }); }), error => error instanceof CatalogSqliteError
          && error.code === "catalog-sqlite-failed" && error.message === "catalog-sqlite-failed",
      "an unknown rollback error cannot expose its code or message");
    } finally { errorDb.close(); }
    assert.equal(readFileSync(oldStore, "utf8"), "legacy-state-v1-must-remain");
    assert.equal(readFileSync(oldRollup, "utf8"), "legacy-rollup-v0-must-remain");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("M09 actual producer selection preserves obligations and successive experience in private output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chrono-composer-producer-"));
  const catalogDirectory = join(directory, "catalog"), capsuleDirectory = join(directory, "capsules"), searchDirectory = join(directory, "search");
  const sourcePath = join(directory, "main.jsonl"), sessionKey = "composer-producer";
  mkdirSync(searchDirectory, { mode: 0o700 });
  const packedRestrictions = Array.from({ length: 20 }, (_, index) =>
    `If approval ${index} is pending, never deploy /Repo/Parser-${index}.ts unless the owner authorizes it.`).join("\n");
  const texts: [string, string][] = [
    ["user", Array.from({ length: 40 }, (_, i) => `Background observation ${i}.`).join("\n") + `\n\n${packedRestrictions}`],
    ["assistant", "Next action: verify /Repo/Parser.ts before deployment."],
    ["assistant", "Inspect the parser input and preserve the failed attempt."],
    ["toolResult", "Parser check failed with exit code 2."],
    ["assistant", "Adjust the parser boundary check; verification remains unresolved."],
    ["user", "Goal: investigate the parser boundary."],
    ["assistant", "Read the boundary evidence."],
    ["assistant", "Attempt the smaller correction."],
    ["toolResult", "The narrow check completed without an execution error."],
    ["assistant", "Next action: review the result; do not claim deployment."],
    ["user", "Keep the pending parser work visible."],
    ["assistant", "The task still needs output review."],
    ["user", "Continue with source recovery."],
    ["assistant", "Inspect the recovered interval."],
    ["assistant", "Next action: preserve the unresolved verification."],
    ["user", "Continue without activation."],
    ["toolResult", Array.from({ length: 32 }, (_, i) => `Failed incidental command ${i}.`).join("\n")],
  ];
  writeFileSync(sourcePath, texts.map(([role, text], i) => message(`e${i + 1}`, i ? `e${i}` : null, role, text,
    role === "toolResult" ? { toolName: "bash", toolCallId: `call${i}`, isError: i === 3 || i === 16 } : {})).join(""), { mode: 0o600 });
  const catalog = async (extra: Record<string, unknown>): Promise<any> => {
    const response = await executeCatalogStoreRequest({ v: 1, catalogDirectory, sessionKey, ...extra });
    assert.equal(response.ok, true, JSON.stringify(response)); return response.ok ? response.result : {};
  };
  try {
    await catalog({ op: "ingestStep", shardKey: "main", sourcePath, branchKey: "main", shardOrdinal: 0 });
    const view = (await catalog({ op: "pin", branchKey: "main", leaf: { shardKey: "main", eventId: "e17" } })).view as CapsuleCatalogView;
    const capsuleIdentity: DerivedStoreIdentity = { storeKey: randomUUID(), sessionKey, catalogStoreKey: view.storeKey, catalogGeneration: view.generation,
      derivedSchemaVersion: DERIVED_SCHEMA_VERSION, capsuleSchemaVersion: CAPSULE_SCHEMA_VERSION, chunkSchemaVersion: CHUNK_SCHEMA_VERSION,
      reducerSetVersion: CAPSULE_REDUCER_PIPELINE_VERSION, configHash: createHash("sha256").update("composer-producer").digest("hex") };
    const identity: SearchV3Identity = { storeKey: randomUUID(), capsule: capsuleIdentity, schemaVersion: 1,
      configHash: createHash("sha256").update("composer-search").digest("hex") };
    const run = (op: string, pinned = view) => executeEpisodeStateRequest({ v: 1, catalogDirectory, capsuleDirectory, searchDirectory, identity, view: pinned, op });
    await deriveAll(capsuleDirectory, catalogDirectory, capsuleIdentity, view);
    let settled = false;
    for (let page = 0; page < 24; page++) {
      const result = await run("materializeState"); assert.equal(result.ok, true, JSON.stringify(result));
      if (result.ok && result.result.complete) { settled = true; break; }
    }
    assert.ok(settled);
    const response = await run("composeStateSelection"); assert.equal(response.ok, true, JSON.stringify(response)); if (!response.ok) return;
    const selection = response.result as unknown as EpisodeStateSelection;
    const restriction = selection.protected.find(item => item.kind === "restriction" && (item.evidence as any).exactText.includes("never deploy /Repo/Parser-0.ts"));
    assert.ok(restriction, "real producer restriction survives stored selection");
    assert.ok((restriction.evidence as any).exactText.includes("If approval 0 is pending,"));
    assert.ok((restriction.evidence as any).exactText.includes("unless the owner authorizes it."));
    assert.equal((restriction.evidence as any).contextComplete, true);
    const packed = selection.protected.find(item => item.kind === "restriction"
      && (item.evidence as any).exactText.includes("/Repo/Parser-"));
    assert.equal(packed?.coveredPropositions?.length, 19,
      "one exact paragraph representation retains each additional proposition and source coordinates once");
    assert.ok(packed?.coveredPropositions?.every(item => item.stableKey !== packed.stableKey),
      "the primary proposition is not repeated in covered proposition provenance");
    assert.match(packed?.representationKey ?? "", /^[a-f0-9]{64}$/u);
    assert.ok(packed?.coveredPropositions?.every(item => item.representationKey === packed.representationKey));
    assert.ok(packed?.coveredPropositions?.every(item => {
      const evidence = item.evidence as any;
      return evidence.exactText.includes("/Repo/Parser-") && !evidence.contextComplete
        && evidence.decodedUtf16.end - evidence.decodedUtf16.start === evidence.exactText.length
        && evidence.source.coordinateKind === "decoded-body";
    }), "packed proposition records keep original clauses and coordinates instead of repeating the shared paragraph");
    assert.equal(selection.omissions.protectedAtLeastOne, false);
    assert.equal(selection.omissions.openWorkAtLeastOne, true, "later failures overflow only their own category");
    assert.equal(restriction.authority, "user");
    assert.ok(selection.protected.some(item => item.kind === "goal" && item.authority === "user"),
      "user work retains the first work reservation");
    assert.ok(selection.protected.some(item => item.kind === "openwork" && item.authority === "assistant-report"),
      "assistant unresolved work survives lower-authority tool-failure shedding");
    assert.ok(selection.protected.some(item => item.kind === "openwork"));
    assert.ok(new Set(selection.recent.map(item => item.episodeKey)).size > 1, "successive episodes remain readable");
    assert.ok(selection.older?.length, "older obligation-linked experience is selected");
    const result = composeStoredSelection({ regularPiSummary: "Parser work remains pending. Deployment requires approval.", combinedCeilingTokens: 30000,
      cut: { sourceCutEntryId: "e17", sourceCutSeq: view.eventCut, firstKeptEntryId: "tail", firstKeptSeq: view.eventCut + 1,
        rawTailTokens: 100, toolPairSafe: true } }, selection, source => `synthetic-source:${source.eventSeq}:${source.descriptor}`);
    assert.ok(result.text.includes("never deploy /Repo/Parser-0.ts unless the owner authorizes it."), "nonempty zero-omission evidence is not discarded");
    assert.ok(result.text.includes("Next action:"), "pending work survives rendering");
    assert.equal(result.envelope.validation.protectedCoverageComplete, true, "actual producer qualifies this synthetic cut, not the live session");
    assert.equal(result.envelope.validation.openWorkCoverageComplete, false, "work overflow does not certify restrictions or work");
    const optional = result.artifact.selectedRows.filter(item => ["older", "recent", "delta"].includes(item.section));
    const mandatoryKeys = new Set(result.artifact.selectedRows.filter(item => ["protected", "open-work"].includes(item.section)).map(item => item.row.recovery));
    assert.ok(optional.every(item => !mandatoryKeys.has(item.row.recovery)), "optional detail does not repeat mandatory source events");
    assert.ok(result.envelope.combinedTokens <= 30000);
    assert.equal(result.envelope.combinedTokens, result.envelope.renderedTokens + 100, "tail is counted once");
    // A later oversized user source is processed from existing decoded chunks without changing the historical pin.
    const oversizedRestriction = "If the release window is absent,\nnever activate /Repo/Oversized.ts unless the owner grants it.";
    appendFileSync(sourcePath, message("e18", "e17", "user", "z".repeat(32760) + `\n\n${oversizedRestriction}`));
    await catalog({ op: "ingestStep", shardKey: "main", sourcePath, branchKey: "main", shardOrdinal: 0 });
    const laterView = (await catalog({ op: "pin", branchKey: "main", leaf: { shardKey: "main", eventId: "e18" } })).view as CapsuleCatalogView;
    await deriveAll(capsuleDirectory, catalogDirectory, capsuleIdentity, laterView);
    for (let page = 0; page < 24; page++) {
      const response = await run("materializeState", laterView);
      assert.equal(response.ok, true, JSON.stringify(response));
      if (response.ok && response.result.complete) break;
      assert.ok(page < 23);
    }
    const historical = await run("composeStateSelection"), later = await run("composeStateSelection", laterView);
    assert.ok(historical.ok && later.ok);
    if (historical.ok && later.ok) {
      assert.equal((historical.result as any).coverage.restrictionsComplete, true);
      assert.equal((later.result as any).coverage.restrictionsComplete, true);
      const oversized = (later.result as any).protected.find((item: any) => item.kind === "restriction"
        && item.evidence.exactText.includes("never activate /Repo/Oversized.ts"));
      assert.ok(oversized, "an oversized relevant source is resumed and selected");
      assert.ok(oversized.evidence.exactText.includes("If the release window is absent,"));
      assert.equal(oversized.evidence.contextComplete, true, "cross-chunk condition and exception retain exact coordinates");
      assert.equal((historical.result as any).stateGeneration, selection.stateGeneration);
    }
    const artifactDir = join(directory, "artifacts");
    const stored = await persistPrivateCompositionArtifact(artifactDir, result.artifact);
    const persisted = JSON.parse(readFileSync(join(artifactDir, stored.artifactRef), "utf8"));
    assert.equal(typeof persisted.validation, "object", "shared validation references must not serialize as Circular");
    assert.ok(!JSON.stringify(persisted).includes("[Circular]"));
    if (process.env.CHRONO_SYNTHETIC_OUTPUT) writeFileSync(process.env.CHRONO_SYNTHETIC_OUTPUT, result.text + "\n", { mode: 0o600 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("state gap repair: bounded legacy reconciliation preserves historical handles and coverage", async t => {
  const directory = mkdtempSync(join(tmpdir(), "chrono-state-gap-repair-"));
  const catalogDirectory = join(directory, "catalog"), capsuleDirectory = join(directory, "capsules"), searchDirectory = join(directory, "search");
  const sourcePath = join(directory, "main.jsonl"), sessionKey = "state-gap-repair";
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const clauses = Array.from({ length: 96 }, (_, index) => index % 2
    ? `Goal: verify /Repo/Gap${index}.ts before release.` : `Never deploy /Repo/Gap${index}.ts without approval.`);
  const text = clauses.map(clause => clause.padEnd(510, " ") + "\n\n").join("");
  mkdirSync(searchDirectory, { mode: 0o700 });
  writeFileSync(sourcePath, message("u1", null, "user", text), { mode: 0o600 });
  const catalog = async (extra: Record<string, unknown>): Promise<any> => {
    const response = await executeCatalogStoreRequest({ v: 1, catalogDirectory, sessionKey, ...extra });
    assert.equal(response.ok, true, JSON.stringify(response)); return response.ok ? response.result : {};
  };
  const database = <T>(fn: (db: CatalogSqlite) => T): T => {
    const db = CatalogSqlite.open(join(searchDirectory, "state-v4.sqlite"));
    try { return fn(db); } finally { db.close(); }
  };
  try {
    await catalog({ op: "ingestStep", shardKey: "main", sourcePath, branchKey: "main", shardOrdinal: 0 });
    const oldView = (await catalog({ op: "pin", branchKey: "main", leaf: { shardKey: "main", eventId: "u1" } })).view as CapsuleCatalogView;
    const capsuleIdentity: DerivedStoreIdentity = { storeKey: randomUUID(), sessionKey, catalogStoreKey: oldView.storeKey, catalogGeneration: oldView.generation,
      derivedSchemaVersion: DERIVED_SCHEMA_VERSION, capsuleSchemaVersion: CAPSULE_SCHEMA_VERSION, chunkSchemaVersion: CHUNK_SCHEMA_VERSION,
      reducerSetVersion: CAPSULE_REDUCER_PIPELINE_VERSION, configHash: hash("repair-capsules") };
    const identity: SearchV3Identity = { storeKey: randomUUID(), capsule: capsuleIdentity, schemaVersion: 1, configHash: hash("repair-search") };
    const request = (view: CapsuleCatalogView, extra: Record<string, unknown>) => ({ v: 1, catalogDirectory, capsuleDirectory, searchDirectory, identity, view, ...extra });
    const run = async (view: CapsuleCatalogView, extra: Record<string, unknown>): Promise<any> => {
      const response = await executeEpisodeStateRequest(request(view, extra));
      assert.equal(response.ok, true, JSON.stringify(response));
      assert.ok(response.sourceBytes <= EPISODE_STATE_LIMITS.sourceBytesPerJob);
      assert.equal(response.sqliteNativeLimitBytes, EPISODE_STATE_LIMITS.nativeSqliteBytes);
      return response.ok ? response.result : {};
    };
    const settle = async (view: CapsuleCatalogView): Promise<any> => {
      for (let step = 0; step < 16; step++) {
        const result = await run(view, { op: "materializeState" });
        if (result.complete) return result;
      }
      assert.fail("fixture state did not settle");
    };
    await deriveAll(capsuleDirectory, catalogDirectory, capsuleIdentity, oldView);
    const base = await settle(oldView);
    const capsulePage = await executeCapsuleRequest({ v: 1, derivedDirectory: capsuleDirectory, catalogDirectory, identity: capsuleIdentity,
      op: "capsulePage", view: oldView, limit: 1 });
    assert.ok(capsulePage.ok);
    const source = (capsulePage.result.capsules as ReducerEnvelope[])[0]!.source;
    // Construct a persisted old truncation: 16 first-window rows and 16 later-window rows.
    // Later identities use the legacy window-relative offsets, but evidence stays exact.
    database(db => db.transaction(() => {
      const rows = [...db.prepare("SELECT * FROM state_items WHERE eventSeq=1 ORDER BY stableKey LIMIT 128").iterate(128)];
      assert.equal(rows.length, 96);
      for (const row of rows) {
        const evidence = JSON.parse(String(row.evidence)), index = evidence.decodedUtf16.start / 512;
        if (!(index < 16 || index >= 48 && index < 64)) {
          db.prepare("DELETE FROM state_fts WHERE stableKey=?").run(String(row.stableKey));
          db.prepare("DELETE FROM state_items WHERE stableKey=?").run(String(row.stableKey));
        } else if (index >= 48) {
          const spanKey = hash(`${JSON.stringify(source)}\n${evidence.decodedUtf16.start - 24576}\n${evidence.decodedUtf16.end - 24576}`);
          const stableKey = hash(`${row.propositionKey}\n${spanKey}`).slice(0, 32);
          db.prepare("UPDATE state_items SET stableKey=?,spanKey=? WHERE stableKey=?").run(stableKey, spanKey, String(row.stableKey));
          db.prepare("UPDATE state_fts SET stableKey=? WHERE stableKey=?").run(stableKey, String(row.stableKey));
        }
      }
      db.prepare("UPDATE coverage SET restrictionGap=1,openWorkGap=1,optionalGap=1 WHERE eventSeq=1").run();
      db.prepare("UPDATE heads SET partialCount=1").run();
    }));
    const authorizationText = "I authorize retiring the prior repository restriction.";
    const authorizationRaw = message("u2", "u1", "user", authorizationText);
    appendFileSync(sourcePath, authorizationRaw + message("u3", "u2", "user", "Never remove /Repo/Unrelated.ts."));
    await catalog({ op: "ingestStep", shardKey: "main", sourcePath, branchKey: "main", shardOrdinal: 0 });
    const view = (await catalog({ op: "pin", branchKey: "main", leaf: { shardKey: "main", eventId: "u3" } })).view as CapsuleCatalogView;
    await deriveAll(capsuleDirectory, catalogDirectory, capsuleIdentity, view);
    const ready = await settle(view);
    const target = database(db => db.prepare("SELECT * FROM state_items WHERE eventSeq=1 AND json_extract(evidence,'$.decodedUtf16.start')=24576").get()!);
    const authorization = database(db => JSON.parse(String(db.prepare("SELECT evidence FROM state_items WHERE eventSeq=2 LIMIT 1").get()!.evidence)));
    await run(view, { op: "supersedeState", expectedGeneration: ready.stateGeneration,
      authorization: { source: authorization.source, decodedUtf16: authorization.decodedUtf16,
        spanHash: createHash("sha256").update(Buffer.from(authorizationText, "utf16le")).digest("hex"), rawEventHash: hash(authorizationRaw.slice(0, -1)) },
      decision: { actor: "agent", basis: "direct-original-user-instruction", scope: "repository-and-chrono",
        action: "revoke-prior-user-restrictions-and-approval-holds", rationale: "Retire only the exact synthetic legacy restriction." },
      targets: [{ stableKey: target.stableKey, propositionKey: target.propositionKey, spanKey: target.spanKey, createdGeneration: target.createdGeneration,
        evidenceHash: hash(String(target.evidence)), kind: "restriction", authority: "user", scope: "repository", category: "restriction" }] });
    const oldPin = { eventSeq: 1, descriptor: 0, stableKey: "", generation: base.stateGeneration };
    const oldRecall = await run(oldView, { op: "recallState", after: oldPin });
    const oldSelection = await run(oldView, { op: "composeStateSelection" });
    assert.equal(oldSelection.coverage.restrictionsComplete, false);
    let rollup: any;
    for (let step = 0; step < 20; step++) {
      rollup = await run(view, { op: "materializeRollup", limit: 1 });
      if (rollup.complete) break;
    }
    assert.ok(rollup.complete && rollup.handle);
    const historicalRoot = await run(view, { op: "recallRollup", handle: rollup.handle, level: "root", limit: 1 });
    const frozen = database(db => ({ rows: [...db.prepare("SELECT * FROM state_items ORDER BY stableKey LIMIT 128").iterate(128)],
      coverage: [...db.prepare("SELECT * FROM coverage ORDER BY eventSeq,descriptor LIMIT 16").iterate(16)],
      cuts: [...db.prepare("SELECT * FROM cuts ORDER BY eventSeq,descriptor LIMIT 16").iterate(16)], head: db.prepare("SELECT * FROM heads LIMIT 1").get()! }));
    const sourceHash = hash(readFileSync(sourcePath, "utf8"));
    const repairId = "dense-legacy", status = await run(view, { op: "repairState", action: "status", repairId, source });
    const binding = { op: "repairState", repairId, source, expectedGeneration: status.expectedGeneration, priorCoverage: status.priorCoverage };
    const refuses = async (extra: Record<string, unknown>, code: string) => {
      const response = await executeEpisodeStateRequest(request(view, extra));
      assert.equal(response.ok, false); if (!response.ok) assert.equal(response.code, code);
    };
    await refuses({ ...binding, action: "start", priorCoverage: { ...status.priorCoverage, hash: "0".repeat(64) } }, "search-v3-state-repair-stale");
    let repair = await run(view, { ...binding, action: "start" });
    await refuses({ ...binding, action: "publish" }, "search-v3-state-repair-incomplete");
    await refuses({ op: "materializeState" }, "search-v3-state-repair-active");
    if (process.env.CHRONO_PREVIOUS_STATE_EXECUTOR) {
      const previous = await import(pathToFileURL(process.env.CHRONO_PREVIOUS_STATE_EXECUTOR).href);
      for (const op of ["materializeState", "recallState"]) {
        const refusal = await previous.executeEpisodeStateRequest(request(oldView, { op }));
        assert.equal(refusal.ok, false);
        assert.ok(["search-v3-state-store-mismatch", "search-v3-state-store-failed"].includes(refusal.code));
        t.diagnostic(`Previous executor ${op} refused: ${refusal.code}`);
      }
    }
    let steps = 0, restartedBatch = false;
    for (; steps < 24 && repair.phase !== "ready"; steps++) {
      repair = await run(view, JSON.parse(JSON.stringify({ ...binding, action: "step" })));
      assert.ok(repair.metrics.stateItems <= 32);
      assert.equal((await run(view, { op: "stateStatus" })).stateGeneration, status.expectedGeneration);
      if (repair.afterState && !restartedBatch) {
        restartedBatch = true;
        const restored = await run(view, { op: "repairState", action: "status", repairId, source });
        assert.equal(restored.afterState, repair.afterState);
        assert.equal(restored.nextDecoded, repair.nextDecoded);
        assert.equal((await run(view, { op: "composeStateSelection" })).coverage.restrictionsComplete, false);
        assert.deepEqual((await run(oldView, { op: "recallState", after: oldPin })).items, oldRecall.items);
      }
    }
    assert.equal(repair.phase, "ready"); assert.equal(restartedBatch, true);
    assert.equal(repair.accounted, 96); assert.equal(repair.matched, 32); assert.equal(repair.inserted, 64);
    assert.equal(repair.supersededPreserved, 1);
    const publication = await run(view, { ...binding, action: "publish" });
    assert.equal(publication.published, true); assert.equal(publication.publicationGeneration, status.expectedGeneration + 1);
    assert.equal((await run(view, { ...binding, action: "publish" })).publicationGeneration, publication.publicationGeneration);
    const current = await run(view, { op: "composeStateSelection" });
    assert.equal(current.coverage.restrictionsComplete, true); assert.equal(current.coverage.openWorkComplete, true);
    assert.equal(current.omissions.protectedAtLeastOne, true, "repair does not waive mandatory representation limits");
    assert.equal((await run(oldView, { op: "composeStateSelection" })).coverage.restrictionsComplete, false);
    const restored = await run(oldView, { op: "recallState", after: oldPin });
    assert.equal(restored.stateGeneration, oldRecall.stateGeneration); assert.deepEqual(restored.items, oldRecall.items);
    assert.deepEqual((await run(view, { op: "recallRollup", handle: rollup.handle, level: "root", limit: 1 })).items, historicalRoot.items);
    database(db => {
      for (const row of frozen.rows) assert.deepEqual(db.prepare("SELECT * FROM state_items WHERE stableKey=?").get(String(row.stableKey)), row);
      assert.deepEqual([...db.prepare("SELECT * FROM coverage ORDER BY eventSeq,descriptor LIMIT 16").iterate(16)], frozen.coverage);
      for (const cut of frozen.cuts) assert.deepEqual(db.prepare("SELECT * FROM cuts WHERE lineage=? AND eventSeq=? AND descriptor=?").get(String(cut.lineage), Number(cut.eventSeq), Number(cut.descriptor)), cut);
      assert.deepEqual({ ...db.prepare("SELECT * FROM heads LIMIT 1").get(), generation: frozen.head.generation }, frozen.head);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM state_items WHERE eventSeq=1 AND json_extract(evidence,'$.decodedUtf16.start')=24576").get()!.count, 1);
    });
    assert.equal(hash(readFileSync(sourcePath, "utf8")), sourceHash);
    t.diagnostic(JSON.stringify({ steps, accounted: repair.accounted, matched: repair.matched, inserted: repair.inserted,
      supersededPreserved: repair.supersededPreserved, historicalHandle: rollup.handle.ruleset, oldBinaryChecks: !!process.env.CHRONO_PREVIOUS_STATE_EXECUTOR }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("state delta pagination: noncontiguous events and late metadata stay bounded", async t => {
  const directory = mkdtempSync(join(tmpdir(), "chrono-state-delta-pages-"));
  const catalogDirectory = join(directory, "catalog"), capsuleDirectory = join(directory, "capsules"), searchDirectory = join(directory, "search");
  const sourcePath = join(directory, "main.jsonl"), sessionKey = "state-delta-pages";
  mkdirSync(searchDirectory, { mode: 0o700 });
  writeFileSync(sourcePath, message("u0", null, "user", "Goal: inspect /Repo/Delta.ts."), { mode: 0o600 });
  const catalog = async (extra: Record<string, unknown>): Promise<any> => {
    const response = await executeCatalogStoreRequest({ v: 1, catalogDirectory, sessionKey, ...extra });
    assert.equal(response.ok, true, JSON.stringify(response)); return response.ok ? response.result : {};
  };
  const ingest = () => catalog({ op: "ingestStep", shardKey: "main", sourcePath, branchKey: "main", shardOrdinal: 0 });
  const pin = async (eventId: string) => (await catalog({ op: "pin", branchKey: "main", leaf: { shardKey: "main", eventId } })).view as CapsuleCatalogView;
  try {
    await ingest();
    const oldView = await pin("u0");
    const capsuleIdentity: DerivedStoreIdentity = { storeKey: randomUUID(), sessionKey, catalogStoreKey: oldView.storeKey, catalogGeneration: oldView.generation,
      derivedSchemaVersion: DERIVED_SCHEMA_VERSION, capsuleSchemaVersion: CAPSULE_SCHEMA_VERSION, chunkSchemaVersion: CHUNK_SCHEMA_VERSION,
      reducerSetVersion: CAPSULE_REDUCER_PIPELINE_VERSION, configHash: createHash("sha256").update("state-delta-capsules").digest("hex") };
    const identity: SearchV3Identity = { storeKey: randomUUID(), capsule: capsuleIdentity, schemaVersion: 1,
      configHash: createHash("sha256").update("state-delta-search").digest("hex") };
    const pages: { after: number; count: number; last: number }[] = [];
    const run = async (view: CapsuleCatalogView, op: string): Promise<any> => {
      const response = await executeEpisodeStateRequest({ v: 1, catalogDirectory, capsuleDirectory, searchDirectory, identity, view, op }, {
        catalogExecutor: async request => {
          assert.ok(isCatalogRequest(request), "every catalog call respects its existing contract");
          const result = await executeCatalogStoreRequest(request);
          if (request.op === "page" && request.limit === CATALOG_LIMITS.page && result.ok) {
            const events = result.result.events as { seq: number }[];
            pages.push({ after: request.after ?? 0, count: events.length, last: events.at(-1)?.seq ?? 0 });
          }
          return result;
        },
      });
      assert.equal(response.ok, true, JSON.stringify(response));
      assert.ok(response.sourceBytes <= EPISODE_STATE_LIMITS.sourceBytesPerJob);
      return response.ok ? response.result : {};
    };
    await deriveAll(capsuleDirectory, catalogDirectory, capsuleIdentity, oldView);
    let ready = false;
    for (let step = 0; step < 4 && !ready; step++) ready = (await run(oldView, "materializeState")).complete;
    assert.equal(ready, true);
    for (let index = 1; index <= 20; index++) appendFileSync(sourcePath,
      message(`m${index}`, index === 1 ? "u0" : `m${index - 1}`, "assistant", `Evidence detail ${index}.`)
      + message(`s${index}`, "u0", "assistant", `Sibling observation ${index}.`));
    await ingest();
    const view = await pin("m20");
    assert.equal(view.eventCut, 40);
    await deriveAll(capsuleDirectory, catalogDirectory, capsuleIdentity, view);
    pages.length = 0;
    const selection = await run(view, "composeStateSelection");
    assert.equal(selection.delta.verified, true);
    assert.equal(selection.delta.throughCut, view.eventCut);
    assert.equal(selection.delta.reason, "bounded-committed-delta");
    assert.deepEqual(pages, [{ after: 1, count: 16, last: 32 }, { after: 32, count: 4, last: 40 }]);
    appendFileSync(sourcePath, custom("h1", "m20", "chrono-compact-retention-hint", { preserveExact: "Keep the exact delta source." }));
    await ingest();
    const lateView = await pin("h1");
    pages.length = 0;
    const late = await run(lateView, "composeStateSelection");
    assert.equal(late.delta.verified, false);
    assert.equal(late.delta.throughCut, 1);
    assert.equal(late.delta.reason, "delta-requires-metadata-materialization");
    assert.deepEqual(pages, [{ after: 1, count: 16, last: 32 }, { after: 32, count: 5, last: 42 }]);
    t.diagnostic("20 noncontiguous events use 2 catalog pages; the 21st metadata writer refuses the overlay on page 2");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const mode of ["whole", "large"] as const) test(`state clause continuation: ${mode} body preserves exact recovery and old pins`, async t => {
  const directory = mkdtempSync(join(tmpdir(), "chrono-state-batches-"));
  const catalogDirectory = join(directory, "catalog"), capsuleDirectory = join(directory, "capsules"), searchDirectory = join(directory, "search");
  const sourcePath = join(directory, "main.jsonl"), sessionKey = `state-batches-${mode}`;
  mkdirSync(searchDirectory, { mode: 0o700 });
  const authorizationText = "I authorize retiring the prior repository restriction.";
  const authorizationRaw = message("u2", "u1", "user", authorizationText);
  writeFileSync(sourcePath, message("u1", null, "user", "Never deploy /Repo/Pinned.ts.") + authorizationRaw, { mode: 0o600 });
  const catalog = async (extra: Record<string, unknown>): Promise<any> => {
    const response = await executeCatalogStoreRequest({ v: 1, catalogDirectory, sessionKey, ...extra });
    assert.equal(response.ok, true, JSON.stringify(response)); return response.ok ? response.result : {};
  };
  const database = <T>(fn: (db: CatalogSqlite) => T): T => {
    const db = CatalogSqlite.open(join(searchDirectory, "state-v4.sqlite"));
    try { return fn(db); } finally { db.close(); }
  };
  try {
    await catalog({ op: "ingestStep", shardKey: "main", sourcePath, branchKey: "main", shardOrdinal: 0 });
    const oldView = (await catalog({ op: "pin", branchKey: "main", leaf: { shardKey: "main", eventId: "u1" } })).view as CapsuleCatalogView;
    const capsuleIdentity: DerivedStoreIdentity = { storeKey: randomUUID(), sessionKey, catalogStoreKey: oldView.storeKey, catalogGeneration: oldView.generation,
      derivedSchemaVersion: DERIVED_SCHEMA_VERSION, capsuleSchemaVersion: CAPSULE_SCHEMA_VERSION, chunkSchemaVersion: CHUNK_SCHEMA_VERSION,
      reducerSetVersion: CAPSULE_REDUCER_PIPELINE_VERSION, configHash: createHash("sha256").update("state-batches").digest("hex") };
    const identity: SearchV3Identity = { storeKey: randomUUID(), capsule: capsuleIdentity, schemaVersion: 1,
      configHash: createHash("sha256").update("state-batches-search").digest("hex") };
    const request = (view: CapsuleCatalogView, extra: Record<string, unknown>) => ({ v: 1, catalogDirectory, capsuleDirectory, searchDirectory, identity, view, ...extra });
    const run = async (view: CapsuleCatalogView, extra: Record<string, unknown>): Promise<any> => {
      const response = await executeEpisodeStateRequest(request(view, extra));
      assert.equal(response.ok, true, JSON.stringify(response));
      assert.ok(response.sourceBytes <= EPISODE_STATE_LIMITS.sourceBytesPerJob);
      assert.equal(response.sqliteNativeLimitBytes, EPISODE_STATE_LIMITS.nativeSqliteBytes);
      if (!response.ok) return {};
      if (extra.op === "materializeState") assert.ok(Number((response.result.metrics as any).stateItems) <= 32);
      return response.result;
    };
    const settle = async (view: CapsuleCatalogView): Promise<any> => {
      for (let step = 0; step < 16; step++) {
        const result = await run(view, { op: "materializeState" });
        if (result.complete) return result;
      }
      assert.fail("finite state batch continuation did not complete");
    };
    await deriveAll(capsuleDirectory, catalogDirectory, capsuleIdentity, oldView);
    const oldReady = await settle(oldView), oldPin = { eventSeq: 1, descriptor: 0, stableKey: "", generation: oldReady.stateGeneration };
    const oldRecall = await run(oldView, { op: "recallState", after: oldPin });
    const authorizationView = (await catalog({ op: "pin", branchKey: "main", leaf: { shardKey: "main", eventId: "u2" } })).view as CapsuleCatalogView;
    await deriveAll(capsuleDirectory, catalogDirectory, capsuleIdentity, authorizationView);
    const authorizedReady = await settle(authorizationView), states = (await run(authorizationView, { op: "recallState" })).items;
    const target = states.find((item: any) => item.evidence.source.eventSeq === 1);
    const authorization = states.find((item: any) => item.evidence.source.eventSeq === 2).evidence;
    await run(authorizationView, { op: "supersedeState", expectedGeneration: authorizedReady.stateGeneration,
      authorization: { source: authorization.source, decodedUtf16: authorization.decodedUtf16,
        spanHash: createHash("sha256").update(Buffer.from(authorizationText, "utf16le")).digest("hex"),
        rawEventHash: createHash("sha256").update(authorizationRaw.slice(0, -1)).digest("hex") },
      decision: { actor: "agent", basis: "direct-original-user-instruction", scope: "repository-and-chrono",
        action: "revoke-prior-user-restrictions-and-approval-holds", rationale: "The fixture authorizes this exact prior restriction." },
      targets: [{ stableKey: target.stableKey, propositionKey: target.propositionKey, spanKey: target.spanKey,
        createdGeneration: target.createdGeneration, evidenceHash: target.evidenceHash, kind: "restriction", authority: "user",
        scope: "repository", category: "restriction" }] });
    const oldRows = () => database(db => [...db.prepare("SELECT * FROM state_items WHERE eventSeq<=2 ORDER BY stableKey LIMIT 8").iterate(8)]);
    const preservedRows = oldRows();
    assert.ok(preservedRows.some(row => row.resolutionEvidence !== null));
    const count = mode === "whole" ? 70 : 96, width = mode === "whole" ? 64 : 512;
    const clauses = Array.from({ length: count }, (_, index) => index % 2
      ? "Goal: verify /Repo/Batch.ts before any release." : "Never deploy /Repo/Batch.ts without approval.");
    const text = clauses.map(clause => clause.padEnd(width - 1, " ") + "\n").join("");
    appendFileSync(sourcePath, message("u3", "u2", "user", text));
    const sourceHash = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
    await catalog({ op: "ingestStep", shardKey: "main", sourcePath, branchKey: "main", shardOrdinal: 0 });
    const view = (await catalog({ op: "pin", branchKey: "main", leaf: { shardKey: "main", eventId: "u3" } })).view as CapsuleCatalogView;
    await deriveAll(capsuleDirectory, catalogDirectory, capsuleIdentity, view);
    let result = await run(view, { op: "materializeState" }), jobs = 1;
    assert.equal(result.bodyCheckpoint.afterState, 32);
    assert.equal(result.next.eventSeq, 2);
    assert.equal(result.metadata.afterEventSeq, 2);
    const pendingStatus = await run(view, { op: "stateStatus" });
    assert.deepEqual(pendingStatus.bodyCheckpoint, result.bodyCheckpoint);
    assert.equal(pendingStatus.complete, false);
    const pendingSelection = await run(view, { op: "composeStateSelection" });
    assert.equal(pendingSelection.coverage.bodyComplete, false);
    assert.equal(pendingSelection.coverage.restrictionsComplete, false);
    assert.equal(pendingSelection.coverage.openWorkComplete, false);
    const checkpointRow = database(db => db.prepare("SELECT * FROM large_bodies LIMIT 1").get()!);
    const checkpoint = JSON.parse(String(checkpointRow.envelope));
    assert.equal(checkpoint.format, "state-clause-batch-v1");
    assert.equal(checkpoint.source, undefined, "old writers cannot treat this payload as a bare envelope");
    assert.deepEqual(checkpoint.view, view);
    const snapshot = () => database(db => ({ head: db.prepare("SELECT * FROM heads LIMIT 1").get(),
      checkpoint: db.prepare("SELECT * FROM large_bodies LIMIT 1").get(),
      meta: db.prepare("SELECT generation FROM meta").get(),
      rows: [...db.prepare("SELECT * FROM state_items ORDER BY eventSeq,stableKey LIMIT 256").iterate(256)],
      cuts: [...db.prepare("SELECT * FROM cuts ORDER BY eventSeq,descriptor LIMIT 16").iterate(16)],
      coverage: [...db.prepare("SELECT * FROM coverage ORDER BY eventSeq,descriptor LIMIT 16").iterate(16)] }));
    // A release-validation run can also invoke the actual previous built executor.
    let previousRefused = false;
    if (process.env.CHRONO_PREVIOUS_STATE_EXECUTOR) {
      const previous = await import(pathToFileURL(process.env.CHRONO_PREVIOUS_STATE_EXECUTOR).href);
      const before = snapshot(), refusal = await previous.executeEpisodeStateRequest(request(view, { op: "materializeState" }));
      assert.equal(refusal.ok, false, "a downlevel writer must refuse the new checkpoint");
      assert.deepEqual(snapshot(), before, "downlevel refusal cannot publish, erase, or restart a batch");
      previousRefused = true;
    }
    const badCursor = structuredClone(checkpoint);
    badCursor.batch.cursor.afterState = 64;
    database(db => db.prepare("UPDATE large_bodies SET envelope=?").run(JSON.stringify(badCursor)));
    const beforeBad = snapshot(), bad = await executeEpisodeStateRequest(request(view, { op: "materializeState" }));
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.code, "search-v3-state-checkpoint-corrupt");
    assert.deepEqual(snapshot(), beforeBad, "an unbound cursor cannot skip source clauses or move the head");
    database(db => db.prepare("UPDATE large_bodies SET envelope=?").run(String(checkpointRow.envelope)));
    let legacyCheckpointResumed = false;
    for (; jobs < 12 && !result.complete; jobs++) {
      result = await run(view, { op: "materializeState" });
      if (result.bodyCheckpoint) {
        assert.equal(result.next.eventSeq, 2, "the body cut stays behind the entire envelope");
        assert.equal(result.metadata.afterEventSeq, 2, "metadata cannot pass a pending body");
        if (mode === "large" && !legacyCheckpointResumed && result.bodyCheckpoint.afterState === 0) {
          // A legacy checkpoint has no state cursor and may carry earlier unrepaired gaps.
          database(db => {
            const row = db.prepare("SELECT envelope FROM large_bodies LIMIT 1").get()!;
            const legacy = JSON.parse(String(row.envelope));
            db.prepare("UPDATE large_bodies SET envelope=?,restrictionGap=0,openWorkGap=1,partial=1").run(JSON.stringify(legacy.envelope));
          });
          legacyCheckpointResumed = true;
        }
      }
    }
    assert.equal(result.complete, true, "the fixed-size batches reach a finite completed body and metadata cut");
    assert.equal(result.knownThroughCut, view.eventCut);
    assert.equal(database(db => db.prepare("SELECT 1 AS found FROM large_bodies LIMIT 1").get()), undefined);
    const recovered = database(db => [...db.prepare("SELECT * FROM state_items WHERE eventSeq=3 ORDER BY stableKey LIMIT 256").iterate(256)]);
    assert.equal(recovered.length, count, "overlap is deduplicated without collapsing repeated text at distinct positions");
    for (let index = 0; index < count; index++) {
      const start = index * width, end = start + clauses[index]!.length;
      const spanKey = createHash("sha256").update(`${JSON.stringify(checkpoint.envelope.source)}\n${start}\n${end}`).digest("hex");
      const row = recovered.find(item => item.spanKey === spanKey);
      assert.ok(row, `exact source-relative span ${index} is recovered`);
      const evidence = JSON.parse(String(row.evidence));
      assert.equal(evidence.exactText, text.slice(start, end));
      assert.deepEqual(evidence.decodedUtf16, { start, end });
      assert.equal(row.authority, "user");
      assert.equal(row.confidence, "verified");
      assert.equal(row.kind, index % 2 ? "goal" : "restriction");
    }
    assert.deepEqual(oldRows(), preservedRows, "prior rows and explicit supersession records stay byte-identical");
    assert.deepEqual((await run(oldView, { op: "recallState", after: oldPin })).items, oldRecall.items);
    const coverage = database(db => db.prepare("SELECT restrictionGap,openWorkGap,optionalGap FROM coverage WHERE eventSeq=3").get()!);
    assert.deepEqual(coverage, mode === "whole" ? { restrictionGap: 0, openWorkGap: 0, optionalGap: 0 }
      : { restrictionGap: 1, openWorkGap: 1, optionalGap: 1 }, "legacy gaps remain and the old span-key prefix is not certified");
    assert.equal(createHash("sha256").update(readFileSync(sourcePath)).digest("hex"), sourceHash);
    t.diagnostic(JSON.stringify({ mode, recovered: recovered.length, materializeJobs: jobs, stateBatchLimit: 32,
      previousRefused, legacyCheckpointResumed, oldPinPreserved: true, supersessionPreserved: true }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
