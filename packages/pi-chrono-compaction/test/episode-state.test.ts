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
import { CatalogSqlite, CatalogSqliteError } from "../src/catalog-sqlite.js";
import { executeCapsuleRequest } from "../src/capsule-store.js";
import { reduceEpisodeStateEnvelope } from "../src/episode-state-reducer.js";
import { executeEpisodeStateRequest } from "../src/episode-state-store.js";
import { createMemoryEvent } from "../src/memory-store.js";
import { composeStoredSelection, persistPrivateCompositionArtifact } from "../src/context-composer.js";
import type { EpisodeStateSelection } from "../src/episode-state-contract.js";
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
    assert.equal(packed?.coveredPropositions?.length, 20,
      "one exact paragraph representation retains all covered propositions and source coordinates");
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
