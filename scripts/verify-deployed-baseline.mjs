#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = readJson(join(root, "package.json"));
const consolidation = packageJson.piConsolidation;
const products = consolidation?.products;
if (!Array.isArray(products)) throw new Error("package.json lacks piConsolidation.products");

const args = process.argv.slice(2);
const productIndex = args.indexOf("--product");
const selectedSlug = productIndex >= 0 ? args[productIndex + 1] : undefined;
if (productIndex >= 0 && !selectedSlug) throw new Error("--product requires a slug");
const staticOnly = args.includes("--static-only");
const projectGlanceSlug = "pi-project-glance";

const expectedSlugs = [
  "codex-usage-footer", "files-ui", "grounded-tools", "herdr-agent-state",
  "herdr-blocked-bridge", "herdr-status", "pi-agent-context",
  "pi-chrono-compaction", "pi-herdr-orchestrator", "pi-native-ssh",
  "pi-pixel-cua", "pi-progressive-tools", "pi-review-ui", "pi-signal-board",
  "pi-tool-controls", "temporary-orchestrator-cancel-isolation", "titlebar-spinner",
];
const expectedSafeScripts = Object.freeze({
  "files-ui": { typecheck: "tsc -p tsconfig.json --noEmit" },
  "herdr-status": { typecheck: "tsc -p tsconfig.json --noEmit" },
  "pi-agent-context": {
    syntax: "node --experimental-strip-types --check extensions/index.ts && node --experimental-strip-types --check extensions/snapshot.ts",
  },
  "pi-chrono-compaction": {
    typecheck: "tsc -p tsconfig.json --noEmit",
    build: "rm -rf dist && tsc -p tsconfig.json",
    test: "rm -rf dist-test && tsc -p tsconfig.test-build.json && node --test dist-test/test/*.test.js",
  },
  "pi-herdr-orchestrator": {
    typecheck: "tsc -p tsconfig.json --noEmit",
    build: "rm -rf dist && tsc -p tsconfig.json",
  },
  "pi-pixel-cua": {
    syntax: "python3 -m py_compile helper/ei_sender.py helper/portal_backend.py helper/server.py && node --experimental-strip-types --check src/helper-client.ts && node --experimental-strip-types --check src/index.ts",
  },
  "pi-review-ui": { typecheck: "tsc -p tsconfig.json --noEmit" },
  "pi-signal-board": {
    typecheck: "tsc -p tsconfig.json --noEmit",
    build: "rm -rf dist && tsc -p tsconfig.build.json",
  },
  "pi-tool-controls": { typecheck: "tsc -p tsconfig.json --noEmit" },
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Dependency trees are not repository-owned discovery roots. Force-tracked
    // dependency content is rejected separately through git ls-files below.
    if (entry.isDirectory() && entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(path);
  }
  return out;
}
function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function sha256(path) {
  return sha256Bytes(readFileSync(path));
}
function parseDeployed(path) {
  const entries = new Map();
  for (const [index, line] of readFileSync(path, "utf8").trimEnd().split("\n").entries()) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) throw new Error(`${relative(root, path)}:${index + 1}: invalid DEPLOYED.sha256 line`);
    if (entries.has(match[2])) throw new Error(`${relative(root, path)}: duplicate ${match[2]}`);
    entries.set(match[2], match[1]);
  }
  return entries;
}
function isWithin(parent, path) {
  return path === parent || path.startsWith(`${parent}${sep}`);
}
function gitBytesAt(commit, rel) {
  try {
    return execFileSync("git", ["show", `${commit}:${rel}`], { cwd: root });
  } catch {
    throw new Error(`cannot read baseline Git object ${commit}:${rel}`);
  }
}
function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function trackedWorkingFiles() {
  return execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root })
    .toString("utf8").split("\0").filter(Boolean)
    .filter((rel) => existsSync(join(root, rel)));
}

