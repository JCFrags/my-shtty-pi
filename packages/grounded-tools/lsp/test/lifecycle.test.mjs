import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fork, spawn } from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LspClient, LspRequestTimeout } from '@grounded/pi-core/lsp-client';
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
const pendingLaunchPids = [];
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
function config(servers, policy = {}) {
  const dir = join(process.env.PI_CODING_AGENT_DIR, 'grounded-tools');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'lsp.json'), JSON.stringify({ servers, ...policy }));
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
async function host(fixture, extra = {}, policy = { automaticDiagnostics: true, diagnosticTimeoutMs: 120 }) {
  config([fixture.config], policy);
  const { context, ...runtime } = extra;
  const hooks = new Map();
  let tool;
  const time = clock();
  registerGroundedLsp({ on(name, fn) { hooks.set(name, fn); }, registerTool(value) { tool = value; }, registerCommand() {} }, {
    ...time, launchRust: createRustLauncher({ directory: fixture.directory }), clientOptions: { stopTimeouts: limits }, ...runtime,
  });
  const ctx = { cwd: fixture.root, isProjectTrusted: () => false, ...context };
  await hooks.get('session_start')({}, ctx);
  const call = (params, signal) => tool.execute('fixture', params, signal, undefined, ctx);
  const result = (event, signal) => hooks.get('tool_result')(event, { ...ctx, signal });
  return {
    time, call, result,
    hover: (path = fixture.path, signal) => call({ action: 'hover', path, line: 1, character: 0 }, signal),
    auto: (path = fixture.path, toolName = 'write', options = {}) => result({ toolName, input: { path, ...options.input }, content: [{ type: 'text', text: 'saved' }], details: { preserved: true, ...options.details } }, options.signal),
    status: async () => (await call({ action: 'status' })).details,
    stop: () => hooks.get('session_shutdown')({}, ctx),
  };
}
const starts = fixture => rows(fixture.log).filter(row => row.event === 'start');
function nonRust(fixture) {
  fixture.path = join(fixture.root, 'tiny.jsx'); writeFileSync(fixture.path, 'bad synthetic text');
  fixture.config = { ...fixture.config, id: 'typescript', extensions: ['.jsx', '.js'], languageId: 'typescript', languageIds: { '.jsx': 'javascriptreact', '.js': 'javascript' } };
  return fixture;
}

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

test('active Rust operation is not stolen at expiry; opted-in non-Rust mappings retire only when idle', async t => {
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

  const js = nonRust(files('non-rust', 'slow'));
  const local = await host(js); t.after(local.stop);
  await local.auto();
  assert.equal(starts(js).length, 1);
  assert.equal(rows(js.log).find(row => row.method === 'textDocument/didOpen').params.textDocument.languageId, 'javascriptreact');
  local.time.advance(59_999);
  const active = local.hover();
  await until(() => rows(js.log).some(row => row.method === 'textDocument/hover'), 'non-Rust operation starts');
  local.time.advance(120_000);
  assert.equal((await local.status()).running[0].active, 1);
  assert.equal(live(starts(js)[0].pid), true, 'idle expiry cannot evict an active request');
  assert.equal((await active).details.result.languageId, 'javascriptreact');
  assert.equal(starts(js).length, 1, 'reuse before idle expiry');
  assert.equal((await local.status()).running[0].expiresAt, local.time.now() + 60_000);
  local.time.advance(60_000);
  await until(() => !live(starts(js)[0].pid), 'non-Rust idle child closes');
  assert.equal((await local.status()).running.length, 0);
  assert.equal((await local.hover()).details.result.languageId, 'javascriptreact');
  assert.equal(starts(js).length, 2, 'a later explicit request can start after confirmed close');
  await local.stop();
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
  const ticket = await client.open(fixture.path);
  assert.equal((await client.waitForDiagnostics(ticket, 120)).diagnostics.length, 1);
  const old = children[0];
  const stoppedWait = client.waitForDiagnostics({ ...ticket, baseline: Number.MAX_SAFE_INTEGER }, 120);
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
  assert.equal((await h.hover()).details.groundedLsp.reason, 'timeout');
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
    await assert.rejects(uncertain.waitForDiagnostics({ generation: 0, uri: 'unused', documentVersion: 1, baseline: 0, changed: true, saveNotification: 'not-requested' }, 20), /unavailable/);
    assert.equal(launched, 1); assert.equal(released, 0);
    child.emit('close', null, 'SIGKILL');
    assert.equal(uncertain.state, 'stopped'); assert.equal(released, 1);
  } finally { clearInterval(keepAlive); }
});


