import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredScripts = { check: 'node scripts/check.mjs', 'check:public-tree': 'node scripts/check-public-tree.mjs', 'check:catalog': 'node scripts/check-catalog.mjs', 'test:repo': 'node --test scripts/test/*.test.mjs', inventory: 'node scripts/inventory.mjs' };
export function validateRoot(root = defaultRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.private !== true || manifest.workspaces || manifest.dependencies || manifest.devDependencies) throw new Error('root policy: private/workspace/dependency boundary');
  if (manifest.engines?.node !== '>=22.19.0' || manifest.packageManager !== 'npm@10.9.3') throw new Error('root policy: runtime metadata');
  if (fs.readFileSync(path.join(root, '.node-version'), 'utf8').trim() !== '22.19.0') throw new Error('root policy: Node version');
  for (const [script, command] of Object.entries(requiredScripts)) if (manifest.scripts?.[script] !== command) throw new Error(`root policy: exact ${script} command`);
  if (fs.existsSync(path.join(root, 'package-lock.json'))) throw new Error('root policy: root lockfile');
  return true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) { try { validateRoot(process.env.REPO_ROOT ? path.resolve(process.env.REPO_ROOT) : defaultRoot); console.log('root policy: ok'); } catch (error) { console.error(error.message); process.exitCode = 1; } }
