import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const scanner = join(process.cwd(), "scripts", "verify-chrono-v3-privacy.mjs");
const expectedRepository = "JCFrags/my-shtty-pi";

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function createRepo() {
  const root = mkdtempSync(join(tmpdir(), "chrono-privacy-test-"));
  mkdirSync(root, { recursive: true });
  git(root, "init", "--quiet", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Chrono privacy test");
  writeFileSync(join(root, "README.md"), "synthetic repository\n");
  git(root, "add", "README.md");
  git(root, "commit", "--quiet", "-m", "initial");
  return root;
}
function commit(root, message) {
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", message);
  return git(root, "rev-parse", "HEAD");
}
function runScanner(root, ...args) {
  const result = spawnSync(process.execPath, [scanner, "--root", root, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 120000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  let json;
  try {
    json = JSON.parse((result.stdout || result.stderr).trim());
  } catch (error) {
    assert.fail(`scanner did not emit JSON: ${error.message}`);
  }
  return { ...result, json, output };
}
function withRepo(fn) {
  const root = createRepo();
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function assertBlocked(result, category) {
  assert.notEqual(result.status, 0);
  assert.ok(["blocked", "unscanned-input", "invalid-invocation"].includes(result.json.status), result.output);
  if (category) assert.ok(result.json.findings.some((finding) => finding.category === category), result.output);
}
function eventFile(root, repository, extra = {}) {
  const path = join(root, "event.json");
  writeFileSync(path, JSON.stringify({ repository, ...extra }));
  return path;
}
function publicRepository() {
  return { full_name: expectedRepository, visibility: "public", private: false, fork: false };
}
function historicalObject(root, objectId) {
  return execFileSync("git", ["cat-file", "-p", objectId], {
    cwd: process.cwd(),
    encoding: null,
    stdio: ["ignore", "pipe", "ignore"],
  });
}
function assertFindingPaths(result, category, paths) {
  assertBlocked(result, category);
  const found = result.json.findings.filter((finding) => finding.category === category).map((finding) => finding.path);
  for (const path of paths) assert.ok(found.includes(path), result.output);
}

// Safe and current-tree/index behavior.
test("safe current tree passes", () => withRepo((root) => {
  const result = runScanner(root, "--self-test", "--worktree", "--index");
  assert.equal(result.status, 0);
  assert.equal(result.json.status, "passed");
  assert.equal(result.json.schemaVersion, 3);
}));

test("unsafe worktree file fails", () => withRepo((root) => {
  const token = ["ghp_", "x".repeat(40)].join("");
  writeFileSync(join(root, "unsafe.txt"), token);
  const result = runScanner(root, "--worktree");
  assertBlocked(result, "github-token");
}));

test("unsafe staged index file fails", () => withRepo((root) => {
  const token = ["sk-proj-", "x".repeat(32)].join("");
  writeFileSync(join(root, "staged.txt"), token);
  git(root, "add", "staged.txt");
  const result = runScanner(root, "--index");
  assertBlocked(result, "openai-key");
}));

test("secret added then removed is found by range scanning", () => withRepo((root) => {
  const base = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "temporary.txt"), ["sk-ant-", "x".repeat(32)].join(""));
  const added = commit(root, "synthetic unsafe addition");
  rmSync(join(root, "temporary.txt"));
  const head = commit(root, "remove unsafe addition");
  assert.notEqual(base, added);
  const result = runScanner(root, "--range", `${base}..${head}`);
  assertBlocked(result, "anthropic-key");
}));

test("all-ref scanning includes a non-current branch", () => withRepo((root) => {
  git(root, "checkout", "--quiet", "-b", "hidden");
  writeFileSync(join(root, "hidden.txt"), ["AIza", "x".repeat(24)].join(""));
  commit(root, "hidden branch fixture");
  git(root, "checkout", "--quiet", "main");
  const result = runScanner(root, "--all-refs");
  assertBlocked(result, "google-api-key");
}));

test("commit and all-ref scanning reject historical symlinks", () => withRepo((root) => {
  writeFileSync(join(root, "target.txt"), "safe target\n");
  execFileSync("ln", ["-s", "target.txt", join(root, "historical-link.txt")], { cwd: root });
  const head = commit(root, "historical symlink fixture");
  const commitResult = runScanner(root, "--commit", head);
  assertBlocked(commitResult, "symlink");
  const allRefResult = runScanner(root, "--all-refs");
  assertBlocked(allRefResult, "symlink");
}));

test("NUL-containing file is not silently skipped", () => withRepo((root) => {
  writeFileSync(join(root, "nul.bin"), Buffer.from([0x66, 0x00, 0x61, 0x6b, 0x65]));
  const result = runScanner(root, "--worktree");
  assertBlocked(result, "binary-or-nul");
}));

test("oversized blob fails closed", () => withRepo((root) => {
  writeFileSync(join(root, "large.txt"), "x".repeat(4096));
  const result = runScanner(root, "--worktree", "--max-bytes", "1024");
  assertBlocked(result, "unscanned-oversize");
}));

test("missing blob fails closed", () => withRepo((root) => {
  const missing = "0".repeat(40);
  const result = runScanner(root, "--object", missing);
  assertBlocked(result, "unscanned-blob");
}));

test("worktree symlink is rejected without following it", () => withRepo((root) => {
  const token = ["sk-", "x".repeat(32)].join("");
  const outside = join(root, "outside-secret.txt");
  writeFileSync(outside, token);
  execFileSync("ln", ["-s", "outside-secret.txt", join(root, "link.txt")], { cwd: root });
  const result = runScanner(root, "--worktree");
  assertBlocked(result, "symlink");
  assert.ok(!result.output.includes(token));
}));

// Credential and private-material categories.
test("private key is detected", () => withRepo((root) => {
  const key = ["-----BEGIN ", "OPENSSH PRIVATE KEY-----\nsynthetic\n-----END OPENSSH PRIVATE KEY-----"].join("");
  writeFileSync(join(root, "key.txt"), key);
  const result = runScanner(root, "--worktree");
  assertBlocked(result, "private-key");
}));

test("dynamically constructed GitHub token is detected", () => withRepo((root) => {
  const token = ["github_pat_", "x".repeat(30)].join("");
  writeFileSync(join(root, "github.txt"), token);
  const result = runScanner(root, "--worktree");
  assertBlocked(result, "github-token");
}));

test("dynamically constructed OpenAI key is detected", () => withRepo((root) => {
  const token = ["sk-", "x".repeat(32)].join("");
  writeFileSync(join(root, "openai.txt"), token);
  const result = runScanner(root, "--worktree");
  assertBlocked(result, "openai-key");
}));

test("dynamically constructed Anthropic key is detected", () => withRepo((root) => {
  const token = ["sk-ant-", "x".repeat(32)].join("");
  writeFileSync(join(root, "anthropic.txt"), token);
  const result = runScanner(root, "--worktree");
  assertBlocked(result, "anthropic-key");
}));

test("credential URL is detected", () => withRepo((root) => {
  const url = ["https://", "user:password@example.invalid/path"].join("");
  writeFileSync(join(root, "url.txt"), url);
  const result = runScanner(root, "--worktree");
  assertBlocked(result, "credential-url");
}));

test("raw session JSONL outside the fixture path is rejected", () => withRepo((root) => {
  writeFileSync(join(root, "session.jsonl"), '{"type":"session"}\n');
  const result = runScanner(root, "--worktree");
  assertBlocked(result, "raw-session-jsonl");
}));

test("valid synthetic JSONL fixture passes", () => withRepo((root) => {
  const fixture = join(root, "packages", "pi-chrono-compaction", "test", "fixtures");
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, "session.jsonl"), '{"type":"session","id":"synthetic"}\n{"type":"message","text":"fixture"}\n');
  const result = runScanner(root, "--worktree");
  assert.equal(result.status, 0, result.output);
}));