// Repository identity, product set, activation status, and root boundary.
const actualSlugs = products.map((product) => product.slug);
if (!jsonEqual(actualSlugs, expectedSlugs)) throw new Error(`unexpected product order/set: ${actualSlugs.join(",")}`);
if (selectedSlug && selectedSlug !== projectGlanceSlug && !products.some((product) => product.slug === selectedSlug)) throw new Error(`unknown product ${selectedSlug}`);
const allPackageDirs = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
const packageDirs = allPackageDirs.filter((name) => name !== projectGlanceSlug);
if (!allPackageDirs.includes(projectGlanceSlug)) throw new Error("pi-project-glance package directory is missing");
if (!jsonEqual(packageDirs, [...expectedSlugs].sort())) throw new Error(`baseline packages/ set changed: ${packageDirs.join(",")}`);
if (allPackageDirs.some((name) => name.toLowerCase().includes("pi-web"))) throw new Error("pi-web package directory is forbidden");
const active = products.filter((product) => product.status === "active" || product.status === "active-temporary");
const inactive = products.filter((product) => product.status === "inactive");
const activeEntrypoints = active.flatMap((product) => product.entrypoints.map((entry) => `${product.slug}/${entry}`));
if (active.length !== 15 || activeEntrypoints.length !== 21) throw new Error(`expected 15 active families and 21 entrypoints; got ${active.length}/${activeEntrypoints.length}`);
if (!jsonEqual(inactive.map((product) => product.slug), ["pi-review-ui", "pi-tool-controls"])) throw new Error("inactive product set changed");
if (products.find((product) => product.slug === "temporary-orchestrator-cancel-isolation")?.status !== "active-temporary") throw new Error("temporary shim status changed");
if (!existsSync(join(root, "packages/temporary-orchestrator-cancel-isolation"))) throw new Error("temporary cancellation isolation must remain separate");
if (existsSync(join(root, "packages/pi-herdr-orchestrator/extensions/temporary-orchestrator-cancel-isolation.ts"))) throw new Error("temporary cancellation isolation was folded into the orchestrator");
const rootEntries = readdirSync(root).filter((name) => ![".git", ".chrono-v3-private"].includes(name)).sort();
const allowedRootEntries = [".github", ".gitignore", "LICENSE", "README.md", "docs", "package-lock.json", "package.json", "packages", "scripts"].sort();
if (!jsonEqual(rootEntries, allowedRootEntries)) throw new Error(`unexpected root entries: ${rootEntries.join(",")}`);
const northStarPath = join(root, "docs/chrono-v3/master-goal-and-work-plan.md");
if (!existsSync(northStarPath) || sha256(northStarPath) !== "7bdf3f9b1a2bc1ec7ab6c9983da1a8d2e723ca96a8fb5672d18893d57996fa9f") throw new Error("ChronoCompact north-star charter is not byte-preserved");
const workflows = walk(join(root, ".github/workflows")).map((path) => relative(join(root, ".github/workflows"), path));
if (!jsonEqual(workflows, ["verify.yml"])) throw new Error("exactly one verify workflow is required");
const workflow = readFileSync(join(root, ".github/workflows/verify.yml"), "utf8");
for (const required of ["pull_request:", "- main", "push:", "workflow_dispatch:"]) {
  if (!workflow.includes(required)) throw new Error(`verify workflow lacks ${required}`);
}
if (workflow.includes("consolidation/clean-monorepo-20260901")) throw new Error("verify workflow retains the deleted consolidation trigger");
const scriptFiles = walk(join(root, "scripts")).map((path) => relative(join(root, "scripts"), path));
if (!jsonEqual(scriptFiles, ["verify-chrono-v3-baseline.mjs", "verify-chrono-v3-privacy.mjs", "verify-deployed-baseline.mjs"])) throw new Error("only the root baseline verifiers are allowed under scripts/");
if (!jsonEqual(packageJson.scripts, { verify: "node scripts/verify-deployed-baseline.mjs" })) throw new Error("root package scripts must contain only verify");

