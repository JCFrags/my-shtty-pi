// Tiny stdio peer. Its finite lifetime bounds cleanup even after a fixture owner dies.
import { appendFileSync } from 'node:fs';
const [log, mode = 'normal'] = process.argv.slice(2);
const modes = new Set(mode.split('+'));
const has = name => modes.has(name);
const record = value => appendFileSync(log, `${JSON.stringify({ pid: process.pid, ...value })}\n`);
record({ event: 'start', cwd: process.cwd() });
process.on('exit', code => record({ event: 'exit', code }));
process.stdout.on('error', () => {});
if (has('ignore-initialize') || has('ignore-stop')) process.on('SIGTERM', () => {});
setTimeout(() => process.exit(0), 20_000);
const documents = new Map();
function send(value) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...value });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
function publish(doc, save = false) {
  if (has('silent')) return;
  const diagnostics = doc.text.includes('bad') ? [
    { severity: 1, message: 'synthetic diagnostic', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
  ] : [];
  const sendDiagnostics = (version, items) => send({ method: 'textDocument/publishDiagnostics', params: {
    uri: doc.uri, ...(has('unversioned') ? {} : { version }), diagnostics: items,
  } });
  if (has('save-late')) {
    if (save) setTimeout(() => sendDiagnostics(doc.version, diagnostics), 220);
    else sendDiagnostics(doc.version, []);
  } else if (has('stale') || (has('stale-on-change') && doc.version > 1)) {
    sendDiagnostics(doc.version - 1, diagnostics);
    if (has('current-later')) setTimeout(() => sendDiagnostics(doc.version, diagnostics), 40);
  } else sendDiagnostics(doc.version, diagnostics);
}
function handle(message) {
  const { method, params, id } = message;
  record({ event: 'message', method, params, id, result: message.result });
  if (method === 'initialize') {
    const respond = () => send({ id, result: { capabilities: {
      textDocumentSync: has('no-save') ? 1 : { openClose: true, change: 1, save: has('save-text') ? { includeText: true } : true },
    } } });
    if (!has('ignore-initialize')) {
      if (has('slow-initialize')) setTimeout(respond, 180);
      else respond();
    }
  } else if (method === 'shutdown') {
    if (!has('ignore-stop')) send({ id, result: null });
  } else if (method === 'exit') {
    if (!has('ignore-stop')) process.exit(0);
  } else if (method === 'textDocument/didOpen' || method === 'textDocument/didChange') {
    const doc = params.textDocument;
    const text = doc.text ?? params.contentChanges[0].text;
    const current = { ...documents.get(doc.uri), ...doc, text };
    documents.set(doc.uri, current);
    publish(current);
  } else if (method === 'textDocument/didSave') {
    const doc = documents.get(params.textDocument.uri);
    if (doc) publish(doc, true);
  } else if (method?.startsWith('textDocument/') && id !== undefined) {
    const doc = documents.get(params.textDocument.uri);
    if (has('crash')) process.exit(3);
    if (has('no-response')) return;
    if (has('collision')) send({ id, method: 'workspace/configuration', params: { items: [] } });
    const respond = () => {
      record({ event: 'reply', id, requestMethod: method });
      send({ id, result: { method, languageId: doc?.languageId, version: doc?.version, text: doc?.text } });
    };
    if (has('slow')) setTimeout(respond, 180);
    else if (has('collision')) setTimeout(respond, 30);
    else respond();
  }
}
let buffer = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    handle(message);
  }
});
