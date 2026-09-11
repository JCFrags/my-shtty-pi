#!/usr/bin/env node
/**
 * ChronoCompact publication-content and public-review verifier.
 *
 * Blob bytes and historical path/mode contexts are intentionally scanned as
 * separate bounded concerns. Every emitted finding is sanitized: it contains
 * no matched bytes, local root, or private diagnostic path.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_COMMITS = 10_000;
const DEFAULT_MAX_PATH_CONTEXTS = 500_000;
const DEFAULT_MAX_GIT_LIST_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;
const syntheticFixturePrefix = "packages/pi-chrono-compaction/test/fixtures/";
const CANONICAL_REPOSITORY = "JCFrags/my-shtty-pi";
const approvedHistoricalFixtures = new Map([
  ["packages/herdr-status/test/sanitize.test.ts", "1590f61a6f57accf641d4093d588b5b531f33662"],
  ["packages/pi-herdr-orchestrator/vendor/pi-chrono-compact-2.0.0-herdr.1.tgz", "1ee946bc730487d849a7d9ab74af8ceb47cda76f"],
  ["packages/chrono-compact/test/fixtures/session.jsonl", "3ba5c247bbf021482451b145636abcb7d86b108c"],
  ["packages/chrono-compact/examples/synthetic-session.jsonl", "3ba5c247bbf021482451b145636abcb7d86b108c"],
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

export function isSafeRepositoryPath(path) {
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
  if (/(^|\/)\.env(?:\.[^/]+)?$/iu.test(normalized) || base === ".npmrc" || base === ".netrc") categories.push("credential-file");
  if (/(^|\/)[^/]+\.(?:pem|key|p12|pfx|sqlite|sqlite3|db|core|dmp|hprof|heap)$/iu.test(normalized)) categories.push("private-artifact-file");
  if (/(?:\.tar|\.tar\.gz|\.tgz|\.zip|\.7z|\.rar|\.dump|\.bak)$/iu.test(lower)) categories.push("opaque-archive");
  if (/(?:\.log|\.out|\.trace)$/iu.test(lower)) categories.push("raw-log");
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

function parsePositiveInteger(value, code) {
  if (!/^\d+$/u.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) throw new PrivacyScanError("invalid-invocation", code);
  return Number(value);
}

function parseArgs(argv) {
  const modes = [];
  const options = {
    root: DEFAULT_ROOT,
    maxBytes: DEFAULT_MAX_BYTES,
    maxCommits: DEFAULT_MAX_COMMITS,
    maxPathContexts: DEFAULT_MAX_PATH_CONTEXTS,
    maxGitListBytes: DEFAULT_MAX_GIT_LIST_BYTES,
    selfTest: false,
    requirePublicReview: false,
    eventScope: false,
    repository: undefined,
    ciEvent: undefined,
    eventName: undefined,
  };
  const valueOptions = new Set([
    "--commit", "--range", "--ci-event", "--event-name", "--repository", "--root", "--repository-root", "--max-bytes",
    "--max-commits", "--max-path-contexts", "--max-git-list-bytes", "--object",
  ]);
  const modeOptions = new Set(["--worktree", "--index", "--all-refs", "--self-test", "--event-scope"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (modeOptions.has(arg)) {
      if (arg === "--self-test") options.selfTest = true;
      else if (arg === "--event-scope") options.eventScope = true;
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
      else if (arg === "--event-name") options.eventName = value;
      else if (arg === "--repository") options.repository = value;
      else if (arg === "--root" || arg === "--repository-root") options.root = resolve(value);
      else if (arg === "--max-bytes") options.maxBytes = parsePositiveInteger(value, "invalid-max-bytes");
      else if (arg === "--max-commits") options.maxCommits = parsePositiveInteger(value, "invalid-max-commits");
      else if (arg === "--max-path-contexts") options.maxPathContexts = parsePositiveInteger(value, "invalid-max-path-contexts");
      else if (arg === "--max-git-list-bytes") options.maxGitListBytes = parsePositiveInteger(value, "invalid-max-git-list-bytes");
      continue;
    }
    throw new PrivacyScanError("invalid-invocation", "unknown-option");
  }
  if (options.eventScope && modes.length > 0) throw new PrivacyScanError("invalid-invocation", "event-scope-conflicts-with-explicit-mode");
  if (!options.eventScope && modes.length === 0) modes.push({ mode: "worktree" }, { mode: "index" });
  if (options.requirePublicReview && (!options.repository || !options.ciEvent)) throw new PrivacyScanError("invalid-invocation", "public-review-requires-repository-and-ci-event");
  if (options.eventScope && (!options.repository || !options.ciEvent || !options.eventName)) throw new PrivacyScanError("invalid-invocation", "event-scope-requires-event-name-repository-and-ci-event");
  return { modes, options };
}

function safeGit(root, args, { encoding = null, maxBuffer = DEFAULT_MAX_GIT_LIST_BYTES } = {}) {
  try {
    return execFileSync("git", args, { cwd: root, encoding, maxBuffer, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    if (error?.code === "ENOENT") throw new PrivacyScanError("unavailable-dependency", "git-unavailable");
    if (error?.code === "ENOBUFS") throw new PrivacyScanError("unscanned-input", "unscanned-git-list-limit");
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
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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
  if (finding.commit) normalized.commit = /^[0-9a-f]{40}$/u.test(finding.commit) ? finding.commit : "<commit>";
  if (finding.line !== undefined) normalized.location = { line: finding.line };
  else if (finding.location) normalized.location = finding.location;
  const key = JSON.stringify(normalized);
  if (!seen.has(key)) {
    seen.add(key);
    findings.push(normalized);
  }
}

function checkPathContext(context, findings, seen, counts, maxPathContexts) {
  counts.pathContexts += 1;
  if (counts.pathContexts > maxPathContexts) throw new PrivacyScanError("unscanned-input", "unscanned-path-context-limit");
  const { path, objectId, scope, mode, commit } = context;
  if (!isSafeRepositoryPath(path)) {
    addFinding(findings, seen, { path, objectId, category: "unsafe-path", scope, commit });
    return false;
  }
  if (mode === "120000") {
    addFinding(findings, seen, { path, objectId, category: "symlink", scope, commit });
    return false;
  }
  if (mode !== undefined && !["100644", "100755", "100664", "100775"].includes(mode)) {
    addFinding(findings, seen, { path, objectId, category: "unsupported-tree-mode", scope, commit });
    return false;
  }
  const approvedHistorical = isApprovedHistoricalFixture(path, objectId, scope);
  for (const category of pathCategories(path)) {
    if (approvedHistorical && ["opaque-archive", "raw-session-jsonl", "private-data-file"].includes(category)) continue;
    addFinding(findings, seen, { path, objectId, category, scope, commit });
  }
  return mode === undefined || mode === "100644" || mode === "100755" || mode === "100664" || mode === "100775";
}

function validateSyntheticJsonl(context, bytes, findings, seen) {
  const path = normalizePath(context.path);
  if (!isApprovedSyntheticFixture(path) || !path.toLowerCase().endsWith(".jsonl")) return;
  let valid = false;
  try {
    const header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\n", 1)[0]);
    valid = Boolean(header && header.type === "session");
  } catch {
    valid = false;
  }
  if (!valid) addFinding(findings, seen, { path, objectId: context.objectId, category: "invalid-synthetic-jsonl", scope: context.scope, commit: context.commit });
}

function historicalSuppressed(category, context) {
  if (!isApprovedHistoricalFixture(context.path, context.objectId, context.scope)) return false;
  if (category === "credential-url" && normalizePath(context.path) === "packages/herdr-status/test/sanitize.test.ts") return true;
  if (category === "binary-or-nul" && normalizePath(context.path).toLowerCase().endsWith(".tgz")) return true;
  if (["raw-session-jsonl", "private-data-file"].includes(category) && ["packages/chrono-compact/test/fixtures/session.jsonl", "packages/chrono-compact/examples/synthetic-session.jsonl"].includes(normalizePath(context.path))) return true;
  return false;
}

function contentResult(bytes, maxBytes) {
  if (bytes.length > maxBytes) return { kind: "oversize" };
  if (isBinary(bytes)) return { kind: "binary" };
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const matches = [];
  for (const [category, pattern] of textPatterns) {
    const match = pattern.exec(text);
    pattern.lastIndex = 0;
    if (match) matches.push({ category, line: lineNumber(bytes, Buffer.byteLength(text.slice(0, match.index), "utf8")) });
  }
  return { kind: "text", matches };
}

function scanBlobContent(key, bytes, context, findings, seen, counts, contentResults, maxBytes) {
  let result = contentResults.get(key);
  if (!result) {
    result = contentResult(bytes, maxBytes);
    contentResults.set(key, result);
    counts.blobs += 1;
  }
  validateSyntheticJsonl(context, bytes, findings, seen);
  if (result.kind === "oversize") {
    addFinding(findings, seen, { path: context.path, objectId: context.objectId, category: "unscanned-oversize", scope: context.scope, commit: context.commit });
    return;
  }
  if (result.kind === "binary") {
    if (!historicalSuppressed("binary-or-nul", context)) addFinding(findings, seen, { path: context.path, objectId: context.objectId, category: "binary-or-nul", scope: context.scope, commit: context.commit });
    return;
  }
  for (const match of result.matches) {
    if (!historicalSuppressed(match.category, context)) {
      addFinding(findings, seen, { path: context.path, objectId: context.objectId, category: match.category, scope: context.scope, line: match.line, commit: context.commit });
    }
  }
}

function scanWorktree(root, findings, seen, counts, contentResults, options) {
  const raw = safeGit(root, ["ls-files", "-co", "--exclude-standard", "-z"], { maxBuffer: options.maxGitListBytes });
  const paths = raw.toString("utf8").split("\0").filter(Boolean);
  counts.worktree += paths.length;
  const byContent = new Map();
  for (const path of paths) {
    const context = { path, scope: "worktree" };
    const eligible = checkPathContext(context, findings, seen, counts, options.maxPathContexts);
    if (!eligible || !isSafeRepositoryPath(path)) continue;
    const absolute = join(root, path);
    const result = readBoundedFile(absolute, options.maxBytes);
    if (result.kind === "symlink") {
      addFinding(findings, seen, { path, category: "symlink", scope: "worktree" });
      continue;
    }
    if (result.kind === "unsupported-file") {
      addFinding(findings, seen, { path, category: "unsupported-file", scope: "worktree" });
      continue;
    }
    if (result.kind === "oversize") {
      addFinding(findings, seen, { path, category: "unscanned-oversize", scope: "worktree" });
      continue;
    }
    if (result.kind !== "file") {
      addFinding(findings, seen, { path, category: "unscanned-file", scope: "worktree" });
      continue;
    }
    const key = `bytes:${sha256(result.bytes)}`;
    if (!byContent.has(key)) byContent.set(key, { bytes: result.bytes, contexts: [] });
    byContent.get(key).contexts.push(context);
  }
  for (const [key, record] of byContent) for (const context of record.contexts) scanBlobContent(key, record.bytes, context, findings, seen, counts, contentResults, options.maxBytes);
}

function parseIndexEntries(raw) {
  return raw.toString("utf8").split("\0").filter(Boolean).map((record) => {
    const tab = record.indexOf("\t");
    if (tab < 0) throw new PrivacyScanError("unscanned-input", "malformed-index-entry");
    const [mode, objectAndStage] = record.slice(0, tab).split(" ");
    const [objectId] = objectAndStage.split("\t");
    if (!/^\d{6}$/u.test(mode) || !/^[0-9a-f]{40}$/u.test(objectId)) throw new PrivacyScanError("unscanned-input", "malformed-index-entry");
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

function scanIndex(root, findings, seen, counts, contentResults, options) {
  const raw = safeGit(root, ["ls-files", "-s", "-z"], { maxBuffer: options.maxGitListBytes });
  const entries = parseIndexEntries(raw);
  counts.index += entries.length;
  const byObject = new Map();
  for (const entry of entries) {
    const context = { ...entry, scope: "index" };
    const eligible = checkPathContext(context, findings, seen, counts, options.maxPathContexts);
    if (!eligible || !isSafeRepositoryPath(entry.path)) continue;
    if (!byObject.has(entry.objectId)) byObject.set(entry.objectId, []);
    byObject.get(entry.objectId).push(context);
  }
  for (const [objectId, contexts] of byObject) {
    const result = readGitObject(root, objectId, options.maxBytes);
    if (result.kind !== "blob") {
      for (const context of contexts) addFinding(findings, seen, { path: context.path, objectId, category: result.kind === "oversize" ? "unscanned-oversize" : "unscanned-blob", scope: "index" });
      continue;
    }
    for (const context of contexts) scanBlobContent(`bytes:${sha256(result.bytes)}`, result.bytes, context, findings, seen, counts, contentResults, options.maxBytes);
  }
}

function parseCommitList(raw) {
  const commits = raw.toString("utf8").split("\n").filter(Boolean);
  for (const commit of commits) if (!/^[0-9a-f]{40}$/u.test(commit)) throw new PrivacyScanError("unscanned-input", "malformed-commit-list");
  return commits;
}

function parseTreeEntries(raw) {
  const entries = [];
  for (const record of raw.toString("utf8").split("\0").filter(Boolean)) {
    const match = /^(?<mode>\d+) (?<type>blob|tree|commit) (?<object>[0-9a-f]{40})\t(?<path>.*)$/u.exec(record);
    if (!match) throw new PrivacyScanError("unscanned-input", "malformed-tree-entry");
    entries.push({ mode: match.groups.mode, type: match.groups.type, objectId: match.groups.object, path: match.groups.path });
  }
  return entries;
}

function scanCommitTree(root, commit, scope, findings, seen, counts, contentResults, options) {
  const raw = safeGit(root, ["ls-tree", "-r", "-z", "--full-tree", commit], { maxBuffer: options.maxGitListBytes });
  for (const entry of parseTreeEntries(raw)) {
    const context = { ...entry, scope, commit };
    const eligible = checkPathContext(context, findings, seen, counts, options.maxPathContexts);
    if (entry.type !== "blob") {
      addFinding(findings, seen, { path: entry.path, objectId: entry.objectId, category: "unscanned-git-entry", scope, commit });
      continue;
    }
    if (!eligible || !isSafeRepositoryPath(entry.path)) continue;
    const result = readGitObject(root, entry.objectId, options.maxBytes);
    if (result.kind !== "blob") {
      addFinding(findings, seen, { path: entry.path, objectId: entry.objectId, category: result.kind === "oversize" ? "unscanned-oversize" : "unscanned-blob", scope, commit });
      continue;
    }
    scanBlobContent(`bytes:${sha256(result.bytes)}`, result.bytes, context, findings, seen, counts, contentResults, options.maxBytes);
  }
}

function scanCommitSet(root, commits, scope, findings, seen, counts, contentResults, options) {
  for (const commit of commits) {
    counts.commits += 1;
    if (counts.commits > options.maxCommits) throw new PrivacyScanError("unscanned-input", "unscanned-commit-limit");
    scanCommitTree(root, commit, scope, findings, seen, counts, contentResults, options);
  }
}

function revisionCommits(root, revision, options) {
  return parseCommitList(safeGit(root, ["rev-list", "--full-history", "--reverse", revision], { maxBuffer: options.maxGitListBytes }));
}

function scanRevision(root, revision, scope, findings, seen, counts, contentResults, options) {
  scanCommitSet(root, revisionCommits(root, revision, options), scope, findings, seen, counts, contentResults, options);
}

function scanAllRefs(root, findings, seen, counts, contentResults, options) {
  scanRevision(root, "--all", "all-refs", findings, seen, counts, contentResults, options);
}

function scanObject(root, objectId, findings, seen, counts, contentResults, options) {
  if (!/^[0-9a-f]{40}$/u.test(objectId)) {
    addFinding(findings, seen, { path: "<object>", category: "invalid-object-id", scope: "object" });
    return;
  }
  const result = readGitObject(root, objectId, options.maxBytes);
  if (result.kind !== "blob") {
    addFinding(findings, seen, { path: "<object>", objectId, category: result.kind === "oversize" ? "unscanned-oversize" : "unscanned-blob", scope: "object" });
    return;
  }
  scanBlobContent(`bytes:${sha256(result.bytes)}`, result.bytes, { path: "<object>", objectId, scope: "object" }, findings, seen, counts, contentResults, options.maxBytes);
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

function verifyPublicReview(expectedRepository, eventPath, findings, seen) {
  if (expectedRepository !== CANONICAL_REPOSITORY) throw new PrivacyScanError("invalid-invocation", "noncanonical-repository");
  const event = parseEvent(eventPath);
  const repository = event.repository;
  if (!repository || typeof repository !== "object" || Array.isArray(repository)) throw new PrivacyScanError("invalid-invocation", "ci-event-lacks-repository");
  if (repository.full_name !== expectedRepository) {
    addFinding(findings, seen, { path: "repository", category: "wrong-repository-identity", scope: "public-review" });
  }
  if (repository.visibility !== "public" || repository.private !== false) addFinding(findings, seen, { path: "repository", category: "private-repository-visibility", scope: "public-review" });
  if (repository.fork !== false) addFinding(findings, seen, { path: "repository", category: "public-fork", scope: "public-review" });
  return event;
}

function requireSha(value, code) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) throw new PrivacyScanError("invalid-invocation", code);
  return value;
}

function eventRepoFullName(value, code) {
  if (!value || typeof value !== "object" || typeof value.full_name !== "string") throw new PrivacyScanError("invalid-invocation", code);
  return value.full_name;
}

function scanEventScope(root, eventName, event, expectedRepository, findings, seen, counts, contentResults, options) {
  const eventScope = `event-${eventName}`;
  if (eventName === "pull_request") {
    const pull = event.pull_request;
    if (!pull || typeof pull !== "object") throw new PrivacyScanError("invalid-invocation", "pull-request-event-incomplete");
    const base = pull.base;
    const head = pull.head;
    const baseSha = requireSha(base?.sha, "pull-request-base-sha-missing");
    const headSha = requireSha(head?.sha, "pull-request-head-sha-missing");
    if (eventRepoFullName(base?.repo, "pull-request-base-repository-missing") !== expectedRepository) {
      addFinding(findings, seen, { path: "pull_request.base.repo", category: "wrong-repository-identity", scope: eventScope });
    }
    if (!head?.repo) throw new PrivacyScanError("invalid-invocation", "pull-request-head-repository-missing");
    if (eventRepoFullName(head.repo, "pull-request-head-repository-invalid") !== expectedRepository) {
      addFinding(findings, seen, { path: "pull_request.head.repo", category: "public-fork", scope: eventScope });
    }
    scanRevision(root, `${baseSha}..${headSha}`, eventScope, findings, seen, counts, contentResults, options);
    scanWorktree(root, findings, seen, counts, contentResults, options);
    return;
  }
  if (eventName === "push") {
    const before = requireSha(event.before, "push-before-sha-missing");
    const after = requireSha(event.after, "push-after-sha-missing");
    if (/^0{40}$/u.test(before)) scanRevision(root, after, eventScope + "-new-branch", findings, seen, counts, contentResults, options);
    else scanRevision(root, `${before}..${after}`, eventScope, findings, seen, counts, contentResults, options);
    scanWorktree(root, findings, seen, counts, contentResults, options);
    scanIndex(root, findings, seen, counts, contentResults, options);
    return;
  }
  if (eventName === "schedule" || eventName === "workflow_dispatch") {
    scanAllRefs(root, findings, seen, counts, contentResults, options);
    scanWorktree(root, findings, seen, counts, contentResults, options);
    scanIndex(root, findings, seen, counts, contentResults, options);
    return;
  }
  throw new PrivacyScanError("invalid-invocation", "unsupported-event-name");
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

function outputResult({ status, selfTest, scopes, findings, counts, code, eventName }) {
  const sortedFindings = [...findings].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const result = {
    schemaVersion: 3,
    status,
    selfTest,
    scopes: [...new Set(scopes)].sort(),
    eventName: eventName ?? null,
    scannedCommitCount: counts.commits,
    scannedPathContextCount: counts.pathContexts,
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
    return outputResult({ status, selfTest: false, scopes: [], findings: [], counts: { blobs: 0, worktree: 0, index: 0, commits: 0, pathContexts: 0 }, code: error.code ?? "invalid-invocation" });
  }
  const { modes, options } = parsed;
  const findings = [];
  const seen = new Set();
  const scopes = [];
  const counts = { blobs: 0, worktree: 0, index: 0, commits: 0, pathContexts: 0 };
  const contentResults = new Map();
  try {
    if (options.selfTest) runSelfTest();
    let event;
    if (options.requirePublicReview || options.eventScope) {
      event = verifyPublicReview(options.repository, options.ciEvent, findings, seen);
      scopes.push("public-review");
    } else if (options.ciEvent) {
      event = parseEvent(options.ciEvent);
      scopes.push("ci-event");
    }
    if (options.eventScope) {
      scanEventScope(options.root, options.eventName, event, options.repository, findings, seen, counts, contentResults, options);
      scopes.push("event-scope");
    } else {
      for (const mode of modes) {
        if (mode.mode === "worktree") {
          scopes.push("worktree");
          scanWorktree(options.root, findings, seen, counts, contentResults, options);
        } else if (mode.mode === "index") {
          scopes.push("index");
          scanIndex(options.root, findings, seen, counts, contentResults, options);
        } else if (mode.mode === "commit") {
          if (!/^[0-9a-f]{40}$/u.test(mode.value)) throw new PrivacyScanError("invalid-invocation", "invalid-commit-id");
          scopes.push("commit");
          scanCommitSet(options.root, [mode.value], "commit", findings, seen, counts, contentResults, options);
        } else if (mode.mode === "range") {
          scopes.push("range");
          scanRevision(options.root, mode.value, "range", findings, seen, counts, contentResults, options);
        } else if (mode.mode === "all-refs") {
          scopes.push("all-refs");
          scanAllRefs(options.root, findings, seen, counts, contentResults, options);
        } else if (mode.mode === "object") {
          scopes.push("object");
          scanObject(options.root, mode.value, findings, seen, counts, contentResults, options);
        }
      }
    }
    const hasUnscanned = findings.some((finding) => finding.category.startsWith("unscanned-") || finding.category === "unreadable" || finding.category === "unscanned-file");
    const status = findings.length === 0 ? "passed" : hasUnscanned ? "unscanned-input" : "blocked";
    return outputResult({ status, selfTest: options.selfTest, scopes, findings, counts, eventName: options.eventName });
  } catch (error) {
    const status = error instanceof PrivacyScanError ? error.status : "unscanned-input";
    return outputResult({ status, selfTest: options.selfTest, scopes, findings, counts, eventName: options.eventName, code: error.code ?? "unscanned-input" });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const exitCode = await run();
  process.exitCode = exitCode;
}
