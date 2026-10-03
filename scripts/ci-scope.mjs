#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imports } from './verify-supported.mjs';

// Changed provider -> consumer checks. Include inactive products and test/event
// contracts, not just manifest dependencies. Keep these keys equal to the registry.
export const dependents = {
  'codex-usage-footer': [],
  'files-ui': [],
  'grounded-tools': ['pi-context-kit', 'pi-project-glance', 'pi-self-reload', 'pi-chrono-compaction', 'pi-native-ssh', 'herdr-agent-state'],
  'herdr-agent-state': ['pi-herdr-orchestrator'],
  'herdr-status': [],
  'pi-agent-context': [],
  'pi-chrono-compaction': ['pi-context-kit'],
  'pi-context-kit': ['grounded-tools', 'pi-chrono-compaction', 'pi-project-glance'],
  'pi-herdr-orchestrator': [],
  'pi-notify': [],
  'pi-native-ssh': ['grounded-tools'],
  'pi-pixel-cua': [],
  'pi-progressive-tools': ['pi-herdr-orchestrator'],
  'pi-project-glance': [],
  'pi-self-reload': [],
  'pi-review-ui': [],
  'pi-tool-controls': ['grounded-tools', 'pi-context-kit', 'pi-herdr-orchestrator'],
};

const sharedPrefixes = [
  'packages/grounded-tools/core/',
  'packages/pi-context-kit/protocol/',
  'packages/pi-context-kit/state-store/',
  'packages/pi-tool-controls/presentation/',
];
const browserPrefix = 'vendor/terminal-browser/';
// Human documentation only. Markdown fixtures and generated skill templates
// remain product inputs. Shared runtime directories do not make prose executable.
export function isDocumentation(path) {
  if (!path.endsWith('.md')) return false;
  if (path === 'README.md' || path.startsWith('docs/') || path.startsWith('skills/')) return true;
  if (Object.hasOwn(dependents, owner(path))) {
    return /\/(?:README|AGENTS|API|CONTRACT)\.md$/.test(path) || /\/docs\/.+\.md$/.test(path);
  }
  return path.startsWith(browserPrefix) && (/\/(?:README)\.md$/.test(path) || path.startsWith(`${browserPrefix}docs/`));
}
// This exact subproject contract overrides the shared-core fallback, not its
// parent directories. The standalone runner is delivered with the LSP repair.
export const lspFiles = [
  'scripts/verify-lsp.mjs',
  'packages/grounded-tools/lsp/index.ts',
  'packages/grounded-tools/core/src/lsp-client.ts',
  'packages/grounded-tools/README.md',
  'packages/grounded-tools/lsp/rust-launch.ts',
  'packages/grounded-tools/lsp/test/lifecycle.test.mjs',
  'packages/grounded-tools/lsp/test/fixtures/fake-lsp.mjs',
  'packages/grounded-tools/lsp/test/fixtures/owner.mjs',
];
const newLspFiles = lspFiles.filter((_, index) => index === 0 || index >= 4);
const manifestEvidenceSha256 = '8936ccd783a0bf9763f18a38ee677b505cd1f58d630bc548852abaa0b008520f';
const metadata = new Set(['name', 'version', 'description', 'author', 'contributors', 'keywords', 'license', 'repository', 'homepage', 'bugs', 'funding']);
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const withoutMetadata = value => Object.fromEntries(Object.entries(value).filter(([key]) => !metadata.has(key)));
const owner = path => /^packages\/([^/]+)\//.exec(path)?.[1];
const read = (root, path) => {
  const absolute = join(root, path);
  if (!lstatSync(absolute).isFile()) throw new Error('Non-regular evidence input.');
  return readFileSync(absolute, 'utf8');
};
const git = (root, ...args) => new TextDecoder('utf-8', { fatal: true }).decode(
  execFileSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));

export function affectedProducts(selected) {
  const result = new Set(selected);
  for (const product of result) {
    if (!Object.hasOwn(dependents, product)) throw new Error('Unknown product.');
    for (const consumer of dependents[product]) result.add(consumer);
  }
  return [...result].sort();
}

