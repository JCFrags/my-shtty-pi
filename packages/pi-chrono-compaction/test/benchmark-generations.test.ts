import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error The manual benchmark is an executable JavaScript module without declarations.
import { generationCounts, parseArguments, runConcurrent, runSeries, runSingle } from "../../scripts/benchmark-generations.mjs";

test("generation benchmark parses valid series and concurrent arguments", () => {
  assert.deepEqual(parseArguments(["series", "--final-tasks", "10", "--generations", "3"]), { mode: "series", "final-tasks": 10, generations: 3 });
  assert.deepEqual(parseArguments(["concurrent", "--tasks", "10", "--workers", "2"]), { mode: "concurrent", tasks: 10, workers: 2 });
});

test("generation benchmark rejects unsafe arguments", () => {
  for (const args of [
    ["unknown"],
    ["single", "--unknown", "1"],
    ["single", "--tasks"],
    ["single", "--tasks", "abc"],
    ["single", "--tasks", "0"],
    ["single", "--tasks", "5001"],
    ["series", "--final-tasks", "2", "--generations", "101"],
    ["concurrent", "--tasks", "2", "--workers", "9"],
    ["single", "--tasks", "2", "--workers", "1"],
  ]) assert.throws(() => parseArguments(args));
});

test("generation counts are monotonic, unique, and end at the exact final count", () => {
  assert.deepEqual(generationCounts(10, 3), [3, 6, 10]);
  assert.deepEqual(generationCounts(3, 5), [1, 2, 3]);
  for (const counts of [generationCounts(1000, 10), generationCounts(1000, 25), generationCounts(7, 100)]) {
    assert.equal(new Set(counts).size, counts.length);
    assert.ok(counts.every((value: number, index: number) => index === 0 || value > counts[index - 1]!));
  }
});

test("small aggregate outputs expose schema fields without source text", async () => {
  const single = await runSingle(1);
  const series = await runSeries(2, 2);
  assert.equal(single.mode, "single");
  assert.equal(series.mode, "series");
  assert.equal(series.generationsRun, 2);
  assert.equal(series.finalTasks, 2);
  assert.equal(series.sourceWorkAmplification, series.cumulativeSourceTokensProcessed / series.finalSourceTokens);
  for (const output of [single, series]) {
    assert.equal(output.schemaVersion, 1);
    assert.ok(Number.isFinite(output.maximumTimerDelayMs));
    assert.ok(output.maximumTimerDelayMs >= 0);
    const text = JSON.stringify(output);
    assert.doesNotMatch(text, /Never publish private evidence|immutable JSONL|migration guard|syn-root|source text/i);
  }
});

test("concurrent aggregate exposes required schema fields without child content", async () => {
  const output = await runConcurrent(2, 2, async () => ({
    sourceTokens: 100,
    compactionMs: 5,
    peakRssKiB: 10,
    maximumTimerDelayMs: 4,
    protectedFactRate: 1,
    falseCompletion: 0,
    validationErrors: 0,
  }));
  assert.deepEqual({ mode: output.mode, tasks: output.tasks, workers: output.workers }, { mode: "concurrent", tasks: 2, workers: 2 });
  assert.equal(output.totalSourceTokens, 200);
  assert.equal(output.sumWorkerPeakRssKiB, 20);
  assert.equal(output.maximumWorkerTimerDelayMs, 4);
  assert.doesNotMatch(JSON.stringify(output), /source text|syn-root/i);
});

test("one child failure rejects the concurrent result", async () => {
  let calls = 0;
  await assert.rejects(() => runConcurrent(1, 2, async () => {
    calls += 1;
    if (calls === 2) throw new Error("synthetic child failure");
    return { sourceTokens: 1, compactionMs: 1, peakRssKiB: 1, maximumTimerDelayMs: 0, protectedFactRate: 1, falseCompletion: 0, validationErrors: 0 };
  }), /synthetic child failure/);
});
