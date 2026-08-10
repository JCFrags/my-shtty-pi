import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LIMITS = { fileBytes: 2 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, entries: 100000, pathBytes: 4096 };
const generated = new Set(['node_modules', 'dist', 'target', 'coverage']);
const privateMetadata = new Set(['.pi', '.agents', 'session', 'sessions', 'browser', 'evidence', 'rollback', 'failed-candidates']);
const binary = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|tgz|gz|tar|7z|exe|dll|so|dylib|bin|woff2?|ttf|class)$/i;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

function finding(category, relativePath, line = 1) { return { category, path: relativePath, line }; }
function hasPrivatePath(text) { return /(?<![A-Za-z0-9_])(?:\/home\/|\/root\/|\/Users\/|[A-Z]:\\Users\\)/.test(text); }
function hasPrivateEndpoint(text) {
  const endpoint = /https?:\/\/(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|localhost|127\.0\.0\.1|[\w.-]+\.home\.arpa)(?::\d+)?/ig;
  return [...text.matchAll(endpoint)].some(m => !/(?:127\.0\.0\.1):(0|9)\b/.test(m[0]));
}
function lineFindings(text, relativePath) {
  const results = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(line)) results.push(finding('private-key', relativePath, index + 1));
    if (/(?:\bpassword\b|\bpasswd\b|\bsecret\b|\btoken\b|\bapi[_-]?key\b)\s*["']?\s*[:=]\s*['"][^'"]{20,}['"]/i.test(line) || /AKIA[0-9A-Z]{16}/.test(line)) results.push(finding('credential', relativePath, index + 1));
    if (hasPrivatePath(line)) results.push(finding('private-path', relativePath, index + 1));
    if (hasPrivateEndpoint(line)) results.push(finding('private-endpoint', relativePath, index + 1));
    const values = [...line.matchAll(/["'`]([A-Za-z0-9+/=_-]{40,})["'`]/g)].map(match => match[1]);
    for (const value of values) {
      if (/integrity|sha(?:256|512)-/i.test(line) || /^[a-f0-9]{40,}$/i.test(value) || /^\b[0-9a-f]{40}\b$/i.test(value)) continue;
      if (/^\/(?:workspace|packages|examples|tmp)\//.test(value)) continue; const counts = new Map([...value].map(character => [character, 0])); for (const character of value) counts.set(character, counts.get(character) + 1); const entropy = [...counts.values()].reduce((sum, count) => { const ratio = count / value.length; return sum - ratio * Math.log2(ratio); }, 0); if (entropy > 4.3) results.push(finding('high-entropy', relativePath, index + 1));
    }
  }
  return results;
}

export function scanPublicTree(directory, limits = LIMITS, hooks = {}) {
  const root = path.resolve(directory);
  const state = { findings: [], entries: 0, bytes: 0, stopped: false };
  function add(category, relativePath, line = 1) { state.findings.push(finding(category, relativePath, line)); }
  function walk(absolute, relative) {
    if (state.stopped) return;
    let node;
    try { node = fs.lstatSync(absolute); } catch { add('unsafe-file-type', relative || '.'); return; }
    state.entries += 1;
    if (state.entries > limits.entries) { add('entry-bound', relative || '.'); state.stopped = true; return; }
    if (node.isSymbolicLink()) { add('symlink', relative); return; }
    if (relative === '.git' || relative.startsWith('.git/')) return;
    if (Buffer.byteLength(relative, 'utf8') > limits.pathBytes) { add('path-bound', relative); state.stopped = true; return; }
    const basename = path.basename(relative);
    if (privateMetadata.has(basename)) { add('private-metadata', relative); return; }
    if (node.isDirectory()) {
      if (basename === '.git') return;
      if (generated.has(basename)) { add('generated-directory', relative); return; }
      let children;
      try { children = fs.readdirSync(absolute).sort((a, b) => a.localeCompare(b)); } catch { add('unsafe-file-type', relative); return; }
      for (const child of children) walk(path.join(absolute, child), relative ? `${relative}/${child}` : child);
      return;
    }
    if (!node.isFile()) { add('unsafe-file-type', relative); return; }
    if (binary.test(relative)) { add('binary', relative); return; }
    if (node.size > limits.fileBytes) { add('file-bound', relative); state.stopped = true; return; }
    const remaining = limits.totalBytes - state.bytes;
    if (remaining < 0 || node.size > remaining) { add('total-bound', relative); state.stopped = true; return; }
    try { hooks.beforeOpen?.(absolute, relative); } catch { add('unsafe-file-type', relative); return; }
    let fd;
    try {
      fd = fs.openSync(absolute, openFlags);
      const opened = fs.fstatSync(fd);
      if (!opened.isFile()) { add('unsafe-file-type', relative); return; }
      if (opened.size > limits.fileBytes) { add('file-bound', relative); state.stopped = true; return; }
      if (opened.size > remaining) { add('total-bound', relative); state.stopped = true; return; }
      hooks.beforeRead?.(absolute, relative, fd);
      const maxRead = Math.min(limits.fileBytes, remaining);
      const buffer = Buffer.alloc(maxRead + 1);
      let count = 0;
      while (count < buffer.length) {
        const read = (hooks.read ?? fs.readSync)(fd, buffer, count, buffer.length - count, count);
        if (!Number.isInteger(read) || read < 0 || read > buffer.length - count) throw new Error('invalid read result');
        if (read === 0) break;
        count += read;
      }
      const after = fs.fstatSync(fd);
      if (after.size > limits.fileBytes || count > limits.fileBytes) { add('file-bound', relative); state.stopped = true; return; }
      if (after.size > remaining || count > remaining || after.size > opened.size || count > maxRead) { add('total-bound', relative); state.stopped = true; return; }
      state.bytes += count;
      const bytes = buffer.subarray(0, count);
      if (bytes.includes(0)) { add('binary', relative); return; }
      let text;
      try { text = utf8.decode(bytes); } catch { add('binary', relative); return; }
      state.findings.push(...lineFindings(text, relative));
    } catch { add('unsafe-file-type', relative); } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
  }
  walk(root, '');
  const unique = new Map(state.findings.map(item => [`${item.category}\0${item.path}\0${item.line}`, item]));
  return [...unique.values()].sort((a, b) => `${a.category}\0${a.path}\0${a.line}`.localeCompare(`${b.category}\0${b.path}\0${b.line}`));
}

export function renderFindings(findings) { return findings.map(item => `${item.category}\t${item.path}\t${item.line}`).join('\n'); }
const defaultRoot = process.env.PUBLIC_TREE_ROOT ? path.resolve(process.env.PUBLIC_TREE_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) { const findings = scanPublicTree(defaultRoot); process.stdout.write(findings.length ? `${renderFindings(findings)}\n` : 'public-tree: ok\n'); process.exitCode = findings.length ? 1 : 0; }
