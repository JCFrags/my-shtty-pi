// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseHistoryRollupBenchmarkArgs,
  runHistoryRollupBenchmark,
} from "../../scripts/benchmark-history-rollups.mjs";

test("history rollup benchmark rejects unsafe arguments", () => {
  assert.equal(parseHistoryRollupBenchmarkArgs([
    "scale", "--source-tokens", "50000000", "--batches", "50", "--target-tokens", "20000",
  ])["source-tokens"], 50000000);
  assert.equal(parseHistoryRollupBenchmarkArgs([
    "query", "--source-tokens", "5000000", "--hint-target", "old-critical-evidence",
  ])["hint-target"], "old-critical-evidence");
  for (const value of [
    ["unknown"],
    ["series", "--final-tasks", "0"],
    ["render", "--tasks", "10001"],
    ["scale", "--source-tokens", "99999"],
    ["branch", "--left-tasks", "x"],
    ["compare", "--batches", "2"],
    ["metadata", "--entries", "1000001"],
    ["query", "--hint-target", "private path"],
    ["restrictions", "--restrictions", "1001"],
  ]) assert.throws(() => parseHistoryRollupBenchmarkArgs(value));
});

test("small series, render, branch, and compare modes preserve integrity", async () => {
  const series = await runHistoryRollupBenchmark(parseHistoryRollupBenchmarkArgs([
    "series", "--final-tasks", "10", "--batches", "2",
  ]));
  assert.equal(series.integrityOk, true);
  const render = await runHistoryRollupBenchmark(parseHistoryRollupBenchmarkArgs([
    "render", "--tasks", "10", "--target-tokens", "2000",
  ]));
  assert.equal(render.integrityOk, true);
  assert.equal(render.invalidSourceRefs, 0);
  const branch = await runHistoryRollupBenchmark(parseHistoryRollupBenchmarkArgs([
    "branch", "--common-tasks", "1000", "--left-tasks", "1000", "--right-tasks", "1000",
  ]));
  assert.equal(branch.outputIntegrity, true);
  assert.equal(branch.abandonedBranchRecordsInActiveRender, 0);
  const compare = await runHistoryRollupBenchmark(parseHistoryRollupBenchmarkArgs([
    "compare", "--tasks", "10",
  ]));
  assert.equal(compare.rollupRecoveryReferenceValidity, true);
});

test("metadata, query, and restriction modes report bounded final integrity", async () => {
  const metadata = await runHistoryRollupBenchmark(parseHistoryRollupBenchmarkArgs([
    "metadata", "--entries", "100000", "--append-entries", "1000",
  ]));
  assert.equal(metadata.integrity, true);
  assert.equal(metadata.oldLeafDigestsChecked, 0);
  assert.equal(metadata.nodeDirectoryEntriesScanned, 0);
  const query = await runHistoryRollupBenchmark(parseHistoryRollupBenchmarkArgs([
    "query", "--source-tokens", "100000", "--hint-target", "old-critical-evidence",
  ]));
  assert.equal(query.integrity, true);
  assert.equal(query.targetFound, true);
  assert.ok(query.queryNodesVisited <= 64);
  const restrictions = await runHistoryRollupBenchmark(parseHistoryRollupBenchmarkArgs([
    "restrictions", "--restrictions", "10", "--source-tokens", "100000", "--target-tokens", "2000",
  ]));
  assert.equal(restrictions.integrity, true);
  assert.equal(restrictions.restrictionsWithoutRoute, 0);
  assert.equal(restrictions.finalCueCoverage, 1);
});