test('automatic diagnostics default off even for warm clients; policy bounds and trusted overrides', async t => {
  const fixture = nonRust(files('automatic-off'));
  const h = await host(fixture, {}, {}); t.after(h.stop);
  assert.deepEqual((await h.status()).policy, { automaticDiagnostics: false, idleTimeoutMs: 60000, diagnosticTimeoutMs: 3000 });
  const event = { toolName: 'write', content: [{ type: 'text', text: 'saved' }], details: { preserved: true }, get input() { throw new Error('disabled hook must not inspect paths'); } };
  assert.equal(await h.result(event), undefined);
  assert.equal(starts(fixture).length, 0);
  assert.equal((await h.hover()).details.result.languageId, 'javascriptreact');
  const count = rows(fixture.log).length;
  assert.equal(await h.result(event), undefined);
  assert.equal(await h.auto(join(fixture.root, 'absent.jsx')), undefined);
  assert.equal(rows(fixture.log).length, count, 'warm off does not send changes, saves, or diagnostics');
  await h.stop();

  const bounds = nonRust(files('policy-bounds'));
  mkdirSync(join(bounds.root, '.pi'));
  writeFileSync(join(bounds.root, '.pi', 'grounded-lsp.json'), JSON.stringify({ automaticDiagnostics: false, idleTimeoutMs: 0, diagnosticTimeoutMs: 999999, disabledServers: ['typescript'] }));
  const trusted = await host(bounds, { context: { isProjectTrusted: () => true } }, { automaticDiagnostics: true, idleTimeoutMs: 999999, diagnosticTimeoutMs: 0 }); t.after(trusted.stop);
  assert.deepEqual((await trusted.status()).policy, { automaticDiagnostics: false, idleTimeoutMs: 1000, diagnosticTimeoutMs: 30000 });
  await assert.rejects(trusted.hover(), /No available language server/);
  assert.equal(starts(bounds).length, 0);
  await trusted.stop();
});

test('actual-save capabilities, unchanged versions, and bounded save sampling', async t => {
  const fixture = nonRust(files('save-text', 'save-text+save-late'));
  const h = await host(fixture, {}, { automaticDiagnostics: true, diagnosticTimeoutMs: 400 }); t.after(h.stop);
  const saved = await h.auto();
  assert.equal(saved.details.groundedLsp.saveNotification, 'sent');
  assert.equal(saved.details.groundedLsp.outcome, 'published');
  assert.equal(saved.details.groundedLsp.waitEnded, 'deadline');
  assert.ok(saved.details.groundedLsp.waitedMs >= 380, 'save wait does not stop on the early empty parser publication');
  assert.equal(saved.details.groundedLsp.diagnostics.length, 1);
  const save = rows(fixture.log).find(row => row.method === 'textDocument/didSave');
  assert.equal(save.params.text, 'bad synthetic text');
  const initialize = rows(fixture.log).find(row => row.method === 'initialize');
  assert.equal(initialize.params.capabilities.textDocument.synchronization.didSave, true);
  assert.equal(initialize.params.capabilities.textDocument.publishDiagnostics.versionSupport, true);
  assert.equal((await h.hover()).details.result.version, 1);
  const cached = await h.call({ action: 'diagnostics', path: fixture.path });
  assert.equal(cached.details.outcome, 'cached');
  assert.equal(cached.details.checked, false);
  assert.match(cached.content[0].text, /Cached LSP diagnostics/);
  assert.equal(rows(fixture.log).filter(row => row.method === 'textDocument/didSave').length, 1, 'read-only tools never save');
  assert.equal(rows(fixture.log).filter(row => row.method === 'textDocument/didChange').length, 0, 'unchanged navigation never bumps the version');
  writeFileSync(fixture.path, 'synthetic clean');
  const clean = await h.auto();
  assert.equal(clean.details.groundedLsp.documentVersion, 2);
  assert.equal(clean.details.groundedLsp.checked, true);
  assert.match(clean.content.at(-1).text, /latest version-matched LSP publication.*Analysis completion is unknown/);
  assert.equal(rows(fixture.log).filter(row => row.method === 'textDocument/didChange').length, 1);
  await h.stop();

  const unsupported = nonRust(files('no-save', 'no-save'));
  const noSave = await host(unsupported); t.after(noSave.stop);
  assert.equal((await noSave.auto()).details.groundedLsp.saveNotification, 'not-supported');
  assert.equal(rows(unsupported.log).some(row => row.method === 'textDocument/didSave'), false, 'numeric synchronization kind does not request saves');
  await noSave.stop();
});

