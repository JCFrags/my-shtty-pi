import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";

const root = process.cwd();
const verifier = join(root, "scripts", "verify-chrono-v3-baseline.mjs");
const packageRoot = join(root, "packages", "pi-chrono-compaction");

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

function clonedRepository() {
  const tempRoot = mkdtempSync(join(tmpdir(), "chrono-baseline-repository-"));
  const repositoryRoot = join(tempRoot, "repository");
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", root, repositoryRoot], { stdio: ["ignore", "pipe", "pipe"] });
  return { tempRoot, repositoryRoot };
}
function withClonedRepository(fn) {
  const clone = clonedRepository();
  try {
    return fn(clone.repositoryRoot);
  } finally {
    rmSync(clone.tempRoot, { recursive: true, force: true });
  }
}
function runStatic(repositoryRoot, ...args) {
  return run("--repository-root", repositoryRoot, "--allow-missing-live", "--static-only", "--allow-dirty", ...args);
}
function mutatePackage(repositoryRoot, mutate) {
  const path = join(repositoryRoot, "packages", "pi-chrono-compaction", "package.json");
  const value = JSON.parse(readFileSync(path, "utf8"));
  mutate(value);
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}
function manifestPath(repositoryRoot) {
  return join(repositoryRoot, "packages", "pi-chrono-compaction", "DEPLOYED.sha256");
}
function copiedLivePackage() {
  const tempRoot = mkdtempSync(join(tmpdir(), "chrono-baseline-test-"));
  const liveRoot = join(tempRoot, "package");
  cpSync(packageRoot, liveRoot, {
    recursive: true,
    filter: (path) => !["node_modules", "dist-test"].includes(basename(path)),
  });
  const clone = clonedRepository();
  return { tempRoot, liveRoot, repositoryRoot: clone.repositoryRoot, repositoryTempRoot: clone.tempRoot };
}

test("frozen repository baseline passes without requiring live files", () => withClonedRepository((repositoryRoot) => {
  const result = run("--repository-root", repositoryRoot, "--allow-missing-live", "--static-only");
  assert.equal(result.status, 0);
  assert.equal(result.json.status, "ok");
  assert.equal(result.json.schemaVersion, 3);
  assert.equal(result.json.repository.sourceFiles, 67);
  assert.equal(result.json.repository.distFiles, 66);
  assert.deepEqual(result.json.repository.deployedManifest, {
    runtimeMismatches: [],
    metadataExceptions: [],
  });
}));

test("missing live package is explicit and allowlisted", () => {
  const clone = clonedRepository();
  const tempRoot = mkdtempSync(join(tmpdir(), "chrono-baseline-missing-"));
  try {
    const missing = join(tempRoot, "missing");
    const denied = run("--repository-root", clone.repositoryRoot, "--live", missing);
    assert.equal(denied.status, 1);
    assert.equal(denied.json.code, "live-package-missing");
    const allowed = run("--repository-root", clone.repositoryRoot, "--allow-missing-live", "--live", missing);
    assert.equal(allowed.status, 0);
    assert.equal(allowed.json.live.state, "missing-allowed");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(clone.tempRoot, { recursive: true, force: true });
  }
});

