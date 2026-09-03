#!/usr/bin/env node
/**
 * ChronoCompact publication-content and public-review-access verifier.
 *
 * The scanner is intentionally content-focused. Repository visibility is an
 * independent public-review precondition supplied by the CI event payload.
 * All reads are bounded and findings never contain matched bytes.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_GIT_LIST_BYTES = 64 * 1024 * 1024;
const syntheticFixturePrefix = "packages/pi-chrono-compaction/test/fixtures/";
const approvedHistoricalFixtures = new Map([
  ["packages/herdr-status/test/sanitize.test.ts", "1590f61a6f57accf641d4093d588b5b531f33662"],
  ["packages/pi-herdr-orchestrator/vendor/pi-chrono-compact-2.0.0-herdr.1.tgz", "1ee946bc730487d849a7d9ab74af8ceb47cda76f"],
]);
const uuidFilename = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.[^/]+)?$/iu;

const textPatterns = [
  ["private-key", /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/u],
  ["github-token", /\bgh[opsu]_[A-Za-z0-9]{20,}\b/u],
  ["github-token", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u],
  ["openai-key", /\bsk-proj-[A-Za-z0-9_-]{20,}\b/u],
  ["openai-key", /\bsk-[A-Za-z0-9_-]{20,}\b/u],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/u],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u],
  ["aws-secret-assignment", /\b(?:aws[_-]?secret[_-]?access[_-]?key|secret[_-]?access[_-]?key|awsSecretAccessKey)\s*[:=]\s*["']?[A-Za-z0-9/+=]{20,}/iu],
  ["google-api-key", /\bAIza[A-Za-z0-9_-]{20,}\b/u],
  ["azure-client-secret", /\b(?:AZURE_CLIENT_SECRET|client[_-]?secret|clientSecret)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{16,}/iu],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u],
  ["npm-token", /\bnpm_[A-Za-z0-9]{30,}\b/u],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b/iu],
  ["credential-url", /https?:\/\/[^\s/@:]+:[^\s/@]+@/iu],
  ["generic-credential-assignment", /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{20,}/iu],
  ["absolute-private-path", /(?:\/home\/[A-Za-z0-9._-]+(?:\/|$)|\/Users\/[A-Za-z0-9._-]+(?:\/|$)|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\|$))/u],
];

export class PrivacyScanError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function normalizePath(path) {
  return String(path).replaceAll("\\", "/").replace(/^\.\//u, "");
}

function isSafeRepositoryPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") || path.includes("\\")) return false;
  if (path.startsWith("/") || /^[A-Za-z]:(?:\/|$)/u.test(path)) return false;
  if (/[\u0000-\u001f\u007f]/u.test(path)) return false;
  return !path.split("/").some((part) => part.length === 0 || part === "." || part === "..");
}

function displayPath(path) {
  const normalized = normalizePath(path ?? "<repository>");
  return isSafeRepositoryPath(normalized) ? normalized : "<unsafe-path>";
}

export function isApprovedSyntheticFixture(path) {
  return normalizePath(path).startsWith(syntheticFixturePrefix);
}

function isApprovedHistoricalFixture(path, objectId, scope) {
  if (!objectId || scope === "worktree" || scope === "index") return false;
  return approvedHistoricalFixtures.get(normalizePath(path)) === objectId;
}

function pathCategories(path) {
  const normalized = normalizePath(path);
  const lower = normalized.toLowerCase();
  const base = lower.split("/").at(-1) ?? lower;
  const categories = [];
  if (lower.includes(".chrono-v3-private") || lower.includes("privacy-containment") || lower.includes("incident-evidence") || lower.includes("scanner-output")) {
    categories.push("private-evidence-path");
  }
  if (/(^|\/)\.env(?:\.[^/]+)?$/iu.test(normalized) || base === ".npmrc" || base === ".netrc") {
    categories.push("credential-file");
  }
  if (/(^|\/)[^/]+\.(?:pem|key|p12|pfx|sqlite|sqlite3|db|core|dmp|hprof|heap)$/iu.test(normalized)) {
    categories.push("private-artifact-file");
  }
  if (/(?:\.tar|\.tar\.gz|\.tgz|\.zip|\.7z|\.rar|\.dump|\.bak)$/iu.test(lower)) {
    categories.push("opaque-archive");
  }
  if (/(?:\.log|\.out|\.trace)$/iu.test(lower)) {
    categories.push("raw-log");
  }
  if (uuidFilename.test(base)) categories.push("session-uuid-filename");
  if (lower.endsWith(".jsonl") && !isApprovedSyntheticFixture(normalized)) categories.push("raw-session-jsonl");
  if (!isApprovedSyntheticFixture(normalized) && /(^|\/)(?:cookies?|browser-profile|auth(?:entication)?|credentials?|tokens?|secrets?|session(?:s)?)(?:\.[^/]+)?$/iu.test(normalized) && /\.(?:json|sqlite|sqlite3|db|dump|log|txt|jsonl)$/iu.test(base)) {
    categories.push("private-data-file");
  }
  return [...new Set(categories)];
}

function textFindingCategories(text) {
  const categories = [];
  for (const [category, pattern] of textPatterns) if (pattern.test(text)) categories.push(category);
  return [...new Set(categories)];
}

/** Compatibility helper used by the original M00 verifier and its callers. */
export function privacyFindings(path, text) {
  return [...new Set([...pathCategories(path), ...textFindingCategories(text)])];
}