// Pin declared dependency/build evidence until the map is reviewed. Formatting
// and descriptive/version-only edits do not change this projection. Lockfile
// dependency versions remain significant; only the lock's own metadata is ignored.
export function dependencyEvidence(root, files) {
  const records = [];
  const names = new Map();
  for (const path of files.filter(path => owner(path) && /(?:^|\/)package(?:-lock)?\.json$/.test(path)).sort()) {
    const data = JSON.parse(read(root, path));
    const projected = withoutMetadata(data);
    if (path.endsWith('/package-lock.json')) {
      if (projected.packages?.['']) projected.packages = { ...projected.packages, '': withoutMetadata(projected.packages['']) };
    } else if (typeof data.name === 'string') {
      if (names.has(data.name)) throw new Error('Duplicate local package name.');
      names.set(data.name, owner(path));
    }
    records.push([path, canonical(projected)]);
  }
  return { sha256: createHash('sha256').update(JSON.stringify(records)).digest('hex'), names };
}

export function lspReadiness(root) {
  try {
    const entries = new Map(git(root, 'ls-tree', '-r', '-z', 'HEAD', '--', ...lspFiles).split('\0').filter(Boolean).map(record => {
      const [entry, path] = record.split('\t');
      return [path, /^(100644|100755) blob [0-9a-f]{40}$/.test(entry)];
    }));
    if (lspFiles.every(path => entries.get(path) === true)) return 'ready';
    // Only pre-runner history can omit this check. Removing a delivered runner
    // or even one fixture must not restore the legacy skip.
    if (newLspFiles.every(path => !entries.has(path))
        && lspFiles.filter(path => !newLspFiles.includes(path)).every(path => entries.get(path) === true)
        && git(root, 'rev-parse', '--is-shallow-repository').trim() === 'false'
        && !git(root, 'log', '--full-history', '-1', '--format=%H', 'HEAD', '--', ...newLspFiles).trim()) return 'legacy';
  } catch { /* Missing or unsafe Git evidence is not a legacy installation. */ }
  return 'invalid';
}

// A documentation hash refresh is not a browser runtime change. Keep inventory,
// source attribution, modes, removed records, and all non-document records exact.
function documentationProvenance(root, base, head) {
  const path = `${browserPrefix}copy-provenance.json`;
  const projection = commit => {
    const data = JSON.parse(git(root, 'show', `${commit}:${path}`));
    return canonical({ ...data, files: data.files.map(record => isDocumentation(`${browserPrefix}${record.path}`)
      ? { ...record, sha256: null, modified: null } : record) });
  };
  return JSON.stringify(projection(base)) === JSON.stringify(projection(head));
}

function verifyLspConsumers(root, files) {
  for (const path of files.filter(path => /\.[cm]?[jt]sx?$/.test(path))) {
    if (!lspFiles.includes(path) && imports(read(root, path)).some(spec => /(?:^|\/)lsp-client(?:\.[cm]?[jt]s)?$/.test(spec))) {
      throw new Error('LSP client has a consumer outside its exact verification lane.');
    }
  }
}

