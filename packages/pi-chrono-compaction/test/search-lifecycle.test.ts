import test from "node:test";
import assert from "node:assert/strict";
import { SearchLifecycleScheduler, type SearchLifecycleTarget } from "../src/search-lifecycle.js";
const target: SearchLifecycleTarget = { sourcePath: "/synthetic/session.jsonl", catalogDirectory: "/synthetic/catalog", sessionKey: "a".repeat(64), shardKey: "b".repeat(64), leafId: "leaf-a" };
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check: () => boolean): Promise<void> { for (let i = 0; i < 100 && !check(); i++) await tick(); assert.ok(check()); }

test("lifecycle catch-up separates readiness and settles branch replacement, disable and shutdown", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  let held = false;
  const seen: string[] = [];
  const scheduler = new SearchLifecycleScheduler(async (t, signal) => {
    calls++; seen.push(t.leafId);
    if (held) { await new Promise<void>(resolve => { release = resolve; }); assert.equal(signal.aborted, true); }
    if (calls === 1) return { catalog: "ready", capsules: "lagging", index: "pending" };
    return { catalog: "ready", capsules: "ready", index: "ready" };
  }, 1);
  assert.equal(scheduler.status().state, "disabled");
  scheduler.schedule(target);
  await until(() => scheduler.status().state === "ready");
  assert.equal(calls, 2);
  held = true;
  scheduler.schedule(target);
  await until(() => !!release);
  scheduler.schedule({ ...target, leafId: "leaf-b" });
  assert.equal(calls, 3, "replacement waits for settlement");
  assert.equal(scheduler.status().index, "pending");
  held = false; release!();
  await until(() => scheduler.status().state === "ready");
  assert.equal(seen.at(-1), "leaf-b");
  scheduler.disable();
  assert.equal(scheduler.status().state, "disabled");
  const before = calls; await tick(); assert.equal(calls, before);
  scheduler.dispose(); scheduler.schedule(target); await scheduler.drain();
  assert.equal(scheduler.status().state, "disabled");
  assert.equal(calls, before);
});
