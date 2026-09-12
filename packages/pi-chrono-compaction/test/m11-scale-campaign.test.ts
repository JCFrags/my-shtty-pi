// @ts-nocheck
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Package-local executable support module intentionally has no declaration file.
import { FULL, SMOKE, distribution, maximum, parseArgs, sessionTargets } from "../../scripts/m11-scale-campaign.mjs";

const SHA = "a".repeat(40);

test("M11 campaign requires revision binding and explicit absolute isolated paths", () => {
  assert.deepEqual(parseArgs(["plan", "--profile", "full", "--candidate-sha", SHA]), {
    mode: "plan", profile: "full", candidateSha: SHA, campaignRoot: undefined, output: undefined,
  });
  assert.throws(() => parseArgs(["run", "--profile", "full", "--candidate-sha", SHA, "--campaign-root", "relative", "--output", "/tmp/out.json"]), /campaign-root/);
  assert.throws(() => parseArgs(["run", "--profile", "full", "--candidate-sha", SHA, "--campaign-root", "/tmp/campaign", "--output", "/tmp/campaign/out.json"]), /output-inside-campaign/);
});

test("full profile represents actual billion-token decoded input and hundreds-of-millions-token largest session", () => {
  const targets = sessionTargets(FULL);
  assert.equal(targets.length, 16);
  assert.equal(targets.reduce((sum, value) => sum + value, 0), 4_000_000_000);
  assert.equal(Math.ceil(Math.max(...targets) / 4), 200_000_000);
  assert.equal(Math.ceil(targets.reduce((sum, value) => sum + value, 0) / 4), 1_000_000_000);
  assert.ok(FULL.compositionGenerations >= 100);
  assert.equal(FULL.sessionCounts.flatMap(sessions => FULL.slots.map(slots => ({ sessions, slots }))).length, 9);
  assert.deepEqual(SMOKE.sessionCounts, [4]);
});

test("M11 percentiles use observed samples without extrapolation", () => {
  assert.deepEqual(distribution([9, 1, 5, 3]), { count: 4, p50: 5, p95: 9, p99: 9, maximum: 9 });
  assert.deepEqual(distribution([], false), { count: 0, p50: null, p95: null, maximum: null });
});

test("M11 report maxima accept campaign-sized metric arrays", () => {
  const samples = Array.from({ length: 164_170 }, (_, index) => index);
  assert.deepEqual(distribution(samples), { count: 164_170, p50: 82_085, p95: 155_961, p99: 162_528, maximum: 164_169 });
  const observations = samples.map(value => ({ processPeakRssBytes: value * 1024, cgroupMemoryPeakBytes: value * 2048 }));
  assert.equal(maximum(observations.map(item => item.processPeakRssBytes ?? 0), 0), 164_169 * 1024);
  assert.equal(maximum(observations.map(item => item.cgroupMemoryPeakBytes ?? 0), 0), 164_169 * 2048);
  assert.equal(maximum([], 0), 0);
});

test("M11 final report status controls the process exit after an aggregation failure", async t => {
  const root = await mkdtemp(join(tmpdir(), "chrono-m11-report-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleUrl = new URL("../../scripts/m11-scale-campaign.mjs", import.meta.url).href;
  for (const failAggregation of [true, false]) {
    const output = join(root, `${failAggregation ? "failed" : "completed"}.json`);
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { writeReport } from ${JSON.stringify(moduleUrl)};
      let report;
      try {
        report = { status: "completed", measurements: (() => {
          if (${failAggregation}) throw new RangeError("Maximum call stack size exceeded");
          return {};
        })() };
      } catch (error) {
        report = { status: "failed", failureMessage: error.message };
      }
      await writeReport(${JSON.stringify(output)}, report);
    `], { encoding: "utf8", timeout: 10_000 });
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, failAggregation ? 1 : 0);
    assert.equal(child.stderr, "");
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.status, failAggregation ? "failed" : "completed");
    assert.equal(JSON.parse(child.stdout).status, report.status);
    if (failAggregation) assert.equal(report.failureMessage, "Maximum call stack size exceeded");
  }
});
