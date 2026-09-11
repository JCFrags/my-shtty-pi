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

test("M11 supplemental limits use one host-wide slot and bounded disposable resources", () => {
  assert.equal(LIMITS.slots, 1);
  assert.equal(LIMITS.repeatedDeaths, 3);
  assert.ok(LIMITS.memoryBytes <= 256 * 1024 * 1024);
  assert.ok(LIMITS.heapMiB <= 128);
  assert.ok(LIMITS.sourceBytes <= 8 * 1024 * 1024);
  assert.ok(LIMITS.diskBytes <= 128 * 1024 * 1024);
  assert.ok(LIMITS.wallMs <= 2 * 60_000);
});
