import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/benchmark-v2.mjs");
const TOP_LEVEL_FIELDS = [
  "schemaVersion", "benchmark", "inputKind", "records", "blocks", "sourceTokens", "renderedTokens",
  "reductionRatio", "protectedFactRate", "falseCompletion", "exactRecoveryRate", "categories", "search",
  "validationWarnings", "timing",
];
const SEARCH_FIELDS = ["queryCount", "queriesWithHits", "averageHits"];

async function run(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
  }
}

test("benchmark synthetic smoke runs are deterministic and emit the exact safe schema", async () => {
  const first = await run("--synthetic-tasks", "20");
  const second = await run("--synthetic-tasks", "20");
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  const left = JSON.parse(first.stdout) as Record<string, unknown>;
  const right = JSON.parse(second.stdout) as Record<string, unknown>;
  const stableLeft = JSON.parse(JSON.stringify(left)) as Record<string, unknown>;
  const stableRight = JSON.parse(JSON.stringify(right)) as Record<string, unknown>;
  delete (stableLeft.timing as Record<string, unknown>).compactionMs;
  delete (stableLeft.timing as Record<string, unknown>).indexBuildMs;
  delete (stableRight.timing as Record<string, unknown>).compactionMs;
  delete (stableRight.timing as Record<string, unknown>).indexBuildMs;
  assert.deepEqual(stableLeft, stableRight);
  assert.deepEqual(Object.keys(left), TOP_LEVEL_FIELDS);
  assert.deepEqual(Object.keys(left.search as Record<string, unknown>), SEARCH_FIELDS);
  assert.deepEqual(Object.keys(left.timing as Record<string, unknown>), ["advisory", "compactionMs", "indexBuildMs"]);
  assert.equal(left.schemaVersion, 2);
  assert.equal(left.benchmark, "chrono-v2-public-manual");
  assert.equal(left.inputKind, "synthetic");
  assert.equal((left.timing as Record<string, unknown>).advisory, true);

  const serialized = JSON.stringify(left);
  for (const forbidden of [
    "Never publish private evidence",
    "migration guard expected=pending",
    "Revision r250",
    "/repo/src/year-run.ts",
    "syn-root",
    "syn-r-250",
    "syn-call-250",
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  for (const query of ["error", "failure", "tool", "user"]) {
    assert.equal(new RegExp(`\\\"query\\\"\\s*:\\s*\\\"${query}\\\"`).test(serialized), false, query);
  }
  assert.equal(serialized.includes("generationHash"), false);
  assert.equal(serialized.includes("sessionId"), false);
  assert.equal(serialized.includes("recovered"), false);
});

test("fixture access requires an explicit single-file option and rejects positional paths", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "chrono-benchmark-"));
  const directory = resolve(root, "fixture.jsonl");
  await mkdir(directory);
  const directoryResult = await run("--fixture", directory);
  const positionalResult = await run(directory);
  for (const result of [directoryResult, positionalResult]) {
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /\"error\":\"benchmark-input-rejected\"/);
    assert.equal(result.stdout.includes(root), false);
    assert.equal(result.stderr, "");
  }
});

test("symlink fixtures are rejected without reading the target", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "chrono-benchmark-"));
  const target = resolve(root, "target.jsonl");
  const link = resolve(root, "fixture.jsonl");
  await writeFile(target, "private-looking fixture text\n", "utf8");
  await symlink(target, link);
  const result = await run("--fixture", link);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout.includes("private-looking fixture text"), false);
  assert.equal(result.stdout.includes(link), false);
  assert.equal(result.stderr, "");
});

test("default source has no environment, home, or session discovery", async () => {
  const source = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/benchmark-v2.mjs"), "utf8");
  for (const forbidden of ["process.env", "process.cwd", "homedir", "HOME", "CHRONO_BENCH_SESSION", "readSessionJsonl"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.equal(source.includes("<private-session-path>"), false);
});

test("invalid JSONL does not print fixture content or path", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "chrono-benchmark-"));
  const path = resolve(root, "invalid.jsonl");
  await writeFile(path, "not jsonl\n", "utf8");
  const result = await run("--fixture", path);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout.includes("not jsonl"), false);
  assert.equal(result.stdout.includes(path), false);
  assert.equal(result.stderr, "");
});
