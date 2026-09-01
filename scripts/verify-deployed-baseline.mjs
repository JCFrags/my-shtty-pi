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
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const products = packageJson.piConsolidation?.products;
if (!Array.isArray(products)) throw new Error("package.json lacks piConsolidation.products");

const args = process.argv.slice(2);
const productIndex = args.indexOf("--product");
const selectedSlug = productIndex >= 0 ? args[productIndex + 1] : undefined;
if (productIndex >= 0 && !selectedSlug) throw new Error("--product requires a slug");
const staticOnly = args.includes("--static-only");

const expectedSlugs = [
  "codex-usage-footer", "files-ui", "grounded-tools", "herdr-agent-state",
  "herdr-blocked-bridge", "herdr-status", "pi-agent-context",
  "pi-chrono-compaction", "pi-herdr-orchestrator", "pi-native-ssh",
  "pi-pixel-cua", "pi-progressive-tools", "pi-review-ui", "pi-signal-board",
  "pi-tool-controls", "temporary-orchestrator-cancel-isolation", "titlebar-spinner",
];
const actualSlugs = products.map((p) => p.slug);
if (JSON.stringify(actualSlugs) !== JSON.stringify(expectedSlugs)) {
  throw new Error(`unexpected product order/set: ${actualSlugs.join(",")}`);
}
const packageDirs = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
if (JSON.stringify(packageDirs) !== JSON.stringify([...expectedSlugs].sort())) {
  throw new Error(`packages/ must contain exactly 17 products: ${packageDirs.join(",")}`);
}
if (packageDirs.some((name) => name.toLowerCase().includes("pi-web"))) {
  throw new Error("pi-web package directory is forbidden");
}
if (!existsSync(join(root, "packages/temporary-orchestrator-cancel-isolation"))) {
  throw new Error("temporary cancellation isolation must remain separate");
}
if (existsSync(join(root, "packages/pi-herdr-orchestrator/extensions/temporary-orchestrator-cancel-isolation.ts"))) {
  throw new Error("temporary cancellation isolation was folded into the orchestrator");
}

const active = products.filter((p) => p.status === "active" || p.status === "active-temporary");
const inactive = products.filter((p) => p.status === "inactive");
const activeEntrypoints = active.flatMap((p) => p.entrypoints.map((entry) => `${p.slug}/${entry}`));
if (active.length !== 15 || activeEntrypoints.length !== 21) {
  throw new Error(`expected 15 active families and 21 entrypoints; got ${active.length}/${activeEntrypoints.length}`);
}
if (inactive.map((p) => p.slug).join(",") !== "pi-review-ui,pi-tool-controls") {
  throw new Error("inactive product set changed");
}
if (products.find((p) => p.slug === "temporary-orchestrator-cancel-isolation")?.status !== "active-temporary") {
  throw new Error("temporary shim status changed");
}
if (selectedSlug && !products.some((p) => p.slug === selectedSlug)) throw new Error(`unknown product ${selectedSlug}`);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(path);
  }
  return out;
}
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function parseDeployed(path) {
  const entries = new Map();
  for (const [index, line] of readFileSync(path, "utf8").trimEnd().split("\n").entries()) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) throw new Error(`${path}:${index + 1}: invalid DEPLOYED.sha256 line`);
    if (entries.has(match[2])) throw new Error(`${path}: duplicate ${match[2]}`);
    entries.set(match[2], match[1]);
  }
  return entries;
}

