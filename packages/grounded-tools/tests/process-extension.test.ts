import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import groundedProcess, { BashParams, ProcessParams, SessionParams } from "../packages/process/index.ts";
import {
  SESSION_PROVIDER_PROTOCOL_VERSION,
  SESSION_PROVIDER_READY_EVENT,
  SESSION_PROVIDER_REGISTER_EVENT,
  SessionServiceError,
  type SessionProvider,
  type SessionProviderReadyEvent,
} from "@grounded/pi-core/session-contract";

function harness(beforeLoad?: (events: ReturnType<typeof createBus>) => void) {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, Array<(event: any, ctx: any) => any>>();
  const events = createBus();
  beforeLoad?.(events);
  const pi = {
    events,
    on(name: string, handler: (event: any, ctx: any) => any) {
      const handlers = lifecycle.get(name) ?? [];
      handlers.push(handler);
      lifecycle.set(name, handlers);
    },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
  };
  groundedProcess(pi as any);
  return {
    tools,
    events,
    async emitLifecycle(name: string, event: any = {}, ctx: any = {}) {
      for (const handler of lifecycle.get(name) ?? []) await handler(event, ctx);
    },
  };
}

function createBus() {
  const listeners = new Map<string, Array<(value: unknown) => void>>();
  return {
    on(name: string, handler: (value: unknown) => void) {
      const handlers = listeners.get(name) ?? [];
      handlers.push(handler);
      listeners.set(name, handlers);
      return () => listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== handler));
    },
    emit(name: string, value: unknown) {
      for (const handler of listeners.get(name) ?? []) handler(value);
    },
  };
}

function context(cwd: string) {
  return {
    cwd,
    thinkingLevel: "off",
    ui: { setStatus() {}, notify() {} },
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionFile: () => undefined,
    },
  } as any;
}

function sshProvider(): SessionProvider {
  return {
    id: "fake-ssh-v1",
    backend: "ssh",
    protocolVersion: SESSION_PROVIDER_PROTOCOL_VERSION,
    capabilities: () => ({ backend: "ssh", providerId: "fake-ssh-v1", protocolVersion: 1, pty: false, input: false }),
    async open() { throw new Error("not used"); },
  };
}

test("process extension adds only explicit bash sessionId routing and registers one unique session tool", () => {
  const previous = process.env.GROUNDED_TRIAL_MODE;
  process.env.GROUNDED_TRIAL_MODE = "1";
  try {
    const { tools } = harness();
    assert.deepEqual([...tools.keys()].sort(), ["grounded_bash", "grounded_process", "session"]);
    assert.equal(Value.Check(BashParams, { command: "pwd" }), true);
    assert.equal("sessionId" in BashParams.properties, true);
    assert.equal(Value.Check(BashParams, { command: "pwd", sessionId: "s_test" }), true);
    assert.equal(Value.Check(ProcessParams, { action: "list" }), true);
    assert.equal("sessionId" in ProcessParams.properties, false);
    assert.equal(Value.Check(SessionParams, { action: "capabilities" }), true);
    assert.equal(Value.Check(SessionParams, { action: "open", backend: "local" }), true);
  } finally {
    if (previous === undefined) delete process.env.GROUNDED_TRIAL_MODE;
    else process.env.GROUNDED_TRIAL_MODE = previous;
  }
});

test("session provider handshake works when a provider listens before Grounded Process loads", async () => {
  let ready: SessionProviderReadyEvent | undefined;
  const { tools } = harness((events) => {
    events.on(SESSION_PROVIDER_READY_EVENT, (value) => {
      ready = value as SessionProviderReadyEvent;
      ready.register(sshProvider());
    });
  });
  assert.equal(ready?.protocolVersion, 1);
  const result = await tools.get("session").execute("s1", { action: "capabilities" });
  assert.deepEqual(result.details.capabilities.map((entry: any) => entry.backend).sort(), ["local", "ssh"]);
});

test("session provider handshake works when a provider registers after Grounded Process loads", async () => {
  const { tools, events } = harness();
  events.emit(SESSION_PROVIDER_REGISTER_EVENT, { protocolVersion: 1, provider: sshProvider() });
  const result = await tools.get("session").execute("s1", { action: "capabilities" });
  assert.deepEqual(result.details.capabilities.map((entry: any) => entry.backend).sort(), ["local", "ssh"]);
});

