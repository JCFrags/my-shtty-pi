import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import childProcess from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import fsPromises, { chmod, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import todo from "../../todo/index.ts";
import notes from "../../notes/index.ts";
import { createWorkplanExtension } from "../../workplan/index.ts";
import { BranchStateOwner, captureSourceIdentity, STATE_ANCHOR_TYPE } from "../src/index.ts";
import { publishPrivateBytes } from "../src/objects.ts";
import { sameDurableSource, sameSource, sourceKey, verifyDiskAnchor } from "../src/source.ts";
import { canonicalJson, hashText, STATE_STORE_LIMITS } from "../src/validation.ts";

class ProviderHost {
  handlers = new Map();
  listeners = new Map();
  tools = new Map();
  events = {
    on: (name, handler) => {
      const listeners = this.listeners.get(name) ?? new Set();
      listeners.add(handler); this.listeners.set(name, listeners);
      return () => listeners.delete(handler);
    },
    emit: (name, value) => { for (const listener of this.listeners.get(name) ?? []) listener(value); },
  };
  constructor(manager, root) {
    this.manager = manager;
    this.context = { sessionManager: manager, hasUI: false, ui: { notify() {}, setWidget() {} } };
    todo(this, { storeRoot: join(root, "todo"), settingsPath: join(root, "todo-settings.json"), outputRoot: root });
    notes(this, { storeRoot: join(root, "notes"), outputRoot: root });
    createWorkplanExtension(this, { storeRoot: join(root, "workplan") });
  }
  on(name, handler) {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler); this.handlers.set(name, handlers);
  }
  registerTool(tool) { this.tools.set(tool.name, tool); }
  registerCommand() {}
  registerShortcut() {}
  getActiveTools() { return [...this.tools.keys()]; }
  appendEntry(type, data) { this.manager.appendCustomEntry(type, data); }
  async lifecycle(name) {
    for (const handler of this.handlers.get(name) ?? []) await handler({ type: name }, this.context);
  }
  execute(name, input) {
    return this.tools.get(name).execute("fixture", input, new AbortController().signal, undefined, this.context);
  }
}

async function session(root) {
  const manager = SessionManager.create(root, root);
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Identity fixture" }],
    api: "openai-responses", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  await chmod(manager.getSessionFile(), 0o600);
  return manager;
}
const anchorHost = (manager) => ({ sessionManager: manager, appendEntry: (type, data) => manager.appendCustomEntry(type, data) });
const scopeOf = (manager) => ({ sessionId: manager.getSessionId(), leafId: manager.getLeafId() });

async function savedCursor(root, provider, manager) {
  const key = { version: 1, scope: scopeOf(manager), sourceKey: sourceKey(await captureSourceIdentity(manager)) };
  const path = join(root, provider, "resolutions", `${hashText(canonicalJson(key, STATE_STORE_LIMITS.recordBytes))}.json`);
  try { return { path, cursor: JSON.parse(await readFile(path, "utf8")) }; }
  catch (error) { if (error.code === "ENOENT") return { path }; throw error; }
}
async function immutableState(root, names) {
  const hashes = {};
  for (const name of names) {
    hashes[`${name}/store.json`] = hashText(await readFile(join(root, name, "store.json")));
    for (const directory of ["objects", "commits", "identities"]) {
      for (const file of (await readdir(join(root, name, directory))).sort()) {
        const path = `${name}/${directory}/${file}`;
        hashes[path] = hashText(await readFile(join(root, path)));
      }
    }
  }
  return hashes;
}
async function observeResolution(t, manager, root, names) {
  const immutable = await immutableState(root, names);
  t.diagnostic(`immutable baseline ${JSON.stringify(immutable)}`);
  let reads = 0;
  const getEntry = manager.getEntry.bind(manager);
  t.mock.method(manager, "getEntry", (id) => { reads++; return getEntry(id); });
  return async (name, phase, operation, maxReads = 128) => {
    const before = await readFile(manager.getSessionFile());
    reads = 0;
    let result, error;
    try { result = await operation(); } catch (caught) { error = caught; }
    const count = reads;
    assert.ok(count <= maxReads, `${name} ${phase} read ${count} entries`);
    assert.deepEqual(await readFile(manager.getSessionFile()), before, "resolution must not change source bytes");
    assert.deepEqual(await immutableState(root, names), immutable, "resolution must preserve immutable state");
    const { cursor } = await savedCursor(root, name, manager);
    const nextIndex = cursor?.nextEntryId === null ? -1 : cursor
      ? manager.getEntries().findIndex(entry => entry.id === cursor.nextEntryId) : undefined;
    if (cursor?.nextEntryId) assert.ok(nextIndex >= 0, "saved next entry must exist");
    t.diagnostic(JSON.stringify({ name, phase, reads: count, leafId: manager.getLeafId(),
      nextEntryId: cursor?.nextEntryId, nextIndex, scanned: cursor?.scanned, head: cursor?.head,
      legacySeen: cursor?.legacySeen, error: error?.message, result,
      source: { bytes: before.length, sha256: hashText(before) }, immutablePreserved: true }));
    return { result, error, cursor, nextIndex, reads: count };
  };
}

