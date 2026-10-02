// Tiny stdio peer. Its finite lifetime bounds cleanup even after a fixture owner dies.
import { appendFileSync } from 'node:fs';
const [log, mode = 'normal'] = process.argv.slice(2);
const record = value => appendFileSync(log, `${JSON.stringify({ pid: process.pid, ...value })}\n`);
record({ event: 'start' });
process.on('exit', code => record({ event: 'exit', code }));
process.stdout.on('error', () => {});
if (mode === 'ignore-initialize' || mode === 'ignore-stop') process.on('SIGTERM', () => {});
setTimeout(() => process.exit(0), 20_000);
const documents = new Map();
function send(value) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...value });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
function handle(message) {
  const { method, params, id } = message;
  record({ event: 'message', method, params });
  if (method === 'initialize') {
    if (mode !== 'ignore-initialize') send({ id, result: { capabilities: {} } });
  } else if (method === 'shutdown') {
    if (mode !== 'ignore-stop') send({ id, result: null });
  } else if (method === 'exit') {
    if (mode !== 'ignore-stop') process.exit(0);
  } else if (method === 'textDocument/didOpen' || method === 'textDocument/didChange') {
    const doc = params.textDocument;
    const text = doc.text ?? params.contentChanges[0].text;
    documents.set(doc.uri, { ...documents.get(doc.uri), ...doc, text });
    send({ method: 'textDocument/publishDiagnostics', params: { uri: doc.uri, diagnostics: text.includes('bad') ? [
      { severity: 1, message: 'synthetic diagnostic', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
    ] : [] } });
  } else if (method?.startsWith('textDocument/') && id !== undefined) {
    const doc = documents.get(params.textDocument.uri);
    if (mode === 'crash') process.exit(3);
    const respond = () => send({ id, result: { method, languageId: doc?.languageId, version: doc?.version, text: doc?.text } });
    if (mode === 'slow') setTimeout(respond, 180);
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
