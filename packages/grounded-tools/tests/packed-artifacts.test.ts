import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import test from "node:test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const COMMAND_TIMEOUT_MS = 30_000;

const FEATURE_ENTRIES = {
  notes: ["package/LICENSE", "package/README.md", "package/index.ts", "package/package.json"],
  workplan: ["package/LICENSE", "package/README.md", "package/index.ts", "package/package.json"],
} as const;
const CORE_ENTRIES = [
  "LICENSE", "README.md", "package.json", "src/anchors.ts", "src/atomic.ts", "src/exec.ts",
  "src/lsp-client.ts", "src/notes.ts", "src/output.ts", "src/paths.ts", "src/process-manager.ts",
  "src/pty_bridge.py", "src/search.ts", "src/state.ts", "src/syntax.ts", "src/tasks.ts", "src/text.ts", "src/workplan.ts",
] as const;
const UMBRELLA_ENTRIES = [
  "package/LICENSE", "package/README.md", "package/package.json",
  "package/docs/artifacts.md", "package/docs/benchmark.md", "package/docs/security.md",
  "package/packages/core/LICENSE", "package/packages/core/README.md", "package/packages/core/package.json",
  "package/packages/core/src/anchors.ts", "package/packages/core/src/atomic.ts", "package/packages/core/src/exec.ts",
  "package/packages/core/src/lsp-client.ts", "package/packages/core/src/notes.ts", "package/packages/core/src/output.ts",
  "package/packages/core/src/paths.ts", "package/packages/core/src/process-manager.ts", "package/packages/core/src/pty_bridge.py", "package/packages/core/src/search.ts",
  "package/packages/core/src/state.ts", "package/packages/core/src/syntax.ts", "package/packages/core/src/tasks.ts",
  "package/packages/core/src/text.ts", "package/packages/core/src/workplan.ts",
  ...["dialog", "files", "lsp", "notes", "process", "tasks", "workplan"].flatMap((name) => [
    `package/packages/${name}/LICENSE`, `package/packages/${name}/README.md`,
    `package/packages/${name}/index.ts`, `package/packages/${name}/package.json`,
  ]),
  ...CORE_ENTRIES.map((path) => `package/node_modules/@grounded/pi-core/${path}`),
].sort();
const FORBIDDEN_ENTRY = /(?:^|\/)(?:tests?|test-fixtures?|\.git|node_modules\/(?:@earendil-works|typebox)|rollback|migration|backup|inventory|\.pi)(?:\/|$)|(?:goal|workplan-export)/i;

function childEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    HOME: root,
    TMPDIR: root,
    npm_config_cache: join(root, "npm-cache"),
    npm_config_userconfig: join(root, ".npmrc"),
    npm_config_global: "false",
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_registry: "http://127.0.0.1:9",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    NO_COLOR: "1",
  };
}

function safeChild(root: string, child: string): string {
  const base = resolve(root);
  const target = resolve(base, child);
  const remainder = relative(base, target);
  if (remainder === "" || remainder.startsWith(`..${relative(".", ".")}`) || isAbsolute(remainder)) {
    throw new Error(`Path escapes temporary root: ${child}`);
  }
  return target;
}

