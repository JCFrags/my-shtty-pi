import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalSessionProvider } from "@grounded/pi-core/local-session";
import { SessionRegistry } from "@grounded/pi-core/session-registry";
import {
  SESSION_PROVIDER_PROTOCOL_VERSION,
  SessionServiceError,
  type SessionBackendHandle,
  type SessionCommandResult,
  type SessionProvider,
} from "@grounded/pi-core/session-contract";

class FakeHandle implements SessionBackendHandle {
  readonly providerId: string;
  readonly backend: "local" | "ssh";
  readonly pty = false;
  state: "idle" | "running" | "closed" = "idle";
  concurrent = 0;
  maximumConcurrent = 0;
  order: string[] = [];

  constructor(backend: "local" | "ssh" = "local") {
    this.backend = backend;
    this.providerId = `fake-${backend}`;
  }

  status() {
    return {
      state: this.state,
      cwd: "/tmp",
      generation: 1,
      openedAt: 1,
      lastActivityAt: 1,
    };
  }

  async execute(command: string): Promise<SessionCommandResult> {
    this.state = "running";
    this.concurrent++;
    this.maximumConcurrent = Math.max(this.maximumConcurrent, this.concurrent);
    this.order.push(`start:${command}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    this.order.push(`end:${command}`);
    this.concurrent--;
    this.state = "idle";
    return {
      requestId: command,
      exitCode: 0,
      signal: null,
      cwd: "/tmp",
      cancelled: false,
      timedOut: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      terminalBytes: 0,
      truncated: false,
      chunks: [],
      logPath: "/tmp/fake",
    };
  }

  input() {}
  interrupt() {}
  whenClosed() { return Promise.resolve(); }
  async close() { this.state = "closed"; }
}

function fakeProvider(handles: FakeHandle[]): SessionProvider {
  return {
    id: "fake-local",
    backend: "local",
    protocolVersion: SESSION_PROVIDER_PROTOCOL_VERSION,
    capabilities: () => ({ backend: "local", providerId: "fake-local", protocolVersion: 1, pty: false, input: false }),
    async open() {
      const handle = new FakeHandle();
      handles.push(handle);
      return handle;
    },
  };
}

const openOptions = { backend: "local" as const, cwd: "/tmp", env: process.env };

test("session registry enforces capacity and releases it after close", async () => {
  const handles: FakeHandle[] = [];
  const registry = new SessionRegistry({ maximumSessions: 4 });
  registry.registerProvider(fakeProvider(handles));
  const sessions = await Promise.all(Array.from({ length: 4 }, () => registry.open(openOptions)));
  assert.equal(new Set(sessions.map((entry) => entry.id)).size, 4);
  assert.ok(sessions.every((entry) => /^s_[a-f0-9]{32}$/.test(entry.id)));
  await assert.rejects(
    () => registry.open(openOptions),
    (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_LIMIT",
  );
  await registry.close(sessions[0]!.id);
  assert.equal(registry.list().length, 3);
  await registry.open(openOptions);
  assert.equal(registry.list().length, 4);
  await registry.shutdown();
});

test("session registry runs one FIFO command per session", async () => {
  const handles: FakeHandle[] = [];
  const registry = new SessionRegistry();
  registry.registerProvider(fakeProvider(handles));
  const session = await registry.open(openOptions);
  const results = await Promise.all([
    registry.execute(session.id, "one"),
    registry.execute(session.id, "two"),
    registry.execute(session.id, "three"),
  ]);
  assert.deepEqual(results.map((entry) => entry.requestId), ["one", "two", "three"]);
  assert.equal(handles[0]!.maximumConcurrent, 1);
  assert.deepEqual(handles[0]!.order, ["start:one", "end:one", "start:two", "end:two", "start:three", "end:three"]);
  await registry.shutdown();
});

test("session registry serializes local operations with commands and remains reusable after failure", async () => {
  const handles: FakeHandle[] = [];
  const registry = new SessionRegistry();
  registry.registerProvider(fakeProvider(handles));
  const session = await registry.open(openOptions);
  const first = registry.execute(session.id, "one");
  const local = registry.withLocalSession(session.id, async (context) => {
    assert.equal(context.backend, "local");
    assert.equal(context.cwd, "/tmp");
    handles[0]!.order.push("start:file");
    await new Promise((resolve) => setTimeout(resolve, 10));
    handles[0]!.order.push("end:file");
    return "file-result";
  });
  const second = registry.execute(session.id, "two");
  assert.equal(await local, "file-result");
  await Promise.all([first, second]);
  assert.deepEqual(handles[0]!.order, [
    "start:one", "end:one", "start:file", "end:file", "start:two", "end:two",
  ]);

  await assert.rejects(
    registry.withLocalSession(session.id, async () => { throw new Error("file failed"); }),
    /file failed/,
  );
  assert.equal(await registry.withLocalSession(session.id, async () => "reused"), "reused");

  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => registry.withLocalSession(session.id, async () => "not-run", { signal: controller.signal }),
    /Operation aborted/,
  );
  assert.throws(
    () => registry.withLocalSession("missing", async () => "not-run"),
    (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_UNKNOWN",
  );
  await registry.shutdown();
});

test("session registry rejects local operations for non-local providers", async () => {
  const registry = new SessionRegistry();
  registry.registerProvider({
    id: "fake-ssh",
    backend: "ssh",
    protocolVersion: SESSION_PROVIDER_PROTOCOL_VERSION,
    capabilities: () => ({ backend: "ssh", providerId: "fake-ssh", protocolVersion: 1, pty: false, input: false }),
    async open() { return new FakeHandle("ssh"); },
  });
  const session = await registry.open({ backend: "ssh", cwd: "/tmp", env: process.env });
  assert.throws(
    () => registry.withLocalSession(session.id, async () => "not-run"),
    (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_OPERATION_REQUIRES_LOCAL",
  );
  await registry.shutdown();
});

test("idle-closed local sessions release registry capacity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grounded-session-idle-"));
  const registry = new SessionRegistry({ maximumSessions: 1, idleTimeoutMs: 30, closeTimeoutMs: 500 });
  registry.registerProvider(new LocalSessionProvider());
  await registry.open({ backend: "local", cwd, env: process.env });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(registry.list(), []);
  const replacement = await registry.open({ backend: "local", cwd, env: process.env });
  assert.equal(registry.list().length, 1);
  await registry.close(replacement.id);
});

test("session registry routes exact input only to a running PTY session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grounded-session-registry-pty-"));
  const registry = new SessionRegistry();
  registry.registerProvider(new LocalSessionProvider());
  const session = await registry.open({ backend: "local", cwd, env: process.env, pty: true });
  try {
    assert.throws(
      () => registry.input(session.id, Buffer.from("idle")),
      (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_INPUT_NOT_RUNNING",
    );
    const command = registry.execute(session.id, "IFS= read -r value; printf '<%s>\\n' \"$value\"");
    await new Promise((resolve) => setTimeout(resolve, 100));
    registry.input(session.id, Buffer.from("registry-input\n"));
    const result = await command;
    const terminal = Buffer.concat(result.chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64"))).toString("utf8");
    assert.equal(terminal, "<registry-input>\r\n");
  } finally {
    await registry.shutdown();
  }
});

test("session registry rejects unknown ids and out-of-range timeouts", async () => {
  const registry = new SessionRegistry({ maximumCommandTimeoutMs: 1000 });
  registry.registerProvider(fakeProvider([]));
  const session = await registry.open(openOptions);
  assert.throws(() => registry.status("missing"), (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_UNKNOWN");
  assert.throws(
    () => registry.execute(session.id, "x", { timeoutMs: 1001 }),
    (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_TIMEOUT_INVALID",
  );
  await registry.shutdown();
});
