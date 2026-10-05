import assert from 'node:assert/strict';
import test from 'node:test';
import dateReferenceExtension from '../extensions/index.ts';
import { captureReference, ENTRY_TYPE, findReference, projectReference, referenceText, SECTION_NAME } from '../extensions/reference.ts';

function fixture() {
  const entries = [];
  let leaf = null;
  let count = 0;
  let handlers;
  let command;
  const branch = () => {
    const result = [];
    for (let id = leaf; id !== null;) {
      const entry = entries.find(entry => entry.id === id);
      assert.ok(entry);
      result.unshift(entry);
      id = entry.parentId;
    }
    return result;
  };
  const append = data => {
    const entry = { ...data, id: `e${++count}`, parentId: leaf };
    entries.push(entry);
    leaf = entry.id;
    return entry;
  };
  const ctx = { sessionManager: { getBranch: branch, getEntries: () => entries }, ui: { notify() {} } };
  const reload = () => {
    handlers = new Map();
    dateReferenceExtension({
      on: (name, handler) => handlers.set(name, handler),
      appendEntry: (customType, data) => append({ type: 'custom', customType, data }),
      registerCommand: (_name, definition) => { command = definition; },
    });
  };
  reload();
  return { entries, branch, append, reload, setLeaf: id => { leaf = id; },
    event: (name, event = {}) => handlers.get(name)?.(event, ctx),
    command: () => command.handler('', ctx) };
}

test('reference metadata survives ordinary turns, failed compaction, reload, and tree navigation', async () => {
  const f = fixture();
  assert.equal(f.entries.length, 0, 'factory does not initialize a session');
  await f.command();
  assert.equal(f.entries.length, 0, 'status does not capture or refresh');
  const start = { systemPromptOptions: { sections: { other: 'preserve' } } };
  f.event('before_agent_start', start);
  const root = f.entries[0];
  assert.equal(root.customType, ENTRY_TYPE);
  assert.equal(root.data.contextId, null);
  const original = start.systemPromptOptions.sections[SECTION_NAME];
  assert.equal(start.systemPromptOptions.sections.other, 'preserve');
  f.append({ type: 'message', message: { role: 'user', content: 'work' } });
  const oldLeaf = f.branch().at(-1).id;
  f.event('turn_start');
  f.event('session_compact_failed', { aborted: true });
  f.event('model_select');
  f.reload();
  f.event('session_start', { reason: 'reload' });
  f.event('before_agent_start', start);
  assert.equal(start.systemPromptOptions.sections[SECTION_NAME], original);
  assert.equal(f.entries.filter(entry => entry.customType === ENTRY_TYPE).length, 1);

  const compact = f.append({ type: 'compaction', timestamp: '2030-04-03T12:00:00.000Z', summary: 'done' });
  // Boundary-draft compaction has no session_compact notification.
  f.event('turn_start');
  const refreshed = findReference(f.branch(), () => f.entries);
  assert.equal(refreshed.contextId, `compaction:${compact.id}`);
  assert.equal(refreshed.date, captureReference('test', new Date(compact.timestamp)).date);
  f.reload();
  const writes = f.entries.length;
  f.setLeaf(compact.id);
  f.event('turn_start');
  assert.deepEqual(findReference(f.branch(), () => f.entries), refreshed);
  assert.equal(f.entries.length, writes, 'checkpoint navigation restores the exact saved reference');
  f.setLeaf(oldLeaf);
  f.event('before_agent_start', start);
  assert.equal(start.systemPromptOptions.sections[SECTION_NAME], original);
  assert.equal(f.entries.length, writes, 'old-context navigation does not refresh');
  f.setLeaf(null);
  f.event('before_agent_start', start);
  assert.equal(f.entries.length, writes + 1, 'a separate root initializes a separate context');
});

test('first compacted request changes only its owned section, without a session write', () => {
  const f = fixture();
  const start = { systemPromptOptions: { sections: {} } };
  f.event('before_agent_start', start);
  const oldText = `<${SECTION_NAME}>\n${start.systemPromptOptions.sections[SECTION_NAME]}\n</${SECTION_NAME}>`;
  const tool = { name: 'example', description: 'preserve', parameters: {} };
  const system = { role: 'system', content: 'opaque instructions', sections: { preamble: 'stable', [SECTION_NAME]: oldText }, toolsAdded: [tool], timestamp: 1 };
  const user = { role: 'user', content: 'continue', timestamp: 2 };
  const delta = { role: 'system', content: '', sections: { rules: 'stable rule' }, toolsRemoved: [{ name: 'other' }], timestamp: 3 };
  f.append({ type: 'compaction', timestamp: '2030-04-03T12:00:00.000Z', systemMessage: system, summary: 'done' });
  f.event('turn_start');
  const leaf = f.branch().at(-1).id;
  const source = JSON.stringify(f.entries);
  const messages = [system, user, delta];
  const result = f.event('context_with_system', { messages }).messages;
  assert.notEqual(result[0], system);
  assert.equal(result[0].sections.preamble, 'stable');
  assert.equal(result[0].content, system.content);
  assert.equal(result[0].toolsAdded, system.toolsAdded);
  assert.equal(result[0].timestamp, system.timestamp);
  assert.equal(result[1], user);
  assert.equal(result[2], delta);
  assert.equal(JSON.stringify(f.entries), source);
  assert.equal(f.branch().at(-1).id, leaf, 'request projection preserves the admission leaf');
  const current = findReference(f.branch(), () => f.entries);
  assert.ok(result[0].sections[SECTION_NAME].includes(referenceText(current)));
  assert.equal(projectReference(result, current), result, 'unchanged text preserves the exact request objects');
  const same = captureReference('next', new Date('2030-04-03T12:00:00.000Z'));
  assert.equal(referenceText(same), referenceText(current), 'context IDs do not change prompt text');
});
