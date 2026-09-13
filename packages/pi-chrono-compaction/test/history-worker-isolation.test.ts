import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { appendFile, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/pi-extension.js";
import { handleHistoryWorkerRequest } from "../src/history-worker-handler.js";
import { dispatchHistoryWorker, historyWorkerAdmissionStatus, validateHistoryWorkerWire } from "../src/history-worker-dispatch.js";
import { HISTORY_WORKER_CAPS, type HistoryOperation, type HistoryWorkerTransport } from "../src/history-worker-contract.js";
import { readBoundedHistorySidecar } from "../src/history-worker-bounded-read.js";
import { appendMemoryEvent, memorySidecarPath, readMemoryEvents } from "../src/memory-store.js";
import { parseSessionJsonl } from "../src/jsonl.js";
import { historyGet, historyRange, historySearch } from "../src/retrieval.js";
import { buildLocalSearchIndex, renderRankedSearch, searchLocalHistory } from "../src/search-index.js";
import { buildCausalMemory } from "../src/causal-memory.js";
import { recallHistory, renderRecall } from "../src/recall.js";

const text = [
  { type: "session", version: 3, id: "history-worker-synthetic" },
  { type: "message", id: "u1", parentId: null, message: { role: "user", content: "alpha parser work in src/parser.ts" } },
  { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "alpha parser fixed" }] } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
// Explicit synthetic-only adapter. This tests semantics/dispatch, NOT OS containment.
const syntheticTransport: HistoryWorkerTransport = { isolation: "os-bounded-child-v1", run: async (wire) => handleHistoryWorkerRequest(wire) };
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "chrono-history-worker-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "session.jsonl");
  await writeFile(path, text, { mode: 0o600 });
  return { directory, path };
}

test("small persisted get/range/legacy/ranked/recall preserve exact existing render semantics", async (t) => {
  const { path } = await fixture(t);
  const session = parseSessionJsonl(text), index = buildLocalSearchIndex(session);
  const operations: [HistoryOperation, string][] = [
    [{ kind: "get", entryId: "u1", options: {} }, historyGet(session, "u1")],
    [{ kind: "range", startEntryId: "u1", endEntryId: "a1", options: {} }, historyRange(session, "u1", "a1")],
    [{ kind: "legacy-search", query: "alpha", options: {} }, historySearch(session, "alpha")],
    [{ kind: "search", query: "alpha", options: {} }, renderRankedSearch(searchLocalHistory(index, "alpha"))],
    [{ kind: "recall", query: "alpha", options: {} }, renderRecall(recallHistory(index, buildCausalMemory(index.documents.map((d) => d.block), index.resourceLineage), "alpha"))],
  ];
  for (const [operation, expected] of operations) {
    const response = await dispatchHistoryWorker(path, operation, syntheticTransport);
    assert.equal(response.status, "ok", JSON.stringify(response));
    if (response.status === "ok") assert.equal(response.text, expected);
    assert.equal(historyWorkerAdmissionStatus().totalBytes, 0);
  }
});

test("reservation covers child and bounded IPC before transport; missing capabilities and oversize refuse without running", async (t) => {
  const { path } = await fixture(t);
  const op: HistoryOperation = { kind: "search", query: "alpha", options: {} };
  assert.deepEqual(await dispatchHistoryWorker(path, op), { status: "refused", code: "history-worker-unavailable" });
  assert.deepEqual(await dispatchHistoryWorker(undefined, op, syntheticTransport), { status: "refused", code: "history-source-unpersisted" });
  let calls = 0;
  const transport: HistoryWorkerTransport = { isolation: "os-bounded-child-v1", async run(wire, caps) {
    calls++;
    assert.equal(caps, HISTORY_WORKER_CAPS);
    assert.ok(historyWorkerAdmissionStatus().totalBytes > caps.memoryBytes);
    const request = JSON.parse(wire);
    assert.deepEqual(Object.keys(request).sort(), ["operation", "path", "source", "version"]);
    assert.equal(request.session, undefined);
    return handleHistoryWorkerRequest(wire);
  } };
  await dispatchHistoryWorker(path, op, transport);
  assert.equal(calls, 1);
  await writeFile(path, text + " ".repeat(5 * 1024 * 1024));
  assert.deepEqual(await dispatchHistoryWorker(path, op, transport), { status: "refused", code: "history-index-memory-limit" });
  assert.equal(calls, 1);
  const oversizedQuery = { ...op, query: "q".repeat(5000) };
  assert.equal((await dispatchHistoryWorker(path, oversizedQuery, transport)).status, "refused");
  assert.equal(calls, 1);
});

