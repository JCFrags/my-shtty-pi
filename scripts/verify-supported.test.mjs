import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chronoScriptEnvironment, finishChronoBuild, imports, localReference, removeChronoBuildMaps, scanBoundary, scanFile, scanPrivacy, snapshotIndex, validateManifests, verifyStatic, walk } from './verify-supported.mjs';

function fixture(callback) {
  const root = mkdtempSync(join(tmpdir(), 'pi-verifier-test-'));
  try { return callback(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
const git = (root, ...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe', env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });

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

test('registry cannot resurrect the retired cancellation extension', () => fixture(root => {
  const files = ['package.json', 'package-lock.json', '.github/workflows/verify.yml', 'scripts/verify-supported.mjs', 'scripts/verify-supported.test.mjs', 'scripts/verify-deployed-baseline.mjs', 'scripts/verify-chrono-v3-baseline.mjs'];
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'packages/temporary-orchestrator-cancel-isolation'), { recursive: true });
  for (const file of files) writeFileSync(join(root, file), '');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ piConsolidation: { products: [{ slug: 'temporary-orchestrator-cancel-isolation', status: 'active-temporary', entrypoints: ['index.ts'] }] } }));
  assert.throws(() => verifyStatic(root, files), /retired product remains registered/);
}));

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


// Copy only the frozen package, never dependencies, generated output, or HOME.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chronoRelative = 'packages/pi-chrono-compaction';
function chronoFixture(root) {
  const dir = join(root, chronoRelative);
  cpSync(join(repository, chronoRelative), dir, { recursive: true, filter: path => !['node_modules', 'dist-test'].includes(path.split('/').at(-1)) });
  return dir;
}

import { CHRONO_BASELINE, verifyChronoFiles, verifyChronoIndex, verifyFrozenChrono } from './verify-chrono-v3-baseline.mjs';

test('Chrono JSONL exception admits only the exact frozen synthetic fixture', () => fixture(root => {
  const dir = chronoFixture(root), name = `${chronoRelative}/test/fixtures/session.jsonl`;
  assert.doesNotThrow(() => scanFile(join(root, name), name));
  assert.throws(() => scanFile(join(root, name), `${chronoRelative}/test/fixtures/other.jsonl`), /runtime artifact/);
  writeFileSync(join(root, name), readFileSync(join(root, name), 'utf8') + '\n');
  assert.throws(() => scanFile(join(root, name), name), /runtime artifact/);
  writeFileSync(join(dir, 'test/secret.test.ts'), 'AKIA' + 'A'.repeat(16));
  assert.throws(() => scanFile(join(dir, 'test/secret.test.ts'), `${chronoRelative}/test/secret.test.ts`), /secret-like content/);
}));

test('Chrono test-build imports require the exact caller, spec, config, and retained source', () => fixture(root => {
  const dir = chronoFixture(root), owner = { dir, data: JSON.parse(readFileSync(join(dir, 'package.json'))) };
  const source = join(dir, 'scripts/memory-characterization.mjs');
  assert.equal(localReference(root, owner, source, '', '../dist-test/src/jsonl.js'), join(dir, 'src/jsonl.ts'));
  assert.equal(localReference(root, owner, source, '', '../dist-test/src/search-index.js'), join(dir, 'src/search-index.ts'));
  assert.throws(() => localReference(root, owner, source, '', '../dist-test/src/extra.js'), /unexpected test-build import/);
  assert.throws(() => localReference(root, owner, join(dir, 'scripts/other.mjs'), '', '../dist-test/src/jsonl.js'), /unexpected test-build import/);
  const configPath = join(dir, 'tsconfig.test-build.json'), original = readFileSync(configPath);
  const config = JSON.parse(original); config.compilerOptions.outDir = '../escape';
  writeFileSync(configPath, JSON.stringify(config));
  assert.throws(() => localReference(root, owner, source, '', '../dist-test/src/jsonl.js'), /config drift/);
  writeFileSync(configPath, original); rmSync(join(dir, 'src/jsonl.ts'));
  assert.throws(() => localReference(root, owner, source, '', '../dist-test/src/jsonl.js'), /unresolved test-build source/);
}));

