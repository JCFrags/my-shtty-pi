import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";

const root = process.cwd();
const verifier = join(root, "scripts", "verify-chrono-v3-baseline.mjs");
const packageRoot = join(root, "packages", "pi-chrono-compaction");
const runtimeBaseline = "eb9742c318a76eeaf753e87a620fae83ca9048d1";

function run(...args) {
  const result = spawnSync(process.execPath, [verifier, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 120000,
  });
  const jsonText = (result.stdout || result.stderr).trim();
  let json;
  try {
    json = JSON.parse(jsonText);
  } catch (error) {
    assert.fail(`baseline verifier did not emit JSON: ${error.message}`);
  }
  return { ...result, json };
}

function copiedLivePackage() {
  const tempRoot = mkdtempSync(join(tmpdir(), "chrono-baseline-test-"));
  const liveRoot = join(tempRoot, "package");
  cpSync(packageRoot, liveRoot, {
    recursive: true,
    filter: (path) => !["node_modules", "dist-test"].includes(basename(path)),
  });
  const baselinePackage = execFileSync("git", ["show", `${runtimeBaseline}:packages/pi-chrono-compaction/package.json`], {
    cwd: root,
    encoding: null,
    stdio: ["ignore", "pipe", "ignore"],
  });
  writeFileSync(join(liveRoot, "package.json"), baselinePackage);
  return { tempRoot, liveRoot };
}

test("frozen repository baseline passes without requiring live files", () => {
  const result = run("--allow-missing-live", "--static-only");
  assert.equal(result.status, 0);
  assert.equal(result.json.status, "ok");
  assert.equal(result.json.schemaVersion, 2);
  assert.equal(result.json.repository.sourceFiles, 66);
  assert.equal(result.json.repository.distFiles, 65);
  assert.deepEqual(result.json.repository.deployedManifest, {
    runtimeMismatches: [],
    metadataMismatches: ["package.json"],
  });
});

test("missing live package is explicit and allowlisted", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "chrono-baseline-missing-"));
  try {
    const denied = run("--live", join(tempRoot, "missing"));
    assert.equal(denied.status, 1);
    assert.equal(denied.json.code, "live-package-missing");
    const allowed = run("--allow-missing-live", "--live", join(tempRoot, "missing"));
    assert.equal(allowed.status, 0);
    assert.equal(allowed.json.live.state, "missing-allowed");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("matching copied live package passes the runtime boundary", () => {
  const { tempRoot, liveRoot } = copiedLivePackage();
  try {
    const result = run("--live", liveRoot);
    assert.equal(result.status, 0);
    assert.equal(result.json.live.sourceMatch, true);
    assert.equal(result.json.live.distMatch, true);
    assert.equal(result.json.live.entrypointMatch, true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("live metadata divergence fails without exposing a path", () => {
  const { tempRoot, liveRoot } = copiedLivePackage();
  try {
    const packageJson = JSON.parse(readFileSync(join(liveRoot, "package.json"), "utf8"));
    packageJson.description = "unexpected metadata";
    writeFileSync(join(liveRoot, "package.json"), `${JSON.stringify(packageJson)}\n`);
    const result = run("--live", liveRoot);
    assert.equal(result.status, 1);
    assert.equal(result.json.code, "live-metadata-mismatch");
    assert.ok(!result.stdout.includes(liveRoot));
    assert.ok(!result.stderr.includes(liveRoot));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("live runtime divergence fails closed", () => {
  const { tempRoot, liveRoot } = copiedLivePackage();
  try {
    const entrypoint = join(liveRoot, "dist", "src", "pi-extension.js");
    const bytes = readFileSync(entrypoint);
    bytes[0] ^= 1;
    writeFileSync(entrypoint, bytes);
    const result = run("--live", liveRoot);
    assert.equal(result.status, 1);
    assert.equal(result.json.code, "live-runtime-mismatch");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
