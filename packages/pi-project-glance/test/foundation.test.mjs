import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConnection, createServer } from "node:net";
import { execFileSync } from "node:child_process";

import {
  MAX_FRAME_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_REQUEST_ID,
  PROJECT_GLANCE_PROTOCOL_VERSION,
} from "../dist/protocol/model.js";
import {
  FRAME_HEADER_BYTES,
  MAX_FRAMES_PER_PUSH,
  MAX_RETAINED_FRAME_BYTES,
  ProjectGlanceFrameDecoder,
  ProjectGlanceFrameError,
  encodeFrame,
  snapshotFrameBodyBytes,
} from "../dist/protocol/framing.js";
import {
  validateClientFrame,
  validateRuntimeDescriptor,
  validateServerFrame,
  validateSnapshot,
} from "../dist/protocol/validation.js";
import {
  createRuntimeDescriptor,
  readConnectionDescriptor,
  removeConnectionDescriptor,
  writeConnectionDescriptor,
} from "../dist/runtime/connection-file.js";
import {
  assertPrivateRuntimeDirectory,
  deriveSessionKey,
  ensurePrivateDirectory,
  runtimePathsForSession,
} from "../dist/runtime/paths.js";
import { ProjectGlancePaneRegistry } from "../dist/runtime/pane-registry.js";
import {
  createStaticSnapshot,
  STATIC_FIXTURE_LONG_FEED_COUNT,
  STATIC_FIXTURE_SESSION_KEY,
} from "../dist/fixture/static-snapshot.js";
import { startStaticFixtureRelay } from "../dist/fixture/runtime.js";
import {
  ProjectGlanceClient,
  probeProjectGlanceRelay,
} from "../dist/protocol/client.js";
import { ProjectGlancePaneModel } from "../dist/pane/model.js";
import { ProjectGlancePaneView } from "../dist/pane/main.js";
import {
  renderProjectGlance,
  renderProjectGlanceAtHeight,
  renderProjectGlanceFeed,
  renderProjectGlancePinned,
} from "../dist/pane/renderer.js";
import {
  buildPaneOpenArgs,
  openOrFocusProjectGlancePane,
  parsePaneOpenOutput,
} from "../dist/pi/open-pane.js";
import { ProjectGlanceServer } from "../dist/protocol/server.js";
import { visibleWidth } from "@earendil-works/pi-tui";

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

