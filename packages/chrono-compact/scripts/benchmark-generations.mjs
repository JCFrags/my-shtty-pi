#!/usr/bin/env node
// @ts-nocheck
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { syntheticEntries } from "./benchmark-v2.mjs";

const execFileAsync = promisify(execFile);
const SCHEMA_VERSION = 1;
const FACTS = [
  "Never publish private evidence.",
  "Keep immutable JSONL.",
  "The migration remains unresolved until approval.",
  "ERROR migration guard expected=pending received=complete",
];
const LIMITS = { tasks: 5_000, "final-tasks": 5_000, generations: 100, workers: 8 };
const HELP = "Usage: benchmark-generations.mjs series --final-tasks N --generations N | concurrent --tasks N --workers N | single --tasks N";
let runtime;
async function chrono() { return runtime ??= await import("../dist/src/index.js"); }

function integer(name, value) {
  if (value === undefined) throw new Error(`Missing value for --${name}.`);
  if (!/^\d+$/.test(value)) throw new Error(`--${name} must be an integer.`);
  const parsed = Number(value);
  if (parsed < 1 || parsed > LIMITS[name]) throw new Error(`--${name} must be from 1 through ${LIMITS[name]}.`);
  return parsed;
}

export function parseArguments(argv) {
  const mode = argv[0];
  if (mode === "--help" || mode === "help") return { mode: "help" };
  if (!['series', 'concurrent', 'single'].includes(mode)) throw new Error(`Unknown mode: ${mode ?? "<missing>"}.`);
  const allowed = mode === "series" ? new Set(["final-tasks", "generations"]) : mode === "concurrent" ? new Set(["tasks", "workers"]) : new Set(["tasks"]);
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) throw new Error(`Unknown argument: ${argument ?? "<missing>"}.`);
    const name = argument.slice(2);
    if (!allowed.has(name)) throw new Error(`Unknown argument: ${argument}.`);
    if (Object.hasOwn(values, name)) throw new Error(`Duplicate argument: ${argument}.`);
    values[name] = integer(name, argv[index + 1]);
    if (argv[index + 1] === undefined) throw new Error(`Missing value for ${argument}.`);
  }
  for (const name of allowed) if (!Object.hasOwn(values, name)) throw new Error(`Missing value for --${name}.`);
  return { mode, ...values };
}