function verifyMapping(root, files) {
  const registry = JSON.parse(read(root, 'package.json')).piConsolidation?.products?.map(product => product.slug).sort();
  const expected = Object.keys(dependents).sort();
  const actual = [...new Set(files.map(owner).filter(Boolean))].sort();
  if (JSON.stringify(registry) !== JSON.stringify(expected) || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Product registry or ownership drift.');
  }
  const evidence = dependencyEvidence(root, files);
  if (evidence.sha256 !== manifestEvidenceSha256) throw new Error('Declared dependency or build evidence changed.');
  // Reuse the verifier's literal import discovery for an additional runtime guard.
  // Computed loads, test fixtures, and event contracts still need explicit map review.
  for (const path of files.filter(path => (owner(path) || path.startsWith(browserPrefix)) && /\.[cm]?[jt]sx?$/.test(path)
      && !/(?:^|\/)(?:test|tests|fixtures|checks)\//.test(path))) {
    const consumer = owner(path);
    for (const spec of imports(read(root, path))) {
      const target = spec.startsWith('.') ? relative(root, resolve(root, dirname(path), spec)) : undefined;
      const provider = target ? owner(target) : evidence.names.get(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
      if ((consumer && target?.startsWith(browserPrefix)) || (provider && !affectedProducts([provider]).includes(consumer))) {
        throw new Error('Unmapped cross-project runtime import.');
      }
    }
  }
}

export function selectScope(root, env = process.env) {
  const lspState = lspReadiness(root);
  const finish = selection => ({ ...selection, lspState,
    lsp: selection.mode === 'lsp' || lspState === 'invalid'
      || (lspState === 'ready' && (selection.mode === 'full' || selection.products.includes('grounded-tools'))),
  });
  const full = reason => finish({ mode: 'full', browser: true, products: [], reason });
  try {
    let base, head;
    const checkout = env.CHECKOUT_SHA;
    const sha = value => /^[0-9a-f]{40}$/.test(value ?? '');
    if (env.EVENT_NAME === 'pull_request') {
      base = env.BASE_SHA;
      head = env.HEAD_SHA;
      if (![base, head, checkout].every(sha)
          || git(root, 'show', '-s', '--format=%P', checkout).trim() !== `${base} ${head}`) {
        return full('Unverified pull request merge.');
      }
    } else if (env.EVENT_NAME === 'push' && env.REF === 'refs/heads/main') {
      base = env.BEFORE_SHA;
      head = env.AFTER_SHA;
      if (![base, head, checkout].every(sha) || head !== checkout) return full('Unverified push commits.');
      git(root, 'merge-base', '--is-ancestor', base, head);
    } else {
      return full('Manual or unsupported event.');
    }
    if (git(root, 'rev-parse', 'HEAD').trim() !== checkout) return full('Checkout does not match the event.');
    // Disable rename detection so both old and new paths count. Do not filter or
    // paginate the diff. Git failures, unusual paths, and type changes use full CI.
    const changes = git(root, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames',
      '--name-status', '-z', base, head, '--').split('\0');
    if (changes.pop() !== '' || !changes.length || changes.length % 2) return full('Empty or incomplete diff.');
    const paths = changes.filter((_, index) => index % 2);
    const regularChanges = changes.filter((_, index) => !(index % 2)).every(status => /^[AMD]$/.test(status));
    if (paths.every(path => lspFiles.includes(path))) {
      const selection = finish({ mode: 'lsp', browser: false, products: [], reason: 'Exact LSP-only changes.' });
      // Once identified as LSP-only, invalid inputs fail that lane. They must
      // not start unrelated suites as a fallback.
      try {
        if (!regularChanges) throw new Error('LSP file type changed.');
        verifyLspConsumers(root, git(root, 'ls-files', '-z').split('\0').filter(Boolean));
      } catch {
        selection.lspState = 'invalid';
        selection.reason = 'Unsafe or unmapped LSP-only inputs.';
      }
      return selection;
    }
    if (!regularChanges) return full('File type or uncertain status change.');
    if (paths.some(path => /[\x00-\x1f\x7f]/u.test(path)
        || path.split('/').some(part => !part || part === '.' || part === '..'))) return full('Uncertain changed path.');
    const files = git(root, 'ls-files', '-z').split('\0').filter(Boolean);
    const documentation = new Set(paths.filter(isDocumentation));
    const provenance = `${browserPrefix}copy-provenance.json`;
    if (paths.includes(provenance) && documentationProvenance(root, base, head)) documentation.add(provenance);
    if (paths.every(path => documentation.has(path))) {
      verifyMapping(root, files);
      return finish({ mode: 'docs', browser: false, products: [], reason: 'Human documentation only.' });
    }
    if (paths.some(path => lspFiles.includes(path))) return full('Mixed LSP and other changes.');
    const selected = new Set();
    let browser = false;
    for (const path of paths) {
      if (documentation.has(path)) continue;
      if (sharedPrefixes.some(prefix => path.startsWith(prefix) || path === prefix.slice(0, -1))) return full('Shared helper change.');
      if (path.startsWith(browserPrefix)) browser = true;
      else if (Object.hasOwn(dependents, owner(path))) selected.add(owner(path));
      else return full('Shared infrastructure or unknown ownership.');
    }
    verifyMapping(root, files);
    return finish({ mode: 'affected', browser, products: affectedProducts(selected), reason: 'Known projects and mapped dependents.' });
  } catch {
    return full('Unavailable history or uncertain dependency evidence.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const selection = selectScope(process.cwd());
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `mode=${selection.mode}\nbrowser=${selection.browser}\nproducts=${JSON.stringify(selection.products)}\nlsp=${selection.lsp}\nlsp_state=${selection.lspState}\n`);
  }
  console.log(JSON.stringify(selection));
}