async function withFakeRelay(callback) {
  const root = await mkdtemp(join(tmpdir(), "pi-project-glance-fake-"));
  const environment = { ...process.env, XDG_RUNTIME_DIR: root };
  const sessionKey = deriveSessionKey("fake-project-glance-relay");
  const paths = runtimePathsForSession(sessionKey, environment);
  await ensurePrivateDirectory(paths.runtimeDirectory);
  const descriptor = createRuntimeDescriptor(paths, sessionKey, FIXTURE_NOW);
  let handler = () => undefined;
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    handler(socket);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socketPath, () => resolve());
  });
  await chmod(paths.socketPath, 0o600);
  await writeConnectionDescriptor(paths, descriptor);
  try {
    return await callback({
      root,
      environment,
      paths,
      descriptor,
      setHandler: (next) => { handler = next; },
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => {
      if (!server.listening) resolve();
      else server.close(() => resolve());
    });
    await removeConnectionDescriptor(paths).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

test("framing is incremental, coalescing, and bounded", () => {
  const first = { version: 1, type: "ping", requestId: "one" };
  const second = { version: 1, type: "ping", requestId: "two" };
  const encoded = Buffer.concat([encodeFrame(first), encodeFrame(second)]);
  const decoder = new ProjectGlanceFrameDecoder();
  assert.deepEqual(decoder.push(encoded.subarray(0, 1)), []);
  assert.deepEqual(decoder.push(encoded.subarray(1, 3)), []);
  assert.deepEqual(decoder.push(encoded.subarray(3, 7)), []);
  assert.deepEqual(decoder.push(encoded.subarray(7)), [first, second]);
  assert.equal(decoder.bufferedBytes, 0);

  const partial = new ProjectGlanceFrameDecoder();
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(MAX_FRAME_BYTES, 0);
  partial.push(header);
  partial.push(Buffer.alloc(MAX_FRAME_BYTES - 1));
  assert.ok(partial.bufferedBytes <= MAX_RETAINED_FRAME_BYTES);

  const oversized = Buffer.alloc(FRAME_HEADER_BYTES);
  oversized.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
  assert.throws(() => decoder.push(oversized), (error) => error instanceof ProjectGlanceFrameError && /FRAME_TOO_LARGE/.test(error.message));
  assert.throws(() => encodeFrame(undefined), ProjectGlanceFrameError);
  assert.throws(() => encodeFrame({ version: 1, type: "ping", requestId: "x".repeat(MAX_FRAME_BYTES) }), /FRAME_TOO_LARGE/);

  const many = Buffer.concat(Array.from({ length: MAX_FRAMES_PER_PUSH + 1 }, (_, index) => encodeFrame({
    version: 1,
    type: "ping",
    requestId: String(index),
  })));
  assert.throws(() => new ProjectGlanceFrameDecoder().push(many), /TOO_MANY_FRAMES/);
});

test("validation separates display text from filesystem paths and enforces the wire budget", () => {
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
  assert.throws(() => validateRuntimeDescriptor({
    protocolVersion: 1,
    sessionKey: snapshot.sessionKey,
    socketPath: "relative.sock",
    token: "0".repeat(64),
    generation: "0".repeat(32),
    createdAt: FIXTURE_NOW,
  }), /INVALID_FRAME/);

  const makeNearLimit = (textLength) => ({
    ...snapshot,
    feed: Array.from({ length: 50 }, (_, index) => ({
      id: `budget-${index}`,
      type: "assistant_update",
      text: "x".repeat(textLength),
      createdAt: FIXTURE_NOW,
    })),
  });
  let low = 1;
  let high = 4096;
  let accepted;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    try {
      accepted = validateSnapshot(makeNearLimit(middle));
      low = middle + 1;
    } catch {
      high = middle - 1;
    }
  }
  assert.ok(accepted);
  const payloadBytes = Buffer.byteLength(JSON.stringify(accepted), "utf8");
  assert.ok(payloadBytes <= MAX_SNAPSHOT_BYTES);
  assert.ok(payloadBytes > MAX_SNAPSHOT_BYTES - 2_048);
  assert.ok(snapshotFrameBodyBytes(accepted, MAX_SNAPSHOT_REQUEST_ID) <= MAX_FRAME_BYTES);
  assert.doesNotThrow(() => encodeFrame({
    version: PROJECT_GLANCE_PROTOCOL_VERSION,
    type: "snapshot",
    requestId: MAX_SNAPSHOT_REQUEST_ID,
    snapshot: accepted,
  }));
  assert.throws(() => validateSnapshot(makeNearLimit(4096)), /INVALID_FRAME/);
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

test("snapshot frames stay within the correlated wire budget near the boundary", () => {
  const base = createStaticSnapshot(STATIC_FIXTURE_SESSION_KEY, FIXTURE_NOW);
  const makeSnapshot = (textLength) => ({
    ...base,
    feed: Array.from({ length: 50 }, (_, index) => ({
      id: `wire-${index}`,
      type: "assistant_update",
      text: "z".repeat(textLength),
      createdAt: FIXTURE_NOW,
    })),
  });
  let low = 1;
  let high = 4096;
  let accepted;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    try {
      accepted = validateSnapshot(makeSnapshot(middle));
      low = middle + 1;
    } catch {
      high = middle - 1;
    }
  }
  assert.ok(accepted);
  assert.ok(Buffer.byteLength(JSON.stringify(accepted), "utf8") <= MAX_SNAPSHOT_BYTES);
  assert.ok(snapshotFrameBodyBytes(accepted, MAX_SNAPSHOT_REQUEST_ID) <= MAX_FRAME_BYTES);
  assert.doesNotThrow(() => encodeFrame({
    version: PROJECT_GLANCE_PROTOCOL_VERSION,
    type: "snapshot",
    requestId: MAX_SNAPSHOT_REQUEST_ID,
    snapshot: accepted,
  }));
});

test("client enforces hello and snapshot request correlation", async () => {
  await withFakeRelay(async ({ descriptor, setHandler }) => {
    const errors = [];
    const snapshots = [];
    setHandler((socket) => {
      const decoder = new ProjectGlanceFrameDecoder();
      socket.on("data", (chunk) => {
        for (const frame of decoder.push(chunk)) {
          if (frame?.type !== "hello") continue;
          sendRawFrame(socket, {
            version: PROJECT_GLANCE_PROTOCOL_VERSION,
            type: "hello",
            requestId: "wrong-hello-request",
            accepted: true,
            sessionKey: descriptor.sessionKey,
            generation: descriptor.generation,
          });
        }
      });
    });
    const client = new ProjectGlanceClient({
      descriptorPath: descriptorPathFor(descriptor),
      reconnectMinMs: 25,
      reconnectMaxMs: 50,
      onError: (error) => errors.push(error),
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });
    try {
      client.start();
      await waitFor(() => errors.includes("frame"));
      assert.equal(snapshots.length, 0);
      assert.equal(client.state, "reconnecting");
    } finally {
      client.stop();
    }
  });

  await withFakeRelay(async ({ descriptor, paths, setHandler }) => {
    const errors = [];
    const snapshots = [];
    const initial = createStaticSnapshot(descriptor.sessionKey, FIXTURE_NOW);
    setHandler((socket) => {
      const decoder = new ProjectGlanceFrameDecoder();
      socket.on("data", (chunk) => {
        for (const frame of decoder.push(chunk)) {
          if (frame?.type === "hello") {
            sendRawFrame(socket, {
              version: PROJECT_GLANCE_PROTOCOL_VERSION,
              type: "hello",
              requestId: frame.requestId,
              accepted: true,
              sessionKey: descriptor.sessionKey,
              generation: descriptor.generation,
            });
            sendRawFrame(socket, {
              version: PROJECT_GLANCE_PROTOCOL_VERSION,
              type: "snapshot",
              snapshot: initial,
            });
            setTimeout(() => {
              if (!socket.destroyed) sendRawFrame(socket, {
                version: PROJECT_GLANCE_PROTOCOL_VERSION,
                type: "snapshot_changed",
                revision: 2,
              });
            }, 10);
          } else if (frame?.type === "snapshot_request") {
            sendRawFrame(socket, {
              version: PROJECT_GLANCE_PROTOCOL_VERSION,
              type: "snapshot",
              requestId: "wrong-snapshot-request",
              snapshot: { ...initial, revision: 2 },
            });
          }
        }
      });
    });
    const client = new ProjectGlanceClient({
      descriptorPath: paths.descriptorPath,
      reconnectMinMs: 25,
      reconnectMaxMs: 50,
      onError: (error) => errors.push(error),
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });
    try {
      client.start();
      await waitFor(() => errors.includes("frame") && snapshots.length >= 1);
      assert.equal(snapshots[0].revision, 1);
      assert.equal(client.state, "reconnecting");
    } finally {
      client.stop();
    }
  });
});

function descriptorPathFor(descriptor) {
  return descriptor.socketPath.replace(/relay-[a-f0-9]{24}\.sock$/u, (name) => `connection-${name.slice(6, -5)}.json`);
}

test("pane model accepts revision one again for a new relay generation", () => {
  const firstGeneration = "a".repeat(32);
  const secondGeneration = "b".repeat(32);
  const model = new ProjectGlancePaneModel(STATIC_FIXTURE_SESSION_KEY, firstGeneration);
  const first = createStaticSnapshot(STATIC_FIXTURE_SESSION_KEY, FIXTURE_NOW);
  assert.equal(model.applySnapshot(first, firstGeneration), "applied");
  model.setExpectedRelay({ sessionKey: STATIC_FIXTURE_SESSION_KEY, generation: secondGeneration });
  assert.equal(model.state, "reconnecting");
  const second = createStaticSnapshot(STATIC_FIXTURE_SESSION_KEY, "2026-09-02T00:00:01.000Z", 1);
  assert.equal(model.applySnapshot(second, {
    sessionKey: STATIC_FIXTURE_SESSION_KEY,
    generation: secondGeneration,
  }), "applied");
  assert.equal(model.state, "connected");
  assert.throws(() => model.applySnapshot(first, firstGeneration), /PROJECT_GLANCE_GENERATION_MISMATCH/);
});

test("pane layout pins CURRENT and scrolls only the feed", () => {
  const model = new ProjectGlancePaneModel(STATIC_FIXTURE_SESSION_KEY);
  model.applySnapshot(createStaticSnapshot(STATIC_FIXTURE_SESSION_KEY, FIXTURE_NOW, 0, true));
  const view = new ProjectGlancePaneView(model);
  assert.equal(view.root.children.length, 2);
  assert.equal(view.root.children[0], view.pinned);
  assert.equal(view.root.children[1], view.scrollView);
  const pinnedBefore = view.pinned.render(32);
  assert.deepEqual(view.scrollView.render(32).slice(0, 1), ["PROGRESS FEED"]);
  view.scrollView.updateLayout(100, 5, () => undefined);
  view.scrollView.scrollBy(7);
  assert.ok(view.scrollView.scrollTop > 0);
  assert.deepEqual(view.pinned.render(32), pinnedBefore);
  const narrow = renderProjectGlance(model.snapshot, "connected", 32);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 32));
  assert.ok(!narrow.some((line) => /^Connection:/u.test(line)));
  assert.ok(renderProjectGlancePinned(model.snapshot, "disconnected", 32).some((line) => line.startsWith("DISCONNECTED:")));
  assert.ok(renderProjectGlanceFeed(model.snapshot, 32).includes("PROGRESS FEED"));
});

