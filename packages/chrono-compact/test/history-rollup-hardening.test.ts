import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireHistoryRollupLock } from "../src/history-rollup-lock.js";
import { queryHistoryRollups } from "../src/history-rollup-query.js";
import {
  aggregateHistoryState,
  createHistoryRollupRuntime,
  historyRollupStorePath,
  historyRollupV1StorePath,
  loadHistoryNode,
  resolveHistoryLifecycles,
  updateHistoryRollupStore,
} from "../src/history-rollup-store.js";
import { createHistoryValueRecord } from "../src/history-value.js";
import type { HistoricalBlock, SessionEntryLike } from "../src/types.js";

const block = (patch: Partial<HistoricalBlock> = {}): HistoricalBlock => ({
  id: "block",
  entryId: "entry",
  entryIndex: 0,
  kind: "assistant_text",
  label: "assistant",
  exactText: "routine state",
  rawTokens: 3,
  sourceRefs: [{ entryId: "entry" }],
  protectedExact: false,
  reproducible: false,
  unresolved: false,
  exactIdentifiers: [],
  attributes: {},
  ...patch,
});

function record(id: string, text: string, patch: Partial<HistoricalBlock> = {}) {
  return createHistoryValueRecord(block({ id, entryId: id, entryIndex: Number(id.replace(/\D/g, "")) || 0, exactText: text, ...patch }));
}

function message(id: string, parentId: string | null, role: string, text: string): SessionEntryLike {
  return {
    type: "message",
    id,
    parentId,
    message: { role, content: role === "assistant" ? [{ type: "text", text }] : text, stopReason: "stop" },
  };
}

async function sourceFixture(t: test.TestContext, entries: SessionEntryLike[], config: Record<string, number> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "chrono-rollup-hardening-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionPath = join(directory, "session.jsonl");
  await writeFile(sessionPath, [
    { type: "session", version: 3, id: "hardening" },
    ...entries,
  ].map(value => JSON.stringify(value)).join("\n") + "\n", { mode: 0o600 });
  const runtime = createHistoryRollupRuntime(sessionPath, config);
  return { directory, sessionPath, runtime };
}

test("restriction relations require duplicate identity or explicit same-authority correction", () => {
  const first = record("r1", "Never publish without approval.", { kind: "user", protectedExact: true });
  const duplicate = record("r2", "Never publish without approval.", { kind: "user", protectedExact: true });
  const corrected = record("r3", "Correction: never publish without approval.", { kind: "user", protectedExact: true });
  const opposing = record("r4", "You must publish without approval.", { kind: "user", protectedExact: true });
  const assistant = record("r5", "Correction: never publish without approval.", { protectedExact: true });
  const duplicates = aggregateHistoryState([first, duplicate]);
  assert.equal(duplicates.current.length, 1);
  assert.equal(duplicates.current[0]!.relations.at(-1)?.kind, "duplicate");
  const correction = aggregateHistoryState([first, corrected]);
  assert.equal(correction.current.length, 1);
  assert.equal(correction.current[0]!.relations.at(-1)?.kind, "supersession");
  const conflict = aggregateHistoryState([first, opposing]);
  assert.equal(conflict.conflicts.length, 2);
  const lowerAuthority = aggregateHistoryState([first, assistant]);
  assert.equal(lowerAuthority.conflicts.length, 2);
});

