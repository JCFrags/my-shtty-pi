#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CHRONO_BASELINE, verifyChronoBuildMaps, verifyChronoFiles, verifyChronoIndex, verifyFrozenChrono } from './verify-chrono-v3-baseline.mjs';
import { builtinModules } from 'node:module';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const run = (command, args, cwd, options = {}) => execFileSync(command, args, { cwd, stdio: 'inherit', ...options });
const output = (command, args, cwd) => run(command, args, cwd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const within = (root, path) => path === root || path.startsWith(root + sep);
const codeFile = path => /\.(?:[cm]?[jt]sx?)$/.test(path);
const changedProducts = new Set(['pi-project-glance', 'pi-herdr-orchestrator']);

export function walk(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    if (entry.name === 'node_modules' || entry.name === '.git') return [];
    if (entry.isSymbolicLink()) throw new Error(`symlink input: ${path}`);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

// Copy index blobs, not the worktree. Ignored output and local edits cannot supply
// missing dependencies, generated files, or tests. Git object modes are checked
// before checkout-index can materialize a symlink or submodule.
export function snapshotIndex(source, destination) {
  const records = output('git', ['ls-files', '--stage', '-z'], source).split('\0').filter(Boolean);
  if (!records.length) throw new Error('empty Git index');
  for (const record of records) {
    const match = /^(100644|100755) [0-9a-f]+ 0\t(.+)$/.exec(record);
    if (!match) throw new Error('index must contain regular files at stage zero');
    const path = match[2];
    if (path.split('/').some(part => ['..', 'node_modules', '.git'].includes(part)) || !within(destination, resolve(destination, path))) {
      throw new Error(`unsafe indexed path: ${path}`);
    }
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  run('git', ['checkout-index', '--all', `--prefix=${destination}/`], source);
  return records.map(record => record.slice(record.indexOf('\t') + 1));
}

export function scanPrivacy(text, label) {
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/, /\bgh[opsu]_[A-Za-z0-9]{30,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/, /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    /https?:\/\/[^\s/@:]+:[^\s/@]+@/,
  ];
  if (patterns.some(pattern => pattern.test(text))) throw new Error(`${label}: secret-like content`);
  // Tests may contain deliberately synthetic home paths. Runtime and docs may not.
  if (!/(?:^|\/)(?:test|tests|fixtures)\//.test(label) &&
      /(?:\/home\/|\/Users\/)[A-Za-z0-9._-]+(?:\/|\b)|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/.test(text)) {
    throw new Error(`${label}: private home path`);
  }
}

export function imports(text) {
  return [
    /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/g,
    /(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /new\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
  ].flatMap(pattern => [...text.matchAll(pattern)].map(match => match[1]));
}

export function scanBoundary(text, label, slug) {
  // Presentation identities are forbidden in shipped code/config, not historical
  // documents, regression fixtures, or this verifier's own intentional ban list.
  const legacy = /\b(?:pi-signal-board|signal-board|signalboard|SignalBoard|signal_board_(?:update|question|ack)|pi-agent-board|agent-board|AgentBoard|pi-herdr-deck|pi-herdr-decks\.json|openPiHerd)\b|@pi-herdr-deck\/tui|["']\/(?:signals|signalboard|agent-board|pi-herd)(?:["'/])/;
  if (legacy.test(text)) throw new Error(`${label}: retired presentation identity`);
  const registrations = [...text.matchAll(/registerCommand\s*\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
  if (registrations.some(name => /^(?:signals?|signal-board|agent-board|pi-herd|deck|herd|herdr-deck|orchestrator-status)$/.test(name))) {
    throw new Error(`${label}: retired presentation command`);
  }
  if (slug === 'pi-project-glance') {
    if (registrations.some(name => name !== 'project-glance')) throw new Error(`${label}: Glance command alias`);
    if (/\bregister(?:Tool|Shortcut|Keybind|Hotkey|Widget|EditorWidget)\s*\(|\bsetWidget\s*\(/.test(text)) throw new Error(`${label}: Glance control surface`);
  }
  for (const spec of imports(text)) {
    if (slug === 'pi-project-glance' && /(?:pi-herdr-orchestrator|files-ui|grounded-tools|@grounded|broker|scheduler|model-policy)/.test(spec)) {
      throw new Error(`${label}: Glance cross-product import ${spec}`);
    }
    if (slug === 'pi-herdr-orchestrator' && /(?:pi-project-glance|files-ui|grounded-tools|@grounded)/.test(spec)) {
      throw new Error(`${label}: orchestrator cross-product import ${spec}`);
    }
  }
}

function isRuntime(path) {
  return !/(?:^|\/)(?:test|tests|fixtures)\//.test(path) && !/\.md$|DEPLOYED\.sha256$|(?:^|\/)LICENSE(?:\.[^/]*)?$/.test(path);
}
export function scanFile(path, rel) {
  const bytes = readFileSync(path);
  const syntheticFixture = rel === `${CHRONO_BASELINE.package}/test/fixtures/session.jsonl`
    && createHash('sha256').update(bytes).digest('hex') === '23f198ab80ffe75dec1dbf1aad28037cfa6d5141261d43ea9a82502842efe047';
  if (!syntheticFixture && /(?:^|\/)(?:\.runtime|node_modules)(?:\/|$)|\.(?:sock|tgz|jsonl|log)$/.test(rel)) throw new Error(`${rel}: runtime artifact`);
  if (bytes.includes(0)) return;
  const text = bytes.toString('utf8');
  scanPrivacy(text, rel);
  if (rel.startsWith('packages/') && isRuntime(rel)) scanBoundary(text, rel, rel.split('/')[1]);
}
function target(root, base, spec, generated = false) {
  const path = resolve(base, spec);
  if (!within(root, path)) throw new Error(`path escapes snapshot: ${spec}`);
  const candidates = [path];
  if (/\.[cm]?js$/.test(path)) candidates.push(path.replace(/\.[cm]?js$/, '.ts'), path.replace(/\.[cm]?js$/, '.d.ts'));
  if (!extname(path)) candidates.push(...['.ts', '.js', '.mjs', '.json', '/index.ts', '/index.js'].map(suffix => path + suffix));
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found && !generated) throw new Error(`unresolved local path ${relative(root, base)}: ${spec}`);
  return found;
}
export function localReference(root, owner, source, text, spec) {
  if (relative(root, owner.dir) === CHRONO_BASELINE.package && spec.startsWith('../dist-test/')) {
    if (relative(owner.dir, source) !== 'scripts/memory-characterization.mjs'
        || !['../dist-test/src/jsonl.js', '../dist-test/src/search-index.js'].includes(spec)) throw new Error('chrono: unexpected test-build import');
    const config = chronoTestBuild(owner.dir);
    const emitted = resolve(dirname(source), spec);
    const sourcePath = resolve(config.sourceRoot, relative(config.outputRoot, emitted).replace(/\.js$/, '.ts'));
    if (!within(config.outputRoot, emitted) || !within(config.sourceRoot, sourcePath) || !config.sources.includes(sourcePath)) throw new Error('chrono: unresolved test-build source');
    return sourcePath;
  }
  // import.meta.url in compiled TypeScript is relative to the emitted file,
  // not its source directory. Validate that exact emitted resource location.
  const resources = [...text.matchAll(/new\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)].map(match => match[1]);
  if (source.endsWith('.ts') && owner.data.scripts?.build && resources.includes(spec)) {
    const configPath = join(owner.dir, 'tsconfig.json');
    if (existsSync(configPath)) {
      const options = json(configPath).compilerOptions ?? {};
      if (options.outDir) {
        const sourceRoot = resolve(owner.dir, options.rootDir ?? '.');
        const emitted = resolve(owner.dir, options.outDir, relative(sourceRoot, source).replace(/\.ts$/, '.js'));
        return target(root, dirname(emitted), spec);
      }
    }
  }
  const base = dirname(source);
  return target(root, base, spec, generatedTarget(owner.data, relative(owner.dir, resolve(base, spec))));
}
function chronoTestBuild(dir) {
  const config = json(join(dir, 'tsconfig.test-build.json'));
  const base = json(join(dir, 'tsconfig.json'));
  if (config.extends !== './tsconfig.json' || config.compilerOptions?.outDir !== './dist-test'
      || config.compilerOptions?.noEmit !== false || base.compilerOptions?.rootDir !== '.'
      || base.compilerOptions?.sourceMap !== true || base.compilerOptions?.declaration !== false
      || JSON.stringify(config.include) !== JSON.stringify(['src/**/*.ts', 'src/**/*.d.ts', 'test/**/*.ts'])
      || JSON.stringify(config.exclude) !== JSON.stringify(['test/incremental-context.test.ts'])) throw new Error('chrono: test-build config drift');
  const sources = ['src', 'test'].flatMap(part => walk(join(dir, part)))
    .filter(path => path.endsWith('.ts') && !path.endsWith('.d.ts') && !config.exclude.includes(relative(dir, path)));
  return { sourceRoot: resolve(dir, base.compilerOptions.rootDir), outputRoot: resolve(dir, config.compilerOptions.outDir), sources };
}

// Called only for disposable indexed builds, after tests and before packing.
// Validate every output and source-map binding before removing any generated file.
export function finishChronoBuild(root, files) {
  if (existsSync(join(root, '.git'))) throw new Error('chrono: cleanup requires disposable snapshot');
  const generatedFiles = directory => {
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('chrono: unsafe generated output');
    return readdirSync(directory).flatMap(name => {
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('chrono: unsafe generated output');
      return stat.isDirectory() ? generatedFiles(path) : [path];
    });
  };
  const dir = join(root, CHRONO_BASELINE.package), indexed = new Set(files);
  const config = chronoTestBuild(dir);
  if (files.some(path => path.startsWith(`${CHRONO_BASELINE.package}/dist-test/`))) throw new Error('chrono: indexed test output');
  const validateMaps = (outputRoot, sources) => {
    const expected = sources.flatMap(source => {
      if (!indexed.has(relative(root, source))) throw new Error('chrono: unindexed build source');
      const emitted = join(outputRoot, relative(config.sourceRoot, source).replace(/\.ts$/, '.js'));
      return [emitted, `${emitted}.map`];
    }).sort();
    const actual = generatedFiles(outputRoot).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('chrono: generated output inventory drift');
    for (const path of actual) {
      scanFile(path, relative(root, path));
      if (!path.endsWith('.map')) continue;
      if (indexed.has(relative(root, path))) throw new Error('chrono: indexed generated map');
      const map = json(path);
      const expectedSource = resolve(config.sourceRoot, relative(outputRoot, path).replace(/\.js\.map$/, '.ts'));
      if (map.version !== 3 || map.file !== path.slice(path.lastIndexOf('/') + 1, -4)
          || map.sourceRoot !== '' || !Array.isArray(map.sources) || map.sources.length !== 1
          || resolve(dirname(path), map.sources[0]) !== expectedSource || !sources.includes(expectedSource)) throw new Error('chrono: invalid generated source map');
    }
    return actual.filter(path => path.endsWith('.map'));
  };
  validateMaps(config.outputRoot, config.sources);
  const runtimeSources = config.sources.filter(path => within(join(dir, 'src'), path));
  const runtimeMaps = validateMaps(join(dir, 'dist'), runtimeSources);
  // All removals are proven unindexed compiler output in this disposable build.
  rmSync(config.outputRoot, { recursive: true });
  for (const path of runtimeMaps) rmSync(path);
  verifyChronoFiles(dir);
}

function manifestTargets(value) {
  if (typeof value === 'string') return [value];
  return value && typeof value === 'object' ? Object.values(value).flatMap(manifestTargets) : [];
}
function generatedTarget(manifest, spec) {
  return !!manifest.scripts?.build && /^(?:\.\/)?dist\//.test(spec);
}
export function validateManifests(root, files) {
  const rootLock = json(join(root, 'package-lock.json'));
  const workspaces = json(join(root, 'package.json')).workspaces ?? [];
  const manifests = files.filter(path => path.endsWith('/package.json') || path === 'package.json').map(path => ({
    path, dir: dirname(join(root, path)), data: json(join(root, path)),
  }));
  const local = new Map();
  for (const manifest of manifests) {
    const { data, path, dir } = manifest;
    if (!data.name || local.has(data.name)) throw new Error(`${path}: missing or duplicate package name`);
    local.set(data.name, manifest);
    const dependencies = { ...data.dependencies, ...data.devDependencies, ...data.peerDependencies, ...data.optionalDependencies };
    const lockPath = join(dir, 'package-lock.json');
    const workspace = workspaces.includes(relative(root, dir));
    if ((data.dependencies || data.devDependencies) && !existsSync(lockPath) && !workspace) throw new Error(`${path}: dependencies require indexed lockfile`);
    if (existsSync(lockPath) || workspace) {
      const lock = workspace ? rootLock.packages?.[relative(root, dir)] : json(lockPath).packages?.[''];
      if (!lock) throw new Error(`${path}: missing lock root`);
      for (const key of ['name', 'version', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        if (JSON.stringify(data[key]) !== JSON.stringify(lock[key])) throw new Error(`${path}: lock mismatch for ${key}`);
      }
    }
    for (const [name, spec] of Object.entries(dependencies)) {
      if (/^(?:file|link):/.test(spec)) target(root, dir, spec.replace(/^(?:file|link):/, ''));
      if (name.includes('pi-herdr-deck') || name.includes('pi-signal-board')) throw new Error(`${path}: retired dependency ${name}`);
    }
    for (const spec of [...manifestTargets(data.pi?.extensions), ...manifestTargets(data.bin), ...manifestTargets(data.exports), ...manifestTargets(data.main)]) {
      if (spec.includes('*')) continue;
      target(root, dir, spec, generatedTarget(data, spec));
    }
  }
  for (const rel of files.filter(codeFile)) {
    if (!rel.startsWith('packages/') || !isRuntime(rel)) continue;
    const owner = manifests.filter(manifest => within(manifest.dir, join(root, rel))).sort((a, b) => b.dir.length - a.dir.length)[0];
    const declared = { ...owner.data.dependencies, ...owner.data.devDependencies, ...owner.data.peerDependencies, ...owner.data.optionalDependencies };
    const text = readFileSync(join(root, rel), 'utf8');
    for (const spec of imports(text)) {
      if (spec.startsWith('.')) {
        localReference(root, owner, join(root, rel), text, spec);
        continue;
      }
      if (spec.startsWith('node:') || builtinModules.includes(spec)) continue;
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (local.has(name)) {
        const dependency = local.get(name);
        const key = spec === name ? '.' : `./${spec.slice(name.length + 1)}`;
        const exported = dependency.data.exports?.[key];
        if (!exported) throw new Error(`${rel}: unresolved local export ${spec}`);
        for (const value of manifestTargets(exported)) target(root, dependency.dir, value);
      } else if (!declared[name] && !['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', '@earendil-works/pi-ai', '@sinclair/typebox', 'typebox'].includes(name)) {
        throw new Error(`${rel}: undeclared dependency ${spec}`);
      }
    }
  }
  return manifests;
}

export function verifyStatic(root, files) {
  for (const path of ['package.json', 'package-lock.json', '.github/workflows/verify.yml', 'scripts/verify-supported.mjs', 'scripts/verify-supported.test.mjs', 'scripts/verify-deployed-baseline.mjs', 'scripts/verify-chrono-v3-baseline.mjs']) {
    if (!files.includes(path)) throw new Error(`required indexed root input: ${path}`);
  }
  for (const rel of files) scanFile(join(root, rel), rel);
  const products = json(join(root, 'package.json')).piConsolidation?.products;
  if (!Array.isArray(products) || new Set(products.map(p => p.slug)).size !== products.length) throw new Error('invalid product registry');
  const dirs = readdirSync(join(root, 'packages'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  if (JSON.stringify(dirs) !== JSON.stringify(products.map(p => p.slug).sort())) throw new Error('package directories differ from supported registry');
  if (products.some(p => ['pi-signal-board', 'temporary-orchestrator-cancel-isolation'].includes(p.slug))) throw new Error('retired product remains registered');
  if (products.find(p => p.slug === 'pi-project-glance')?.status !== 'active') throw new Error('Project Glance must be active');
  const manifests = validateManifests(root, files);
  if (products.some(product => product.slug === 'pi-chrono-compaction')) verifyChronoFiles(join(root, CHRONO_BASELINE.package));
  for (const product of products) {
    if (!['active', 'inactive', 'active-temporary'].includes(product.status) || !product.entrypoints?.length) throw new Error(`${product.slug}: invalid status/entrypoints`);
    const dir = join(root, 'packages', product.slug);
    const manifest = json(join(dir, 'package.json'));
    for (const spec of [...product.entrypoints, ...(product.runtimeResources ?? []), ...(product.sourceEntrypoints ?? [])]) target(root, dir, spec, generatedTarget(manifest, spec));
    if (changedProducts.has(product.slug)) {
      for (const script of ['typecheck', 'test', 'build']) if (!manifest.scripts?.[script]) throw new Error(`${product.slug}: required ${script} script missing`);
    }
  }
  return { products, manifests };
}

// Explicitly requested candidate cleanup only: exact index + complete working
// package proof, all 83 regular maps bound to retained sources, then map-only
// unlink. Unlike finishChronoBuild, this helper can operate on a candidate Git
// checkout. It never removes dist-test, dependencies, or indexed package files.
export function removeChronoBuildMaps(root) {
  verifyChronoIndex(output('git', ['ls-files', '--stage', '-z', '--', CHRONO_BASELINE.package], root));
  const dir = join(root, CHRONO_BASELINE.package);
  const { maps } = verifyChronoBuildMaps(dir);
  for (const path of maps) rmSync(path);
  const identity = verifyChronoFiles(dir);
  return { status: 'passed', removedGeneratedMaps: maps.length, ...identity };
}

export function chronoScriptEnvironment(root) {
  const home = join(root, '.verify-chrono-home');
  const temporary = join(home, 'tmp');
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  return { PATH: process.env.PATH, HOME: home, TMPDIR: temporary, PI_CODING_AGENT_DIR: join(home, 'agent'), LANG: 'C.UTF-8' };
}

export function executeProducts(root, files, state, selected) {
  const env = { ...process.env, PYTHONPYCACHEPREFIX: join(root, '.verify-python-cache'), PI_PROJECT_GLANCE_VERIFIER_COPY: '1', PI_PROJECT_GLANCE_PROVIDER_ROOT: root };
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], root, { env });
  const products = state.products.filter(p => !selected || p.slug === selected);
  for (const product of products) {
    const dir = join(root, 'packages', product.slug);
    const manifest = json(join(dir, 'package.json'));
    const scriptEnv = product.slug === 'pi-chrono-compaction' ? chronoScriptEnvironment(root) : env;
    // Install all nested locked dependencies needed by a selected product.
    for (const nested of state.manifests.filter(m => within(dir, m.dir))) {
      if (existsSync(join(nested.dir, 'package-lock.json'))) run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], nested.dir, { env });
    }
    const committedDist = files.filter(path => path.startsWith(`packages/${product.slug}/dist/`));
    const expected = new Map(committedDist.map(path => [path, readFileSync(join(root, path))]));
    if (manifest.scripts?.build) rmSync(join(dir, 'dist'), { recursive: true, force: true });
    for (const script of ['typecheck', 'syntax', 'build', 'test']) {
      if (manifest.scripts?.[script]) run('npm', ['run', '--ignore-scripts', script], dir, { env: scriptEnv });
    }
    if (manifest.scripts?.build && !changedProducts.has(product.slug)) {
      for (const [path, bytes] of expected) if (!existsSync(join(root, path)) || !readFileSync(join(root, path)).equals(bytes)) throw new Error(`${path}: tracked compiled output differs from build`);
      const actualJs = walk(join(dir, 'dist')).filter(path => path.endsWith('.js')).map(path => relative(root, path)).sort();
      const trackedJs = committedDist.filter(path => path.endsWith('.js')).sort();
      if (JSON.stringify(actualJs) !== JSON.stringify(trackedJs)) throw new Error(`${product.slug}: build JavaScript inventory differs from indexed output`);
    }
    if (product.slug === 'pi-chrono-compaction') finishChronoBuild(root, files);
    for (const entry of [...product.entrypoints, ...manifestTargets(manifest.pi?.extensions), ...manifestTargets(manifest.bin)]) target(root, dir, entry);
    for (const path of walk(dir)) {
      scanFile(path, relative(root, path));
      if (codeFile(path) && isRuntime(relative(dir, path))) {
        const text = readFileSync(path, 'utf8');
        for (const spec of imports(text)) if (spec.startsWith('.')) localReference(root, { dir, data: manifest }, path, text, spec);
      }
    }
    const packs = JSON.parse(output('npm', ['pack', '--json', '--ignore-scripts'], dir));
    if (packs.length !== 1 || !packs[0].files?.length || !existsSync(join(dir, packs[0].filename))) throw new Error(`${product.slug}: invalid npm pack result`);
    const packed = new Set(packs[0].files.map(file => file.path));
    const indexed = new Set(files.filter(path => path.startsWith(`packages/${product.slug}/`)).map(path => path.slice(`packages/${product.slug}/`.length)));
    const generated = new Set(manifest.scripts?.build && existsSync(join(dir, 'dist')) ? walk(join(dir, 'dist')).map(path => relative(dir, path)) : []);
    for (const path of packed) {
      if (!indexed.has(path) && !generated.has(path)) throw new Error(`${product.slug}: pack includes unexplained output ${path}`);
      if (!within(dir, resolve(dir, path)) || !existsSync(join(dir, path))) throw new Error(`${product.slug}: unsafe pack member`);
      scanFile(join(dir, path), `packages/${product.slug}/${path}`);
    }
    for (const entry of [...product.entrypoints, ...manifestTargets(manifest.bin), ...generated]) if (!packed.has(entry.replace(/^\.\//, ''))) throw new Error(`${product.slug}: pack omitted ${entry}`);
    console.log(`PASS ${product.slug}: supported scripts and pack`);
  }
  // These tests execute real providers from this same disposable indexed tree.
  if (!selected || selected === 'grounded-tools' || selected === 'pi-project-glance') {
    for (const provider of ['workplan', 'dialog']) {
      const dir = join(root, `packages/grounded-tools/${provider}`);
      const tests = walk(join(dir, 'test')).filter(path => path.endsWith('.test.mjs'));
      if (!tests.length) throw new Error(`${provider} tests missing`);
      run(process.execPath, ['--experimental-transform-types', '--test', ...tests], dir, { env });
    }
  }
}

export function main(args = process.argv.slice(2)) {
  let selected;
  let staticOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--static-only') staticOnly = true;
    else if (args[i] === '--product' && args[i + 1] && !args[i + 1].startsWith('-')) selected = args[++i];
    else throw new Error(`unknown or incomplete argument: ${args[i]}`);
  }
  const temp = mkdtempSync(join(tmpdir(), 'pi-supported-verify-'));
  chmodSync(temp, 0o700);
  try {
    const root = join(temp, 'repo');
    verifyFrozenChrono(here);
    const files = snapshotIndex(here, root);
    const state = verifyStatic(root, files);
    if (selected && !state.products.some(p => p.slug === selected)) throw new Error(`unknown product: ${selected}`);
    // Run the indexed root regression suite, never an untracked local substitute.
    run(process.execPath, ['--test', 'scripts/verify-supported.test.mjs'], root);
    if (!staticOnly) executeProducts(root, files, state, selected);
    console.log(JSON.stringify({ status: 'pass', inputs: 'Git index', staticOnly, product: selected ?? 'all', products: state.products.length, files: files.length }));
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
