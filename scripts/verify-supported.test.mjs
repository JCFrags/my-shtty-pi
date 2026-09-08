import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { imports, scanBoundary, scanPrivacy, snapshotIndex, validateManifests } from './verify-supported.mjs';

function fixture(callback) {
  const root = mkdtempSync(join(tmpdir(), 'pi-verifier-test-'));
  try { return callback(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
const git = (root, ...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });

test('snapshot uses indexed bytes and excludes ignored and untracked inputs', () => fixture(root => {
  const source = join(root, 'source');
  mkdirSync(source);
  git(source, 'init', '-q');
  writeFileSync(join(source, '.gitignore'), 'node_modules/\ndist/\n');
  writeFileSync(join(source, 'entry.mjs'), 'export const value = 1;\n');
  git(source, 'add', '.');
  writeFileSync(join(source, 'entry.mjs'), 'export const value = 2;\n');
  writeFileSync(join(source, 'untracked.mjs'), 'throw Error();');
  mkdirSync(join(source, 'node_modules'));
  writeFileSync(join(source, 'node_modules', 'poison.mjs'), 'throw Error();');
  const destination = join(root, 'snapshot');
  assert.deepEqual(snapshotIndex(source, destination).sort(), ['.gitignore', 'entry.mjs']);
  assert.equal(readFileSync(join(destination, 'entry.mjs'), 'utf8'), 'export const value = 1;\n');
  assert.equal(existsSync(join(destination, 'node_modules')), false);
  assert.equal(existsSync(join(destination, 'untracked.mjs')), false);
}));

test('snapshot rejects indexed symlinks', () => fixture(root => {
  git(root, 'init', '-q');
  symlinkSync('/tmp', join(root, 'escape'));
  git(root, 'add', 'escape');
  assert.throws(() => snapshotIndex(root, join(root, 'copy')), /regular files/);
}));

test('snapshot rejects force-tracked dependency trees', () => fixture(root => {
  git(root, 'init', '-q');
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'poison'), 'poison');
  git(root, 'add', '-f', 'node_modules');
  assert.throws(() => snapshotIndex(root, join(root, 'copy')), /unsafe indexed path/);
}));

test('boundary bans retired commands and aliases, not supported settings or Glance', () => {
  assert.throws(() => scanBoundary('pi.registerCommand("pi-herd", {})', 'runtime', 'pi-herdr-orchestrator'), /retired presentation command/);
  assert.throws(() => scanBoundary('import x from "@pi-herdr-deck/tui"', 'runtime', 'pi-herdr-orchestrator'), /retired presentation identity/);
  assert.throws(() => scanBoundary('pi.registerCommand("orchestrator-status", {})', 'runtime', 'pi-herdr-orchestrator'), /retired presentation command/);
  assert.doesNotThrow(() => scanBoundary('pi.registerCommand("agent-settings", {})', 'runtime', 'pi-herdr-orchestrator'));
  assert.doesNotThrow(() => scanBoundary('pi.registerCommand("project-glance", {})', 'runtime', 'pi-project-glance'));
  assert.throws(() => scanBoundary('pi.registerCommand("glance", {})', 'runtime', 'pi-project-glance'), /command alias/);
});

test('boundary rejects cross-product runtime imports and Glance tools', () => {
  for (const spec of ['../../pi-herdr-orchestrator/src/index.js', 'files-ui', '@grounded/pi-core/tasks']) {
    assert.throws(() => scanBoundary(`import x from '${spec}'`, 'runtime', 'pi-project-glance'), /cross-product import/);
  }
  assert.throws(() => scanBoundary('import("pi-project-glance")', 'runtime', 'pi-herdr-orchestrator'), /cross-product import/);
  assert.throws(() => scanBoundary('pi.registerTool({})', 'runtime', 'pi-project-glance'), /control surface/);
});

test('privacy rejects credentials and private home paths without exposing values', () => {
  assert.throws(() => scanPrivacy('AKIA' + 'A'.repeat(16), 'runtime'), /secret-like content/);
  assert.throws(() => scanPrivacy('/' + 'home' + '/private-user/project', 'runtime'), /private home path/);
  assert.doesNotThrow(() => scanPrivacy('/' + 'home' + '/fixture/project', 'packages/example/test/privacy.test.mjs'));
});

test('import discovery covers literal static, dynamic, require and URL resources', () => {
  const specs = imports('import x from "./a.js"; export { y } from "./b.js"; import("./c.js"); require("./d.js"); new URL("./helper.py", import.meta.url);');
  assert.deepEqual(specs.sort(), ['./a.js', './b.js', './c.js', './d.js', './helper.py']);
});


test('manifest validation rejects lock drift, missing local imports, and undeclared dependencies', () => fixture(root => {
  mkdirSync(join(root, 'packages/example'), { recursive: true });
  const rootManifest = { name: 'test-root', version: '1.0.0' };
  writeFileSync(join(root, 'package.json'), JSON.stringify(rootManifest));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: { '': rootManifest } }));
  const manifest = { name: 'test-example', version: '1.0.0', dependencies: { example: '1.0.0' } };
  const packagePath = join(root, 'packages/example');
  writeFileSync(join(packagePath, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(packagePath, 'package-lock.json'), JSON.stringify({ packages: { '': { ...manifest, version: '2.0.0' } } }));
  const files = ['package.json', 'packages/example/package.json', 'packages/example/index.mjs'];
  writeFileSync(join(packagePath, 'index.mjs'), 'import "./missing.mjs";');
  assert.throws(() => validateManifests(root, files), /lock mismatch/);
  writeFileSync(join(packagePath, 'package-lock.json'), JSON.stringify({ packages: { '': manifest } }));
  assert.throws(() => validateManifests(root, files), /unresolved local path/);
  writeFileSync(join(packagePath, 'index.mjs'), 'import "undeclared-library";');
  assert.throws(() => validateManifests(root, files), /undeclared dependency/);
  writeFileSync(join(packagePath, 'index.mjs'), 'import "node:fs"; import "example";');
  assert.doesNotThrow(() => validateManifests(root, files));
}));

test('compiled import.meta.url resources resolve at emitted location and remain required', () => fixture(root => {
  const manifest = { name: 'example', version: '1', scripts: { build: 'tsc' } };
  const dir = join(root, 'packages/example');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root' }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: { '': { name: 'root' } } }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { rootDir: '.', outDir: 'dist' } }));
  writeFileSync(join(dir, 'bin/start'), 'launcher');
  writeFileSync(join(dir, 'src/main.ts'), 'new URL("../../bin/start", import.meta.url);');
  const files = ['package.json', 'packages/example/package.json', 'packages/example/src/main.ts'];
  assert.doesNotThrow(() => validateManifests(root, files));
  writeFileSync(join(dir, 'src/main.ts'), 'new URL("../../bin/missing", import.meta.url);');
  assert.throws(() => validateManifests(root, files), /unresolved local path/);
}));
