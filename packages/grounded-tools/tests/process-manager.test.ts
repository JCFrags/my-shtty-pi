import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { ProcessManager } from "@grounded/pi-core/process-manager";

const cwd = process.cwd();

test("process manager captures exact output and complete logs", async () => {
  const manager = new ProcessManager();
  const processInfo = await manager.start({ command: "printf 'alpha\\nbeta\\n'", cwd, env: process.env });
  await manager.wait(processInfo.id);
  const drained = manager.drain(processInfo.id);
  assert.equal(drained.output, "alpha\nbeta\n");
  assert.equal(await readFile(processInfo.logPath, "utf8"), drained.output);
  assert.equal((await stat(processInfo.logPath)).mode & 0o777, 0o600);
  assert.equal(manager.get(processInfo.id)?.exitCode, 0);
});

test("process timeouts escalate when a command ignores SIGTERM", async () => {
  const manager = new ProcessManager();
  const session = await manager.start({
    command: "trap '' TERM; while :; do sleep 1; done",
    cwd,
    env: process.env,
    timeoutMs: 100,
  });
  await manager.wait(session.id, 3000);
  const snapshot = manager.get(session.id)!;
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.signal, "SIGKILL");
});

test("process manager writes stdin and supports PTY sessions", async () => {
  const manager = new ProcessManager();
  const session = await manager.start({
    command: "read value; printf 'got:%s\\n' \"$value\"",
    cwd,
    env: process.env,
    pty: true,
  });
  manager.input(session.id, Buffer.from("hello\n"));
  await manager.wait(session.id, 5000);
  const output = manager.drain(session.id).output.replace(/\r/g, "");
  assert.match(output, /got:hello/);
  assert.equal(manager.get(session.id)?.running, false);
  await manager.shutdown();
});
