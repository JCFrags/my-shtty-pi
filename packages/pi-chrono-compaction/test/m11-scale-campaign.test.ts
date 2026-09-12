// @ts-nocheck
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Package-local executable support module intentionally has no declaration file.
import { FULL, SMOKE, distribution, maximum, parseArgs, runtimeModules, sessionTargets } from "../../scripts/m11-scale-campaign.mjs";
import { FROZEN, RECOVERY_LIMITS, matrixSuffix, parseRecoveryArgs, reserveOutput, validateCheckpoint, validateGo } from "../../scripts/m11-retained-tail-recovery.mjs";

const SHA = "a".repeat(40);
const hash = value => createHash("sha256").update(value).digest("hex");

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

test("M11 retained-tail CLI refuses execution without exact go and loads only the explicit runtime root", async t => {
  const root = await mkdtemp(join(tmpdir(), "chrono-m11-recovery-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = new URL("../../scripts/m11-retained-tail-recovery.mjs", import.meta.url);
  for (const args of [["plan"], ["recover"], ["recover", "--go", join(root, "missing.json"), "--go-sha256", "0".repeat(64)]]) {
    const child = spawnSync(process.execPath, [script.pathname, ...args], { encoding: "utf8", timeout: 10_000 });
    assert.equal(child.error, undefined); assert.equal(child.signal, null);
    assert.equal(child.status, args[0] === "plan" ? 0 : 1);
    if (args[0] === "plan") {
      const plan = JSON.parse(child.stdout);
      assert.equal(plan.executionEnabled, false); assert.equal(plan.frozen.runtimeSha, FROZEN.runtimeSha);
      assert.equal(plan.limits.validationWorkerCalls, 80); assert.equal(plan.limits.matrixWorkerCalls, 504);
    } else { assert.match(child.stderr, /^m11-recovery-(exact-go-required|refused)\n$/); assert.equal(child.stdout, ""); }
  }
  assert.throws(() => parseRecoveryArgs(["recover", "--go", "relative", "--go-sha256", "0".repeat(64)]), /exact-go-required/);
  const names = ["catalog-worker-client", "capsule-worker-client", "search-v3-worker-client", "capsule-contract", "context-composer", "host-worker-scheduler", "episode-state-contract"];
  await mkdir(join(root, "dist", "src"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  for (const name of names) await writeFile(join(root, "dist", "src", `${name}.js`), `export const origin = ${JSON.stringify(name)};\n`);
  const loaded = await runtimeModules(root);
  assert.deepEqual(Object.values(loaded).map(module => module.origin), names);
});

test("M11 retained-tail synthetic checkpoint binds identities, complete cuts, bounded suffixes and exclusive output", async t => {
  const root = await mkdtemp(join(tmpdir(), "chrono-m11-recovery-checkpoint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Metadata only. These small placeholders do not claim that full-scale bodies were generated.
  const sessions = sessionTargets(FULL).map((decodedUnits, index) => {
    const shards = Array.from({ length: index === 0 ? 12 : 4 }, (_, ordinal) => ({ ordinal, sourceBytes: 100 }));
    return { session: index + 1, decodedUnits, events: index === 0 ? 764 : 205, compactions: 8, shards, sourceBytes: shards.length * 100, leafId: `leaf-${index}` };
  });
  const manifest = { schemaVersion: 1, candidateSha: FROZEN.sourcePreparationSha, profile: "full", generated: {
    sessions, totals: { shards: 72, events: 3839, compactions: 128, decodedUnits: FULL.totalDecodedUnits, sourceBytes: 7200 },
  } };
  const checkpoint = { schemaVersion: 1, candidateSha: FROZEN.runtimeSha, preparedCandidateSha: FROZEN.sourcePreparationSha, reusedPreparedStores: true,
    states: sessions.map(session => {
      const view = { generation: 1, eventCut: session.events + session.compactions, branchKey: "main" };
      return { session, sessionKey: hash(`m11-session-${session.session}`), view, verifiedShards: session.shards.length,
        selection: { sourceView: view, requestedCut: view.eventCut, processedCut: view.eventCut, processedMemoryCut: view.eventCut,
          stateGeneration: 10, coverage: { bodyComplete: true, metadataComplete: true } } };
    }),
  };
  const failure = { kind: "chrono-m11-scale-campaign", status: "failed", candidateSha: FROZEN.runtimeSha, preparedCandidateSha: FROZEN.sourcePreparationSha,
    failureCode: "m11-campaign-failed", failureMessage: "Maximum call stack size exceeded", retainedCampaignRoot: true };
  const checkpointBytes = JSON.stringify(checkpoint);
  assert.equal(validateCheckpoint(manifest, checkpoint, failure).length, 16);
  const incomplete = structuredClone(checkpoint); incomplete.states[0].selection.coverage.metadataComplete = false;
  assert.throws(() => validateCheckpoint(manifest, incomplete, failure), /selection-incomplete/);
  assert.throws(() => validateCheckpoint(manifest, { ...checkpoint, candidateSha: SHA }, failure), /checkpoint-identity/);
  assert.throws(() => validateCheckpoint(manifest, checkpoint, { ...failure, failureMessage: "timeout" }), /natural-report-failure-required/);
  assert.equal(JSON.stringify(checkpoint), checkpointBytes);
  for (const rounds of [1, 2]) {
    const suffixes = sessions.map(session => matrixSuffix(session, rounds));
    assert.equal(suffixes.reduce((sum, suffix) => sum + suffix.events, 0), rounds * RECOVERY_LIMITS.appendedEvents);
    assert.ok(suffixes.every(suffix => suffix.bytes.length <= RECOVERY_LIMITS.suffixBytesPerSession));
  }
  assert.throws(() => matrixSuffix(sessions[0], 3), /suffix-rounds/);
  const go = { schemaVersion: 1, kind: "chrono-m11-retained-tail-exact-go", approveRetainedTail: true, naturalSettlement: true,
    sourcePreparationSha: FROZEN.sourcePreparationSha, statePreparationSha: FROZEN.runtimeSha, executionRuntimeSha: FROZEN.runtimeSha,
    currentMainSha: SHA, harnessSha: SHA, campaignRoot: join(root, FROZEN.sourcePreparationSha), runtimePackage: join(root, "frozen"),
    failedReport: join(root, "old.json"), output: join(root, "new.json"), recoveryUnit: `chrono-m11-retained-tail-${SHA.slice(0, 12)}.service`,
    parent: { unit: `chrono-m11-resume-${FROZEN.runtimeSha.slice(0, 12)}.service`, bootId: "0".repeat(36), processes: [{ pid: 2, startTicks: "1" }, { pid: 3, startTicks: "2" }] },
    hashes: Object.fromEntries(["manifest", "checkpoint", "failedReport", "harness", "sharedHarness", "dependencies", "node"].map(key => [key, "0".repeat(64)])),
    sources: sessions.flatMap(session => session.shards.map(shard => ({ session: session.session, ordinal: shard.ordinal, device: "1", inode: "2", prefixSha256: "0".repeat(64) }))),
  };
  assert.equal(validateGo(go), go);
  assert.throws(() => validateGo({ ...go, approveRetainedTail: false }), /exact-go-required/);
  assert.throws(() => validateGo({ ...go, executionRuntimeSha: SHA }), /revision-binding/);
  const output = await reserveOutput(go.output); await output.writeFile("reserved\n"); await output.close();
  await assert.rejects(() => reserveOutput(go.output), { code: "EEXIST" });
  const link = join(root, "link.json"); await symlink(go.output, link);
  await assert.rejects(() => reserveOutput(link));
  assert.equal(await readFile(go.output, "utf8"), "reserved\n");
});
