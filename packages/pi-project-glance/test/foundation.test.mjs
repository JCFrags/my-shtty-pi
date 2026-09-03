import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConnection } from "node:net";

import {
  MAX_FRAME_BYTES,
  PROJECT_GLANCE_PROTOCOL_VERSION,
} from "../dist/protocol/model.js";
import {
  ProjectGlanceFrameDecoder,
  encodeFrame,
} from "../dist/protocol/framing.js";
import {
  validateRuntimeDescriptor,
  validateSnapshot,
} from "../dist/protocol/validation.js";
import {
  readConnectionDescriptor,
} from "../dist/runtime/connection-file.js";
import {
  deriveSessionKey,
  runtimePathsForSession,
} from "../dist/runtime/paths.js";
import { ProjectGlancePaneRegistry } from "../dist/runtime/pane-registry.js";
import {
  createStaticSnapshot,
  STATIC_FIXTURE_SESSION_KEY,
} from "../dist/fixture/static-snapshot.js";
import { startStaticFixtureRelay } from "../dist/fixture/runtime.js";
import {
  ProjectGlanceClient,
  probeProjectGlanceRelay,
} from "../dist/protocol/client.js";
import { ProjectGlancePaneModel } from "../dist/pane/model.js";
import {
  renderProjectGlance,
  renderProjectGlanceAtHeight,
} from "../dist/pane/renderer.js";
import {
  buildPaneOpenArgs,
  openOrFocusProjectGlancePane,
  parsePaneOpenOutput,
} from "../dist/pi/open-pane.js";

const FIXTURE_NOW = "2026-09-02T00:00:00.000Z";