function parseArgs(argv) {
  const modes = [];
  const options = {
    root: DEFAULT_ROOT,
    maxBytes: DEFAULT_MAX_BYTES,
    selfTest: false,
    requirePublicReview: false,
    repository: undefined,
    ciEvent: undefined,
  };
  const valueOptions = new Set(["--commit", "--range", "--ci-event", "--repository", "--root", "--repository-root", "--max-bytes", "--object"]);
  const modeOptions = new Set(["--worktree", "--index", "--all-refs", "--self-test"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (modeOptions.has(arg)) {
      if (arg === "--self-test") options.selfTest = true;
      else modes.push({ mode: arg.slice(2) });
      continue;
    }
    if (arg === "--require-public-review") {
      options.requirePublicReview = true;
      continue;
    }
    if (valueOptions.has(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new PrivacyScanError("invalid-invocation", `${arg}-requires-value`);
      index += 1;
      if (arg === "--commit") modes.push({ mode: "commit", value });
      else if (arg === "--range") modes.push({ mode: "range", value });
      else if (arg === "--object") modes.push({ mode: "object", value });
      else if (arg === "--ci-event") options.ciEvent = value;
      else if (arg === "--repository") options.repository = value;
      else if (arg === "--root" || arg === "--repository-root") options.root = resolve(value);
      else if (arg === "--max-bytes") {
        if (!/^\d+$/u.test(value) || Number(value) < 1) throw new PrivacyScanError("invalid-invocation", "invalid-max-bytes");
        options.maxBytes = Number(value);
      }
      continue;
    }
    throw new PrivacyScanError("invalid-invocation", "unknown-option");
  }
  if (modes.length === 0) modes.push({ mode: "worktree" }, { mode: "index" });
  if (options.requirePublicReview && (!options.repository || !options.ciEvent)) throw new PrivacyScanError("invalid-invocation", "public-review-requires-repository-and-ci-event");
  return { modes, options };
}

function safeGit(root, args, { encoding = null, maxBuffer = MAX_GIT_LIST_BYTES } = {}) {
  try {
    return execFileSync("git", args, { cwd: root, encoding, maxBuffer, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    if (error?.code === "ENOENT") throw new PrivacyScanError("unavailable-dependency", "git-unavailable");
    throw new PrivacyScanError("unscanned-input", "git-read-failed");
  }
}

function readBoundedFile(path, maxBytes) {
  let descriptor;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return { kind: "symlink" };
    if (!stat.isFile()) return { kind: "unsupported-file" };
    if (stat.size > maxBytes) return { kind: "oversize", size: stat.size };
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    descriptor = openSync(path, flags);
    const chunks = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, maxBytes));
    while (true) {
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) return { kind: "oversize", size: total };
      chunks.push(Buffer.from(chunk.subarray(0, count)));
    }
    return { kind: "file", bytes: Buffer.concat(chunks, total) };
  } catch {
    return { kind: "unreadable" };
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
  }
}

function lineNumber(bytes, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (bytes[index] === 0x0a) line += 1;
  return line;
}

function isBinary(bytes) {
  if (bytes.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return true;
  }
  for (const byte of bytes.subarray(0, Math.min(bytes.length, 8192))) {
    if (byte < 0x20 && ![0x09, 0x0a, 0x0d].includes(byte)) return true;
  }
  return false;
}