test("native calls finish bounded pages across moving leaves and cold owners", async (t) => {
  const root = await mkdtemp(join(process.cwd(), ".state-ancestry-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = await session(root);
  let providers = new ProviderHost(manager, root);
  await providers.lifecycle("session_start");
  await providers.execute("todo", { action: "add", text: "Retain task" });
  await providers.execute("notes", { action: "add", title: "Retain note", body: "Exact body" });
  await providers.execute("workplan", { action: "create", content: { title: "Retain plan", objective: "Stay ready", approach: "Resolve bounded pages" } });
  const inputs = { todo: { action: "list" }, notes: { action: "read", id: "N1" }, workplan: { action: "read", planId: "WP1" } };
  const names = Object.keys(inputs), expected = {};
  for (const name of names) expected[name] = await providers.execute(name, inputs[name]);
  const observe = await observeResolution(t, manager, root, names);
  const read = (name, phase) => observe(name, phase, () => providers.execute(name, inputs[name]), 32 * 128);
  const append = (text) => manager.appendMessage({ role: "user", content: text, timestamp: 0 });
  const appendResult = (name, phase, isError) => manager.appendMessage({ role: "toolResult",
    toolCallId: `${phase}-${name}`, toolName: name, content: [{ type: "text", text: phase }], isError, timestamp: 0 });
  for (let index = 0; index < 300; index++) append(`Ordinary message ${index}`);
  for (const name of names) {
    append(`First native read ${name}`);
    const observed = await read(name, "first-ready");
    assert.equal(observed.error, undefined);
    assert.deepEqual(observed.result, expected[name]);
    assert.ok(observed.reads > 128, "one native call must advance more than one page");
    appendResult(name, "first-ready", false);
  }
  for (const name of names) {
    append(`Moving leaf ${name}`);
    const moved = await read(name, "moving-ready");
    assert.equal(moved.error, undefined);
    assert.deepEqual(moved.result, expected[name]);
    assert.ok(moved.reads <= 8, `${name} restarted a completed ancestry walk`);
    appendResult(name, "moving-ready", false);
  }
  const coldStart = async (phase) => {
    await providers.lifecycle("session_shutdown");
    providers = new ProviderHost(manager, root);
    append(phase);
    for (const [index, handler] of providers.handlers.get("session_start").entries()) {
      const observed = await observe(names[index], phase, () => handler({ type: "session_start" }, providers.context));
      assert.equal(observed.error, undefined);
    }
  };
  await coldStart("cold-after-pages");
  for (let turn = 0; turn < 2; turn++) {
    for (const name of names) {
      append(`Normal continuation ${turn} ${name}`);
      const observed = await read(name, `ready-${turn}`);
      assert.equal(observed.error, undefined);
      assert.deepEqual(observed.result, expected[name]);
      assert.ok(observed.reads <= 8, `${name} restarted a completed ancestry walk`);
      appendResult(name, `ready-${turn}`, false);
    }
  }
  await coldStart("cold-ready");
  for (const name of names) {
    append(`After cold owner ${name}`);
    const observed = await read(name, "after-cold-ready");
    assert.equal(observed.error, undefined);
    assert.deepEqual(observed.result, expected[name]);
  }
  await providers.lifecycle("session_shutdown");

  // A retained signature must also permit progress at the smallest supported page size.
  const small = SessionManager.inMemory(), host = anchorHost(small);
  const options = { providerId: "todo", storeRoot: join(root, "one-entry"), ancestryPageEntries: 1,
    validateRoot: (value) => assert.deepEqual(value, { value: 7 }), isLegacyEntry: () => false };
  let owner = new BranchStateOwner(options);
  assert.equal((await owner.resolve(host)).status, "empty");
  const committed = await owner.commit(host, { value: 7 }, { expectedCommitId: null, durability: "allow-volatile" });
  for (let index = 0; index < 3; index++) small.appendMessage({ role: "user", content: "Ordinary message", timestamp: 0 });
  let reads = 0;
  const smallGetEntry = small.getEntry.bind(small);
  t.mock.method(small, "getEntry", (id) => { reads++; return smallGetEntry(id); });
  for (let page = 0; page < 4; page++) {
    owner.close(); owner = new BranchStateOwner(options); reads = 0;
    const result = await owner.resolve(host);
    assert.equal(reads, 1);
    assert.equal(result.status, page === 3 ? "ready" : "pending");
    if (result.status === "ready") assert.equal(result.snapshot.commitId, committed.commitId);
    t.diagnostic(JSON.stringify({ phase: "one-entry", page, reads, status: result.status }));
    if (page === 0) {
      const saved = await savedCursor(root, "one-entry", small);
      const { head, ...oldCursor } = saved.cursor;
      assert.ok(head);
      await writeFile(saved.path, JSON.stringify(oldCursor), { mode: 0o600 });
      owner.close(); owner = new BranchStateOwner(options); reads = 0;
      assert.equal((await owner.resolve(host)).status, "pending");
      assert.equal(reads, 1, "old head recovery must use the one-entry budget");
      const restored = (await savedCursor(root, "one-entry", small)).cursor;
      assert.equal(restored.head, head);
      assert.equal(restored.nextEntryId, oldCursor.nextEntryId);
      t.diagnostic(JSON.stringify({ phase: "old-head-recovery", reads, nextEntryId: restored.nextEntryId }));
    }
  }
  owner.close();
});

test("native paging preserves explicit legacy import refusal and excludes an off-branch suffix", async (t) => {
  const root = await mkdtemp(join(process.cwd(), ".state-legacy-ancestry-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = await session(root), providers = new ProviderHost(manager, root);
  await providers.lifecycle("session_start");
  await providers.execute("todo", { action: "add", text: "Clean task" });
  await providers.execute("notes", { action: "add", title: "Clean note", body: "Unchanged body" });
  const inputs = { todo: { action: "list" }, notes: { action: "read", id: "N1" } };
  const names = Object.keys(inputs), expected = {};
  for (const name of names) expected[name] = await providers.execute(name, inputs[name]);
  const observe = await observeResolution(t, manager, root, names);
  const append = (text) => manager.appendMessage({ role: "user", content: text, timestamp: 0 });
  for (let index = 0; index < 300; index++) append(`Clean prefix ${index}`);
  const cleanLeaf = manager.getLeafId();
  // These markers require explicit import. This check never replays their payloads.
  for (const provider of names) manager.appendCustomEntry("grounded-state-checkpoint-v1", { version: 1, provider });
  for (const name of names) {
    append(`Legacy native read ${name}`);
    const observed = await observe(name, "legacy-first", () => providers.execute(name, inputs[name]), 32 * 128);
    assert.equal(observed.result, undefined, "legacy ancestry cannot expose an older owned root");
    assert.match(observed.error?.message ?? "", /STATE_CONFLICT.*legacy state requires/);
    assert.equal(observed.cursor.legacySeen, true);
    assert.equal(observed.cursor.nextEntryId, null);
  }
  for (const name of names) {
    append(`Legacy continuation ${name}`);
    const observed = await observe(name, "legacy-moving", () => providers.execute(name, inputs[name]), 32 * 128);
    assert.equal(observed.result, undefined, "new input does not authorize legacy import");
    assert.match(observed.error?.message ?? "", /STATE_CONFLICT.*legacy state requires/);
    assert.equal(observed.cursor.legacySeen, true);
    assert.equal(observed.cursor.nextEntryId, null);
  }
  manager.branch(cleanLeaf);
  await providers.lifecycle("session_tree");
  for (const name of names) {
    append(`Clean branch ${name}`);
    const observed = await observe(name, "clean-branch", () => providers.execute(name, inputs[name]), 32 * 128);
    assert.equal(observed.error, undefined);
    assert.deepEqual(observed.result, expected[name], "off-branch legacy state must not be selected");
  }
  await providers.lifecycle("session_shutdown");
});

// One focused scenario. The only simulated field is the session descriptor's st_dev.
// The source bytes, Btrfs identity subprocess, immutable objects, Pi manager, and tools are real.
test("Btrfs reboot identity preserves providers, proves legacy recovery, and refuses replacement", async (t) => {
  const root = await mkdtemp(join(process.cwd(), ".state-identity-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = await session(root);
  const initialSource = await captureSourceIdentity(manager);
  if (!initialSource.identity) { t.skip("Requires Linux Btrfs and GNU stat for the supported durable identity"); return; }
  const handle = await open(manager.getSessionFile());
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  let device = 53, statCalls = 0, statMilliseconds = 0;
  let replaceDuringProbe;
  const sourceInodes = new Set([initialSource.inode]);
  const realStat = prototype.stat;
  t.mock.method(prototype, "stat", async function (...args) {
    const info = await realStat.apply(this, args);
    if (sourceInodes.has(String(info.ino))) info.dev = typeof info.dev === "bigint" ? BigInt(device) : device;
    return info;
  });
  const realLstat = fsPromises.lstat;
  const lstatMock = t.mock.method(fsPromises, "lstat", async (...args) => {
    const info = await realLstat(...args);
    if (sourceInodes.has(String(info.ino))) info.dev = typeof info.dev === "bigint" ? BigInt(device) : device;
    return info;
  });
  const realSpawn = childProcess.spawn;
  const spawnMock = t.mock.method(childProcess, "spawn", function (...args) {
    const start = performance.now();
    const child = realSpawn.apply(this, args);
    if (args[0] === "/usr/bin/stat") {
      statCalls++;
      child.once("close", () => { statMilliseconds += performance.now() - start; });
      if (replaceDuringProbe) { const replace = replaceDuringProbe; replaceDuringProbe = undefined; replace(); }
    }
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { spawnMock.mock.restore(); lstatMock.mock.restore(); syncBuiltinESMExports(); });

  let providers = new ProviderHost(manager, root);
  await providers.lifecycle("session_start");
  await providers.execute("todo", { action: "add", text: "Retain task", description: "Exact details" });
  await providers.execute("notes", { action: "add", title: "Retain note", body: "Exact note\nSecond line" });
  await providers.execute("workplan", { action: "create", content: { title: "Retain plan", objective: "Preserve identity", approach: "Verify receipts" } });
  const firstLeaf = manager.getLeafId();
  const before = {
    todo: (await providers.execute("todo", { action: "list" })).details,
    notes: (await providers.execute("notes", { action: "read", id: "N1" })).details,
    workplan: (await providers.execute("workplan", { action: "recover", planId: "WP1" })).content,
  };
  const prefix = await readFile(manager.getSessionFile());
  await providers.lifecycle("session_shutdown");
  device = 54;
  const reopened = SessionManager.open(manager.getSessionFile());
  providers = new ProviderHost(reopened, root);
  await providers.lifecycle("session_start");
  assert.deepEqual((await providers.execute("todo", { action: "list" })).details, before.todo);
  assert.deepEqual((await providers.execute("notes", { action: "read", id: "N1" })).details, before.notes);
  assert.deepEqual((await providers.execute("workplan", { action: "recover", planId: "WP1" })).content, before.workplan);
  assert.deepEqual(await readFile(manager.getSessionFile()), prefix, "reopen must not rewrite or append native state");
  await providers.execute("todo", { action: "add", text: "Second task" });
  await providers.execute("notes", { action: "append", id: "N1", expectedRevision: 1, body: "After reboot" });
  await providers.execute("workplan", { action: "checkpoint", planId: "WP1", expectedRevision: 1, content: { summary: "After reboot" } });
  reopened.branch(firstLeaf);
  await providers.lifecycle("session_tree");
  assert.deepEqual((await providers.execute("todo", { action: "list" })).details, before.todo);
  assert.deepEqual((await providers.execute("notes", { action: "read", id: "N1" })).details, before.notes);
  assert.deepEqual((await providers.execute("workplan", { action: "recover", planId: "WP1" })).content, before.workplan);
  const sourceBytes = await readFile(reopened.getSessionFile());
  await rename(reopened.getSessionFile(), `${reopened.getSessionFile()}.original`);
  await writeFile(reopened.getSessionFile(), sourceBytes, { mode: 0o600 });
  for (const name of ["todo", "notes", "workplan"]) {
    await assert.rejects(() => providers.execute(name, { action: "list" }), /state-store-source-changed/);
  }
  await providers.lifecycle("session_shutdown");

  // Construct an old-format commit, without rewriting any immutable object.
  device = 53;
  const legacyManager = await session(root);
  sourceInodes.add((await captureSourceIdentity(legacyManager)).inode);
  const host = anchorHost(legacyManager);
  const options = { providerId: "todo", storeRoot: join(root, "legacy"),
    validateRoot: (value) => assert.equal(value.value, 7), isLegacyEntry: () => false };
  let owner = new BranchStateOwner(options);
  const current = await captureSourceIdentity(legacyManager);
  const { identity, ...source } = current;
  const rootRef = await owner.objects.publish({ value: 7 });
  const record = { version: 1, commitId: randomUUID(), parentCommitId: null, rootRef, origin: scopeOf(legacyManager), source };
  const commitRef = await owner.objects.publish(record);
  const data = { version: 1, providerId: "todo", storeId: commitRef.storeId, commitRef };
  legacyManager.appendCustomEntry(STATE_ANCHOR_TYPE, data);
  const anchor = legacyManager.getEntry(legacyManager.getLeafId());
  const proof = await verifyDiskAnchor(source, record.origin, data, anchor);
  const receipt = { version: 1, commitRef, anchor, durability: "disk",
    proof: { offset: proof.offset, bytes: proof.bytes, lineHash: proof.lineHash } };
  const location = await owner.objects.location();
  const receiptPath = join(location.root, "commits", `${record.commitId}.json`);
  await publishPrivateBytes(receiptPath, Buffer.from(canonicalJson(receipt, STATE_STORE_LIMITS.recordBytes)));
  const originalCommit = await readFile(join(location.root, "objects", `${commitRef.hash}.json`));
  const originalReceipt = await readFile(receiptPath);
  const originalSource = await readFile(legacyManager.getSessionFile());
  const expectedPrefix = { bytes: originalSource.length, sha256: hashText(originalSource) };
  assert.equal((await owner.resolve(host)).status, "ready", "unchanged legacy source remains readable");
  owner.close();
  device = 54;
  owner = new BranchStateOwner(options);
  await assert.rejects(() => owner.resolve(host), /state-store-source-recovery-required/);
  const target = await captureSourceIdentity(legacyManager);
  const evidence = { authorization: "independent-prefix-sha256", commitRef, scope: scopeOf(legacyManager), source, target, prefix: expectedPrefix };
  await assert.rejects(() => owner.recoverSourceIdentity(host, { ...evidence, prefix: { ...expectedPrefix, sha256: "0".repeat(64) } }), /state-store-source-changed/);
  assert.deepEqual(await readdir(join(location.root, "identities")), [], "bad independent evidence cannot publish recovery");
  await assert.rejects(() => owner.recoverSourceIdentity(host, { ...evidence, scope: { ...evidence.scope, leafId: "wrong-branch" } }), /state-store-conflict/);
  const recovered = await owner.recoverSourceIdentity(host, evidence);
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.snapshot.commitId, record.commitId);
  assert.deepEqual(recovered.snapshot.root, { value: 7 });
  assert.deepEqual(await readFile(legacyManager.getSessionFile()), originalSource);
  assert.deepEqual(await readFile(receiptPath), originalReceipt);
  assert.deepEqual(await readFile(join(location.root, "objects", `${commitRef.hash}.json`)), originalCommit);
  const recoveryPath = join(location.root, "identities", `${record.commitId}.json`);
  const recoveryBytes = await readFile(recoveryPath);
  assert.deepEqual(JSON.parse(recoveryBytes).prefix, expectedPrefix);
  owner.close();
  device = 55;
  owner = new BranchStateOwner(options);
  assert.equal((await owner.resolve(host)).snapshot.commitId, record.commitId, "recovered identity survives another reboot");
  assert.deepEqual(await readFile(recoveryPath), recoveryBytes);
  // The durable comparator rejects a different subvolume/filesystem or file generation.
  assert.equal(sameDurableSource(target, { ...target, identity: { ...identity, filesystemId: "1" } }), false);
  assert.equal(sameDurableSource(target, { ...target, identity: { ...identity, birthtimeNs: "1" } }), false);
  assert.equal(sameSource(source, { ...source, device: "99" }), false, "unsupported identity keeps strict device checks");
  await rename(legacyManager.getSessionFile(), `${legacyManager.getSessionFile()}.original`);
  await writeFile(legacyManager.getSessionFile(), originalSource, { mode: 0o600 });
  await assert.rejects(() => owner.resolve(host), /state-store-source-changed/);
  owner.close();
  const racingManager = await session(root);
  const racingFile = racingManager.getSessionFile();
  const racingBytes = await readFile(racingFile);
  replaceDuringProbe = () => {
    renameSync(racingFile, `${racingFile}.original`);
    writeFileSync(racingFile, racingBytes, { mode: 0o600 });
  };
  await assert.rejects(() => captureSourceIdentity(racingManager), /state-store-scope-changed/,
    "replacement during the FD statfs probe must not return an identity for the old pathname");
  t.diagnostic(`${statCalls} bounded GNU stat calls, ${statMilliseconds.toFixed(1)} ms total child time, ${(statMilliseconds / statCalls).toFixed(2)} ms mean`);
});
