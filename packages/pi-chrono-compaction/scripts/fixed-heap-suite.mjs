#!/usr/bin/env node
// @ts-nocheck
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const SCHEMA_VERSION = 1;
const ALLOWED_HEAPS = [512, 1024, 2048];
const DEFAULT_HEAPS = [512, 1024];
const TEST_FILES = Object.freeze([
  "dist-test/test/fault-injection.test.js",
  "dist-test/test/legacy-memory-safety.test.js",
  "dist-test/test/source-ledger.test.js",
  "dist-test/test/derived-store-lock.test.js",
  "dist-test/test/host-worker-scheduler.test.js",
  "dist-test/test/compaction-worker.test.js",
  "dist-test/test/candidate-segment-store.test.js",
  "dist-test/test/history-rollup-store.test.js",
]);
const PROFILES = Object.freeze(["small", "medium"]);

export function parseFixedHeapArguments(argv) {
  if (argv.length === 0) return { heaps: [...DEFAULT_HEAPS] };
  if (argv.length !== 2 || argv[0] !== "--heaps") throw new Error("fixed-heap-option");
  const raw = argv[1].split(",");
  const heaps = raw.map(Number);
  if (raw.length === 0 || new Set(heaps).size !== heaps.length || heaps.some((heap) => !ALLOWED_HEAPS.includes(heap))) throw new Error("fixed-heap-value");
  return { heaps };
}

function safeFailure(error) {
  const text = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`.toLowerCase();
  if (text.includes("heap out of memory") || text.includes("allocation failed")) return "unbounded-oom";
  if (error?.killed) return "suite-timeout";
  if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "suite-output-limit";
  return "test-failure";
}

async function runTests(heapMiB) {
  const started = performance.now();
  try {
    await execFileAsync(process.execPath, [`--max-old-space-size=${heapMiB}`, "--test", "--test-concurrency=1", ...TEST_FILES], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 15 * 60_000 });
    return { status: "passed", failureCode: null, wallMs: performance.now() - started };
  } catch (error) {
    return { status: "failed", failureCode: safeFailure(error), wallMs: performance.now() - started };
  }
}

async function runCharacterization(heapMiB) {
  const started = performance.now();
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [`--max-old-space-size=${heapMiB}`, "--expose-gc", "scripts/memory-characterization.mjs"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 10 * 60_000 });
    const parsed = JSON.parse(stdout);
    if (stderr.trim() || parsed?.status !== "passed" || parsed?.kind !== "chrono-m02-memory-characterization") throw Object.assign(new Error("characterization-failed"), { stdout, stderr });
    return { status: "passed", failureCode: null, deterministic: parsed.deterministic, wallMs: performance.now() - started, child: parsed.advisory };
  } catch (error) {
    return { status: "failed", failureCode: safeFailure(error), deterministic: {}, wallMs: performance.now() - started, child: {} };
  }
}

async function runProfile(heapMiB, profile) {
  const started = performance.now();
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [`--max-old-space-size=${heapMiB}`, "scripts/benchmark-harness.mjs", "child", "--profile", profile], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 10 * 60_000 });
    const parsed = JSON.parse(stdout);
    if (stderr.trim() || parsed?.status !== "passed" || parsed?.kind !== "chrono-m02-workload") throw Object.assign(new Error("profile-failed"), { stdout, stderr });
    return { status: "passed", failureCode: null, deterministic: parsed.deterministic, wallMs: performance.now() - started, child: parsed.advisory };
  } catch (error) {
    return { status: "failed", failureCode: safeFailure(error), deterministic: { profile }, wallMs: performance.now() - started, child: {} };
  }
}

export async function runFixedHeapSuite(heaps) {
  const lanes = [];
  for (const heapMiB of heaps) {
    const tests = await runTests(heapMiB);
    const characterization = tests.status === "passed" ? await runCharacterization(heapMiB) : { status: "failed", failureCode: "tests-not-passed", deterministic: {}, wallMs: 0, child: {} };
    const profiles = [];
    if (tests.status === "passed" && characterization.status === "passed") for (const profile of PROFILES) profiles.push(await runProfile(heapMiB, profile));
    const status = tests.status === "passed" && characterization.status === "passed" && profiles.every((result) => result.status === "passed") ? "passed" : "failed";
    lanes.push({ heapMiB, status, tests, characterization, profiles });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "chrono-m02-fixed-heap-fault-suite",
    status: lanes.every((lane) => lane.status === "passed") ? "passed" : "failed",
    deterministic: {
      heaps: [...heaps],
      testFiles: [...TEST_FILES],
      profiles: [...PROFILES],
      lanes: lanes.map((lane) => ({ heapMiB: lane.heapMiB, status: lane.status, tests: { status: lane.tests.status, failureCode: lane.tests.failureCode }, characterization: { status: lane.characterization.status, failureCode: lane.characterization.failureCode, ...lane.characterization.deterministic }, profiles: lane.profiles.map((profile) => ({ status: profile.status, failureCode: profile.failureCode, ...profile.deterministic })) })),
      oomIsPassing: false,
    },
    advisory: { lanes: lanes.map((lane) => ({ heapMiB: lane.heapMiB, testWallMs: lane.tests.wallMs, characterization: { wallMs: lane.characterization.wallMs, ...lane.characterization.child }, profiles: lane.profiles.map((profile) => ({ profile: profile.deterministic.profile, wallMs: profile.wallMs, ...profile.child })) })) },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseFixedHeapArguments(argv);
  const result = await runFixedHeapSuite(args.heaps);
  console.log(JSON.stringify(result));
  if (result.status !== "passed") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch(() => {
  console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, kind: "chrono-m02-fixed-heap-fault-suite", status: "failed", failureCode: "fixed-heap-input-rejected" }));
  process.exitCode = 1;
});
