const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const net = require("node:net");
const fs = require("node:fs");
const test = require("node:test");
const { daemonRequest } = require("../dist/daemon-status.js");
const { connectionInventory } = require("../dist/connections.js");
const { safeDaemonStatus } = require("../dist/doctor.js");
const { reuseOriginBrowser } = require("../dist/origin-open.js");
const { DAEMON_SOCKET, INTEROP_INSTANCES_DIR, RUNTIME_IDENTITY } = require("pixel-store");

test("connection inventory is complete metadata only and refuses legacy or uncertain status", async t => {
  const identity = RUNTIME_IDENTITY;
  const owner = { workspaceId: "terminal-browser:cli", tabId: "project:a", paneId: "session:a", sessionId: "task-a", projectDir: "/tmp/project" };
  const origin = { schemaVersion: 1, generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", piSessionId: "pi-a", piSessionFile: null };
  const entry = { key: "123-1", owner, origin, terminal: null, tab: null, pane: null };
  const value = { ok: true, identity, sessions: [entry], complete: true };
  assert.deepEqual(safeDaemonStatus(value, true), { identity, sessions: [entry], complete: true });
  const legacy = { ...value, sessions: [{ key: entry.key, owner: { workspaceId: owner.workspaceId, tabId: owner.tabId, paneId: owner.paneId }, terminal: null, tab: null, pane: null }] };
  assert.deepEqual(safeDaemonStatus(legacy).sessions, legacy.sessions);
  assert.throws(() => safeDaemonStatus(legacy, true), error => error.code === "RUNTIME_MISMATCH" && /legacy loaded/.test(error.message));
  t.mock.method(net, "connect", () => {
    const connection = new EventEmitter();
    connection.destroy = () => {};
    connection.write = raw => { assert.deepEqual(JSON.parse(raw), { cmd: "status" }); queueMicrotask(() => connection.emit("data", Buffer.from(JSON.stringify(value) + "\n"))); };
    queueMicrotask(() => connection.emit("connect"));
    return connection;
  });
  const result = await connectionInventory();
  assert.deepEqual(result.sessions, [entry]);
  assert.equal(result.instancesDirectory, INTEROP_INSTANCES_DIR);
  assert.equal(result.schemaVersion, 1);
  t.mock.restoreAll();
  const commands = [];
  t.mock.method(net, "connect", socket => {
    const connection = new EventEmitter(); connection.destroy = () => {};
    connection.write = raw => {
      const request = JSON.parse(raw); commands.push(request.cmd);
      const response = socket === DAEMON_SOCKET ? value : { id: request.id, ok: true, data: request.cmd === "hello" ? { identity, key: entry.key, owner, origin, where: { terminal: null, pane: null } } : { state: "human", controlEpoch: 2 } };
      queueMicrotask(() => connection.emit("data", Buffer.from(JSON.stringify(response) + "\n")));
    };
    queueMicrotask(() => connection.emit("connect"));
    return connection;
  });
  assert.deepEqual((await reuseOriginBrowser(owner, origin)).origin, origin);
  await assert.rejects(reuseOriginBrowser(owner, origin, "https://example.test/"), error => error.code === "CONTROL_NOT_AGENT");
  assert.equal(commands.includes("targets"), false); assert.equal(commands.includes("agent.navigate"), false);
  entry.origin = null;
  await assert.rejects(reuseOriginBrowser(owner, origin), error => error.code === "STATE_CHANGED");
  entry.origin = origin;
  t.mock.restoreAll();
  for (const code of ["ENOENT", "EACCES", "ECONNREFUSED"]) {
    t.mock.method(net, "connect", () => {
      const connection = new EventEmitter(); connection.destroy = () => {};
      queueMicrotask(() => connection.emit("error", Object.assign(new Error("unavailable"), { code })));
      return connection;
    });
    t.mock.method(fs, "lstatSync", file => { assert.equal(file, DAEMON_SOCKET); throw Object.assign(new Error("absent"), { code: "ENOENT" }); });
    if (code === "ENOENT") assert.deepEqual(await connectionInventory(), { schemaVersion: 1, instancesDirectory: INTEROP_INSTANCES_DIR, identity: null, matchesCandidate: null, sessions: [], complete: true });
    else await assert.rejects(connectionInventory(), error => error.code === code);
    t.mock.restoreAll();
  }
});

test("daemon status preserves missing and inaccessible socket error codes without private messages", async t => {
  for (const code of ["ENOENT", "EACCES", "ECONNREFUSED"]) {
    const connection = new EventEmitter();
    connection.destroy = () => {};
    connection.write = () => {};
    t.mock.method(net, "connect", () => {
      queueMicrotask(() => connection.emit("error", Object.assign(new Error("private socket details"), { code })));
      return connection;
    });
    await assert.rejects(daemonRequest({ cmd: "status" }), error => {
      assert.equal(error.code, code);
      assert.equal(error.message, "daemon status unavailable");
      return true;
    });
    t.mock.restoreAll();
  }
});