test('complete Chrono tree gate rejects missing, extra, source, lock, fixture, and mode drift', () => fixture(root => {
  const dir = chronoFixture(root);
  assert.deepEqual(verifyChronoFiles(dir), { tree: CHRONO_BASELINE.tree, files: 278 });
  for (const name of ['src/jsonl.ts', 'package-lock.json', 'test/fixtures/session.jsonl']) {
    const path = join(dir, name), original = readFileSync(path);
    writeFileSync(path, Buffer.concat([original, Buffer.from('\n')]));
    assert.throws(() => verifyChronoFiles(dir), /tree-mismatch/);
    writeFileSync(path, original);
    rmSync(path); assert.throws(() => verifyChronoFiles(dir), /tree-mismatch/);
    writeFileSync(path, original);
  }
  writeFileSync(join(dir, 'extra.ts'), 'extra');
  assert.throws(() => verifyChronoFiles(dir), /tree-mismatch/);
  rmSync(join(dir, 'extra.ts'));
  symlinkSync(join(dir, 'src'), join(dir, 'escape'));
  assert.throws(() => verifyChronoFiles(dir), /unsafe-tree/);
  rmSync(join(dir, 'escape'));
  git(root, 'init', '-q'); git(root, 'add', chronoRelative);
  git(root, 'update-index', '--chmod=+x', `${chronoRelative}/src/jsonl.ts`);
  assert.throws(() => verifyChronoIndex(git(root, 'ls-files', '--stage', '-z', '--', chronoRelative).toString()), /index-tree-mismatch/);
}));

test('independent Chrono gate needs no ancestor commit and rejects index-only drift', () => fixture(root => {
  const dir = chronoFixture(root);
  git(root, 'init', '-q'); git(root, 'add', chronoRelative);
  assert.throws(() => git(root, 'cat-file', '-e', CHRONO_BASELINE.commit));
  assert.equal(verifyFrozenChrono(root).index, 'exact');
  const script = join(repository, 'scripts/verify-chrono-v3-baseline.mjs');
  const report = JSON.parse(execFileSync(process.execPath, [script, '--repository-root', root, '--allow-missing-live', '--static-only'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root } }));
  assert.equal(report.status, 'ok'); assert.equal(report.live.state, 'not-checked');
  const path = join(dir, 'src/jsonl.ts'), original = readFileSync(path);
  writeFileSync(path, Buffer.concat([original, Buffer.from('\n')])); git(root, 'add', chronoRelative);
  writeFileSync(path, original);
  assert.throws(() => verifyFrozenChrono(root), /index-tree-mismatch/);
  git(root, 'add', chronoRelative);
  git(root, 'update-index', '--force-remove', `${chronoRelative}/src/jsonl.ts`);
  assert.throws(() => verifyFrozenChrono(root), /index-tree-mismatch/);
}));

// Model compiler output deterministically; the real selected-product verifier
// separately runs the locked compiler/tests and compares all 83 tracked JS bytes.
function generatedChrono(root) {
  const dir = chronoFixture(root), files = walk(dir).map(path => relative(root, path));
  const sources = walk(dir).filter(path => path.endsWith('.ts') && !path.endsWith('.d.ts') && !path.endsWith('/test/incremental-context.test.ts'));
  for (const source of sources) {
    const rel = relative(dir, source);
    for (const output of rel.startsWith('src/') ? ['dist', 'dist-test'] : ['dist-test']) {
      const emitted = join(dir, output, rel.replace(/\.ts$/, '.js'));
      mkdirSync(dirname(emitted), { recursive: true });
      if (!existsSync(emitted)) writeFileSync(emitted, '// synthetic compiler output\n');
      writeFileSync(`${emitted}.map`, JSON.stringify({ version: 3, file: emitted.split('/').at(-1), sourceRoot: '', sources: [relative(dirname(emitted), source)], names: [], mappings: '' }));
    }
  }
  return { dir, files };
}
test('Chrono disposable build cleanup validates every generated output before removal', () => fixture(root => {
  const { dir, files } = generatedChrono(root);
  const mapPath = join(dir, 'dist/src/jsonl.js.map'), original = readFileSync(mapPath);
  writeFileSync(mapPath, JSON.stringify({ version: 3, file: 'jsonl.js', sources: ['../../../missing.ts'] }));
  assert.throws(() => finishChronoBuild(root, files), /invalid generated source map/);
  assert.ok(existsSync(join(dir, 'dist-test')));
  writeFileSync(mapPath, original);
  writeFileSync(join(dir, 'dist-test/extra.js'), 'extra');
  assert.throws(() => finishChronoBuild(root, files), /inventory drift/);
  rmSync(join(dir, 'dist-test/extra.js'));
  assert.throws(() => finishChronoBuild(root, [...files, `${chronoRelative}/dist-test/src/jsonl.js`]), /indexed test output/);
  mkdirSync(join(root, '.git'));
  assert.throws(() => finishChronoBuild(root, files), /disposable snapshot/);
  rmSync(join(root, '.git'), { recursive: true });
  finishChronoBuild(root, files);
  assert.equal(existsSync(join(dir, 'dist-test')), false);
  assert.equal(existsSync(mapPath), false);
  assert.equal(verifyChronoFiles(dir).tree, CHRONO_BASELINE.tree);
}));