test("failure and task lifecycle changes require linked evidence", () => {
  const failure = record("e1", "build E42 failed", {
    kind: "tool_result",
    toolName: "bash",
    toolArguments: { command: "npm test", path: "/repo/a.ts" },
    isError: true,
    unresolved: true,
  });
  const unrelated = record("e2", "unrelated checks passed", {
    kind: "tool_result",
    toolName: "bash",
    toolArguments: { command: "other", path: "/repo/a.ts" },
  });
  const matchingSignature = record("e3", "build E42 passed", {
    kind: "tool_result",
    toolName: "bash",
    toolArguments: { command: "other", path: "/repo/a.ts" },
  });
  assert.equal(resolveHistoryLifecycles([failure, unrelated])[0]!.lifecycle, "unresolved");
  assert.equal(resolveHistoryLifecycles([failure, matchingSignature])[0]!.lifecycle, "resolved");

  const failureByCommand = record("e4", "different failure failed", {
    kind: "tool_result",
    toolName: "bash",
    toolArguments: { command: "npm test", path: "/repo/a.ts" },
    isError: true,
  });
  const commandPass = record("e5", "all checks passed", {
    kind: "tool_result",
    toolName: "bash",
    toolArguments: { command: "npm test", path: "/repo/a.ts" },
  });
  assert.equal(resolveHistoryLifecycles([failureByCommand, commandPass])[0]!.lifecycle, "resolved");

  const task = record("e6", "Task alpha implementation started");
  const finalText = record("e7", "Task alpha implementation completed");
  const validation = record("e8", "Task alpha validation passed", { kind: "tool_result", toolName: "validation" });
  const acceptance = record("e9", "Task alpha accepted", { kind: "user" });
  assert.equal(resolveHistoryLifecycles([task, finalText])[0]!.lifecycle, "open");
  assert.equal(resolveHistoryLifecycles([task, validation])[0]!.lifecycle, "closed");
  assert.equal(resolveHistoryLifecycles([task, acceptance])[0]!.lifecycle, "closed");
});

test("cross-leaf tool context is exact, bounded, and removes matched calls", async t => {
  const call: SessionEntryLike = {
    type: "message",
    id: "call-entry",
    parentId: null,
    message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/repo/a.ts", sentinel: "SECRET_ARGUMENT" } }], stopReason: "toolUse" },
  };
  const result: SessionEntryLike = {
    type: "message",
    id: "result-entry",
    parentId: "call-entry",
    message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "RESULT_SENTINEL complete" }], isError: false },
  };
  const f = await sourceFixture(t, [call, result], { targetLeafEntries: 1, targetLeafBlocks: 10 });
  await updateHistoryRollupStore(f.runtime, "result-entry");
  assert.equal(f.runtime.branchManifest!.leafNodes.length, 2);
  const second = await loadHistoryNode(f.runtime, f.runtime.branchManifest!.leafNodes[1]!.nodeId);
  assert.equal(second.nodeType, "leaf");
  if (second.nodeType !== "leaf") return;
  const value = second.valueRecords.find(item => item.sourceRange.startEntryId === "result-entry");
  assert.equal(value?.resourceIdentity, "/repo/a.ts");
  assert.equal(value?.resourceRole, "read");
  assert.equal(second.openContext.openToolCallRefs.length, 0);
  const bytes = await readFile(join(f.runtime.directory, "nodes", `${second.nodeId}.json`), "utf8");
  assert.doesNotMatch(bytes, /SECRET_ARGUMENT|RESULT_SENTINEL/);
});

test("exact hit and append expose bounded metadata work and V1 stays untouched", async t => {
  const entries: SessionEntryLike[] = [];
  let parent: string | null = null;
  for (let index = 0; index < 200; index++) {
    const id = `entry-${index}`;
    entries.push(message(id, parent, index === 0 ? "user" : "assistant", index === 0 ? "Never publish without approval." : `status ${index}`));
    parent = id;
  }
  const f = await sourceFixture(t, entries, { targetLeafEntries: 2, targetLeafBlocks: 10 });
  await writeFile(historyRollupV1StorePath(f.sessionPath), "V1_SENTINEL", { mode: 0o600 });
  await updateHistoryRollupStore(f.runtime, parent!);
  const manifestPath = join(historyRollupStorePath(f.sessionPath), "manifest.json");
  const before = await stat(manifestPath);
  const exact = await updateHistoryRollupStore(f.runtime, parent!);
  assert.equal(exact.oldLeafDigestsChecked, 0);
  assert.equal(exact.nodeDirectoryEntriesScanned, 0);
  assert.equal(exact.exactHitFilesWritten, 0);
  assert.equal((await stat(manifestPath)).mtimeMs, before.mtimeMs);
  const next = message("entry-200", parent, "assistant", "next action: validate append");
  await appendFile(f.sessionPath, `${JSON.stringify(next)}\n`);
  const appended = await updateHistoryRollupStore(f.runtime, "entry-200");
  assert.equal(appended.oldLeafDigestsChecked, 0);
  assert.equal(appended.nodeDirectoryEntriesScanned, 0);
  assert.ok(appended.oldNodesLoaded <= f.runtime.branchManifest!.treeLevels + 2);
  assert.ok(appended.treePathNodesCreated <= f.runtime.branchManifest!.treeLevels + 1);
  assert.equal(await readFile(historyRollupV1StorePath(f.sessionPath), "utf8"), "V1_SENTINEL");
});

