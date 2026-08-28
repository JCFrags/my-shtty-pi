import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { link, mkdir, readFile, mkdtemp, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NativeSshSessionProvider,
  SESSION_BOOTSTRAP_COMMAND,
} from "../src/session-provider.mjs";
import { decodeSingleFrame, encodeFrame, validateResponse } from "../src/protocol.mjs";

const helper = await readFile(new URL("../src/session_helper.py", import.meta.url), "utf8");
const bootstrap = SESSION_BOOTSTRAP_COMMAND.slice("exec python3 -c '".length, -1);
const config = { targets: { fixture: { name: "fixture", destination: "fixture" } } };
const oneShotHelper = fileURLToPath(new URL("../src/helper.py", import.meta.url));
let oneShotSerial = 0;

async function oneShotRequest(operation, args) {
  const id = (++oneShotSerial).toString(16).padStart(16, "0");
  const child = spawn("python3", [oneShotHelper], { stdio: ["pipe", "pipe", "pipe"] });
  const output = [];
  const errors = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => errors.push(chunk));
  child.stdin.end(encodeFrame({ version: 2, id, operation, args }));
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(code, 0);
  assert.equal(Buffer.concat(errors).length, 0);
  return validateResponse(decodeSingleFrame(Buffer.concat(output)), id, operation);
}

function localSpawn(capture = {}) {
  return (_binary, args, options) => {
    capture.calls = (capture.calls ?? 0) + 1;
    capture.args = args;
    const child = spawn("python3", ["-c", bootstrap], options);
    capture.child = child;
    return child;
  };
}

function request(cwd, options = {}) {
  return {
    cwd,
    env: { SHOULD_NOT_REACH_REMOTE: "secret" },
    pty: false,
    target: "fixture",
    openTimeoutMs: 3000,
    commandTimeoutMs: 3000,
    idleTimeoutMs: 0,
    closeTimeoutMs: 500,
    ...options,
  };
}

function text(result, stream) {
  return result.chunks
    .filter((chunk) => chunk.stream === stream)
    .map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString("utf8"))
    .join("");
}

async function waitForExit(pid) {
  for (let index = 0; index < 50; index++) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") return true; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

test("local no-network harness preserves shell state and exact streams over one child", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-native-ssh-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capture = {};
  const provider = new NativeSshSessionProvider(helper, config, { spawn: localSpawn(capture) });
  const handle = await provider.open(request(root));
  t.after(() => handle.close());

  const first = await handle.execute("export SESSION_VALUE=kept; session_function(){ printf function; }; cd /tmp; printf out; printf err >&2; false");
  assert.equal(first.exitCode, 1);
  assert.equal(first.cwd, "/tmp");
  assert.equal(text(first, "stdout"), "out");
  assert.equal(text(first, "stderr"), "err");

  const second = await handle.execute('printf "%s:" "$SESSION_VALUE"; session_function; printf ":%s" "$SHOULD_NOT_REACH_REMOTE"');
  assert.equal(second.exitCode, 0);
  assert.equal(text(second, "stdout"), "kept:function:");
  assert.equal(text(second, "stderr"), "");
  assert.equal(second.cwd, "/tmp");
  assert.equal(capture.calls, 1);
  assert.equal(handle.status().state, "idle");

  const mode = (await stat(second.logPath)).mode & 0o777;
  assert.equal(mode, 0o600);
  const log = await readFile(second.logPath, "utf8");
  assert.match(log, /"stream":"stdout"/);
  assert.doesNotMatch(log, /SESSION_VALUE|kept:function/);
});

test("cancellation and timeout settle truthfully and keep a valid shell reusable", async (t) => {
  const provider = new NativeSshSessionProvider(helper, config, { spawn: localSpawn(), cancelGraceMs: 2000 });
  const handle = await provider.open(request("/tmp", { commandTimeoutMs: 5000 }));
  t.after(() => handle.close());

  const controller = new AbortController();
  const cancelled = handle.execute("sleep 30", { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const cancelledResult = await cancelled;
  assert.equal(cancelledResult.cancelled, true);
  assert.equal(cancelledResult.timedOut, false);
  assert.equal((await handle.execute("printf reusable")).exitCode, 0);

  const timedOut = await handle.execute("sleep 30", { timeoutMs: 50 });
  assert.equal(timedOut.cancelled, true);
  assert.equal(timedOut.timedOut, true);
  assert.equal(text(await handle.execute("printf still-reusable"), "stdout"), "still-reusable");
});

test("close kills descendants in the persistent remote shell process group", async () => {
  const provider = new NativeSshSessionProvider(helper, config, { spawn: localSpawn(), killGraceMs: 50 });
  const handle = await provider.open(request("/tmp"));
  const result = await handle.execute("sleep 30 & printf %s $!");
  const descendant = Number(text(result, "stdout"));
  assert.ok(Number.isSafeInteger(descendant) && descendant > 1);
  process.kill(descendant, 0);
  await handle.close();
  assert.equal(await waitForExit(descendant), true);
  assert.equal(handle.status().state, "closed");
});

test("file resource resolves, reads, commits, discloses hard links, and shares one-shot rollback sidecars", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-native-ssh-resource-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "sample.txt");
  await writeFile(path, "old\n", { mode: 0o640 });
  await link(path, join(root, "linked.txt"));

  const provider = new NativeSshSessionProvider(helper, config, { spawn: localSpawn() });
  const handle = await provider.open(request(root));
  t.after(() => handle.close());
  const resource = handle.fileResource;

  assert.equal(await resource.resolve("sample.txt"), path);
  const before = await resource.read("sample.txt");
  assert.equal(Buffer.from(before.dataBase64, "base64").toString("utf8"), "old\n");
  assert.equal(before.mode, 0o640);
  assert.equal(before.hardLinks, 2);

  const committed = await resource.commit({
    path: "sample.txt",
    canonicalPath: before.canonicalPath,
    dataBase64: Buffer.from("new\n").toString("base64"),
    expectedExists: true,
    expectedRawDigest: before.rawDigest,
  });
  assert.equal(committed.atomic, true);
  assert.equal(committed.created, false);
  assert.equal(committed.preservedHardLinks, false);
  assert.equal(committed.hardLinksBefore, 2);
  assert.equal(committed.rollbackAvailable, true);
  assert.equal(await readFile(path, "utf8"), "new\n");
  assert.equal(await readFile(join(root, "linked.txt"), "utf8"), "old\n");
  assert.equal((await stat(path)).mode & 0o777, 0o640);

  const rollback = await oneShotRequest("rollback", { cwd: root, path });
  assert.equal(rollback.action, "restored");
  assert.equal(await readFile(path, "utf8"), "old\n");
  assert.equal(handle.status().state, "idle");
});

