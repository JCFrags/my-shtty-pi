// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRollupShadowBenchmarkArgs,
  runRollupShadowBenchmark,
} from "../../scripts/benchmark-rollup-shadow.mjs";

test("rollup shadow benchmark validates bounded public arguments", () => {
  assert.equal(parseRollupShadowBenchmarkArgs(["compare", "--tasks", "10000"]).tasks, 10000);
  assert.equal(parseRollupShadowBenchmarkArgs(["generations", "--final-tasks", "5000", "--generations", "20"]).generations, 20);
  assert.equal(parseRollupShadowBenchmarkArgs(["pressure", "--source-tokens", "50000000", "--restrictions", "1000"])["source-tokens"], 50000000);
  assert.equal(parseRollupShadowBenchmarkArgs(["failures"]).mode, "failures");
  for (const input of [
    ["unknown"],
    ["compare", "--tasks", "0"],
    ["generations", "--generations", "51"],
    ["pressure", "--source-tokens", "50000001"],
    ["pressure", "--private-path", "/tmp/private"],
  ]) assert.throws(() => parseRollupShadowBenchmarkArgs(input));
});

test("small shadow compare, generations, and pressure modes preserve isolation and integrity", async () => {
  const compare = await runRollupShadowBenchmark(parseRollupShadowBenchmarkArgs(["compare", "--tasks", "10"]));
  assert.equal(compare.integrity, true);
  assert.equal(compare.authoritativeResponseUnchanged, true);
  assert.equal(compare.maliciousShadowAttempted, true);
  assert.equal(compare.modelCalls, 0);
  assert.equal(compare.networkCalls, 0);
  const generations = await runRollupShadowBenchmark(parseRollupShadowBenchmarkArgs(["generations", "--final-tasks", "10", "--generations", "2"]));
  assert.equal(generations.integrity, true);
  assert.equal(generations.outputUnchanged, true);
  assert.equal(generations.sidecarRecords, 2);
  const pressure = await runRollupShadowBenchmark(parseRollupShadowBenchmarkArgs(["pressure", "--source-tokens", "100000", "--restrictions", "10", "--target-tokens", "5000"]));
  assert.equal(pressure.integrity, true);
  assert.equal(pressure.invalidReferences, 0);
  assert.equal(pressure.missingRecoveryRoutes, 0);
  assert.equal(pressure.modelCalls, 0);
  assert.equal(pressure.networkCalls, 0);
  const failures = await runRollupShadowBenchmark(parseRollupShadowBenchmarkArgs(["failures"]));
  assert.equal(failures.integrity, true);
  assert.equal(failures.unexpectedUnknownFailures, 0);
  assert.equal(failures.rawErrors, 0);
  assert.equal(failures.modelCalls, 0);
  assert.equal(failures.networkCalls, 0);
});