test("registry records do not lose concurrent sessions and same-session locks serialize", async () => {
  await withTemporaryRuntime(async ({ environment }) => {
    const sessionA = deriveSessionKey("registry-session-a");
    const sessionB = deriveSessionKey("registry-session-b");
    const pathsA = runtimePathsForSession(sessionA, environment);
    const pathsB = runtimePathsForSession(sessionB, environment);
    assert.equal(pathsA.runtimeDirectory, pathsB.runtimeDirectory);
    assert.equal(pathsA.registryPath, pathsB.registryPath);
    const registry = new ProjectGlancePaneRegistry(pathsA);
    const registryB = new ProjectGlancePaneRegistry(pathsB);
    let active = 0;
    let maximum = 0;
    await Promise.all([
      registry.withSessionLock(sessionA, async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active -= 1;
      }),
      registry.withSessionLock(sessionA, async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      }),
    ]);
    assert.equal(maximum, 1);
    await Promise.all([
      registry.set(sessionA, "pane-session-a"),
      registryB.set(sessionB, "pane-session-b"),
    ]);
    assert.deepEqual(await registry.get(sessionA), { paneId: "pane-session-a", updatedAt: (await registry.get(sessionA)).updatedAt });
    assert.deepEqual(await registryB.get(sessionB), { paneId: "pane-session-b", updatedAt: (await registryB.get(sessionB)).updatedAt });
  });
});

