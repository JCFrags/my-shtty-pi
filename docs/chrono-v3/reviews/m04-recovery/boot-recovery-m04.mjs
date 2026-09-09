#!/usr/bin/env node
// @ts-nocheck -- standalone Node ESM helper, validated with node --check.
// PREPARATION ONLY: production apply is intentionally impossible in this candidate.
import { constants } from 'node:fs';
import { open, lstat, realpath, readdir, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, isAbsolute, relative, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const hash = b => createHash('sha256').update(b).digest('hex');
const fail = code => { throw new Error(code); };
const need = (v, code) => { if (!v) fail(code); };
const uid = process.getuid?.();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PROFILE_HASH = '2c0b48e15d817a6d1333eaa4855cbb8cd41a32d3ba0c6be41479e6e6022507b9';
const ACCEPTED_COMMIT = 'dcd91924dbcfc0c02489e04c3e163b33e2b08e86';

async function ancestors(path) {
  need(isAbsolute(path) && resolve(path) === path, 'noncanonical-path');
  let part = '/';
  for (const c of path.slice(1).split('/').filter(Boolean)) {
    part = join(part, c);
    const s = await lstat(part);
    need(s.isDirectory() && !s.isSymbolicLink() && [0, uid].includes(s.uid), 'unsafe-ancestor');
    need(!(s.mode & 0o022) || (s.uid === 0 && (s.mode & 0o1000)), 'writable-ancestor');
  }
  need(await realpath(path) === path, 'noncanonical-path');
}
async function bytes(path, max, privateMode = false) {
  await ancestors(dirname(path));
  const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await h.stat();
    need(s.isFile() && s.nlink === 1 && s.uid === uid && !(s.mode & 0o022) && s.size <= max && (!privateMode || (s.mode & 0o777) === 0o600), 'unsafe-file');
    const b = await h.readFile();
    need(b.length <= max, 'file-bound');
    return b;
  } finally { await h.close(); }
}
async function privateDir(path) {
  await ancestors(path);
  const s = await lstat(path);
  need(s.uid === uid && (s.mode & 0o777) === 0o700, 'unsafe-namespace');
  return s;
}
async function present(path) {
  try { await lstat(path); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
async function exactNames(path, names) {
  need(JSON.stringify((await readdir(path)).sort()) === JSON.stringify([...names].sort()), 'partial-or-foreign-namespace');
}
async function recursiveJsNames(root, current = '') {
  const directory = join(root, current);
  const ds = await lstat(directory);
  need(ds.isDirectory() && !ds.isSymbolicLink() && ds.uid === uid && !(ds.mode & 0o022), 'unsafe-dist-directory');
  const result = [];
  for (const name of (await readdir(directory)).sort()) {
    const rel = current ? `${current}/${name}` : name;
    const path = join(root, rel);
    const s = await lstat(path);
    need(!s.isSymbolicLink(), 'unsafe-dist-entry');
    if (s.isDirectory()) result.push(...await recursiveJsNames(root, rel));
    else if (s.isFile() && name.endsWith('.js')) result.push(rel);
  }
  return result;
}
async function quiescent(workerBasenames) {
  const deadline = performance.now() + 10000;
  const names = (await readdir('/proc')).filter(x => /^\d+$/.test(x));
  if (names.length > 8192) return false;
  let total = 0;
  for (const pid of names) {
    if (performance.now() > deadline) return false;
    let h;
    try {
      if ((await lstat(`/proc/${pid}`)).uid !== uid) continue;
      h = await open(`/proc/${pid}/cmdline`, constants.O_RDONLY | constants.O_NOFOLLOW);
      const b = Buffer.alloc(131073);
      const { bytesRead } = await h.read(b, 0, b.length, 0);
      total += bytesRead;
      if (bytesRead === b.length || total > 64 * 1024 * 1024) return false;
      for (const arg of b.subarray(0, bytesRead).toString().split('\0')) {
        if (workerBasenames.includes(basename(arg))) return false;
      }
    } catch (e) { if (!['ENOENT', 'ESRCH'].includes(e.code)) return false; }
    finally { await h?.close(); }
  }
  return performance.now() <= deadline;
}
async function doubleQuiescent(names) {
  return await quiescent(names) && await sleep(100).then(() => quiescent(names));
}

async function main() {
  need(process.platform === 'linux' && Number.isInteger(uid) && uid !== 0, 'linux-user-required');
  const a = process.argv.slice(2);
  let pkg, mode, synthetic;
  while (a.length) {
    const k = a.shift();
    if (k === '--package' && !pkg) pkg = a.shift();
    else if ((k === '--check' || k === '--apply') && !mode) mode = k;
    else if (k === '--synthetic-root' && !synthetic) synthetic = a.shift();
    else fail('invalid-arguments');
  }
  need(pkg && mode && isAbsolute(pkg), 'explicit-package-and-mode-required');
  if (mode === '--apply') need(synthetic, 'production-apply-disabled');
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('PI_CHRONO_') || ['TMPDIR', 'TMP', 'TEMP'].includes(key)) fail('environment-override-refused');
  }

  pkg = resolve(pkg);
  await ancestors(pkg);
  const profilePath = join(dirname(fileURLToPath(import.meta.url)), 'recovery-profile.json');
  const profileBytes = await bytes(profilePath, 65536, true);
  need(hash(profileBytes) === PROFILE_HASH, 'profile-record-mismatch');
  const profile = JSON.parse(profileBytes);
  need(profile.schemaVersion === 2 && profile.preparationOnly === true && profile.productionApplyEnabled === false, 'profile-scope-mismatch');
  need(profile.accepted.sourceCommit === ACCEPTED_COMMIT && profile.accepted.packageName === 'pi-chrono-compact' && profile.accepted.packageVersion === '2.0.5', 'accepted-identity-mismatch');
  need(profile.accepted.runtimeManifestEntryCount === 96 && Object.keys(profile.files).length === 96, 'runtime-manifest-count-mismatch');
  for (const [rel, digest] of Object.entries(profile.files)) {
    need(/^package\.json$|^dist\/src\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.js$/.test(rel), 'unsafe-manifest-entry');
    need(hash(await bytes(join(pkg, rel), 2 * 1024 * 1024)) === digest, 'accepted-package-mismatch');
  }
  const expectedDist = Object.keys(profile.files).filter(p => p.startsWith('dist/src/')).map(p => p.slice(9)).sort();
  need(JSON.stringify(await recursiveJsNames(join(pkg, 'dist/src'))) === JSON.stringify(expectedDist), 'accepted-dist-set-mismatch');
  const manifest = JSON.parse((await bytes(join(pkg, 'package.json'), 65536)).toString());
  need(manifest.name === profile.accepted.packageName && manifest.version === profile.accepted.packageVersion, 'accepted-identity-mismatch');

  const load = name => import(pathToFileURL(join(pkg, 'dist/src', `${name}.js`)).href);
  const ns = await load('worker-runtime-namespace');
  const gate = await load('worker-runtime-legacy-gate');
  const systemd = await load('worker-runtime-systemd');
  const { WORKER_LIMITS: limits } = await load('worker-runtime-limits');
  need(JSON.stringify(limits.slots) === JSON.stringify(profile.limits.slots) && JSON.stringify(limits.timeoutSeconds) === JSON.stringify(profile.limits.timeoutSeconds) && JSON.stringify(limits.nice) === JSON.stringify(profile.limits.nice) && limits.hostMemoryBytes === profile.limits.hostMemoryBytes && limits.sourceBytes === profile.limits.sourceBytes, 'accepted-limits-mismatch');

  async function config() {
    const raw = JSON.parse((await bytes(profile.configuration.path, 65536)).toString());
    const c = Object.fromEntries(profile.configuration.projectionKeys.map(k => [k, raw[k]]));
    need(hash(JSON.stringify(c)) === profile.configuration.projectionSha256, 'configured-policy-drift');
    need(Number.isInteger(c.hostWorkerSlots) && c.hostWorkerSlots >= limits.slots.min && c.hostWorkerSlots <= limits.slots.max, 'configured-policy-invalid');
    need(Number.isInteger(c.workerTimeoutSeconds) && c.workerTimeoutSeconds >= limits.timeoutSeconds.min && c.workerTimeoutSeconds <= limits.timeoutSeconds.max, 'configured-policy-invalid');
    need(Number.isInteger(c.workerNiceLevel) && c.workerNiceLevel >= limits.nice.min && c.workerNiceLevel <= limits.nice.max && c.isolatedWorkerEnabled === true, 'configured-policy-invalid');
    return c;
  }
  const c = await config();
  const policy = JSON.stringify({ schemaVersion: profile.policy.schemaVersion, slots: c.hostWorkerSlots, memoryBytes: limits.hostMemoryBytes });

  let runtime = ns.defaultRuntimeDirectory();
  let legacy = ns.legacySchedulerDirectory();
  if (synthetic) {
    need(isAbsolute(synthetic) && resolve(synthetic) === synthetic, 'synthetic-root-refused');
    const base = profile.syntheticRootBase;
    need(relative(base, synthetic).split('/').length === 1 && !relative(base, synthetic).startsWith('..') && /^recovery-test-[A-Za-z0-9_-]+$/.test(basename(synthetic)), 'synthetic-root-refused');
    await privateDir(base);
    await privateDir(synthetic);
    runtime = join(synthetic, 'runtime');
    legacy = join(synthetic, 'legacy');
  }
  await ancestors(dirname(runtime));
  await ancestors(dirname(legacy));
  async function inactive() {
    const states = await Promise.all(Array.from({ length: 4 }, (_, i) => systemd.runtimeUnitState(systemd.runtimeUnitName(runtime, i))));
    need(states.every(s => s === 'inactive'), 'fixed-unit-not-inactive');
  }
  async function identities(ri, li) {
    const rr = await privateDir(runtime), ll = await privateDir(legacy);
    need(rr.dev === ri.dev && rr.ino === ri.ino && ll.dev === li.dev && ll.ino === li.ino, 'namespace-replaced');
  }
  async function policyMatches() {
    need((await bytes(join(runtime, 'policy.json'), 1024, true)).toString() === policy, 'policy-mismatch');
  }
  async function ready() {
    await privateDir(runtime);
    await privateDir(legacy);
    await exactNames(runtime, ['policy.json', 'admission.lock', 'legacy-gate.json']);
    await exactNames(legacy, Array.from({ length: 4 }, (_, i) => `slot-${i}.json`));
    await policyMatches();
    await bytes(join(runtime, 'admission.lock'), 0, true);
    need(await gate.verifyLegacyAdmissionGate(runtime, legacy), 'gate-not-verified');
  }

  await inactive();
  need(await doubleQuiescent(profile.workerProcessBasenames), 'legacy-not-quiescent');
  const r = await present(runtime), l = await present(legacy);
  need(!r && !l, r !== l ? 'partial-or-foreign-namespace' : 'occupied-namespace-refused');
  if (mode === '--check') {
    console.log(JSON.stringify({ ready: false, recoverableFresh: true, changed: false, synthetic: !!synthetic, acceptedCommit: ACCEPTED_COMMIT, manifestEntries: 96, productionApplyEnabled: false }));
    process.exitCode = 2;
    return;
  }

  // Synthetic apply only. Reserve both absent namespaces exclusively. Never remove partial state on failure.
  await mkdir(runtime, { mode: 0o700 });
  const ri = await privateDir(runtime);
  await mkdir(legacy, { mode: 0o700 });
  const li = await privateDir(legacy);
  await config();
  await inactive();
  need(await doubleQuiescent(profile.workerProcessBasenames), 'legacy-not-quiescent');
  await exactNames(runtime, []);
  await exactNames(legacy, []);
  await identities(ri, li);
  const h = await open(join(runtime, 'policy.json'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await h.writeFile(policy); await h.sync(); } finally { await h.close(); }
  await policyMatches();
  await identities(ri, li);
  await gate.installLegacyAdmissionGate({ runtimeDirectory: runtime, legacyDirectory: legacy, confirmLegacyQuiescent: async () => {
    await identities(ri, li);
    await config();
    await policyMatches();
    await inactive();
    await exactNames(runtime, ['policy.json', 'admission.lock']);
    await exactNames(legacy, Array.from({ length: 4 }, (_, i) => `slot-${i}.json`));
    return await doubleQuiescent(profile.workerProcessBasenames);
  } });
  await identities(ri, li);
  await ready();
  await config();
  await inactive();
  need(await doubleQuiescent(profile.workerProcessBasenames), 'legacy-not-quiescent');
  console.log(JSON.stringify({ ready: true, changed: true, mode, synthetic: true, acceptedCommit: ACCEPTED_COMMIT, manifestEntries: 96, exactPolicy: true, fixedUnitsInactive: true, workersQuiescent: true, productionApplyEnabled: false }));
}

try { await main(); }
catch (e) {
  const message = typeof e?.message === 'string' && /^[a-z][a-z0-9-]{0,80}$/.test(e.message) ? e.message : 'boot-recovery-refused';
  console.error(JSON.stringify({ ready: false, refused: true, reason: message, partialStatePreserved: true, productionApplyEnabled: false }));
  process.exitCode = 1;
}