test("matching copied live package passes the runtime boundary", () => {
  const { tempRoot, liveRoot, repositoryRoot, repositoryTempRoot } = copiedLivePackage();
  try {
    const result = run("--repository-root", repositoryRoot, "--live", liveRoot);
    assert.equal(result.status, 0);
    assert.equal(result.json.live.sourceMatch, true);
    assert.equal(result.json.live.distMatch, true);
    assert.equal(result.json.live.entrypointMatch, true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(repositoryTempRoot, { recursive: true, force: true });
  }
});

test("live metadata divergence fails without exposing a path", () => {
  const { tempRoot, liveRoot, repositoryRoot, repositoryTempRoot } = copiedLivePackage();
  try {
    const packageJson = JSON.parse(readFileSync(join(liveRoot, "package.json"), "utf8"));
    packageJson.description = "unexpected metadata";
    writeFileSync(join(liveRoot, "package.json"), `${JSON.stringify(packageJson)}\n`);
    const result = run("--repository-root", repositoryRoot, "--live", liveRoot);
    assert.equal(result.status, 1);
    assert.equal(result.json.code, "live-metadata-mismatch");
    assert.ok(!result.stdout.includes(liveRoot));
    assert.ok(!result.stderr.includes(liveRoot));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(repositoryTempRoot, { recursive: true, force: true });
  }
});

test("live runtime divergence fails closed", () => {
  const { tempRoot, liveRoot, repositoryRoot, repositoryTempRoot } = copiedLivePackage();
  try {
    const entrypoint = join(liveRoot, "dist", "src", "pi-extension.js");
    const bytes = readFileSync(entrypoint);
    bytes[0] ^= 1;
    writeFileSync(entrypoint, bytes);
    const result = run("--repository-root", repositoryRoot, "--live", liveRoot);
    assert.equal(result.status, 1);
    assert.equal(result.json.code, "live-runtime-mismatch");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(repositoryTempRoot, { recursive: true, force: true });
  }
});

// R2 fail-closed baseline matrix.
test("runtime byte mismatch fails", () => withClonedRepository((repositoryRoot) => {
  const path = join(repositoryRoot, "packages/pi-chrono-compaction/dist/src/pi-extension.js");
  const bytes = readFileSync(path);
  bytes[0] ^= 1;
  writeFileSync(path, bytes);
  const result = runStatic(repositoryRoot);
  assert.equal(result.status, 1);
  assert.ok(["dist-baseline-mismatch", "entrypoint-baseline-mismatch"].includes(result.json.code), JSON.stringify(result.json));
}));

test("missing dist runtime file fails", () => withClonedRepository((repositoryRoot) => {
  rmSync(join(repositoryRoot, "packages/pi-chrono-compaction/dist/src/pi-extension.js"));
  const result = runStatic(repositoryRoot);
  assert.equal(result.status, 1);
  assert.equal(result.json.code, "dist-file-count-changed");
}));

test("extra dist runtime file fails", () => withClonedRepository((repositoryRoot) => {
  writeFileSync(join(repositoryRoot, "packages/pi-chrono-compaction/dist/extra-r2.js"), "synthetic\n");
  const result = runStatic(repositoryRoot);
  assert.equal(result.status, 1);
  assert.equal(result.json.code, "dist-file-count-changed");
}));

test("missing source file fails", () => withClonedRepository((repositoryRoot) => {
  rmSync(join(repositoryRoot, "packages/pi-chrono-compaction/src/blocks.ts"));
  const result = runStatic(repositoryRoot);
  assert.equal(result.status, 1);
  assert.equal(result.json.code, "source-file-count-changed");
}));

test("extra live source file fails", () => {
  const { tempRoot, liveRoot, repositoryRoot, repositoryTempRoot } = copiedLivePackage();
  try {
    writeFileSync(join(liveRoot, "src", "extra-r2.ts"), "export {};\n");
    const result = run("--repository-root", repositoryRoot, "--live", liveRoot);
    assert.equal(result.status, 1);
    assert.equal(result.json.code, "live-runtime-files-missing");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(repositoryTempRoot, { recursive: true, force: true });
  }
});

test("unsafe source symlink fails", () => withClonedRepository((repositoryRoot) => {
  const source = join(repositoryRoot, "packages/pi-chrono-compaction/src/blocks.ts");
  rmSync(source);
  symlinkSync("../../../../outside-r2.txt", source);
  writeFileSync(join(repositoryRoot, "outside-r2.txt"), "outside\n");
  const result = runStatic(repositoryRoot);
  assert.equal(result.status, 1);
  assert.equal(result.json.code, "unsafe-tree");
}));

test("unsafe dist symlink fails", () => withClonedRepository((repositoryRoot) => {
  const dist = join(repositoryRoot, "packages/pi-chrono-compaction/dist/src/pi-extension.js");
  rmSync(dist);
  symlinkSync("../../../../outside-r2.js", dist);
  writeFileSync(join(repositoryRoot, "outside-r2.js"), "outside\n");
  const result = runStatic(repositoryRoot);
  assert.equal(result.status, 1);
  assert.equal(result.json.code, "unsafe-tree");
}));

test("arbitrary repository package metadata change fails", () => withClonedRepository((repositoryRoot) => {
  mutatePackage(repositoryRoot, (value) => { value.description = "unexpected R2 metadata"; });
  const result = runStatic(repositoryRoot);
  assert.equal(result.status, 1);
  assert.equal(result.json.code, "chrono-package-metadata-changed");
}));

test("dependency change fails", () => withClonedRepository((repositoryRoot) => {
  mutatePackage(repositoryRoot, (value) => { value.devDependencies["synthetic-dependency"] = "1.0.0"; });
  const result = runStatic(repositoryRoot);
  assert.equal(result.status, 1);
  assert.equal(result.json.code, "chrono-package-metadata-changed");
}));

test("peer dependency change fails", () => withClonedRepository((repositoryRoot) => {
  mutatePackage(repositoryRoot, (value) => { value.peerDependencies["synthetic-peer"] = "*"; });
  const result = runStatic(repositoryRoot);
  assert.equal(result.status, 1);
  assert.equal(result.json.code, "chrono-package-metadata-changed");
}));

test("Pi extension entrypoint change fails", () => withClonedRepository((repositoryRoot) => {
  mutatePackage(repositoryRoot, (value) => { value.pi.extensions[0] = "./dist/src/other-entrypoint.js"; });
  const result = runStatic(repositoryRoot);
  assert.equal(result.status, 1);
  assert.equal(result.json.code, "chrono-package-metadata-changed");
}));

test("existing build script change fails", () => withClonedRepository((repositoryRoot) => {
  mutatePackage(repositoryRoot, (value) => { value.scripts.build += " --pretty false"; });
  const result = runStatic(repositoryRoot);
  assert.equal(result.status, 1);
  assert.equal(result.json.code, "chrono-package-metadata-changed");
}));

test("exact M01 package metadata passes without an exception", () => withClonedRepository((repositoryRoot) => {
  const result = runStatic(repositoryRoot);
  assert.equal(result.status, 0, JSON.stringify(result.json));
  assert.deepEqual(result.json.repository.metadataExceptions, []);
  assert.deepEqual(result.json.repository.runtimeMismatches, []);
}));

test("changed test command fails", () => withClonedRepository((repositoryRoot) => {
  mutatePackage(repositoryRoot, (value) => { value.scripts.test = "node --test"; });
  const result = runStatic(repositoryRoot);
  assert.equal(result.status, 1);
  assert.equal(result.json.code, "chrono-package-metadata-changed");
}));

test("a second package field plus test command fails", () => withClonedRepository((repositoryRoot) => {
  mutatePackage(repositoryRoot, (value) => { value.scripts.test = "node --test"; value.description = "also changed"; });
  const result = runStatic(repositoryRoot);
  assert.equal(result.status, 1);
  assert.equal(result.json.code, "chrono-package-metadata-changed");
}));

test("package-lock mismatch fails", () => withClonedRepository((repositoryRoot) => {
  const path = join(repositoryRoot, "packages/pi-chrono-compaction/package-lock.json");
  writeFileSync(path, `${readFileSync(path, "utf8")}\n`);
  const result = runStatic(repositoryRoot);
  assert.equal(result.status, 1);
  assert.equal(result.json.code, "chrono-package-lock-changed");
}));

test("DEPLOYED manifest runtime hash mismatch fails", () => withClonedRepository((repositoryRoot) => {
  const path = manifestPath(repositoryRoot);
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  const index = lines.findIndex((line) => line.endsWith("  dist/src/pi-extension.js"));
  assert.notEqual(index, -1);
  lines[index] = `${"0".repeat(64)}  dist/src/pi-extension.js`;
  writeFileSync(path, `${lines.join("\n")}\n`);
  const result = runStatic(repositoryRoot);
  assert.equal(result.status, 1);
  assert.equal(result.json.code, "deployed-runtime-mismatch");
}));

test("DEPLOYED manifest missing runtime path fails", () => withClonedRepository((repositoryRoot) => {
  const path = manifestPath(repositoryRoot);
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  const index = lines.findIndex((line) => line.endsWith("  dist/src/pi-extension.js"));
  assert.notEqual(index, -1);
  lines.splice(index, 1);
  writeFileSync(path, `${lines.join("\n")}\n`);
  const result = runStatic(repositoryRoot);
  assert.equal(result.status, 1);
  assert.equal(result.json.code, "deployed-manifest-scope-changed");
}));

test("DEPLOYED manifest extra path fails", () => withClonedRepository((repositoryRoot) => {
  const path = manifestPath(repositoryRoot);
  writeFileSync(path, `${readFileSync(path, "utf8").trimEnd()}\n${"0".repeat(64)}  dist/extra-r2.js\n`);
  const result = runStatic(repositoryRoot);
  assert.equal(result.status, 1);
  assert.equal(result.json.code, "deployed-manifest-scope-changed");
}));

test("dirty repository fails by default", () => withClonedRepository((repositoryRoot) => {
  writeFileSync(join(repositoryRoot, "dirty-r2.txt"), "synthetic\n");
  const result = run(repositoryRoot === root ? "--repository-root" : "--repository-root", repositoryRoot, "--allow-missing-live", "--static-only");
  assert.equal(result.status, 1);
  assert.equal(result.json.code, "dirty-repository");
}));

test("dirty repository passes only with explicit allow-dirty diagnostic mode", () => withClonedRepository((repositoryRoot) => {
  writeFileSync(join(repositoryRoot, "dirty-r2.txt"), "synthetic\n");
  const result = runStatic(repositoryRoot);
  assert.equal(result.status, 0, JSON.stringify(result.json));
  assert.equal(result.json.repository.workingTree.allowDirtyUsed, true);
  assert.equal(result.json.repository.workingTree.clean, false);
}));

test("invalid repository root fails safely", () => {
  const empty = mkdtempSync(join(tmpdir(), "chrono-baseline-invalid-root-"));
  try {
    const result = run("--repository-root", empty, "--allow-missing-live", "--static-only");
    assert.equal(result.status, 1);
    assert.equal(result.json.code, "invalid-repository-root");
    assert.ok(!result.stdout.includes(empty));
    assert.ok(!result.stderr.includes(empty));
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("symlink repository root is rejected without escape", () => {
  const clone = clonedRepository();
  const link = join(clone.tempRoot, "repository-link");
  try {
    symlinkSync(clone.repositoryRoot, link);
    const result = run("--repository-root", link, "--allow-missing-live", "--static-only");
    assert.equal(result.status, 1);
    assert.equal(result.json.code, "invalid-repository-root");
    assert.ok(!result.stdout.includes(link));
    assert.ok(!result.stderr.includes(link));
  } finally {
    rmSync(clone.tempRoot, { recursive: true, force: true });
  }
});

test("equivalent verification output is deterministic", () => withClonedRepository((repositoryRoot) => {
  const first = runStatic(repositoryRoot);
  const second = runStatic(repositoryRoot);
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.deepEqual(second.json, first.json);
}));
