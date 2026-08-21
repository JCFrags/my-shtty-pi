import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const statuses = new Set(['quarantined', 'experimental', 'host-dependent', 'blocked', 'candidate']);
const allowedStatuses = [...statuses].sort();
const productOrder = ['chrono-compact', 'grounded-tools', 'progressive-tools', 'agent-context', 'files-ui', 'review-ui', 'tool-controls', 'herdr-status', 'native-ssh'];
const releaseOrder = ['pi-chrono-compact', 'pi-grounded-tools', 'grounded-pi-core', 'grounded-pi-dialog', 'grounded-pi-files', 'grounded-pi-lsp', 'grounded-pi-notes', 'grounded-pi-process', 'grounded-pi-tasks', 'grounded-pi-workplan', 'pi-progressive-tools', 'pi-agent-context', 'pi-files-ui', 'pi-review-ui', 'pi-tool-controls', 'pi-herdr-status', 'pi-native-ssh'];
const rootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const relativeSafe = value => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..');

export function validateCatalog(root = rootDefault) {
  const catalogFile = path.join(root, 'docs/package-catalog.json');
  const rawCatalog = fs.readFileSync(catalogFile, 'utf8');
  const catalog = JSON.parse(rawCatalog);
  const schema = json(path.join(root, 'docs/package-catalog.schema.json'));
  validateSchemaContract(schema);
  if (rawCatalog !== `${JSON.stringify(catalog, null, 2)}\n`) throw new Error('catalog: non-normalized bytes');
  if (catalog.schemaVersion !== 1 || schema.properties?.schemaVersion?.const !== 1) throw new Error('catalog: unsupported schema');
  validateCatalogObjects(catalog, schema);
  if (schema.properties?.products?.minItems !== 9 || schema.properties?.products?.maxItems !== 9 || schema.properties?.releaseUnits?.minItems !== 17 || schema.properties?.releaseUnits?.maxItems !== 17) throw new Error('catalog: schema counts');
  if (JSON.stringify(schema.$defs?.status?.enum?.slice().sort()) !== JSON.stringify(allowedStatuses)) throw new Error('catalog: schema statuses');
  if (catalog.products?.length !== 9 || JSON.stringify(catalog.products.map(p => p.id)) !== JSON.stringify(productOrder)) throw new Error('catalog: product count/order');
  if (catalog.releaseUnits?.length !== 17 || JSON.stringify(catalog.releaseUnits.map(u => u.id)) !== JSON.stringify(releaseOrder)) throw new Error('catalog: release-unit count/order');
  if (catalog.products.some(p => !productOrder.includes(p.id))) throw new Error('catalog: missing required product');
  const productIds = new Set(); const releaseIds = new Set(); const npmNames = new Set();
  const releaseById = new Map(); const manifests = new Set();
  for (const product of catalog.products) {
    if (productIds.has(product.id)) throw new Error(`catalog: duplicate product ID ${product.id}`);
    productIds.add(product.id);
    if (!product.sourceDirectory || !relativeSafe(product.sourceDirectory) || !fs.existsSync(path.join(root, product.sourceDirectory)) || !fs.statSync(path.join(root, product.sourceDirectory)).isDirectory()) throw new Error(`catalog: missing product directory ${product.id}`);
    if (!product.purpose?.trim() || !product.buildModel?.trim() || !product.operatingSystemBoundary?.trim() || !product.lifecycle?.reason?.trim() || !product.nextGate?.action?.trim()) throw new Error(`catalog: empty product field ${product.id}`);
    if (!statuses.has(product.lifecycle.status) || product.installationRecommended !== false || product.publicationAllowed !== false || product.stable !== false) throw new Error(`catalog: unsafe product flags ${product.id}`);
    if (!Array.isArray(product.releaseUnitIds) || product.releaseUnitIds.length === 0) throw new Error(`catalog: release list ${product.id}`);
    for (const entry of product.extensionEntries ?? []) validateEntry(entry, path.join(root, product.sourceDirectory));
  }
  for (const unit of catalog.releaseUnits) {
    if (releaseIds.has(unit.id)) throw new Error(`catalog: duplicate release ID ${unit.id}`);
    if (npmNames.has(unit.npmName)) throw new Error(`catalog: duplicate npm name ${unit.npmName}`);
    releaseIds.add(unit.id); npmNames.add(unit.npmName); releaseById.set(unit.id, unit);
    if (!productIds.has(unit.parentProductId) || !statuses.has(unit.lifecycleStatus) || !unit.lifecycleReason?.trim() || unit.installationRecommended !== false || unit.publicationAllowed !== false || unit.stable !== false) throw new Error(`catalog: invalid release ${unit.id}`);
    if (!relativeSafe(unit.sourceDirectory) || !relativeSafe(unit.manifestPath)) throw new Error(`catalog: unsafe release path ${unit.id}`);
    if (path.posix.normalize(unit.sourceDirectory) !== path.posix.dirname(path.posix.normalize(unit.manifestPath))) throw new Error(`catalog: source directory mismatch ${unit.id}`);
    const manifestFile = path.join(root, unit.manifestPath);
    if (!fs.existsSync(manifestFile)) throw new Error(`catalog: missing manifest ${unit.id}`);
    if (!fs.existsSync(path.join(root, unit.sourceDirectory)) || !fs.statSync(path.join(root, unit.sourceDirectory)).isDirectory()) throw new Error(`catalog: missing directory ${unit.id}`);
    manifests.add(unit.manifestPath);
    const manifest = json(manifestFile);
    const expected = { npmName: manifest.name, version: manifest.version, license: manifest.license, private: manifest.private ?? false, nodeEngine: manifest.engines?.node, peerDependencies: manifest.peerDependencies ?? {}, peerDependenciesMeta: manifest.peerDependenciesMeta ?? {}, dependencies: manifest.dependencies ?? {}, filesBoundary: manifest.files ?? [], scripts: manifest.scripts ?? {} };
    for (const [field, value] of Object.entries(expected)) if (!equal(unit[field], value)) throw new Error(`catalog: manifest drift ${unit.id}:${field}`);
    const devPi = manifest.devDependencies?.['@earendil-works/pi-coding-agent'] ?? null;
    if (unit.developmentPiVersion !== devPi) throw new Error(`catalog: development Pi drift ${unit.id}`);
    if (!Array.isArray(unit.validationCommands) || new Set(unit.validationCommands).size !== unit.validationCommands.length || unit.validationCommands.some(command => typeof command !== 'string' || !Object.hasOwn(manifest.scripts ?? {}, command))) throw new Error(`catalog: invalid validation commands ${unit.id}`);
    if (unit.validationCommands.length === 0 && Object.keys(manifest.scripts ?? {}).length !== 0) throw new Error(`catalog: empty validation commands ${unit.id}`);
    const extensionPaths = (manifest.pi?.extensions ?? []);
    if (!equal(unit.piExtensionEntries.map(e => e.path), extensionPaths)) throw new Error(`catalog: extension drift ${unit.id}`);
    for (const entry of unit.piExtensionEntries) validateEntry(entry, path.join(root, unit.sourceDirectory));
    if (!unit.lockfile || !relativeSafe(unit.lockfile.path) || !['package', 'workspace'].includes(unit.lockfile.scope)) throw new Error(`catalog: lockfile metadata ${unit.id}`);
    const lock = path.resolve(root, unit.lockfile.path);
    const manifestDirectory = path.resolve(root, path.dirname(unit.manifestPath));
    const lockDirectory = path.dirname(lock);
    if (!fs.existsSync(lock) || path.basename(lock) !== 'package-lock.json') throw new Error(`catalog: missing lockfile ${unit.id}`);
    if (unit.lockfile.scope === 'package' && lockDirectory !== manifestDirectory) throw new Error(`catalog: package lock scope ${unit.id}`);
    if (unit.lockfile.scope === 'workspace' && (lockDirectory === manifestDirectory || path.relative(lockDirectory, manifestDirectory).startsWith('..'))) throw new Error(`catalog: workspace lock scope ${unit.id}`);
  }
  for (const product of catalog.products) {
    const units = product.releaseUnitIds.map(id => releaseById.get(id));
    const expectedUnits = catalog.releaseUnits.filter(unit => unit.parentProductId === product.id);
    if (units.some(unit => !unit) || units.some(unit => unit.parentProductId !== product.id) || !equal(units, expectedUnits)) throw new Error(`catalog: bad release list ${product.id}`);
    const primary = units[0];
    if (product.primaryPackage !== primary.npmName || !equal(product.extensionEntries, primary.piExtensionEntries)) throw new Error(`catalog: primary mismatch ${product.id}`);
    const primaryManifest = json(path.join(root, primary.manifestPath));
    const primaryFields = { sourceDirectory: primary.sourceDirectory, nodeRequirement: primary.nodeEngine, lockfile: primary.lockfile, peerDependencies: primary.peerDependencies, peerDependenciesMeta: primary.peerDependenciesMeta, dependencies: primary.dependencies, filesBoundary: primary.filesBoundary, developmentPiVersion: primary.developmentPiVersion, private: primary.private };
    for (const [field, value] of Object.entries(primaryFields)) if (!equal(product[field], value)) throw new Error(`catalog: product manifest drift ${product.id}:${field}`);
    if (!equal(product.validationCommands, primaryManifest.scripts ?? {})) throw new Error(`catalog: product manifest drift ${product.id}:validationCommands`);
    if (units.some(unit => unit.lifecycleStatus !== product.lifecycle.status || unit.lifecycleReason !== product.lifecycle.reason || unit.installationRecommended !== product.installationRecommended || unit.publicationAllowed !== product.publicationAllowed || unit.stable !== product.stable)) throw new Error(`catalog: lifecycle inheritance ${product.id}`);
  }
  const discovered = discoverManifests(path.join(root, 'packages'), root).sort();
  if (!equal(discovered, [...manifests].sort())) throw new Error('catalog: uncatalogued release unit');
  walkStrings(catalog, value => { if (typeof value === 'string' && /(?<![A-Za-z0-9_])(?:\/home\/|\/root\/|\/Users\/|[A-Z]:\\Users\\)/.test(value)) throw new Error('catalog: private machine path'); });
  return catalog;
}
function validateCatalogObjects(catalog, schema) {
  validateFixedObject(catalog, schema, 'top-level catalog');
  if (!Array.isArray(catalog.products) || !Array.isArray(catalog.releaseUnits)) throw new Error('catalog: invalid top-level arrays');
  const defs = schema.$defs;
  for (const product of catalog.products) {
    validateFixedObject(product, defs.product, `product ${product.id}`);
    validateFixedObject(product.lifecycle, defs.lifecycle, `product ${product.id} lifecycle`);
    for (const entry of product.extensionEntries ?? []) validateFixedObject(entry, defs.entry, `product ${product.id} entry`);
    validateFixedObject(product.lockfile, defs.product.properties.lockfile, `product ${product.id} lockfile`);
  }
  for (const unit of catalog.releaseUnits) {
    validateFixedObject(unit, defs.releaseUnit, `release unit ${unit.id}`);
    for (const entry of unit.piExtensionEntries ?? []) validateFixedObject(entry, defs.entry, `release unit ${unit.id} entry`);
    validateFixedObject(unit.lockfile, defs.releaseUnit.properties.lockfile, `release unit ${unit.id} lockfile`);
  }
}
function validateFixedObject(value, schemaNode, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`catalog: invalid object ${label}`);
  for (const field of schemaNode.required ?? []) if (!Object.hasOwn(value, field)) throw new Error(`catalog: missing required field ${label}:${field}`);
  if (schemaNode.additionalProperties === false) for (const field of Object.keys(value)) if (!Object.hasOwn(schemaNode.properties ?? {}, field)) throw new Error(`catalog: unknown field ${label}:${field}`);
}
function validateSchemaContract(schema) {
  const required = (value, expected, label) => { if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error(`catalog: schema ${label}`); };
  if (schema.type !== 'object' || schema.additionalProperties !== false) throw new Error('catalog: schema top-level shape');
  required(schema.required, ['schemaVersion', 'catalogPurpose', 'products', 'releaseUnits'], 'top-level required fields');
  const defs = schema.$defs ?? {};
  for (const [name, fields] of Object.entries({
    entry: ['path', 'entryKind', 'existsInSource'], lifecycle: ['status', 'reason'],
    product: ['id', 'displayName', 'sourceDirectory', 'primaryPackage', 'releaseUnitIds', 'purpose', 'lifecycle', 'installationRecommended', 'publicationAllowed', 'stable', 'nodeRequirement', 'piPeerRangeOrPackageModel', 'validationCommands', 'buildModel', 'lockfile', 'extensionEntries', 'externalCommands', 'operatingSystemBoundary', 'nextGate', 'peerDependencies', 'peerDependenciesMeta', 'dependencies', 'filesBoundary', 'developmentPiVersion', 'private'],
    releaseUnit: ['id', 'parentProductId', 'sourceDirectory', 'manifestPath', 'npmName', 'version', 'license', 'private', 'nodeEngine', 'piExtensionEntries', 'peerDependencies', 'developmentPiVersion', 'filesBoundary', 'scripts', 'validationCommands', 'packageModel', 'buildModel', 'lifecycleStatus', 'lifecycleReason', 'installationRecommended', 'publicationAllowed', 'stable', 'peerDependenciesMeta', 'dependencies', 'lockfile']
  })) { if (!defs[name] || defs[name].type !== 'object' || defs[name].additionalProperties !== false) throw new Error(`catalog: schema ${name} shape`); required(defs[name].required, fields, `${name} required fields`); }
  const lockfiles = [defs.product?.properties?.lockfile, defs.releaseUnit?.properties?.lockfile];
  for (const lockfile of lockfiles) { if (!lockfile || lockfile.type !== 'object' || lockfile.additionalProperties !== false) throw new Error('catalog: schema lockfile shape'); required(lockfile.required, ['path', 'scope'], 'lockfile required fields'); }
  const expect = (condition, label) => { if (!condition) throw new Error(`catalog: schema ${label}`); };
  expect(schema.properties?.schemaVersion?.const === 1 && schema.properties?.catalogPurpose?.type === 'string', 'schema version shape');
  for (const [name, count, ref] of [['products', 9, '#/$defs/product'], ['releaseUnits', 17, '#/$defs/releaseUnit']]) { const property = schema.properties?.[name]; expect(property?.type === 'array' && property.minItems === count && property.maxItems === count && property.items?.$ref === ref, `${name} array shape`); }
  expect(defs.falseFlag?.const === false, 'false flag contract');
  expect(defs.product.properties?.lifecycle?.$ref === '#/$defs/lifecycle', 'product lifecycle link');
  expect(defs.lifecycle.properties?.status?.$ref === '#/$defs/status', 'lifecycle status link');
  expect(defs.releaseUnit.properties?.lifecycleStatus?.$ref === '#/$defs/status', 'release lifecycle status link');
  expect(defs.lifecycle.properties?.reason?.type === 'string' && defs.lifecycle.properties.reason.minLength === 1, 'lifecycle reason shape');
  for (const name of ['product', 'releaseUnit']) for (const flag of ['installationRecommended', 'publicationAllowed', 'stable']) expect(defs[name].properties?.[flag]?.$ref === '#/$defs/falseFlag', `${name} approval flag ${flag}`);
  expect(defs.entry.properties?.path?.type === 'string' && defs.entry.properties.path.pattern === '^(?!/)[^\\\\]*$', 'entry path shape');
  expect(defs.entry.properties?.entryKind?.type === 'string', 'entry kind type');
  expect(defs.entry.properties?.entryKind?.enum?.slice().sort().join('|') === 'build-entry|source-directory|source-file', 'entry kinds');
  expect(defs.entry.properties?.existsInSource?.type === 'boolean', 'entry source flag shape');
  const validation = defs.releaseUnit.properties?.validationCommands; expect(validation?.type === 'array' && validation.items?.type === 'string', 'validation command shape');
  for (const lockfile of [defs.product.properties?.lockfile, defs.releaseUnit.properties?.lockfile]) { expect(lockfile?.type === 'object' && lockfile.additionalProperties === false, 'lockfile shape'); expect(lockfile.properties?.path?.type === 'string' && lockfile.properties.path.pattern === '^(?!/)[^\\\\]*$', 'lockfile path shape'); expect(lockfile.properties?.scope?.enum?.slice().sort().join('|') === 'package|workspace', 'lockfile scope'); }
  if (defs.status.enum?.slice().sort().join('|') !== allowedStatuses.join('|')) throw new Error('catalog: schema statuses');
}
function validateEntry(entry, base) {
  if (!entry || !relativeSafe(entry.path) || !['source-file', 'source-directory', 'build-entry'].includes(entry.entryKind)) throw new Error(`catalog: bad extension entry ${entry?.path}`);
  const target = path.join(base, entry.path.replace(/^\.\//, ''));
  const exists = fs.existsSync(target);
  if (entry.entryKind === 'build-entry') { if (entry.existsInSource || exists) throw new Error(`catalog: bad build classification ${entry.path}`); return; }
  if (entry.existsInSource !== exists || !exists) throw new Error(`catalog: extension existence ${entry.path}`);
  const stat = fs.statSync(target); if (entry.entryKind === 'source-file' && !stat.isFile() || entry.entryKind === 'source-directory' && !stat.isDirectory()) throw new Error(`catalog: extension type ${entry.path}`);
}
function discoverManifests(directory, root) {
  const found = []; const excluded = new Set(['node_modules', 'dist', 'target', 'coverage', 'test', 'tests', 'fixture', 'fixtures', 'examples']);
  function visit(current) { for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { if (entry.name.startsWith('.') || excluded.has(entry.name)) continue; const next = path.join(current, entry.name); if (entry.isDirectory()) visit(next); else if (entry.name === 'package.json') found.push(path.relative(root, next).split(path.sep).join('/')); } }
  visit(directory); return found;
}
function walkStrings(value, visit) { visit(value); if (Array.isArray(value)) for (const item of value) walkStrings(item, visit); else if (value && typeof value === 'object') for (const item of Object.values(value)) walkStrings(item, visit); }
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) { try { validateCatalog(process.env.CATALOG_ROOT ? path.resolve(process.env.CATALOG_ROOT) : rootDefault); console.log('catalog: ok'); } catch (error) { console.error(error.message); process.exitCode = 1; } }