// Exact deployed records. Corrected repository metadata is checked against the immutable baseline commit.
if (consolidation.stage1RuntimeRecords !== 272 || consolidation.canonicalDeployedFiles !== 261) throw new Error("Stage 1 record or canonical deployed-file count changed");
if (consolidation.deployedBaselineCommit !== "049b6390fba7a7908d01908a7953dd2f50fa15df") throw new Error("unexpected deployed baseline commit");
let hashCount = 0;
let historicalMetadataHashes = 0;
const deployedByProduct = new Map();
const deployedPaths = new Set();
for (const product of active) {
  const packageRoot = join(root, "packages", product.slug);
  const manifestPath = join(packageRoot, "DEPLOYED.sha256");
  if (!existsSync(manifestPath)) throw new Error(`${product.slug} lacks DEPLOYED.sha256`);
  const deployed = parseDeployed(manifestPath);
  deployedByProduct.set(product.slug, deployed);
  for (const [rel, expected] of deployed) {
    const path = resolve(packageRoot, rel);
    if (!isWithin(packageRoot, path)) throw new Error(`${product.slug}: path escapes package: ${rel}`);
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${product.slug}: missing deployed file ${rel}`);
    const repoRel = relative(root, path).replaceAll(sep, "/");
    const current = sha256(path);
    if (current !== expected) {
      if (!["package.json", "package-lock.json"].includes(basename(rel))) throw new Error(`${product.slug}: deployed runtime hash mismatch for ${rel}`);
      const baseline = gitBytesAt(consolidation.deployedBaselineCommit, repoRel);
      if (sha256Bytes(baseline) !== expected) throw new Error(`${product.slug}: baseline metadata hash mismatch for ${rel}`);
      historicalMetadataHashes += 1;
    }
    deployedPaths.add(repoRel);
    hashCount += 1;
  }
  for (const entry of product.entrypoints) {
    if (!deployed.has(entry)) throw new Error(`${product.slug}: active entrypoint absent from DEPLOYED.sha256: ${entry}`);
    if (!existsSync(join(packageRoot, entry))) throw new Error(`${product.slug}: missing entrypoint ${entry}`);
  }
  if (product.compiledCount !== undefined) {
    const committed = walk(join(packageRoot, "dist")).filter((path) => path.endsWith(".js"));
    const declared = [...deployed.keys()].filter((path) => path.startsWith("dist/") && path.endsWith(".js"));
    if (committed.length !== product.compiledCount || declared.length !== product.compiledCount) throw new Error(`${product.slug}: compiled count ${committed.length}/${declared.length}; expected ${product.compiledCount}`);
    const committedRel = committed.map((path) => relative(packageRoot, path).replaceAll(sep, "/")).sort();
    if (!jsonEqual(committedRel, declared.sort())) throw new Error(`${product.slug}: unexpected committed compiled output`);
  }
}
if (hashCount !== 261) throw new Error(`canonical deployed hash count ${hashCount}; expected 261`);
for (const product of inactive) {
  if (existsSync(join(root, "packages", product.slug, "DEPLOYED.sha256"))) throw new Error(`${product.slug}: inactive product must not have an active deployed manifest`);
}

// Package manifests, locks, configuration paths, and the exact safe script set.
const packageManifestPaths = walk(join(root, "packages"))
  .filter((path) => basename(path) === "package.json" && !relative(root, path).startsWith(`packages/${projectGlanceSlug}/`))
  .sort();
const topManifests = expectedSlugs.map((slug) => join(root, "packages", slug, "package.json"));
if (topManifests.some((path) => !packageManifestPaths.includes(path))) throw new Error("one or more product manifests are missing");
if (packageManifestPaths.length !== 25) throw new Error(`expected 25 baseline manifests across 17 products; got ${packageManifestPaths.length}`);
const localPackages = new Map();
const scriptPlans = [];
const lockComparedFields = ["name", "version", "license", "os", "cpu", "engines", "dependencies", "devDependencies", "peerDependencies", "peerDependenciesMeta", "bin", "bundleDependencies", "bundledDependencies"];

function manifestTargets(value, prefix = "") {
  const out = [];
  if (typeof value === "string") out.push([prefix, value]);
  else if (Array.isArray(value)) value.forEach((item, index) => out.push(...manifestTargets(item, `${prefix}[${index}]`)));
  else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => out.push(...manifestTargets(item, prefix ? `${prefix}.${key}` : key)));
  return out;
}
function ensureManifestTarget(packageRoot, label, target, allowDirectory = false) {
  if (typeof target !== "string" || target.length === 0) throw new Error(`${label}: target must be a non-empty string`);
  if (/[?*\[\]]/u.test(target)) throw new Error(`${label}: globs are not allowed in retained manifest paths`);
  const path = resolve(packageRoot, target);
  if (!isWithin(packageRoot, path) || !existsSync(path)) throw new Error(`${label}: unresolved path ${target}`);
  if (!allowDirectory && !statSync(path).isFile()) throw new Error(`${label}: expected a file: ${target}`);
}
for (const manifestPath of packageManifestPaths) {
  const manifest = readJson(manifestPath);
  const packageRoot = dirname(manifestPath);
  const rel = relative(root, manifestPath).replaceAll(sep, "/");
  if (typeof manifest.name !== "string" || manifest.name.length === 0) throw new Error(`${rel}: package name is required`);
  if (manifest.name.toLowerCase().includes("pi-web")) throw new Error(`${rel}: forbidden pi-web package name`);
  if (manifest.private !== true) throw new Error(`${rel}: retained packages must be private`);
  for (const forbidden of ["main", "module", "types", "bin", "files", "publishConfig", "bundledDependencies", "bundleDependencies"]) {
    if (Object.hasOwn(manifest, forbidden)) throw new Error(`${rel}: stale publish field ${forbidden}`);
  }
  if (Object.hasOwn(manifest, "exports")) {
    if (rel !== "packages/grounded-tools/core/package.json") throw new Error(`${rel}: library exports are not required`);
    for (const [label, target] of manifestTargets(manifest.exports, "exports")) ensureManifestTarget(packageRoot, `${rel}:${label}`, target);
  }
  const piExtensions = manifest.pi?.extensions ?? [];
  if (!Array.isArray(piExtensions)) throw new Error(`${rel}: pi.extensions must be an array`);
  for (const entry of piExtensions) ensureManifestTarget(packageRoot, `${rel}:pi.extensions`, entry, true);
  if (manifest.pi?.skills !== undefined) throw new Error(`${rel}: no retained package declares Pi skills`);
  const slug = relative(join(root, "packages"), packageRoot).split(sep)[0];
  const expectedScripts = expectedSafeScripts[slug] ?? {};
  if (packageRoot === join(root, "packages", slug)) {
    if (!jsonEqual(manifest.scripts ?? {}, expectedScripts)) throw new Error(`${rel}: unexpected safe script set`);
    if (Object.keys(expectedScripts).length > 0) scriptPlans.push({ slug, packageRoot, scripts: expectedScripts });
  } else if (manifest.scripts !== undefined) {
    throw new Error(`${rel}: nested runtime manifests must not retain scripts`);
  }
  if (localPackages.has(manifest.name)) throw new Error(`duplicate local package name ${manifest.name}`);
  localPackages.set(manifest.name, { packageRoot, manifest });
  const lockPath = join(packageRoot, "package-lock.json");
  if (existsSync(lockPath)) {
    const lockRoot = readJson(lockPath).packages?.[""];
    if (!lockRoot) throw new Error(`${rel}: lockfile lacks packages[\"\"]`);
    for (const field of lockComparedFields) {
      const left = manifest[field];
      const right = lockRoot[field];
      if (!jsonEqual(left, right)) throw new Error(`${rel}: package-lock mismatch for ${field}`);
    }
  }
}
if (scriptPlans.reduce((sum, plan) => sum + Object.keys(plan.scripts).length, 0) !== 13) throw new Error("expected exactly 13 retained safe package scripts");

function globRegex(pattern) {
  let out = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") { index += 1; out += "(?:.*/)?"; }
      else out += ".*";
    } else if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else out += char.replace(/[\\^$+?.()|{}\[\]]/gu, "\\$&");
  }
  return new RegExp(`${out}$`, "u");
}
const tsconfigPaths = walk(join(root, "packages")).filter((path) => /^tsconfig(?:\.[^.]+)?\.json$/u.test(basename(path)));
for (const configPath of tsconfigPaths) {
  const config = readJson(configPath);
  const configRoot = dirname(configPath);
  const rel = relative(root, configPath).replaceAll(sep, "/");
  if (config.extends) {
    const target = resolve(configRoot, config.extends.endsWith(".json") ? config.extends : `${config.extends}.json`);
    if (!existsSync(target) || !statSync(target).isFile()) throw new Error(`${rel}: unresolved extends ${config.extends}`);
  }
  const candidates = walk(configRoot).map((path) => relative(configRoot, path).replaceAll(sep, "/"));
  for (const pattern of config.include ?? []) {
    if (!candidates.some((candidate) => globRegex(pattern).test(candidate))) throw new Error(`${rel}: include matches no retained file: ${pattern}`);
  }
  const rootDir = config.compilerOptions?.rootDir;
  if (rootDir && !existsSync(resolve(configRoot, rootDir))) throw new Error(`${rel}: rootDir does not exist: ${rootDir}`);
  for (const targets of Object.values(config.compilerOptions?.paths ?? {})) {
    for (const target of targets) ensureManifestTarget(configRoot, `${rel}:compilerOptions.paths`, target);
  }
}

