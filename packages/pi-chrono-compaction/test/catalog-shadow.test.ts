import { test } from "node:test";
import assert from "node:assert/strict";
import { CatalogShadowScheduler, type CatalogShadowProgress, type CatalogShadowTarget } from "../src/catalog-shadow.js";
const target: CatalogShadowTarget = { catalogDirectory: "/synthetic/catalog", sourcePath: "/synthetic/session.jsonl", sessionKey: "a".repeat(64), shardKey: "b".repeat(64) };
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const done: CatalogShadowProgress = { complete: true, sourceBytesRead: 32, events: 1 };
test("catalog shadow default off performs no callback and enabled scheduling is nonblocking", async () => {
  let calls = 0;
  const scheduler = new CatalogShadowScheduler(async () => { calls++; return done; });
  try {
    scheduler.schedule(target, false); await pause();
    assert.equal(calls, 0); assert.equal(scheduler.status().state, "disabled");
    scheduler.schedule(target, true);
    assert.equal(calls, 0, "no source or database work on the interactive scheduling stack");
    await pause(); await scheduler.drain();
    assert.equal(calls, 1); assert.equal(scheduler.status().state, "ready");
  } finally { scheduler.dispose(); }
});
test("catalog shadow retains one replacement and waits for cancelled caller settlement", async () => {
  const signals: AbortSignal[] = [];
  const resolutions: ((result: CatalogShadowProgress) => void)[] = [];
  const scheduler = new CatalogShadowScheduler(async (_target, signal) => {
    signals.push(signal); return new Promise(resolve => resolutions.push(resolve));
  });
  try {
    scheduler.schedule(target, true); await pause();
    for (let i = 0; i < 100; i++) scheduler.schedule({ ...target, sourcePath: "/synthetic/replacement.jsonl" }, true);
    assert.equal(signals.length, 1); assert.equal(signals[0]!.aborted, true);
    await pause(120); assert.equal(signals.length, 1, "metadata/cancellation does not free running caller capacity");
    resolutions[0]!(done); await scheduler.drain(); await pause(130);
    assert.equal(signals.length, 2);
    resolutions[1]!(done); await scheduler.drain();
    assert.equal(scheduler.status().state, "ready");
  } finally { scheduler.dispose(); for (const resolve of resolutions) resolve(done); await scheduler.drain(); }
});
test("catalog shadow follows bounded continuation but does not retry a safe error", async () => {
  let calls = 0;
  const scheduler = new CatalogShadowScheduler(async () => {
    calls++;
    if (calls === 1) return { ...done, complete: false };
    throw Object.assign(new Error("private path must not be exposed"), { code: "catalog-corrupt" });
  });
  try {
    scheduler.schedule(target, true); await pause(160); await scheduler.drain();
    assert.equal(calls, 2); assert.deepEqual(scheduler.status(), { state: "error", errorCode: "catalog-corrupt" });
    await pause(130); assert.equal(calls, 2);
  } finally { scheduler.dispose(); }
});
test("catalog incomplete tail waits for an append signal without a polling loop", async () => {
  let calls = 0;
  const scheduler = new CatalogShadowScheduler(async () => {
    calls++;
    return calls === 1 ? { ...done, complete: false, waitingForAppend: true } : done;
  });
  try {
    scheduler.schedule(target, true); await pause(180); await scheduler.drain();
    assert.equal(calls, 1); assert.equal(scheduler.status().state, "lagging");
    scheduler.schedule(target, true); await pause(); await scheduler.drain();
    assert.equal(calls, 2); assert.equal(scheduler.status().state, "ready");
    scheduler.disable(); assert.equal(scheduler.status().state, "disabled");
    scheduler.schedule(target, true); await pause(); await scheduler.drain();
    assert.equal(calls, 3, "disable is reversible, unlike disposal");
  } finally { scheduler.dispose(); }
});
test("catalog shadow disposal suppresses late result and continuation", async () => {
  let resolve!: (value: CatalogShadowProgress) => void;
  const scheduler = new CatalogShadowScheduler(async () => new Promise(settle => { resolve = settle; }));
  scheduler.schedule(target, true); await pause(); scheduler.dispose();
  resolve({ ...done, complete: false }); await scheduler.drain(); await pause(130);
  assert.deepEqual(scheduler.status(), { state: "disabled" });
});
