import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import reloadAll, { contact } from '../extensions/reload-all.ts';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function host(options = {}) {
  const state = { sessionId: randomUUID(), idle: true, draft: '', queued: false, tools: [], replies: [], reloads: 0, aborts: 0, wakes: 0, preparations: 0, notifications: [], errors: [], messages: [], branch: [], ...options };
  let controller = new AbortController(), runtime;
  function install() {
    let stale = false, tool;
    const handlers = new Map(), bus = new Map(), commands = new Map();
    const check = () => { assert.equal(stale, false, 'old runtime was reused'); };
    const ctx = {
      mode: 'tui',
      get signal() { check(); return controller.signal; },
      sessionManager: { getSessionId: () => { check(); return state.sessionId; }, getBranch: () => { check(); return state.branch; } },
      ui: {
        getEditorText: () => { check(); return state.draft; },
        notify: text => { check(); state.notifications.push(text); },
        select: async (_title, choices) => { check(); state.choices = choices; return state.selection ?? choices[2]; },
      },
      isIdle: () => { check(); return state.idle; },
      hasPendingMessages: () => { check(); return state.queued; },
      abort: () => {
        check(); controller.abort(); state.aborts++; state.idle = true;
        if (state.question) {
          state.branch.push({ type: 'message', message: { role: 'toolResult', toolName: 'ask_user', details: { status: 'cancelled', reason: 'abort' } } });
          void emit('tool_execution_end', { toolCallId: 'question', toolName: 'ask_user', result: {}, isError: false });
          void emit('turn_end');
          bus.get('herdr:blocked')({ active: false });
          void emit('ui_prompt_end');
          state.question = false;
        }
        void emit('agent_settled');
      },
      waitForIdle: async () => { check(); while (!state.idle) await delay(1); },
      reload: async () => {
        check(); state.reloads++;
        await emit('session_shutdown', { reason: 'reload' });
        stale = true;
        install();
        await runtime.emit('session_start', { reason: 'reload' });
      },
    };
    const pi = {
      on: (name, handler) => { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
      registerCommand: (name, command) => commands.set(name, command),
      registerTool: value => { tool = value; },
      getAllTools: () => { check(); return state.tools.map(name => ({ name })); },
      events: {
        on: (name, handler) => bus.set(name, handler),
        emit: (_name, event) => { check(); for (const reply of state.replies) event.accept(reply); },
      },
      sendUserMessage: (text, options) => {
        check(); assert.equal(options.expandPromptTemplates, true);
        void commands.get('reload+').handler(text.slice('/reload+ '.length), ctx).catch(error => state.errors.push(error));
      },
      sendMessage: (message, options) => {
        check(); state.messages.push(message);
        if (!options.triggerTurn) return;
        if (message.customType === 'reload-pi-preparation') {
          state.preparations++; controller = new AbortController(); state.idle = false;
          void emit('agent_start').then(() => state.onPrepare?.(api, message)).catch(error => state.errors.push(error));
        } else state.wakes++;
      },
    };
    async function emit(name, event = {}) { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); }
    reloadAll(pi);
    assert.deepEqual([...commands.keys()], ['reload+']);
    assert.equal(tool.name, 'reload-pi');
    runtime = { emit, bus, ctx, command: args => commands.get('reload+').handler(args, ctx), tool };
  }
  install();
  const api = {
    state, get controller() { return controller; },
    start: () => runtime.emit('session_start', { reason: 'startup' }),
    emit: (...args) => runtime.emit(...args), command: (args = '') => runtime.command(args),
    blocked: active => runtime.bus.get('herdr:blocked')({ active }),
    close: () => runtime.emit('session_shutdown', { reason: 'quit' }),
    begin: async () => { controller = new AbortController(); state.idle = false; await runtime.emit('agent_start'); },
    call: async params => {
      const id = randomUUID();
      const assistant = { role: 'assistant', content: [{ type: 'toolCall', id, name: 'reload-pi', arguments: params }] };
      state.branch.push({ type: 'message', message: assistant });
      await runtime.emit('message_end', { message: assistant });
      await runtime.emit('tool_execution_start', { toolCallId: id, toolName: 'reload-pi', args: params });
      let result;
      try { result = await runtime.tool.execute(id, params, controller.signal, undefined, runtime.ctx); }
      catch (error) {
        await runtime.emit('tool_execution_end', { toolCallId: id, toolName: 'reload-pi', isError: true });
        await runtime.emit('turn_end');
        throw error;
      }
      await runtime.emit('tool_execution_end', { toolCallId: id, toolName: 'reload-pi', result, isError: false });
      state.branch.push({ type: 'message', message: { role: 'toolResult', toolName: 'reload-pi', toolCallId: id, details: result.details } });
      await runtime.emit('turn_end');
      if (result.terminate) { state.idle = true; await runtime.emit('agent_settled'); }
      return result;
    },
  };
  return api;
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
const hostsErrors = hosts => hosts.flatMap(h => h.state.errors);
const socketFor = async (root, sessionId) => {
  for (const name of readdirSync(root).filter(name => name.endsWith('.sock'))) {
    const path = join(root, name);
    const status = await contact(path, { requestId: randomUUID(), action: 'status' });
    if (status.identity?.sessionId === sessionId) return { path, status };
  }
  throw new Error('No matching socket');
};

test('peers prepare independently across calls, preserve batches, and apply fleet-wide no-resume', async () => {
  await scenario(async (root, create) => {
    const caller = await create(), done = await create(), working = await create({ idle: false });
    await working.emit('agent_start');
    const resource = await create({ tools: ['process'], replies: [{ protocolVersion: 1, runningProcesses: 1, openSessions: 1 }],
      onPrepare: async (h, message) => {
        for (let i = 0; i < 2; i++) {
          await h.emit('tool_execution_start', { toolCallId: `settle-${i}`, toolName: 'process' });
          await delay(20);
          await h.emit('tool_execution_end', { toolCallId: `settle-${i}`, toolName: 'process', result: {}, isError: false });
          await h.emit('turn_end');
          assert.equal(h.state.reloads, 0, 'a preparation tool end is not readiness');
        }
        h.state.replies = [{ protocolVersion: 1, runningProcesses: 0, openSessions: 0 }];
        await assert.rejects(h.call({ action: 'ready', requestId: randomUUID() }), /matching preparation/);
        await h.call({ action: 'ready', requestId: message.details.requestId });
      } });
    const batch = await create({ idle: false });
    await batch.emit('agent_start');
    await batch.emit('message_end', { message: { role: 'assistant', content: [{ type: 'toolCall', id: 'write', name: 'write' }] } });
    await batch.emit('tool_execution_start', { toolCallId: 'write', toolName: 'write' });
    const run = caller.command();
    await delay(150);
    assert.equal(done.state.reloads, 1, 'safe peers do not wait behind a busy peer');
    assert.equal(batch.state.reloads, 0);
    await batch.emit('tool_execution_end', { toolCallId: 'write', toolName: 'write', result: {}, isError: false });
    await delay(120);
    assert.equal(batch.state.reloads, 0, 'one tool end does not prove result persistence');
    await batch.emit('turn_end');
    await run;
    assert.deepEqual([caller.state.reloads, done.state.reloads, working.state.reloads, resource.state.reloads, batch.state.reloads], [1, 1, 1, 1, 1]);
    assert.deepEqual([caller.state.wakes, done.state.wakes, working.state.wakes, resource.state.wakes, batch.state.wakes], [0, 0, 1, 0, 1]);
    assert.equal(resource.state.preparations, 1);
    const receipt = JSON.parse(readFileSync(join(root, 'last-result.json'), 'utf8'));
    assert.ok(receipt.peers.every(peer => peer.result.instanceId !== peer.operation.target.instanceId));
    await working.begin();
    caller.state.selection = 'Reload all local sessions, do not resume';
    await caller.command();
    const disabled = JSON.parse(readFileSync(join(root, 'last-result.json'), 'utf8'));
    assert.equal(disabled.resume, false);
    assert.ok(disabled.peers.every(peer => peer.result.resumed === false));
    assert.equal(working.state.wakes, 1, 'no-resume covers peers and cannot replay the earlier wake');
    await assert.rejects(caller.command('status'), /without arguments/);
    caller.state.selection = 'Status and pending operations';
    await caller.command();
    assert.deepEqual(hostsErrors([caller, done, working, resource, batch]), []);
  });
});

test('protected input/resources fail closed, question cancellation restores only its wait, and expiry is explicit', async () => {
  await scenario(async (root, create) => {
    const caller = await create();
    const protectedHosts = [
      await create({ draft: 'keep this draft' }),
      await create({ queued: true }),
      await create({ tools: ['process'], replies: [{}], onPrepare: (h, message) => h.call({ action: 'ready', requestId: message.details.requestId, outcome: 'needs-attention', reason: 'Keep this resource.' }) }),
      await create({ idle: false }),
    ];
    await protectedHosts[3].emit('agent_start');
    protectedHosts[3].controller.abort();
    const question = await create({ idle: false, question: true, onPrepare: (h, message) => h.call({ action: 'ready', requestId: message.details.requestId }) });
    await question.emit('agent_start');
    question.blocked(true);
    await question.emit('ui_prompt_start');
    await question.emit('message_end', { message: { role: 'assistant', content: [{ type: 'toolCall', id: 'question', name: 'ask_user', arguments: { mode: 'blocking' } }] } });
    await question.emit('tool_execution_start', { toolCallId: 'question', toolName: 'ask_user', args: { mode: 'blocking' } });
    await caller.command();
    assert.ok(protectedHosts.every(h => h.state.reloads === 0 && h.state.wakes === 0 && h.state.aborts === 0));
    assert.equal(protectedHosts[0].state.draft, 'keep this draft');
    assert.equal(protectedHosts[1].state.queued, true);
    assert.equal(question.state.reloads, 1);
    assert.equal(question.state.wakes, 1);
    assert.equal(question.state.messages.at(-1).customType, 'reload-pi-restore-wait');
    assert.match(question.state.messages.at(-1).content, /not by the user.*no answer or approval/i);
    assert.equal(question.state.branch.find(entry => entry.message.role === 'toolResult').message.details.status, 'cancelled');
    const { path, status } = await socketFor(root, caller.state.sessionId);
    const invalid = await contact(path, { requestId: randomUUID(), action: 'prepare', target: { ...status.identity, instanceId: randomUUID() } });
    assert.match(invalid.error, /identity changed/);
    const busy = await create({ idle: false });
    await busy.emit('agent_start');
    await busy.emit('tool_execution_start', { toolCallId: 'keep-write', toolName: 'write' });
    const endpoint = await socketFor(root, busy.state.sessionId), id = randomUUID();
    const accepted = await contact(endpoint.path, { requestId: id, action: 'prepare', target: endpoint.status.identity, expiresAt: Date.now() + 150 });
    assert.equal(accepted.operation.requestId, id);
    await delay(300);
    const expired = await contact(endpoint.path, { requestId: randomUUID(), action: 'status', operationId: id });
    assert.equal(expired.operation.result.status, 'skipped');
    assert.match(expired.operation.result.reason, /expired/);
    assert.deepEqual([busy.state.aborts, busy.state.reloads, busy.state.preparations], [0, 0, 0]);
    assert.deepEqual(hostsErrors([caller, ...protectedHosts, question, busy]), []);
  });
});
