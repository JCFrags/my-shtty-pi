import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encodeFrame, decodeSingleFrame, validateResponse } from "../src/protocol.mjs";

const helper = fileURLToPath(new URL("../src/helper.py", import.meta.url));
let serial = 0;

async function request(operation, args, rawFrame) {
  const id = (++serial).toString(16).padStart(16, "0");
  const input = rawFrame ?? encodeFrame({ version: 2, id, operation, args });
  const child = spawn("python3", [helper], { stdio: ["pipe", "pipe", "pipe"] });
  const output = [];
  const errors = [];
  child.stdout.on("data", chunk => output.push(chunk));
  child.stderr.on("data", chunk => errors.push(chunk));
  child.stdin.end(input);
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  assert.equal(code, 0);
  assert.equal(Buffer.concat(errors).length, 0);
  return validateResponse(decodeSingleFrame(Buffer.concat(output)), id, operation);
}

test("capability negotiation is versioned and explicit", async () => {
  const result = await request("capabilities", {});
  assert.equal(result.protocol, 2);
  assert.equal(result.authorization, "remote-account");
  assert.deepEqual(result.operations, ["read", "ls", "find", "grep", "access", "readRaw", "write", "mkdir", "rollback", "exec"]);
  assert.equal(result.limits.responseBytes, 48 * 1024 * 1024);
  assert.equal(result.limits.readBytes, 50 * 1024);
  assert.equal(result.limits.readLines, 2000);
  assert.equal(result.limits.textSourceBytes, 128 * 1024 * 1024);
  assert.match(result.utilities.rg, /ripgrep/i);
  assert.match(result.utilities.fd, /fd/i);
});

test("read applies late offset at source and preserves native bounds", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-helper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lines = Array.from({ length: 5000 }, (_, index) => `${index + 1}:${"x".repeat(20)}`);
  await writeFile(join(root, "large.txt"), `${lines.join("\n")}\n`);
  const late = await request("read", { cwd: root, path: "large.txt", offset: 4000, limit: 2 });
  assert.equal(late.data, `${lines[3999]}\n${lines[4000]}`);
  assert.equal(late.totalFileLines, 5001);
  assert.equal(late.truncation.truncated, false);
  assert.equal(late.hasMoreAfterUserLimit, true);

  const many = await request("read", { cwd: root, path: "large.txt", offset: 1, limit: null });
  assert.equal(many.truncation.truncated, true);
  assert.equal(many.truncation.truncatedBy, "lines");
  assert.equal(many.truncation.outputLines, 2000);
  assert.ok(Buffer.byteLength(many.data) <= 50 * 1024);
});

test("read preserves Pi-compatible replacement decoding and NUL text", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-encoding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "invalid"), Buffer.from([0x66, 0x80, 0x0a]));
  await writeFile(join(root, "binary"), Buffer.from([0x66, 0x00, 0x0a]));
  const invalid = await request("read", { cwd: root, path: "invalid", offset: 1, limit: null });
  const binary = await request("read", { cwd: root, path: "binary", offset: 1, limit: null });
  assert.equal(invalid.data, Buffer.from([0x66, 0x80, 0x0a]).toString("utf8"));
  assert.equal(binary.data, "f\0\n");
});

test("read supports native image content bytes with a strict source bound", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-image-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await writeFile(join(root, "pixel.png"), png);
  const result = await request("read", { cwd: root, path: "pixel.png", offset: 999, limit: 1 });
  assert.equal(result.kind, "image");
  assert.equal(result.mimeType, "image/png");
  assert.deepEqual(Buffer.from(result.data, "base64"), png);
});

test("late line offsets pass beyond 64 MiB and text scans stop at 128 MiB", { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-large-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "over-64m.txt");
  await writeFile(file, Buffer.concat([Buffer.alloc(65 * 1024 * 1024, 0x78), Buffer.from("\ntail\n")]));
  const result = await request("read", { cwd: root, path: file, offset: 2, limit: 1 });
  assert.equal(result.data, "tail");
  assert.equal(result.totalFileLines, 3);
  assert.equal(result.hasMoreAfterUserLimit, true);

  const overBound = join(root, "over-128m.txt");
  await writeFile(overBound, "text\n");
  await truncate(overBound, 128 * 1024 * 1024 + 1);
  await assert.rejects(
    request("read", { cwd: root, path: overBound, offset: 2, limit: 1 }),
    error => error?.code === "REMOTE_OUTPUT_LIMIT" && /bounded scan limit/.test(error.safeMessage),
  );
});

