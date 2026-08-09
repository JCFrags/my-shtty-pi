import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateRoot } from '../check-root-policy.mjs';
import { validateCatalog } from '../check-catalog.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const fixtures = new Set();
afterEach(() => { for (const directory of fixtures) fs.rmSync(directory, { recursive: true, force: true }); fixtures.clear(); });
function temporary(prefix) { const directory = fs.mkdtempSync(prefix); fixtures.add(directory); return directory; }
function altered(mutator) {
  const directory = temporary('/tmp/repo-policy-');
  fs.cpSync(path.join(root, 'docs'), path.join(directory, 'docs'), { recursive: true });
  fs.cpSync(path.join(root, 'packages'), path.join(directory, 'packages'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(directory, 'package.json'));
  fs.copyFileSync(path.join(root, '.node-version'), path.join(directory, '.node-version'));
  mutator(directory);
  return directory;
}
test('root policy accepts canonical root', () => assert.doesNotThrow(() => validateRoot(root)));
test('catalog accepts canonical catalog', () => assert.doesNotThrow(() => validateCatalog(root)));
test('root policy rejects wrong engine, missing script, and altered script command', () => { for (const mutate of [d => edit(d, p => p.engines.node = '>=21'), d => edit(d, p => delete p.scripts.inventory), d => edit(d, p => p.scripts.check = 'node packages/unsafe.mjs')]) assert.throws(() => validateRoot(altered(mutate)), /root policy:/); });
test('root policy rejects private workspace dependency devDependency root-lock version packageManager failures', () => {
  for (const [name, mutate] of Object.entries({ private: d => edit(d, p => p.private = false), workspace: d => edit(d, p => p.workspaces = ['packages/*']), dependency: d => edit(d, p => p.dependencies = { x: '1' }), devDependency: d => edit(d, p => p.devDependencies = { x: '1' }), 'root-lock': d => fs.writeFileSync(path.join(d, 'package-lock.json'), '{}'), version: d => fs.writeFileSync(path.join(d, '.node-version'), '21.0.0'), packageManager: d => edit(d, p => p.packageManager = 'npm@9') })) { const d = altered(mutate); assert.throws(() => validateRoot(d), /root policy:/); }
});
test('catalog rejects local schema count/status controls', () => { for (const mutate of [d => editSchema(d, s => s.properties.products.minItems = 6), d => editSchema(d, s => s.$defs.status.enum = ['unknown'])]) assert.throws(() => validateCatalog(altered(mutate)), /catalog:/); });
test('catalog rejects unsupported schema, missing product, unknown status, and duplicate product ID', () => {
  for (const [name, mutate] of Object.entries({ schema: d => editCatalog(d, c => c.schemaVersion = 2), product: d => editCatalog(d, c => c.products.pop()), status: d => editCatalog(d, c => c.products[0].lifecycle.status = 'unknown'), duplicate: d => editCatalog(d, c => c.products[1].id = c.products[0].id) })) { const d = altered(mutate); assert.throws(() => validateCatalog(d), /catalog:/, name); }
});
test('catalog rejects release order, unsafe lock path, and unknown lock scope', () => { for (const mutate of [d => editCatalog(d, c => [c.releaseUnits[0], c.releaseUnits[1]] = [c.releaseUnits[1], c.releaseUnits[0]]), d => editCatalog(d, c => c.releaseUnits[0].lockfile.path = ['/', 'root', 'private', 'package-lock.json'].join('/')), d => editCatalog(d, c => c.releaseUnits[0].lockfile.scope = 'unknown')]) assert.throws(() => validateCatalog(altered(mutate)), /catalog:/); });
test('catalog rejects duplicate release ID/name, missing directory/manifest, and uncatalogued unit', () => {
  for (const mutate of [d => editCatalog(d, c => c.releaseUnits[1].id = c.releaseUnits[0].id), d => editCatalog(d, c => c.releaseUnits[1].npmName = c.releaseUnits[0].npmName), d => removeTree(path.join(d, 'packages/chrono-compact')),  d => editCatalog(d, c => c.releaseUnits[0].manifestPath = 'packages/missing/package.json'), d => { fs.mkdirSync(path.join(d, 'packages/extra')); fs.writeFileSync(path.join(d, 'packages/extra/package.json'), '{}'); }]) { assert.throws(() => validateCatalog(altered(mutate)), /catalog:/); }
});
test('catalog rejects each direct manifest drift class', () => {
  const fields = { name: m => m.name = 'wrong-name', version: m => m.version = '9.9.9', license: m => m.license = 'NOPE', engine: m => m.engines.node = '>=1', scripts: m => m.scripts = { changed: 'x' }, files: m => m.files = ['wrong'], peers: m => m.peerDependencies = { wrong: '1' }, peerMeta: m => m.peerDependenciesMeta = { wrong: { optional: true } }, dependencies: m => m.dependencies = { wrong: '1' }, developmentPi: m => m.devDependencies['@earendil-works/pi-coding-agent'] = '9.9.9' };
  for (const [name, mutate] of Object.entries(fields)) assert.throws(() => validateCatalog(altered(d => editManifest(d, mutate))), /catalog:/, name);
});
test('catalog rejects every product primary manifest duplicate drift', () => {
  const fields = {
    sourceDirectory: 'packages/grounded-tools', nodeRequirement: '>=99', lockfile: { path: 'packages/grounded-tools/package-lock.json', scope: 'package' },
    peerDependencies: { wrong: '1' }, peerDependenciesMeta: { wrong: { optional: true } }, dependencies: { wrong: '1' }, filesBoundary: ['wrong'], developmentPiVersion: '9.9.9', private: true,
    validationCommands: { wrong: 'command' }
  };
  for (const [field, value] of Object.entries(fields)) assert.throws(() => validateCatalog(altered(d => editCatalog(d, c => c.products[0][field] = value))), new RegExp(`catalog: product manifest drift chrono-compact:${field}`), field);
});
test('catalog rejects a release source directory that differs from its manifest directory', () => assert.throws(() => validateCatalog(altered(d => editCatalog(d, c => c.releaseUnits[0].sourceDirectory = 'packages'))), /catalog: source directory mismatch pi-chrono-compact/));
test('catalog rejects extension drift/type, existence, flags, empty reason/gate, parent/list/inheritance, and primary fields', () => {
  const cases = [d => editCatalog(d, c => c.releaseUnits[0].piExtensionEntries[0].path = './missing.js'), d => editCatalog(d, c => c.releaseUnits[0].piExtensionEntries[0].entryKind = 'source-file'), d => editCatalog(d, c => c.releaseUnits[0].piExtensionEntries[0].existsInSource = true), d => editCatalog(d, c => c.products[0].publicationAllowed = true), d => editCatalog(d, c => c.products[0].lifecycle.reason = ''), d => editCatalog(d, c => c.products[0].nextGate.action = ''), d => editCatalog(d, c => c.releaseUnits[0].parentProductId = 'missing'), d => editCatalog(d, c => c.products[0].releaseUnitIds = []), d => editCatalog(d, c => c.releaseUnits[0].lifecycleStatus = 'candidate'), d => editCatalog(d, c => c.products[0].primaryPackage = 'wrong'), d => editCatalog(d, c => c.products[0].extensionEntries = [])]; for (const mutate of cases) assert.throws(() => validateCatalog(altered(mutate)), /catalog:/);
  for (const field of ['installationRecommended', 'publicationAllowed', 'stable']) for (const value of [undefined, 'false', 0, null]) assert.throws(() => validateCatalog(altered(d => editCatalog(d, c => { delete c.products[0][field]; if (value !== undefined) c.products[0][field] = value; }))), /catalog: unsafe product flags/);
  for (const field of ['installationRecommended', 'publicationAllowed', 'stable']) for (const value of [undefined, 'false', 0, null]) assert.throws(() => validateCatalog(altered(d => editCatalog(d, c => { delete c.releaseUnits[0][field]; if (value !== undefined) c.releaseUnits[0][field] = value; }))), /catalog: invalid release/);
});
test('catalog rejects private paths and non-normalized bytes', () => { assert.throws(() => validateCatalog(altered(d => editCatalog(d, c => c.products[0].purpose = ['/home', 'private'].join('/')))), /catalog: private machine path/); assert.throws(() => validateCatalog(altered(d => editCatalog(d, c => c.products[0].purpose = ['/root', 'private'].join('/')))), /catalog: private machine path/); assert.throws(() => validateCatalog(altered(d => { const file = path.join(d, 'docs/package-catalog.json'); fs.writeFileSync(file, JSON.stringify(JSON.parse(fs.readFileSync(file)), null, 0)); })), /catalog: non-normalized bytes/); });
test('catalog rejects non-normalized product order', () => assert.throws(() => validateCatalog(altered(d => editCatalog(d, c => [c.products[0], c.products[1]] = [c.products[1], c.products[0]]))), /catalog:/));
function removeTree(directory) { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const target = path.join(directory, entry.name); if (entry.isDirectory()) removeTree(target); else fs.unlinkSync(target); } fs.rmdirSync(directory); }
function edit(directory, mutator) { const file = path.join(directory, 'package.json'); const value = JSON.parse(fs.readFileSync(file)); mutator(value); fs.writeFileSync(file, JSON.stringify(value)); }
function editSchema(directory, mutator) { const file = path.join(directory, 'docs/package-catalog.schema.json'); const value = JSON.parse(fs.readFileSync(file)); mutator(value); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function editCatalog(directory, mutator) { const file = path.join(directory, 'docs/package-catalog.json'); const value = JSON.parse(fs.readFileSync(file)); mutator(value); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function editManifest(directory, mutator) { const file = path.join(directory, 'packages/chrono-compact/package.json'); const value = JSON.parse(fs.readFileSync(file)); mutator(value); fs.writeFileSync(file, JSON.stringify(value)); }
