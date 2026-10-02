import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LspClient } from '@grounded/pi-core/lsp-client';
import { registerGroundedLsp } from '../index.ts';
import { createRustLauncher, isRustServer } from '../rust-launch.ts';

assert.equal(process.platform, 'linux', 'the inherited kernel-lock check requires Linux');
assert.ok(process.env.PI_CODING_AGENT_DIR, 'run through the isolated verify-lsp entrypoint');
const suite = mkdtempSync(join(tmpdir(), 'pi-lsp-fixtures-'));
const fake = fileURLToPath(new URL('./fixtures/fake-lsp.mjs', import.meta.url));
const ownerFile = fileURLToPath(new URL('./fixtures/owner.mjs', import.meta.url));
const limits = { shutdown: 100, exit: 80, term: 80, kill: 80 };
const logs = [];
const ownerPids = [];
const orphanPids = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, message, timeout = 2500) {
  const end = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= end) assert.fail(message);
    await delay(10);
  }
}
const rows = log => { try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
function live(pid) {
  try { return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
function files(name, mode = 'normal') {
  const root = join(suite, name);
  mkdirSync(root, { mode: 0o700 });
  writeFileSync(join(root, '.fixture-root'), '');
  const log = join(root, 'peer.log');
  logs.push(log);
  const path = join(root, 'tiny.rs');
  writeFileSync(path, 'bad synthetic text');
  return { root, log, path, directory: join(root, 'lock'), config: {
    id: 'rust-analyzer', command: process.execPath, args: [fake, log, mode],
    extensions: ['.rs'], languageId: 'rust', rootMarkers: ['.fixture-root'], timeoutMs: 500,
  } };
}
function config(servers) {
  const dir = join(process.env.PI_CODING_AGENT_DIR, 'grounded-tools');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'lsp.json'), JSON.stringify({ servers }));
}
function clock() {
  let now = 10_000;
  const timers = new Set();
  return {
    now: () => now,
    setTimer(fn, ms) { const timer = { fn, at: now + ms, unref() {} }; timers.add(timer); return timer; },
    clearTimer(timer) { timers.delete(timer); },
    advance(ms) { now += ms; for (const timer of [...timers]) if (timer.at <= now) { timers.delete(timer); timer.fn(); } },
  };
}
async function host(fixture, extra = {}) {
  config([fixture.config]);
  const hooks = new Map();
  let tool;
  const time = clock();
  registerGroundedLsp({ on(name, fn) { hooks.set(name, fn); }, registerTool(value) { tool = value; }, registerCommand() {} }, {
    ...time, launchRust: createRustLauncher({ directory: fixture.directory }), clientOptions: { stopTimeouts: limits }, ...extra,
  });
  const ctx = { cwd: fixture.root, isProjectTrusted: () => false };
  await hooks.get('session_start')({}, ctx);
  const call = params => tool.execute('fixture', params, undefined, undefined, ctx);
  return {
    time, call,
    hover: (path = fixture.path) => call({ action: 'hover', path, line: 1, character: 0 }),
    auto: (path = fixture.path, toolName = 'write') => hooks.get('tool_result')({ toolName, input: { path }, content: [{ type: 'text', text: 'saved' }], details: { preserved: true } }, ctx),
    status: async () => (await call({ action: 'status' })).details,
    stop: () => hooks.get('session_shutdown')({}, ctx),
  };
}
const starts = fixture => rows(fixture.log).filter(row => row.event === 'start');

// These cases invoke the registered extension hooks/tool, not a replacement manager.
test('registered Rust tool: no automatic start, custom policy, warm-only reuse and expiry', async t => {
  const fixture = files('policy');
  const h = await host(fixture);
  t.after(h.stop);
  for (const toolName of ['edit', 'write', 'grounded_edit', 'grounded_write']) {
    const result = await h.auto(fixture.path, toolName);
    assert.equal(result.details.groundedLsp.reason, 'explicit-start-required');
    assert.equal(result.details.groundedLsp.checked, false);
    assert.equal(result.details.preserved, true);
    assert.ok(!('diagnostics' in result.details.groundedLsp));
  }
  await h.status();
  await h.call({ action: 'diagnostics' });
  await assert.rejects(h.call({ action: 'hover', path: fixture.path }), /line and character/);
  await assert.rejects(h.call({ action: 'rename_preview', path: fixture.path, line: 1, character: 0 }), /newName/);
  assert.equal(starts(fixture).length, 0);
  assert.equal((await h.hover()).details.result.languageId, 'rust');
  const expiry = (await h.status()).rust.expiresAt;
  h.time.advance(30_000);
  assert.equal((await h.auto()).details.groundedLsp.diagnostics.length, 1);
  assert.equal((await h.status()).rust.expiresAt, expiry, 'automatic use does not renew');
  const another = join(fixture.root, 'other');
  mkdirSync(another); writeFileSync(join(another, '.fixture-root'), ''); writeFileSync(join(another, 'tiny.rs'), '');
  assert.equal((await h.hover(join(another, 'tiny.rs'))).details.groundedLsp.reason, 'busy');
  h.time.advance(30_000);
  await until(() => !live(starts(fixture)[0].pid), 'expired child closes');
  const skipped = await h.auto();
  assert.equal(skipped.details.groundedLsp.checked, false);
  assert.equal(starts(fixture).length, 1, 'expired automatic call never restarts');
  assert.equal((await h.status()).rust.slots, 1);
  assert.match((await h.status()).rust.sharedAvailability, /unknown/);
  await h.hover();
  assert.equal(starts(fixture).length, 2, 'later explicit use can restart');
  await h.stop();
  assert.equal((await h.status()).rust.localState, 'stopped');

  for (const patch of [{ id: 'rust-analyzer' }, { extensions: ['.RS'] }, { languageId: 'RuSt' }, { languageIds: { '.mixed': 'Rust' } }, { command: '/synthetic/rust-analyzer' }]) {
    assert.equal(isRustServer({ ...fixture.config, id: 'custom', command: 'alias', extensions: ['.mixed'], languageId: 'plain', ...patch }), true);
  }
  const custom = files('mapped');
  custom.config = { ...custom.config, id: 'custom-mapped', extensions: ['.mixed'], languageId: 'plain', languageIds: { '.mixed': 'rust' } };
  custom.path = join(custom.root, 'tiny.mixed'); writeFileSync(custom.path, 'synthetic');
  const mapped = await host(custom); t.after(mapped.stop);
  assert.equal((await mapped.auto()).details.groundedLsp.reason, 'explicit-start-required');
  assert.equal((await mapped.hover()).details.result.languageId, 'rust');
  await mapped.stop();
});

test('active Rust operation is not stolen or interrupted at expiry; non-Rust mappings stay automatic', async t => {
  const fixture = files('active', 'slow');
  const h = await host(fixture); t.after(h.stop);
  await h.hover();
  h.time.advance(59_999);
  const operation = h.hover();
  await until(() => rows(fixture.log).filter(r => r.method === 'textDocument/hover').length === 2, 'second operation started');
  h.time.advance(2);
  assert.equal((await h.auto()).details.groundedLsp.reason, 'request-active');
  assert.equal((await h.hover()).details.groundedLsp.reason, 'request-active');
  assert.equal((await operation).details.result.method, 'textDocument/hover');
  assert.equal(starts(fixture).length, 1);
  assert.equal((await h.status()).rust.expiresAt, h.time.now() + 60_000);
  await h.stop();

  const js = files('non-rust');
  js.path = join(js.root, 'tiny.jsx'); writeFileSync(js.path, 'synthetic');
  js.config = { ...js.config, id: 'typescript', extensions: ['.jsx', '.js'], languageId: 'typescript', languageIds: { '.jsx': 'javascriptreact', '.js': 'javascript' } };
  const nonRust = await host(js); t.after(nonRust.stop);
  await nonRust.auto();
  assert.equal(starts(js).length, 1);
  assert.equal(rows(js.log).find(row => row.method === 'textDocument/didOpen').params.textDocument.languageId, 'javascriptreact');
  nonRust.time.advance(120_000);
  assert.equal((await nonRust.hover()).details.result.languageId, 'javascriptreact');
  assert.equal(starts(js).length, 1, 'Rust expiry does not retire non-Rust');
  await nonRust.stop();
});

async function owner(fixture, directory = fixture.directory) {
  const child = fork(ownerFile, [fixture.root, directory], { execArgv: ['--experimental-transform-types'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  ownerPids.push(child.pid);
  let seq = 0, ready = false, stopPromise;
  const waiting = new Map();
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('message', message => {
    if (message.ready) { ready = true; return; }
    const pending = waiting.get(message.id); if (!pending) return;
    waiting.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
  });
  child.on('close', () => { for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error(`owner closed: ${stderr}`)); } waiting.clear(); });
  await until(() => ready, `owner readiness: ${stderr}`);
  return { child, call(params) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`owner reply timeout: ${stderr}`)); }, 2500);
      waiting.set(id, { resolve, reject, timer });
      child.send({ id, params }, error => {
        if (!error) return;
        waiting.delete(id); clearTimeout(timer); reject(error);
      });
    });
  }, stop() {
    if (!stopPromise) stopPromise = (async () => {
      if (!child.connected || child.exitCode !== null || child.signalCode !== null) return;
      await this.call({ action: 'fixture-stop' });
      await until(() => !live(child.pid), 'owner closes');
    })();
    return stopPromise;
  } };
}