function addFinding(findings, seen, finding) {
  const normalized = {
    path: displayPath(finding.path),
    category: finding.category,
    scope: finding.scope,
  };
  if (finding.objectId) normalized.objectId = finding.objectId.slice(0, 12);
  if (finding.line !== undefined) normalized.location = { line: finding.line };
  else if (finding.location) normalized.location = finding.location;
  const key = JSON.stringify(normalized);
  if (!seen.has(key)) {
    seen.add(key);
    findings.push(normalized);
  }
}

function scanBytes(path, bytes, scope, objectId, findings, seen, maxBytes) {
  const approvedHistorical = isApprovedHistoricalFixture(path, objectId, scope);
  for (const category of pathCategories(path)) {
    // Approved synthetic fixtures are validated below. Two historical
    // repository fixtures are retained only for their known test/archive
    // purpose and do not bypass credential scanning elsewhere.
    if (category === "raw-session-jsonl" && isApprovedSyntheticFixture(path)) continue;
    if (approvedHistorical && (category === "credential-url" || category === "opaque-archive")) continue;
    addFinding(findings, seen, { path, objectId, category, scope });
  }
  if (isBinary(bytes)) {
    if (approvedHistorical && path.toLowerCase().endsWith(".tgz")) return;
    addFinding(findings, seen, { path, objectId, category: "binary-or-nul", scope });
    return;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (isApprovedSyntheticFixture(path) && path.toLowerCase().endsWith(".jsonl")) {
    const firstLine = text.split("\n", 1)[0];
    try {
      const header = JSON.parse(firstLine);
      if (!header || header.type !== "session") addFinding(findings, seen, { path, objectId, category: "invalid-synthetic-jsonl", scope });
    } catch {
      addFinding(findings, seen, { path, objectId, category: "invalid-synthetic-jsonl", scope });
    }
  }
  for (const [category, pattern] of textPatterns) {
    const match = pattern.exec(text);
    pattern.lastIndex = 0;
    if (match && !(approvedHistorical && category === "credential-url")) {
      addFinding(findings, seen, { path, objectId, category, scope, line: lineNumber(bytes, Buffer.byteLength(text.slice(0, match.index), "utf8")) });
    }
  }
  // Keep this assertion local to the bounded read so callers cannot silently
  // pass an unexpectedly large buffer into the aggregate finding set.
  if (bytes.length > maxBytes) addFinding(findings, seen, { path, objectId, category: "unscanned-oversize", scope });
}

function scanWorktree(root, scope, findings, seen, maxBytes, counts) {
  let raw;
  try {
    raw = safeGit(root, ["ls-files", "-co", "--exclude-standard", "-z"]);
  } catch (error) {
    addFinding(findings, seen, { path: ".", category: error.code, scope });
    return;
  }
  const paths = raw.toString("utf8").split("\0").filter(Boolean);
  counts.worktree += paths.length;
  for (const path of paths) {
    if (!isSafeRepositoryPath(path)) {
      addFinding(findings, seen, { path, category: "unsafe-path", scope });
      continue;
    }
    const absolute = join(root, path);
    if (!existsSync(absolute)) {
      addFinding(findings, seen, { path, category: "unscanned-file", scope });
      continue;
    }
    const result = readBoundedFile(absolute, maxBytes);
    if (result.kind === "symlink") {
      addFinding(findings, seen, { path, category: "symlink", scope });
      continue;
    }
    if (result.kind === "unsupported-file") {
      addFinding(findings, seen, { path, category: "unsupported-file", scope });
      continue;
    }
    if (result.kind === "oversize") {
      addFinding(findings, seen, { path, category: "unscanned-oversize", scope });
      continue;
    }
    if (result.kind !== "file") {
      addFinding(findings, seen, { path, category: "unscanned-file", scope });
      continue;
    }
    counts.blobs += 1;
    scanBytes(path, result.bytes, scope, undefined, findings, seen, maxBytes);
  }
}

function parseIndexEntries(raw) {
  return raw.toString("utf8").split("\0").filter(Boolean).map((record) => {
    const tab = record.indexOf("\t");
    if (tab < 0) throw new PrivacyScanError("unscanned-input", "malformed-index-entry");
    const [mode, objectAndStage] = record.slice(0, tab).split(" ");
    const [objectId] = objectAndStage.split("\t");
    return { mode, objectId, path: record.slice(tab + 1) };
  });
}

function readGitObject(root, objectId, maxBytes) {
  try {
    const output = execFileSync("git", ["cat-file", "--batch"], {
      cwd: root,
      input: `${objectId}\n`,
      encoding: null,
      maxBuffer: maxBytes + 8192,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const headerEnd = output.indexOf(0x0a);
    if (headerEnd < 0) return { kind: "unreadable" };
    const header = output.subarray(0, headerEnd).toString("ascii").split(" ");
    if (header[1] === "missing") return { kind: "missing" };
    if (header[1] !== "blob") return { kind: "non-blob", type: header[1] };
    const size = Number(header[2]);
    if (!Number.isSafeInteger(size) || size < 0) return { kind: "unreadable" };
    if (size > maxBytes) return { kind: "oversize", size };
    const start = headerEnd + 1;
    if (output.length < start + size) return { kind: "unreadable" };
    return { kind: "blob", bytes: output.subarray(start, start + size) };
  } catch (error) {
    if (error?.code === "ENOENT") throw new PrivacyScanError("unavailable-dependency", "git-unavailable");
    if (error?.code === "ENOBUFS") return { kind: "oversize" };
    return { kind: "unreadable" };
  }
}

function scanIndex(root, findings, seen, maxBytes, counts) {
  let raw;
  try {
    raw = safeGit(root, ["ls-files", "-s", "-z"]);
  } catch (error) {
    addFinding(findings, seen, { path: ".", category: error.code, scope: "index" });
    return;
  }
  const entries = parseIndexEntries(raw);
  counts.index += entries.length;
  const byObject = new Map();
  for (const entry of entries) {
    if (!isSafeRepositoryPath(entry.path)) {
      addFinding(findings, seen, { path: entry.path, objectId: entry.objectId, category: "unsafe-path", scope: "index" });
      continue;
    }
    if (entry.mode === "120000") {
      addFinding(findings, seen, { path: entry.path, objectId: entry.objectId, category: "symlink", scope: "index" });
      continue;
    }
    if (!byObject.has(entry.objectId)) byObject.set(entry.objectId, []);
    byObject.get(entry.objectId).push(entry.path);
  }
  counts.blobs += byObject.size;
  for (const [objectId, paths] of byObject) {
    const result = readGitObject(root, objectId, maxBytes);
    if (result.kind === "oversize") {
      for (const path of paths) addFinding(findings, seen, { path, objectId, category: "unscanned-oversize", scope: "index" });
    } else if (result.kind !== "blob") {
      for (const path of paths) addFinding(findings, seen, { path, objectId, category: "unscanned-blob", scope: "index" });
    } else {
      for (const path of paths) scanBytes(path, result.bytes, "index", objectId, findings, seen, maxBytes);
    }
  }
}

function parseRevList(raw) {
  const records = [];
  for (const line of raw.toString("utf8").split("\n")) {
    if (!line) continue;
    const match = /^(?<object>[0-9a-f]{40})\s?(?<path>.*)$/u.exec(line);
    if (!match) throw new PrivacyScanError("unscanned-input", "malformed-object-list");
    records.push({ objectId: match.groups.object, path: match.groups.path || "<object>" });
  }
  return records;
}

function scanObjectRecords(root, records, scope, findings, seen, maxBytes, counts) {
  const byObject = new Map();
  for (const record of records) {
    if (!isSafeRepositoryPath(record.path)) {
      addFinding(findings, seen, { path: record.path, objectId: record.objectId, category: "unsafe-path", scope });
      continue;
    }
    if (!byObject.has(record.objectId)) byObject.set(record.objectId, []);
    byObject.get(record.objectId).push(record);
  }
  for (const [objectId, objectRecords] of byObject) {
    const result = readGitObject(root, objectId, maxBytes);
    if (result.kind === "blob") {
      counts.blobs += 1;
      for (const record of objectRecords) {
        if (record.mode === "120000") {
          addFinding(findings, seen, { path: record.path, objectId, category: "symlink", scope });
          continue;
        }
        // rev-list includes commits and trees. Only blob objects carry file
        // content; all object reads remain bounded to one blob at a time.
        scanBytes(record.path, result.bytes, scope, objectId, findings, seen, maxBytes);
      }
      continue;
    }
    if (result.kind === "non-blob") continue;
    for (const record of objectRecords) addFinding(findings, seen, { path: record.path, objectId, category: result.kind === "oversize" ? "unscanned-oversize" : "unscanned-blob", scope });
  }
}

function scanCommit(root, commit, findings, seen, maxBytes, counts, scope = "commit", modeOnly = false) {
  let raw;
  try {
    raw = safeGit(root, ["ls-tree", "-r", "-z", "--full-tree", commit]);
  } catch (error) {
    addFinding(findings, seen, { path: "<commit>", category: error.code, scope });
    return;
  }
  const records = raw.toString("utf8").split("\0").filter(Boolean).map((record) => {
    const match = /^(?<mode>\d+) blob (?<object>[0-9a-f]{40})\t(?<path>.*)$/u.exec(record);
    if (!match) throw new PrivacyScanError("unscanned-input", "malformed-tree-entry");
    return { mode: match.groups.mode, objectId: match.groups.object, path: match.groups.path };
  });
  if (modeOnly) {
    for (const record of records) {
      if (!isSafeRepositoryPath(record.path)) addFinding(findings, seen, { path: record.path, objectId: record.objectId, category: "unsafe-path", scope });
      else if (record.mode === "120000") addFinding(findings, seen, { path: record.path, objectId: record.objectId, category: "symlink", scope });
    }
    return;
  }
  scanObjectRecords(root, records, scope, findings, seen, maxBytes, counts);
}

function scanRevision(root, revision, scope, findings, seen, maxBytes, counts) {
  let raw;
  try {
    raw = safeGit(root, ["rev-list", "--objects", "--full-history", revision]);
  } catch (error) {
    addFinding(findings, seen, { path: "<revision>", category: error.code, scope });
    return;
  }
  scanObjectRecords(root, parseRevList(raw), scope, findings, seen, maxBytes, counts);
}

function scanAllRefs(root, findings, seen, maxBytes, counts) {
  scanRevision(root, "--all", "all-refs", findings, seen, maxBytes, counts);
  let raw;
  try {
    raw = safeGit(root, ["rev-list", "--all"]);
  } catch (error) {
    addFinding(findings, seen, { path: "<all-refs>", category: error.code, scope: "all-refs" });
    return;
  }
  for (const commit of raw.toString("utf8").split("\n").filter(Boolean)) {
    if (!/^[0-9a-f]{40}$/u.test(commit)) {
      addFinding(findings, seen, { path: "<all-refs>", category: "unscanned-input", scope: "all-refs" });
      continue;
    }
    scanCommit(root, commit, findings, seen, maxBytes, counts, "all-refs", true);
  }
}

function scanObject(root, objectId, findings, seen, maxBytes, counts) {
  if (!/^[0-9a-f]{40}$/u.test(objectId)) {
    addFinding(findings, seen, { path: "<object>", category: "invalid-object-id", scope: "object" });
    return;
  }
  const result = readGitObject(root, objectId, maxBytes);
  if (result.kind !== "blob") {
    addFinding(findings, seen, { path: "<object>", objectId, category: result.kind === "oversize" ? "unscanned-oversize" : "unscanned-blob", scope: "object" });
    return;
  }
  scanBytes("<object>", result.bytes, "object", objectId, findings, seen, maxBytes);
}

function parseEvent(path) {
  const result = readBoundedFile(path, MAX_EVENT_BYTES);
  if (result.kind !== "file") throw new PrivacyScanError("invalid-invocation", "invalid-ci-event");
  try {
    const value = JSON.parse(result.bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not-object");
    return value;
  } catch {
    throw new PrivacyScanError("invalid-invocation", "invalid-ci-event");
  }
}

function verifyPublicReview(root, expectedRepository, eventPath, findings, seen) {
  const event = parseEvent(eventPath);
  const repository = event.repository;
  if (!repository || typeof repository !== "object" || Array.isArray(repository)) throw new PrivacyScanError("invalid-invocation", "ci-event-lacks-repository");
  if (repository.full_name !== expectedRepository) {
    addFinding(findings, seen, { path: "repository", category: "wrong-repository-identity", scope: "public-review" });
    return;
  }
  if (repository.visibility !== "public" || repository.private !== false) {
    addFinding(findings, seen, { path: "repository", category: "private-repository-visibility", scope: "public-review" });
  }
  if (repository.fork !== false) addFinding(findings, seen, { path: "repository", category: "public-fork", scope: "public-review" });
  if (repository.visibility === "public" && repository.private === false && repository.fork === false) {
    // The successful identity is represented in the aggregate status only.
  }
  // A repository-root option is deliberately accepted for synthetic tests; no
  // network request or credential lookup is performed by this verifier.
  void root;
}

function runSelfTest() {
  const token = ["ghp_", "x".repeat(40)].join("");
  const openai = ["sk-", "x".repeat(32)].join("");
  const anthropic = ["sk-ant-", "x".repeat(32)].join("");
  const privatePath = ["/", "home", "/owner/private/session.jsonl"].join("");
  const credentialUrl = ["https://", "user:password@example.invalid/"].join("");
  const assert = (condition, code) => { if (!condition) throw new PrivacyScanError("invalid-invocation", code); };
  assert(privacyFindings("safe.txt", token).includes("github-token"), "self-test-github-token");
  assert(privacyFindings("safe.txt", openai).includes("openai-key"), "self-test-openai-key");
  assert(privacyFindings("safe.txt", anthropic).includes("anthropic-key"), "self-test-anthropic-key");
  assert(privacyFindings("safe.txt", privatePath).includes("absolute-private-path"), "self-test-private-path");
  assert(privacyFindings("safe.txt", credentialUrl).includes("credential-url"), "self-test-credential-url");
  assert(privacyFindings("private.sqlite", "fixture").includes("private-artifact-file"), "self-test-private-file");
  assert(privacyFindings(`${syntheticFixturePrefix}session.jsonl`, '{"type":"session"}\n').length === 0, "self-test-synthetic-fixture");
  assert(privacyFindings("notes.txt", "deterministic identifier").length === 0, "self-test-safe-documentation");
}

function outputResult({ status, selfTest, scopes, findings, counts, code }) {
  const sortedFindings = [...findings].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const result = {
    schemaVersion: 2,
    status,
    selfTest,
    scopes: [...new Set(scopes)].sort(),
    scannedBlobCount: counts.blobs,
    scannedWorktreeFiles: counts.worktree,
    scannedIndexFiles: counts.index,
    findingCount: sortedFindings.length,
    findings: sortedFindings,
  };
  if (code) result.code = code;
  const stream = status === "passed" ? process.stdout : process.stderr;
  stream.write(`${JSON.stringify(result, null, 2)}\n`);
  return status === "passed" ? 0 : 1;
}

export async function run(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    const status = error instanceof PrivacyScanError ? error.status : "invalid-invocation";
    return outputResult({ status, selfTest: false, scopes: [], findings: [], counts: { blobs: 0, worktree: 0, index: 0 }, code: error.code ?? "invalid-invocation" });
  }
  const { modes, options } = parsed;
  const findings = [];
  const seen = new Set();
  const scopes = [];
  const counts = { blobs: 0, worktree: 0, index: 0 };
  try {
    if (options.selfTest) runSelfTest();
    if (options.requirePublicReview) {
      verifyPublicReview(options.root, options.repository, options.ciEvent, findings, seen);
      scopes.push("public-review");
    } else if (options.ciEvent) {
      parseEvent(options.ciEvent);
      scopes.push("ci-event");
    }
    for (const mode of modes) {
      if (mode.mode === "worktree") {
        scopes.push("worktree");
        scanWorktree(options.root, "worktree", findings, seen, options.maxBytes, counts);
      } else if (mode.mode === "index") {
        scopes.push("index");
        scanIndex(options.root, findings, seen, options.maxBytes, counts);
      } else if (mode.mode === "commit") {
        scopes.push("commit");
        scanCommit(options.root, mode.value, findings, seen, options.maxBytes, counts);
      } else if (mode.mode === "range") {
        scopes.push("range");
        scanRevision(options.root, mode.value, "range", findings, seen, options.maxBytes, counts);
      } else if (mode.mode === "all-refs") {
        scopes.push("all-refs");
        scanAllRefs(options.root, findings, seen, options.maxBytes, counts);
      } else if (mode.mode === "object") {
        scopes.push("object");
        scanObject(options.root, mode.value, findings, seen, options.maxBytes, counts);
      }
    }
    const hasUnscanned = findings.some((finding) => finding.category.startsWith("unscanned-") || finding.category === "unreadable" || finding.category === "unscanned-file");
    const status = findings.length === 0 ? "passed" : hasUnscanned ? "unscanned-input" : "blocked";
    return outputResult({ status, selfTest: options.selfTest, scopes, findings, counts, code: undefined });
  } catch (error) {
    const status = error instanceof PrivacyScanError ? error.status : "unscanned-input";
    return outputResult({ status, selfTest: options.selfTest, scopes, findings, counts, code: error.code ?? "unscanned-input" });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const exitCode = await run();
  process.exitCode = exitCode;
}
