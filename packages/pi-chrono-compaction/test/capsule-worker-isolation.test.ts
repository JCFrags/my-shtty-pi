import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runCapsuleWorker } from "../src/capsule-worker-client.js";
import { schedulerArtifactCounts } from "../src/host-worker-scheduler.js";
import { withRuntimeMutex } from "../src/worker-runtime-mutex.js";
import { runtimeUnitName, runtimeUnitState } from "../src/worker-runtime-systemd.js";
import { setupCapsuleFixture, line } from "./capsule-storage-fixture.js";
import type { CapsuleWorkerRequest } from "../src/capsule-contract.js";
import { CatalogSqlite } from "../src/catalog-sqlite.js";

async function waitForActiveOwnedUnit(schedulerDirectory: string): Promise<void> {
  const unit = runtimeUnitName(schedulerDirectory, 0), deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const counts = await schedulerArtifactCounts(schedulerDirectory);
    if (counts.slots === 1 && await runtimeUnitState(unit) === "active") return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("capsule worker never reached an admitted active unit");
}

async function holdMutex(path: string): Promise<() => Promise<void>> {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const settled = withRuntimeMutex(path, async () => { enter(); await held; });
  await entered;
  return async () => { release(); await settled; };
}

async function assertWorkerSettlement(schedulerDirectory: string): Promise<void> {
  assert.deepEqual(await schedulerArtifactCounts(schedulerDirectory), { tickets: 0, slots: 0 });
  assert.equal(await runtimeUnitState(runtimeUnitName(schedulerDirectory, 0)), "inactive");
}

function immutableArtifacts(derivedDirectory: string): Record<string, string[]> {
  const names = (path: string) => readdirSync(join(derivedDirectory, path)).sort();
  return {
    capsuleSegments: names("segments/capsules"), chunkSegments: names("segments/chunks"),
    manifests: names("manifests"), receipts: names("receipts"),
  };
}

test("capsule derive and reads use real contained workers in a synthetic namespace", async () => {
  const text = "not completed; pending approval; λ 😀 \ud800\r\n";
  const fixture = setupCapsuleFixture(line("a", null, text));
  const schedulerDirectory = join(fixture.directory, "scheduler");
  const observations: Record<string, any>[] = [];
  try {
    const view = await fixture.initialize();
    const base = { v: 1 as const, identity: fixture.identity, view, catalogDirectory: fixture.catalogDirectory, derivedDirectory: fixture.derivedDirectory };
    async function call(request: CapsuleWorkerRequest) {
      const response = await runCapsuleWorker(request, { schedulerDirectory, slots: 1 });
      assert.equal(response.ok, true, JSON.stringify(response));
      const observation = response.result.workerObservation as Record<string, any>;
      assert.ok(observation);
      assert.equal(observation.cgroupMemoryLimitBytes, 256 * 1024 * 1024);
      assert.ok(observation.processPeakRssBytes <= 256 * 1024 * 1024);
      assert.ok(observation.cgroupMemoryPeakBytes <= 256 * 1024 * 1024);
      observations.push(observation);
      return response;
    }
    let completed = false;
    for (let page = 0; page < 8; page++) {
      const response = await call({ ...base, op: "derivePage" });
      if (response.result.complete === true) { completed = true; break; }
    }
    assert.equal(completed, true);
    const status = await call({ ...base, op: "status" });
    const readiness = status.result.readiness as any;
    // M04 emits both the block descriptor and its text-body descriptor.
    // The body is reduced; the bodyless block descriptor remains unsupported.
    assert.equal(readiness.capsules.state, "unsupported");
    assert.equal(readiness.capsules.ready, 1);
    assert.equal(readiness.capsules.unsupported, 1);
    assert.equal(readiness.capsules.eligible, 2);
    assert.equal(readiness.chunks.state, "ready");
    const page = await call({ ...base, op: "capsulePage", limit: 1 });
    const capsule = (page.result.capsules as any[])[0];
    assert.ok(capsule);
    assert.equal(capsule.provenance, "original");
    assert.ok(capsule.alternatives.every((alternative: any) => alternative.outcome.status === "unknown"));
    const range = await call({ ...base, op: "chunkRange", source: capsule.source, decodedStart: 0, decodedLength: text.length, limit: 1 });
    assert.equal(Buffer.from(range.result.data as string, "base64").toString("utf16le"), text);
    assert.ok(observations.length >= 4);
  } finally {
    // Do not remove artifacts of an active worker. Awaited clients must settle.
    await assertWorkerSettlement(schedulerDirectory);
    fixture.cleanup();
  }
});