test('independent processes contend and inherited lock survives parent death', async t => {
  const fixture = files('cross-process');
  config([fixture.config]);
  const a = await owner(fixture); t.after(() => a.stop());
  const b = await owner(fixture); t.after(() => b.stop());
  const params = { action: 'hover', path: fixture.path, line: 1, character: 0 };
  const results = await Promise.all([a.call(params), b.call(params)]);
  assert.equal(results.filter(result => result.details.groundedLsp?.reason === 'busy').length, 1);
  assert.equal(starts(fixture).length, 1, 'exactly one fake server admitted');
  const winner = results[0].isError ? b : a;
  const loser = winner === a ? b : a;
  const inheritedPid = starts(fixture)[0].pid;
  orphanPids.add(inheritedPid);
  winner.child.kill('SIGKILL');
  await until(() => !live(winner.child.pid), 'owned Pi substitute exits');
  assert.equal(live(inheritedPid), true, 'fake server outlives parent');
  assert.equal((await loser.call(params)).details.groundedLsp.reason, 'busy', 'child fd retains flock after parent death');
  process.kill(inheritedPid, 'SIGTERM');
  await until(() => !live(inheritedPid), 'owned orphan closes');
  orphanPids.delete(inheritedPid);
  assert.equal((await loser.call(params)).details.result.languageId, 'rust', 'close releases slot');
  await loser.stop();
});

