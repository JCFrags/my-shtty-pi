import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error Package-local executable support module intentionally has no declaration file.
import * as harnessModule from "../../scripts/benchmark-harness.mjs";

const { parseHarnessArguments, runHarness } = harnessModule as any;
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/benchmark-harness.mjs");
const execFileAsync = promisify(execFile);

async function command(...args: string[]) {
  try {
    const result = await execFileAsync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function normalized(report: any) {
  const copy = JSON.parse(JSON.stringify(report));
  copy.advisory = "omitted";
  return copy;
}

test("argument parser accepts only bounded profiles and heap lanes", () => {
  assert.deepEqual(parseHarnessArguments(["normal"]), { mode: "normal", profiles: ["small", "medium"], heaps: [512, 1024] });
  assert.deepEqual(parseHarnessArguments(["fixed-heap", "--profiles", "small,adversarial", "--heaps", "512,2048"]), { mode: "fixed-heap", profiles: ["small", "adversarial"], heaps: [512, 2048] });
  assert.deepEqual(parseHarnessArguments(["child", "--profile", "multi-agent"]), { mode: "child", profiles: ["small", "medium"], heaps: [512, 1024], profile: "multi-agent" });
  for (const argv of [["normal", "--heaps", "512"], ["fixed-heap", "--heaps", "256"], ["normal", "--profiles", "small,small"], ["child"], ["unknown"]]) {
    assert.throws(() => parseHarnessArguments(argv), /harness-/);
  }
});

test("aggregate schema is stable and any bounded child failure fails the lane", async () => {
  const child = async (profile: string, heapMiB?: number) => ({
    schemaVersion: 1, kind: "chrono-m02-workload", status: profile === "medium" ? "failed" : "passed",
    deterministic: { profile, heapMiB, records: 1, workerCodes: profile === "medium" ? ["worker-timeout"] : [] },
    advisory: { wallMs: 1 },
  });
  const result = await runHarness("fixed-heap", ["small", "medium"], [512, 1024], child);
  assert.equal(result.status, "failed");
  assert.deepEqual(Object.keys(result), ["schemaVersion", "kind", "mode", "status", "deterministic", "advisory"]);
  assert.equal(result.deterministic.runs.length, 4);
  assert.equal(result.deterministic.runs.filter((run: { status: string }) => run.status === "failed").length, 2);
});

test("small child runs are deterministic apart from advisory measurements", async () => {
  const first = await command("child", "--profile", "small");
  const second = await command("child", "--profile", "small");
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.equal(first.stderr, "");
  assert.equal(second.stderr, "");
  const left = JSON.parse(first.stdout), right = JSON.parse(second.stdout);
  assert.deepEqual(normalized(left), normalized(right));
  assert.equal(left.status, "passed");
  assert.deepEqual(Object.keys(left.deterministic), [
    "profile", "records", "activeBranchRecords", "sourceBytes", "bytesRead", "bytesWritten", "outputHash", "generationHash",
    "repeatedOutputEqual", "repeatedGenerationEqual", "sourceTokens", "renderedTokens", "validationErrors", "validationWarnings", "workerCodes", "derivedStoreGrowthBytes",
  ]);
  assert.deepEqual(Object.keys(left.advisory), ["wallMs", "cpuUserMicros", "cpuSystemMicros", "peakRssKiB", "heapUsedBefore", "heapUsedAfter", "heapUsedDelta"]);
  assert.equal(left.deterministic.repeatedOutputEqual, true);
  assert.equal(left.deterministic.repeatedGenerationEqual, true);
  assert.match(left.deterministic.outputHash, /^[a-f0-9]{64}$/);
});

test("normal and fixed-heap CLI reports use the same deterministic workload schema", async () => {
  const normal = await command("normal", "--profiles", "small");
  const fixed = await command("fixed-heap", "--profiles", "small", "--heaps", "512");
  assert.equal(normal.code, 0);
  assert.equal(fixed.code, 0);
  const left = JSON.parse(normal.stdout), right = JSON.parse(fixed.stdout);
  assert.equal(left.status, "passed");
  assert.equal(right.status, "passed");
  const normalRun = left.deterministic.runs[0];
  const fixedRun = right.deterministic.runs[0];
  const { heapMiB: ignoredNormal, ...normalWork } = normalRun;
  const { heapMiB: ignoredFixed, ...fixedWork } = fixedRun;
  assert.deepEqual(normalWork, fixedWork);
  assert.equal(ignoredNormal, null);
  assert.equal(ignoredFixed, 512);

  const serialized = `${normal.stdout}${fixed.stdout}`;
  for (const forbidden of ["/home/", "sessionPath", "syn-root", "Never publish private evidence", "Concurrent append event"]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test("invalid CLI input returns one sanitized machine-readable failure", async () => {
  const result = await command("fixed-heap", "--heaps", "64");
  assert.notEqual(result.code, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { schemaVersion: 1, kind: "chrono-m02-harness", status: "failed", failureCode: "harness-input-rejected" });
});
