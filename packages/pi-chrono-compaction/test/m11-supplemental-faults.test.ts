// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Package-local executable support module intentionally has no declaration file.
import { LIMITS, parseArgs } from "../../scripts/m11-supplemental-faults.mjs";

const SHA = "a".repeat(40);

test("M11 supplemental harness binds one exact revision and isolated output paths", () => {
  assert.deepEqual(parseArgs(["run", "--candidate-sha", SHA, "--root", "/tmp/chrono-synthetic-root", "--output", "/tmp/chrono-synthetic-result.json"]), {
    mode: "run", candidateSha: SHA, root: "/tmp/chrono-synthetic-root", output: "/tmp/chrono-synthetic-result.json",
  });
  assert.throws(() => parseArgs(["run", "--candidate-sha", SHA, "--root", "relative", "--output", "/tmp/chrono-synthetic-result.json"]), /root/);
  assert.throws(() => parseArgs(["run", "--candidate-sha", SHA, "--root", "/tmp/chrono-synthetic-root", "--output", "/tmp/chrono-synthetic-root/result.json"]), /output-inside-root/);
});

test("M11 supplemental contract separates fault-worker caps from post-run acceptance checks", () => {
  assert.equal(LIMITS.requestedHostWideSlots, 1);
  assert.equal(LIMITS.repeatedDeaths, 3);
  assert.ok(LIMITS.faultWorkerMemoryBytes <= 256 * 1024 * 1024);
  assert.ok(LIMITS.faultWorkerHeapMiB <= 128);
  assert.ok(LIMITS.faultWorkerSourceBytes <= 8 * 1024 * 1024);
  assert.ok(LIMITS.postRunDiskAcceptanceBytes <= 128 * 1024 * 1024);
  assert.ok(LIMITS.postRunWallAcceptanceMs <= 2 * 60_000);
});
