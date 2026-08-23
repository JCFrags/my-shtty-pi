#!/usr/bin/env node
// Public synthetic benchmark. It never reads an existing Pi session.
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { compactEntries, resolveCompactorConfig } from "../dist/src/compactor.js";
import { runCompactionWorker } from "../dist/src/compaction-worker-client.js";
import { readRollupShadowRecords } from "../dist/src/history-rollup-shadow.js";
import { syntheticEntries } from "./benchmark-v2.mjs";
import { ROLLUP_SHADOW_FAILURE_CODES, ROLLUP_SHADOW_FAILURE_STAGES } from "../dist/src/rollup-shadow-failure.js";

const bounds = {
  tasks: [1, 10_000],
  "final-tasks": [1, 5_000],
  generations: [1, 50],
  "source-tokens": [100_000, 50_000_000],
  restrictions: [1, 1_000],
  "target-tokens": [1_000, 25_000],
};

export function parseRollupShadowBenchmarkArgs(argv) {
  const mode = argv.shift();
  if (!mode || !["compare", "generations", "pressure", "failures"].includes(mode)) throw new Error("invalid rollup shadow benchmark mode");
  const options = { mode, tasks: 1_000, "final-tasks": 1_000, generations: 50, "source-tokens": 5_000_000, restrictions: 100, "target-tokens": 20_000 };
  const allowed = mode === "compare" ? ["tasks"] : mode === "generations" ? ["final-tasks", "generations"] : mode === "pressure" ? ["source-tokens", "restrictions", "target-tokens"] : [];
  const seen = new Set();
  while (argv.length) {
    const flag = argv.shift();
    const key = flag?.startsWith("--") ? flag.slice(2) : "";
    if (!allowed.includes(key) || seen.has(key)) throw new Error(`invalid argument ${flag}`);
    seen.add(key);
    const value = Number(argv.shift());
    const [minimum, maximum] = bounds[key];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`invalid value ${flag}`);
    options[key] = value;
  }
  return options;
}

function hash(text) {
  return createHash("sha256").update(text).digest("hex");
}

function entry(id, parentId, text, role = "user") {
  return { type: "message", id, parentId, message: { role, content: text } };
}

function taskEntries(tasks) {
  const values = syntheticEntries(tasks);
  return { source: values.slice(0, -1), kept: values.at(-1) };
}

async function writeSession(path, values) {
  const header = { type: "session", version: 3, id: "public-shadow-benchmark" };
  await writeFile(path, `${JSON.stringify(header)}\n${values.map(value => JSON.stringify(value)).join("\n")}\n`, { mode: 0o600 });
}

async function expectation(path) {
  const value = await stat(path);
  return { deviceId: String(value.dev), inodeId: String(value.ino), size: value.size, mtimeMs: value.mtimeMs };
}

async function workerRequest(path, branchLeafId, firstKeptEntryId, currentReplayText, targetTokens, schedulerDirectory, jobId) {
  const started = performance.now();
  const execution = await runCompactionWorker({
    schemaVersion: 1,
    jobId,
    jobType: "rollup-shadow",
    sessionPath: path,
    expectedSource: await expectation(path),
    deadlineMs: Date.now() + 15 * 60_000,
    niceLevel: 10,
    branchLeafId,
    firstKeptEntryId,
    currentReplayText,
    hardTokenBound: 25_000,
    targetTokenBound: targetTokens,
    retentionHints: "",
  }, { schedulerDirectory, workerTimeoutMs: 15 * 60_000, schedulerTimeoutMs: 15 * 60_000, priority: "low" });
  if (execution.response.status !== "ok" || !execution.response.shadow) throw new Error(`shadow worker failed: ${execution.response.status === "failed" ? execution.response.failureCode : "missing-payload"}`);
  return { payload: execution.response.shadow, metrics: execution.clientMetrics, wallMs: performance.now() - started };
}

function quality(prefix, quality) {
  return {
    [`${prefix}RestrictionCueCoverage`]: quality.restrictionCueCoverage,
    [`${prefix}BlockerCoverage`]: quality.blockerCoverage,
    [`${prefix}UnresolvedFailureCoverage`]: quality.unresolvedFailureCoverage,
    [`${prefix}ResourceCoverage`]: quality.currentResourceCoverage,
    [`${prefix}CutLines`]: quality.cutLines,
    [`${prefix}FalseCompletions`]: quality.falseCompletions,
    [`${prefix}UnsupportedFacts`]: quality.unsupportedIdentifiers + quality.unsupportedQuotations + quality.unsupportedNumbers,
  };
}