test('diagnostic timeout, stale and unversioned caches, current publications, and superseded tickets', async t => {
  const silent = nonRust(files('silent', 'silent'));
  const h = await host(silent, {}, { automaticDiagnostics: true, diagnosticTimeoutMs: 100 }); t.after(h.stop);
  const timeout = await h.call({ action: 'diagnostics', path: silent.path });
  assert.equal(timeout.details.outcome, 'timeout');
  assert.equal(timeout.details.checked, false);
  assert.equal(timeout.details.timeoutMs, 100);
  assert.ok(timeout.details.waitedMs >= 100 && timeout.details.waitedMs < 1000, 'diagnostic setting is used instead of the old 3000 ms wait');
  assert.match(timeout.content[0].text, /timed out.*current-version check is not confirmed/);
  const snapshot = await h.call({ action: 'diagnostics' });
  assert.equal(snapshot.details.diagnostics[0].outcome, 'pending');
  assert.equal(snapshot.details.diagnostics[0].analysisComplete, 'unknown');
  assert.equal((await h.auto()).details.groundedLsp.timeoutMs, 100);
  await h.stop();

  const stale = nonRust(files('stale-cache', 'stale-on-change'));
  writeFileSync(stale.path, 'synthetic clean');
  const old = await host(stale); t.after(old.stop);
  await old.hover();
  writeFileSync(stale.path, 'bad changed text');
  const outdated = await old.call({ action: 'diagnostics', path: stale.path });
  assert.equal(outdated.details.outcome, 'timeout');
  assert.equal(outdated.details.freshness, 'stale');
  assert.equal(outdated.details.checked, false);
  assert.deepEqual(outdated.details.diagnostics, [], 'stale incoming version cannot replace the old cache');
  assert.match(outdated.content[0].text, /not a confirmed clean check/);
  await old.stop();

  const unversioned = nonRust(files('unversioned', 'unversioned'));
  const uncertain = await host(unversioned); t.after(uncertain.stop);
  const observed = await uncertain.call({ action: 'diagnostics', path: unversioned.path });
  assert.equal(observed.details.outcome, 'published');
  assert.equal(observed.details.freshness, 'unversioned');
  assert.equal(observed.details.checked, false);
  assert.match(observed.content[0].text, /analyzed document version and analysis completion are unknown/);
  await uncertain.stop();

  const current = nonRust(files('current-after-stale', 'stale+current-later'));
  const client = new LspClient(current.config, current.root, { stopTimeouts: limits }); t.after(() => client.stop());
  const first = await client.open(current.path);
  const fresh = await client.waitForDiagnostics(first, 120);
  assert.equal(fresh.outcome, 'published');
  assert.equal(fresh.freshness, 'version-matched');
  assert.equal(fresh.checked, true);
  const waiting = client.waitForDiagnostics({ ...first, baseline: Number.MAX_SAFE_INTEGER }, 120);
  await client.open(current.path, 'another content snapshot');
  const superseded = await waiting;
  assert.equal(superseded.outcome, 'pending');
  assert.equal(superseded.waitEnded, 'superseded');
  assert.equal(superseded.checked, false);
  await client.stop();
});