async function command(environmentRoot: string, cwd: string, executable: string, args: string[]): Promise<string> {
  return await new Promise((resolveOutput, reject) => {
    const child = spawn(executable, args, { cwd, env: childEnvironment(environmentRoot), stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) { settled = true; reject(new Error(`${executable} timed out`)); }
    }, COMMAND_TIMEOUT_MS);
    timer.unref();
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) child.kill("SIGKILL");
      else target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => { clearTimeout(timer); if (!settled) { settled = true; reject(error); } });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) reject(new Error(`${executable} failed (${code ?? signal ?? "unknown"})`));
      else resolveOutput(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

async function archiveEntries(root: string, archive: string): Promise<string[]> {
  const output = await command(root, root, "tar", ["-tzf", archive]);
  return output.trim().split("\n").filter(Boolean).sort();
}

async function packSource(environmentRoot: string, sourceRoot: string, destination: string): Promise<{ archive: string; metadata: any }> {
  await mkdir(destination, { recursive: true });
  const output = await command(environmentRoot, sourceRoot, "npm", ["pack", ".", "--ignore-scripts", "--json", "--pack-destination", destination]);
  const metadata = JSON.parse(output)[0];
  return { archive: join(destination, metadata.filename), metadata };
}

async function assertNoSymlinks(root: string): Promise<void> {
  for (const name of await readdir(root)) {
    const path = join(root, name);
    const info = await lstat(path);
    assert.equal(info.isSymbolicLink(), false, path);
    if (info.isDirectory()) await assertNoSymlinks(path);
  }
}

async function copyLockedTypeScript(root: string): Promise<void> {
  const lock = JSON.parse(await readFile(join(repo, "package-lock.json"), "utf8"));
  const locked = lock.packages?.["node_modules/typescript"];
  assert.ok(locked?.version, "typescript must be locked locally");
  const sourceManifest = require.resolve("typescript/package.json");
  const destination = safeChild(root, "fixtures/node_modules/typescript");
  await cp(dirname(sourceManifest), destination, { recursive: true });
  await assertNoSymlinks(destination);
  const copied = JSON.parse(await readFile(join(destination, "package.json"), "utf8"));
  assert.equal(copied.name, "typescript");
  assert.equal(copied.version, locked.version);
  await writeFile(safeChild(root, "fixtures/loader-identity.json"), JSON.stringify({ name: copied.name, version: copied.version, resolved: locked.resolved, integrity: locked.integrity ?? null }));
}

async function writePeerFixtures(root: string): Promise<void> {
  const fixtures = safeChild(root, "artifact/node_modules");
  const fixtureRoot = safeChild(root, "fixtures");
  await mkdir(fixtureRoot, { recursive: true });
  await copyLockedTypeScript(root);
  const packages: Record<string, string> = {
    "@earendil-works/pi-ai": "export const StringEnum = (values) => ({ type: 'string', values });\n",
    "@earendil-works/pi-coding-agent": "export const CONFIG_DIR_NAME = '.pi'; export const getAgentDir = () => { throw new Error('controlled fixture forbids agent-directory access'); }; export const DEFAULT_MAX_BYTES = 1024 * 1024; export const DEFAULT_MAX_LINES = 2000; export const formatSize = (value) => `${value} bytes`; export const truncateHead = (value, limits) => ({ content: value, truncated: false, outputLines: value.split('\\n').length, totalLines: value.split('\\n').length, outputBytes: Buffer.byteLength(value), totalBytes: Buffer.byteLength(value) }); export const truncateTail = truncateHead; export const createReadTool = () => ({ execute: async () => ({ content: [{ type: 'text', text: '' }] }) }); export const generateDiffString = () => ({ diff: '', firstChangedLine: 1 }); export const generateUnifiedPatch = () => ''; export const withFileMutationQueue = (_path, fn) => fn();\n",
    "@earendil-works/pi-tui": "export const CURSOR_MARKER = ''; export class Editor { constructor() {} set focused(value) {} setText() {} handleInput() {} invalidate() {} render() { return []; } } export class Text { constructor() {} } export const Key = { escape: '', up: '', down: '', enter: '', ctrl: () => '' }; export const matchesKey = () => false; export const truncateToWidth = (value) => value; export const wrapTextWithAnsi = (value) => [value];\n",
    typebox: "export const Type = new Proxy({}, { get: () => (...args) => ({ args }) });\n",
  };
  for (const [name, source] of Object.entries(packages)) {
    const packageRoot = join(fixtures, ...name.split("/"));
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name, version: "0.0.0", type: "module", exports: { ".": "./index.js", "./package.json": "./package.json" } }));
    await writeFile(join(packageRoot, "index.js"), source);
  }
}

async function cleanLoad(
  root: string,
  archive: string,
  packageName: string,
  entries: string[],
  expectedTools: string[],
  stateTool?: "notes" | "workplan",
): Promise<void> {
  const packageRoot = safeChild(root, join("artifact/node_modules", ...packageName.split("/")));
  await mkdir(packageRoot, { recursive: true });
  await command(root, root, "tar", ["-xzf", archive, "-C", packageRoot, "--strip-components=1"]);
  await writePeerFixtures(root);
  const script = safeChild(root, "load.mjs");
  await writeFile(script, `
import { createRequire } from 'node:module';
const root = ${JSON.stringify(packageRoot)};
const entries = ${JSON.stringify(entries)};
const tools = [];
const registered = new Map();
const require = createRequire(root + '/package.json');
for (const entry of entries) {
  const factory = (await import(root + '/' + entry.replace(/^\\.\\//, ''))).default;
  factory({ registerTool(value) { tools.push(value.name); registered.set(value.name, value); }, registerCommand() {}, on() {}, appendEntry() {}, getActiveTools() { return []; }, setActiveTools() {}, getAllTools() { return []; } });
}
const resolutions = { core: require.resolve('@grounded/pi-core/state'), peers: Object.fromEntries(['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox'].map((name) => [name, require.resolve(name)])) };
let stateRead = null;
if (${JSON.stringify(stateTool)} === 'notes') { const result = await registered.get('notes').execute('m', { action: 'add', body: 'artifact fixture' }); stateRead = result.details.result.id; }
if (${JSON.stringify(stateTool)} === 'workplan') { const result = await registered.get('workplan').execute('m', { action: 'create', content: { title: 'Artifact', objective: 'Fixture', approach: 'Offline' } }); stateRead = result.details.result.planId; }
console.log(JSON.stringify({ tools, resolutions, stateRead }));
`);
  const loader = safeChild(root, "fixtures/loader.mjs");
  await writeFile(loader, `import ts from ${JSON.stringify(safeChild(root, "fixtures/node_modules/typescript/lib/typescript.js"))};\nimport { readFile } from 'node:fs/promises';\nexport async function load(url, context, nextLoad) { if (!url.endsWith('.ts')) return nextLoad(url, context); const source = await readFile(new URL(url), 'utf8'); return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText }; }\n`);
  const output = JSON.parse((await command(root, root, process.execPath, ["--experimental-loader", loader, script])).trim());
  assert.deepEqual(output.tools, expectedTools);
  for (const value of [output.resolutions.core, ...Object.values(output.resolutions.peers)]) {
    assert.ok(value.startsWith(resolve(root) + "/"), value);
    assert.equal(value.includes(repo), false);
  }
  if (stateTool) assert.equal(output.stateRead, stateTool === "notes" ? "N1" : "WP1");
}

