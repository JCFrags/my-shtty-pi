import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { extractAssistantArchiveItems } from "../dist/feed/index.js";
import { createDurableGlanceRepository } from "../dist/history/store.js";
import { openHistoryDatabase } from "../dist/history/schema.js";

const AT = "2026-09-10T00:00:00.000Z";
const signature = (id) => JSON.stringify({ v: 1, id, phase: "commentary" });
const assistantEntry = (id, parentId, body, timestamp = AT) => ({
  type: "message", id, parentId, timestamp,
  message: { role: "assistant", stopReason: "stop", timestamp: Date.parse(timestamp), content: [{ type: "text", text: body, textSignature: signature(id) }] },
});
const uiEntry = (id, parentId, action, itemId) => ({ type: "custom", id, parentId, timestamp: AT, customType: "pi-project-glance/ui-state-v1", data: { version: 1, action, itemId } });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "glance-history-"));
  return { directory, database: join(directory, "state", "archive.sqlite") };
}
function linear(count, prefix = "e") {
  return Array.from({ length: count }, (_, index) => assistantEntry(`${prefix}${index}`, index ? `${prefix}${index - 1}` : null, `Update ${index}`, new Date(Date.parse(AT) + index * 1000).toISOString()));
}

test("archive extraction retains complete sanitized commentary before projection clipping", () => {
  const body = `Start\n\n${"x".repeat(12 * 1024)}`;
  const item = extractAssistantArchiveItems(assistantEntry("one", null, body).message, "one", AT)[0];
  assert.equal(item.sanitizedBody, body);
  assert.ok(Buffer.byteLength(item.sanitizedBody) > 4096);
});

test("private SQLite store captures once and pages Inbox oldest-first in both directions", () => {
  const { database } = fixture();
  const repository = createDurableGlanceRepository(database);
  const entries = linear(60);
  const captured = repository.capture({ sessionKey: "a".repeat(64), sourceSessionId: "session-a", mode: "initial", startOrdinal: 0, entries, activeLeafId: "e59", activePathIds: entries.map((entry) => entry.id) });
  assert.equal(captured.insertedItems, 60);
  assert.deepEqual(repository.counts(captured.branchId), { inbox: 60, history: 0, commitSeq: captured.checkpoint.commitSeq });
  const first = repository.page({ branchId: captured.branchId, view: "inbox" });
  assert.equal(first.items.length, 25);
  assert.equal(first.items[0].preview, "Update 0");
  assert.equal(first.previousCursor, undefined);
  const second = repository.page({ branchId: captured.branchId, view: "inbox", cursor: first.nextCursor });
  assert.equal(second.items[0].preview, "Update 25");
  const previous = repository.page({ branchId: captured.branchId, view: "inbox", cursor: second.previousCursor });
  assert.deepEqual(previous.items.map((item) => item.itemId), first.items.map((item) => item.itemId));
  assert.equal(statSync(database).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(database)).mode & 0o777, 0o700);
  repository.close();
});

test("snapshot cursors have no gaps when arrivals and archives commit concurrently", () => {
  const { database } = fixture();
  const repository = createDurableGlanceRepository(database);
  const entries = linear(40);
  const initial = repository.capture({ sessionKey: "b".repeat(64), sourceSessionId: "session-b", mode: "initial", startOrdinal: 0, entries, activeLeafId: "e39", activePathIds: entries.map((entry) => entry.id) });
  const first = repository.page({ branchId: initial.branchId, view: "inbox" });
  const oldSecondPageItem = repository.page({ branchId: initial.branchId, view: "inbox", cursor: first.nextCursor }).items[0];
  repository.archive({ branchId: initial.branchId, itemId: oldSecondPageItem.itemId, actionId: "archive-one", archivedAt: AT, source: "action" });
  repository.capture({ sessionKey: "b".repeat(64), sourceSessionId: "session-b", mode: "append", startOrdinal: 40, entries: [assistantEntry("e40", "e39", "Update 40")], activeLeafId: "e40", currentBranchId: initial.branchId });
  const stableSecond = repository.page({ branchId: initial.branchId, view: "inbox", cursor: first.nextCursor });
  assert.equal(stableSecond.items[0].itemId, oldSecondPageItem.itemId);
  assert.equal(new Set([...first.items, ...stableSecond.items].map((item) => item.itemId)).size, first.items.length + stableSecond.items.length);
  const fresh = repository.page({ branchId: initial.branchId, view: "inbox" });
  assert.ok(!fresh.items.some((item) => item.itemId === oldSecondPageItem.itemId));
  repository.close();
});

