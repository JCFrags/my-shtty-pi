import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  NativeSshSessionProvider,
  SessionFrameDecoder,
  SESSION_BOOTSTRAP_COMMAND,
  SESSION_PROVIDER_READY_EVENT,
  SESSION_PROVIDER_REGISTER_EVENT,
  registerNativeSshSessionProvider,
} from "../src/session-provider.mjs";
import { STRICT_SSH_ARGS } from "../src/transport.mjs";

const helper = await readFile(new URL("../src/session_helper.py", import.meta.url), "utf8");
const bootstrap = SESSION_BOOTSTRAP_COMMAND.slice("exec python3 -c '".length, -1);
const config = { targets: { fixture: { name: "fixture", destination: "configured-destination" } } };

function request(overrides = {}) {
  return {
    cwd: "/tmp",
    env: {},
    pty: false,
    target: "fixture",
    openTimeoutMs: 2000,
    commandTimeoutMs: 2000,
    idleTimeoutMs: 0,
    closeTimeoutMs: 300,
    ...overrides,
  };
}

function localSpawn(capture) {
  return (binary, args, options) => {
    capture.calls++;
    capture.binary = binary;
    capture.args = args;
    const child = spawn("python3", ["-c", bootstrap], options);
    capture.child = child;
    return child;
  };
}

function frame(body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}

test("provider exposes the exact Grounded contract and fixed strict SSH argv", async (t) => {
  const capture = { calls: 0 };
  const provider = new NativeSshSessionProvider(helper, config, { spawn: localSpawn(capture), sshBinary: "/test/ssh" });
  assert.deepEqual(provider.capabilities(), { backend: "ssh", providerId: "native-ssh-v1", protocolVersion: 1, pty: false, input: false });
  const handle = await provider.open(request());
  t.after(() => handle.close());
  assert.equal(capture.calls, 1);
  assert.equal(capture.binary, "/test/ssh");
  assert.deepEqual(capture.args.slice(0, STRICT_SSH_ARGS.length), STRICT_SSH_ARGS);
  assert.deepEqual(capture.args.slice(-3), ["--", "configured-destination", SESSION_BOOTSTRAP_COMMAND]);
  assert.equal(capture.child.spawnargs.includes("fixture"), false);

  await assert.rejects(provider.open(request()), (error) => error.code === "SESSION_LIMIT");
});

test("missing and unknown targets, relative cwd, and PTY fail before any spawn", async () => {
  const capture = { calls: 0 };
  const provider = new NativeSshSessionProvider(helper, config, { spawn: localSpawn(capture) });
  await assert.rejects(provider.open(request({ target: undefined })), (error) => error.code === "SESSION_TARGET_INVALID");
  await assert.rejects(provider.open(request({ target: "configured-destination" })), (error) => error.code === "SESSION_TARGET_INVALID");
  await assert.rejects(provider.open(request({ cwd: "relative" })), (error) => error.code === "SESSION_CWD_INVALID");
  await assert.rejects(provider.open(request({ pty: true })), (error) => error.code === "SESSION_PTY_UNAVAILABLE");
  assert.equal(capture.calls, 0);
});

test("first-target authorization fails closed before spawn and is cached only after acceptance", async () => {
  const deniedCapture = { calls: 0 };
  const denied = new NativeSshSessionProvider(helper, config, {
    spawn: localSpawn(deniedCapture),
    authorize: async () => { const error = new Error("confirmation required"); error.code = "SESSION_CONFIRMATION_REQUIRED"; throw error; },
  });
  await assert.rejects(denied.open(request()), (error) => error.code === "SESSION_CONFIRMATION_REQUIRED");
  assert.equal(deniedCapture.calls, 0);

  const acceptedCapture = { calls: 0 };
  let authorizations = 0;
  const accepted = new NativeSshSessionProvider(helper, config, {
    spawn: localSpawn(acceptedCapture),
    authorize: async (target, value) => { authorizations++; assert.equal(target.displayName, undefined); assert.equal(value.cwd, "/tmp"); },
  });
  const first = await accepted.open(request());
  await first.close();
  const second = await accepted.open(request());
  await second.close();
  assert.equal(authorizations, 1);
  assert.equal(acceptedCapture.calls, 2);
});

test("provider registration supports both extension load orders", () => {
  const provider = { id: "native-ssh-v1", backend: "ssh", protocolVersion: 1 };

  const groundedFirst = new EventEmitter();
  let eventProvider;
  groundedFirst.on(SESSION_PROVIDER_REGISTER_EVENT, (event) => { eventProvider = event.provider; });
  registerNativeSshSessionProvider({ events: groundedFirst }, provider);
  assert.equal(eventProvider, provider);

  const nativeFirst = new EventEmitter();
  const registration = registerNativeSshSessionProvider({ events: nativeFirst }, provider);
  let calls = 0;
  nativeFirst.emit(SESSION_PROVIDER_READY_EVENT, { protocolVersion: 1, register(value) { calls++; assert.equal(value, provider); } });
  nativeFirst.emit(SESSION_PROVIDER_READY_EVENT, { protocolVersion: 1, register() { calls++; } });
  assert.equal(calls, 1);
  assert.equal(registration.isRegistered(), true);
});

test("incremental decoder rejects duplicate fields, bad UTF-8, excessive lengths, and truncation", () => {
  const good = frame(JSON.stringify({ version: 1, type: "ready" }));
  const decoder = new SessionFrameDecoder();
  assert.deepEqual(decoder.push(good.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(good.subarray(2, 7)), []);
  assert.deepEqual({ ...decoder.push(good.subarray(7))[0] }, { version: 1, type: "ready" });
  decoder.finish();

  assert.throws(() => new SessionFrameDecoder().push(frame('{"version":1,"version":1}')), (error) => error.code === "PROTOCOL_ERROR");
  assert.throws(() => new SessionFrameDecoder().push(frame(Buffer.from([0x7b, 0x80, 0x7d]))), (error) => error.code === "PROTOCOL_ERROR");
  const excessive = Buffer.alloc(4); excessive.writeUInt32BE(4 * 1024 * 1024 + 1);
  assert.throws(() => new SessionFrameDecoder().push(excessive), (error) => error.code === "SESSION_FRAME_LIMIT");
  const truncated = new SessionFrameDecoder(); truncated.push(Buffer.from([0, 0, 0, 10, 0]));
  assert.throws(() => truncated.finish(), (error) => error.code === "SESSION_PROTOCOL_ERROR");
});

test("running and idle child disconnects reject or close without a local fallback spawn", async () => {
  const runningCapture = { calls: 0 };
  const runningProvider = new NativeSshSessionProvider(helper, config, { spawn: localSpawn(runningCapture) });
  const running = await runningProvider.open(request());
  const pending = running.execute("sleep 30");
  process.kill(-runningCapture.child.pid, "SIGTERM");
  await assert.rejects(pending, (error) => ["SESSION_DISCONNECTED", "SESSION_TAINTED"].includes(error.code));
  await running.whenClosed();
  assert.equal(runningCapture.calls, 1);
  assert.equal(running.status().state, "closed");

  const idleCapture = { calls: 0 };
  const idleProvider = new NativeSshSessionProvider(helper, config, { spawn: localSpawn(idleCapture) });
  const idle = await idleProvider.open(request());
  process.kill(-idleCapture.child.pid, "SIGTERM");
  await idle.whenClosed();
  assert.equal(idleCapture.calls, 1);
  assert.equal(idle.status().state, "closed");
});
