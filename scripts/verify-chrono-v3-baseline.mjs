#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let repoRoot = defaultRepoRoot;
const packageSlug = "pi-chrono-compaction";
let packageRoot = join(repoRoot, "packages", packageSlug);
const packageRelative = `packages/${packageSlug}`;
const entrypointRelative = "dist/src/pi-extension.js";
const deployedManifestRelative = `${packageRelative}/DEPLOYED.sha256`;

// These values are the frozen M00 runtime boundary. A later runtime milestone
// must deliberately replace this verifier rather than silently moving it.
const EXPECTED = Object.freeze({
  schemaVersion: 3,
  m00Commit: "1887c77b39c42fb0b5d35b38baac94aff13465e9",
  runtimeBaselineCommit: "eb9742c318a76eeaf753e87a620fae83ca9048d1",
  deployedBaselineCommit: "049b6390fba7a7908d01908a7953dd2f50fa15df",
  sourceFiles: 66,
  sourceTreeHash: "ce9e04d11e314fa19d8d6409bc238d788ab5c9f0332f59612d9b486f34f56b63",
  distFiles: 65,
  distTreeHash: "baba971b54b84e97f4382f7dd532ddae3ec74ed80b5b9eec48eb1cbcacf7ea0e",
  entrypointHash: "2dc8f0dff8c8204c60e0487067263c92ef010415c877938f2b6e807144699d89",
  m01PackageHash: "bf56a67fb0a7f449929cec8eac5b44b1e2ca66065648202c5afeea39b61e679d",
  m01LockHash: "cbccc05104d11e0b082fa419253c517087a52f0bb3bc58f40e60515ecb02f22c",
  livePackageHash: "bf56a67fb0a7f449929cec8eac5b44b1e2ca66065648202c5afeea39b61e679d",
  deployedPackageHash: "bf56a67fb0a7f449929cec8eac5b44b1e2ca66065648202c5afeea39b61e679d",
  northStarHash: "7bdf3f9b1a2bc1ec7ab6c9983da1a8d2e723ca96a8fb5672d18893d57996fa9f",
  stage1RuntimeRecords: 272,
  canonicalDeployedFiles: 261,
});

const correctionPaths = new Set([
  "README.md",
  ".github/workflows/verify.yml",
  "packages/pi-chrono-compaction/DEPLOYED.sha256",
  "packages/pi-chrono-compaction/README.md",
  "packages/pi-chrono-compaction/package-lock.json",
  "packages/pi-chrono-compaction/package.json",
  "packages/pi-chrono-compaction/dist/src/compaction-worker-client.js",
  "packages/pi-chrono-compaction/dist/src/compaction-worker-entry.js",
  "packages/pi-chrono-compaction/dist/src/compaction-worker-protocol.js",
  "packages/pi-chrono-compaction/dist/src/host-worker-scheduler.js",
  "packages/pi-chrono-compaction/dist/src/pi-extension.js",
  "packages/pi-chrono-compaction/src/compaction-worker-client.ts",
  "packages/pi-chrono-compaction/src/compaction-worker-entry.ts",
  "packages/pi-chrono-compaction/src/compaction-worker-protocol.ts",
  "packages/pi-chrono-compaction/src/host-worker-scheduler.ts",
  "packages/pi-chrono-compaction/src/pi-extension.ts",
  "packages/pi-chrono-compaction/test/compaction-worker.test.ts",
  "packages/pi-chrono-compaction/test/extension.test.ts",
  "packages/pi-chrono-compaction/test/host-worker-scheduler.test.ts",
  "scripts/verify-chrono-v3-baseline.mjs",
  "scripts/verify-chrono-v3-privacy.mjs",
  "scripts/verify-deployed-baseline.mjs",
  "scripts/test/verify-chrono-v3-baseline.test.mjs",
  "scripts/test/verify-chrono-v3-privacy.test.mjs",
  "docs/chrono-v3/README.md",
  "docs/chrono-v3/amendments/A-0001-private-repository-containment.md",
  "docs/chrono-v3/amendments/A-0002-m00-baseline-provenance.md",
  "docs/chrono-v3/amendments/A-0003-m00-r1-corrections.md",
  "docs/chrono-v3/baseline.md",
  "docs/chrono-v3/baseline-evidence.json",
  "docs/chrono-v3/containment-timeline.md",
  "docs/chrono-v3/decisions.md",
  "docs/chrono-v3/evidence.md",
  "docs/chrono-v3/historical-test-inventory.md",
  "docs/chrono-v3/independent-review.md",
  "docs/chrono-v3/known-incidents.md",
  "docs/chrono-v3/milestone-ledger.md",
  "docs/chrono-v3/privacy-policy.md",
  "docs/chrono-v3/rollback.md",
  "docs/chrono-v3/test-recovery.md",
  "docs/chrono-v3/decision-and-update-protocol.md",
  "docs/chrono-v3/reviews/README.md",
  "docs/chrono-v3/reviews/M00-project-lead-review-1.md",
  "docs/chrono-v3/reviews/M00-project-lead-review-2.md",
  "docs/chrono-v3/reviews/M00-project-lead-acceptance.md",
]);

class BaselineVerificationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new BaselineVerificationError(code);
}

function bytesHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readRegularFile(path, missingCode = "unscanned-input") {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) fail("unsafe-file-type");
    return readFileSync(path);
  } catch (error) {
    if (error instanceof BaselineVerificationError) throw error;
    fail(missingCode);
  }
}

function fileHash(path) {
  return bytesHash(readRegularFile(path));
}

function isWithin(parent, path) {
  return path === parent || path.startsWith(`${parent}${sep}`);
}

function safeRelativePath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    fail("unsafe-relative-path");
  }
  return path;
}

function filesUnder(root) {
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    fail("missing-tree");
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("unsafe-tree");
  const output = [];
  function visit(directory) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      fail("unreadable-tree");
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        fail("unreadable-tree");
      }
      if (stat.isSymbolicLink()) fail("unsafe-tree");
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) output.push(relative(root, path).replaceAll("\\", "/"));
      else fail("unsupported-file-type");
    }
  }
  visit(root);
  return output.sort();
}

function treeHash(root, paths) {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    safeRelativePath(path);
    const absolute = resolve(root, path);
    if (!isWithin(resolve(root), absolute)) fail("unsafe-relative-path");
    hash.update(path).update("\0").update(readRegularFile(absolute)).update("\0");
  }
  return hash.digest("hex");
}

function gitBytes(args, code = "git-unavailable") {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: null,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    fail(code);
  }
}

function gitText(args, code = "git-unavailable") {
  return gitBytes(args, code).toString("utf8");
}

function gitLines(args, code = "git-unavailable") {
  return gitText(args, code).split("\n").filter(Boolean);
}

function gitNames(args, code = "git-unavailable") {
  return gitBytes(args, code).toString("utf8").split("\0").filter(Boolean).map(safeRelativePath);
}

function gitBytesAt(commit, path) {
  safeRelativePath(path);
  return gitBytes(["show", `${commit}:${path}`], "baseline-git-object-unavailable");
}

function readJson(path, code = "invalid-json") {
  try {
    return JSON.parse(readRegularFile(path, code).toString("utf8"));
  } catch (error) {
    if (error instanceof BaselineVerificationError) throw error;
    fail(code);
  }
}

function parseArgs() {
  const parsed = { allowMissingLive: false, allowDirty: false, staticOnly: false, live: undefined, repositoryRoot: defaultRepoRoot };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--allow-missing-live") parsed.allowMissingLive = true;
    else if (arg === "--allow-dirty") parsed.allowDirty = true;
    else if (arg === "--static-only") parsed.staticOnly = true;
    else if (arg === "--live" || arg === "--repository-root") {
      if (!args[index + 1] || args[index + 1].startsWith("--")) fail(arg === "--live" ? "invalid-live-option" : "invalid-repository-root-option");
      const value = args[++index];
      if (arg === "--live") {
        if (parsed.live !== undefined) fail("invalid-live-option");
        parsed.live = value;
      } else {
        if (parsed.repositoryRoot !== defaultRepoRoot) fail("invalid-repository-root-option");
        parsed.repositoryRoot = resolve(value);
      }
    } else {
      fail("invalid-invocation");
    }
  }
  return parsed;
}

function parseManifest(path) {
  const text = readRegularFile(path, "deployed-manifest-missing").toString("utf8");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (lines.length === 0 || lines.some((line) => line.length === 0)) fail("invalid-deployed-manifest");
  const entries = new Map();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([^\r\n]+)$/u.exec(line);
    if (!match) fail("invalid-deployed-manifest");
    const pathValue = safeRelativePath(match[2]);
    if (entries.has(pathValue)) fail("duplicate-deployed-manifest-path");
    const absolute = resolve(packageRoot, pathValue);
    if (!isWithin(resolve(packageRoot), absolute)) fail("unsafe-deployed-manifest-path");
    entries.set(pathValue, match[1]);
  }
  return entries;
}

