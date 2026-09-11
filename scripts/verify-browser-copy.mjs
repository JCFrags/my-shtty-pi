#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const copyPrefix = 'vendor/terminal-browser/';
const copyRootRel = copyPrefix.slice(0, -1);
const provenanceRel = `${copyPrefix}copy-provenance.json`;
const sourceCommit = '19c33769a33edddd066b3bac291ce371d2c1aba9';
const requiredExclusions = [
  '.github/',
  '.vscode/',
  'release-worker/',
  'scripts/retire-legacy/',
  'scripts/legacy-browser-cleanup.mjs',
  'scripts/test/legacy-browser-cleanup.test.mjs',
  'scripts/publish-r2.sh',
  'scripts/tag-release.sh',
  'scripts/next-version.sh',
  'pi-extension/src/web-research.ts',
  'pi-extension/dist/',
  'pi-extension/test/web-research.test.mjs',
];

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, path) => path === root || path.startsWith(root + sep);

function safeRelative(path, label) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.endsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`${label}: unsafe relative path`);
  }
  return path;
}

function globPattern(pattern) {
  const escaped = pattern.split('/').map(part => part === '*' ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/');
  return new RegExp(`^${escaped}$`);
}

export function verifyBrowserCopy(root, files) {
  const copied = files.filter(path => path.startsWith(copyPrefix));
  if (!copied.includes(provenanceRel)) throw new Error(`${provenanceRel}: required indexed provenance`);
  for (const required of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    if (!copied.includes(copyPrefix + required)) throw new Error(`${copyPrefix + required}: required indexed pnpm workspace input`);
  }

  const copyRoot = resolve(root, copyRootRel);
  const provenance = json(join(root, provenanceRel));
  if (provenance.schemaVersion !== 1 || provenance.source?.commit !== sourceCommit || typeof provenance.source?.repository !== 'string' || !provenance.source.repository) {
    throw new Error(`${provenanceRel}: invalid or unexpected source`);
  }
  if (!Array.isArray(provenance.excluded) || provenance.excluded.some(path => typeof path !== 'string')) {
    throw new Error(`${provenanceRel}: invalid exclusions`);
  }
  for (const path of requiredExclusions) {
    const exclusion = provenance.excluded.find(item => item === path || (item.endsWith('/') && path.startsWith(item)));
    if (!exclusion) throw new Error(`${provenanceRel}: missing exclusion ${path}`);
    const normalized = exclusion.endsWith('/') ? exclusion : `${exclusion}/`;
    if (copied.some(file => file === copyPrefix + exclusion || file.startsWith(copyPrefix + normalized))) {
      throw new Error(`${copyPrefix + exclusion}: excluded browser-copy input is present`);
    }
  }
  if (!Array.isArray(provenance.files)) throw new Error(`${provenanceRel}: invalid file inventory`);

  const records = new Map();
  for (const record of provenance.files) {
    const path = safeRelative(record?.path, provenanceRel);
    if (records.has(path)) throw new Error(`${provenanceRel}: duplicate file ${path}`);
    if (!/^[0-9a-f]{64}$/.test(record.sha256) || !/^[0-9a-f]{64}$/.test(record.sourceSha256)
        || ![0o644, 0o755].includes(record.mode) || typeof record.modified !== 'boolean') {
      throw new Error(`${provenanceRel}: invalid record ${path}`);
    }
    if (record.modified !== (record.sha256 !== record.sourceSha256)) throw new Error(`${provenanceRel}: inconsistent modified flag ${path}`);
    records.set(path, record);
  }

  const actual = copied.filter(path => path !== provenanceRel).map(path => path.slice(copyPrefix.length)).sort();
  const recorded = [...records.keys()].sort();
  if (JSON.stringify(actual) !== JSON.stringify(recorded)) throw new Error(`${provenanceRel}: copied file inventory mismatch`);
  for (const path of actual) {
    const absolute = resolve(copyRoot, path);
    if (!within(copyRoot, absolute)) throw new Error(`${provenanceRel}: path escapes copy ${path}`);
    const bytes = readFileSync(absolute);
    const stat = lstatSync(absolute);
    const mode = stat.mode & 0o111 ? 0o755 : 0o644;
    const record = records.get(path);
    if (!stat.isFile() || hash(bytes) !== record.sha256 || mode !== record.mode) throw new Error(`${copyPrefix + path}: provenance mismatch`);
  }

  const manifest = json(join(copyRoot, 'package.json'));
  if (!/^pnpm@10\.13\.1$/.test(manifest.packageManager ?? '')) throw new Error(`${copyPrefix}package.json: pnpm version drift`);
  if (Object.keys(manifest.scripts ?? {}).some(name => name.startsWith('release:'))) throw new Error(`${copyPrefix}package.json: release script retained`);

  const workspaceText = readFileSync(join(copyRoot, 'pnpm-workspace.yaml'), 'utf8');
  const packagesBlock = workspaceText.match(/^packages:\s*\n((?:^[ \t].*(?:\n|$))*)/m)?.[1] ?? '';
  const patterns = [...packagesBlock.matchAll(/^  - ([^\s#]+)\s*$/gm)].map(match => safeRelative(match[1], `${copyPrefix}pnpm-workspace.yaml`));
  if (!patterns.length) throw new Error(`${copyPrefix}pnpm-workspace.yaml: no package patterns`);
  const manifests = actual.filter(path => path.endsWith('/package.json')).map(path => dirname(path)).sort();
  for (const dir of manifests) if (!patterns.some(pattern => globPattern(pattern).test(dir))) throw new Error(`${copyPrefix + dir}/package.json: outside pnpm workspace`);
  for (const pattern of patterns) if (!manifests.some(dir => globPattern(pattern).test(dir))) throw new Error(`${copyPrefix}pnpm-workspace.yaml: unmatched pattern ${pattern}`);

  const lockText = readFileSync(join(copyRoot, 'pnpm-lock.yaml'), 'utf8');
  if (!/^lockfileVersion: ['"]?9\.0['"]?$/m.test(lockText)) throw new Error(`${copyPrefix}pnpm-lock.yaml: unsupported lock version`);
  const importerBlock = lockText.match(/\nimporters:\n([\s\S]*?)\npackages:\n/)?.[1];
  if (!importerBlock) throw new Error(`${copyPrefix}pnpm-lock.yaml: missing importers`);
  const importers = new Set([...importerBlock.matchAll(/^  ([^\s][^:]*):$/gm)].map(match => match[1].replace(/^['"]|['"]$/g, '')));
  for (const dir of ['.', ...manifests]) if (!importers.has(dir)) throw new Error(`${copyPrefix}pnpm-lock.yaml: missing importer ${dir}`);

  return { files: actual.length, manifests: manifests.length + 1, sourceCommit };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { execFileSync } = await import('node:child_process');
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  console.log(JSON.stringify({ status: 'pass', ...verifyBrowserCopy(root, files) }));
}