let hashCount = 0;
for (const product of active) {
  const packageRoot = join(root, "packages", product.slug);
  const manifestPath = join(packageRoot, "DEPLOYED.sha256");
  if (!existsSync(manifestPath)) throw new Error(`${product.slug} lacks DEPLOYED.sha256`);
  const deployed = parseDeployed(manifestPath);
  for (const [rel, expected] of deployed) {
    const path = resolve(packageRoot, rel);
    if (!path.startsWith(`${packageRoot}${sep}`)) throw new Error(`${product.slug}: path escapes package: ${rel}`);
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${product.slug}: missing deployed file ${rel}`);
    const actual = sha256(path);
    if (actual !== expected) throw new Error(`${product.slug}: hash mismatch for ${rel}: ${actual} != ${expected}`);
    hashCount += 1;
  }
  for (const entry of product.entrypoints) {
    if (!deployed.has(entry)) throw new Error(`${product.slug}: active entrypoint absent from DEPLOYED.sha256: ${entry}`);
    if (!existsSync(join(packageRoot, entry))) throw new Error(`${product.slug}: missing entrypoint ${entry}`);
  }
  if (product.compiledCount !== undefined) {
    const committed = walk(join(packageRoot, "dist")).filter((path) => path.endsWith(".js"));
    const declared = [...deployed.keys()].filter((path) => path.startsWith("dist/") && path.endsWith(".js"));
    if (committed.length !== product.compiledCount || declared.length !== product.compiledCount) {
      throw new Error(`${product.slug}: compiled count ${committed.length}/${declared.length}; expected ${product.compiledCount}`);
    }
  }
}
if (packageJson.piConsolidation.stage1RuntimeRecords !== 272 || packageJson.piConsolidation.canonicalDeployedFiles !== 261) {
  throw new Error("Stage 1 record or canonical deployed-file count changed");
}
if (hashCount !== packageJson.piConsolidation.canonicalDeployedFiles) {
  throw new Error(`canonical deployed hash count ${hashCount}; expected ${packageJson.piConsolidation.canonicalDeployedFiles}`);
}
for (const product of inactive) {
  if (existsSync(join(root, "packages", product.slug, "DEPLOYED.sha256"))) {
    throw new Error(`${product.slug}: inactive product must not have an active deployed manifest`);
  }
}

// Every package manifest must parse, and each Pi-declared entrypoint must resolve.
const packageManifestPaths = walk(join(root, "packages")).filter((path) => basename(path) === "package.json");
for (const manifestPath of packageManifestPaths) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof manifest.name === "string" && manifest.name.toLowerCase().includes("pi-web")) {
    throw new Error(`forbidden pi-web package name in ${relative(root, manifestPath)}`);
  }
  const declared = manifest.pi?.extensions ?? [];
  if (!Array.isArray(declared)) throw new Error(`${relative(root, manifestPath)}: pi.extensions must be an array`);
  for (const entry of declared) {
    const path = resolve(dirname(manifestPath), entry);
    if (!path.startsWith(`${dirname(manifestPath)}${sep}`) || !existsSync(path)) {
      throw new Error(`${relative(root, manifestPath)}: unresolved Pi entrypoint ${entry}`);
    }
  }
}

// Check exact root shape and committed privacy boundary.
const rootEntries = readdirSync(root).filter((name) => name !== ".git").sort();
const allowedRootEntries = [".github", ".gitignore", "LICENSE", "README.md", "package-lock.json", "package.json", "packages", "scripts"].sort();
if (JSON.stringify(rootEntries) !== JSON.stringify(allowedRootEntries)) {
  throw new Error(`unexpected root entries: ${rootEntries.join(",")}`);
}
const workflows = walk(join(root, ".github/workflows")).map((path) => relative(join(root, ".github/workflows"), path));
if (workflows.length !== 1 || workflows[0] !== "verify.yml") throw new Error("exactly one verify workflow is required");
const scriptFiles = walk(join(root, "scripts")).map((path) => relative(join(root, "scripts"), path));
if (scriptFiles.length !== 1 || scriptFiles[0] !== "verify-deployed-baseline.mjs") throw new Error("only the root baseline verifier is allowed under scripts/");

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root }).toString("utf8").split("\0").filter(Boolean);
const privatePatterns = [
  /\/home\/mainpc(?:\/|\b)/,
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
  if (rel.toLowerCase().startsWith("packages/") && rel.toLowerCase().includes("pi-web")) {
    throw new Error(`forbidden pi-web package path: ${rel}`);
  }
  const path = join(root, rel);
  if (!existsSync(path) || !lstatSync(path).isFile()) continue;
  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  for (const pattern of privatePatterns) {
    if (pattern.test(text)) throw new Error(`${rel}: private-path or secret-like pattern ${pattern}`);
  }
}

function verifyBuild(product) {
  const source = join(root, "packages", product.slug);
  const temp = mkdtempSync(join(tmpdir(), `pi-baseline-${product.slug}-`));
  chmodSync(temp, 0o700);
  const work = join(temp, "package");
  try {
    cpSync(source, work, { recursive: true, filter: (path) => !["dist", "node_modules"].includes(basename(path)) });
    execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: work, stdio: "inherit" });
    const tsc = join(work, "node_modules", ".bin", "tsc");
    const out = join(temp, "out");
    execFileSync(tsc, ["-p", product.buildConfig, "--outDir", out], { cwd: work, stdio: "inherit" });
    const deployed = parseDeployed(join(source, "DEPLOYED.sha256"));
    let matched = 0;
    for (const [rel, expected] of deployed) {
      if (!rel.startsWith("dist/") || !rel.endsWith(".js")) continue;
      const built = join(out, rel.slice("dist/".length));
      if (!existsSync(built)) throw new Error(`${product.slug}: build omitted ${rel}`);
      const actual = sha256(built);
      if (actual !== expected) throw new Error(`${product.slug}: build mismatch ${rel}: ${actual} != ${expected}`);
      matched += 1;
    }
    if (matched !== product.compiledCount) throw new Error(`${product.slug}: build matched ${matched}/${product.compiledCount}`);
    return matched;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const compiled = products.filter((p) => p.compiledCount !== undefined && (!selectedSlug || p.slug === selectedSlug));
const buildResults = {};
if (!staticOnly) {
  for (const product of compiled) buildResults[product.slug] = verifyBuild(product);
}

console.log(JSON.stringify({
  products: products.length,
  activeFamilies: active.length,
  activeEntrypoints: activeEntrypoints.length,
  inactiveProducts: inactive.length,
  stage1RuntimeRecords: packageJson.piConsolidation.stage1RuntimeRecords,
  deployedHashesVerified: hashCount,
  compiledCounts: Object.fromEntries(products.filter((p) => p.compiledCount !== undefined).map((p) => [p.slug, p.compiledCount])),
  buildResults,
  privacyScan: "pass",
  piWebPackages: 0,
}, null, 2));