test("source replacement after admission is refused; symlinks and unsafe source types never dispatch", async (t) => {
  const { directory, path } = await fixture(t);
  const op: HistoryOperation = { kind: "get", entryId: "u1", options: {} };
  const transport: HistoryWorkerTransport = { isolation: "os-bounded-child-v1", async run(wire) {
    const replacement = join(directory, "replacement"); await writeFile(replacement, text);
    await rename(replacement, path);
    return handleHistoryWorkerRequest(wire);
  } };
  assert.deepEqual(await dispatchHistoryWorker(path, op, transport), { status: "refused", code: "history-source-changed" });
  const link = join(directory, "link"); await symlink(path, link);
  assert.deepEqual(await dispatchHistoryWorker(link, op, syntheticTransport), { status: "refused", code: "history-source-unsafe-type" });
});

test("bounded responses reject full indexes, huge payloads, and failed jobs without local reruns", async (t) => {
  const { path } = await fixture(t);
  const op: HistoryOperation = { kind: "search", query: "alpha", options: {} };
  let calls = 0;
  for (const run of [
    async () => JSON.stringify({ status: "ok", text: "x", details: {}, index: { documents: [] } }),
    async () => "x".repeat(HISTORY_WORKER_CAPS.responseBytes + 1),
    async () => { throw new Error("private child error must not escape"); },
  ]) {
    const response = await dispatchHistoryWorker(path, op, { isolation: "os-bounded-child-v1", async run() { calls++; return run(); } });
    assert.equal(response.status, "refused");
    assert.ok(!JSON.stringify(response).includes("private"));
    assert.equal(historyWorkerAdmissionStatus().totalBytes, 0);
  }
  assert.equal(calls, 3);
});

test("concurrent admission and aborted calls release all reservation space", async (t) => {
  const { path } = await fixture(t);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let active = 0;
  const transport: HistoryWorkerTransport = { isolation: "os-bounded-child-v1", async run(wire) { active++; await waiting; return handleHistoryWorkerRequest(wire); } };
  const op: HistoryOperation = { kind: "search", query: "alpha", options: {} };
  const pending = Array.from({ length: 8 }, () => dispatchHistoryWorker(path, op, transport));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(active <= 3);
  release();
  const responses = await Promise.all(pending);
  assert.ok(responses.some((response) => response.status === "refused"));
  assert.ok(responses.some((response) => response.status === "ok"));
  const abort = new AbortController(); abort.abort();
  assert.deepEqual(await dispatchHistoryWorker(path, op, transport, abort.signal), { status: "refused", code: "history-worker-aborted" });
  assert.equal(historyWorkerAdmissionStatus().totalBytes, 0);
});

test("strict sidecar reader refuses growth/replacement before reads and never reads beyond an opened checkpoint", async (t) => {
  const { directory } = await fixture(t);
  const path = join(directory, "sidecar");
  for (const mode of ["growth", "replacement"]) {
    await writeFile(path, "x".repeat(100), { mode: 0o600 });
    let reads = 0;
    await assert.rejects(readBoundedHistorySidecar(path, 128, {
      async afterOpened() {
        if (mode === "growth") await appendFile(path, "y".repeat(1000));
        else { const replacement = path + ".new"; await writeFile(replacement, "z".repeat(1000), { mode: 0o600 }); await rename(replacement, path); }
      }, onRead() { reads++; },
    }), /history-promotion-source-changed/);
    assert.equal(reads, 0);
  }
  await writeFile(path, "x".repeat(100), { mode: 0o600 });
  let observed = 0;
  await assert.rejects(readBoundedHistorySidecar(path, 99, { onRead(_requested, actual) { observed += actual; } }), /history-promotion-source-too-large/);
  assert.equal(observed, 0);
  assert.equal((await readBoundedHistorySidecar(path, 100)).length, 100);
});