test("descriptor and runtime files reject unsafe modes and symlinks without changing umask", async () => {
  await withTemporaryRuntime(async ({ relay }) => {
    const beforeUmask = process.umask();
    await chmod(relay.paths.runtimeDirectory, 0o755);
    await assert.rejects(assertPrivateRuntimeDirectory(relay.paths.runtimeDirectory), /Unsafe Project Glance permissions/);
    await assert.rejects(readConnectionDescriptor(relay.paths.descriptorPath), /Unsafe Project Glance permissions|runtime directory/);
    await chmod(relay.paths.runtimeDirectory, 0o700);

    const backup = `${relay.paths.descriptorPath}.backup`;
    await rename(relay.paths.descriptorPath, backup);
    await symlink(backup, relay.paths.descriptorPath);
    await assert.rejects(readConnectionDescriptor(relay.paths.descriptorPath));
    await assert.rejects(writeConnectionDescriptor(relay.paths, relay.descriptor));
    await unlink(relay.paths.descriptorPath);
    await rename(backup, relay.paths.descriptorPath);
    await writeConnectionDescriptor(relay.paths, relay.descriptor);
    assert.equal(process.umask(), beforeUmask);
  });
});

test("fixture restart is serialized and restores the old descriptor on replacement failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-project-glance-restart-"));
  const environment = { ...process.env, XDG_RUNTIME_DIR: root };
  let relay;
  let failOnce = true;
  try {
    relay = await startStaticFixtureRelay(environment, FIXTURE_NOW, {
      hooks: {
        afterReplacementStart: async () => {
          if (failOnce) {
            failOnce = false;
            throw new Error("INJECTED_RESTART_FAILURE");
          }
        },
      },
    });
    const previous = relay.descriptor;
    await assert.rejects(relay.restart("2026-09-02T00:00:01.000Z"), /INJECTED_RESTART_FAILURE/);
    const restored = await readConnectionDescriptor(relay.paths.descriptorPath);
    assert.equal(restored.generation, previous.generation);
    assert.equal((await probeProjectGlanceRelay(relay.paths.descriptorPath)).revision, 1);
    await Promise.all([
      relay.restart("2026-09-02T00:00:02.000Z"),
      relay.restart("2026-09-02T00:00:03.000Z"),
    ]);
    assert.notEqual(relay.descriptor.generation, previous.generation);
    assert.equal((await probeProjectGlanceRelay(relay.paths.descriptorPath)).revision, 1);
  } finally {
    await relay?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("root Project Glance verification leaves source dist artifacts untouched", async () => {
  // The outer root verifier owns this proof. Its disposable package copy must
  // not recursively invoke the root verifier against its temporary cwd.
  if (process.env.PI_PROJECT_GLANCE_VERIFIER_COPY === "1") return;
  const packageRoot = join(process.cwd());
  const dist = join(packageRoot, "dist");
  const sentinel = join(dist, "verifier-isolation-sentinel.txt");
  await mkdir(dist, { recursive: true });
  await writeFile(sentinel, "keep-me\n", "utf8");
  try {
    execFileSync(process.execPath, [
      join(process.cwd(), "../../scripts/verify-deployed-baseline.mjs"),
      "--product",
      "pi-project-glance",
    ], {
      cwd: join(process.cwd(), "../.."),
      env: { ...process.env, HERDR_ENV: "1" },
      stdio: "ignore",
    });
    assert.equal(await readFile(sentinel, "utf8"), "keep-me\n");
  } finally {
    await unlink(sentinel).catch(() => undefined);
  }
});