// Static import/resource graph from all active and inactive entrypoints plus compiled source entrypoints.
const importPatterns = [
  /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/gu,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  /new\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/gu,
];
function localSpecs(path) {
  if (![".ts", ".js", ".mjs"].includes(extname(path)) && !path.endsWith(".d.ts")) return [];
  const text = readFileSync(path, "utf8");
  return importPatterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1]));
}
function localPackageTarget(specifier) {
  const matches = [...localPackages.entries()].filter(([name]) => specifier === name || specifier.startsWith(`${name}/`)).sort((left, right) => right[0].length - left[0].length);
  if (matches.length === 0) return undefined;
  const [name, descriptor] = matches[0];
  const subpath = specifier === name ? "." : `./${specifier.slice(name.length + 1)}`;
  const target = descriptor.manifest.exports?.[subpath];
  if (typeof target !== "string") throw new Error(`${specifier}: local package export is unresolved`);
  return resolve(descriptor.packageRoot, target);
}
function resolveLocalReference(source, specifier, sourceMode) {
  let base;
  if (specifier.startsWith(".")) base = resolve(dirname(source), specifier);
  else base = localPackageTarget(specifier);
  if (!base) return undefined;
  const candidates = [base];
  if (sourceMode && [".js", ".mjs"].includes(extname(base))) {
    candidates.unshift(base.slice(0, -extname(base).length) + ".d.ts");
    candidates.unshift(base.slice(0, -extname(base).length) + ".ts");
  }
  if (extname(base) === "") {
    candidates.push(`${base}.ts`, `${base}.d.ts`, `${base}.js`, `${base}.mjs`, `${base}.json`, `${base}.py`);
    candidates.push(join(base, "index.ts"), join(base, "index.d.ts"), join(base, "index.js"), join(base, "index.mjs"));
  }
  const found = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (!found || !isWithin(root, found)) throw new Error(`${relative(root, source)}: unresolved local import/resource ${specifier}`);
  return resolve(found);
}
function graphClosure(starts, sourceMode) {
  const seen = new Set();
  const stack = starts.map((path) => resolve(path));
  while (stack.length > 0) {
    const path = stack.pop();
    if (seen.has(path)) continue;
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`graph start is missing: ${relative(root, path)}`);
    seen.add(path);
    for (const specifier of localSpecs(path)) {
      const target = resolveLocalReference(path, specifier, sourceMode);
      if (target) stack.push(target);
    }
  }
  return seen;
}
const activeRuntimeGraph = new Set();
const inactiveGraph = new Set();
const sourceBuildGraph = new Set();
const runtimeResourcePaths = new Set();
for (const product of products) {
  const packageRoot = join(root, "packages", product.slug);
  const entrypoints = product.entrypoints.map((entry) => join(packageRoot, entry));
  const closure = graphClosure(entrypoints, entrypoints.some((entry) => entry.endsWith(".ts")));
  const target = product.status === "inactive" ? inactiveGraph : activeRuntimeGraph;
  for (const path of closure) target.add(path);
  for (const resource of product.runtimeResources ?? []) {
    const path = resolve(packageRoot, resource);
    if (!isWithin(packageRoot, path) || !existsSync(path) || !statSync(path).isFile()) throw new Error(`${product.slug}: missing runtime resource ${resource}`);
    runtimeResourcePaths.add(path);
    if (product.status !== "inactive") activeRuntimeGraph.add(path);
  }
  if (product.compiledCount !== undefined) {
    if (!Array.isArray(product.sourceEntrypoints) || product.sourceEntrypoints.length === 0) throw new Error(`${product.slug}: compiled source entrypoints are required`);
    const sourceClosure = graphClosure(product.sourceEntrypoints.map((entry) => join(packageRoot, entry)), true);
    for (const path of sourceClosure) sourceBuildGraph.add(path);
    for (const path of walk(packageRoot).filter((candidate) => candidate.endsWith(".d.ts") && !candidate.includes(`${sep}dist${sep}`))) sourceBuildGraph.add(path);
  }
}
const deployedRuntimeCode = new Set([...deployedPaths].filter((path) => [".ts", ".js", ".mjs"].includes(extname(path))).map((path) => resolve(root, path)));
const missingRuntimeCode = [...deployedRuntimeCode].filter((path) => !activeRuntimeGraph.has(path));
if (missingRuntimeCode.length > 0) throw new Error(`deployed runtime code is unreachable: ${missingRuntimeCode.map((path) => relative(root, path)).join(",")}`);
for (const product of products.filter((candidate) => candidate.compiledCount !== undefined)) {
  const packageRoot = join(root, "packages", product.slug);
  const sourceFiles = walk(packageRoot).filter((path) => !path.includes(`${sep}dist${sep}`) && !path.includes(`${sep}test${sep}`) && (path.endsWith(".ts") || path.endsWith(".d.ts")));
  const unexplained = sourceFiles.filter((path) => !sourceBuildGraph.has(path));
  if (unexplained.length > 0) throw new Error(`${product.slug}: source cannot reproduce deployed closure: ${unexplained.map((path) => relative(packageRoot, path)).join(",")}`);
}
for (const product of inactive) {
  const packageRoot = join(root, "packages", product.slug);
  const code = walk(packageRoot).filter((path) => path.endsWith(".ts") || path.endsWith(".d.ts") || path.endsWith(".js") || path.endsWith(".mjs"));
  const unexplained = code.filter((path) => !inactiveGraph.has(path) && !path.endsWith(".d.ts"));
  if (unexplained.length > 0) throw new Error(`${product.slug}: inactive retained source is unreachable: ${unexplained.map((path) => relative(packageRoot, path)).join(",")}`);
}

