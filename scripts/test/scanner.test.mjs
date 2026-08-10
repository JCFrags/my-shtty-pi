import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { scanPublicTree, renderFindings } from '../check-public-tree.mjs';

const fixtures = new Set();
afterEach(() => { for (const directory of fixtures) fs.rmSync(directory, { recursive: true, force: true }); fixtures.clear(); });
const temporary = () => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'public-tree-')); fixtures.add(directory); return directory; };
const write = (root, name, data) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
const categories = (root) => new Set(scanPublicTree(root).map(item => item.category));

test('scanner accepts normal clone and ignores .git', () => { const root = temporary(); fs.mkdirSync(path.join(root, '.git')); write(root, 'readme.txt', 'safe'); write(root, '.git/private.txt', ['token', ': "this must not be read"'].join('')); assert.deepEqual(scanPublicTree(root), []); });
test('scanner accepts exported archive without .git at a path with spaces', () => { const root = temporary(); write(root, 'path with spaces/readme.txt', 'safe'); assert.deepEqual(scanPublicTree(root), []); });
test('scanner rejects generated directories without descending', () => { const root = temporary(); const hidden = ['token', ': "abcdefghijklmnopqrstuv"'].join(''); write(root, 'dist/unsafe.txt', hidden); write(root, 'node_modules/unsafe.txt', hidden); const found = categories(root); assert(found.has('generated-directory')); assert(!found.has('credential')); });
test('scanner rejects private metadata paths without descending or opening them', () => {
  const root = temporary();
  const names = ['.pi', '.agents', 'session', 'sessions', 'browser', 'evidence', 'rollback', 'failed-candidates'];
  const sentinel = ['token', ': "abcdefghijklmnopqrstuv"'].join('');
  for (const name of names) write(root, `metadata/${name}/sentinel.txt`, sentinel);
  write(root, 'metadata/.pi-file', 'safe');
  const opened = [];
  const found = scanPublicTree(root, undefined, { beforeOpen: (absolute, relative) => { opened.push({ absolute, relative }); } });
  for (const name of names) {
    const directory = `metadata/${name}`;
    assert(found.some(item => item.category === 'private-metadata' && item.path === directory && item.line === 1));
    assert(!found.some(item => item.path === `metadata/${name}/sentinel.txt`));
    assert(!found.some(item => item.category === 'credential' && item.path === `metadata/${name}/sentinel.txt`));
    assert(!opened.some(item => item.relative === `metadata/${name}/sentinel.txt`));
  }
  const fileRoot = temporary();
  write(fileRoot, 'metadata/.pi', 'safe');
  const fileOpened = [];
  const fileFindings = scanPublicTree(fileRoot, undefined, { beforeOpen: (absolute, relative) => { fileOpened.push(relative); } });
  assert(fileFindings.some(item => item.category === 'private-metadata' && item.path === 'metadata/.pi' && item.line === 1));
  assert(!fileOpened.includes('metadata/.pi'));
});
test('scanner rejects a .git symlink before metadata skip', () => { const root = temporary(); write(root, 'target.txt', 'safe'); fs.symlinkSync('target.txt', path.join(root, '.git')); assert(categories(root).has('symlink')); });
test('scanner rejects symlink and special file', () => { const root = temporary(); write(root, 'safe.txt', 'ok'); fs.symlinkSync('safe.txt', path.join(root, 'link')); const found = categories(root); assert(found.has('symlink')); if (process.platform !== 'win32' && typeof fs.mkfifoSync === 'function') { fs.mkfifoSync(path.join(root, 'fifo'), 0o600); assert(categories(root).has('unsafe-file-type')); } });
test('scanner rejects private path, endpoint, credential, key, and entropy without disclosure', () => { const root = temporary(); const entropyValue = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+'.repeat(2); const home = ['prefix:', '/', 'home', '/', 'private'].join(''); const rootPath = ['punctuation;', '/', 'root', '/', 'private'].join(''); const key = ['-----BEGIN ', 'PRIVATE KEY-----'].join(''); const credentialLabel = ['secret', ': "'].join(''); write(root, 'unsafe.txt', `${home}\n${rootPath}\nhttps://${[192,168,1,2].join('.')}\/api\n${credentialLabel}${entropyValue}"\n${key}`); const found = scanPublicTree(root); assert.deepEqual(new Set(found.map(item => item.category)), new Set(['credential','high-entropy','private-endpoint','private-key','private-path'])); assert(!renderFindings(found).includes(entropyValue)); });
test('scanner rejects credentials in package-lock while allowing integrity', () => { const root = temporary(); const label = ['sec', 'ret'].join(''); const longValue = 'not-a-real-secret-value-'.repeat(2); write(root, 'package-lock.json', JSON.stringify({ integrity: 'sha512-' + 'A'.repeat(70), [label]: longValue })); const found = scanPublicTree(root); assert(found.some(item => item.category === 'credential') || found.some(item => item.category === 'high-entropy')); });
test('scanner detects base64 entropy containing slash', () => { const root = temporary(); const value = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/'.repeat(2); write(root, 'secret.txt', `value: "${value}"`); assert(categories(root).has('high-entropy')); });
test('scanner accepts fixed offline loopback and integrity or SHA values', () => { const root = temporary(); write(root, 'lock.txt', 'url=https://127.0.0.1:9/\nintegrity=sha512-' + 'A'.repeat(70) + '\nsha=' + 'a'.repeat(64)); assert.deepEqual(scanPublicTree(root), []); });
test('scanner rejects binary, NUL, and invalid UTF-8', () => { const root = temporary(); write(root, 'nul.txt', Buffer.from([65, 0, 66])); write(root, 'bad.txt', Buffer.from([0xc3, 0x28])); write(root, 'archive.zip', Buffer.from([80, 75, 3, 4])); const found = categories(root); assert(found.has('binary')); });
test('scanner enforces UTF-8 path bound', () => { const root = temporary(); write(root, '界.txt', 'safe'); assert(scanPublicTree(root, { fileBytes: 1000, totalBytes: 1000, entries: 100, pathBytes: 5 }).some(item => item.category === 'path-bound')); });
test('scanner enforces file total entry and path bounds', () => { const root = temporary(); write(root, 'big.txt', 'x'.repeat(100)); assert(categories(root).has('file-bound') === false); assert(scanPublicTree(root, { fileBytes: 10, totalBytes: 1000, entries: 100, pathBytes: 4096 }).some(item => item.category === 'file-bound')); assert(scanPublicTree(root, { fileBytes: 1000, totalBytes: 1, entries: 100, pathBytes: 4096 }).some(item => item.category === 'total-bound')); assert(scanPublicTree(root, { fileBytes: 1000, totalBytes: 1000, entries: 1, pathBytes: 4096 }).some(item => item.category === 'entry-bound')); });
test('scanner rejects Unix socket special node when supported', async (t) => { if (process.platform === 'win32') return; const root = temporary(); const socketPath = path.join(root, 'socket'); const server = net.createServer(); await new Promise(resolve => server.listen(socketPath, resolve)); t.after(() => server.close()); assert(categories(root).has('unsafe-file-type')); });
test('scanner rejects path replacement by symlink and inode growth', () => { const root = temporary(); write(root, 'replace.txt', 'safe'); assert(categories(root).size === 0); const replaced = scanPublicTree(root, undefined, { beforeOpen: (absolute) => { fs.unlinkSync(absolute); fs.symlinkSync('/etc/passwd', absolute); } }); assert(replaced.some(item => item.category === 'unsafe-file-type'));
  const growing = temporary(); write(growing, 'grow.txt', 'safe'); const grown = scanPublicTree(growing, { ...{ fileBytes: 100, totalBytes: 100, entries: 100, pathBytes: 4096 } }, { beforeRead: (absolute) => fs.appendFileSync(absolute, 'growth') }); assert(grown.some(item => item.category === 'total-bound' || item.category === 'file-bound')); });
test('scanner completes injected short reads and detects findings after the first chunk', () => {
  const root = temporary(); write(root, 'short.txt', `safe\n${['secret', ': "abcdefghijklmnopqrstuv"'].join('')}\n`);
  const reads = []; const found = scanPublicTree(root, undefined, { read: (fd, buffer, offset, length, position) => { reads.push({ offset, length }); return fs.readSync(fd, buffer, offset, Math.min(3, length), position); } });
  assert(reads.length > 1); assert(found.some(item => item.category === 'credential' && item.path === 'short.txt' && item.line === 2));
});
test('scanner output is deterministic and locally stateful', () => { const root = temporary(); write(root, 'b.txt', 'safe'); write(root, 'a.txt', ['secret', ': "abcdefghijklmnopqrstu"'].join('')); const first = renderFindings(scanPublicTree(root)); const second = renderFindings(scanPublicTree(root)); assert.equal(first, second); });
