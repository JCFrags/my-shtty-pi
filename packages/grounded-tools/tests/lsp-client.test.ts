import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LspClient } from "@grounded/pi-core/lsp-client";

const fakeServer = String.raw`
let buffer = Buffer.alloc(0);
let serverRequestHandled = false;
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n');
  process.stdout.write(body);
}
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { hoverProvider: true } } });
    send({ jsonrpc: '2.0', id: 900, method: 'client/registerCapability', params: { registrations: [] } });
  } else if (message.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: message.id, result: null });
  } else if (message.method === 'exit') {
    process.exit(0);
  } else if (message.method === 'textDocument/didOpen' || message.method === 'textDocument/didChange') {
    const uri = message.params.textDocument.uri;
    send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: {
      uri,
      diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, source: 'fake', message: 'exact diagnostic' }]
    }});
  } else if (message.method === 'textDocument/hover') {
    send({ jsonrpc: '2.0', id: message.id, result: { contents: { kind: 'markdown', value: serverRequestHandled ? '**hover**' : 'request not handled' } } });
  } else if (message.id === 900) {
    serverRequestHandled = message.result === null;
  } else if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, result: [] });
  }
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const header = buffer.subarray(0, end).toString('ascii');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) { buffer = buffer.subarray(end + 4); continue; }
    const length = Number(match[1]);
    const start = end + 4;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length));
    buffer = buffer.subarray(start + length);
    handle(message);
  }
});
`;

test("LSP client frames requests and returns exact diagnostics and hover", async () => {
  const root = await mkdtemp(join(tmpdir(), "grounded-lsp-"));
  const serverPath = join(root, "fake-lsp.mjs");
  const filePath = join(root, "sample.ts");
  await writeFile(serverPath, fakeServer);
  await writeFile(filePath, "x\n");
  const client = new LspClient({
    id: "fake",
    command: process.execPath,
    args: [serverPath],
    extensions: [".ts"],
    languageId: "typescript",
    rootMarkers: [],
    timeoutMs: 2000,
  }, root);
  await client.open(filePath);
  const diagnostics = await client.waitForDiagnostics(filePath, 1000);
  assert.equal(diagnostics[0]?.message, "exact diagnostic");
  const hover = await client.hover(filePath, 0, 0) as { contents: { value: string } };
  assert.equal(hover.contents.value, "**hover**");
  await client.stop();
});