test("invalid synthetic JSONL fixture fails", () => withRepo((root) => {
  const fixture = join(root, "packages", "pi-chrono-compaction", "test", "fixtures");
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, "session.jsonl"), "not json\n");
  const result = runScanner(root, "--worktree");
  assertBlocked(result, "invalid-synthetic-jsonl");
}));

test("matched secret bytes never appear in output", () => withRepo((root) => {
  const token = ["npm_", "x".repeat(36)].join("");
  writeFileSync(join(root, "token.txt"), token);
  const result = runScanner(root, "--worktree");
  assertBlocked(result, "npm-token");
  assert.ok(!result.output.includes(token));
  assert.ok(!result.output.includes(root));
}));

test("error output contains no absolute temporary path", () => withRepo((root) => {
  const event = join(root, "malformed-event.json");
  writeFileSync(event, "not-json\n");
  const result = runScanner(root, "--worktree", "--ci-event", event);
  assert.equal(result.json.status, "invalid-invocation");
  assert.ok(!result.output.includes(root));
  assert.ok(!result.output.includes(event));
}));

// Public review event identity behavior.
test("public-review identity succeeds for the expected public repository event", () => withRepo((root) => {
  const event = eventFile(root, { full_name: expectedRepository, visibility: "public", private: false, fork: false });
  const result = runScanner(root, "--self-test", "--worktree", "--require-public-review", "--repository", expectedRepository, "--ci-event", event);
  assert.equal(result.status, 0, result.output);
  assert.ok(result.json.scopes.includes("public-review"));
}));

