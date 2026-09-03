#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repoRoot, "packages", "pi-chrono-compaction");
const args = process.argv.slice(2);
const allowMissingLive = args.includes("--allow-missing-live");
const liveOption = args.indexOf("--live");
if (liveOption >= 0 && !args[liveOption + 1]) fail("invalid-live-option");
const configuredLiveRoot = liveOption >= 0 ? args[liveOption + 1] : undefined;
const liveRoot = configuredLiveRoot ?? join(homedir(), ".pi", "agent", "packages", "pi-chrono-compaction");

function fail(code) {
  console.error(JSON.stringify({ schemaVersion: 1, status: "failed", code }));
  process.exitCode = 1;
  throw new Error(code);
}
function bytesHash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function fileHash(path) { return bytesHash(readFileSync(path)); }
function filesUnder(root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const output = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) output.push(relative(root, path).replaceAll("\\", "/"));
      else if (entry.isSymbolicLink()) fail("unexpected-symlink-in-tree");
    }
  }
  visit(root);
  return output;
}
function treeHash(root, paths = filesUnder(root)) {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    hash.update(path).update("\0").update(readFileSync(join(root, path))).update("\0");
  }
  return hash.digest("hex");
}
function gitLines(...args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim().split("\n").filter(Boolean);
}
function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function manifestEntries(path) {
  return readFileSync(path, "utf8").trimEnd().split("\n").map((line) => {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) fail("invalid-deployed-manifest");
    return { hash: match[1], path: match[2] };
  });
}
function compareManifest() {
  const metadataNames = new Set(["package.json", "package-lock.json"]);
  const metadataMismatches = [];
  const runtimeMismatches = [];
  for (const entry of manifestEntries(join(packageRoot, "DEPLOYED.sha256"))) {
    const path = join(packageRoot, entry.path);
    if (!existsSync(path) || !statSync(path).isFile()) {
      runtimeMismatches.push(entry.path);
      continue;
    }
    if (fileHash(path) !== entry.hash) {
      (metadataNames.has(entry.path) ? metadataMismatches : runtimeMismatches).push(entry.path);
    }
  }
  return { metadataMismatches, runtimeMismatches };
}
function statusSummary() {
  const lines = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repoRoot, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  return { clean: lines.length === 0, changedFileCount: lines.length };
}

if (!existsSync(packageRoot)) fail("repository-package-missing");
const sourcePaths = gitLines("ls-files", "packages/pi-chrono-compaction/src").map((path) => path.slice("packages/pi-chrono-compaction/".length));
if (sourcePaths.length === 0) fail("repository-source-missing");
const repoSourceHash = treeHash(packageRoot, sourcePaths);
const repoDistPaths = filesUnder(join(packageRoot, "dist"));
if (repoDistPaths.length === 0) fail("repository-dist-missing");
const repoDistHash = treeHash(join(packageRoot, "dist"), repoDistPaths);
const entrypointRelative = "dist/src/pi-extension.js";
const repoEntrypointHash = fileHash(join(packageRoot, entrypointRelative));
const manifest = compareManifest();
const repository = {
  commit: gitLines("rev-parse", "HEAD")[0],
  sourceFiles: sourcePaths.length,
  sourceTreeHash: repoSourceHash,
  distFiles: repoDistPaths.length,
  distTreeHash: repoDistHash,
  entrypointHash: repoEntrypointHash,
  packageVersion: readJson(join(packageRoot, "package.json")).version,
  workingTree: statusSummary(),
  deployedManifest: {
    runtimeMismatches: manifest.runtimeMismatches,
    metadataMismatches: manifest.metadataMismatches,
  },
};

const liveExists = existsSync(liveRoot);
if (!liveExists) {
  if (!allowMissingLive) fail("live-package-missing");
  console.log(JSON.stringify({ schemaVersion: 1, status: "ok", live: { state: "missing-allowed" }, repository }, null, 2));
  process.exit(0);
}
if (!lstatSync(liveRoot).isDirectory() && !lstatSync(liveRoot).isSymbolicLink()) fail("live-package-not-directory");
const liveResolved = resolve(liveRoot);
if (!existsSync(join(liveResolved, "package.json"))) fail("live-manifest-missing");
const liveSourcePaths = sourcePaths;
const liveSourceMissing = liveSourcePaths.filter((path) => !existsSync(join(liveResolved, path)));
const liveSourceHash = liveSourceMissing.length === 0 ? treeHash(liveResolved, liveSourcePaths) : undefined;
const liveDistPaths = filesUnder(join(liveResolved, "dist"));
const liveDistHash = liveDistPaths.length > 0 ? treeHash(join(liveResolved, "dist"), liveDistPaths) : undefined;
const liveEntrypoint = join(liveResolved, entrypointRelative);
const liveEntrypointHash = existsSync(liveEntrypoint) ? fileHash(liveEntrypoint) : undefined;
const live = {
  state: "present",
  sourceFiles: liveSourceMissing.length === 0 ? liveSourcePaths.length : liveSourcePaths.length - liveSourceMissing.length,
  sourceTreeHash: liveSourceHash ?? null,
  distFiles: liveDistPaths.length,
  distTreeHash: liveDistHash ?? null,
  entrypointHash: liveEntrypointHash ?? null,
  packageVersion: readJson(join(liveResolved, "package.json")).version,
  sourceMatch: liveSourceHash === repoSourceHash,
  distMatch: liveDistHash === repoDistHash && liveDistPaths.length === repoDistPaths.length,
  entrypointMatch: liveEntrypointHash === repoEntrypointHash,
};
if (liveSourceMissing.length > 0 || live.distFiles === 0) fail("live-runtime-files-missing");
if (!live.sourceMatch || !live.distMatch || !live.entrypointMatch) fail("live-runtime-mismatch");
console.log(JSON.stringify({ schemaVersion: 1, status: "ok", repository, live }, null, 2));