test("bounded append uses strict reread inside transaction and does not replace oversize sidecars", async (t) => {
  const { path } = await fixture(t);
  const sidecar = memorySidecarPath(path);
  await appendMemoryEvent(sidecar, { action: "remember", text: "alpha memory", sourceRef: "synthetic", timestamp: "2026-01-01T00:00:00Z", turn: 0 });
  const before = await readFile(sidecar, "utf8"), size = Buffer.byteLength(before);
  const memory = await readMemoryEvents(sidecar);
  await assert.rejects(appendMemoryEvent(sidecar, { action: "touch", memoryId: memory.memories[0]!.memoryId, sourceRef: "synthetic", timestamp: "2026-01-01T00:00:01Z", turn: 1 }, { maxReadBytes: size - 1 }), /history-promotion-source-too-large/);
  assert.equal(await readFile(sidecar, "utf8"), before);
});

test("registered tools keep synthetic persisted search, exact retrieval, and recall promotion connected; ephemeral never enumerates", async (t) => {
  const { directory, path } = await fixture(t);
  const saved = process.env.PI_CHRONO_CONFIG_PATH;
  process.env.PI_CHRONO_CONFIG_PATH = join(directory, "compatibility-config.json");
  await writeFile(process.env.PI_CHRONO_CONFIG_PATH, JSON.stringify({ memoryEngineEnabled: false }), { mode: 0o600 });
  t.after(async () => { if (saved === undefined) delete process.env.PI_CHRONO_CONFIG_PATH; else process.env.PI_CHRONO_CONFIG_PATH = saved; });
  const tools = new Map<string, (...args: any[]) => Promise<any>>(), appended: any[] = [];
  const hooks = new Map<string, () => void>();
  extension({ registerTool(tool: any) { tools.set(tool.name, tool.execute); }, registerCommand() {}, on(name: string, callback: () => void) { hooks.set(name, callback); }, appendEntry(_kind: string, event: any) { appended.push(event); }, sendMessage() {} } as unknown as ExtensionAPI, { historyTransport: syntheticTransport });
  t.after(async () => { hooks.get("session_shutdown")?.(); });
  const ctx = { sessionManager: { getSessionFile: () => path, getLeafId: () => "a1", getEntries() { throw new Error("must not enumerate entries"); }, getBranch() { throw new Error("must not enumerate branch"); } } };
  const sidecar = memorySidecarPath(path);
  await appendMemoryEvent(sidecar, { action: "remember", text: "alpha memory", sourceRef: "synthetic", timestamp: "2026-01-01T00:00:00Z", turn: 0 });
  for (const [name, params] of [["history_get", { entryId: "u1" }], ["history_range", { startEntryId: "u1", endEntryId: "a1" }], ["history_search", { query: "alpha" }], ["history_recall", { query: "alpha" }]] as const) {
    const result = await tools.get(name)!("synthetic-call", params, undefined, undefined, ctx);
    assert.equal(result.details.code, undefined, name + JSON.stringify(result));
    assert.ok(result.content[0].text.includes("alpha"));
  }
  const promoted = await readMemoryEvents(sidecar);
  assert.equal(promoted.memories[0]!.useCount, 1);
  assert.equal(promoted.memories[0]!.lastUsedTurn, 2);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].action, "touch");
  ctx.sessionManager.getSessionFile = () => undefined as any;
  for (const [name, params] of [["history_get", { entryId: "u1" }], ["history_range", { startEntryId: "u1", endEntryId: "a1" }], ["history_search", { query: "alpha" }], ["history_recall", { query: "alpha" }]] as const) {
    const result = await tools.get(name)!("synthetic-call", params, undefined, undefined, ctx);
    assert.equal(result.details.code, "history-source-unpersisted");
  }
});

