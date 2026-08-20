import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const fixtures = new Set();
afterEach(() => { for (const directory of fixtures) fs.rmSync(directory, { recursive: true, force: true }); fixtures.clear(); });
function temporary(prefix) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); fixtures.add(directory); return directory; }
function capture(environment = {}) { const result = spawnSync(process.execPath, ['scripts/inventory.mjs'], { cwd: root, encoding: 'utf8', env: { ...process.env, ...environment } }); assert.equal(result.status, 0); return result.stdout; }
test('inventory has required header and columns', () => { const lines = capture().trimEnd().split('\n'); assert.equal(lines[0], 'product\tlifecycle\tprimary-npm-package\tsource-directory\trelease-unit-count\tinstall-recommendation\tpublication-permission\tpreferred-manifest-validation\tnext-gate'); assert.equal(lines.length, 9); for (const line of lines.slice(1)) assert.equal(line.split('\t').length, 9); });
test('inventory is stable, useful, and non-writing', () => { const before = fs.readFileSync(path.join(root, 'docs/package-catalog.json')); const first = capture(); const second = capture(); assert.equal(first, second); assert.match(first, /npm run (?:check|validate)/); assert.match(first, /its current product scope/); assert.deepEqual(fs.readFileSync(path.join(root, 'docs/package-catalog.json')), before); });
test('inventory honors explicit catalog root with spaces', () => { const fixture = temporary('catalog root with spaces-'); fs.cpSync(path.join(root, 'docs'), path.join(fixture, 'docs'), { recursive: true }); fs.cpSync(path.join(root, 'packages'), path.join(fixture, 'packages'), { recursive: true }); assert.equal(capture({ CATALOG_ROOT: fixture }), capture({ CATALOG_ROOT: fixture })); });
test('inventory rejects manifest drift', () => { const fixture = temporary('catalog manifest drift-'); fs.cpSync(path.join(root, 'docs'), path.join(fixture, 'docs'), { recursive: true }); fs.cpSync(path.join(root, 'packages'), path.join(fixture, 'packages'), { recursive: true }); const manifest = path.join(fixture, 'packages/chrono-compact/package.json'); const value = JSON.parse(fs.readFileSync(manifest)); value.version = '99.99.99'; fs.writeFileSync(manifest, JSON.stringify(value, null, 2) + '\n'); const result = spawnSync(process.execPath, ['scripts/inventory.mjs'], { cwd: root, encoding: 'utf8', env: { ...process.env, CATALOG_ROOT: fixture } }); assert.notEqual(result.status, 0); assert.match(result.stderr, /catalog: manifest drift/); });
