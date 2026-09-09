#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const shaPattern = /^[0-9a-f]{40}$/u;

function fail(reason, outputPath) {
  const result = { classification: "unknown", broad: "false", reason };
  writeOutputs(result, outputPath);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 1;
}

function writeOutputs(result, outputPath) {
  if (!outputPath) return;
  appendFileSync(outputPath, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(""));
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function requireSha(value, reason) {
  if (typeof value !== "string" || !shaPattern.test(value)) throw new Error(reason);
  return value;
}

function changedPaths(root, range) {
  const output = git(root, "diff", "--name-only", "--no-renames", range, "--");
  const paths = output.split("\n").filter(Boolean);
  if (paths.length === 0) throw new Error("empty-change-set");
  return paths;
}

function isDocumentation(path) {
  return path.startsWith("docs/") || /^[^/]+\.md$/u.test(path);
}

const supportedValidationPaths = new Set([
  ".github/workflows/verify.yml",
  "package.json", // Root compiled-count inventory; baseline verification remains required.
  "scripts/chrono-validation-scope.mjs",
  "scripts/test/chrono-validation-scope.test.mjs",
  "scripts/verify-chrono-v3-baseline.mjs",
  "scripts/verify-deployed-baseline.mjs",
  "scripts/verify-chrono-v3-privacy.mjs",
]);

function isSupportedRuntime(path) {
  return path.startsWith("packages/pi-chrono-compaction/") || supportedValidationPaths.has(path);
}

function classify({ eventName, event, sha, root }) {
  requireSha(sha, "invalid-event-sha");
  if (git(root, "rev-parse", "HEAD") !== sha) throw new Error("checkout-head-mismatch");
  if (eventName === "workflow_dispatch") {
    if (event.inputs?.validation_scope !== "milestone") throw new Error("dispatch-must-request-milestone");
    const expectedHead = requireSha(event.inputs?.expected_head, "dispatch-expected-head-missing");
    if (expectedHead !== sha) throw new Error("dispatch-head-mismatch");
    return { classification: "milestone", broad: "true", reason: "explicit-milestone-checkpoint" };
  }

  let paths;
  let baseRevision;
  let headRevision;
  if (eventName === "pull_request") {
    const base = requireSha(event.pull_request?.base?.sha, "pull-request-base-missing");
    const head = requireSha(event.pull_request?.head?.sha, "pull-request-head-missing");
    // merge_commit_sha is asynchronous mergeability metadata, not the Actions
    // checkout identity: it can be absent or refer to an earlier test merge.
    // Bind the actual GITHUB_SHA checkout to both event parents instead.
    const parents = git(root, "show", "-s", "--format=%P", sha).split(" ");
    if (parents.length !== 2 || parents[0] !== base || parents[1] !== head) throw new Error("pull-request-merge-parents-mismatch");
    baseRevision = git(root, "merge-base", base, head);
    headRevision = head;
    paths = changedPaths(root, `${base}...${head}`);
  } else if (eventName === "push") {
    const before = requireSha(event.before, "push-before-missing");
    const after = requireSha(event.after, "push-after-missing");
    if (/^0{40}$/u.test(before)) throw new Error("new-branch-push-needs-pull-request-qualification");
    if (after !== sha) throw new Error("push-head-mismatch");
    baseRevision = before;
    headRevision = after;
    paths = changedPaths(root, `${before}..${after}`);
  } else {
    throw new Error("unsupported-event");
  }

  if (paths.includes("package.json")) {
    const before = JSON.parse(git(root, "show", `${baseRevision}:package.json`));
    const after = JSON.parse(git(root, "show", `${headRevision}:package.json`));
    const oldProduct = before.piConsolidation?.products?.find(p => p.slug === "pi-chrono-compaction");
    const newProduct = after.piConsolidation?.products?.find(p => p.slug === "pi-chrono-compaction");
    if (oldProduct?.compiledCount !== 114 || newProduct?.compiledCount !== 118) throw new Error("unsupported-root-inventory-change");
    newProduct.compiledCount = oldProduct.compiledCount;
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("unsupported-root-metadata-change");
  }

  const unsupported = paths.find((path) => !isDocumentation(path) && !isSupportedRuntime(path));
  if (unsupported) throw new Error(`unsupported-change-path:${unsupported}`);
  const documentationOnly = paths.every(isDocumentation);
  return {
    classification: documentationOnly ? "docs" : "runtime",
    broad: "false",
    reason: documentationOnly ? "documentation-only-diff" : "supported-chrono-runtime-diff",
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("invalid-arguments");
    values[flag.slice(2)] = value;
  }
  for (const required of ["event", "event-name", "sha"]) if (!values[required]) throw new Error(`missing-${required}`);
  return values;
}

let outputPath;
try {
  const args = parseArgs(process.argv.slice(2));
  outputPath = args.output;
  const event = JSON.parse(readFileSync(args.event, "utf8"));
  const result = classify({ eventName: args["event-name"], event, sha: args.sha, root: args.root ?? process.cwd() });
  writeOutputs(result, outputPath);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : "classification-failed", outputPath);
}