test("restart reuses an ancestor branch but historical checkout cannot leak later descendants", () => {
  const { database } = fixture();
  const repository = createDurableGlanceRepository(database);
  const firstEntries = linear(2);
  const first = repository.capture({ sessionKey: "9".repeat(64), sourceSessionId: "session-nine", mode: "initial", startOrdinal: 0, entries: firstEntries, activeLeafId: "e1", activePathIds: ["e0", "e1"] });
  const e0 = repository.page({ branchId: first.branchId, view: "inbox" }).items[0];
  repository.archive({ branchId: first.branchId, itemId: e0.itemId, actionId: "archive-root", archivedAt: AT, source: "action" });
  const all = [...firstEntries, assistantEntry("e2", "e1", "Update 2")];
  const restart = repository.capture({ sessionKey: "9".repeat(64), sourceSessionId: "session-nine", mode: "initial", startOrdinal: 0, entries: all, activeLeafId: "e2", activePathIds: ["e0", "e1", "e2"] });
  assert.equal(restart.branchId, first.branchId);
  assert.deepEqual(repository.counts(first.branchId), { inbox: 2, history: 1, commitSeq: restart.checkpoint.commitSeq });
  const checkout = repository.capture({ sessionKey: "9".repeat(64), sourceSessionId: "session-nine", mode: "tree", startOrdinal: 0, entries: all, activeLeafId: "e0", activePathIds: ["e0"] });
  assert.notEqual(checkout.branchId, first.branchId);
  assert.deepEqual(repository.page({ branchId: checkout.branchId, view: "inbox" }).items.map((item) => item.preview), ["Update 0"]);
  assert.deepEqual(repository.counts(checkout.branchId).history, 0);
  repository.close();
});

test("live tree selection recovers previously off-path updates and dismissals without rescanning", () => {
  const { database } = fixture();
  const repository = createDurableGlanceRepository(database);
  const sessionKey = "8".repeat(64);
  const entries = [
    assistantEntry("root", null, "Root"),
    assistantEntry("a", "root", "Branch A"),
    uiEntry("dismiss-a", "a", "dismiss", "a"),
    assistantEntry("b", "root", "Branch B"),
  ];
  const branchB = repository.capture({
    sessionKey, sourceSessionId: "session-eight", mode: "initial", startOrdinal: 0,
    entries, activeLeafId: "b", activePathIds: ["root", "b"],
  });
  assert.deepEqual(repository.page({ branchId: branchB.branchId, view: "inbox" }).items.map((item) => item.preview), ["Root", "Branch B"]);
  assert.equal(repository.counts(branchB.branchId).history, 0);

  const branchA = repository.capture({
    sessionKey, sourceSessionId: "session-eight", mode: "tree", startOrdinal: entries.length,
    entries: [], activeLeafId: "dismiss-a", activePathIds: ["root", "a", "dismiss-a"],
  });
  assert.notEqual(branchA.branchId, branchB.branchId);
  assert.deepEqual(repository.page({ branchId: branchA.branchId, view: "inbox" }).items.map((item) => item.preview), ["Root"]);
  assert.deepEqual(repository.page({ branchId: branchA.branchId, view: "history" }).items.map((item) => item.preview), ["Branch A"]);
  assert.equal(branchA.importedDismissals, 1);
  assert.deepEqual(repository.checkpoint(sessionKey), branchA.checkpoint);
  assert.equal(branchA.checkpoint.nextOrdinal, entries.length);
  assert.deepEqual(repository.page({ branchId: branchB.branchId, view: "inbox" }).items.map((item) => item.preview), ["Root", "Branch B"], "selecting A cannot leak its update or dismissal into B");
  assert.equal(repository.counts(branchB.branchId).history, 0);
  repository.close();
});