test('hook paths use confirmed local session cwd and skip SSH or missing metadata before I/O', async t => {
  const context = nonRust(files('session-context'));
  const saved = nonRust(files('session-saved'));
  writeFileSync(context.path, 'wrong context text');
  writeFileSync(saved.path, 'bad correct session text');
  saved.config.rootMarkers = ['.no-fixture-marker'];
  const h = await host(saved, { context: { cwd: context.root } }); t.after(h.stop);
  for (const options of [
    { input: { sessionId: 'ssh-session' }, details: { sessionId: 'ssh-session', sessionBackend: 'ssh', sessionCwd: '/remote' } },
    { input: { sessionId: 'local-session' } },
    { input: { sessionId: 'local-session' }, details: { sessionId: 'another', sessionBackend: 'local', sessionCwd: saved.root } },
  ]) {
    const skipped = await h.auto('tiny.jsx', 'write', options);
    assert.equal(skipped.details.groundedLsp.checked, false);
    assert.ok(['remote-session-unsupported', 'session-metadata-missing'].includes(skipped.details.groundedLsp.reason));
  }
  assert.equal(starts(saved).length, 0, 'skips do not start or inspect a local server');
  const result = await h.auto('tiny.jsx', 'edit', { input: { sessionId: 'local-session' }, details: { sessionId: 'local-session', sessionBackend: 'local', sessionCwd: saved.root } });
  assert.equal(result.details.groundedLsp.effectivePath, saved.path);
  assert.equal(result.details.groundedLsp.effectiveCwd, saved.root);
  assert.equal(result.details.preserved, true);
  assert.equal(starts(saved)[0].cwd, saved.root, 'root fallback uses the effective session cwd');
  assert.equal(rows(saved.log).find(row => row.method === 'textDocument/didOpen').params.textDocument.text, 'bad correct session text');
  const count = rows(saved.log).length;
  await h.auto(context.path, 'write', { input: { sessionId: 'ssh-session' }, details: { sessionId: 'ssh-session', sessionBackend: 'ssh' } });
  assert.equal(rows(saved.log).length, count, 'warm SSH skip does not analyze the local same-name path');
  await h.stop();
});

test('server request collision cannot consume a response; cancellation and timeout clean request ownership', async t => {
  const fixture = nonRust(files('collision-cancel', 'collision+slow'));
  const client = new LspClient(fixture.config, fixture.root, { stopTimeouts: limits }); t.after(() => client.stop());
  assert.equal((await client.hover(fixture.path, 0, 0)).method, 'textDocument/hover');
  const request = rows(fixture.log).find(row => row.method === 'textDocument/hover');
  assert.ok(rows(fixture.log).some(row => row.id === request.id && Array.isArray(row.result)), 'same-ID server request receives its own reply');
  const control = new AbortController();
  const aborted = client.hover(fixture.path, 0, 0, control.signal);
  const rejection = assert.rejects(aborted, { name: 'AbortError' });
  await until(() => rows(fixture.log).filter(row => row.method === 'textDocument/hover').length === 2, 'abort request starts');
  const abortId = rows(fixture.log).filter(row => row.method === 'textDocument/hover').at(-1).id;
  control.abort(); await rejection;
  await until(() => rows(fixture.log).some(row => row.method === '$/cancelRequest' && row.params.id === abortId), 'abort is sent to the same request ID');
  assert.equal(getEventListeners(control.signal, 'abort').length, 0);
  assert.equal(client.pending.size, 0);
  const timedOut = client.request('textDocument/hover', { textDocument: { uri: pathToFileURL(fixture.path).href }, position: { line: 0, character: 0 } }, 40);
  await assert.rejects(timedOut, LspRequestTimeout);
  const timeoutId = rows(fixture.log).filter(row => row.method === 'textDocument/hover').at(-1).id;
  await until(() => rows(fixture.log).some(row => row.method === '$/cancelRequest' && row.params.id === timeoutId), 'timeout cancels server work best effort');
  assert.equal(client.pending.size, 0);
  assert.equal((await client.definition(fixture.path, 0, 0)).method, 'textDocument/definition', 'late canceled responses cannot settle another request');
  await client.stop();
});

