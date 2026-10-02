#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imports, scanPrivacy, snapshotIndex } from './verify-supported.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LSP_FILES = Object.freeze([
  'packages/grounded-tools/lsp/index.ts',
  'packages/grounded-tools/core/src/lsp-client.ts',
  'packages/grounded-tools/README.md',
  'packages/grounded-tools/lsp/rust-launch.ts',
  'packages/grounded-tools/lsp/test/lifecycle.test.mjs',
  'packages/grounded-tools/lsp/test/fixtures/fake-lsp.mjs',
  'packages/grounded-tools/lsp/test/fixtures/owner.mjs',
]);
const RUNNER = 'scripts/verify-lsp.mjs';
const scoped = [...LSP_FILES, RUNNER];
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const run = (command, args, cwd, options = {}) => execFileSync(command, args, { cwd, stdio: 'inherit', ...options });
const output = args => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function checkRoutes(root) {
  const rootManifest = json(join(root, 'package.json'));
  const lock = json(join(root, 'package-lock.json'));
  const coreDir = 'packages/grounded-tools/core';
  const lspDir = 'packages/grounded-tools/lsp';
  const core = json(join(root, coreDir, 'package.json'));
  const lsp = json(join(root, lspDir, 'package.json'));
  for (const [directory, manifest] of [['', rootManifest], [coreDir, core], [lspDir, lsp]]) {
    assert.ok(lock.packages[directory], `indexed lock owner: ${directory}`);
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      assert.deepEqual(manifest[key], lock.packages[directory][key], `${directory}: committed lock mismatch for ${key}`);
    }
  }
  assert.ok(rootManifest.workspaces.includes(coreDir) && rootManifest.workspaces.includes(lspDir));
  assert.equal(lsp.dependencies[core.name], core.version);
  assert.equal(core.exports['./lsp-client'], './src/lsp-client.ts');
  for (const path of LSP_FILES.filter(path => /\.(?:ts|mjs)$/.test(path))) {
    const manifest = path.startsWith(`${coreDir}/`) ? core : lsp;
    for (const spec of imports(readFileSync(join(root, path), 'utf8'))) {
      if (spec.startsWith('node:') || builtinModules.includes(spec)) continue;
      if (spec.startsWith('.')) {
        const target = resolve(dirname(join(root, path)), spec);
        assert.ok(target.startsWith(`${root}/`) && existsSync(target), `${path}: unresolved local import ${spec}`);
      } else if (spec.startsWith('@grounded/pi-core/')) {
        assert.ok(manifest === core || manifest.dependencies?.[core.name]);
        const exported = core.exports[`./${spec.slice('@grounded/pi-core/'.length)}`];
        assert.equal(typeof exported, 'string', `${path}: unexported core route`);
        assert.ok(existsSync(join(root, coreDir, exported)));
      } else {
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        assert.ok(manifest.peerDependencies?.[name] || manifest.dependencies?.[name], `${path}: undeclared import ${spec}`);
      }
    }
  }
}

export function main() {
  const temporary = mkdtempSync(join(tmpdir(), 'pi-lsp-verify-'));
  const root = join(temporary, 'repo');
  try {
    const files = snapshotIndex(source, root);
    for (const path of scoped) {
      assert.ok(files.includes(path), `required staged LSP input: ${path}`);
      const bytes = readFileSync(join(root, path));
      scanPrivacy(bytes.toString('utf8'), path);
      if (path === RUNNER) assert.ok(bytes.equals(readFileSync(join(source, path))), `${path}: stage the runner before verification`);
      if (/\.(?:ts|mjs)$/.test(path)) run(process.execPath, ['--experimental-transform-types', '--check', path], root);
    }
    checkRoutes(root);
    const tree = output(['write-tree']);
    const home = join(temporary, 'home');
    const temp = join(home, 'tmp');
    mkdirSync(temp, { recursive: true, mode: 0o700 });
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: temp, PI_CODING_AGENT_DIR: join(home, 'agent'), LANG: 'C.UTF-8' };
    // Only dependency preparation uses the root lock. No workspace scripts,
    // product verifier, unrelated regression test, or package build is invoked.
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], root, { env, timeout: 180_000 });
    assert.equal(realpathSync(join(root, 'node_modules/@grounded/pi-core')), join(root, 'packages/grounded-tools/core'));
    assert.equal(relative(root, realpathSync(join(root, 'node_modules/@grounded/pi-lsp'))), 'packages/grounded-tools/lsp');
    const started = Date.now();
    run(process.execPath, ['--experimental-transform-types', '--test', '--test-concurrency=1', '--test-timeout=60000', 'packages/grounded-tools/lsp/test/lifecycle.test.mjs'], root, {
      env, timeout: 60_000, killSignal: 'SIGKILL',
    });
    console.log(JSON.stringify({ status: 'pass', inputs: 'Git index', tree, scope: scoped, fixtureMs: Date.now() - started, watchdogMs: 60_000 }));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