test("archive receipts are idempotent, History is newest-first, and source conflicts roll back", () => {
  const { database } = fixture();
  const repository = createDurableGlanceRepository(database);
  const entries = linear(3);
  const capture = repository.capture({ sessionKey: "c".repeat(64), sourceSessionId: "session-c", mode: "initial", startOrdinal: 0, entries, activeLeafId: "e2", activePathIds: entries.map((entry) => entry.id) });
  const inbox = repository.page({ branchId: capture.branchId, view: "inbox" });
  const one = repository.archive({ branchId: capture.branchId, itemId: inbox.items[0].itemId, actionId: "same-action", archivedAt: AT, source: "action" });
  const replay = repository.archive({ branchId: capture.branchId, itemId: inbox.items[0].itemId, actionId: "same-action", archivedAt: AT, source: "action" });
  assert.equal(one.changed, true);
  assert.deepEqual(replay, { accepted: true, changed: false, archiveSeq: one.archiveSeq });
  repository.archive({ branchId: capture.branchId, itemId: inbox.items[2].itemId, actionId: "later-action", archivedAt: AT, source: "action" });
  assert.deepEqual(repository.page({ branchId: capture.branchId, view: "history" }).items.map((item) => item.preview), ["Update 2", "Update 0"]);
  assert.throws(() => repository.capture({ sessionKey: "c".repeat(64), sourceSessionId: "session-c", mode: "initial", startOrdinal: 0, entries: [assistantEntry("e0", null, "changed")], activeLeafId: "e0", activePathIds: ["e0"], currentBranchId: capture.branchId }), /SOURCE_CONFLICT/);
  assert.equal(repository.counts(capture.branchId).inbox, 1);
  repository.close();
});

test("body chunks use exact UTF-8 byte offsets and retain unbounded bodies", () => {
  const { database } = fixture();
  const repository = createDurableGlanceRepository(database);
  const body = "é".repeat(20_000);
  const capture = repository.capture({ sessionKey: "d".repeat(64), sourceSessionId: "session-d", mode: "initial", startOrdinal: 0, entries: [assistantEntry("e0", null, body)], activeLeafId: "e0", activePathIds: ["e0"] });
  const item = repository.page({ branchId: capture.branchId, view: "inbox" }).items[0];
  const first = repository.body({ branchId: capture.branchId, itemId: item.itemId, offset: 0 });
  assert.ok(Buffer.byteLength(first.text) <= 24 * 1024);
  const second = repository.body({ branchId: capture.branchId, itemId: item.itemId, offset: first.nextOffset });
  assert.equal(second.previousOffset, 0);
  assert.equal(Buffer.byteLength(first.text) + Buffer.byteLength(second.text), Buffer.byteLength(body));
  assert.throws(() => repository.body({ branchId: capture.branchId, itemId: item.itemId, offset: 1 }), /BODY_OFFSET/);
  repository.close();
});

test("selected import recovers all leaf branches and branch-local dismissals but not seen", async () => {
  const { directory, database } = fixture();
  const source = join(directory, "selected.jsonl");
  const root = assistantEntry("root", null, "Root");
  const a = assistantEntry("a", "root", "Branch A");
  const dismissed = uiEntry("dismiss-a", "a", "dismiss", "a");
  const b = assistantEntry("b", "root", "Branch B");
  const seen = uiEntry("seen-b", "b", "mark_read", "b");
  writeFileSync(source, [{ type: "session", version: 3, id: "selected-session", timestamp: AT, cwd: "/fixture" }, root, a, dismissed, b, seen].map((value) => JSON.stringify(value)).join("\n") + "\n", { mode: 0o600 });
  const repository = createDurableGlanceRepository(database);
  const result = await repository.importSelected({ selectedPath: source, expectedSessionId: "selected-session" });
  assert.equal(result.state, "complete");
  assert.equal(result.discoveredBranches, 2);
  assert.equal(result.importedDismissals, 1);
  const db = new DatabaseSync(database, { readOnly: true });
  const counts = db.prepare("SELECT b.branch_id,COUNT(bi.item_pk) AS items,COUNT(a.item_pk) AS archived FROM branches b JOIN branch_items bi ON bi.branch_id=b.branch_id LEFT JOIN archives a ON a.branch_id=b.branch_id AND a.item_pk=bi.item_pk GROUP BY b.branch_id ORDER BY archived DESC").all();
  db.close();
  assert.equal(counts.length >= 2, true);
  assert.equal(counts.some((value) => Number(value.archived) === 1), true);
  assert.equal(counts.some((value) => Number(value.archived) === 0), true);
  repository.close();
});