export async function verifyReleaseArtifact(input: {
  artifactPath: string;
  sha256: string;
  provenance: { source: string; version: string; commit: string };
  temporaryRoot: string;
  packageName: string;
  entries: string[];
  expectedTools: string[];
}): Promise<void> {
  const root = resolve(input.temporaryRoot);
  assert.match(input.sha256, /^[0-9a-f]{64}$/);
  assert.ok(input.provenance.source && input.provenance.version && input.provenance.commit);
  const bytes = await readFile(input.artifactPath);
  assert.equal(sha256(bytes), input.sha256);
  const extractionRoot = safeChild(root, "artifact");
  await mkdir(extractionRoot, { recursive: true });
  const entries = await archiveEntries(root, input.artifactPath);
  assert.deepEqual(entries, UMBRELLA_ENTRIES);
  await cleanLoad(root, input.artifactPath, input.packageName, input.entries, input.expectedTools);
}

test("source packs use reviewed payloads, forbidden-path checks, and no lifecycle scripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "grounded-source-pack-"));
  try {
    const destination = safeChild(root, "archives");
    const packed = await packSource(root, repo, destination);
    assert.deepEqual(await archiveEntries(root, packed.archive), UMBRELLA_ENTRIES);
    const entries = await archiveEntries(root, packed.archive);
    assert.equal(entries.some((entry) => FORBIDDEN_ENTRY.test(entry)), false);
    const manifest = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
    assert.equal(manifest.scripts?.postinstall, undefined);
    assert.equal(manifest.scripts?.prepare, undefined);
    await cleanLoad(root, packed.archive, "pi-grounded-tools", manifest.pi.extensions, ["read", "edit", "write", "grep", "find", "fuzzy_find", "bash", "process", "lsp", "ask_user_question", "todo", "notes", "workplan"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("feature source packs keep bundled core and clean-load only controlled fixtures", async () => {
  for (const name of ["notes", "workplan"] as const) {
    const root = await mkdtemp(join(tmpdir(), `grounded-${name}-pack-`));
    try {
      const stage = safeChild(root, "stage");
      await mkdir(stage);
      await cp(join(repo, "packages", name), stage, { recursive: true });
      await mkdir(safeChild(root, "stage/node_modules/@grounded"), { recursive: true });
      await cp(join(repo, "packages", "core"), safeChild(root, "stage/node_modules/@grounded/pi-core"), { recursive: true });
      const packed = await packSource(root, stage, safeChild(root, "archives"));
      assert.deepEqual(packed.metadata.bundled, ["@grounded/pi-core"]);
      assert.deepEqual(await archiveEntries(root, packed.archive), [...FEATURE_ENTRIES[name], ...CORE_ENTRIES.map((path) => `package/node_modules/@grounded/pi-core/${path}`)].sort());
      await cleanLoad(root, packed.archive, `@grounded/pi-${name}`, ["./index.ts"], [name], name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("exact release verification requires a supplied artifact, digest, and provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "grounded-release-artifact-"));
  try {
    const packed = await packSource(root, repo, safeChild(root, "source-pack"));
    const artifactPath = join(root, "received", "pi-grounded-tools-0.1.0.tgz");
    await mkdir(dirname(artifactPath), { recursive: true });
    await cp(packed.archive, artifactPath);
    await verifyReleaseArtifact({
      artifactPath,
      sha256: sha256(await readFile(artifactPath)),
      provenance: { source: "public source-pack fixture", version: "0.1.0", commit: "fixture-commit" },
      temporaryRoot: root,
      packageName: "pi-grounded-tools",
      entries: ["./packages/files/index.ts", "./packages/process/index.ts", "./packages/lsp/index.ts", "./packages/dialog/index.ts", "./packages/tasks/index.ts", "./packages/notes/index.ts", "./packages/workplan/index.ts"],
      expectedTools: ["read", "edit", "write", "grep", "find", "fuzzy_find", "bash", "process", "lsp", "ask_user_question", "todo", "notes", "workplan"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