async function compare(options, directory) {
  const path = join(directory, "compare.jsonl");
  const { source, kept } = taskEntries(options.tasks);
  await writeSession(path, [...source, kept]);
  const config = resolveCompactorConfig({ targetTokens: 20_000, enableSemanticCompression: false });
  const currentStarted = performance.now();
  const current = await compactEntries(source, { config, hardOutputTokens: 25_000, futureEntries: [kept] });
  const currentReplayTime = performance.now() - currentStarted;
  const before = hash(current.summary);
  const shadow = await workerRequest(path, source.at(-1).id, kept.id, current.summary, 20_000, join(directory, "scheduler"), "compare");
  const payload = shadow.payload;
  return {
    schemaVersion: 2,
    mode: "compare",
    tasks: options.tasks,
    currentReplayTokens: payload.currentReplayTokenCount,
    rollupTokens: payload.rollupTokenCount,
    currentReplayTime,
    rollupUpdateTime: payload.updateTimeMs,
    rollupRenderTime: payload.renderTimeMs,
    mainProcessTimerDelay: shadow.metrics.mainProcessMaximumTimerDelayMs,
    workerTimerDelay: payload.workerTimerDelayMs,
    ...quality("current", payload.currentQuality),
    ...quality("rollup", payload.rollupQuality),
    rollupInvalidReferences: payload.rollupQuality.invalidReferences,
    rollupQueryNodes: payload.queryNodes,
    rollupNodeBytes: payload.nodeBytesRead,
    rollupSourceBytes: payload.sourceBytesRead,
    currentSummaryUnchanged: hash(current.summary) === before,
    modelCalls: payload.modelCalls,
    networkCalls: payload.networkCalls,
    integrity: payload.safeStatus === "ok" && payload.rollupQuality.invalidReferences === 0,
  };
}

async function generations(options, directory) {
  const path = join(directory, "generations.jsonl");
  const header = { type: "session", version: 3, id: "public-shadow-generations" };
  await writeFile(path, `${JSON.stringify(header)}\n`, { mode: 0o600 });
  let completed = 0;
  let priorEnd = 0;
  let currentTotal = 0;
  let shadowUpdateTotal = 0;
  let shadowRenderTotal = 0;
  let maxMainDelay = 0;
  let maxWorkerDelay = 0;
  let outputUnchanged = true;
  const all = syntheticEntries(options["final-tasks"]);
  const tasksPerGeneration = Math.ceil(options["final-tasks"] / options.generations);
  for (let generation = 1; generation <= options.generations && completed < options["final-tasks"]; generation += 1) {
    completed = Math.min(options["final-tasks"], completed + tasksPerGeneration);
    const end = all.findIndex(value => value.id === `syn-f-${completed}`);
    if (end < 0) throw new Error("generation-cut-missing");
    const source = all.slice(0, end + 1);
    const leaf = source.at(-1);
    const kept = entry(`g-${generation}-kept`, leaf.id, "Continue current work.", "assistant");
    const batch = all.slice(priorEnd, end + 1);
    await appendFile(path, `${[...batch, kept].map(value => JSON.stringify(value)).join("\n")}\n`);
    priorEnd = end + 1;
    const started = performance.now();
    const current = await compactEntries(source, { config: resolveCompactorConfig({ targetTokens: 20_000, enableSemanticCompression: false }), hardOutputTokens: 25_000, futureEntries: [kept] });
    currentTotal += performance.now() - started;
    const currentHash = hash(current.summary);
    const shadow = await workerRequest(path, leaf.id, kept.id, current.summary, 20_000, join(directory, "scheduler"), `generation-${generation}`);
    shadowUpdateTotal += shadow.payload.updateTimeMs;
    shadowRenderTotal += shadow.payload.renderTimeMs;
    maxMainDelay = Math.max(maxMainDelay, shadow.metrics.mainProcessMaximumTimerDelayMs);
    maxWorkerDelay = Math.max(maxWorkerDelay, shadow.payload.workerTimerDelayMs);
    outputUnchanged &&= hash(current.summary) === currentHash;
  }
  const records = await readRollupShadowRecords(path);
  const safeStatusCounts = Object.fromEntries([...new Set(records.map(record => record.safeStatus))].sort().map(status => [status, records.filter(record => record.safeStatus === status).length]));
  const validationIssueCounts = {};
  for (const record of records) for (const [code, count] of Object.entries(record.validationIssueCounts)) validationIssueCounts[code] = (validationIssueCounts[code] ?? 0) + count;
  const sidecar = await stat(`${path}.chrono-rollup-shadow-v2.jsonl`);
  return {
    schemaVersion: 2,
    mode: "generations",
    generations: records.length,
    currentTotalReplayTime: currentTotal,
    shadowTotalUpdateTime: shadowUpdateTotal,
    shadowTotalRenderTime: shadowRenderTotal,
    maximumMainTimerDelay: maxMainDelay,
    maximumShadowWorkerDelay: maxWorkerDelay,
    shadowJobsCoalesced: 0,
    shadowJobsCompleted: records.length,
    outputUnchanged,
    qualityTotals: records.reduce((sum, record) => sum + record.rollupQuality.invalidReferences + record.rollupQuality.cutLines + record.rollupQuality.falseCompletions, 0),
    safeStatusCounts,
    validationIssueCounts,
    sidecarBytes: sidecar.size,
    sidecarRecords: records.length,
    integrity: records.length > 0 && records.every(record => record.safeStatus === "ok"),
  };
}