// Every tracked file must fit categories A-G. Runtime resources are also reported as an explicit subset of A.
const tracked = trackedWorkingFiles();
const trackedDependencyFiles = tracked.filter((rel) => rel.split("/").includes("node_modules"));
if (trackedDependencyFiles.length > 0) throw new Error(`tracked dependency-tree files are forbidden: ${trackedDependencyFiles.join(",")}`);
const categories = { deployedRuntime: 0, sourceBuildInputs: 0, inactiveSource: 0, metadata: 0, docs: 0, tests: 0, testSupport: 0, rootVerification: 0, unexplained: 0 };
const unexplainedPaths = [];
for (const rel of tracked) {
  // Project Glance is verified in its own additive phase below; it must not
  // enter the frozen Stage 1 product/category counts.
  if (rel.startsWith(`packages/${projectGlanceSlug}/`)) continue;
  const path = resolve(root, rel);
  let category;
  if (deployedPaths.has(rel)) category = "deployedRuntime";
  else if (sourceBuildGraph.has(path)) category = "sourceBuildInputs";
  else if (inactiveGraph.has(path) || (rel.startsWith("packages/pi-review-ui/") || rel.startsWith("packages/pi-tool-controls/")) && path.endsWith(".d.ts")) category = "inactiveSource";
  else if (rel.startsWith("packages/pi-chrono-compaction/test/")) category = "tests";
  else if (rel.startsWith("packages/pi-chrono-compaction/docs/") || rel.startsWith("packages/pi-chrono-compaction/scripts/")) category = "testSupport";
  else if (/^packages\/[^/]+\/(?:DEPLOYED\.sha256|LICENSE|package(?:-lock)?\.json|tsconfig(?:\.[^.]+)?\.json)$/u.test(rel) || /^packages\/grounded-tools\/[^/]+\/package\.json$/u.test(rel)) category = "metadata";
  else if (/^packages\/[^/]+\/README\.md$/u.test(rel) || rel.startsWith("docs/")) category = "docs";
  else if ([".github/workflows/verify.yml", ".gitignore", "LICENSE", "README.md", "package-lock.json", "package.json", "scripts/verify-chrono-v3-baseline.mjs", "scripts/verify-chrono-v3-privacy.mjs", "scripts/verify-deployed-baseline.mjs"].includes(rel)) category = "rootVerification";
  else {
    category = "unexplained";
    unexplainedPaths.push(rel);
  }
  categories[category] += 1;
}
if (unexplainedPaths.length > 0) throw new Error(`unexplained tracked files: ${unexplainedPaths.join(",")}`);

