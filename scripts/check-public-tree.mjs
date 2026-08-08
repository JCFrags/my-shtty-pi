#!/usr/bin/env node
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

// This scanner reports only category, repository-relative path, and line number.
// It scans every regular text file, including this file and package scripts.
const root = new URL("..", import.meta.url).pathname;
const findings = [];
const text = (...codes) => String.fromCharCode(...codes);
const joinWords = (...parts) => parts.join("");
const home = text(104, 111, 109, 101);
const users = text(85, 115, 101, 114, 115);
const loopbackHost = text(108, 111, 99, 97, 108, 104, 111, 115, 116);
const homeArpa = joinWords(text(104, 111, 109, 101), ".", text(97, 114, 112, 97));
const secretWord = text(115, 101, 99, 114, 101, 116);
const tokenWord = text(116, 111, 107, 101, 110);
const passwordWord = text(112, 97, 115, 115, 119, 111, 114, 100);
const cookieWord = text(99, 111, 111, 107, 105, 101);
const authWord = text(97, 117, 116, 104);
const oauthWord = text(111, 97, 117, 116, 104);
const apiKeyWord = joinWords(text(97, 112, 105), "[_-]?", text(107, 101, 121));
const privateKeyMarker = joinWords("-----BEGIN ", text(80, 82, 73, 86, 65, 84, 69), " KEY-----");

const pathRules = [
  ["prohibited-path", /(^|\/)(\.git|node_modules|dist|target|coverage|\.pi|\.agents|sessions?|browser|evidence|rollback|failed-candidates)(\/|$)/i],
  ["generated-output", /(?:\.map$|\.tgz$|\.tar\.gz$|\.node$|\.wasm$)/i],
  ["archive", /(?:\.zip$|\.7z$|\.rar$|\.tar$|\.gz$|\.bz2$|\.xz$)/i],
];
const contentRules = [
  ["absolute-home-path", new RegExp(`(?:^|[^A-Za-z])\\/(?:${home}|${users}|root)\\/[A-Za-z0-9._-]+`)],
  ["private-endpoint", new RegExp(`(?:\\b${text(49, 48)}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b|\\b${text(49, 57, 50, 46, 49, 54, 56)}\\.\\d{1,3}\\.\\d{1,3}\\b|\\b${text(49, 55, 50)}\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}\\b|\\b${loopbackHost}\\b|\\b${homeArpa}\\b|\\.${text(108, 111, 99, 97, 108)}\\b)`, "i")],
  ["private-key", new RegExp(privateKeyMarker, "i")],
  ["credential-value", new RegExp(`(?:${apiKeyWord}|${passwordWord}|${secretWord}|${tokenWord}|${oauthWord}|${authWord})\\s*[:=]\\s*(?:[\\\"'][^\\\"']{12,}[\\\"']|(?:sk|ghp|glpat|xox|eyJ)[A-Za-z0-9_+/=-]{10,})`, "i")],
  ["cookie-value", new RegExp(`${cookieWord}\\s*[:=]\\s*(?:[\\\"'][^\\\"']{12,}[\\\"']|[A-Za-z0-9_+/=-]{16,})`, "i")],
  ["authorization-value", new RegExp(`(?:${authWord}orization|${text(66, 101, 97, 114, 101, 114)})\\s*[:=]?\\s*(?:[\\\"'][^\\\"']{16,}[\\\"']|[A-Za-z0-9_+/=-]{20,})`, "i")],
  [joinWords(text(115, 101, 115, 115, 105, 111, 110), "-", text(104, 105, 115, 116, 111, 114, 121)), new RegExp(`(?:${text(115, 101, 115, 115, 105, 111, 110)}[_-]?(?:${text(105, 100)}|${text(107, 101, 121)}|${tokenWord})\\s*[:=]\\s*[\\\"'](?!${text(115, 101, 115, 115, 105, 111, 110)}-\\d)[^\\\"']{8,}[\\\"']|${text(104, 105, 115, 116, 111, 114, 121)}[_-]?(?:${text(105, 100)}|${text(107, 101, 121)})\\s*[:=]\\s*[\\\"'](?!${text(104, 105, 115, 116, 111, 114, 121)}-\\d)[^\\\"']{8,}[\\\"'])`, "i")],
];
const workflowRule = ["workflow-secret-misuse", new RegExp(`(?:run|script)\\s*:[^\\n]*\\$\\{\\{\\s*secrets\\.`, "i")];
const committedLiteralRule = ["unsafe-secret-literal", new RegExp(`(?:${apiKeyWord}|${passwordWord}|${secretWord}|${tokenWord})\\s*[:=]\\s*[\\\"'][^\\\"']{12,}[\\\"']`, "i")];

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}
function add(category, rel, line) {
  findings.push([category, rel, line]);
}
function isSafeEntropyExclusion(rel, value) {
  // Lockfile integrity hashes and fixed source identifiers are expected, not credentials.
  if (/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(rel)) return true;
  if (/\.(?:c|m)?js|tsx?|md|json$/.test(rel) && /^[a-f0-9]{40,64}$/i.test(value)) return true;
  return false;
}
function entropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}
function highEntropyMatch(source, rel) {
  const candidates = [...source.matchAll(/[A-Za-z0-9_+/=-]{24,}/g)];
  for (const match of candidates) {
    const value = match[0];
    if (isSafeEntropyExclusion(rel, value)) continue;
    if (value.length >= 24 && entropy(value) >= 4.2 && /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value)) return { index: match.index, value };
  }
  return undefined;
}
async function walk(dir) {
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const rel = relative(root, path) || ".";
    const st = await lstat(path);
    if (st.isSymbolicLink()) { add("unsafe-symlink", rel, 1); continue; }
    if (st.isDirectory()) { for (const [category, rule] of pathRules) if (rule.test(`${rel}/`)) add(category, rel, 1); await walk(path); continue; }
    if (!st.isFile()) { add("unsafe-file-type", rel, 1); continue; }
    for (const [category, rule] of pathRules) if (rule.test(rel)) add(category, rel, 1);
    const bytes = await readFile(path);
    if (bytes.includes(0)) { add("binary-file", rel, 1); continue; }
    const source = bytes.toString("utf8");
    for (const [category, rule] of contentRules) {
      const match = rule.exec(source);
      if (match?.index !== undefined) add(category, rel, lineNumber(source, match.index));
    }
    if (/\.github\/workflows\//i.test(rel)) {
      const match = workflowRule[1].exec(source);
      if (match?.index !== undefined) add(workflowRule[0], rel, lineNumber(source, match.index));
    }
    const literal = committedLiteralRule[1].exec(source);
    if (literal?.index !== undefined) add(committedLiteralRule[0], rel, lineNumber(source, literal.index));
    const highEntropy = highEntropyMatch(source, rel);
    if (highEntropy !== undefined) add("high-entropy-value", rel, lineNumber(source, highEntropy.index));
  }
}
await walk(root);
const unique = [...new Map(findings.map(([category, path, line]) => [`${category}\0${path}\0${line}`, [category, path, line]])).values()]
  .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2] - b[2]);
for (const [category, path, line] of unique) console.log(`${category}\t${path}\t${line}`);
if (unique.length) process.exitCode = 1;
else console.log("PASS\tpublic tree has no prohibited findings");