test("file resource detects stale commits and remains reusable after resource errors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-native-ssh-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "sample.txt");
  await writeFile(path, "first\n");
  const provider = new NativeSshSessionProvider(helper, config, { spawn: localSpawn() });
  const handle = await provider.open(request(root));
  t.after(() => handle.close());
  const resource = handle.fileResource;

  const snapshot = await resource.read("sample.txt");
  await writeFile(path, "changed elsewhere\n");
  await assert.rejects(resource.commit({
    path: "sample.txt",
    canonicalPath: snapshot.canonicalPath,
    dataBase64: Buffer.from("candidate\n").toString("base64"),
    expectedExists: true,
    expectedRawDigest: snapshot.rawDigest,
  }), (error) => error.code === "SESSION_FILE_CONFLICT");
  assert.equal(await readFile(path, "utf8"), "changed elsewhere\n");

  const missing = await resource.read("created.txt", { allowMissing: true });
  assert.equal(missing.exists, false);
  const created = await resource.commit({
    path: "created.txt",
    canonicalPath: missing.canonicalPath,
    dataBase64: Buffer.from("created\n").toString("base64"),
    expectedExists: false,
  });
  assert.equal(created.created, true);
  assert.equal(await readFile(join(root, "created.txt"), "utf8"), "created\n");
  assert.equal((await oneShotRequest("rollback", { cwd: root, path: "created.txt" })).action, "removed-created-file");
  await assert.rejects(resource.read("created.txt"), (error) => error.code === "REMOTE_NOT_FOUND");
  assert.equal(text(await handle.execute("printf reusable"), "stdout"), "reusable");
});

test("file resource searches exact text and file inventory from the persistent session cwd", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-native-ssh-search-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "child", "nested"), { recursive: true });
  await writeFile(join(root, "child", "a.txt"), "one\nneedle\nthree\n");
  await writeFile(join(root, "child", "b.md"), "needle markdown\n");
  await writeFile(join(root, "child", "ignored.txt"), "needle ignored\n");
  await writeFile(join(root, "child", "nested", "c.txt"), "nested\n");
  await writeFile(join(root, "child", ".gitignore"), "ignored.txt\n");

  const provider = new NativeSshSessionProvider(helper, config, { spawn: localSpawn() });
  const handle = await provider.open(request(root));
  t.after(() => handle.close());
  await handle.execute("cd child");
  const resource = handle.fileResource;

  const textHits = await resource.searchText({ query: "needle", path: ".", contextLines: 1 });
  assert.deepEqual(textHits.hits.map((hit) => [hit.path, hit.line, hit.byteColumn]), [["a.txt", 2, 1], ["b.md", 1, 1]]);
  assert.match(textHits.hits[0].snippet, /1: one\n2: needle\n3: three/);
  const globbed = await resource.searchText({ query: "markdown", path: ".", fileGlob: "*.md" });
  assert.deepEqual(globbed.hits.map((hit) => hit.path), ["b.md"]);
  const inventory = await resource.searchFiles({ path: "." });
  assert.deepEqual(inventory.hits.map((hit) => [hit.path, hit.kind]), [
    [".gitignore", "file"],
    ["a.txt", "file"],
    ["b.md", "file"],
    ["nested/", "directory"],
    ["nested/c.txt", "file"],
  ]);
  assert.equal(handle.status().cwd, join(root, "child"));
});

test("resource timeout fails closed and closes the session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-native-ssh-resource-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "rg"), "#!/bin/sh\nsleep 30\n");
  await chmod(join(bin, "rg"), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    const provider = new NativeSshSessionProvider(helper, config, { spawn: localSpawn(), resourceTimeoutMs: 50, killGraceMs: 50 });
    const handle = await provider.open(request(root));
    await assert.rejects(
      handle.fileResource.searchText({ query: "needle", path: "." }),
      (error) => error.code === "SESSION_RESOURCE_TIMEOUT",
    );
    await handle.whenClosed();
    assert.equal(handle.status().state, "closed");
  } finally {
    process.env.PATH = previousPath;
  }
});

test("aborting an active resource operation fails closed and closes the session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-native-ssh-resource-abort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "rg"), "#!/bin/sh\nsleep 30\n");
  await chmod(join(bin, "rg"), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    const provider = new NativeSshSessionProvider(helper, config, { spawn: localSpawn(), killGraceMs: 50 });
    const handle = await provider.open(request(root));
    const controller = new AbortController();
    const pending = handle.fileResource.searchText({ query: "needle", path: "." }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, (error) => error.code === "SESSION_TAINTED");
    await handle.whenClosed();
    assert.equal(handle.status().state, "closed");
  } finally {
    process.env.PATH = previousPath;
  }
});