test("selected import cancellation is bounded and resumes without duplicate items", async () => {
  const { directory, database } = fixture();
  const source = join(directory, "long-selected.jsonl");
  const entries = linear(600, "long-");
  writeFileSync(source, [{ type: "session", version: 3, id: "long-selected-session", timestamp: AT, cwd: "/fixture" }, ...entries].map((value) => JSON.stringify(value)).join("\n") + "\n", { mode: 0o600 });
  const repository = createDurableGlanceRepository(database);
  const controller = new AbortController();
  const paused = await repository.importSelected({ selectedPath: source, expectedSessionId: "long-selected-session", signal: controller.signal, onProgress: () => controller.abort() });
  assert.equal(paused.state, "paused");
  assert.ok(paused.committedBytes > 0 && paused.committedBytes < paused.totalBytes);
  const resumed = await repository.importSelected({ selectedPath: source, expectedSessionId: "long-selected-session" });
  assert.equal(resumed.state, "complete");
  assert.equal(resumed.insertedItems, 600);
  assert.equal(resumed.discoveredBranches, 1);
  const status = repository.importStatus(resumed.importId);
  assert.deepEqual(status.state, "complete");
  assert.equal(status.insertedItems, 600);
  const db = new DatabaseSync(database, { readOnly: true });
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM items").get().count), 600);
  db.close();
  repository.close();
});

test("forward and interrupted schemas refuse without erasing existing data", () => {
  const newer = fixture().database;
  const db = openHistoryDatabase(newer);
  db.exec("PRAGMA user_version=999");
  db.close();
  const before = readFileSync(newer);
  assert.throws(() => openHistoryDatabase(newer), /SCHEMA_NEWER/);
  assert.deepEqual(readFileSync(newer), before);

  const partial = fixture().database;
  mkdirSync(dirname(partial), { recursive: true, mode: 0o700 });
  const partialDb = new DatabaseSync(partial);
  partialDb.exec("CREATE TABLE items(keep TEXT); INSERT INTO items VALUES('do-not-erase')");
  partialDb.close();
  assert.throws(() => openHistoryDatabase(partial), /SCHEMA_INVALID/);
  const verify = new DatabaseSync(partial, { readOnly: true });
  assert.equal(verify.prepare("SELECT keep FROM items").get().keep, "do-not-erase");
  assert.equal(verify.prepare("PRAGMA user_version").get().user_version, 0);
  verify.close();
});

test("SQLite-full failure rolls back item and persistent source checkpoint", () => {
  const other = fixture().database;
  const repository = createDurableGlanceRepository(other);
  const initial = repository.capture({ sessionKey: "f".repeat(64), sourceSessionId: "session-f", mode: "initial", startOrdinal: 0, entries: [assistantEntry("e0", null, "kept")], activeLeafId: "e0", activePathIds: ["e0"] });
  repository.close();
  const limiter = new DatabaseSync(other);
  limiter.exec("CREATE TRIGGER simulate_disk_full BEFORE INSERT ON items BEGIN SELECT RAISE(ABORT, 'SQLITE_FULL: database or disk is full'); END");
  limiter.close();
  const limited = createDurableGlanceRepository(other);
  assert.throws(() => limited.capture({ sessionKey: "f".repeat(64), sourceSessionId: "session-f", mode: "append", startOrdinal: 1, entries: [assistantEntry("e1", "e0", "z".repeat(2 * 1024 * 1024))], activeLeafId: "e1", currentBranchId: initial.branchId }), /full|SQLITE_FULL/i);
  assert.equal(limited.checkpoint("f".repeat(64)).nextOrdinal, 1);
  assert.equal(limited.counts(initial.branchId).inbox, 1);
  limited.close();
});
