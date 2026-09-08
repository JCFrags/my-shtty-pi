import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { runCapsuleWorker } from "../src/capsule-worker-client.js";
import { schedulerArtifactCounts } from "../src/host-worker-scheduler.js";
import { runtimeUnitName, runtimeUnitState } from "../src/worker-runtime-systemd.js";
import { setupCapsuleFixture, line } from "./capsule-storage-fixture.js";
import type { CapsuleWorkerRequest } from "../src/capsule-contract.js";

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
    const counts = await schedulerArtifactCounts(schedulerDirectory);
    assert.deepEqual(counts, { tickets: 0, slots: 0 });
    assert.equal(await runtimeUnitState(runtimeUnitName(schedulerDirectory, 0)), "inactive");
    fixture.cleanup();
  }
});