test("lock preserves live, unverifiable, and replacement owners", async t => {
  const directory = await mkdtemp(join(tmpdir(), "chrono-rollup-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockPath = join(directory, "writer.lock");
  const liveOptions = { readProcessStart: async () => "start-live" as const };
  const release = await acquireHistoryRollupLock(directory, liveOptions);
  await assert.rejects(() => acquireHistoryRollupLock(directory, liveOptions), /busy/);
  await release();

  const owner = { schemaVersion: 2, pid: 42, processStartIdentity: "unknown", nonce: "a".repeat(32), creationTime: new Date().toISOString() };
  await writeFile(lockPath, JSON.stringify(owner), { mode: 0o600 });
  await assert.rejects(
    () => acquireHistoryRollupLock(directory, { readProcessStart: async pid => pid === process.pid ? "self" : "unverifiable" }),
    /unverifiable/,
  );
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).nonce, owner.nonce);
  await rm(lockPath);

  const oldRelease = await acquireHistoryRollupLock(directory, { readProcessStart: async () => "old" });
  await rm(lockPath);
  const replacement = { ...owner, pid: process.pid, processStartIdentity: "new", nonce: "b".repeat(32) };
  await writeFile(lockPath, JSON.stringify(replacement), { mode: 0o600 });
  await oldRelease();
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).nonce, replacement.nonce);
});

test("bounded dynamic query finds old evidence omitted from the root in numeric order", async t => {
  const entries: SessionEntryLike[] = [];
  let parent: string | null = null;
  const ids = ["z-last-lexically", "a-second", ...Array.from({ length: 158 }, (_, index) => `random-${index}`)];
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index]!;
    const text = index === 0
      ? "old-critical-evidence zirconium retention marker"
      : `failure unique-${index} failed and remains unresolved`;
    entries.push(message(id, parent, "assistant", text));
    parent = id;
  }
  const f = await sourceFixture(t, entries, {
    targetLeafEntries: 2,
    targetLeafBlocks: 10,
    fanout: 4,
    maximumStructuredRecords: 8,
    maximumQueryNodes: 64,
  });
  await updateHistoryRollupStore(f.runtime, parent!);
  f.runtime.cache.clear();
  f.runtime.cacheBytes = 0;
  f.runtime.nodesLoaded = 0;
  f.runtime.nodeBytesRead = 0;
  const firstLeaf = await loadHistoryNode(f.runtime, f.runtime.branchManifest!.leafNodes[0]!.nodeId);
  const firstLeafRecords = firstLeaf.nodeType === "leaf" ? firstLeaf.valueRecords.length : -1;
  const result = await queryHistoryRollups(f.runtime, {
    context: { retentionHints: "old-critical-evidence zirconium" },
    maximumNodes: 64,
  });
  assert.ok(result.records.some(value => value.sourceRange.startEntryId === ids[0]), JSON.stringify({ firstLeafRecords, nodes: result.nodesVisited, leaves: result.targetLeavesLoaded, records: result.records.slice(0, 5).map(value => value.sourceRange.startEntryId) }));
  assert.ok(result.nodesVisited <= 64);
  assert.ok(result.targetLeavesLoaded < f.runtime.branchManifest!.leafCount);
  assert.equal(result.sourceOrderValid, true);
  assert.ok(result.records.every((value, index) => index === 0 || result.records[index - 1]!.sourceOrder.start <= value.sourceOrder.start));
  const nodeText = await readFile(join(f.runtime.directory, "nodes", `${f.runtime.branchManifest!.rootRollupNodeId}.json`), "utf8");
  assert.doesNotMatch(nodeText, /PROTECTED_EXACT_SENTINEL/);
  assert.doesNotMatch(nodeText, /old-critical-evidence zirconium retention marker/);
});
