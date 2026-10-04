import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import reloadAll, { contact } from '../extensions/reload-all.ts';

function host(options = {}) {
  const state = { sessionId: randomUUID(), idle: true, draft: '', queued: false, tools: [], replies: [], reloads: 0, aborts: 0, wakes: 0, notifications: [], errors: [], ...options };
  const controller = new AbortController();
  let runtime;
  function install() {
    let stale = false;
    const handlers = new Map(), bus = new Map(), commands = new Map();
    const check = () => { assert.equal(stale, false, 'old runtime was reused'); };
    const ctx = {
      mode: 'tui',
      signal: controller.signal,
      sessionManager: { getSessionId: () => { check(); return state.sessionId; } },
      ui: { getEditorText: () => { check(); return state.draft; }, notify: text => { check(); state.notifications.push(text); } },
      isIdle: () => { check(); return state.idle; },
      hasPendingMessages: () => { check(); return state.queued; },
      abort: () => { check(); controller.abort(); state.aborts++; state.idle = true; },
      waitForIdle: async () => { check(); assert.equal(state.idle, true); },
      reload: async () => {
        check();
        state.reloads++;
        await emit('session_shutdown', { reason: 'reload' });
        stale = true;
        install();
        await runtime.emit('session_start', { reason: 'reload' });
      },
    };
    const pi = {
      on: (name, handler) => { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
      registerCommand: (name, command) => commands.set(name, command),
      registerTool: () => {},
      getAllTools: () => { check(); return state.tools.map(name => ({ name })); },
      events: {
        on: (name, handler) => bus.set(name, handler),
        emit: (_name, event) => { check(); for (const reply of state.replies) event.accept(reply); },
      },
      sendUserMessage: (text, options) => {
        check(); assert.equal(options.expandPromptTemplates, true);
        void commands.get('reload-all').handler(text.slice('/reload-all '.length), ctx).catch(error => state.errors.push(error));
      },
      sendMessage: (_message, options) => { check(); assert.equal(options.triggerTurn, true); state.wakes++; },
    };
    async function emit(name, event = {}) { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); }
    reloadAll(pi);
    runtime = { emit, bus, ctx, command: args => commands.get('reload-all').handler(args, ctx) };
  }
  install();
  return { state, controller, start: () => runtime.emit('session_start', { reason: 'startup' }),
    emit: (...args) => runtime.emit(...args), command: args => runtime.command(args),
    blocked: () => runtime.bus.get('herdr:blocked')({ active: true }), close: () => runtime.emit('session_shutdown', { reason: 'quit' }) };
}

async function scenario(fn) {
  const before = process.env.PI_RELOAD_ALL_DIR;
  const root = mkdtempSync(join(tmpdir(), 'pi-ra-test-'));
  process.env.PI_RELOAD_ALL_DIR = root;
  const hosts = [];
  try { await fn(root, async options => { const h = host(options); hosts.push(h); await h.start(); return h; }); }
  finally {
    for (const h of hosts) await h.close();
    if (before === undefined) delete process.env.PI_RELOAD_ALL_DIR; else process.env.PI_RELOAD_ALL_DIR = before;
    rmSync(root, { recursive: true, force: true });
  }
}

test('fleet reload resumes only a natively interrupted run, once, with fresh runtime receipts', async () => {
  await scenario(async (root, create) => {
    const caller = await create();
    const done = await create();
    const working = await create({ idle: false });
    await working.emit('agent_start');
    await caller.command('');
    assert.deepEqual([caller.state.reloads, done.state.reloads, working.state.reloads], [1, 1, 1]);
    assert.deepEqual([caller.state.aborts, done.state.aborts, working.state.aborts], [0, 0, 1]);
    assert.deepEqual([caller.state.wakes, done.state.wakes, working.state.wakes], [0, 0, 1]);
    const receipt = JSON.parse(readFileSync(join(root, 'last-result.json'), 'utf8'));
    assert.equal(receipt.caller.sessionId, caller.state.sessionId);
    assert.equal(receipt.caller.status, 'reloaded');
    assert.ok(receipt.peers.every(peer => peer.result.instanceId !== peer.identity.instanceId));
    await caller.command(''); // All are idle now. A later reload must not replay a wake.
    assert.deepEqual([caller.state.wakes, done.state.wakes, working.state.wakes], [0, 0, 1]);
    assert.deepEqual(hostsErrors([caller, done, working]), []);
  });
});

const hostsErrors = hosts => hosts.flatMap(h => h.state.errors);

test('drafts, input, prompts, tools, jobs, cancelling runs, and changed target identities fail closed', async () => {
  await scenario(async (root, create) => {
    const caller = await create();
    const protectedHosts = [
      await create({ draft: 'keep this draft' }),
      await create({ queued: true }),
      await create({ tools: ['process'], replies: [{ protocolVersion: 1, runningProcesses: 1, openSessions: 0 }] }),
      await create({ idle: false }),
      await create({ idle: false }),
      await create({ idle: false }),
    ];
    protectedHosts[3].blocked();
    await protectedHosts[4].emit('tool_execution_start', { toolCallId: 'protected-write', toolName: 'write' });
    await protectedHosts[5].emit('agent_start');
    protectedHosts[5].controller.abort();
    await caller.command('');
    assert.ok(protectedHosts.every(h => h.state.reloads === 0 && h.state.wakes === 0 && h.state.aborts === 0));
    assert.equal(protectedHosts[0].state.draft, 'keep this draft');
    assert.equal(protectedHosts[1].state.queued, true);
    const receipt = JSON.parse(readFileSync(join(root, 'last-result.json'), 'utf8'));
    assert.equal(receipt.peers.length, protectedHosts.length);
    assert.ok(receipt.peers.every(peer => peer.error || peer.result.status === 'skipped'));
    const { readdirSync } = await import('node:fs');
    const socket = readdirSync(root).find(name => name.endsWith('.sock'));
    const path = join(root, socket);
    const status = await contact(path, { requestId: randomUUID(), action: 'status' });
    const invalid = await contact(path, { requestId: randomUUID(), action: 'reload', target: { ...status.identity, instanceId: randomUUID() } });
    assert.match(invalid.error, /identity changed/);
    assert.deepEqual(hostsErrors([caller, ...protectedHosts]), []);
  });
});