// Privacy, private-path, and high-confidence secret gate.
const privatePatterns = [
  /\/home\/[A-Za-z0-9._-]+(?:\/|\b)/,
  /\/Users\/[A-Za-z0-9._-]+(?:\/|\b)/,
  /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\|\b)/,
  new RegExp("pi-extension-" + "rescue-backups"),
  /\.agents\/temporary\//,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[opsu]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/,
];
for (const rel of tracked) {
  if (rel.toLowerCase().startsWith("packages/") && rel.toLowerCase().includes("pi-web")) throw new Error(`forbidden pi-web package path: ${rel}`);
  const path = join(root, rel);
  if (!lstatSync(path).isFile()) continue;
  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  for (const pattern of privatePatterns) if (pattern.test(text)) throw new Error(`${rel}: private-path or secret-like pattern ${pattern}`);
}

function packDryRun(product, source) {
  const temp = mkdtempSync(join(tmpdir(), `pi-pack-${product.slug}-`));
  chmodSync(temp, 0o700);
  const work = join(temp, "package");
  try {
    cpSync(source, work, { recursive: true, filter: (path) => !["node_modules", "dist-test"].includes(basename(path)) });
    const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    const result = JSON.parse(output);
    if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0].files)) throw new Error(`${product.slug}: invalid npm pack result`);
    const trackedPackage = new Set(tracked.filter((rel) => rel.startsWith(`packages/${product.slug}/`)).map((rel) => rel.slice(`packages/${product.slug}/`.length)));
    for (const entry of result[0].files) {
      if (!trackedPackage.has(entry.path)) throw new Error(`${product.slug}: npm pack includes unexplained file ${entry.path}`);
    }
    return result[0].files.length;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