function verifyCorrectionScope(allowDirty = false) {
  const ancestor = gitBytes(["merge-base", "--is-ancestor", EXPECTED.m00Commit, "HEAD"], "baseline-history-unavailable");
  void ancestor;
  const changed = new Set([
    ...gitNames(["diff", "--name-only", "-z", `${EXPECTED.m00Commit}..HEAD`, "--"]),
    ...(allowDirty ? [] : gitNames(["diff", "--name-only", "-z", "HEAD", "--"])),
    ...(allowDirty ? [] : gitNames(["diff", "--cached", "--name-only", "-z", "--"])),
    ...(allowDirty ? [] : gitNames(["ls-files", "--others", "--exclude-standard", "-z"])),
  ]);
  for (const path of changed) if (!correctionPaths.has(path)) fail("unexpected-correction-artifact");
}

function verifyNorthStar() {
  const path = join(repoRoot, "docs", "chrono-v3", "master-goal-and-work-plan.md");
  if (fileHash(path) !== EXPECTED.northStarHash) fail("north-star-changed");
}

function verifyPackageCorrection() {
  const currentPath = join(packageRoot, "package.json");
  if (fileHash(currentPath) !== EXPECTED.m01PackageHash) fail("chrono-package-metadata-changed");
  if (fileHash(join(packageRoot, "package-lock.json")) !== EXPECTED.m01LockHash) fail("chrono-package-lock-changed");
  return [];
}

function readJsonFromBytes(bytes) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("invalid-json");
  }
}