test('fresh generation resets transport/documents; failed starts and uncertain close cannot appear clean', async t => {
  const fixture = files('restart', 'slow');
  const children = [];
  const launch = createRustLauncher({ directory: fixture.directory });
  const client = new LspClient(fixture.config, fixture.root, { stopTimeouts: limits, launch: async (...args) => {
    const result = await launch(...args); children.push(result.child); return result;
  } });
  t.after(() => client.stop());
  await client.open(fixture.path);
  assert.equal((await client.waitForDiagnostics(fixture.path)).length, 1);
  const old = children[0];
  const stoppedWait = client.waitForDiagnostics(fixture.path);
  const rejection = assert.rejects(stoppedWait, /stopped or changed generation/);
  await client.stop(); await rejection;
  writeFileSync(fixture.path, 'synthetic clean');
  const restarted = client.hover(fixture.path, 0, 0);
  await until(() => children.length === 2, 'new child started');
  old.emit('error', new Error('late old-child error'));
  old.emit('close', 0, null);
  const stale = JSON.stringify({ method: 'textDocument/publishDiagnostics', params: { uri: 'stale', diagnostics: [{ message: 'stale' }] } });
  old.stdout.emit('data', Buffer.from(`Content-Length: ${Buffer.byteLength(stale)}\r\n\r\n${stale}`));
  assert.equal((await restarted).version, 1);
  assert.equal(client.allDiagnostics().some(entry => entry.uri === 'stale'), false);
  const freshOpens = rows(fixture.log).filter(row => row.pid === children[1].pid && row.method?.startsWith('textDocument/did'));
  assert.equal(freshOpens[0].method, 'textDocument/didOpen');
  assert.equal(freshOpens[0].params.textDocument.version, 1);
  assert.deepEqual(client.getDiagnostics(fixture.path), []);
  await client.stop();

  const ignored = files('ignored', 'ignore-initialize'); ignored.config.timeoutMs = 100;
  const h = await host(ignored); t.after(h.stop);
  assert.equal((await h.hover()).details.groundedLsp.reason, 'unavailable');
  await until(() => !live(starts(ignored)[0].pid), 'ignored initialize child is killed');
  assert.equal((await h.auto()).details.groundedLsp.checked, false);
  assert.equal(starts(ignored).length, 1, 'automatic failure does not restart');
  await h.stop();
  const missing = files('missing');
  const unavailable = await host(missing, { launchRust: createRustLauncher({ directory: missing.directory, flockCommand: join(missing.root, 'absent-flock') }) });
  t.after(unavailable.stop);
  assert.equal((await unavailable.hover()).details.groundedLsp.reason, 'launcher-unavailable');
  assert.equal(starts(missing).length, 0, 'no fallback server');
  await unavailable.stop();

  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, kill: () => false });
  let released = 0, launched = 0;
  const uncertain = new LspClient({ ...fixture.config, timeoutMs: 20 }, fixture.root, {
    launch: () => { launched++; return { child, release: () => released++ }; },
    stopTimeouts: { shutdown: 20, exit: 20, term: 20, kill: 20 },
  });
  // The synthetic transport has no OS handles; keep its short request timer alive.
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(uncertain.start(), /timed out/);
    assert.equal(uncertain.state, 'stopping');
    await assert.rejects(uncertain.start(), /stopping/);
    await assert.rejects(uncertain.waitForDiagnostics(fixture.path), /unavailable/);
    assert.equal(launched, 1); assert.equal(released, 0);
    child.emit('close', null, 'SIGKILL');
    assert.equal(uncertain.state, 'stopped'); assert.equal(released, 1);
  } finally { clearInterval(keepAlive); }
});

after(async () => {
  const fakePids = [...new Set(logs.flatMap(log => rows(log).filter(row => row.event === 'start').map(row => row.pid)))];
  const remaining = [...new Set([...fakePids, ...ownerPids, ...orphanPids])].filter(live);
  // Failure cleanup is restricted to exact PIDs created by these fixtures.
  for (const pid of remaining) { try { process.kill(pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
  await until(() => remaining.every(pid => !live(pid)), 'owned fixture cleanup');
  console.log(JSON.stringify({ fakePids, ownerPids, forcedCleanup: remaining, liveOwned: remaining.filter(live) }));
  rmSync(suite, { recursive: true, force: true });
  assert.deepEqual(remaining, [], 'successful checks must not need emergency cleanup');
});
