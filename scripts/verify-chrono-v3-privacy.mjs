#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const syntheticFixturePrefix = "packages/pi-chrono-compaction/test/fixtures/";
const forbiddenPathParts = [
  /(?:^|\/)\.chrono-v3-private(?:\/|$)/u,
  /(?:^|\/)(?:\.env(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$))/iu,
  /(?:^|\/)[^/]+\.(?:pem|key|p12|pfx|sqlite|sqlite3|db|core)$/iu,
  /(?:^|\/)(?:worker-diagnostics|scheduler-artifacts?)(?:\/|\.|$)/iu,
];
const privateTextPatterns = [
  /\/home\/[A-Za-z0-9._-]+(?:\/|$)/u,
  /\/Users\/[A-Za-z0-9._-]+(?:\/|$)/u,
  /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\|$)/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\bgh[opsu]_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/iu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b/iu,
];

export function isApprovedSyntheticFixture(path) {
  return path.startsWith(syntheticFixturePrefix);
}
export function privacyFindings(path, text) {
  const findings = [];
  for (const pattern of forbiddenPathParts) if (pattern.test(path)) findings.push("forbidden-file-name");
  if (path.toLowerCase().endsWith(".jsonl") && !isApprovedSyntheticFixture(path)) findings.push("raw-session-extension");
  if (path.toLowerCase().endsWith(".jsonl") && isApprovedSyntheticFixture(path) && !text.includes('"type":"session"')) findings.push("unrecognized-jsonl-fixture");
  for (const pattern of privateTextPatterns) if (pattern.test(text)) findings.push("private-or-credential-text");
  return [...new Set(findings)];
}
function gitPaths(...args) {
  return execFileSync("git", [...args, "-z"], { cwd: root }).toString("utf8").split("\0").filter(Boolean);
}
function repositoryPaths() {
  return gitPaths("ls-files", "-co", "--exclude-standard");
}
function indexPaths() {
  return gitPaths("ls-files");
}
function indexBytes(path) {
  try {
    return execFileSync("git", ["show", `:${path}`], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}
function runSelfTest() {
  const token = "ghp_" + "x".repeat(40);
  const privatePath = "/" + "home" + "/owner/private/session.jsonl";
  const credentialUrl = "https://" + "user:password@example.invalid/";
  const assertFinding = (path, text, expected) => {
    const findings = privacyFindings(path, text);
    if (!findings.includes(expected)) throw new Error(`privacy self-test missing ${expected}`);
  };
  assertFinding("safe.txt", token, "private-or-credential-text");
  assertFinding("safe.txt", privatePath, "private-or-credential-text");
  assertFinding("safe.txt", credentialUrl, "private-or-credential-text");
  assertFinding("private.sqlite", "fixture", "forbidden-file-name");
  if (privacyFindings("packages/pi-chrono-compaction/test/fixtures/session.jsonl", '{"type":"session"}\n').length !== 0) throw new Error("synthetic fixture self-test rejected");
  if (privacyFindings("notes.txt", "~/.pi/agent and a deterministic identifier").length !== 0) throw new Error("safe documentation self-test rejected");
}
function main() {
  if (process.argv.includes("--self-test")) runSelfTest();
  const worktreePaths = repositoryPaths();
  const indexPathsToScan = indexPaths();
  const findings = [];
  const seen = new Set();
  const scan = (path, bytes) => {
    if (!bytes || bytes.includes(0)) return;
    for (const reason of privacyFindings(path, bytes.toString("utf8"))) {
      const key = `${path}\0${reason}`;
      if (!seen.has(key)) { seen.add(key); findings.push({ path, reason }); }
    }
  };
  for (const path of worktreePaths) if (existsSync(join(root, path))) scan(path, readFileSync(join(root, path)));
  for (const path of indexPathsToScan) scan(path, indexBytes(path));
  if (findings.length > 0) {
    console.error(JSON.stringify({ schemaVersion: 1, status: "failed", findingCount: findings.length, findings }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ schemaVersion: 1, status: "ok", selfTest: process.argv.includes("--self-test"), scannedRepositoryFiles: new Set([...worktreePaths, ...indexPathsToScan]).size, scannedWorktreeFiles: worktreePaths.length, scannedIndexFiles: indexPathsToScan.length }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
