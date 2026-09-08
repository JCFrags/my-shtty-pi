#!/usr/bin/env node
// Historical evidence only: never compare current product files to old hashes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length > 1 || args[0]?.startsWith('-')) throw new Error('usage: verify-deployed-baseline.mjs [Git-tag-or-commit]');
const ref = args[0] ?? 'deployed-baseline-2026-09-01';
const git = args => execFileSync('git', args, { cwd: root });
const commit = git(['rev-parse', '--verify', `${ref}^{commit}`]).toString().trim();
const files = git(['ls-tree', '-r', '--name-only', '-z', commit]).toString().split('\0').filter(Boolean);
const manifests = files.filter(path => /^packages\/[^/]+\/DEPLOYED\.sha256$/.test(path));
if (!manifests.length) throw new Error(`${ref}: no captured deployment manifests`);
let checked = 0;
for (const manifest of manifests) {
  const seen = new Set();
  for (const line of git(['show', `${commit}:${manifest}`]).toString().trimEnd().split('\n')) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match || match[2].startsWith('/') || match[2].split('/').includes('..') || seen.has(match[2])) throw new Error(`${manifest}: invalid or duplicate hash record`);
    seen.add(match[2]);
    const path = `${dirname(manifest)}/${match[2]}`;
    const digest = createHash('sha256').update(git(['show', `${commit}:${path}`])).digest('hex');
    if (digest !== match[1]) throw new Error(`${ref}:${path}: historical hash mismatch`);
    checked++;
  }
}
console.log(JSON.stringify({ status: 'pass', scope: 'historical Git objects only', ref, commit, manifests: manifests.length, hashes: checked }));