export function generationCounts(finalTasks, generationsRequested) {
  const run = Math.min(finalTasks, generationsRequested);
  return Array.from({ length: run }, (_, index) => Math.floor(((index + 1) * finalTasks) / run));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function factRate(summary) { return FACTS.filter((fact) => summary.includes(fact)).length / FACTS.length; }
function errorCount(result) { return result.validation.issues.filter((issue) => issue.severity === "error").length; }
function warningCount(result) { return result.validation.issues.filter((issue) => issue.severity === "warning").length; }

async function timedCompaction(entries) {
  const api = await chrono();
  const scheduled = performance.now();
  let timerRan;
  const timer = new Promise((resolve) => setTimeout(() => { timerRan = performance.now(); resolve(); }, 0));
  const started = performance.now();
  const result = await api.compactEntries(entries, { config: { targetTokens: 12_000 } });
  const compactionMs = performance.now() - started;
  await timer;
  return { result, compactionMs, timerDelayMs: Math.max(0, timerRan - scheduled) };
}

async function exactRecovery(entries) {
  const api = await chrono();
  const session = api.parseBranchEntries(entries);
  const blocks = api.parseHistoricalBlocks(entries);
  const sample = blocks.slice(0, 10);
  let recovered = 0;
  for (const block of sample) {
    try { api.historyGet(session, block.entryId, block.blockIndex === undefined ? {} : { blockIndex: block.blockIndex, maxChars: 20_000 }); recovered += 1; } catch {}
  }
  return recovered / Math.max(1, sample.length);
}

export async function runSingle(tasks) {
  const entries = syntheticEntries(tasks);
  const wallStarted = performance.now();
  const timed = await timedCompaction(entries);
  const wallMs = performance.now() - wallStarted;
  return {
    schemaVersion: SCHEMA_VERSION, mode: "single", tasks,
    sourceTokens: timed.result.rawTokens, renderedTokens: timed.result.renderedTokens,
    compactionMs: timed.compactionMs, wallMs, peakRssKiB: process.resourceUsage().maxRSS,
    maximumTimerDelayMs: timed.timerDelayMs, protectedFactRate: factRate(timed.result.summary),
    falseCompletion: timed.result.summary.includes("Migration is complete.") ? 1 : 0,
    validationErrors: errorCount(timed.result), validationWarnings: warningCount(timed.result),
  };
}

export async function runSeries(finalTasks, generationsRequested) {
  const counts = generationCounts(finalTasks, generationsRequested);
  const times = []; let cumulative = 0; let peak = 0; let delay = 0; let final;
  for (const count of counts) {
    const entries = syntheticEntries(count);
    const timed = await timedCompaction(entries);
    times.push(timed.compactionMs); cumulative += timed.result.rawTokens;
    peak = Math.max(peak, process.resourceUsage().maxRSS); delay = Math.max(delay, timed.timerDelayMs);
    final = { entries, ...timed };
  }
  return {
    schemaVersion: SCHEMA_VERSION, mode: "series", finalTasks, generationsRequested, generationsRun: counts.length,
    finalSourceTokens: final.result.rawTokens, cumulativeSourceTokensProcessed: cumulative,
    sourceWorkAmplification: cumulative / final.result.rawTokens,
    totalCompactionMs: times.reduce((sum, value) => sum + value, 0), medianCompactionMs: median(times),
    finalCompactionMs: times.at(-1), peakRssKiB: peak, finalRssKiB: process.memoryUsage().rss / 1024,
    maximumTimerDelayMs: delay, protectedFactRate: factRate(final.result.summary),
    falseCompletion: final.result.summary.includes("Migration is complete.") ? 1 : 0,
    exactRecoveryRate: await exactRecovery(final.entries), validationErrors: errorCount(final.result), validationWarnings: warningCount(final.result),
  };
}

async function defaultChildRunner(tasks) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [fileURLToPath(import.meta.url), "single", "--tasks", String(tasks)], { maxBuffer: 1024 * 1024 });
  if (stderr.trim()) throw new Error(stderr.trim());
  return JSON.parse(stdout);
}

export async function runConcurrent(tasks, workers, childRunner = defaultChildRunner) {
  const started = performance.now();
  const results = await Promise.all(Array.from({ length: workers }, () => childRunner(tasks)));
  const totalWallMs = performance.now() - started;
  return {
    schemaVersion: SCHEMA_VERSION, mode: "concurrent", tasks, workers,
    sourceTokensPerWorker: results[0].sourceTokens, totalSourceTokens: results.reduce((sum, item) => sum + item.sourceTokens, 0),
    totalWallMs, medianWorkerCompactionMs: median(results.map((item) => item.compactionMs)),
    slowestWorkerCompactionMs: Math.max(...results.map((item) => item.compactionMs)),
    sumWorkerPeakRssKiB: results.reduce((sum, item) => sum + item.peakRssKiB, 0),
    maximumWorkerTimerDelayMs: Math.max(...results.map((item) => item.maximumTimerDelayMs)),
    protectedFactRate: Math.min(...results.map((item) => item.protectedFactRate)),
    falseCompletion: Math.max(...results.map((item) => item.falseCompletion)),
    validationErrors: results.reduce((sum, item) => sum + item.validationErrors, 0),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (args.mode === "help") { console.log(HELP); return; }
  const output = args.mode === "series" ? await runSeries(args["final-tasks"], args.generations)
    : args.mode === "concurrent" ? await runConcurrent(args.tasks, args.workers)
    : await runSingle(args.tasks);
  console.log(JSON.stringify(output));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
