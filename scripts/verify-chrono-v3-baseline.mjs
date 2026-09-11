#!/usr/bin/env node
// Exact approved package identity, independent of branch ancestry and root catalogs.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHRONO_HISTORICAL_BASELINE = Object.freeze({
  commit: 'ad23f0b71ee473d33aff26d367459e76d208c631',
  tree: '14dbd0cb89a8b66f4225e2932503b62a808d9be1',
  files: 278,
  version: '2.0.4',
});
export const CHRONO_BASELINE = Object.freeze({
  commit: 'b5918dbf952423e86a50a71e03ae1996c4801ea5',
  upstreamTree: 'fe3c1df802214b6eba96f39fc36912817058d0d3',
  tree: '9c6694b9073f23a0ed6e0c7677e701a128d59ae7',
  files: 398,
  maps: 124,
  package: 'packages/pi-chrono-compaction',
  version: '2.0.15',
  testOnlyDifference: Object.freeze({
    path: 'test/worker-runtime.test.ts',
    upstreamSha256: 'd55227e12c9ce45e42b4703daf30b2966f95d1352cd442319ae01fd8fbf7fee0',
    integratedSha256: '54ed55886810e4dbaf14625efc8a84aacc39a6f88009a71c1e7ea20821046b3b',
  }),
});
const fail = code => { throw new Error(code); };
const objectHash = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');

// Git tree ordering compares directories with a trailing slash, and embeds raw
// object IDs. No Git writes, mutable branch names, or external inventory files.
function treeHash(entries) {
  const ordered = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.mode === '40000' ? '/' : '')), Buffer.from(b.name + (b.mode === '40000' ? '/' : ''))));
  return objectHash('tree', Buffer.concat(ordered.flatMap(e => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.hash, 'hex')])));
}
function checkIdentity(tree, files, code) {
  if (tree !== CHRONO_BASELINE.tree || files !== CHRONO_BASELINE.files) fail(code);
  return { tree, files };
}
function inspectChronoFiles(packageRoot, generatedMaps = false) {
  let files = 0;
  const maps = [], javascript = [];
  function visit(directory, top = false) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('chrono-unsafe-tree');
    const entries = [];
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), info = lstatSync(path);
      // Only the package-root ignored dependency installation is outside the
      // release. Indexed node_modules is still rejected by the index tree gate.
      if (top && name === 'node_modules' && info.isDirectory() && !info.isSymbolicLink()) continue;
      if (info.isSymbolicLink()) fail('chrono-unsafe-tree');
      const rel = relative(packageRoot, path);
      if (generatedMaps && info.isFile() && rel.startsWith('dist/') && rel.endsWith('.js.map')) { maps.push(path); continue; }
      if (info.isFile() && rel.startsWith('dist/') && rel.endsWith('.js')) javascript.push(path);
      if (info.isDirectory()) entries.push({ name, mode: '40000', hash: visit(path) });
      else if (info.isFile()) {
        files++;
        entries.push({ name, mode: info.mode & 0o111 ? '100755' : '100644', hash: objectHash('blob', readFileSync(path)) });
      } else fail('chrono-unsafe-tree');
    }
    return treeHash(entries);
  }
  try {
    const identity = checkIdentity(visit(packageRoot, true), files, 'chrono-package-tree-mismatch');
    if (!generatedMaps) return identity;
    if (maps.length !== CHRONO_BASELINE.maps || JSON.stringify(maps.sort()) !== JSON.stringify(javascript.map(path => `${path}.map`).sort())) fail('chrono-generated-map-inventory');
    for (const path of maps) {
      const map = JSON.parse(readFileSync(path, 'utf8'));
      const source = resolve(packageRoot, relative(join(packageRoot, 'dist'), path).replace(/\.js\.map$/, '.ts'));
      if (map.version !== 3 || map.file !== basename(path, '.map') || map.sourceRoot !== ''
          || !Array.isArray(map.sources) || map.sources.length !== 1 || resolve(dirname(path), map.sources[0]) !== source) fail('chrono-generated-map-binding');
      if (!lstatSync(source).isFile()) fail('chrono-generated-map-binding');
    }
    return { ...identity, maps };
  }
  catch (error) {
    if (error.code === 'ENOENT') fail('chrono-package-file-missing');
    throw error;
  }
}
export function verifyChronoFiles(packageRoot) { return inspectChronoFiles(packageRoot); }
// Explicit build-only validation. The normal baseline command never allows maps.
export function verifyChronoBuildMaps(packageRoot) { return inspectChronoFiles(packageRoot, true); }

export function verifyChronoIndex(records) {
  const root = new Map();
  let files = 0;
  for (const record of records.split('\0').filter(Boolean)) {
    const match = /^(100644|100755) ([0-9a-f]{40}) 0\t(.+)$/.exec(record);
    if (!match || !match[3].startsWith(CHRONO_BASELINE.package + '/')) fail('chrono-index-invalid');
    const parts = match[3].slice(CHRONO_BASELINE.package.length + 1).split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || p === 'node_modules')) fail('chrono-index-invalid');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.has(part)) node.set(part, new Map());
      node = node.get(part);
      if (!(node instanceof Map)) fail('chrono-index-invalid');
    }
    const name = parts.at(-1);
    if (node.has(name)) fail('chrono-index-invalid');
    node.set(name, { mode: match[1], hash: match[2] });
    files++;
  }
  const visit = node => treeHash([...node].map(([name, value]) => value instanceof Map
    ? { name, mode: '40000', hash: visit(value) } : { name, ...value }));
  return checkIdentity(visit(root), files, 'chrono-index-tree-mismatch');
}
export function verifyFrozenChrono(repositoryRoot) {
  const git = args => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let records;
  try { records = git(['ls-files', '--stage', '-z', '--', CHRONO_BASELINE.package]); }
  catch { fail('chrono-baseline-git-unavailable'); }
  // The literal approved tree is self-contained. The provenance commit need not
  // remain reachable after selective integration, branch cleanup, or shallow CI.
  verifyChronoIndex(records);
  const identity = verifyChronoFiles(join(repositoryRoot, CHRONO_BASELINE.package));
  return { status: 'ok', sourceCommit: CHRONO_BASELINE.commit, upstreamPackageTree: CHRONO_BASELINE.upstreamTree, packageVersion: CHRONO_BASELINE.version, testOnlyDifference: CHRONO_BASELINE.testOnlyDifference, ...identity, index: 'exact', worktree: 'exact', live: { state: 'not-checked' } };
}
export function main(args = process.argv.slice(2)) {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let suppliedRoot = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--static-only' || args[i] === '--allow-missing-live') continue;
    if (args[i] === '--repository-root' && !suppliedRoot && args[i + 1] && !args[i + 1].startsWith('-')) { root = resolve(args[++i]); suppliedRoot = true; }
    else fail('chrono-invalid-invocation');
  }
  // This command never discovers or reads live activation. The historical flags
  // remain accepted solely for existing static release-check invocations.
  console.log(JSON.stringify(verifyFrozenChrono(root)));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: /^chrono-[a-z-]+$/.test(error.message) ? error.message : 'chrono-verification-failed', live: { state: 'not-checked' } }));
    process.exitCode = 1;
  }
}
