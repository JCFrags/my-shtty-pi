import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CAPSULE_REDUCER_PIPELINE_VERSION, CAPSULE_SCHEMA_VERSION, CHUNK_SCHEMA_VERSION, DERIVED_SCHEMA_VERSION,
  type CapsuleCatalogView, type DerivedStoreIdentity,
} from "../src/capsule-contract.js";
import { executeCatalogStoreRequest } from "../src/catalog-store.js";
import { executeCapsuleRequest } from "../src/capsule-store.js";
import { executeEpisodeStateRequest } from "../src/episode-state-store.js";
import type { SearchV3Identity } from "../src/search-v3-contract.js";

const message = (id: string, parentId: string | null, role: string, text: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: "message", id, parentId, message: { role, ...extra, content: [{ type: "text", text }] } }) + "\n";

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

test("actual catalog facts drive bounded episodes/state across append restart and fork-pinned recall", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chrono-state-"));
  const catalogDirectory = join(directory, "catalog"), capsuleDirectory = join(directory, "capsules"), searchDirectory = join(directory, "search");
  const rootPath = join(directory, "root.jsonl"), mainPath = join(directory, "main.jsonl"), forkPath = join(directory, "fork.jsonl");
  mkdirSync(searchDirectory, { mode: 0o700 });
  writeFileSync(rootPath, message("u1", null, "user", "Goal: implement /Repo/Foo.ts revision abc123. Do not deploy it unless approved. This is not approved."), { mode: 0o600 });
  writeFileSync(mainPath,
    message("t1", "u1", "toolResult", "Failure for /Repo/Foo.ts revision abc123: tests failed.", { toolName: "bash", isError: true, exitCode: 1 })
    + message("a1", "t1", "assistant", "Implemented /Repo/Foo.ts, but this is only a report." )
    + message("u2", "a1", "user", "I approve deployment of /Repo/Foo.ts revision abc123." )
    + message("t2", "u2", "toolResult", "Verified success for /Repo/Foo.ts revision abc123; tests passed.", { toolName: "bash", isError: false, exitCode: 0 }), { mode: 0o600 });
  writeFileSync(forkPath, message("f1", "u1", "user", "Only inspect /Repo/Fork.ts; never deploy it."), { mode: 0o600 });
  const sessionKey = "state-real-catalog";
  const catalog = async (extra: Record<string, unknown>): Promise<Record<string, any>> => {
    const response = await executeCatalogStoreRequest({ v: 1, catalogDirectory, sessionKey, ...extra });
    assert.equal(response.ok, true, JSON.stringify(response)); return response.ok ? response.result : {};
  };
  const ingest = (shardKey: string, sourcePath: string, branchKey: string, shardOrdinal: number, parent?: Record<string, string>) =>
    catalog({ op: "ingestStep", shardKey, sourcePath, branchKey, shardOrdinal, ...(parent ? { parent } : {}) });
  const pin = async (branchKey: string, shardKey: string, eventId: string): Promise<CapsuleCatalogView> =>
    (await catalog({ op: "pin", branchKey, leaf: { shardKey, eventId } })).view;
  try {
    await ingest("root", rootPath, "root", 0); await ingest("main", mainPath, "main", 1, { shardKey: "root", eventId: "u1" });
    const oldMain = await pin("main", "main", "t2");
    const capsuleIdentity: DerivedStoreIdentity = { storeKey: randomUUID(), sessionKey, catalogStoreKey: oldMain.storeKey, catalogGeneration: oldMain.generation,
      derivedSchemaVersion: DERIVED_SCHEMA_VERSION, capsuleSchemaVersion: CAPSULE_SCHEMA_VERSION, chunkSchemaVersion: CHUNK_SCHEMA_VERSION,
      reducerSetVersion: CAPSULE_REDUCER_PIPELINE_VERSION, configHash: createHash("sha256").update("state-capsules").digest("hex") };
    const identity: SearchV3Identity = { storeKey: randomUUID(), capsule: capsuleIdentity, schemaVersion: 1,
      configHash: createHash("sha256").update("state-search").digest("hex") };
    const run = (view: CapsuleCatalogView, extra: Record<string, unknown>) => executeEpisodeStateRequest({ v: 1, catalogDirectory, capsuleDirectory,
      searchDirectory, identity, view, ...extra });
    const materializeAll = async (view: CapsuleCatalogView): Promise<Record<string, any>> => {
      for (let page = 0; page < 100; page++) {
        const response = await run(view, { op: "materializeState", limit: 3 });
        assert.equal(response.ok, true, JSON.stringify(response));
        if (response.ok && (response.result as any).complete) return response.result as Record<string, any>;
      }
      return assert.fail("state materialization did not complete");
    };
    await deriveAll(capsuleDirectory, catalogDirectory, capsuleIdentity, oldMain);
    const partialPage = await run(oldMain, { op: "materializeState", limit: 1 });
    assert.equal(partialPage.ok, true, JSON.stringify(partialPage));
    const partialRecall = await run(oldMain, { op: "recallState", level: "state", limit: 1 });
    assert.equal(partialRecall.ok, true, JSON.stringify(partialRecall));
    if (partialPage.ok && partialRecall.ok) {
      assert.equal(partialRecall.result.knownThrough, partialPage.result.knownThroughCut, "recall must not certify the partially processed event");
      assert.equal(partialRecall.result.partial, true);
    }
    const oldReady = await materializeAll(oldMain);
    assert.equal(oldReady.knownThroughCut, oldMain.eventCut);
    const oldEpisodes = await run(oldMain, { op: "recallState", level: "episode", query: "implement", limit: 1 });
    assert.equal(oldEpisodes.ok, true, JSON.stringify(oldEpisodes)); if (!oldEpisodes.ok) return;
    const firstEpisode = (oldEpisodes.result as any).items[0];
    assert.equal(firstEpisode.member.source.entryId, "u1");
    assert.equal(firstEpisode.episode.open, false, "next original user request closes span, not assistant prose");
    assert.equal(typeof (oldEpisodes.result as any).next?.generation, "number");
    const states = await run(oldMain, { op: "recallState", level: "state", limit: 12 });
    assert.equal(states.ok, true, JSON.stringify(states)); if (!states.ok) return;
    const stateItems = (states.result as any).items;
    assert.ok(stateItems.some((item: any) => item.kind === "restriction" && item.authority === "user"));
    assert.equal(stateItems.filter((item: any) => item.kind === "approval").length, 1, "negated approval is not authority");
    assert.ok(stateItems.some((item: any) => item.kind === "reportedimplementation" && item.authority === "assistant-report"));
    assert.ok(stateItems.some((item: any) => item.kind === "observedverification" && item.authority === "verified-tool"));
    const resources = await run(oldMain, { op: "recallState", level: "resource", query: "Repo Foo", limit: 12 });
    assert.equal(resources.ok, true, JSON.stringify(resources)); if (resources.ok) {
      assert.ok((resources.result as any).items.every((item: any) => item.resourceKey.includes("/Repo/Foo.ts")));
      assert.ok((resources.result as any).items.some((item: any) => item.revisionBasis === "declared" && item.revision === "abc123"));
      assert.ok((resources.result as any).items.some((item: any) => item.evidence.source.entryId === "a1" && item.revisionBasis === "unknown" && item.revision === null), "an implementation report without a revision stays unknown");
    }
    const pinGeneration = (oldEpisodes.result as any).stateGeneration;

    appendFileSync(mainPath, message("u3", "t2", "user", "Instead, only inspect /Repo/Foo.ts revision abc123; do not deploy it."));
    await ingest("main", mainPath, "main", 1, { shardKey: "root", eventId: "u1" });
    await ingest("fork", forkPath, "fork", 2, { shardKey: "root", eventId: "u1" });
    const newMain = await pin("main", "main", "u3"), fork = await pin("fork", "fork", "f1");
    await deriveAll(capsuleDirectory, catalogDirectory, capsuleIdentity, newMain); await materializeAll(newMain);
    await deriveAll(capsuleDirectory, catalogDirectory, capsuleIdentity, fork); await materializeAll(fork);
    const pinned = await run(oldMain, { op: "recallState", level: "episode", query: "implement", limit: 1,
      after: { eventSeq: 1, descriptor: 0, stableKey: "", generation: pinGeneration } });
    assert.equal(pinned.ok, true, JSON.stringify(pinned));
    if (pinned.ok && (pinned.result as any).items[0]) assert.equal((pinned.result as any).items[0].episode.end.eventSeq <= oldMain.eventCut, true);
    const forkState = await run(fork, { op: "recallState", level: "state", query: "Fork", limit: 12 });
    assert.equal(forkState.ok, true, JSON.stringify(forkState));
    if (forkState.ok) assert.ok((forkState.result as any).items.every((item: any) => item.evidence.source.entryId !== "u3"), "fork cannot see main append");
    const exactEpisode = await run(newMain, { op: "recallState", level: "episode", source: firstEpisode.member.source, limit: 1 });
    assert.equal(exactEpisode.ok, true, JSON.stringify(exactEpisode));
    if (exactEpisode.ok) assert.equal((exactEpisode.result as any).items[0].member.source.bodyHash, firstEpisode.member.source.bodyHash);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
