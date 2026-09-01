import assert from "node:assert/strict";
import { createConnection, type Socket } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Broker } from "../../src/broker/broker.js";
import { canonicalJson, sha256 } from "../../src/shared/canonical-json.js";
import { createId } from "../../src/shared/ids.js";
import { NdjsonDecoder, encodeFrame } from "../../src/shared/protocol/codec.js";
import { sessionKey, type ResolvedPaths } from "../../src/shared/paths.js";

interface Frame {
  type?: string;
  id?: string;
  ok?: boolean;
  result?: any;
  error?: { code?: string; message?: string };
}

function request(
  socket: Socket,
  method: string,
  params: Record<string, unknown>,
): Promise<Frame> {
  const id = createId("evt");
  socket.write(encodeFrame({ v: 1, type: "request", id, method, params }));
  return new Promise((resolve, reject) => {
    const decoder = new NdjsonDecoder<Frame>((value) => value as Frame);
    const timer = setTimeout(
      () => reject(new Error(`timeout ${method}`)),
      5_000,
    );
    const onData = (chunk: Buffer) => {
      for (const item of decoder.push(chunk)) {
        if (!item.ok || item.value.id !== id) continue;
        clearTimeout(timer);
        socket.off("data", onData);
        resolve(item.value);
      }
    };
    socket.on("data", onData);
  });
}

async function connect(
  paths: ResolvedPaths & { sessionKey: string },
  secret: string,
  kind: "pi_parent" | "cli" | "observer",
): Promise<Socket> {
  const socket = createConnection(paths.socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const id = createId("evt");
  socket.write(
    encodeFrame({
      v: 1,
      type: "hello",
      id,
      client: {
        kind,
        name: "tool-audit-test",
        version: "0.1.0",
        capabilities: [],
      },
      sessionKey: paths.sessionKey,
      auth: { kind: "client_secret", secret },
    }),
  );
  await new Promise<void>((resolve, reject) => {
    const decoder = new NdjsonDecoder<Frame>((value) => value as Frame);
    const timer = setTimeout(() => reject(new Error("hello timeout")), 5_000);
    const onData = (chunk: Buffer) => {
      for (const item of decoder.push(chunk)) {
        if (!item.ok || item.value.id !== id) continue;
        clearTimeout(timer);
        socket.off("data", onData);
        if (item.value.ok === true) resolve();
        else reject(new Error(item.value.error?.message ?? "hello rejected"));
      }
    };
    socket.on("data", onData);
  });
  return socket;
}

function registration(sessionId: string) {
  return {
    adapterVersion: "0.1.0",
    herdr: {
      paneId: "audit-pane",
      terminalId: "audit-terminal",
      detectedKind: "pi",
      sessionReference: {
        source: "herdr:pi",
        agent: "pi",
        kind: "id",
        value: sessionId,
      },
      name: "audit-parent",
    },
    pi: {
      sessionId,
      sessionName: "audit-parent",
      capabilities: {},
      state: {
        model: { provider: "openai-codex", modelId: "gpt-5.6-luna" },
        thinkingLevel: "medium",
      },
    },
  };
}

test("broker authenticates tool audit attribution and exposes operator-only durable queries", async () => {
  const root = await mkdtemp(join(tmpdir(), "tool-audit-wire-"));
  const runtime = await mkdtemp(join(tmpdir(), "tool-audit-wire-runtime-"));
  const paths = {
    sessionKey: sessionKey(join(runtime, "broker.sock")),
    root,
    runtime,
    events: join(root, "events.jsonl"),
    toolAudit: join(root, "tool-audit.jsonl"),
    snapshot: join(root, "snapshot.json"),
    lock: join(runtime, "lock"),
    socket: join(runtime, "broker.sock"),
    secret: join(runtime, "secret"),
  };
  const makeBroker = () =>
    new Broker(paths, {
      herdrFactory: async (store) =>
        ({
          store,
          startupReconcile: async () => [],
          verifyRoot: async (identity: any) => ({
            paneId: identity.paneId,
            terminalId: identity.terminalId,
            workspaceId: "workspace",
            cwd: "/fake",
          }),
        }) as any,
    });
  let broker = makeBroker();
  let parent: Socket | undefined;
  let cli: Socket | undefined;
  let observer: Socket | undefined;
  try {
    await broker.start();
    const secret = (await readFile(paths.secret, "utf8")).trim();
    parent = await connect(paths, secret, "pi_parent");
    const registered = await request(
      parent,
      "agent.register_adopted",
      registration("pi-audit-session"),
    );
    assert.equal(registered.ok, true, JSON.stringify(registered.error));
    const agentId = registered.result.agentId as string;

    const input = { action: "run", task: { title: "Canary", objective: "OK" } };
    const encoded = canonicalJson(input);
    const started = await request(parent, "tool_audit.ingest", {
      phase: "started",
      observedAt: "2026-01-01T00:00:00.000Z",
      toolCallId: "call_wire",
      toolName: "orchestrate",
      input,
      inputBytes: Buffer.byteLength(encoded, "utf8"),
      inputSha256: sha256(encoded),
    });
    assert.equal(started.ok, true, JSON.stringify(started.error));
    const completed = await request(parent, "tool_audit.ingest", {
      phase: "completed",
      observedAt: "2026-01-01T00:00:01.000Z",
      toolCallId: "call_wire",
      toolName: "orchestrate",
      status: "failed",
      durationMs: 1_000,
      errorCode: "INVALID_REQUEST",
      errorMessage: "Synthetic malformed call.",
    });
    assert.equal(completed.ok, true, JSON.stringify(completed.error));

    cli = await connect(paths, secret, "cli");
    const listed = await request(cli, "tool_audit.list", {
      agentId,
      status: "failed",
      limit: 10,
    });
    assert.equal(listed.ok, true, JSON.stringify(listed.error));
    assert.equal(listed.result.length, 1);
    assert.equal(Object.hasOwn(listed.result[0], "input"), false);
    assert.equal(listed.result[0].actor.kind, "pi_parent");
    assert.equal(listed.result[0].actor.agentId, agentId);
    assert.equal(listed.result[0].actor.piSessionId, "pi-audit-session");

    const shown = await request(cli, "tool_audit.get", {
      invocationId: started.result.invocationId,
    });
    assert.equal(shown.ok, true, JSON.stringify(shown.error));
    assert.deepEqual(shown.result.input, input);
    assert.equal(shown.result.errorCode, "INVALID_REQUEST");
    const verified = await request(cli, "tool_audit.verify", {});
    assert.equal(verified.ok, true, JSON.stringify(verified.error));
    assert.equal(verified.result.records, 2);

    observer = await connect(paths, secret, "observer");
    const deniedRead = await request(observer, "tool_audit.list", {});
    assert.equal(deniedRead.ok, false);
    assert.equal(deniedRead.error?.code, "PERMISSION_DENIED");
    const deniedIngest = await request(cli, "tool_audit.ingest", {
      phase: "completed",
    });
    assert.equal(deniedIngest.ok, false);
    assert.equal(deniedIngest.error?.code, "PERMISSION_DENIED");

    parent.destroy();
    parent = undefined;
    cli.destroy();
    cli = undefined;
    observer.destroy();
    observer = undefined;
    await broker.stop();
    broker = makeBroker();
    await broker.start();
    const durable = await broker.auditStore.get(started.result.invocationId);
    assert.deepEqual(durable?.input, input);
    assert.equal(durable?.status, "failed");
  } finally {
    parent?.destroy();
    cli?.destroy();
    observer?.destroy();
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});
