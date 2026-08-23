import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateRoot } from './check-root-policy.mjs';
import { validateCatalog } from './check-catalog.mjs';
import { scanPublicTree } from './check-public-tree.mjs';
import { validateWorkflow } from './check-workflow.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CHILD_TIMEOUT_MS = 15_000;
export const CHILD_MAX_BUFFER = 256 * 1024;
function boundedOutput(value) { return typeof value === 'string' ? value.slice(0, CHILD_MAX_BUFFER) : ''; }
export function sanitizeFailureOutput(value) {
  return boundedOutput(value)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, '[redacted private key]')
    .replace(/(\b(?:password|passwd|secret|token|api[_-]?key)\b\s*[:=]\s*)(["'`]?)[^\s"'`,;]+\2/gi, '$1[redacted]')
    .replace(/(["'`])([A-Za-z0-9+/=_-]{32,})\1/g, '$1[redacted token]$1')
    .replace(/\b[A-Za-z0-9+/=_-]{40,}\b/g, '[redacted token]');
}
export function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? CHILD_TIMEOUT_MS;
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: timeoutMs, maxBuffer: CHILD_MAX_BUFFER, windowsHide: true });
  if (result.error?.code === 'ENOBUFS') throw new Error(`${command} exceeded output limit of ${CHILD_MAX_BUFFER} bytes`);
  if (result.error && (result.error.code === 'ETIMEDOUT' || result.signal === 'SIGTERM')) throw new Error(`${command} timed out after ${timeoutMs}ms`);
  if (result.error) throw new Error(`${command} spawn failed: ${result.error.code ?? 'unknown error'}`);
  if (result.status !== 0) {
    const stdout = sanitizeFailureOutput(result.stdout).trim(); const stderr = sanitizeFailureOutput(result.stderr).trim();
    const detail = [stderr, stdout].filter(Boolean).join('\n'); throw new Error(`${command} failed${detail ? `: ${detail}` : ''}`);
  }
  return boundedOutput(result.stdout);
}
export function gitState(rootDirectory = root) {
  if (!fs.existsSync(path.join(rootDirectory, '.git'))) return null;
  const result = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: rootDirectory, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, maxBuffer: CHILD_MAX_BUFFER, windowsHide: true });
  if (result.error) throw new Error(`git status failed: ${result.error.code ?? 'spawn error'}`);
  if (result.status !== 0) throw new Error('git status failed');
  return boundedOutput(result.stdout);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const before = gitState();
    validateRoot(root); validateCatalog(root);
    if (scanPublicTree(root).length) throw new Error('public tree failed');
    const testFiles = fs.readdirSync(path.join(root, 'scripts/test')).filter(file => file.endsWith('.test.mjs')).sort().map(file => path.join('scripts/test', file));
    run(process.execPath, ['--test', ...testFiles]);
    validateWorkflow(root);
    const first = run(process.execPath, ['scripts/inventory.mjs']); const second = run(process.execPath, ['scripts/inventory.mjs']);
    if (first !== second) throw new Error('inventory is not deterministic');
    const after = gitState(); if (before !== null && before !== after) throw new Error('check changed the Git worktree');
    console.log('check: ok');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
