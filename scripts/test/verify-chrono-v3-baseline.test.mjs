import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
function runSyntheticDeployed(repositoryRoot) {
  const deployedVerifier = join(repositoryRoot, "scripts", "verify-deployed-baseline.mjs");
  const source = readFileSync(join(root, "scripts", "verify-deployed-baseline.mjs"), "utf8");
  const scannerCall = 'runPhase("privacy", "root", verifyPublicationScanner)';
  assert.equal(source.split(scannerCall).length, 2, "expected one publication scanner call");
  writeFileSync(deployedVerifier, source.replace(scannerCall, 'runPhase("privacy", "root", () => "test-bypass")'));
  return spawnSync(process.execPath, [deployedVerifier, "--static-only", "--product", "pi-chrono-compaction"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 120000,
  });
}
function runSyntheticExecutor(repositoryRoot, { staticOnly = false, fail = "", packOutput = JSON.stringify([{ files: [] }]), product = "pi-chrono-compaction" } = {}) {
  const deployedVerifier = join(repositoryRoot, "scripts", "verify-deployed-baseline.mjs");
  const commandLog = join(repositoryRoot, ".synthetic-executor-log");
  rmSync(commandLog, { force: true });
  let source = readFileSync(join(root, "scripts", "verify-deployed-baseline.mjs"), "utf8");
  source = source.replace(
    'import { execFileSync } from "node:child_process";',
    `import { execFileSync as realExecFileSync } from "node:child_process";\nimport { appendFileSync, mkdirSync, writeFileSync } from "node:fs";\nfunction execFileSync(command, args, options = {}) {\n  if (process.env.CHRONO_SYNTHETIC_EXECUTOR_LOG && command === "npm") {\n    appendFileSync(process.env.CHRONO_SYNTHETIC_EXECUTOR_LOG, JSON.stringify(args) + "\\n");\n    const phase = args[0] === "run" ? args[1] : args[0];\n    if (process.env.CHRONO_SYNTHETIC_EXECUTOR_FAIL === phase || (phase === "test:normal" && ["nested-test", "replay"].includes(process.env.CHRONO_SYNTHETIC_EXECUTOR_FAIL))) throw new Error("synthetic command failure");\n    if (args[0] === "test") {\n      for (const path of ["dist/pi/extension.js", "dist/pane/main.js"]) {\n        mkdirSync(dirname(join(options.cwd, path)), { recursive: true });\n        writeFileSync(join(options.cwd, path), "synthetic\\n");\n      }\n    }\n    if (args[0] === "pack") return process.env.CHRONO_SYNTHETIC_PACK_OUTPUT;\n    return options.encoding ? "" : Buffer.alloc(0);\n  }\n  return realExecFileSync(command, args, options);\n}`,
  );
  source = source.replace('runPhase("privacy", "root", verifyPublicationScanner)', 'runPhase("privacy", "root", () => "test-bypass")');
  source = source.replace("verifyBuiltOutput(product, plan.packageRoot, work)", "107");
  writeFileSync(deployedVerifier, source);
  const args = [deployedVerifier];
  if (product) args.push("--product", product);
  if (staticOnly) args.push("--static-only");
  const result = spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 120000,
    env: {
      ...process.env,
      CHRONO_SYNTHETIC_EXECUTOR_LOG: commandLog,
      CHRONO_SYNTHETIC_EXECUTOR_FAIL: fail,
      CHRONO_SYNTHETIC_PACK_OUTPUT: packOutput,
    },
  });
  const commands = existsSync(commandLog)
    ? readFileSync(commandLog, "utf8").trimEnd().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const events = result.stderr.split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value.event?.startsWith("phase-") ? [value] : [];
    } catch {
      return [];
    }
  });
  let json;
  if (result.status === 0) json = JSON.parse(result.stdout);
  return { ...result, commands, events, json };
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
  assert.equal(result.json.repository.sourceFiles, 108);
  assert.equal(result.json.repository.distFiles, 107);
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

