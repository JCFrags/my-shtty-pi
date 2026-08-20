import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { SshTransport, STRICT_SSH_ARGS, BOOTSTRAP_COMMAND } from "../src/transport.mjs";
import { decodeSingleFrame, encodeFrame } from "../src/protocol.mjs";

const target = { destination: "fixture", name: "fixture" };
function fakeSpawn(mode, capture = {}) {
  return (_binary, args, options) => {
    capture.args = args; capture.options = options;
    const child = new EventEmitter();
    child.pid = 900_000_000;
    child.exitCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killCount = 0;
    const input = [];
    child.stdin = new Writable({ write(chunk, _encoding, done) { input.push(Buffer.from(chunk)); done(); }, final(done) {
      const bytes = Buffer.concat(input);
      if (mode === "success") {
        const helperLength = bytes.readUInt32BE(0);
        const request = decodeSingleFrame(bytes.subarray(4 + helperLength));
        const response = encodeFrame({ version: 2, id: request.id, ok: true, result: { data: "a", empty: false, limitReached: false, truncation: null } }, 96 * 1024);
        process.nextTick(() => { child.stdout.end(response); child.exitCode = 0; child.emit("close", 0); });
      } else if (mode === "flood") {
        process.nextTick(() => child.stdout.write(Buffer.alloc(48 * 1024 * 1024 + 5)));
      }
      done();
    }});
    child.kill = () => {
      child.killCount++;
      if (child.exitCode === null) {
        child.exitCode = 0;
        process.nextTick(() => child.emit("close", 0));
      }
      return true;
    };
    capture.child = child;
    return child;
  };
}

test("transport uses fixed strict SSH arguments and a framed helper", async () => {
  const capture = {};
  const transport = new SshTransport("# helper", { spawn: fakeSpawn("success", capture) });
  const reply = await transport.request(target, "ls", { cwd: "/", path: ".", limit: 10 });
  assert.deepEqual({ ...reply.result }, { data: "a", empty: false, limitReached: false, truncation: null });
  assert.deepEqual(capture.args.slice(0, STRICT_SSH_ARGS.length), STRICT_SSH_ARGS);
  assert.deepEqual(capture.args.slice(-3), ["--", "fixture", BOOTSTRAP_COMMAND]);
  assert.equal(capture.options.detached, true);
});

test("output-flood cleanup is idempotent and output wins over exit zero", async () => {
  const capture = {};
  const transport = new SshTransport("# helper", { spawn: fakeSpawn("flood", capture), killGraceMs: 5 });
  await assert.rejects(() => transport.request(target, "ls", { cwd: "/", path: ".", limit: 10 }), error => error.code === "REMOTE_OUTPUT_LIMIT");
  capture.child.stdout.emit("data", Buffer.alloc(100));
  capture.child.stderr.emit("data", Buffer.alloc(100));
  assert.equal(capture.child.killCount, 1);
});

test("timeout and abort take precedence over a racing exit zero", async () => {
  const timeoutCapture = {};
  const timeoutTransport = new SshTransport("# helper", { spawn: fakeSpawn("hang", timeoutCapture), killGraceMs: 5 });
  await assert.rejects(() => timeoutTransport.request(target, "ls", { cwd: "/", path: ".", limit: 10 }, { timeoutMs: 5 }), error => error.code === "REMOTE_TIMEOUT");
  assert.equal(timeoutCapture.child.killCount, 1);

  const abortCapture = {};
  const abortTransport = new SshTransport("# helper", { spawn: fakeSpawn("hang", abortCapture), killGraceMs: 5 });
  const controller = new AbortController();
  const pending = abortTransport.request(target, "ls", { cwd: "/", path: ".", limit: 10 }, { timeoutMs: 1000, signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, error => error.code === "REMOTE_CANCELLED");
  assert.equal(abortCapture.child.killCount, 1);
});