test('Rust diagnostic timeout, stale cache, and caller cancellation cannot renew the explicit window', async t => {
  const fixture = files('rust-no-renew', 'stale-on-change+slow');
  const h = await host(fixture); t.after(h.stop);
  await h.hover();
  const expiry = (await h.status()).rust.expiresAt;
  h.time.advance(1000);
  writeFileSync(fixture.path, 'bad changed text');
  const timeout = await h.call({ action: 'diagnostics', path: fixture.path });
  assert.equal(timeout.details.outcome, 'timeout');
  assert.equal(timeout.details.freshness, 'stale');
  assert.equal((await h.status()).rust.expiresAt, expiry);
  const control = new AbortController();
  const aborted = h.hover(fixture.path, control.signal);
  const rejection = assert.rejects(aborted, { name: 'AbortError' });
  await until(() => rows(fixture.log).filter(row => row.method === 'textDocument/hover').length === 2, 'warm Rust abort starts');
  control.abort(); await rejection;
  assert.equal((await h.status()).rust.expiresAt, expiry);
  assert.equal((await h.status()).rust.lastOutcome.reason, 'cancelled');
  const hookControl = new AbortController();
  const hook = h.auto(fixture.path, 'write', { signal: hookControl.signal });
  await until(() => rows(fixture.log).some(row => row.method === 'textDocument/didSave'), 'hook diagnostic wait starts');
  hookControl.abort();
  const cancelled = await hook;
  assert.equal(cancelled.details.groundedLsp.outcome, 'cancelled');
  assert.equal(cancelled.details.preserved, true);
  assert.equal(cancelled.content[0].text, 'saved');
  assert.equal((await h.status()).rust.expiresAt, expiry);
  assert.equal(getEventListeners(hookControl.signal, 'abort').length, 0);
  await h.stop();

  const silent = files('rust-request-timeout', 'no-response'); silent.config.timeoutMs = 80;
  const requests = await host(silent); t.after(requests.stop);
  const diagnostics = await requests.call({ action: 'diagnostics', path: silent.path });
  assert.equal(diagnostics.details.outcome, 'published');
  const original = (await requests.status()).rust.expiresAt;
  requests.time.advance(1000);
  assert.equal((await requests.hover()).details.groundedLsp.reason, 'timeout');
  assert.equal((await requests.status()).rust.expiresAt, original, 'protocol timeout also does not renew');
  await requests.stop();
});

test('one cancelled initialization owner does not stop another; abandoned pending launch stays owned until close', async t => {
  const shared = nonRust(files('shared-start', 'slow-initialize'));
  const h = await host(shared); t.after(h.stop);
  const control = new AbortController();
  const first = h.hover(shared.path, control.signal);
  const rejection = assert.rejects(first, { name: 'AbortError' });
  const second = h.hover();
  await until(() => rows(shared.log).some(row => row.method === 'initialize'), 'shared initialize starts');
  control.abort(); await rejection;
  assert.equal((await second).details.result.languageId, 'javascriptreact');
  assert.equal(starts(shared).length, 1);
  assert.equal(rows(shared.log).filter(row => row.method === 'initialize').length, 1);
  assert.equal(rows(shared.log).some(row => row.method === '$/cancelRequest'), false, 'another initialization owner retains the shared request');
  assert.equal(getEventListeners(control.signal, 'abort').length, 0);
  await h.stop();

  const fixture = nonRust(files('pending-launch'));
  let resume, child, released = 0, launches = 0;
  const gate = new Promise(resolve => { resume = resolve; });
  const client = new LspClient(fixture.config, fixture.root, { stopTimeouts: limits, launch: async (config, root) => {
    launches++;
    await gate;
    child = spawn(config.command, config.args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    pendingLaunchPids.push(child.pid);
    return { child, release: () => { released++; } };
  } }); t.after(() => client.stop());
  const pre = new AbortController(); pre.abort();
  await assert.rejects(client.start(pre.signal), { name: 'AbortError' });
  assert.equal(launches, 0);
  const cancellation = new AbortController();
  const starting = client.start(cancellation.signal);
  const cancelled = assert.rejects(starting, { name: 'AbortError' });
  cancellation.abort();
  await until(() => client.state === 'stopping', 'abandoned launch is retained in stopping state');
  assert.equal(released, 0);
  await assert.rejects(client.start(), /stopping/);
  resume(); await cancelled;
  assert.equal(client.state, 'stopped');
  assert.equal(released, 1, 'only exact-child close releases launch ownership');
  assert.equal(live(child.pid), false);
  assert.equal(rows(fixture.log).some(row => row.method === 'initialize'), false, 'abandoned launch is closed before initialization');
  assert.equal(getEventListeners(cancellation.signal, 'abort').length, 0);
});

after(async () => {
  const fakePids = [...new Set(logs.flatMap(log => rows(log).filter(row => row.event === 'start').map(row => row.pid)))];
  const remaining = [...new Set([...fakePids, ...ownerPids, ...pendingLaunchPids, ...orphanPids])].filter(live);
  // Failure cleanup is restricted to exact PIDs created by these fixtures.
  for (const pid of remaining) { try { process.kill(pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
  await until(() => remaining.every(pid => !live(pid)), 'owned fixture cleanup');
  console.log(JSON.stringify({ fakePids, ownerPids, pendingLaunchPids, forcedCleanup: remaining, liveOwned: remaining.filter(live) }));
  rmSync(suite, { recursive: true, force: true });
  assert.deepEqual(remaining, [], 'successful checks must not need emergency cleanup');
});