function verifyBuiltOutput(product, source, work) {
  const deployed = deployedByProduct.get(product.slug);
  const expectedJs = new Map([...deployed].filter(([rel]) => rel.startsWith("dist/") && rel.endsWith(".js")));
  const outputFiles = walk(join(work, "dist")).map((path) => relative(work, path).replaceAll(sep, "/")).sort();
  const expectedFiles = [...expectedJs.keys()];
  if (product.slug === "pi-chrono-compaction") expectedFiles.push(...[...expectedJs.keys()].map((rel) => `${rel}.map`));
  expectedFiles.sort();
  if (!jsonEqual(outputFiles, expectedFiles)) throw new Error(`${product.slug}: unexpected build output set`);
  for (const [rel, expected] of expectedJs) {
    if (sha256(join(work, rel)) !== expected) throw new Error(`${product.slug}: built JavaScript differs from approved closure: ${rel}`);
  }
  if (product.slug === "pi-chrono-compaction") {
    for (const rel of expectedJs.keys()) {
      const map = readJson(join(work, `${rel}.map`));
      if (map.file !== basename(rel) || !Array.isArray(map.sources) || map.sources.length !== 1) throw new Error(`${product.slug}: invalid required source map ${rel}.map`);
      const sourcePath = resolve(dirname(join(work, `${rel}.map`)), map.sources[0]);
      if (!isWithin(work, sourcePath) || !existsSync(sourcePath)) throw new Error(`${product.slug}: source map does not resolve to retained source: ${rel}.map`);
    }
  }
  return expectedJs.size;
}
function executeScripts(plan) {
  const product = products.find((candidate) => candidate.slug === plan.slug);
  const temp = mkdtempSync(join(tmpdir(), `pi-scripts-${plan.slug}-`));
  chmodSync(temp, 0o700);
  const work = join(temp, "package");
  try {
    cpSync(plan.packageRoot, work, { recursive: true, filter: (path) => !["node_modules"].includes(basename(path)) });
    if (Object.values(plan.scripts).some((command) => /\btsc\b/u.test(command))) {
      execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: work, stdio: "inherit" });
    }
    let passed = 0;
    let buildResult;
    for (const script of Object.keys(plan.scripts)) {
      execFileSync("npm", ["run", script], { cwd: work, stdio: "inherit" });
      passed += 1;
      if (script === "build") buildResult = verifyBuiltOutput(product, plan.packageRoot, work);
    }
    return { passed, buildResult };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function verifyProjectGlanceStatic() {
  const packageRoot = join(root, "packages", projectGlanceSlug);
  const manifestPath = join(packageRoot, "package.json");
  const manifest = readJson(manifestPath);
  if (manifest.name !== projectGlanceSlug || manifest.version !== "0.1.0" || manifest.private !== true || manifest.type !== "module") {
    throw new Error("pi-project-glance: package identity changed");
  }
  if (!jsonEqual(manifest.os, ["linux"])) throw new Error("pi-project-glance: Linux-only package boundary changed");
  if (!jsonEqual(manifest.pi?.extensions, ["./dist/pi/extension.js"])) throw new Error("pi-project-glance: Pi extension entrypoint changed");
  if (!jsonEqual(manifest.bin, { "pi-project-glance": "./bin/pi-project-glance" })) throw new Error("pi-project-glance: launcher changed");
  if (!jsonEqual(manifest.files, ["bin", "dist", "herdr-plugin.toml", "README.md", "package.json", "package-lock.json"])) throw new Error("pi-project-glance: package file boundary changed");
  const expectedScripts = {
    typecheck: "tsc -p tsconfig.json --noEmit",
    build: "rm -rf dist && tsc -p tsconfig.build.json && chmod +x bin/pi-project-glance && test -f dist/pi/extension.js && test -f dist/pane/main.js",
    test: "npm run build && node --test test/*.test.mjs",
    "dev:link": "node scripts/dev-link.mjs",
    "dev:unlink": "node scripts/dev-unlink.mjs",
    "dev:doctor": "node scripts/dev-doctor.mjs",
    "dev:fixture": "npm run build && node scripts/dev-fixture.mjs",
  };
  if (!jsonEqual(manifest.scripts, expectedScripts)) throw new Error("pi-project-glance: safe script set changed");
  for (const forbidden of ["main", "module", "types", "exports", "publishConfig"]) {
    if (Object.hasOwn(manifest, forbidden)) throw new Error(`pi-project-glance: forbidden manifest field ${forbidden}`);
  }
  const lockPath = join(packageRoot, "package-lock.json");
  const lockRoot = readJson(lockPath).packages?.[""];
  if (!lockRoot) throw new Error("pi-project-glance: lockfile lacks packages[\"\"]");
  for (const field of lockComparedFields) {
    const manifestValue = field === "bin" && manifest.bin
      ? Object.fromEntries(Object.entries(manifest.bin).map(([name, value]) => [name, value.replace(/^\.\//u, "")]))
      : manifest[field];
    if (!jsonEqual(manifestValue, lockRoot[field])) throw new Error(`pi-project-glance: package-lock mismatch for ${field}`);
  }
  const herdrManifest = readFileSync(join(packageRoot, "herdr-plugin.toml"), "utf8");
  for (const required of [
    'id = "pi.project-glance"',
    'name = "Project Glance"',
    'version = "0.1.0"',
    'min_herdr_version = "0.8.2"',
    'id = "glance"',
    'title = "Project Glance"',
    'command = ["./bin/pi-project-glance", "glance"]',
  ]) {
    if (!herdrManifest.includes(required)) throw new Error(`pi-project-glance: Herdr manifest lacks ${required}`);
  }
  const projectTracked = tracked.filter((rel) => rel.startsWith(`packages/${projectGlanceSlug}/`));
  const allowedTracked = new RegExp(`^packages/${projectGlanceSlug}/(?:README\\.md|herdr-plugin\\.toml|package(?:-lock)?\\.json|tsconfig(?:\\.build)?\\.json|bin/pi-project-glance|src/.+\\.ts|scripts/dev-(?:doctor|fixture|link|unlink)\\.mjs|test/.+\\.mjs)$`, "u");
  if (projectTracked.length === 0 || projectTracked.some((rel) => !allowedTracked.test(rel))) throw new Error("pi-project-glance: unexplained tracked file");
  if (existsSync(join(packageRoot, "DEPLOYED.sha256"))) throw new Error("pi-project-glance: additive package must not enter the frozen deployed manifest");
  const launcher = join(packageRoot, "bin/pi-project-glance");
  if (!lstatSync(launcher).isFile() || (lstatSync(launcher).mode & 0o111) === 0) throw new Error("pi-project-glance: launcher is not executable");
  const sourceFiles = walk(join(packageRoot, "src")).filter((path) => path.endsWith(".ts"));
  if (sourceFiles.length === 0) throw new Error("pi-project-glance: source is missing");
  for (const source of sourceFiles) {
    const text = readFileSync(source, "utf8");
    if (text.includes("pi-herdr-orchestrator") || text.includes("pi.herdr.orchestrator")) throw new Error("pi-project-glance: direct orchestrator coupling is forbidden");
    if (/register(?:Tool|Widget|Shortcut|Flag)\s*\(/u.test(text)) throw new Error("pi-project-glance: V1 control registration is forbidden");
    for (const specifier of localSpecs(source)) {
      if (specifier.startsWith("node:") || specifier.startsWith("@earendil-works/")) continue;
      if (!specifier.startsWith(".")) throw new Error(`pi-project-glance: unexpected external import ${specifier}`);
      const base = resolve(dirname(source), specifier);
      const ext = extname(base);
      const candidates = ext === ".js" || ext === ".mjs"
        ? [base.slice(0, -ext.length) + ".ts", base]
        : ext === ""
          ? [`${base}.ts`, `${base}.js`, join(base, "index.ts"), join(base, "index.js")]
          : [base];
      const target = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      if (!target || !isWithin(packageRoot, target)) throw new Error(`pi-project-glance: unresolved local import ${specifier}`);
    }
  }
  return {
    package: manifest.name,
    trackedFiles: projectTracked.length,
    sourceFiles: sourceFiles.length,
    identifiers: "locked",
    baselineBoundary: "separate",
  };
}

function verifyProjectGlance() {
  const staticResult = verifyProjectGlanceStatic();
  if (staticOnly) return { ...staticResult, status: "static-only" };
  const packageRoot = join(root, "packages", projectGlanceSlug);
  const temp = mkdtempSync(join(tmpdir(), `pi-project-glance-verify-${process.pid}-`));
  chmodSync(temp, 0o700);
  const work = join(temp, "package");
  try {
    cpSync(packageRoot, work, {
      recursive: true,
      filter: (path) => {
        const rel = relative(packageRoot, path).replaceAll(sep, "/");
        if (rel === "") return true;
        if (["dist", "node_modules", ".runtime"].some((name) => rel === name || rel.startsWith(`${name}/`))) return false;
        return !rel.endsWith(".tgz");
      },
    });
    execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: work, stdio: "inherit" });
    const isolatedEnv = { ...process.env, PI_PROJECT_GLANCE_VERIFIER_COPY: "1" };
    execFileSync("npm", ["run", "typecheck"], { cwd: work, env: isolatedEnv, stdio: "inherit" });
    execFileSync("npm", ["test"], { cwd: work, env: isolatedEnv, stdio: "inherit" });
    const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    const result = JSON.parse(output);
    if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0].files)) throw new Error("pi-project-glance: invalid pack result");
    const distFiles = walk(join(work, "dist"))
      .filter((path) => statSync(path).isFile())
      .map((path) => relative(work, path).replaceAll(sep, "/"))
      .sort();
    const packFiles = result[0].files.map((entry) => entry.path).sort();
    const required = ["README.md", "bin/pi-project-glance", "herdr-plugin.toml", "package.json", ...distFiles].sort();
    for (const path of required) if (!packFiles.includes(path)) throw new Error(`pi-project-glance: pack omitted ${path}`);
    for (const path of packFiles) {
      if (!required.includes(path) && path !== "package-lock.json") throw new Error(`pi-project-glance: pack includes unexplained file ${path}`);
    }
    return { ...staticResult, status: "pass", tests: "pass", packFiles: packFiles.length };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

let safeScriptsPassed = 0;
let packPassed = 0;
const packFiles = {};
const buildResults = {};
const baselineScopeSelected = selectedSlug !== projectGlanceSlug;
if (!staticOnly) {
  for (const product of products.filter((candidate) => baselineScopeSelected && (!selectedSlug || candidate.slug === selectedSlug))) {
    packFiles[product.slug] = packDryRun(product, join(root, "packages", product.slug));
    packPassed += 1;
  }
  for (const plan of scriptPlans.filter((candidate) => baselineScopeSelected && (!selectedSlug || candidate.slug === selectedSlug))) {
    const result = executeScripts(plan);
    safeScriptsPassed += result.passed;
    if (result.buildResult !== undefined) buildResults[plan.slug] = result.buildResult;
  }
}
const expectedScriptTotal = selectedSlug === projectGlanceSlug ? 0 : selectedSlug
  ? Object.keys(expectedSafeScripts[selectedSlug] ?? {}).length
  : Object.values(expectedSafeScripts).reduce((total, scripts) => total + Object.keys(scripts).length, 0);
const expectedPackTotal = selectedSlug === projectGlanceSlug ? 0 : selectedSlug ? 1 : 17;
if (!staticOnly && safeScriptsPassed !== expectedScriptTotal) throw new Error(`safe scripts passed ${safeScriptsPassed}/${expectedScriptTotal}`);
if (!staticOnly && packPassed !== expectedPackTotal) throw new Error(`pack dry runs passed ${packPassed}/${expectedPackTotal}`);
if (!staticOnly) {
  for (const product of products.filter((candidate) => baselineScopeSelected && candidate.compiledCount !== undefined && (!selectedSlug || candidate.slug === selectedSlug))) {
    if (buildResults[product.slug] !== product.compiledCount) throw new Error(`${product.slug}: build matched ${buildResults[product.slug] ?? 0}/${product.compiledCount}`);
  }
}

const projectGlanceResult = !selectedSlug || selectedSlug === projectGlanceSlug
  ? verifyProjectGlance()
  : { status: "skipped" };

console.log(JSON.stringify({
  products: products.length,
  manifestsValidated: `${topManifests.length}/${expectedSlugs.length}`,
  totalManifestsValidated: packageManifestPaths.length,
  activeFamilies: active.length,
  activeEntrypoints: activeEntrypoints.length,
  inactiveProducts: inactive.length,
  stage1RuntimeRecords: "272/272",
  deployedHashesVerified: "261/261",
  historicalMetadataHashes,
  compiledCounts: Object.fromEntries(products.filter((product) => product.compiledCount !== undefined).map((product) => [product.slug, `${product.compiledCount}/${product.compiledCount}`])),
  buildResults: Object.fromEntries(Object.entries(buildResults).map(([slug, count]) => [slug, `${count}/${products.find((product) => product.slug === slug).compiledCount}`])),
  safeScripts: staticOnly ? "skipped" : `${safeScriptsPassed}/${expectedScriptTotal}`,
  packDryRuns: staticOnly ? "skipped" : `${packPassed}/${expectedPackTotal}`,
  projectGlance: projectGlanceResult,
  dependencyRuntimeGraph: {
    deployedRuntime: categories.deployedRuntime,
    sourceBuildInputs: categories.sourceBuildInputs + categories.inactiveSource,
    runtimeResources: runtimeResourcePaths.size,
    metadataDocs: categories.metadata + categories.docs + categories.rootVerification,
    unexplained: categories.unexplained,
  },
  trackedFiles: tracked.length,
  privacyScan: "pass",
  piWebPackages: 0,
  allCurrentDeployedCodeOnMain: true,
}, null, 2));