test("remote account authorization follows readable symlinks without a containment claim", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-account-"));
  const other = await mkdtemp(join(tmpdir(), "pi-remote-account-target-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); });
  await writeFile(join(other, "allowed.txt"), "account-authorized\n");
  await symlink(join(other, "allowed.txt"), join(root, "link"));
  const result = await request("read", { cwd: root, path: "link", offset: 1, limit: null });
  assert.equal(result.data, "account-authorized\n");
});

test("ls, find, and grep use structured bounded operations and gitignore behavior", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-search-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(join(root, "ignored.txt"), "needle\n");
  await writeFile(join(root, "src", "a.txt"), "one\nneedle\nthree\n");
  const listed = await request("ls", { cwd: root, path: ".", limit: 500 });
  assert.ok(listed.data.split("\n").includes("src/"));
  const found = await request("find", { cwd: root, path: ".", pattern: "**/*.txt", limit: 1000 });
  assert.equal(found.data, "src/a.txt");
  const grep = await request("grep", { cwd: root, path: ".", pattern: "needle", glob: null, ignoreCase: false, literal: true, context: 1, limit: 100 });
  assert.match(grep.data, /src\/a\.txt:2: needle/);
  assert.doesNotMatch(grep.data, /ignored/);
  assert.equal(grep.matchLimitReached, false);
});

test("write, raw read, command execution, and rollback are bounded and reversible", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-native-ssh-mutation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "cycle.txt");
  const first = Buffer.from("first\n");
  const second = Buffer.from("second\n");
  const created = await request("write", { cwd: root, path, data: first.toString("base64"), maxBytes: 1024 });
  assert.equal(created.created, true);
  assert.deepEqual(Buffer.from((await request("readRaw", { cwd: root, path, maxBytes: 1024 })).data, "base64"), first);
  const replaced = await request("write", { cwd: root, path, data: second.toString("base64"), maxBytes: 1024 });
  assert.equal(replaced.created, false);
  assert.equal((await request("rollback", { cwd: root, path })).action, "restored");
  assert.deepEqual(Buffer.from((await request("readRaw", { cwd: root, path, maxBytes: 1024 })).data, "base64"), first);
  await assert.rejects(request("rollback", { cwd: root, path }), error => error.code === "REMOTE_NOT_FOUND");
  const executed = await request("exec", { cwd: root, command: "printf out; printf err >&2; exit 7", timeoutMs: 1000 });
  assert.equal(Buffer.from(executed.stdout, "base64").toString(), "out");
  assert.equal(Buffer.from(executed.stderr, "base64").toString(), "err");
  assert.equal(executed.exitCode, 7);
});

test("malformed, duplicate, trailing, and excessive request frames fail closed", async () => {
  const bodies = [
    Buffer.from('{"version":2,"version":2,"id":"0000000000000001","operation":"capabilities","args":{}}'),
    Buffer.from('{"version":2,"id":"0000000000000001","operation":"capabilities","args":{}}x'),
    Buffer.from([0x7b, 0x80, 0x7d]),
  ];
  for (const body of bodies) {
    const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
    const child = spawn("python3", [helper], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = []; child.stdout.on("data", chunk => chunks.push(chunk)); child.stdin.end(Buffer.concat([header, body]));
    await new Promise(resolve => child.on("close", resolve));
    const value = decodeSingleFrame(Buffer.concat(chunks));
    assert.equal(value.ok, false);
    assert.equal(value.error.code, "PROTOCOL_ERROR");
  }
  const excessive = Buffer.alloc(4); excessive.writeUInt32BE(12 * 1024 * 1024 + 1);
  const child = spawn("python3", [helper], { stdio: ["pipe", "pipe", "pipe"] });
  const chunks = []; child.stdout.on("data", chunk => chunks.push(chunk)); child.stdin.end(excessive);
  await new Promise(resolve => child.on("close", resolve));
  assert.equal(decodeSingleFrame(Buffer.concat(chunks)).error.code, "REMOTE_OUTPUT_LIMIT");
});