test('Chrono build gate rejects changed compiled bytes and never cleans a checkout', () => fixture(root => {
  const { dir, files } = generatedChrono(root);
  const source = readFileSync(join(dir, 'src/jsonl.ts'));
  writeFileSync(join(dir, 'dist/src/jsonl.js'), 'changed compiled output');
  assert.throws(() => finishChronoBuild(root, files), /package-tree-mismatch/);
  assert.deepEqual(readFileSync(join(dir, 'src/jsonl.ts')), source);
}));


test('Chrono scripts isolate HOME, agent configuration, and tmpdir legacy namespace', () => fixture(root => {
  const env = chronoScriptEnvironment(root);
  assert.equal(env.HOME, join(root, '.verify-chrono-home'));
  assert.equal(env.PI_CODING_AGENT_DIR, join(env.HOME, 'agent'));
  assert.equal(env.TMPDIR, join(env.HOME, 'tmp'));
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH', 'PI_CODING_AGENT_DIR', 'TMPDIR']);
  const childTemp = execFileSync(process.execPath, ['--input-type=module', '-e', "import{tmpdir}from'node:os';process.stdout.write(tmpdir())"], { env, encoding: 'utf8' });
  assert.equal(childTemp, env.TMPDIR);
}));


test('explicit candidate map cleanup requires exact index/package and all 83 valid maps', () => fixture(root => {
  const { dir } = generatedChrono(root);
  rmSync(join(dir, 'dist-test'), { recursive: true });
  git(root, 'init', '-q');
  for (const path of walk(dir).filter(path => !path.endsWith('.map'))) git(root, 'add', relative(root, path));
  const map = join(dir, 'dist/src/jsonl.js.map'), original = readFileSync(map);
  assert.throws(() => verifyFrozenChrono(root), /tree-mismatch/);
  git(root, 'add', relative(root, map));
  assert.throws(() => removeChronoBuildMaps(root), /index-tree-mismatch/);
  git(root, 'update-index', '--force-remove', relative(root, map));
  rmSync(map);
  assert.throws(() => removeChronoBuildMaps(root), /map-inventory/);
  writeFileSync(map, original);
  writeFileSync(map, JSON.stringify({ version: 3, file: 'jsonl.js', sources: ['wrong.ts'] }));
  assert.throws(() => removeChronoBuildMaps(root), /map-binding/);
  assert.ok(existsSync(map));
  writeFileSync(map, original);
  writeFileSync(join(dir, 'untracked-extra'), 'extra');
  assert.throws(() => removeChronoBuildMaps(root), /tree-mismatch/);
  assert.ok(existsSync(map));
  rmSync(join(dir, 'untracked-extra'));
  assert.deepEqual(removeChronoBuildMaps(root), { status: 'passed', removedGeneratedMaps: 83, tree: CHRONO_BASELINE.tree, files: 278 });
  assert.equal(existsSync(map), false);
  assert.equal(verifyFrozenChrono(root).worktree, 'exact');
}));
