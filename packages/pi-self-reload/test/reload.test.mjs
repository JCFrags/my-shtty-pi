import assert from 'node:assert/strict';
import { test } from 'node:test';
import selfReload from '../extensions/index.ts';

function harness() {
  let tool, command, commandRun;
  const handlers = new Map();
  const idle = Promise.withResolvers();
  const operation = new AbortController();
  const state = { draft: '', queued: false, idle: false, reloads: 0, replies: [{ protocolVersion: 1, runningProcesses: 0, openSessions: 0 }], tools: ['process'], mode: 'tui', errors: [], notifications: [] };
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerTool: (value) => { tool = value; },
    registerCommand: (name, value) => { assert.equal(name, 'reload+'); command = value; },
    getAllTools: () => state.tools.map(name => ({ name })),
    events: { on: () => {}, emit: (name, event) => {
      assert.equal(name, 'grounded:session-transition-readiness:v1');
      for (const value of state.replies) event.accept(value);
    } },
    sendUserMessage: (text, options) => {
      assert.deepEqual(options, { expandPromptTemplates: true });
      commandRun = command.handler(text.slice('/reload+ '.length), ctx).catch(error => state.errors.push(error));
    },
  };
  const ctx = {
    get mode() { return state.mode; },
    hasPendingMessages: () => state.queued,
    isIdle: () => state.idle,
    signal: operation.signal,
    sessionManager: {
      getSessionId: () => 'session-a',
      getBranch: () => [{ type: 'message', message: { role: 'assistant', content: state.batch ?? [{ type: 'toolCall', id: 'call-a', name: 'reload-pi', arguments: {} }] } }],
    },
    ui: { getEditorText: () => state.draft, notify: text => state.notifications.push(text) },
    waitForIdle: () => idle.promise,
    reload: async () => {
      assert.equal(state.idle, true);
      state.reloads++;
      handlers.get('session_shutdown')({ reason: 'reload' });
      // Any use of the old API/context after reload must fail the check.
      for (const target of [pi, ctx]) for (const key of Object.keys(target)) {
        Object.defineProperty(target, key, { configurable: true, get() { throw new Error('stale runtime'); } });
      }
    },
  };
  selfReload(pi);
  handlers.get('agent_start')();
  return {
    state, handlers,
    call: async (params = {}, signal) => {
      handlers.get('tool_execution_start')({ toolCallId: 'call-a', toolName: 'reload-pi' });
      try {
        const result = await tool.execute('call-a', params, signal, undefined, ctx);
        handlers.get('tool_execution_end')({ toolCallId: 'call-a', toolName: 'reload-pi', result, isError: false });
        return result;
      } catch (error) {
        handlers.get('tool_execution_end')({ toolCallId: 'call-a', toolName: 'reload-pi', isError: true });
        throw error;
      }
    },
    finish: async () => { state.idle = true; idle.resolve(); await commandRun; },
  };
}

test('tool returns before idle, dispatches a command, and reloads once without stale access', async () => {
  const h = harness();
  const status = await h.call({ action: 'status' });
  assert.equal(status.details.version, '0.4.0');
  assert.equal(status.details.scope, 'self');
  assert.match(status.details.sha256, /^[a-f0-9]{64}$/);
  const result = await h.call();
  assert.equal(result.details.status, 'queued');
  assert.equal(result.terminate, true);
  assert.equal(h.state.reloads, 0);
  await assert.rejects(h.call(), /already pending/);
  await h.finish();
  assert.equal(h.state.reloads, 1);
  assert.deepEqual(h.state.errors, []);
});

test('safety gates refuse or cancel instead of discarding drafts, jobs, or aborted work', async () => {
  for (const patch of [
    { draft: 'unsent text' },
    { queued: true },
    { mode: 'rpc' },
    { replies: [{ protocolVersion: 1, runningProcesses: 1, openSessions: 0 }] },
    { replies: [{ protocolVersion: 1, runningProcesses: 0, openSessions: 1 }] },
    { replies: [{}] },
    { replies: [] },
    { batch: [{ type: 'toolCall', id: 'call-a', name: 'reload-pi' }, { type: 'toolCall', id: 'call-b', name: 'write' }] },
  ]) {
    const h = harness();
    Object.assign(h.state, patch);
    await assert.rejects(h.call());
    assert.equal(h.state.reloads, 0);
  }
  const draft = harness();
  await draft.call();
  draft.state.draft = 'typed while waiting';
  await draft.finish();
  assert.equal(draft.state.reloads, 0);
  assert.match(draft.state.notifications[0], /draft/);
  assert.equal(draft.state.draft, 'typed while waiting');

  const cancelled = harness();
  const abort = new AbortController();
  await cancelled.call({}, abort.signal);
  abort.abort();
  await cancelled.finish();
  assert.equal(cancelled.state.reloads, 0);
  assert.match(cancelled.state.notifications[0], /cancelled/);

  const tree = harness();
  await tree.call();
  tree.handlers.get('session_tree')();
  await tree.finish();
  assert.equal(tree.state.reloads, 0);

  const standalone = harness();
  Object.assign(standalone.state, { replies: [], tools: [] });
  await standalone.call();
  await standalone.finish();
  assert.equal(standalone.state.reloads, 1);
});
