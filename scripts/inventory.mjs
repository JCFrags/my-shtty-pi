import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCatalog } from './check-catalog.mjs';

const root = process.env.CATALOG_ROOT ? path.resolve(process.env.CATALOG_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = validateCatalog(root);
const units = new Map(catalog.releaseUnits.map(unit => [unit.id, unit]));
console.log('product\tlifecycle\tprimary-npm-package\tsource-directory\trelease-unit-count\tinstall-recommendation\tpublication-permission\tpreferred-manifest-validation\tnext-gate');
for (const product of catalog.products) {
  const primary = units.get(product.releaseUnitIds[0]);
  const command = product.validationCommands?.validate ? 'npm run validate' : product.validationCommands?.check ? 'npm run check' : Object.keys(product.validationCommands ?? {}).sort().map(key => `npm run ${key}`)[0] ?? 'no command';
  console.log([product.id, product.lifecycle.status, primary?.npmName ?? product.primaryPackage, product.sourceDirectory, product.releaseUnitIds.length, product.installationRecommended ? 'yes' : 'no', product.publicationAllowed ? 'yes' : 'no', command, product.nextGate.action].join('\t'));
}