async function withTemporaryRuntime(callback) {
  const root = await mkdtemp(join(tmpdir(), "pi-project-glance-test-"));
  const environment = { ...process.env, XDG_RUNTIME_DIR: root };
  let relay;
  try {
    relay = await startStaticFixtureRelay(environment, FIXTURE_NOW);
    return await callback({ root, environment, relay });
  } finally {
    await relay?.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("TEST_WAIT_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function mode(path) {
  return lstat(path).then((entry) => entry.mode & 0o777);
}

function sendRawFrame(socket, frame) {
  socket.write(encodeFrame(frame));
}

async function waitForUnauthorizedResponse(descriptor) {
  const socket = createConnection(descriptor.socketPath);
  const decoder = new ProjectGlanceFrameDecoder();
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("AUTH_TEST_TIMEOUT")), 2_000);
    socket.on("connect", () => {
      sendRawFrame(socket, {
        version: PROJECT_GLANCE_PROTOCOL_VERSION,
        type: "hello",
        requestId: "bad-auth",
        sessionKey: descriptor.sessionKey,
        token: "0".repeat(64),
        generation: descriptor.generation,
      });
    });
    socket.on("data", (chunk) => {
      try {
        const frames = decoder.push(chunk);
        if (frames.length > 0) finish(undefined, frames[0]);
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", (error) => finish(error));
  });
}

test("framing is length-prefixed, bounded, and supports partial/multiple frames", () => {
  const first = { version: 1, type: "ping", requestId: "one" };
  const second = { version: 1, type: "ping", requestId: "two" };
  const encoded = Buffer.concat([encodeFrame(first), encodeFrame(second)]);
  const decoder = new ProjectGlanceFrameDecoder();
  assert.deepEqual(decoder.push(encoded.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(encoded.subarray(3)), [first, second]);
  assert.equal(decoder.bufferedBytes, 0);
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
  assert.throws(() => decoder.push(oversized), /FRAME_TOO_LARGE/);
  assert.throws(() => encodeFrame({ version: 1, type: "ping", requestId: "x".repeat(MAX_FRAME_BYTES) }), /FRAME_TOO_LARGE/);
});

test("validation rejects unknown fields, unsafe paths, and unbounded content", () => {
  const snapshot = createStaticSnapshot(STATIC_FIXTURE_SESSION_KEY, FIXTURE_NOW);
  assert.equal(validateSnapshot(snapshot).feed.length, 2);
  assert.throws(() => validateSnapshot({ ...snapshot, extra: true }), /INVALID_FRAME/);
  assert.throws(() => validateSnapshot({ ...snapshot, current: { focus: "/private/secret" } }), /INVALID_FRAME/);
  assert.throws(() => validateSnapshot({ ...snapshot, feed: [{ ...snapshot.feed[0], text: "x".repeat(4097) }] }), /INVALID_FRAME/);
  assert.throws(() => validateRuntimeDescriptor({
    protocolVersion: 1,
    sessionKey: snapshot.sessionKey,
    socketPath: "/tmp/relay.sock",
    token: "0".repeat(64),
    generation: "0".repeat(32),
    createdAt: FIXTURE_NOW,
    extra: true,
  }), /INVALID_FRAME/);
});

test("fixture relay is deterministic, private, authenticated, and exposes only the static snapshot", async () => {
  await withTemporaryRuntime(async ({ relay }) => {
    const descriptor = await readConnectionDescriptor(relay.paths.descriptorPath);
    assert.equal(JSON.stringify(createStaticSnapshot(relay.sessionKey, FIXTURE_NOW)), JSON.stringify(createStaticSnapshot(relay.sessionKey, FIXTURE_NOW)));
    const snapshot = await probeProjectGlanceRelay(relay.paths.descriptorPath);
    assert.equal(snapshot.sessionKey, relay.sessionKey);
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.current.step, "Validate the Project Glance foundation");
    assert.equal(snapshot.feed.length, 2);
    assert.equal(await mode(relay.paths.runtimeDirectory), 0o700);
    assert.equal(await mode(relay.paths.descriptorPath), 0o600);
    assert.equal(await mode(relay.paths.socketPath), 0o600);
    const unauthorized = await waitForUnauthorizedResponse(descriptor);
    assert.equal(unauthorized.type, "error");
    assert.equal(unauthorized.code, "authentication_failed");
  });
});

test("client reconnects after a relay generation restart", async () => {
  await withTemporaryRuntime(async ({ relay }) => {
    const states = [];
    const generations = [];
    const snapshots = [];
    const client = new ProjectGlanceClient({
      descriptorPath: relay.paths.descriptorPath,
      reconnectMinMs: 25,
      reconnectMaxMs: 100,
      onState: (state) => states.push(state),
      onDescriptor: (descriptor) => generations.push(descriptor.generation),
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });
    try {
      client.start();
      await waitFor(() => client.state === "connected" && snapshots.length >= 1);
      const firstGeneration = generations.at(-1);
      await relay.restart("2026-09-02T00:00:01.000Z");
      await waitFor(() => snapshots.length >= 2 && generations.at(-1) !== firstGeneration);
      assert.equal(client.state, "connected");
      assert.ok(states.includes("reconnecting"));
      assert.ok(generations.length >= 2);
    } finally {
      client.stop();
    }
    assert.equal(client.state, "disconnected");
  });
});

test("pane model and renderer keep CURRENT and PROGRESS FEED read-only", () => {
  const snapshot = createStaticSnapshot(STATIC_FIXTURE_SESSION_KEY, FIXTURE_NOW);
  const model = new ProjectGlancePaneModel(STATIC_FIXTURE_SESSION_KEY);
  assert.equal(model.applySnapshot(snapshot), "applied");
  assert.equal(model.applySnapshot(snapshot), "duplicate");
  const newer = { ...snapshot, revision: 2, feed: [...snapshot.feed] };
  assert.equal(model.applySnapshot(newer), "applied");
  assert.equal(model.applySnapshot(snapshot), "stale");
  assert.throws(() => model.applySnapshot({ ...snapshot, sessionKey: deriveSessionKey("other") }), /PROJECT_GLANCE_SESSION_MISMATCH/);
  const lines = renderProjectGlance(model.snapshot, "connected", 80);
  assert.ok(lines.includes("CURRENT"));
  assert.ok(lines.includes("PROGRESS FEED"));
  assert.ok(lines.some((line) => line.includes("Validate the Project Glance foundation")));
  assert.ok(renderProjectGlanceAtHeight(model.snapshot, "connected", 34, 3).length <= 3);
});

test("pane registry is owner-only and removes stale registrations", async () => {
  await withTemporaryRuntime(async ({ relay }) => {
    const registry = new ProjectGlancePaneRegistry(relay.paths);
    assert.equal(await registry.get(relay.sessionKey), undefined);
    await registry.set(relay.sessionKey, "pane-test-1");
    assert.deepEqual(await registry.get(relay.sessionKey), { paneId: "pane-test-1", updatedAt: (await registry.get(relay.sessionKey)).updatedAt });
    assert.equal(await mode(relay.paths.registryPath), 0o600);
    await registry.remove(relay.sessionKey);
    assert.equal(await registry.get(relay.sessionKey), undefined);
  });
});

test("opener focuses a registered pane and opens only when focus cannot find it", async () => {
  await withTemporaryRuntime(async ({ relay, environment }) => {
    const calls = [];
    const runner = async (_executable, args) => {
      calls.push([...args]);
      if (args[0] === "plugin" && args[2] === "focus") return { ok: true, stdout: "", stderr: "" };
      if (args[0] === "plugin" && args[2] === "open") return { ok: true, stdout: JSON.stringify({ result: { pane_id: "pane-test-2" } }), stderr: "" };
      return { ok: false, stdout: "", stderr: "" };
    };
    const options = {
      sessionKey: relay.sessionKey,
      descriptorPath: relay.paths.descriptorPath,
      currentPaneId: "pane-current",
      workspaceId: "workspace-test",
      cwd: "/tmp",
      environment: { ...environment, HERDR_ENV: "1" },
      runner,
    };
    assert.deepEqual(await openOrFocusProjectGlancePane(options), { action: "opened", paneId: "pane-test-2" });
    assert.deepEqual(await openOrFocusProjectGlancePane(options), { action: "focused", paneId: "pane-test-2" });
    assert.equal(calls.filter((args) => args[2] === "open").length, 1);
    assert.equal(calls.filter((args) => args[2] === "focus").length, 1);
    assert.deepEqual(buildPaneOpenArgs(options), [
      "plugin", "pane", "open", "--plugin", "pi.project-glance", "--entrypoint", "glance",
      "--placement", "split", "--workspace", "workspace-test", "--target-pane", "pane-current",
      "--direction", "right", "--cwd", "/tmp", "--env", "PI_PROJECT_GLANCE_DESCRIPTOR=" + relay.paths.descriptorPath,
      "--focus",
    ]);
    assert.equal(parsePaneOpenOutput(JSON.stringify({ result: { pane_id: "pane-test-2" } })), "pane-test-2");
  });
});

test("Pi extension boundary registers one command and lifecycle hooks only", async () => {
  const { default: extension } = await import("../dist/pi/extension.js");
  const commands = [];
  const events = [];
  const pi = {
    registerCommand(name, options) {
      commands.push({ name, options });
    },
    on(name, handler) {
      events.push({ name, handler });
    },
  };
  await extension(pi);
  assert.deepEqual(commands.map((entry) => entry.name), ["project-glance"]);
  assert.deepEqual(events.map((entry) => entry.name), ["session_start", "session_tree", "session_shutdown"]);
  assert.equal("registerTool" in pi, false);
  assert.equal("registerWidget" in pi, false);
});
