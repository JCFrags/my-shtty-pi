#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prefix = 'vendor/terminal-browser/';
const provenancePath = prefix + 'copy-provenance.json';
const git = (...args) => execFileSync('git', args, { cwd: root });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Hash the intended indexed source, never untracked output or dependencies.
try {
  git('diff', '--quiet', '--', prefix, `:(exclude)${provenancePath}`);
} catch {
  throw new Error('Stage intended browser changes before refreshing provenance. Unstaged browser edits remain.');
}
const provenance = JSON.parse(readFileSync(join(root, provenancePath), 'utf8'));
const previous = new Map(provenance.files.map(record => [record.path, record]));
const removed = new Map((provenance.removed ?? []).map(record => [record.path, record]));
const entries = git('ls-files', '--stage', '-z', '--', prefix).toString('utf8').split('\0').filter(Boolean);
const files = [];
for (const entry of entries) {
  const match = /^(100644|100755) [0-9a-f]+ 0\t(.+)$/.exec(entry);
  if (!match) throw new Error('Browser provenance requires regular, resolved indexed files.');
  const [, mode, indexedPath] = match;
  if (indexedPath === provenancePath) continue;
  const path = indexedPath.slice(prefix.length);
  const old = previous.get(path) ?? removed.get(path);
  const sourceSha256 = old?.sourceSha256 ?? null;
  const sha256 = hash(git('show', `:${indexedPath}`));
  files.push({ path, sourceSha256, mode: mode === '100755' ? 0o755 : 0o644, sha256, modified: sha256 !== sourceSha256 });
  previous.delete(path);
  removed.delete(path);
}
for (const record of previous.values()) {
  if (record.sourceSha256 !== null) removed.set(record.path, { path: record.path, sourceSha256: record.sourceSha256 });
}
provenance.schemaVersion = 2;
provenance.files = files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
provenance.removed = [...removed.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const destination = join(root, provenancePath);
const temporary = destination + `.tmp-${process.pid}`;
writeFileSync(temporary, JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
renameSync(temporary, destination);
console.log(`Updated ${files.length} indexed browser records. Stage ${provenancePath} before verification.`);