test("session tool opens, inspects, and closes a local non-PTY session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grounded-process-extension-"));
  const h = harness();
  const ctx = context(cwd);
  await h.emitLifecycle("session_start", {}, ctx);
  const tool = h.tools.get("session");
  const opened = await tool.execute("s1", { action: "open", backend: "local" }, undefined, undefined, ctx);
  const id = opened.details.snapshot.id as string;
  assert.match(id, /^s_[a-f0-9]{32}$/);
  assert.equal(opened.details.snapshot.cwd, cwd);
  const status = await tool.execute("s2", { action: "status", sessionId: id }, undefined, undefined, ctx);
  assert.equal(status.details.snapshot.state, "idle");
  await assert.rejects(
    () => tool.execute("s3", { action: "input", sessionId: id, data: "x" }, undefined, undefined, ctx),
    (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_INPUT_REQUIRES_PTY",
  );
  await tool.execute("s4", { action: "close", sessionId: id }, undefined, undefined, ctx);
  const listed = await tool.execute("s5", { action: "list" }, undefined, undefined, ctx);
  assert.deepEqual(listed.details.sessions, []);
  await h.emitLifecycle("session_shutdown");
});

test("session tool exposes local PTY capability and validates exact input", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grounded-process-pty-extension-"));
  const h = harness();
  const ctx = context(cwd);
  await h.emitLifecycle("session_start", {}, ctx);
  const tool = h.tools.get("session");
  const capabilities = await tool.execute("s1", { action: "capabilities" }, undefined, undefined, ctx);
  assert.deepEqual(capabilities.details.capabilities[0], {
    backend: "local",
    providerId: "grounded-local-v1",
    protocolVersion: 1,
    pty: true,
    input: true,
  });
  const opened = await tool.execute("s2", { action: "open", backend: "local", pty: true }, undefined, undefined, ctx);
  const id = opened.details.snapshot.id as string;
  assert.equal(opened.details.snapshot.pty, true);
  await assert.rejects(
    () => tool.execute("s3", { action: "input", sessionId: id, dataBase64: "QQ==" }, undefined, undefined, ctx),
    (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_INPUT_NOT_RUNNING",
  );
  await assert.rejects(
    () => tool.execute("s4", { action: "input", sessionId: id, data: "x", dataBase64: "eA==" }, undefined, undefined, ctx),
    (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_INPUT_INVALID",
  );
  await assert.rejects(
    () => tool.execute("s5", { action: "input", sessionId: id, dataBase64: "QQ" }, undefined, undefined, ctx),
    (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_INPUT_INVALID",
  );
  await tool.execute("s6", { action: "close", sessionId: id }, undefined, undefined, ctx);
  await h.emitLifecycle("session_shutdown");
});

test("bash remains stateless when sessionId is omitted", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grounded-bash-stateless-parity-"));
  const h = harness();
  const ctx = context(cwd);
  await h.emitLifecycle("session_start", {}, ctx);
  try {
    const result = await h.tools.get("bash").execute(
      "b1",
      { command: "printf 'stateless\\n'", cwd, pty: false },
      undefined,
      undefined,
      ctx,
    );
    assert.match(result.content[0].text, /^\[exited\]\nexit_code: 0\nlog_path:/);
    assert.match(result.content[0].text, /---\nstateless\n$/);
    assert.match(result.details.processId, /^p[0-9]+$/);
    assert.equal(result.details.cwd, cwd);
    assert.equal(result.details.pty, false);
    assert.equal("sessionId" in result.details, false);
  } finally {
    await h.emitLifecycle("session_shutdown");
  }
});

test("bash routes explicit commands through a non-PTY session and rejects ambiguous arguments", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grounded-bash-session-route-"));
  const child = join(cwd, "child");
  await mkdir(child);
  const h = harness();
  const ctx = context(cwd);
  await h.emitLifecycle("session_start", {}, ctx);
  const sessionTool = h.tools.get("session");
  const bash = h.tools.get("bash");
  const opened = await sessionTool.execute("s1", { action: "open", backend: "local" }, undefined, undefined, ctx);
  const sessionId = opened.details.snapshot.id as string;
  try {
    const first = await bash.execute("b1", {
      command: "export ROUTED_VALUE=kept; cd child; printf 'out\\n'; printf 'err\\n' >&2",
      sessionId,
    }, undefined, undefined, ctx);
    assert.equal(first.details.sessionId, sessionId);
    assert.equal(first.details.result.cwd, child);
    const stdout = Buffer.concat(first.details.result.chunks.filter((chunk: any) => chunk.stream === "stdout").map((chunk: any) => Buffer.from(chunk.dataBase64, "base64"))).toString("utf8");
    const stderr = Buffer.concat(first.details.result.chunks.filter((chunk: any) => chunk.stream === "stderr").map((chunk: any) => Buffer.from(chunk.dataBase64, "base64"))).toString("utf8");
    assert.equal(stdout, "out\n");
    assert.equal(stderr, "err\n");
    assert.match(first.content[0].text, /\[stdout\]\n/);
    assert.match(first.content[0].text, /\[stderr\]\n/);
    const second = await bash.execute("b2", { command: "printf '%s:%s\\n' \"$ROUTED_VALUE\" \"$PWD\"", sessionId }, undefined, undefined, ctx);
    const bytes = Buffer.concat(second.details.result.chunks.map((chunk: any) => Buffer.from(chunk.dataBase64, "base64"))).toString("utf8");
    assert.equal(bytes, `kept:${child}\n`);

    const timedOut = await bash.execute("b3", { command: "sleep 30", sessionId, timeout: 0.05 }, undefined, undefined, ctx);
    assert.equal(timedOut.details.result.cancelled, true);
    assert.equal(timedOut.details.result.timedOut, true);
    assert.match(timedOut.content[0].text, /^\[cancelled: timeout\]/);

    const controller = new AbortController();
    const cancelledCommand = bash.execute("b4", { command: "sleep 30", sessionId }, controller.signal, undefined, ctx);
    setTimeout(() => controller.abort(), 50).unref();
    const cancelled = await cancelledCommand;
    assert.equal(cancelled.details.result.cancelled, true);
    assert.equal(cancelled.details.result.timedOut, false);
    const reused = await bash.execute("b5", { command: "printf 'after-cancel\\n'", sessionId }, undefined, undefined, ctx);
    assert.equal(Buffer.from(reused.details.result.chunks[0].dataBase64, "base64").toString("utf8"), "after-cancel\n");

    for (const params of [
      { command: "true", sessionId, cwd },
      { command: "true", sessionId, background: false },
      { command: "true", sessionId, yieldMs: 0 },
      { command: "true", sessionId, pty: false },
    ]) {
      await assert.rejects(
        () => bash.execute("conflict", params, undefined, undefined, ctx),
        (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_BASH_ARGUMENT_CONFLICT",
      );
    }
  } finally {
    await sessionTool.execute("s2", { action: "close", sessionId }, undefined, undefined, ctx).catch(() => undefined);
    await h.emitLifecycle("session_shutdown");
  }
});

test("bash routes a PTY command while session input supplies exact bytes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grounded-bash-pty-route-"));
  const h = harness();
  const ctx = context(cwd);
  await h.emitLifecycle("session_start", {}, ctx);
  const sessionTool = h.tools.get("session");
  const bash = h.tools.get("bash");
  const opened = await sessionTool.execute("s1", { action: "open", backend: "local", pty: true }, undefined, undefined, ctx);
  const sessionId = opened.details.snapshot.id as string;
  try {
    const command = bash.execute("b1", { command: "IFS= read -r value; printf '<%s>\\n' \"$value\"", sessionId }, undefined, undefined, ctx);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await sessionTool.execute("s2", { action: "input", sessionId, dataBase64: "aGVsbG8K" }, undefined, undefined, ctx);
    const result = await command;
    assert.equal(result.details.result.terminalBytes, Buffer.byteLength("<hello>\r\n"));
    assert.match(result.content[0].text, /\[terminal\]\n<hello>\r\n/);
  } finally {
    await sessionTool.execute("s3", { action: "close", sessionId }, undefined, undefined, ctx).catch(() => undefined);
    await h.emitLifecycle("session_shutdown");
  }
});

test("successful session tree navigation closes all owned sessions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grounded-process-tree-"));
  const h = harness();
  const ctx = context(cwd);
  await h.emitLifecycle("session_start", {}, ctx);
  const tool = h.tools.get("session");
  await tool.execute("s1", { action: "open", backend: "local" }, undefined, undefined, ctx);
  await h.emitLifecycle("session_tree", {}, ctx);
  const listed = await tool.execute("s2", { action: "list" }, undefined, undefined, ctx);
  assert.deepEqual(listed.details.sessions, []);
  await h.emitLifecycle("session_shutdown");
});