test("private visibility fails the public-review requirement", () => withRepo((root) => {
  const event = eventFile(root, { full_name: expectedRepository, visibility: "private", private: true, fork: false });
  const result = runScanner(root, "--worktree", "--require-public-review", "--repository", expectedRepository, "--ci-event", event);
  assertBlocked(result, "private-repository-visibility");
}));

test("wrong repository identity fails", () => withRepo((root) => {
  const event = eventFile(root, { full_name: "other-owner/other-repository", visibility: "public", private: false, fork: false });
  const result = runScanner(root, "--worktree", "--require-public-review", "--repository", expectedRepository, "--ci-event", event);
  assertBlocked(result, "wrong-repository-identity");
}));

test("public-review requires an explicit non-fork identity", () => withRepo((root) => {
  const event = eventFile(root, { full_name: expectedRepository, visibility: "public", private: false });
  const result = runScanner(root, "--worktree", "--require-public-review", "--repository", expectedRepository, "--ci-event", event);
  assertBlocked(result, "public-fork");
}));

test("malformed CI event fails closed", () => withRepo((root) => {
  const event = join(root, "event.json");
  writeFileSync(event, "{\n");
  const result = runScanner(root, "--worktree", "--require-public-review", "--repository", expectedRepository, "--ci-event", event);
  assert.equal(result.json.status, "invalid-invocation");
  assert.equal(result.json.code, "invalid-ci-event");
  assert.ok(!result.output.includes(root));
}));

// R2 historical path-context and event-scope coverage.
test("range scanning blocks a safe blob when it also occupied .env", () => withRepo((root) => {
  const base = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, ".env"), "ordinary historical bytes\n");
  const added = commit(root, "synthetic env alias");
  rmSync(join(root, ".env"));
  const head = commit(root, "remove env alias");
  assert.notEqual(base, added);
  const result = runScanner(root, "--range", `${base}..${head}`);
  assertFindingPaths(result, "credential-file", [".env"]);
}));

test("range scanning blocks a safe blob when it also occupied session.jsonl", () => withRepo((root) => {
  const base = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "session.jsonl"), "ordinary historical bytes\n");
  commit(root, "synthetic session alias");
  const head = git(root, "rev-parse", "HEAD");
  const result = runScanner(root, "--range", `${base}..${head}`);
  assertFindingPaths(result, "raw-session-jsonl", ["session.jsonl"]);
}));

test("approved historical fixture content still blocks at an unapproved alias", () => withRepo((root) => {
  const base = git(root, "rev-parse", "HEAD");
  const fixture = join(root, "packages", "herdr-status", "test");
  mkdirSync(fixture, { recursive: true });
  const bytes = historicalObject(root, "1590f61a6f57accf641d4093d588b5b531f33662");
  writeFileSync(join(fixture, "sanitize.test.ts"), bytes);
  writeFileSync(join(root, "notes.txt"), bytes);
  const head = commit(root, "approved fixture with unapproved alias");
  const result = runScanner(root, "--range", `${base}..${head}`);
  assertFindingPaths(result, "credential-url", ["notes.txt"]);
  assert.ok(!result.json.findings.some((finding) => finding.path === "packages/herdr-status/test/sanitize.test.ts" && finding.category === "credential-url"), result.output);
}));

test("range scanning detects a symlink added and removed inside the range", () => withRepo((root) => {
  const base = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "target.txt"), "safe target\n");
  execFileSync("ln", ["-s", "target.txt", join(root, "historical-link.txt")], { cwd: root });
  commit(root, "add historical symlink");
  rmSync(join(root, "historical-link.txt"));
  const head = commit(root, "remove historical symlink");
  const result = runScanner(root, "--range", `${base}..${head}`);
  assertFindingPaths(result, "symlink", ["historical-link.txt"]);
}));

test("range scanning detects a rename into a forbidden path", () => withRepo((root) => {
  writeFileSync(join(root, "ordinary.txt"), "safe historical bytes\n");
  const base = commit(root, "safe historical file");
  execFileSync("mv", [join(root, "ordinary.txt"), join(root, ".env")], { cwd: root });
  const head = commit(root, "rename into env");
  const result = runScanner(root, "--range", `${base}..${head}`);
  assertFindingPaths(result, "credential-file", [".env"]);
}));

test("commit scanning covers every forbidden path context for one deduplicated blob", () => withRepo((root) => {
  const token = ["ghp_", "x".repeat(40)].join("");
  writeFileSync(join(root, ".env"), token);
  writeFileSync(join(root, "session.jsonl"), token);
  writeFileSync(join(root, "notes.txt"), token);
  const head = commit(root, "duplicate secret contexts");
  const result = runScanner(root, "--commit", head);
  assertFindingPaths(result, "credential-file", [".env"]);
  assertFindingPaths(result, "raw-session-jsonl", ["session.jsonl"]);
  assertFindingPaths(result, "github-token", [".env", "session.jsonl", "notes.txt"]);
  assert.ok(!result.output.includes(token));
}));