test("exact candidate package metadata passes without an exception", () => withClonedRepository((repositoryRoot) => {
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

test("changed normal wrapper command fails", () => withClonedRepository((repositoryRoot) => {
  mutatePackage(repositoryRoot, (value) => { value.scripts["test:normal"] = "node scripts/benchmark-harness.mjs normal"; });
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

test("deployed verifier accepts the two exact authorized historical hashes", () => withClonedRepository((repositoryRoot) => {
  const result = runSyntheticDeployed(repositoryRoot);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.deployedHashesVerified, "303/303");
  assert.equal(output.historicalCanonicalDeployedFiles, "291/291");
  assert.equal(output.m05DeployedAdditions, "12/12");
}));

test("deployed verifier rejects a same-count historical non-JS substitution", () => withClonedRepository((repositoryRoot) => {
  const path = manifestPath(repositoryRoot);
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  const index = lines.findIndex((line) => line.endsWith("  package.json"));
  assert.notEqual(index, -1);
  const readme = readFileSync(join(repositoryRoot, "packages", "pi-chrono-compaction", "README.md"));
  lines[index] = `${createHash("sha256").update(readme).digest("hex")}  README.md`;
  writeFileSync(path, `${lines.join("\n")}\n`);
  const result = runSyntheticDeployed(repositoryRoot);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /historical deployed record changed: package\.json/u);
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

test("Chrono executor runs the wrapper once without directly duplicating nested test", () => withClonedRepository((repositoryRoot) => {
  const result = runSyntheticExecutor(repositoryRoot);
  assert.equal(result.status, 0, result.stderr);
  const runScripts = result.commands.filter((args) => args[0] === "run").map((args) => args[1]);
  assert.deepEqual(runScripts, [
    "catalog:sqlite:build-record",
    "typecheck",
    "build",
    "catalog:sqlite:probe-record",
    "test:normal",
    "test:fixed-heap",
  ]);
  assert.deepEqual(result.json.safeScripts, {
    mode: "executed",
    declarationsValidated: "5/5",
    directCommands: "4/4",
    wrapperCoveredDeclarations: "1/1",
  });
  const completed = result.events.filter((event) => event.event === "phase-complete");
  for (const phase of ["packaging", "clean-copy", "dependencies", "native-build-record", "typecheck", "build", "reproducibility", "native-probe-record", "normal-replay", "fixed-heaps"]) {
    assert.ok(completed.some((event) => event.phase === phase && event.outcome === "passed" && Number.isInteger(event.elapsedMs)), phase);
  }
}));

test("Chrono executor reports wrapper, native, and heap failures before rethrowing", () => withClonedRepository((repositoryRoot) => {
  for (const [failure, phase] of [
    ["catalog:sqlite:build-record", "native-build-record"],
    ["catalog:sqlite:probe-record", "native-probe-record"],
    ["nested-test", "normal-replay"],
    ["replay", "normal-replay"],
    ["test:fixed-heap", "fixed-heaps"],
  ]) {
    const result = runSyntheticExecutor(repositoryRoot, { fail: failure });
    assert.equal(result.status, 1, `${failure}: ${result.stderr}`);
    assert.ok(result.events.some((event) => event.event === "phase-complete" && event.phase === phase && event.outcome === "failed"), failure);
  }
}));

test("Project Glance packaging validation failure reports a failed phase", () => withClonedRepository((repositoryRoot) => {
  const result = runSyntheticExecutor(repositoryRoot, { product: "pi-project-glance", packOutput: "not-json" });
  assert.equal(result.status, 1, result.stderr);
  const packaging = result.events.filter((event) => event.phase === "packaging" && event.slug === "pi-project-glance");
  assert.equal(packaging.at(-1)?.event, "phase-complete");
  assert.equal(packaging.at(-1)?.outcome, "failed");
}));

test("Project Glance packaging pass keeps its JSON report", () => withClonedRepository((repositoryRoot) => {
  const files = [
    "README.md", "bin/pi-project-glance", "dist/pane/main.js", "dist/pi/extension.js",
    "herdr-plugin.toml", "package-lock.json", "package.json",
  ].map((path) => ({ path }));
  const result = runSyntheticExecutor(repositoryRoot, { product: "pi-project-glance", packOutput: JSON.stringify([{ files }]) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.projectGlance.status, "pass");
  assert.equal(result.json.projectGlance.tests, "pass");
  assert.equal(result.json.projectGlance.packFiles, files.length);
  assert.ok(result.events.some((event) => event.event === "phase-complete" && event.phase === "packaging" && event.slug === "pi-project-glance" && event.outcome === "passed"));
}));

test("static deployed verification reports all declarations without runtime execution", () => withClonedRepository((repositoryRoot) => {
  const result = runSyntheticExecutor(repositoryRoot, { staticOnly: true, product: null });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.commands, []);
  assert.deepEqual(result.json.safeScripts, {
    mode: "static-only",
    declarationsValidated: "15/15",
    directCommands: "0/14",
    wrapperCoveredDeclarations: "0/1",
  });
  assert.deepEqual(result.json.nativeScripts, {
    declarationsValidated: "4/4",
    controlledCommands: "0/2",
  });
}));
