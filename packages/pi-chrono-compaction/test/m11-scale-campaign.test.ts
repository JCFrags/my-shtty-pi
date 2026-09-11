// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Package-local executable support module intentionally has no declaration file.
import { FULL, SMOKE, distribution, parseArgs, sessionTargets } from "../../scripts/m11-scale-campaign.mjs";

const SHA = "a".repeat(40);

test("M11 campaign requires revision binding and explicit absolute isolated paths", () => {
  assert.deepEqual(parseArgs(["plan", "--profile", "full", "--candidate-sha", SHA]), {
    mode: "plan", profile: "full", candidateSha: SHA, campaignRoot: undefined, output: undefined,
  });
  assert.throws(() => parseArgs(["run", "--profile", "full", "--candidate-sha", SHA, "--campaign-root", "relative", "--output", "/tmp/out.json"]), /campaign-root/);
  assert.throws(() => parseArgs(["run", "--profile", "full", "--candidate-sha", SHA, "--campaign-root", "/tmp/campaign", "--output", "/tmp/campaign/out.json"]), /output-inside-campaign/);
});

test("full profile represents actual billion-token decoded input and hundred-million-token largest session", () => {
  const targets = sessionTargets(FULL);
  assert.equal(targets.length, 16);
  assert.equal(targets.reduce((sum, value) => sum + value, 0), 4_000_000_000);
  assert.equal(Math.ceil(Math.max(...targets) / 4), 100_000_000);
  assert.equal(Math.ceil(targets.reduce((sum, value) => sum + value, 0) / 4), 1_000_000_000);
  assert.ok(FULL.compositionGenerations >= 100);
  assert.deepEqual(SMOKE.sessionCounts, [4]);
});

test("M11 percentiles use observed samples without extrapolation", () => {
  assert.deepEqual(distribution([9, 1, 5, 3]), { count: 4, p50: 5, p95: 9, p99: 9, maximum: 9 });
  assert.deepEqual(distribution([], false), { count: 0, p50: null, p95: null, maximum: null });
});
