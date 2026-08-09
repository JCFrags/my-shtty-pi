import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateRoot } from './check-root-policy.mjs';
import { validateCatalog } from './check-catalog.mjs';
import { scanPublicTree } from './check-public-tree.mjs';
import { validateWorkflow } from './check-workflow.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function run(command, args) { const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr || `${command} failed`); return result.stdout; }
function gitState() { const result = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }); return result.status === 0 ? result.stdout : null; }
try {
  const before = gitState();
  validateRoot(root); validateCatalog(root);
  if (scanPublicTree(root).length) throw new Error('public tree failed');
  const testFiles = fs.readdirSync(path.join(root, 'scripts/test')).filter(file => file.endsWith('.test.mjs')).sort().map(file => path.join('scripts/test', file));
  run(process.execPath, ['--test', ...testFiles]);
  validateWorkflow(root);
  const first = run(process.execPath, ['scripts/inventory.mjs']);
  const second = run(process.execPath, ['scripts/inventory.mjs']);
  if (first !== second) throw new Error('inventory is not deterministic');
  const after = gitState(); if (before !== null && (before !== after || before !== '')) throw new Error('check changed the Git worktree');
  console.log('check: ok');
} catch (error) { console.error(error.message); process.exitCode = 1; }