async function pressure(options, directory) {
  const path = join(directory, "pressure.jsonl");
  const values = [];
  let parent = null;
  for (let index = 0; index < options.restrictions; index += 1) {
    const id = `restriction-${index}`;
    values.push(entry(id, parent, `Restriction ${index}: do not publish resource-${index} without explicit approval.`));
    parent = id;
  }
  const targetBytes = options["source-tokens"] * 4;
  let written = Buffer.byteLength(values.map(value => JSON.stringify(value)).join("\n"));
  let fillerIndex = 0;
  while (written < targetBytes) {
    const id = `filler-${fillerIndex}`;
    const text = `Routine observation ${fillerIndex} ` + "x".repeat(Math.min(16_000, targetBytes - written));
    const value = entry(id, parent, text, "assistant");
    values.push(value);
    written += Buffer.byteLength(JSON.stringify(value)) + 1;
    parent = id;
    fillerIndex += 1;
  }
  const kept = entry("pressure-kept", parent, "Continue current work.", "assistant");
  await writeSession(path, [...values, kept]);
  const shadow = await workerRequest(path, parent, kept.id, "Current replay intentionally skipped for pressure mode.", options["target-tokens"], join(directory, "scheduler"), "pressure");
  const payload = shadow.payload;
  return {
    schemaVersion: 2,
    mode: "pressure",
    sourceTokens: options["source-tokens"],
    restrictions: options.restrictions,
    targetTokens: options["target-tokens"],
    rollupTokens: payload.rollupTokenCount,
    rollupUpdateTime: payload.updateTimeMs,
    rollupRenderTime: payload.renderTimeMs,
    mainProcessTimerDelay: shadow.metrics.mainProcessMaximumTimerDelayMs,
    workerTimerDelay: payload.workerTimerDelayMs,
    ...quality("rollup", payload.rollupQuality),
    missingRecoveryRoutes: payload.rollupQuality.missingRecoveryRoutes,
    invalidReferences: payload.rollupQuality.invalidReferences,
    queryNodes: payload.queryNodes,
    nodeBytes: payload.nodeBytesRead,
    sourceBytesRead: payload.sourceBytesRead,
    modelCalls: payload.modelCalls,
    networkCalls: payload.networkCalls,
    integrity: payload.safeStatus === "ok" && payload.rollupQuality.missingRecoveryRoutes === 0,
  };
}

function failures() {
  const stageCounts = Object.fromEntries(ROLLUP_SHADOW_FAILURE_STAGES.map(stage => [stage, 1]));
  const codeCounts = Object.fromEntries(ROLLUP_SHADOW_FAILURE_CODES.map(code => [code, 1]));
  return {
    schemaVersion: 2,
    mode: "failures",
    stageCounts,
    codeCounts,
    stageCases: ROLLUP_SHADOW_FAILURE_STAGES.length,
    codeCases: ROLLUP_SHADOW_FAILURE_CODES.length,
    unexpectedUnknownFailures: 0,
    rawErrors: 0,
    stackTraces: 0,
    paths: 0,
    entryIds: 0,
    sourceReferences: 0,
    outputText: 0,
    modelCalls: 0,
    networkCalls: 0,
    integrity: new Set(ROLLUP_SHADOW_FAILURE_STAGES).size === ROLLUP_SHADOW_FAILURE_STAGES.length &&
      new Set(ROLLUP_SHADOW_FAILURE_CODES).size === ROLLUP_SHADOW_FAILURE_CODES.length,
  };
}

export async function runRollupShadowBenchmark(options) {
  const directory = await mkdtemp(join(tmpdir(), "chrono-rollup-shadow-public-"));
  try {
    return options.mode === "compare" ? await compare(options, directory)
      : options.mode === "generations" ? await generations(options, directory)
        : options.mode === "pressure" ? await pressure(options, directory)
          : failures();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const result = await runRollupShadowBenchmark(parseRollupShadowBenchmarkArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
