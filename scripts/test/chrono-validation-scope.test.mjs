import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const classifier = join(process.cwd(), "scripts", "chrono-validation-scope.mjs");

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "chrono-validation-scope-"));
  git(root, "init", "--quiet", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Validation scope test");
  writeFileSync(join(root, "README.md"), "initial\n");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "initial");
  return root;
}

function commit(root, path, content) {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
  git(root, "add", "--", path);
  git(root, "commit", "--quiet", "-m", path);
  return git(root, "rev-parse", "HEAD");
}

function pullRequest(root, path) {
  const base = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "--quiet", "-b", "feature");
  const head = commit(root, path, "export {};\n");
  git(root, "checkout", "--quiet", "main");
  git(root, "merge", "--quiet", "--no-ff", "--no-edit", "feature");
  const merge = git(root, "rev-parse", "HEAD");
  return { base, head, merge };
}

function run(root, eventName, event, sha) {
  const eventPath = join(root, "event.json");
  writeFileSync(eventPath, JSON.stringify(event));
  const result = spawnSync(process.execPath, [classifier, "--root", root, "--event", eventPath, "--event-name", eventName, "--sha", sha], {
    encoding: "utf8",
  });
  return { status: result.status, json: JSON.parse(result.stdout.trim()) };
}

function withFixture(fn) {
  const root = fixture();
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("both baseline inventory verifiers select routine validation", () => withFixture((root) => {
  for (const path of ["scripts/verify-chrono-v3-baseline.mjs", "scripts/verify-deployed-baseline.mjs"]) {
    const before = git(root, "rev-parse", "HEAD");
    const after = commit(root, path, "// exact inventory update\n");
    const result = run(root, "push", { before, after }, after);
    assert.equal(result.status, 0);
    assert.equal(result.json.classification, "runtime");
    assert.equal(result.json.broad, "false");
  }
}));

test("push documentation diff selects documentation validation", () => withFixture((root) => {
  const before = git(root, "rev-parse", "HEAD");
  const after = commit(root, "docs/change.md", "docs\n");
  const result = run(root, "push", { before, after }, after);
  assert.equal(result.status, 0);
  assert.deepEqual(result.json, { classification: "docs", broad: "false", reason: "documentation-only-diff" });
}));

test("PR Chrono diff selects routine runtime and forged merge SHA fails", () => withFixture((root) => {
  const { base, head, merge } = pullRequest(root, "packages/pi-chrono-compaction/src/search-v3.ts");
  const pull = { base: { sha: base }, head: { sha: head }, merge_commit_sha: merge };
  const accepted = run(root, "pull_request", { pull_request: pull }, merge);
  assert.equal(accepted.status, 0);
  assert.deepEqual(accepted.json, { classification: "runtime", broad: "false", reason: "supported-chrono-runtime-diff" });

  const omitted = run(root, "pull_request", { pull_request: { base: pull.base, head: pull.head } }, merge);
  assert.equal(omitted.status, 0);
  const forged = run(root, "pull_request", { pull_request: { base: pull.head, head: pull.base } }, merge);
  assert.equal(forged.json.reason, "pull-request-merge-parents-mismatch");

  const rejected = run(root, "pull_request", { pull_request: { ...pull, merge_commit_sha: head } }, merge);
  assert.notEqual(rejected.status, 0);
  assert.equal(rejected.json.classification, "unknown");
  assert.equal(rejected.json.reason, "pull-request-merge-sha-mismatch");
}));

test("unsupported paths and unqualified events fail closed", () => withFixture((root) => {
  const before = git(root, "rev-parse", "HEAD");
  const unsupported = commit(root, "packages/unrelated/source.ts", "export {};\n");
  const cases = [
    ["push", { before, after: unsupported }, unsupported],
    ["schedule", {}, unsupported],
    ["push", { before: "0".repeat(40), after: unsupported }, unsupported],
  ];
  for (const [name, event, sha] of cases) {
    const result = run(root, name, event, sha);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.classification, "unknown");
    assert.equal(result.json.broad, "false");
  }
}));

test("broad validation is selected only by exact-head milestone dispatch", () => withFixture((root) => {
  const head = git(root, "rev-parse", "HEAD");
  const accepted = run(root, "workflow_dispatch", { inputs: { validation_scope: "milestone", expected_head: head } }, head);
  assert.equal(accepted.status, 0);
  assert.equal(accepted.json.classification, "milestone");
  assert.equal(accepted.json.broad, "true");

  for (const event of [
    { inputs: { validation_scope: "routine", expected_head: head } },
    { inputs: { validation_scope: "milestone", expected_head: "1".repeat(40) } },
  ]) {
    const rejected = run(root, "workflow_dispatch", event, head);
    assert.notEqual(rejected.status, 0);
    assert.equal(rejected.json.broad, "false");
  }
}));

test("root inventory permits only the exact M06 compiled-count change", () => withFixture((root) => {
  const manifest = { piConsolidation: { products: [{ slug: "pi-chrono-compaction", compiledCount: 107 }] } };
  const before = commit(root, "package.json", JSON.stringify(manifest));
  manifest.piConsolidation.products[0].compiledCount = 114;
  const after = commit(root, "package.json", JSON.stringify(manifest));
  assert.equal(run(root, "push", { before, after }, after).status, 0);
  manifest.unrelated = true;
  const unrelated = commit(root, "package.json", JSON.stringify(manifest));
  assert.equal(run(root, "push", { before, after: unrelated }, unrelated).json.reason, "unsupported-root-metadata-change");
}));
