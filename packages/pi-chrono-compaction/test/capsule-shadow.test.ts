import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CapsuleShadowScheduler, type CapsuleShadowTarget, type CapsuleShadowProgress } from "../src/capsule-shadow.js";

const target: CapsuleShadowTarget = {
  v: 1, op: "derivePage", catalogDirectory: "/synthetic/catalog", derivedDirectory: "/synthetic/derived",
  identity: { storeKey: "22222222-2222-4222-8222-222222222222", sessionKey: "synthetic",
    catalogStoreKey: "11111111-1111-4111-8111-111111111111", catalogGeneration: 1,
    derivedSchemaVersion: 1, capsuleSchemaVersion: 1, chunkSchemaVersion: 1, reducerSetVersion: "v1", configHash: "a".repeat(64) },
  view: { storeKey: "11111111-1111-4111-8111-111111111111", sessionKey: "synthetic", generation: 1,
    branchKey: "branch", eventCut: 2, segments: [{ segment: 1, cut: 2 }] },
};
function progress(value = target): CapsuleShadowProgress {
  const common = { eligible: 1, ready: 0, unsupported: 1, failed: 0, excluded: 0, afterEventSeq: 2, afterDescriptor: 0, resumable: false };
  return { complete: true, sourceBytes: 0, readiness: { v: 1, identity: value.identity, view: value.view, catalog: "pinned",
    capsules: { ...common, layer: "capsules", state: "unsupported" },
    chunks: { ...common, layer: "chunks", state: "ready", ready: 1, unsupported: 0 } } };
}
async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > end) assert.fail("scheduler condition not reached"); await delay(5); }
}

test("capsule shadow is default-off and settlement does not invent capsule readiness", async () => {
  let calls = 0;
  const scheduler = new CapsuleShadowScheduler(async input => { calls++; return progress(input); });
  try {
    scheduler.schedule(target);
    await delay(10);
    assert.equal(calls, 0);
    assert.deepEqual(scheduler.status(), { state: "disabled" });
    scheduler.schedule(target, true);
    assert.equal(calls, 0, "no store operation on scheduling stack");
    await until(() => scheduler.status().state === "settled");
    assert.equal(calls, 1);
    assert.equal(scheduler.status().readiness?.capsules.state, "unsupported");
    assert.equal(scheduler.status().readiness?.chunks.state, "ready");
    assert.equal(JSON.stringify(scheduler.status()).includes("/synthetic"), false);
  } finally { scheduler.dispose(); await scheduler.drain(); }
});

test("replacement waits for actual caller settlement and ignores stale progress", async () => {
  let release!: () => void;
  let firstSignal: AbortSignal | undefined;
  const seen: string[] = [];
  const gate = new Promise<void>(resolve => { release = resolve; });
  const scheduler = new CapsuleShadowScheduler(async (input, signal) => {
    seen.push(input.view.branchKey);
    if (seen.length === 1) { firstSignal = signal; await gate; }
    return progress(input);
  });
  try {
    scheduler.schedule(target, true);
    await until(() => seen.length === 1);
    const replacement = { ...target, view: { ...target.view, branchKey: "replacement" } };
    scheduler.schedule(replacement, true);
    assert.equal(firstSignal?.aborted, true);
    await delay(20);
    assert.deepEqual(seen, ["branch"]);
    release();
    await until(() => scheduler.status().state === "settled");
    assert.deepEqual(seen, ["branch", "replacement"]);
    assert.equal(scheduler.status().readiness?.view.branchKey, "replacement");
  } finally { release(); scheduler.dispose(); await scheduler.drain(); }
});

test("shadow failure is sanitized and does not automatically retry", async () => {
  let calls = 0;
  const scheduler = new CapsuleShadowScheduler(async () => { calls++; throw new Error("private diagnostic"); });
  try {
    scheduler.schedule(target, true);
    await until(() => scheduler.status().state === "error");
    await delay(120);
    assert.equal(calls, 1);
    assert.deepEqual(scheduler.status(), { state: "error", errorCode: "capsule-shadow-failed" });
  } finally { scheduler.dispose(); await scheduler.drain(); }
});