test("child refuses oversized final output and promotion sidecars rather than returning changed semantics", async (t) => {
  const { path } = await fixture(t);
  const large = [JSON.stringify({ type: "session", version: 3 }), JSON.stringify({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "alpha" } }), ...Array.from({ length: 20 }, (_, i) => JSON.stringify({ type: "message", id: String(i) + "u".repeat(4000), parentId: "u1", message: { role: "user", content: "alpha" } }))].join("\n");
  await writeFile(path, large);
  const output = await dispatchHistoryWorker(path, { kind: "get", entryId: "u1", options: { contextAfter: 20 } }, syntheticTransport);
  assert.equal(output.status, "refused");
  await writeFile(path, text);
  await writeFile(memorySidecarPath(path), " ".repeat(256 * 1024 + 1), { mode: 0o600 });
  const response = await dispatchHistoryWorker(path, { kind: "recall", query: "alpha", options: {}, promotion: { toolCallId: "synthetic-call", leafId: "a1" } }, syntheticTransport);
  assert.deepEqual(response, { status: "refused", code: "history-promotion-unavailable" });
  assert.ok((await stat(memorySidecarPath(path))).size > 256 * 1024);
});


test("stage frames are strict, bounded, and emitted only for performed work", async (t) => {
  const { path } = await fixture(t);
  const frames: string[] = [];
  const transport: HistoryWorkerTransport = { isolation: "os-bounded-child-v1", async run(wire) {
    const response = await handleHistoryWorkerRequest(wire, (stage) => frames.push(JSON.stringify({ status: "stage", stage })));
    assert.equal(validateHistoryWorkerWire(response), response);
    assert.equal(validateHistoryWorkerWire(validateHistoryWorkerWire(response)), response);
    return response;
  } };
  await dispatchHistoryWorker(path, { kind: "get", entryId: "u1", options: {} }, transport);
  assert.deepEqual(frames.map((frame) => JSON.parse(frame).stage), ["validate", "admit", "read", "query", "respond"]);
  for (const frame of frames) assert.equal(validateHistoryWorkerWire(frame), undefined);
  frames.length = 0;
  await dispatchHistoryWorker(path, { kind: "search", query: "alpha", options: {} }, transport);
  assert.deepEqual(frames.map((frame) => JSON.parse(frame).stage), ["validate", "admit", "read", "index", "query", "respond"]);
  for (const value of [{ status: "stage", stage: "made-up" }, { status: "stage", stage: "read", sourceText: "forbidden" }, { status: "pending" }, { status: "ok", text: "x", details: {}, index: [] }]) assert.throws(() => validateHistoryWorkerWire(JSON.stringify(value)), /history-response-invalid/);
});


test("IPC-only child sends validated stages and one bounded final string", async (t) => {
  const { path } = await fixture(t);
  const source = await stat(path);
  const request = JSON.stringify({ version: 1, path, source: { deviceId: String(source.dev), inodeId: String(source.ino), size: source.size, mtimeMs: source.mtimeMs }, operation: { kind: "search", query: "alpha", options: {} } });
  // Plumbing test only. Production OS containment is the shared runtime's gate.
  const child = fork(new URL("../src/history-worker-entry.js", import.meta.url), [], { execArgv: ["--max-old-space-size=80"], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const stages: string[] = [], finals: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("synthetic IPC test timeout")); }, 10_000);
    child.on("message", (wire) => {
      try {
        const final = validateHistoryWorkerWire(wire);
        if (final === undefined) stages.push(JSON.parse(wire as string).stage);
        else finals.push(final);
      } catch (error) { reject(error); }
    });
    child.on("error", reject);
    child.on("exit", (code) => { clearTimeout(timeout); if (code === 0) resolve(); else reject(new Error(`child exit ${code}`)); });
    child.send(request);
  });
  assert.deepEqual(stages, ["validate", "admit", "read", "index", "query", "respond"]);
  assert.equal(finals.length, 1);
  const result = JSON.parse(finals[0]!);
  assert.equal(result.status, "ok");
  assert.match(result.text, /alpha/);
  assert.equal(result.index, undefined);
});
