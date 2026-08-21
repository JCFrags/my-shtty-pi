import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { gunzipSync, gzipSync, inflateRawSync } from "node:zlib";
import { spawn } from "node:child_process";
import test from "node:test";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const MAX_COMPRESSED = 16 * 1024 * 1024;
const MAX_TAR = 128 * 1024 * 1024;
const MAX_ENTRIES = 512;
const MAX_FILE = 4 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
const REVIEWED_MODE = 0o644;
const REVIEWED_UID = 0;
const REVIEWED_GID = 0;
const REVIEWED_MTIME = 499162500;
const TYPESCRIPT_VERSION = "5.9.3";
const TYPESCRIPT_INTEGRITY = "sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==";
const TYPESCRIPT_MANIFEST_SHA256 = "822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6";
const TYPESCRIPT_IMPLEMENTATION_SHA256 = "3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675";
const UMBRELLA_ENTRIES = ["package/LICENSE", "package/README.md", "package/package.json", "package/docs/artifacts.md", "package/docs/benchmark.md", "package/docs/security.md", "package/packages/core/LICENSE", "package/packages/core/README.md", "package/packages/core/package.json", "package/packages/core/src/anchors.ts", "package/packages/core/src/atomic.ts", "package/packages/core/src/exec.ts", "package/packages/core/src/lsp-client.ts", "package/packages/core/src/notes.ts", "package/packages/core/src/output.ts", "package/packages/core/src/paths.ts", "package/packages/core/src/process-manager.ts", "package/packages/core/src/pty_bridge.py", "package/packages/core/src/search.ts", "package/packages/core/src/state.ts", "package/packages/core/src/syntax.ts", "package/packages/core/src/tasks.ts", "package/packages/core/src/text.ts", "package/packages/core/src/workplan.ts", ...["dialog", "files", "lsp", "notes", "process", "tasks", "workplan"].flatMap(n => [`package/packages/${n}/LICENSE`, `package/packages/${n}/README.md`, `package/packages/${n}/index.ts`, `package/packages/${n}/package.json`]), "package/packages/tasks/settings.ts", ...["LICENSE", "README.md", "package.json", "src/anchors.ts", "src/atomic.ts", "src/exec.ts", "src/lsp-client.ts", "src/notes.ts", "src/output.ts", "src/paths.ts", "src/process-manager.ts", "src/pty_bridge.py", "src/search.ts", "src/state.ts", "src/syntax.ts", "src/tasks.ts", "src/text.ts", "src/workplan.ts"].map(p => `package/node_modules/@grounded/pi-core/${p}`)].sort();
const FEATURE_ENTRIES = { notes: ["package/LICENSE", "package/README.md", "package/index.ts", "package/package.json"], workplan: ["package/LICENSE", "package/README.md", "package/index.ts", "package/package.json"] } as const;
const CORE_ENTRIES = UMBRELLA_ENTRIES.filter(p => p.startsWith("package/node_modules/@grounded/pi-core/")).map(p => p.slice("package/node_modules/@grounded/pi-core/".length));
const FORBIDDEN_ENTRY = /(?:^|\/)(?:tests?|test-fixtures?|\.git|node_modules\/(?:@earendil-works|typebox)|rollback|migration|backup|inventory|\.pi)(?:\/|$)|(?:goal|workplan-export)/i;
type ManifestEntry = {
    path: string;
    size: number;
    mode: number;
    uid: number;
    gid: number;
    mtime: number;
    sha256: string;
    bytes: Buffer;
};
type Evidence = {
    pathAccepted: boolean;
    digestAccepted: boolean;
    privateCopyWritten: boolean;
    manifestAccepted: boolean;
    extractionStarted: boolean;
    extractionCompleted: boolean;
    fixturesStarted: boolean;
    loadingStarted: boolean;
    loadingCompleted: boolean;
};
function newEvidence(): Evidence {
    return { pathAccepted: false, digestAccepted: false, privateCopyWritten: false, manifestAccepted: false, extractionStarted: false, extractionCompleted: false, fixturesStarted: false, loadingStarted: false, loadingCompleted: false };
}
function contained(base: string, target: string): boolean {
    return target !== base && target.startsWith(`${base}${sep}`);
}
function withinExact(base: string, target: string): boolean {
    const remainder = relative(base, target);
    return remainder === "" || !isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`);
}
function safeChild(root: string, child: string): string {
    const base = resolve(root);
    const target = resolve(base, child);
    const remainder = relative(base, target);
    if (remainder === "" || isAbsolute(remainder) || remainder === ".." || remainder.startsWith(`..${sep}`))
        throw new Error("temporary-root containment failure");
    return target;
}
function childEnvironment(root: string): NodeJS.ProcessEnv {
    return {
        PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
        HOME: root,
        TMPDIR: root,
        XDG_CACHE_HOME: root,
        XDG_CONFIG_HOME: root,
        XDG_DATA_HOME: root,
        npm_config_cache: join(root, "npm-cache"),
        npm_config_userconfig: join(root, ".npmrc"),
        npm_config_global: "false",
        npm_config_offline: "true",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_ignore_scripts: "true",
        npm_config_update_notifier: "false",
        npm_config_progress: "false",
        npm_config_registry: "http://127.0.0.1:9/",
        npm_config_proxy: "",
        npm_config_https_proxy: "",
        npm_config_noproxy: "*",
        LANG: "C",
        LC_ALL: "C",
        TZ: "UTC",
        NO_COLOR: "1",
    };
}
async function command(root: string, cwd: string, executable: string, args: string[]): Promise<string> {
    return await new Promise((resolveOut, reject) => {
        const p = spawn(executable, args, { cwd, env: childEnvironment(root), stdio: ["ignore", "pipe", "pipe"] });
        const out: Buffer[] = [], err: Buffer[] = [];
        let settled = false;
        const finish = (action: () => void) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                action();
            }
        };
        const timer = setTimeout(() => {
            p.kill("SIGKILL");
            finish(() => reject(new Error("bounded command timeout")));
        }, 30000);
        const collect = (target: Buffer[], chunk: Buffer) => {
            if (Buffer.concat([...target, chunk]).length > 8 * 1024 * 1024) {
                p.kill("SIGKILL");
                finish(() => reject(new Error("bounded command output")));
            }
            else {
                target.push(chunk);
            }
        };
        p.stdout.on("data", (b: Buffer) => collect(out, b));
        p.stderr.on("data", (b: Buffer) => collect(err, b));
        p.on("error", e => finish(() => reject(e)));
        p.on("close", (code, signal) => finish(() => {
            if (code !== 0)
                reject(new Error(`bounded command failed (${code ?? signal ?? "unknown"})`));
            else
                resolveOut(Buffer.concat(out).toString("utf8"));
        }));
    });
}
function octal(field: Buffer, label: string, max: number, blankZero = false): number {
    if (blankZero && field.every(byte => byte === 0))
        return 0;
    if (field.length < 2 || field[field.length - 1] !== 0x20)
        throw new Error(`invalid archive ${label} numeric format`);
    const digits = field.subarray(0, field.length - 1);
    if (!digits.every(byte => byte >= 0x30 && byte <= 0x37))
        throw new Error(`invalid archive ${label} octal digits`);
    const n = Number.parseInt(digits.toString("ascii"), 8);
    if (!Number.isSafeInteger(n) || n > max)
        throw new Error(`archive ${label} number out of bounds`);
    return n;
}
function reviewedOctal(field: Buffer, label: string, max: number, blankZero = false): number {
    if (blankZero && field.every(byte => byte === 0))
        return 0;
    if (field.length < 3 || field[field.length - 1] !== 0)
        throw new Error(`invalid archive ${label} numeric format`);
    return octal(field.subarray(0, field.length - 1), label, max);
}
function text(bytes: Buffer): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
function tarString(field: Buffer, label: string): Buffer {
    const end = field.indexOf(0);
    if (end < 0 || field.subarray(end + 1).some(byte => byte !== 0))
        throw new Error(`invalid archive ${label}`);
    return field.subarray(0, end);
}
function validateName(raw: Buffer): string {
    if (raw.includes(0))
        throw new Error("invalid archive name");
    const name = text(raw);
    if (!name.startsWith("package/") || name === "package/" || name.includes("\\") || name.startsWith("/") || /[\u0000-\u001f\u007f\n\r\t\p{Cf}]/u.test(name))
        throw new Error("invalid archive name");
    const parts = name.split("/");
    if (parts.some(p => !p || p === "." || p === ".."))
        throw new Error("invalid archive containment");
    return name;
}
type ParseLimits = { tar: number; entries: number; file: number; total: number };
const PRODUCTION_LIMITS: ParseLimits = { tar: MAX_TAR, entries: MAX_ENTRIES, file: MAX_FILE, total: MAX_TOTAL };
function parseTar(tar: Buffer, limits: ParseLimits = PRODUCTION_LIMITS): ManifestEntry[] {
    if (tar.length > limits.tar || tar.length % 512)
        throw new Error("invalid archive stream");
    const entries: ManifestEntry[] = [];
    const seen = new Set<string>();
    let total = 0, offset = 0, zeros = 0;
    while (offset < tar.length) {
        const h = tar.subarray(offset, offset + 512);
        if (h.every(b => b === 0)) {
            zeros++;
            offset += 512;
            if (zeros === 2) {
                if (tar.subarray(offset).some(b => b !== 0))
                    throw new Error("unsupported archive trailing data");
                if (tar.length - offset !== 0)
                    throw new Error("invalid archive padding");
                return entries;
            }
            continue;
        }
        if (zeros)
            throw new Error("invalid archive terminal blocks");
        if (entries.length >= limits.entries)
            throw new Error("archive entry limit");
        const stored = reviewedOctal(h.subarray(148, 156), "checksum", 0o7777777);
        const copy = Buffer.from(h);
        copy.fill(32, 148, 156);
        let sum = 0;
        for (const b of copy)
            sum += b;
        if (sum !== stored)
            throw new Error("invalid archive checksum");
        if (h.subarray(257, 263).toString("ascii") !== "ustar\0" || h.subarray(263, 265).toString("ascii") !== "00")
            throw new Error("unsupported archive format");
        const name = validateName(tarString(h.subarray(0, 100), "name"));
        if (h.subarray(345, 500).some(byte => byte !== 0))
            throw new Error("unsupported archive prefix");
        if (h.subarray(500, 512).some(byte => byte !== 0))
            throw new Error("unsupported archive reserved bytes");
        if (tarString(h.subarray(157, 257), "linkname").length || tarString(h.subarray(265, 297), "uname").length || tarString(h.subarray(297, 329), "gname").length)
            throw new Error("unsupported archive metadata");
        if (reviewedOctal(h.subarray(329, 337), "device", 0o7777777) !== 0 || reviewedOctal(h.subarray(337, 345), "device", 0o7777777) !== 0)
            throw new Error("unsupported archive device fields");
        const type = h[156];
        if (type !== 0 && type !== 48)
            throw new Error("unsupported archive entry type");
        const size = reviewedOctal(h.subarray(124, 136), "size", limits.file);
        const padded = Math.ceil(size / 512) * 512;
        if (offset + 512 + padded > tar.length)
            throw new Error("truncated archive payload");
        total += size;
        if (total > limits.total)
            throw new Error("archive byte limit");
        if (seen.has(name))
            throw new Error("duplicate archive path");
        seen.add(name);
        const padding = tar.subarray(offset + 512 + size, offset + 512 + padded);
        if (padding.some(byte => byte !== 0))
            throw new Error("nonzero archive payload padding");
        const bytes = Buffer.from(tar.subarray(offset + 512, offset + 512 + size));
        const mode = reviewedOctal(h.subarray(100, 108), "mode", 0o7777777);
        const uid = reviewedOctal(h.subarray(108, 116), "uid", 0o7777777, true);
        const gid = reviewedOctal(h.subarray(116, 124), "gid", 0o7777777, true);
        const mtime = reviewedOctal(h.subarray(136, 148), "mtime", Number.MAX_SAFE_INTEGER);
        if (mode !== REVIEWED_MODE || uid !== REVIEWED_UID || gid !== REVIEWED_GID || mtime !== REVIEWED_MTIME)
            throw new Error("unsupported archive reviewed metadata");
        entries.push({
            path: name,
            size,
            mode,
            uid,
            gid,
            mtime,
            sha256: sha256(bytes),
            bytes,
        });
        offset += 512 + padded;
    }
    throw new Error("missing archive terminal blocks");
}
async function readBounded(handle: Awaited<ReturnType<typeof open>>, maximum: number, beforeRead?: () => Promise<void>): Promise<Buffer> {
    if (beforeRead)
        await beforeRead();
    const bytes = Buffer.allocUnsafe(maximum + 1);
    let offset = 0;
    while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (result.bytesRead === 0)
            break;
        offset += result.bytesRead;
    }
    if (offset > maximum)
        throw new Error("artifact compressed size limit");
    return bytes.subarray(0, offset);
}
async function custody(root: string, source: string, expected: string, evidence: Evidence, limits: ParseLimits = PRODUCTION_LIMITS, beforeRead?: () => Promise<void>): Promise<{
    file: string;
    entries: ManifestEntry[];
}> {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
        throw new Error("temporary helper root rejected");
    const helperRoot = await realpath(root);
    const dir = await mkdtemp(join(helperRoot, "custody-"));
    const dirInfo = await lstat(dir);
    const resolvedDir = await realpath(dir);
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink() || !contained(helperRoot, resolvedDir))
        throw new Error("custody containment failure");
    await chmod(dir, 0o700);
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_COMPRESSED)
        throw new Error("artifact custody rejected");
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await open(source, flags);
    try {
        const opened = await handle.stat();
        evidence.pathAccepted = true;
        if (!opened.isFile() || opened.size !== info.size || opened.dev !== info.dev || opened.ino !== info.ino)
            throw new Error("artifact identity changed");
        const bytes = await readBounded(handle, MAX_COMPRESSED, beforeRead);
        const afterRead = await handle.stat();
        const afterPath = await lstat(source);
        if (!afterRead.isFile() || afterPath.isSymbolicLink() || afterRead.size > MAX_COMPRESSED || afterRead.size !== info.size || afterPath.size !== info.size || afterRead.dev !== info.dev || afterRead.ino !== info.ino || afterPath.dev !== info.dev || afterPath.ino !== info.ino)
            throw new Error("artifact identity changed");
        if (bytes.length !== info.size || sha256(bytes) !== expected)
            throw new Error("artifact digest mismatch");
        evidence.digestAccepted = true;
        const file = join(dir, "artifact.tgz");
        const out = await open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
        await out.writeFile(bytes);
        await out.close();
        const privateInfo = await lstat(file);
        if (!privateInfo.isFile() || privateInfo.size !== bytes.length || sha256(await readFile(file)) !== expected)
            throw new Error("custody copy mismatch");
        const privateBytes = await readFile(file);
        evidence.privateCopyWritten = true;
        if (sha256(privateBytes) !== expected || privateBytes.length !== info.size)
            throw new Error("custody copy mismatch");
        const flagsByte = privateBytes[3];
        if (privateBytes[0] !== 0x1f || privateBytes[1] !== 0x8b || privateBytes[2] !== 8 || flagsByte !== 0)
            throw new Error("unsupported gzip framing");
        if (privateBytes.length < 18)
            throw new Error("invalid gzip framing");
        const compressed = privateBytes.subarray(10, privateBytes.length - 8);
        const inflated = inflateRawSync(compressed, { info: true, maxOutputLength: limits.tar }) as unknown as { engine: { bytesWritten: number }; buffer: Buffer };
        if (inflated.engine.bytesWritten !== compressed.length)
            throw new Error("concatenated gzip members rejected");
        const tar = gunzipSync(privateBytes, { maxOutputLength: limits.tar });
        if (privateBytes.readUInt32LE(privateBytes.length - 4) !== (tar.length >>> 0))
            throw new Error("invalid gzip size");
        const entries = parseTar(tar, limits);
        if (!entries.length)
            throw new Error("empty archive");
        evidence.manifestAccepted = true;
        return { file, entries };
    }
    finally {
        await handle.close();
    }
}
async function extract(root: string, entries: ManifestEntry[], evidence: Evidence, suppliedTarget?: string): Promise<string> {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
        throw new Error("temporary helper root rejected");
    const helperRoot = await realpath(root);
    let extraction: string;
    if (suppliedTarget !== undefined) {
        const targetInfo = await lstat(suppliedTarget);
        if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink())
            throw new Error("supplied extraction target rejected");
        extraction = await realpath(suppliedTarget);
        if (!contained(helperRoot, extraction))
            throw new Error("extraction containment failure");
    }
    else {
        extraction = await mkdtemp(join(helperRoot, "extract-"));
        const targetInfo = await lstat(extraction);
        const resolvedExtraction = await realpath(extraction);
        if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink() || !contained(helperRoot, resolvedExtraction))
            throw new Error("extraction containment failure");
    }
    if ((await readdir(extraction)).length)
        throw new Error("pre-populated extraction target");
    await chmod(extraction, 0o700);
    evidence.extractionStarted = true;
    for (const e of entries) {
        const rel = e.path.slice("package/".length);
        const target = safeChild(extraction, rel);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const f = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
        await f.writeFile(e.bytes);
        await f.close();
    }
    const walk = async (dir: string): Promise<string[]> => {
        const result: string[] = [];
        for (const n of await readdir(dir)) {
            const p = join(dir, n), s = await lstat(p);
            if (s.isSymbolicLink() || !s.isDirectory() && !s.isFile())
                throw new Error("unsafe extracted type");
            if (s.isDirectory())
                result.push(...await walk(p));
            else
                result.push(`package/${relative(extraction, p).split(sep).join("/")}`);
        }
        return result;
    };
    const paths = (await walk(extraction)).sort();
    assert.deepEqual(paths, entries.map(e => e.path).sort());
    for (const e of entries) {
        const p = safeChild(extraction, e.path.slice(8));
        const s = await lstat(p);
        assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size === e.size);
        assert.equal(sha256(await readFile(p)), e.sha256);
        assert.equal((await realpath(p)).startsWith(`${await realpath(extraction)}${sep}`), true);
    }
    evidence.extractionCompleted = true;
    return extraction;
}
async function rejected(operation: () => Promise<unknown>, label = "operation"): Promise<Error> {
    try {
        await operation();
    }
    catch (error) {
        assert.ok(error instanceof Error);
        return error;
    }
    assert.fail(`expected ${label} to reject`);
}
async function assertNoSymlinks(root: string): Promise<void> {
    const info = await lstat(root);
    assert.equal(info.isSymbolicLink(), false);
    if (info.isDirectory()) {
        for (const name of await readdir(root))
            await assertNoSymlinks(join(root, name));
    }
}
async function writePeerFixtures(root: string, evidence?: Evidence): Promise<void> {
    if (evidence)
        evidence.fixturesStarted = true;
    const fixtures = safeChild(root, "fixtures/node_modules");
    await mkdir(safeChild(root, "fixtures"), { recursive: true, mode: 0o700 });
    const lock = JSON.parse(await readFile(join(repo, "package-lock.json"), "utf8"));
    const locked = lock.packages?.["node_modules/typescript"];
    assert.equal(locked?.version, TYPESCRIPT_VERSION);
    assert.equal(locked?.integrity, TYPESCRIPT_INTEGRITY);
    const packageRequire = createRequire(join(repo, "package.json"));
    const source = await realpath(packageRequire.resolve("typescript/package.json"));
    const typescriptRoot = await realpath(join(repo, "node_modules/typescript"));
    assert.ok(withinExact(typescriptRoot, source));
    const manifestBytes = await readFile(source);
    const implementation = await realpath(join(typescriptRoot, "lib/typescript.js"));
    assert.ok(withinExact(typescriptRoot, implementation));
    const implementationBytes = await readFile(implementation);
    assert.equal(sha256(manifestBytes), TYPESCRIPT_MANIFEST_SHA256);
    assert.equal(sha256(implementationBytes), TYPESCRIPT_IMPLEMENTATION_SHA256);
    const fixtureRoot = safeChild(root, "fixtures/node_modules/typescript");
    await mkdir(safeChild(root, "fixtures/node_modules/typescript/lib"), { recursive: true, mode: 0o700 });
    for (const [path, bytes, digest] of [[join(fixtureRoot, "package.json"), manifestBytes, TYPESCRIPT_MANIFEST_SHA256], [join(fixtureRoot, "lib/typescript.js"), implementationBytes, TYPESCRIPT_IMPLEMENTATION_SHA256]] as const) {
        const file = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
        await file.writeFile(bytes);
        await file.close();
        assert.equal(sha256(await readFile(path)), digest);
        const effective = await realpath(path);
        assert.ok(withinExact(await realpath(fixtureRoot), effective));
    }
    const lockedManifest = JSON.parse(manifestBytes.toString("utf8"));
    assert.equal(lockedManifest.name, "typescript");
    assert.equal(lockedManifest.version, TYPESCRIPT_VERSION);
    const packages: Record<string, string> = { "@earendil-works/pi-ai": "export const StringEnum = (v) => ({type:'string',values:v});", "@earendil-works/pi-coding-agent": "export const CONFIG_DIR_NAME = '.pi'; export const getAgentDir = () => { throw new Error('controlled fixture forbids agent-directory access'); }; export const DEFAULT_MAX_BYTES = 1024 * 1024; export const DEFAULT_MAX_LINES = 2000; export const formatSize = (value) => `${value} bytes`; export const truncateHead = (value, limits) => ({ content: value, truncated: false, outputLines: value.split('\\n').length, totalLines: value.split('\\n').length, outputBytes: Buffer.byteLength(value), totalBytes: Buffer.byteLength(value) }); export const truncateTail = truncateHead; export const createReadTool = () => ({ execute: async () => ({ content: [{ type: 'text', text: '' }] }) }); export const generateDiffString = () => ({ diff: '', firstChangedLine: 1 }); export const generateUnifiedPatch = () => ''; export const withFileMutationQueue = (_path, fn) => fn();", "@earendil-works/pi-tui": "export const CURSOR_MARKER = ''; export class Editor { constructor() {} set focused(value) {} setText() {} handleInput() {} invalidate() {} render() { return []; } } export class Text { constructor() {} } export const Key = { escape: '', up: '', down: '', enter: '', ctrl: () => '' }; export const matchesKey = () => false; export const truncateToWidth = (value) => value; export const wrapTextWithAnsi = (value) => [value];", typebox: "export const Type = new Proxy({}, { get: () => (...args) => ({ args }) });" };
    for (const [name, sourceText] of Object.entries(packages)) {
        const p = join(fixtures, ...name.split("/"));
        await mkdir(p, { recursive: true });
        await writeFile(join(p, "package.json"), JSON.stringify({ name, type: "module", exports: { ".": "./index.js", "./package.json": "./package.json" } }));
        await writeFile(join(p, "index.js"), sourceText);
    }
}
function controlledLoaderSource(ts: string, record: string, packageRoot: string, coreRoot: string, peerRoots: Record<string, string>, childScript: string): string {
    return `import ts from ${JSON.stringify(ts)};
import {appendFile,readFile,realpath} from 'node:fs/promises'; import {fileURLToPath} from 'node:url'; import {isAbsolute,relative,sep} from 'node:path';
const record=${JSON.stringify(record)},packageRoot=${JSON.stringify(packageRoot)},coreRoot=${JSON.stringify(coreRoot)},peerRoots=${JSON.stringify(peerRoots)},childScript=${JSON.stringify(childScript)}; let bytes=0,count=0;
function within(root,target){const r=relative(root,target);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));}
async function inspect(url){if(url.startsWith('node:'))return;let parsed;try{parsed=new URL(url)}catch{throw new Error('loader rejected non-URL import')}if(parsed.protocol!=='file:')throw new Error('loader rejected non-file import');const path=await realpath(fileURLToPath(parsed));let category=null;if(path===childScript)category='child-script';else if(within(coreRoot,path))category='bundled-core';else if(within(packageRoot,path))category='package';else for(const [name,root] of Object.entries(peerRoots)){if(within(root,path)){category='peer:'+name;break}}if(category===null)throw new Error('loader effective-path rejection');const line=JSON.stringify({category,path})+'\\n';bytes+=Buffer.byteLength(line);count++;if(bytes>1048576||count>4096)throw new Error('loader import record limit');await appendFile(record,line,{encoding:'utf8'});}
export async function load(url,context,nextLoad){await inspect(url);if(!url.endsWith('.ts'))return nextLoad(url,context);return {format:'module',shortCircuit:true,source:ts.transpileModule(await readFile(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText};}`;
}
async function cleanLoad(root: string, extraction: string, packageName: string, entries: string[], expectedTools: string[], stateTool?: "notes" | "workplan", evidence?: Evidence): Promise<void> {
    await writePeerFixtures(root, evidence);
    const packageRoot = safeChild(root, join("load/node_modules", ...packageName.split("/")));
    await mkdir(packageRoot, { recursive: true, mode: 0o700 });
    const fixtureModules = safeChild(root, "fixtures/node_modules"), loadModules = safeChild(root, "load/node_modules");
    for (const name of await readdir(fixtureModules)) await cp(join(fixtureModules, name), join(loadModules, name), { recursive: true });
    await cp(extraction, packageRoot, { recursive: true });
    const script = safeChild(root, "load.mjs"), loader = safeChild(root, "fixtures/loader.mjs"), record = safeChild(root, "imports.jsonl");
    const ts = safeChild(root, "fixtures/node_modules/typescript/lib/typescript.js");
    await writeFile(record, "", { mode: 0o600 });
    const exactPackageRoot = await realpath(packageRoot), exactCoreRoot = await realpath(join(packageRoot, "node_modules/@grounded/pi-core"));
    const exactFixtureRoot = await realpath(safeChild(root, "fixtures")), exactTypescriptRoot = await realpath(safeChild(root, "fixtures/node_modules/typescript")), exactTs = await realpath(ts);
    const peerNames = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"];
    const peerRoots = Object.fromEntries(await Promise.all(peerNames.map(async name => [name, await realpath(join(loadModules, ...name.split("/")))])));
    assert.equal(sha256(await readFile(exactTs)), TYPESCRIPT_IMPLEMENTATION_SHA256);
    assert.ok(withinExact(exactTypescriptRoot, exactTs));
    await writeFile(script, `import {createRequire} from 'node:module';const root=${JSON.stringify(exactPackageRoot)},entries=${JSON.stringify(entries)},peers=${JSON.stringify(peerNames)},tools=[],registered=new Map(),require=createRequire(root+'/package.json');for(const e of entries){(await import(root+'/'+e.replace(/^\\.\\//,''))).default({registerTool(v){tools.push(v.name);registered.set(v.name,v)},registerCommand(){},registerShortcut(){},on(){},events:{on(){return()=>{}},emit(){}},appendEntry(){},getActiveTools(){return[]},setActiveTools(){},getAllTools(){return[]}})}const resolutions={core:require.resolve('@grounded/pi-core/state'),peers:Object.fromEntries(peers.map(n=>[n,require.resolve(n)]))};await Promise.all(Object.values(resolutions.peers).map(p=>import(p)));let stateRead=null;if(${JSON.stringify(stateTool)}==='notes'){const result=await registered.get('notes').execute('m',{action:'add',body:'artifact fixture'});stateRead=result.details.result.id}if(${JSON.stringify(stateTool)}==='workplan'){const result=await registered.get('workplan').execute('m',{action:'create',content:{title:'Artifact',objective:'Fixture',approach:'Offline'}});stateRead=result.details.result.planId}console.log(JSON.stringify({tools,resolutions,stateRead}));`);
    const exactScript = await realpath(script);
    await writeFile(loader, controlledLoaderSource(exactTs, record, exactPackageRoot, exactCoreRoot, peerRoots, exactScript));
    const exactLoader = await realpath(loader);
    assert.ok(withinExact(exactFixtureRoot, exactLoader));
    assert.equal(exactLoader, await realpath(safeChild(root, "fixtures/loader.mjs")));
    await assertNoSymlinks(loader); await assertNoSymlinks(fixtureModules);
    if (evidence) evidence.loadingStarted = true;
    const output = JSON.parse((await command(root, root, process.execPath, ["--experimental-loader", exactLoader, exactScript])).trim());
    assert.deepEqual(output.tools, expectedTools);
    if (stateTool) assert.equal(output.stateRead, stateTool === "notes" ? "N1" : "WP1");
    const exactCore = await realpath(output.resolutions.core);
    assert.ok(withinExact(exactCoreRoot, exactCore));
    for (const [name, path] of Object.entries(output.resolutions.peers) as Array<[string, string]>) assert.ok(withinExact(peerRoots[name], await realpath(path)));
    for (const entry of entries) assert.ok(withinExact(exactPackageRoot, await realpath(join(exactPackageRoot, entry.replace(/^\.\//, "")))));
    const recordBytes = await readFile(record);
    assert.ok(recordBytes.length > 0 && recordBytes.length <= 1024 * 1024);
    const records = recordBytes.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line) as { category: string; path: string });
    assert.ok(records.length <= 4096);
    const recorded = new Set(records.map(item => item.path));
    for (const item of records) {
        const effective = await realpath(item.path); assert.equal(effective, item.path);
        if (item.category === "child-script") assert.equal(effective, exactScript);
        else if (item.category === "bundled-core") assert.ok(withinExact(exactCoreRoot, effective));
        else if (item.category === "package") assert.ok(withinExact(exactPackageRoot, effective) && !withinExact(exactCoreRoot, effective));
        else if (item.category.startsWith("peer:")) assert.ok(withinExact(peerRoots[item.category.slice(5)], effective));
        else assert.fail("unexpected loader import category");
    }
    assert.ok(recorded.has(exactScript)); assert.ok(recorded.has(exactCore));
    for (const path of Object.values(output.resolutions.peers) as string[]) assert.ok(recorded.has(await realpath(path)));
    for (const entry of entries) assert.ok(recorded.has(await realpath(join(exactPackageRoot, entry.replace(/^\.\//, "")))));
    if (evidence) evidence.loadingCompleted = true;
}
export async function verifyReleaseArtifact(input: {
    artifactPath: string;
    sha256: string;
    provenance: {
        source: string;
        version: string;
        commit: string;
    };
    temporaryRoot: string;
    packageName: string;
    entries: string[];
    expectedTools: string[];
}): Promise<void> {
    const evidence: Evidence = newEvidence();
    assert.match(input.sha256, /^[0-9a-f]{64}$/);
    assert.ok(input.provenance.source && input.provenance.version && input.provenance.commit);
    const held = await custody(resolve(input.temporaryRoot), input.artifactPath, input.sha256, evidence);
    assert.deepEqual(held.entries.map(e => e.path).sort(), UMBRELLA_ENTRIES);
    const extraction = await extract(resolve(input.temporaryRoot), held.entries, evidence);
    await cleanLoad(resolve(input.temporaryRoot), extraction, input.packageName, input.entries, input.expectedTools, undefined, evidence);
}
function writeReviewedOctal(field: Buffer, offset: number, width: number, value: number): void {
    field.fill(0, offset, offset + width);
    field.write(value.toString(8).padStart(width - 2, "0") + " ", offset, "ascii");
}
function tarHeader(name: string | Buffer, type = 48, body = Buffer.from("x")): Buffer {
    const h = Buffer.alloc(512);
    if (Buffer.isBuffer(name))
        name.copy(h, 0);
    else
        h.write(name, 0, "utf8");
    writeReviewedOctal(h, 100, 8, REVIEWED_MODE);
    writeReviewedOctal(h, 108, 8, 0);
    writeReviewedOctal(h, 116, 8, 0);
    writeReviewedOctal(h, 124, 12, body.length);
    writeReviewedOctal(h, 329, 8, 0);
    writeReviewedOctal(h, 337, 8, 0);
    writeReviewedOctal(h, 136, 12, REVIEWED_MTIME);
    h.fill(32, 148, 156);
    h.writeUInt8(type, 156);
    h.write("ustar\0", 257, "ascii");
    h.write("00", 263, "ascii");
    let sum = 0;
    for (const b of h)
        sum += b;
    writeReviewedOctal(h, 148, 8, sum);
    return Buffer.concat([h, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}
function recomputeChecksum(tar: Buffer): Buffer {
    const copy = Buffer.from(tar);
    copy.fill(32, 148, 156);
    let sum = 0;
    for (const b of copy.subarray(0, 512))
        sum += b;
    writeReviewedOctal(copy, 148, 8, sum);
    return copy;
}
function mutatedArchive(mutator: (header: Buffer) => void): Buffer {
    const tar = tarHeader("package/x");
    mutator(tar);
    return gzipSync(Buffer.concat([recomputeChecksum(tar), Buffer.alloc(1024)]));
}
function badArchive(kind: string): Buffer {
    let name = "package/x";
    let type = 48;
    const complete = () => gzipSync(Buffer.concat([tarHeader(name, type), Buffer.alloc(1024)]));
    if (kind === "bad-crc" || kind === "bad-isize") {
        const value = complete();
        const trailerOffset = value.length - (kind === "bad-crc" ? 8 : 4);
        value.writeUInt8(value.readUInt8(trailerOffset) ^ 1, trailerOffset);
        return value;
    }
    if (kind === "gzip-flags") {
        const value = complete();
        value[3] = 4;
        return value;
    }
    if (kind === "empty")
        return gzipSync(Buffer.alloc(1024));
    if (kind === "no-terminal")
        return gzipSync(tarHeader(name, type));
    if (kind === "one-terminal")
        return gzipSync(Buffer.concat([tarHeader(name, type), Buffer.alloc(512)]));
    const noncanonical = (offset: number, width: number, value: number, nulTerminated = false) => mutatedArchive(header => {
        header.fill(0, offset, offset + width);
        header.write(nulTerminated ? value.toString(8).padStart(width - 1, "0") + "\0" : value.toString(8) + " ", offset, "ascii");
    });
    if (kind === "noncanonical-checksum") {
        const tar = tarHeader(name, type);
        const value = Number.parseInt(tar.subarray(148, 154).toString("ascii"), 8);
        tar.fill(0, 148, 156);
        tar.write(value.toString(8).padStart(6, "0") + "\0", 148, "ascii");
        return gzipSync(Buffer.concat([tar, Buffer.alloc(1024)]));
    }
    if (kind === "noncanonical-mode-early") return noncanonical(100, 8, REVIEWED_MODE);
    if (kind === "noncanonical-mode-nul") return noncanonical(100, 8, REVIEWED_MODE, true);
    if (kind === "noncanonical-uid") return noncanonical(108, 8, 0);
    if (kind === "noncanonical-gid") return noncanonical(116, 8, 0);
    if (kind === "noncanonical-size") return noncanonical(124, 12, 1);
    if (kind === "noncanonical-mtime") return noncanonical(136, 12, REVIEWED_MTIME, true);
    if (kind === "noncanonical-device-major") return noncanonical(329, 8, 0);
    if (kind === "noncanonical-device-minor") return noncanonical(337, 8, 0);
    if (kind === "link" || kind === "hardlink" || kind === "fifo")
        name = "package/LICENSE";
    if (kind === "link")
        type = 50;
    if (kind === "hardlink")
        type = 49;
    if (kind === "fifo")
        type = 54;
    if (kind === "duplicate")
        return gzipSync(Buffer.concat([tarHeader(name), tarHeader(name), Buffer.alloc(1024)]));
    if (kind === "concat") {
        return Buffer.concat([
            gzipSync(Buffer.concat([tarHeader(name), Buffer.alloc(1024)])),
            gzipSync(Buffer.alloc(1024)),
        ]);
    }
    if (kind === "padding") {
        const value = tarHeader(name);
        value[512 + 1] = 1;
        return gzipSync(Buffer.concat([value, Buffer.alloc(1024)]));
    }
    if (kind === "truncated-header")
        return gzipSync(Buffer.alloc(511));
    if (kind === "truncated-payload") {
        const value = tarHeader(name, type, Buffer.alloc(513));
        return gzipSync(value.subarray(0, 1024));
    }
    if (kind === "trailing")
        return gzipSync(Buffer.concat([tarHeader(name), Buffer.alloc(1024), Buffer.from([1]), Buffer.alloc(511)]))
    if (kind === "utf8")
        return mutatedArchive(header => header.writeUInt8(0xff, 8));
    if (kind === "prefix")
        return mutatedArchive(header => header.writeUInt8(0x41, 345));
    if (kind === "reserved")
        return mutatedArchive(header => header.writeUInt8(0x41, 500));
    if (kind === "linkname")
        return mutatedArchive(header => header.write("package/y", 157, "ascii"));
    if (kind === "uname")
        return mutatedArchive(header => header.write("user", 265, "ascii"));
    if (kind === "gname")
        return mutatedArchive(header => header.write("group", 297, "ascii"));
    if (kind === "device-major")
        return mutatedArchive(header => writeReviewedOctal(header, 329, 8, 1));
    if (kind === "device-minor")
        return mutatedArchive(header => writeReviewedOctal(header, 337, 8, 1));
    if (kind === "magic")
        return mutatedArchive(header => header.write("vstar\\0", 257, "ascii"));
    if (kind === "version")
        return mutatedArchive(header => header.write("01", 263, "ascii"));
    if (kind === "pax")
        return mutatedArchive(header => header.writeUInt8(120, 156));
    if (kind === "gnu-longname")
        return mutatedArchive(header => header.writeUInt8(76, 156));
    if (kind === "sparse")
        return mutatedArchive(header => header.writeUInt8(83, 156));
    if (kind === "mode")
        return mutatedArchive(header => writeReviewedOctal(header, 100, 8, 0o755));
    if (kind === "uid")
        return mutatedArchive(header => writeReviewedOctal(header, 108, 8, 1));
    if (kind === "gid")
        return mutatedArchive(header => writeReviewedOctal(header, 116, 8, 1));
    if (kind === "mtime")
        return mutatedArchive(header => writeReviewedOctal(header, 136, 12, REVIEWED_MTIME + 1));
    if (kind === "malformed-mode")
        return mutatedArchive(header => header.write("0000000X ", 100, "ascii"));
    if (kind === "control")
        name = "package/x\n";
    if (kind === "cr")
        name = "package/x\r";
    if (kind === "c0")
        name = "package/x\u000b";
    if (kind === "del")
        name = "package/x\u007f";
    if (kind === "format")
        name = "package/x\u202e";
    if (kind === "nul-suffix") {
        const raw = Buffer.alloc(100);
        raw.write("package/x", 0, "utf8");
        raw.writeUInt8(0, 9);
        raw.writeUInt8(0x41, 10);
        const value = tarHeader(raw, type);
        return gzipSync(Buffer.concat([value, Buffer.alloc(1024)]));
    }
    if (kind === "traversal")
        name = "package/../x";
    if (kind === "absolute")
        name = "/package/x";
    const value = tarHeader(name, type);
    if (kind === "checksum")
        value.writeUInt8(value.readUInt8(0) ^ 1, 0);
    return gzipSync(Buffer.concat([value, Buffer.alloc(1024)]));
}
async function packSource(environmentRoot: string, sourceRoot: string, destination: string): Promise<{
    archive: string;
    metadata: any;
}> {
    await mkdir(destination, { recursive: true });
    const output = await command(environmentRoot, sourceRoot, "npm", ["pack", ".", "--ignore-scripts", "--json", "--pack-destination", destination]);
    const metadata = JSON.parse(output)[0];
    return { archive: join(destination, metadata.filename), metadata };
}
test("feature source packs keep bundled core and load independently", async () => {
    for (const name of ["notes", "workplan"] as const) {
        const root = await mkdtemp(join(tmpdir(), `grounded-${name}-pack-`));
        try {
            const stage = safeChild(root, "stage");
            await mkdir(stage);
            await cp(join(repo, "packages", name), stage, { recursive: true });
            await mkdir(safeChild(root, "stage/node_modules/@grounded"), { recursive: true });
            await cp(join(repo, "packages", "core"), safeChild(root, "stage/node_modules/@grounded/pi-core"), { recursive: true });
            const packed = await packSource(root, stage, safeChild(root, "archives"));
            const held = await custody(root, packed.archive, sha256(await readFile(packed.archive)), newEvidence());
            assert.deepEqual(held.entries.map(e => e.path).sort(), [...FEATURE_ENTRIES[name], ...CORE_ENTRIES.map(path => `package/node_modules/@grounded/pi-core/${path}`)].sort());
            const extraction = await extract(root, held.entries, newEvidence());
            await cleanLoad(root, extraction, `@grounded/pi-${name}`, ["./index.ts"], [name], name, newEvidence());
        }
        finally {
            await rm(root, { recursive: true, force: true });
        }
    }
});
test("source packs use strict reviewed payloads and clean controlled loading", async () => {
    const root = await mkdtemp(join(tmpdir(), "grounded-source-pack-"));
    try {
        const destination = safeChild(root, "archives");
        await mkdir(destination);
        const output = await command(root, repo, "npm", ["pack", ".", "--ignore-scripts", "--json", "--pack-destination", destination]);
        const packed = JSON.parse(output)[0];
        const held = await custody(root, join(destination, packed.filename), sha256(await readFile(join(destination, packed.filename))), newEvidence());
        assert.deepEqual(held.entries.map(e => e.path).sort(), UMBRELLA_ENTRIES);
        assert.equal(held.entries.some(e => FORBIDDEN_ENTRY.test(e.path)), false);
        const manifest = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
        assert.equal(manifest.scripts?.postinstall, undefined);
        assert.equal(manifest.scripts?.prepare, undefined);
        const extraction = await extract(root, held.entries, newEvidence());
        await cleanLoad(root, extraction, "pi-grounded-tools", manifest.pi.extensions, ["read", "edit", "write", "grep", "find", "fuzzy_find", "bash", "process", "lsp", "ask_user_question", "todo", "notes", "workplan"]);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("strict parser rejects unsafe archive headers before extraction", async () => {
    const root = await mkdtemp(join(tmpdir(), "grounded-negative-"));
    try {
        for (const kind of ["checksum", "bad-crc", "bad-isize", "gzip-flags", "empty", "no-terminal", "one-terminal", "link", "hardlink", "fifo", "duplicate", "control", "cr", "c0", "del", "format", "nul-suffix", "traversal", "absolute", "padding", "concat", "truncated-header", "truncated-payload", "trailing", "utf8", "prefix", "reserved", "linkname", "uname", "gname", "device-major", "device-minor", "magic", "version", "pax", "gnu-longname", "sparse", "mode", "uid", "gid", "mtime", "malformed-mode", "noncanonical-checksum", "noncanonical-mode-early", "noncanonical-mode-nul", "noncanonical-uid", "noncanonical-gid", "noncanonical-size", "noncanonical-mtime", "noncanonical-device-major", "noncanonical-device-minor"]) {
            const p = safeChild(root, `${kind}.tgz`);
            await writeFile(p, badArchive(kind));
            const evidence: Evidence = newEvidence();
            const digest = sha256(await readFile(p));
            const error = await rejected(() => custody(root, p, digest, evidence), kind);
            assert.equal(error.message.includes(p), false);
            assert.equal(error.message.includes(repo), false);
            assert.equal(evidence.extractionStarted, false);
            assert.equal(evidence.extractionCompleted, false);
            assert.equal(evidence.fixturesStarted, false);
            assert.equal(evidence.loadingStarted, false);
            assert.equal(evidence.loadingCompleted, false);
        }
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("custody and extraction reject the remaining deterministic boundary cases", async () => {
    const root = await mkdtemp(join(tmpdir(), "grounded-boundaries-"));
    try {
        const good = safeChild(root, "good.tgz");
        await writeFile(good, badArchive("good"));
        const evidence: Evidence = newEvidence();
        const wrongDigestError = await rejected(() => custody(root, good, "0".repeat(64), evidence));
        assert.equal(wrongDigestError.message.includes(good), false);
        assert.equal(wrongDigestError.message.includes(repo), false);
        assert.equal(evidence.extractionStarted, false);
        assert.equal(evidence.extractionCompleted, false);
        assert.equal(evidence.fixturesStarted, false);
        assert.equal(evidence.loadingStarted, false);
        assert.equal(evidence.loadingCompleted, false);
        const link = safeChild(root, "supplied-link.tgz");
        await symlink(good, link);
        const goodDigest = sha256(await readFile(good));
        const symlinkError = await rejected(() => custody(root, link, goodDigest, evidence));
        assert.equal(symlinkError.message.includes(link), false);
        assert.equal(symlinkError.message.includes(repo), false);
        assert.equal(evidence.extractionStarted, false);
        assert.equal(evidence.fixturesStarted, false);
        assert.equal(evidence.loadingStarted, false);
        const large = safeChild(root, "large.tgz");
        const largeHandle = await open(large, fsConstants.O_WRONLY | fsConstants.O_CREAT, 0o600);
        await largeHandle.truncate(MAX_COMPRESSED + 1);
        await largeHandle.close();
        const oversizedError = await rejected(() => custody(root, large, "0".repeat(64), evidence));
        assert.equal(oversizedError.message.includes(large), false);
        assert.equal(oversizedError.message.includes(repo), false);
        assert.equal(evidence.extractionStarted, false);
        assert.equal(evidence.fixturesStarted, false);
        assert.equal(evidence.loadingStarted, false);
        const hard = safeChild(root, "hard.tgz");
        await writeFile(hard, badArchive("hardlink"));
        const hardDigest = sha256(await readFile(hard));
        const unsafeError = await rejected(() => custody(root, hard, hardDigest, evidence));
        assert.equal(unsafeError.message.includes(hard), false);
        assert.equal(unsafeError.message.includes(repo), false);
        assert.equal(evidence.extractionStarted, false);
        assert.equal(evidence.fixturesStarted, false);
        assert.equal(evidence.loadingStarted, false);
        const pre = safeChild(root, "artifact");
        await mkdir(pre);
        await writeFile(join(pre, "existing"), "x");
        await assert.rejects(() => extract(root, [{ path: "package/x", size: 1, mode: REVIEWED_MODE, uid: 0, gid: 0, mtime: REVIEWED_MTIME, sha256: sha256("x"), bytes: Buffer.from("x") }], evidence, pre));
        assert.equal(evidence.extractionStarted, false);
        const helper = safeChild(root, "helper");
        const outside = safeChild(root, "outside");
        await mkdir(helper);
        await mkdir(outside);
        await writeFile(join(outside, "sentinel"), "unchanged");
        const targetLink = safeChild(root, "target-link");
        await symlink(outside, targetLink);
        const targetEvidence = newEvidence();
        await assert.rejects(() => extract(helper, [{ path: "package/x", size: 1, mode: REVIEWED_MODE, uid: 0, gid: 0, mtime: REVIEWED_MTIME, sha256: sha256("x"), bytes: Buffer.from("x") }], targetEvidence, targetLink));
        assert.equal(targetEvidence.extractionStarted, false);
        const parentLink = safeChild(helper, "parent-link");
        await symlink(outside, parentLink);
        const parentEvidence = newEvidence();
        await assert.rejects(() => extract(helper, [{ path: "package/x", size: 1, mode: REVIEWED_MODE, uid: 0, gid: 0, mtime: REVIEWED_MTIME, sha256: sha256("x"), bytes: Buffer.from("x") }], parentEvidence, join(parentLink, "target")));
        assert.equal(parentEvidence.extractionStarted, false);
        assert.deepEqual(await readdir(outside), ["sentinel"]);
        assert.equal(evidence.extractionCompleted, false);
        assert.equal(evidence.fixturesStarted, false);
        assert.equal(evidence.loadingStarted, false);
        assert.equal(evidence.loadingCompleted, false);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("bounded custody rejects inode growth before acceptance or loading", async () => {
    const root = await mkdtemp(join(tmpdir(), "grounded-growth-"));
    try {
        const artifact = safeChild(root, "growing.tgz");
        const initial = await open(artifact, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
        await initial.truncate(MAX_COMPRESSED);
        await initial.close();
        const evidence = newEvidence();
        const error = await rejected(() => custody(root, artifact, "0".repeat(64), evidence, PRODUCTION_LIMITS, async () => {
            const growth = await open(artifact, fsConstants.O_WRONLY);
            try {
                await growth.truncate(MAX_COMPRESSED + 1);
            }
            finally {
                await growth.close();
            }
        }), "inode growth");
        assert.equal(error.message, "artifact compressed size limit");
        assert.equal(evidence.pathAccepted, true);
        assert.equal(evidence.digestAccepted, false);
        assert.equal(evidence.privateCopyWritten, false);
        assert.equal(evidence.manifestAccepted, false);
        assert.equal(evidence.extractionStarted, false);
        assert.equal(evidence.extractionCompleted, false);
        assert.equal(evidence.fixturesStarted, false);
        assert.equal(evidence.loadingStarted, false);
        assert.equal(evidence.loadingCompleted, false);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("archive limits reject before extraction and malformed fields reach parseTar", async () => {
    const one = tarHeader("package/one");
    const two = tarHeader("package/two");
    const valid = Buffer.concat([one, two, Buffer.alloc(1024)]);
    assert.throws(() => parseTar(valid, { tar: 1024, entries: MAX_ENTRIES, file: MAX_FILE, total: MAX_TOTAL }), /archive|stream/);
    assert.throws(() => parseTar(valid, { tar: MAX_TAR, entries: 1, file: MAX_FILE, total: MAX_TOTAL }), /entry/);
    assert.throws(() => parseTar(one, { tar: MAX_TAR, entries: MAX_ENTRIES, file: 0, total: MAX_TOTAL }), /size|bounds/);
    assert.throws(() => parseTar(valid, { tar: MAX_TAR, entries: MAX_ENTRIES, file: MAX_FILE, total: 0 }), /byte/);
    const malformed = gunzipSync(badArchive("malformed-mode"));
    assert.throws(() => parseTar(malformed), /numeric|octal/);
    const root = await mkdtemp(join(tmpdir(), "grounded-bound-limit-"));
    try {
        const p = safeChild(root, "bounded.tgz");
        await writeFile(p, gzipSync(valid));
        const evidence = newEvidence();
        const digest = sha256(await readFile(p));
        await assert.rejects(() => custody(root, p, digest, evidence, { tar: 1, entries: MAX_ENTRIES, file: MAX_FILE, total: MAX_TOTAL }));
        assert.equal(evidence.extractionStarted, false);
        assert.equal(evidence.fixturesStarted, false);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("strict reviewed numeric fields reject malformed encodings", () => {
    const cases: Array<[string, Buffer, string, number, boolean?]> = [
        ["mode", Buffer.alloc(8), "mode", 0o7777777],
        ["size", Buffer.from("00000000001\0"), "size", MAX_FILE],
        ["size", Buffer.from("00000000001  \0"), "size", MAX_FILE],
        ["size", Buffer.from("00000000001"), "size", MAX_FILE],
        ["size", Buffer.from("00000000008 "), "size", MAX_FILE],
        ["size", Buffer.from(" 000000001 "), "size", MAX_FILE],
        ["size", Buffer.from("+00000001 "), "size", MAX_FILE],
        ["size", Buffer.from("77777777777 "), "size", MAX_FILE],
        ["size", Buffer.from([0x80, ...Buffer.alloc(11), 0x20]), "size", MAX_FILE],
    ];
    for (const [, field, label, max, blankZero] of cases)
        assert.throws(() => octal(field, label, max, blankZero), /archive/);
    assert.equal(octal(Buffer.alloc(8), "uid", 0o7777777, true), 0);
    assert.equal(octal(Buffer.from("0000000 "), "uid", 0o7777777, true), 0);
});
test("effective containment distinguishes root, parent escape, and ..safe child", () => {
    const root = "/tmp/root";
    assert.throws(() => safeChild(root, "."));
    assert.throws(() => safeChild(root, "../escape"));
    assert.equal(safeChild(root, "..safe/file"), "/tmp/root/..safe/file");
});
test("loader rejects a physical symlink escape before external code loads", async () => {
    const root = await mkdtemp(join(tmpdir(), "grounded-loader-escape-"));
    try {
        await writePeerFixtures(root);
        const packageRoot = safeChild(root, "load/node_modules/test-package");
        const coreRoot = safeChild(packageRoot, "node_modules/@grounded/pi-core");
        await mkdir(coreRoot, { recursive: true });
        const script = safeChild(root, "child.mjs"), loader = safeChild(root, "fixtures/escape-loader.mjs"), record = safeChild(root, "escape-imports.jsonl");
        const external = safeChild(root, "malicious/external.mjs"), sentinel = safeChild(root, "malicious/loaded");
        await mkdir(dirname(external), { recursive: true });
        await writeFile(external, `import {writeFile} from 'node:fs/promises'; await writeFile(${JSON.stringify(sentinel)},'loaded');`);
        await symlink(external, safeChild(packageRoot, "escape.mjs"));
        await writeFile(script, `await import(${JSON.stringify(safeChild(packageRoot, "escape.mjs"))});`);
        await writeFile(record, "");
        const tsRoot = await realpath(safeChild(root, "fixtures/node_modules/typescript"));
        const ts = await realpath(safeChild(root, "fixtures/node_modules/typescript/lib/typescript.js"));
        assert.ok(withinExact(tsRoot, ts));
        await writeFile(loader, controlledLoaderSource(ts, record, await realpath(packageRoot), await realpath(coreRoot), {}, await realpath(script)));
        const loaderRoot = await realpath(safeChild(root, "fixtures"));
        assert.ok(withinExact(loaderRoot, await realpath(loader)));
        await rejected(() => command(root, root, process.execPath, ["--experimental-loader", loader, script]));
        await assert.rejects(() => lstat(sentinel));
        const records = (await readFile(record, "utf8")).trimEnd().split("\n").filter(Boolean).map(line => JSON.parse(line));
        assert.deepEqual(records, [{ category: "child-script", path: await realpath(script) }]);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("exact release verification binds digest, identity, custody, and manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "grounded-release-artifact-"));
    try {
        await mkdir(safeChild(root, "source-pack"));
        const source = await command(root, repo, "npm", ["pack", ".", "--ignore-scripts", "--json", "--pack-destination", safeChild(root, "source-pack")]);
        const packed = JSON.parse(source)[0];
        const artifactPath = safeChild(root, "received/pi-grounded-tools-0.1.0.tgz");
        await mkdir(dirname(artifactPath), { recursive: true });
        await cp(join(root, "source-pack", packed.filename), artifactPath);
        await verifyReleaseArtifact({ artifactPath, sha256: sha256(await readFile(artifactPath)), provenance: { source: "public source-pack fixture", version: "0.1.0", commit: "fixture-commit" }, temporaryRoot: root, packageName: "pi-grounded-tools", entries: ["./packages/files/index.ts", "./packages/process/index.ts", "./packages/lsp/index.ts", "./packages/dialog/index.ts", "./packages/tasks/index.ts", "./packages/notes/index.ts", "./packages/workplan/index.ts"], expectedTools: ["read", "edit", "write", "grep", "find", "fuzzy_find", "bash", "process", "lsp", "ask_user_question", "todo", "notes", "workplan"] });
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
