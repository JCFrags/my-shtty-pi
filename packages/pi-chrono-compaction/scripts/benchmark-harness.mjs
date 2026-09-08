#!/usr/bin/env node
// @ts-nocheck
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createSyntheticSession, serializeSyntheticSession, SYNTHETIC_PROFILES } from "./synthetic-session.mjs";
import { loadTestRuntime } from "./test-runtime-entry.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(import.meta.url);
const SCHEMA_VERSION = 1;
const PROFILE_NAMES = Object.freeze(Object.keys(SYNTHETIC_PROFILES));
const AUTOMATED_PROFILES = Object.freeze(["small", "medium"]);
const HEAP_LANES = Object.freeze([512, 1024]);
const MAX_CHILD_OUTPUT_BYTES = 4 * 1024 * 1024;
const HELP = "Usage: benchmark-harness.mjs normal [--profiles small,medium] | fixed-heap [--profiles small,medium] [--heaps 512,1024] | child --profile NAME";

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function list(value, allowed, code) {
  const items = value.split(",");
  if (items.length === 0 || new Set(items).size !== items.length || items.some((item) => !allowed.includes(item))) throw new Error(code);
  return items;
}

export function parseHarnessArguments(argv) {
  const mode = argv[0];
  if (mode === "--help" || mode === "help") return { mode: "help" };
  if (!["normal", "fixed-heap", "child"].includes(mode)) throw new Error("harness-mode");
  const result = { mode, profiles: [...AUTOMATED_PROFILES], heaps: [...HEAP_LANES] };
  for (let index = 1; index < argv.length; index += 2) {
    const option = argv[index], value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("harness-option");
    if (option === "--profiles" && mode !== "child") result.profiles = list(value, PROFILE_NAMES, "harness-profile");
    else if (option === "--heaps" && mode === "fixed-heap") result.heaps = list(value, ["512", "1024", "2048"], "harness-heap").map(Number);
    else if (option === "--profile" && mode === "child") result.profile = list(value, PROFILE_NAMES, "harness-profile")[0];
    else throw new Error("harness-option");
  }
  if (mode === "child" && !result.profile) throw new Error("harness-profile");
  return result;
}

function stableResult(result) {
  const summary = result.summary;
  return {
    outputHash: hash(summary),
    generationHash: result.details.generationHash,
    sourceTokens: result.rawTokens,
    renderedTokens: result.renderedTokens,
    validationErrors: result.validation.issues.filter((issue) => issue.severity === "error").length,
    validationWarnings: result.validation.issues.filter((issue) => issue.severity === "warning").length,
  };
}

export async function runChild(profileName) {
  const runtime = await loadTestRuntime();
  const fixture = createSyntheticSession(profileName);
  const text = serializeSyntheticSession(fixture);
  const parsed = runtime.parseSessionJsonl(text);
  const entries = runtime.getActiveBranch(parsed);
  const memoryBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  const first = await runtime.compactEntries(entries, { config: { targetTokens: 12_000 } });
  const second = await runtime.compactEntries(entries, { config: { targetTokens: 12_000 } });
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const memoryAfter = process.memoryUsage();
  const left = stableResult(first), right = stableResult(second);
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "chrono-m02-workload",
    status: left.validationErrors === 0 && JSON.stringify(left) === JSON.stringify(right) ? "passed" : "failed",
    deterministic: {
      profile: profileName,
      records: fixture.entries.length,
      activeBranchRecords: entries.length,
      sourceBytes: Buffer.byteLength(text),
      bytesRead: Buffer.byteLength(text) * 2,
      bytesWritten: Buffer.byteLength(first.summary) + Buffer.byteLength(second.summary),
      outputHash: left.outputHash,
      generationHash: left.generationHash,
      repeatedOutputEqual: left.outputHash === right.outputHash,
      repeatedGenerationEqual: left.generationHash === right.generationHash,
      sourceTokens: left.sourceTokens,
      renderedTokens: left.renderedTokens,
      validationErrors: left.validationErrors,
      validationWarnings: left.validationWarnings,
      workerCodes: [],
      derivedStoreGrowthBytes: 0,
    },
    advisory: {
      wallMs,
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
      peakRssKiB: process.resourceUsage().maxRSS,
      heapUsedBefore: memoryBefore.heapUsed,
      heapUsedAfter: memoryAfter.heapUsed,
      heapUsedDelta: memoryAfter.heapUsed - memoryBefore.heapUsed,
    },
  };
}

async function defaultChildRunner(profile, heapMiB) {
  const args = [...(heapMiB === undefined ? [] : [`--max-old-space-size=${heapMiB}`]), SCRIPT, "child", "--profile", profile];
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, { encoding: "utf8", maxBuffer: MAX_CHILD_OUTPUT_BYTES, timeout: 10 * 60_000 });
    if (stderr.trim()) throw new Error("harness-child-stderr");
    const result = JSON.parse(stdout);
    if (result?.schemaVersion !== SCHEMA_VERSION || result?.kind !== "chrono-m02-workload") throw new Error("harness-child-schema");
    return result;
  } catch (error) {
    const code = error?.killed ? "child-timeout" : error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "child-output-limit" : "child-failed";
    return { schemaVersion: SCHEMA_VERSION, kind: "chrono-m02-workload", status: "failed", deterministic: { profile, failureCode: code, workerCodes: [] }, advisory: {} };
  }
}

export async function runHarness(mode, profiles, heaps, childRunner = defaultChildRunner) {
  const lanes = mode === "normal" ? [{ heapMiB: null }] : heaps.map((heapMiB) => ({ heapMiB }));
  const reports = [];
  for (const lane of lanes) for (const profile of profiles) reports.push({ heapMiB: lane.heapMiB, report: await childRunner(profile, lane.heapMiB ?? undefined) });
  const status = reports.every(({ report }) => report.status === "passed") ? "passed" : "failed";
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "chrono-m02-harness",
    mode,
    status,
    deterministic: {
      profiles: [...profiles],
      heapMiB: lanes.map((lane) => lane.heapMiB),
      runs: reports.map(({ heapMiB, report }) => ({ heapMiB, status: report.status, ...report.deterministic })),
    },
    advisory: { runs: reports.map(({ heapMiB, report }) => ({ heapMiB, profile: report.deterministic.profile, ...report.advisory })) },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseHarnessArguments(argv);
  if (args.mode === "help") { console.log(HELP); return; }
  const result = args.mode === "child" ? await runChild(args.profile) : await runHarness(args.mode, args.profiles, args.heaps);
  console.log(JSON.stringify(result));
  if (result.status !== "passed") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch(() => {
  console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, kind: "chrono-m02-harness", status: "failed", failureCode: "harness-input-rejected" }));
  process.exitCode = 1;
});