test("all-ref scanning detects a forbidden alias on a non-current branch", () => withRepo((root) => {
  git(root, "checkout", "--quiet", "-b", "historical-alias");
  writeFileSync(join(root, ".env"), "safe branch alias\n");
  commit(root, "non-current env alias");
  git(root, "checkout", "--quiet", "main");
  const result = runScanner(root, "--all-refs");
  assertFindingPaths(result, "credential-file", [".env"]);
}));

test("path-context limits fail closed without truncating the scan", () => withRepo((root) => {
  writeFileSync(join(root, "second.txt"), "second path\n");
  const head = commit(root, "second path for context limit");
  const result = runScanner(root, "--commit", head, "--max-path-contexts", "1");
  assert.equal(result.json.status, "unscanned-input", result.output);
  assert.equal(result.json.code, "unscanned-path-context-limit");
}));

test("commit limits fail closed without truncating the scan", () => withRepo((root) => {
  const base = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "one.txt"), "one\n");
  commit(root, "first introduced commit");
  writeFileSync(join(root, "two.txt"), "two\n");
  const head = commit(root, "second introduced commit");
  const result = runScanner(root, "--range", `${base}..${head}`, "--max-commits", "1");
  assert.equal(result.json.status, "unscanned-input", result.output);
  assert.equal(result.json.code, "unscanned-commit-limit");
}));

test("pull-request event scope scans the exact introduced range", () => withRepo((root) => {
  const base = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "pr-secret.txt"), ["sk-ant-", "x".repeat(32)].join(""));
  const head = commit(root, "pull request secret");
  const event = eventFile(root, publicRepository(), {
    pull_request: {
      base: { sha: base, repo: { full_name: expectedRepository } },
      head: { sha: head, repo: { full_name: expectedRepository } },
    },
  });
  const result = runScanner(root, "--event-scope", "--event-name", "pull_request", "--require-public-review", "--repository", expectedRepository, "--ci-event", event);
  assertBlocked(result, "anthropic-key");
  assert.ok(result.json.scopes.includes("event-scope"));
}));

test("ordinary push event scope scans before..after and the resulting tree", () => withRepo((root) => {
  const before = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "push-secret.txt"), ["AIza", "x".repeat(24)].join(""));
  const after = commit(root, "push secret");
  const event = eventFile(root, publicRepository(), { before, after, ref: "refs/heads/main" });
  const result = runScanner(root, "--event-scope", "--event-name", "push", "--require-public-review", "--repository", expectedRepository, "--ci-event", event);
  assertBlocked(result, "google-api-key");
}));

test("new-branch push event scope scans complete newly reachable ancestry", () => withRepo((root) => {
  writeFileSync(join(root, "new-branch-secret.txt"), ["npm_", "x".repeat(36)].join(""));
  const after = commit(root, "new branch secret");
  const event = eventFile(root, publicRepository(), { before: "0".repeat(40), after, ref: "refs/heads/new-branch" });
  const result = runScanner(root, "--event-scope", "--event-name", "push", "--require-public-review", "--repository", expectedRepository, "--ci-event", event);
  assertBlocked(result, "npm-token");
}));

test("scheduled event scope scans all fetched refs", () => withRepo((root) => {
  git(root, "checkout", "--quiet", "-b", "scheduled-hidden");
  writeFileSync(join(root, "scheduled-secret.txt"), ["sk-proj-", "x".repeat(32)].join(""));
  commit(root, "scheduled hidden secret");
  git(root, "checkout", "--quiet", "main");
  const event = eventFile(root, publicRepository());
  const result = runScanner(root, "--event-scope", "--event-name", "schedule", "--require-public-review", "--repository", expectedRepository, "--ci-event", event);
  assertBlocked(result, "openai-key");
}));

test("workflow-dispatch event scope scans all fetched refs", () => withRepo((root) => {
  git(root, "checkout", "--quiet", "-b", "manual-hidden");
  writeFileSync(join(root, "manual-secret.txt"), ["xoxb-", "x".repeat(20)].join(""));
  commit(root, "manual hidden secret");
  git(root, "checkout", "--quiet", "main");
  const event = eventFile(root, publicRepository());
  const result = runScanner(root, "--event-scope", "--event-name", "workflow_dispatch", "--require-public-review", "--repository", expectedRepository, "--ci-event", event);
  assertBlocked(result, "slack-token");
}));

test("incomplete event-scope payload fails closed", () => withRepo((root) => {
  const event = eventFile(root, publicRepository());
  const result = runScanner(root, "--event-scope", "--event-name", "pull_request", "--require-public-review", "--repository", expectedRepository, "--ci-event", event);
  assert.equal(result.json.status, "invalid-invocation", result.output);
  assert.equal(result.json.code, "pull-request-event-incomplete");
  assert.ok(!result.output.includes(root));
}));