test("real contained chunkRange refuses a valid foreign same-view chunk association", async () => {
  const fixture = setupCapsuleFixture(line("a", null, "worker-A") + line("b", "a", "worker-B"));
  const schedulerDirectory = join(fixture.directory, "foreign-chunk-scheduler");
  try {
    const view = await fixture.initialize("b");
    const base = { v: 1 as const, identity: fixture.identity, view, catalogDirectory: fixture.catalogDirectory, derivedDirectory: fixture.derivedDirectory };
    for (let page = 0; page < 12; page++) {
      const derived = await runCapsuleWorker({ ...base, op: "derivePage" }, { schedulerDirectory, slots: 1 });
      assert.equal(derived.ok, true, JSON.stringify(derived));
      if (derived.ok && derived.result.complete === true) break;
      if (page === 11) assert.fail("real worker derive did not complete");
    }
    const page = await runCapsuleWorker({ ...base, op: "capsulePage", limit: 4 }, { schedulerDirectory, slots: 1 });
    assert.equal(page.ok, true, JSON.stringify(page)); if (!page.ok) throw new Error("capsule page refused");
    const [sourceA, sourceB] = (page.result.capsules as any[]).map(item => item.source);
    const chunks = join(fixture.derivedDirectory, "segments/chunks");
    const immutableBefore = readdirSync(chunks).sort().map(name => [name, readFileSync(join(chunks, name))]);
    const db = CatalogSqlite.open(join(fixture.derivedDirectory, "derived.sqlite"));
    const foreign = db.prepare("SELECT * FROM artifacts WHERE layer='chunks' AND eventSeq=? AND descriptor=? AND chunkIndex=0").get(sourceB.eventSeq, sourceB.descriptor)!;
    db.prepare("UPDATE artifacts SET source=?,record=?,manifestHash=?,segmentHash=?,segmentBytes=?,segmentOffset=?,payloadBytes=?,contentHash=? WHERE layer='chunks' AND eventSeq=? AND descriptor=? AND chunkIndex=0")
      .run(String(foreign.source), String(foreign.record), String(foreign.manifestHash), String(foreign.segmentHash), Number(foreign.segmentBytes), Number(foreign.segmentOffset), Number(foreign.payloadBytes), String(foreign.contentHash),
        sourceA.eventSeq, sourceA.descriptor);
    db.close();

    const response = await runCapsuleWorker({ ...base, op: "chunkRange", source: sourceA, decodedStart: 0, decodedLength: 8, limit: 1 }, { schedulerDirectory, slots: 1 });
    assert.equal(response.ok, false, "contained worker must not return foreign valid bytes");
    assert.deepEqual(readdirSync(chunks).sort().map(name => [name, readFileSync(join(chunks, name))]), immutableBefore);
  } finally {
    await assertWorkerSettlement(schedulerDirectory);
    fixture.cleanup();
  }
});

test("real contained chunkRange refuses a valid foreign sibling chunk association", async () => {
  const fixture = setupCapsuleFixture(line("a", null, "worker-ancestor") + line("b", "a", "worker-sibling-B"));
  const schedulerDirectory = join(fixture.directory, "foreign-sibling-scheduler");
  try {
    const bView = await fixture.initialize("b");
    const base = { v: 1 as const, identity: fixture.identity, catalogDirectory: fixture.catalogDirectory, derivedDirectory: fixture.derivedDirectory };
    const derive = async (view: any) => {
      for (let page = 0; page < 12; page++) {
        const response = await runCapsuleWorker({ ...base, view, op: "derivePage" }, { schedulerDirectory, slots: 1 });
        assert.equal(response.ok, true, JSON.stringify(response));
        if (response.ok && response.result.complete === true) return;
      }
      assert.fail("real sibling worker derive did not complete");
    };
    await derive(bView);
    fixture.append(line("c", "a", "worker-selected-C")); await fixture.ingest();
    const cView = (await fixture.catalog({ op: "pin", branchKey: "main", leaf: { shardKey: "s1", eventId: "c" } })).view;
    await derive(cView);
    const bPage = await runCapsuleWorker({ ...base, view: bView, op: "capsulePage", limit: 4 }, { schedulerDirectory, slots: 1 });
    const cPage = await runCapsuleWorker({ ...base, view: cView, op: "capsulePage", limit: 4 }, { schedulerDirectory, slots: 1 });
    assert.equal(bPage.ok, true, JSON.stringify(bPage)); assert.equal(cPage.ok, true, JSON.stringify(cPage));
    if (!bPage.ok || !cPage.ok) throw new Error("sibling capsule page refused");
    const sourceB = (bPage.result.capsules as any[]).find(item => item.source.eventSeq === 2)!.source;
    const sourceC = (cPage.result.capsules as any[]).find(item => item.source.eventSeq === 3)!.source;
    const chunks = join(fixture.derivedDirectory, "segments/chunks");
    const immutableBefore = readdirSync(chunks).sort().map(name => [name, readFileSync(join(chunks, name))]);
    const sourceBefore = readFileSync(fixture.sourcePath);
    const db = CatalogSqlite.open(join(fixture.derivedDirectory, "derived.sqlite"));
    const foreign = db.prepare("SELECT * FROM artifacts WHERE layer='chunks' AND eventSeq=? AND descriptor=? AND chunkIndex=0").get(sourceB.eventSeq, sourceB.descriptor)!;
    db.prepare("UPDATE artifacts SET source=?,record=?,manifestHash=?,segmentHash=?,segmentBytes=?,segmentOffset=?,payloadBytes=?,contentHash=? WHERE layer='chunks' AND eventSeq=? AND descriptor=? AND chunkIndex=0")
      .run(String(foreign.source), String(foreign.record), String(foreign.manifestHash), String(foreign.segmentHash), Number(foreign.segmentBytes), Number(foreign.segmentOffset), Number(foreign.payloadBytes), String(foreign.contentHash),
        sourceC.eventSeq, sourceC.descriptor);
    db.close();

    const response = await runCapsuleWorker({ ...base, view: cView, op: "chunkRange", source: sourceC, decodedStart: 0, decodedLength: 8, limit: 1 }, { schedulerDirectory, slots: 1 });
    assert.equal(response.ok, false, "contained worker must not return a valid chunk from a sibling ancestry");
    assert.deepEqual(readdirSync(chunks).sort().map(name => [name, readFileSync(join(chunks, name))]), immutableBefore);
    assert.deepEqual(readFileSync(fixture.sourcePath), sourceBefore);
  } finally {
    await assertWorkerSettlement(schedulerDirectory);
    fixture.cleanup();
  }
});