function validateRepositoryRoot(candidate) {
  try {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("invalid-repository-root");
    const resolved = realpathSync(candidate);
    const discovered = execFileSync("git", ["-C", resolved, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (realpathSync(discovered) !== resolved) fail("invalid-repository-root");
  } catch (error) {
    if (error instanceof BaselineVerificationError) throw error;
    fail("invalid-repository-root");
  }
  repoRoot = candidate;
  packageRoot = join(repoRoot, "packages", packageSlug);
}

function verifyWorkingTree(allowDirty) {
  let status;
  try {
    status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all", "-z"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    fail("git-status-unavailable");
  }
  const entries = status.split("\0").filter(Boolean);
  if (entries.length > 0 && !allowDirty) fail("dirty-repository");
  const trackedModes = gitBytes(["ls-files", "-s", "-z"], "git-status-unavailable").toString("utf8");
  if (/\b120000\b/u.test(trackedModes) && !allowDirty) fail("unsafe-repository-symlink");
  return { clean: entries.length === 0, allowDirtyUsed: Boolean(allowDirty) };
}

function verifyRepositoryFiles() {
  if (!existsSync(packageRoot)) fail("repository-package-missing");
  const sourcePaths = filesUnder(join(packageRoot, "src")).map((path) => safeRelativePath(`src/${path}`));
  if (sourcePaths.length !== EXPECTED.sourceFiles) fail("source-file-count-changed");
  const sourceTreeHash = treeHash(packageRoot, sourcePaths);
  if (sourceTreeHash !== EXPECTED.sourceTreeHash) fail("source-baseline-mismatch");
  const distFilePaths = filesUnder(join(packageRoot, "dist")).map(safeRelativePath);
  if (distFilePaths.length !== EXPECTED.distFiles) fail("dist-file-count-changed");
  const distPaths = distFilePaths.map((path) => `dist/${path}`);
  const distTreeHash = treeHash(join(packageRoot, "dist"), distFilePaths);
  if (distTreeHash !== EXPECTED.distTreeHash) fail("dist-baseline-mismatch");
  const entrypointHash = fileHash(join(packageRoot, entrypointRelative));
  if (entrypointHash !== EXPECTED.entrypointHash) fail("entrypoint-baseline-mismatch");
  const metadataExceptions = verifyPackageCorrection();
  const manifest = parseManifest(join(packageRoot, "DEPLOYED.sha256"));
  const expectedManifestPaths = new Set(["package.json", ...distPaths]);
  if (!jsonEqual([...manifest.keys()].sort(), [...expectedManifestPaths].sort())) fail("deployed-manifest-scope-changed");
  if (manifest.get("package.json") !== EXPECTED.deployedPackageHash) fail("deployed-metadata-record-changed");
  for (const path of distPaths) {
    if (fileHash(join(packageRoot, path)) !== manifest.get(path)) fail("deployed-runtime-mismatch");
  }
  if (fileHash(join(packageRoot, "package.json")) !== manifest.get("package.json")) fail("deployed-metadata-record-changed");
  const packageJson = readJson(join(packageRoot, "package.json"));
  if (packageJson.version !== "2.0.1") fail("package-version-changed");
  const rootPackage = readJson(join(repoRoot, "package.json"));
  if (rootPackage.piConsolidation?.stage1RuntimeRecords !== EXPECTED.stage1RuntimeRecords) fail("stage1-record-count-changed");
  if (rootPackage.piConsolidation?.canonicalDeployedFiles !== EXPECTED.canonicalDeployedFiles) fail("canonical-deployed-count-changed");
  if (rootPackage.piConsolidation?.deployedBaselineCommit !== EXPECTED.deployedBaselineCommit) fail("deployed-baseline-commit-changed");
  return { sourcePaths, distPaths, distFilePaths, sourceTreeHash, distTreeHash, entrypointHash, manifest, metadataExceptions };
}

function statusSummary(workingTree) {
  const changed = new Set([
    ...gitNames(["diff", "--name-only", "-z", "HEAD", "--"]),
    ...gitNames(["diff", "--cached", "--name-only", "-z", "--"]),
    ...gitNames(["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return { ...workingTree, clean: changed.size === 0, changedFileCount: changed.size };
}

function verifyLive(liveRoot, repository) {
  let liveResolved;
  try {
    const stat = lstatSync(liveRoot);
    if (!stat.isDirectory() && !stat.isSymbolicLink()) fail("live-package-not-directory");
    liveResolved = realpathSync(liveRoot);
  } catch (error) {
    if (error instanceof BaselineVerificationError) throw error;
    fail("live-package-missing");
  }
  const livePackage = join(liveResolved, "package.json");
  if (fileHash(livePackage) !== EXPECTED.livePackageHash) fail("live-metadata-mismatch");
  const liveSourcePaths = filesUnder(join(liveResolved, "src")).map((path) => `src/${safeRelativePath(path)}`);
  if (!jsonEqual(liveSourcePaths, repository.sourcePaths.sort())) fail("live-runtime-files-missing");
  const liveDistFilePaths = filesUnder(join(liveResolved, "dist")).map(safeRelativePath);
  const liveDistPaths = liveDistFilePaths.map((path) => `dist/${path}`);
  if (!jsonEqual(liveDistPaths, repository.distPaths.sort())) fail("live-runtime-files-missing");
  const liveSourceHash = treeHash(liveResolved, repository.sourcePaths);
  const liveDistHash = treeHash(join(liveResolved, "dist"), liveDistFilePaths);
  const liveEntrypointHash = fileHash(join(liveResolved, entrypointRelative));
  if (liveSourceHash !== EXPECTED.sourceTreeHash || liveDistHash !== EXPECTED.distTreeHash || liveEntrypointHash !== EXPECTED.entrypointHash) fail("live-runtime-mismatch");
  return {
    state: "present",
    sourceFiles: liveSourcePaths.length,
    sourceTreeHash: liveSourceHash,
    distFiles: liveDistFilePaths.length,
    distTreeHash: liveDistHash,
    entrypointHash: liveEntrypointHash,
    packageHash: EXPECTED.livePackageHash,
    sourceMatch: true,
    distMatch: true,
    entrypointMatch: true,
  };
}

function verify() {
  const options = parseArgs();
  validateRepositoryRoot(options.repositoryRoot);
  const workingTree = verifyWorkingTree(options.allowDirty);
  verifyCorrectionScope(options.allowDirty);
  verifyNorthStar();
  const repository = verifyRepositoryFiles();
  const repositoryOutput = {
    commit: gitLines(["rev-parse", "HEAD"])[0],
    sourceFiles: repository.sourcePaths.length,
    sourceTreeHash: repository.sourceTreeHash,
    distFiles: repository.distPaths.length,
    distTreeHash: repository.distTreeHash,
    entrypointHash: repository.entrypointHash,
    packageVersion: readJson(join(packageRoot, "package.json")).version,
    workingTree: statusSummary(workingTree),
    runtimeMismatches: [],
    metadataExceptions: repository.metadataExceptions,
    deployedManifest: { runtimeMismatches: [], metadataExceptions: repository.metadataExceptions },
  };
  if (options.staticOnly) return { schemaVersion: EXPECTED.schemaVersion, status: "ok", repository: repositoryOutput, live: { state: "not-checked" } };
  const configuredLiveRoot = options.live ?? join(homedir(), ".pi", "agent", "packages", packageSlug);
  let liveExists = false;
  try {
    liveExists = existsSync(configuredLiveRoot);
  } catch {
    fail("live-package-missing");
  }
  if (!liveExists) {
    if (!options.allowMissingLive) fail("live-package-missing");
    return { schemaVersion: EXPECTED.schemaVersion, status: "ok", repository: repositoryOutput, live: { state: "missing-allowed" } };
  }
  return { schemaVersion: EXPECTED.schemaVersion, status: "ok", repository: repositoryOutput, live: verifyLive(configuredLiveRoot, repository) };
}

try {
  console.log(JSON.stringify(verify(), null, 2));
} catch (error) {
  const code = error instanceof BaselineVerificationError ? error.code : "unscanned-input";
  console.error(JSON.stringify({ schemaVersion: EXPECTED.schemaVersion, status: "failed", code }));
  process.exitCode = 1;
}