test("duplicate real clients coalesce and leave deterministic idempotent store artifacts", async () => {
  const fixture = setupCapsuleFixture(line("a", null, "small duplicate client fixture"));
  const schedulerDirectory = join(fixture.directory, "duplicate-scheduler");
  let releaseMutex: (() => Promise<void>) | undefined;
  let clients: ReturnType<typeof runCapsuleWorker>[] = [];
  try {
    const view = await fixture.initialize();
    const request: CapsuleWorkerRequest = { v: 1, identity: fixture.identity, view,
      catalogDirectory: fixture.catalogDirectory, derivedDirectory: fixture.derivedDirectory, op: "derivePage" };
    const initial = await runCapsuleWorker(request, { schedulerDirectory, slots: 1 });
    assert.equal(initial.ok, true, JSON.stringify(initial));
    const before = immutableArtifacts(fixture.derivedDirectory);

    releaseMutex = await holdMutex(join(fixture.derivedDirectory, "publication.lock"));
    clients = [runCapsuleWorker(request, { schedulerDirectory, slots: 1 }), runCapsuleWorker(request, { schedulerDirectory, slots: 1 })];
    await waitForActiveOwnedUnit(schedulerDirectory);
    assert.deepEqual(await schedulerArtifactCounts(schedulerDirectory), { tickets: 0, slots: 1 });
    await releaseMutex(); releaseMutex = undefined;
    const [first, second] = await Promise.all(clients);
    assert.ok(first); assert.ok(second);
    assert.equal(first.ok, true, JSON.stringify(first)); assert.deepEqual(second, first,
      "both clients must receive the one coalesced worker result");
    if (!first.ok || !second.ok) throw new Error("duplicate capsule worker refused");
    assert.deepEqual(immutableArtifacts(fixture.derivedDirectory), before,
      "duplicate completed derives must not add immutable store artifacts");
    await assertWorkerSettlement(schedulerDirectory);
  } finally {
    if (releaseMutex) await releaseMutex();
    await Promise.allSettled(clients);
    await assertWorkerSettlement(schedulerDirectory);
    fixture.cleanup();
  }
});

test("aborting an admitted active capsule worker settles its unit and admission", async () => {
  const fixture = setupCapsuleFixture(line("a", null, "small active cancellation fixture"));
  const schedulerDirectory = join(fixture.directory, "abort-scheduler");
  let releaseMutex: (() => Promise<void>) | undefined;
  let pending: ReturnType<typeof runCapsuleWorker> | undefined;
  const controller = new AbortController();
  try {
    const view = await fixture.initialize();
    const request: CapsuleWorkerRequest = { v: 1, identity: fixture.identity, view,
      catalogDirectory: fixture.catalogDirectory, derivedDirectory: fixture.derivedDirectory, op: "derivePage" };
    const initial = await runCapsuleWorker(request, { schedulerDirectory, slots: 1 });
    assert.equal(initial.ok, true, JSON.stringify(initial));

    releaseMutex = await holdMutex(join(fixture.derivedDirectory, "publication.lock"));
    pending = runCapsuleWorker(request, { schedulerDirectory, slots: 1, signal: controller.signal });
    await waitForActiveOwnedUnit(schedulerDirectory);
    controller.abort();
    const aborted = await pending;
    assert.equal(aborted.ok, false); if (!aborted.ok) assert.equal(aborted.code, "capsule-worker-aborted");
    await assertWorkerSettlement(schedulerDirectory);
  } finally {
    controller.abort();
    if (releaseMutex) await releaseMutex();
    if (pending) await Promise.allSettled([pending]);
    await assertWorkerSettlement(schedulerDirectory);
    fixture.cleanup();
  }
});
