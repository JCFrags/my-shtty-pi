import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendMemoryEvent, createMemoryEvent, memorySidecarPath, readMemoryEvents, type MemoryEvent } from "../src/memory-store.js";
import { validateHistoryWorkerWire } from "../src/history-worker-dispatch.js";
import { validHistoryPromotionEvent } from "../src/history-worker-contract.js";
import { stableStringify } from "../src/utils.js";
import { installSyntheticHistoryExtension } from "./synthetic-history-adapter.js";

function nearLimitEvents(fillerLength: number): MemoryEvent[] {
  const events: MemoryEvent[] = [];
  for (const [index, text] of ["alpha one", "alpha two", "z".repeat(fillerLength)].entries()) {
    events.push(createMemoryEvent(events, { action: "remember", text: text || "z", sourceRef: `synthetic-${index}`, timestamp: `2026-01-01T00:00:0${index}.000Z`, turn: 0 }));
  }
  return events;
}
function serialize(events: readonly MemoryEvent[]): string { return events.map((event) => stableStringify(event)).join("\n") + "\n"; }

test("partial promotion refusal mirrors each committed event and never repeats the failed job", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chrono-promotion-receipts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "session.jsonl"), sidecar = memorySidecarPath(path);
  await writeFile(path, [JSON.stringify({ type: "session", version: 3 }), JSON.stringify({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "alpha" } })].join("\n") + "\n", { mode: 0o600 });
  const initialSize = 261_494;
  const fillerLength = initialSize - Buffer.byteLength(serialize(nearLimitEvents(1))) + 1;
  const initial = serialize(nearLimitEvents(fillerLength));
  assert.equal(Buffer.byteLength(initial), initialSize);
  await writeFile(sidecar, initial, { mode: 0o600 });
  const before = await readMemoryEvents(sidecar);
  assert.equal(before.status, "ready");
  assert.equal(before.events.length, 3);

  const tools = new Map<string, (...args: any[]) => Promise<any>>();
  const mirrored: MemoryEvent[] = [];
  let runs = 0;
  const shutdown = installSyntheticHistoryExtension({ registerTool(tool: any) { tools.set(tool.name, tool.execute); }, registerCommand() {}, on() {}, appendEntry(kind: string, event: MemoryEvent) { assert.equal(kind, "chrono-memory-v2-event"); mirrored.push(event); }, sendMessage() {} } as unknown as ExtensionAPI, directory, () => { runs++; });
  t.after(shutdown);
  const response = await tools.get("history_recall")!("test", { query: "alpha" }, undefined, undefined, {
    sessionManager: { getSessionFile: () => path, getLeafId: () => "u1", getBranch() { throw new Error("must not copy parent branch"); } },
  });
  assert.equal(response.details.status, "refused");
  assert.equal(response.details.code, "history-promotion-source-too-large");
  assert.equal(response.details.promotedMemories, 1);
  assert.match(response.content[0].text, /Mirrored 1 already committed promotion event/);
  assert.equal(runs, 1, "refusal must not rerun child promotion");
  const after = await readMemoryEvents(sidecar);
  assert.equal(after.status, "ready");
  assert.equal(after.events.length, 4, "first touch commits, second refuses before write");
  assert.ok(Buffer.byteLength(await readFile(sidecar, "utf8")) <= 256 * 1024);
  assert.deepEqual(mirrored, after.events.slice(before.events.length));
  assert.equal(mirrored.length, 1);
  assert.equal(mirrored[0]!.action, "touch");
  const frame = JSON.stringify({ status: "refused", code: "history-promotion-source-too-large", promotionEvents: mirrored });
  assert.equal(validateHistoryWorkerWire(frame), frame);
  assert.equal(validateHistoryWorkerWire(validateHistoryWorkerWire(frame)), frame);
});

test("refusal receipts reject unsupported fields, actions, oversize records, and arrays", () => {
  const remembered = nearLimitEvents(1);
  const receipt = createMemoryEvent(remembered, { action: "touch", memoryId: remembered[0]!.memoryId, sourceRef: "history-recall:test", timestamp: "2026-01-01T00:00:03.000Z", turn: 1 });
  assert.equal(validHistoryPromotionEvent(receipt), true);
  for (const events of [
    [{ ...receipt, index: [] }],
    [{ ...receipt, action: "remember" }],
    [{ ...receipt, authority: "system" }],
    [{ ...receipt, scope: "x".repeat(4097) }],
    [{ ...receipt, scope: 42 }],
    Array.from({ length: 4 }, () => receipt),
  ]) {
    assert.throws(() => validateHistoryWorkerWire(JSON.stringify({ status: "refused", code: "history-promotion-unavailable", promotionEvents: events })), /history-response-invalid/);
  }
});

test("append output guard refuses under the lock before any new sidecar event commits", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chrono-promotion-guard-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "memory.jsonl");
  const events = nearLimitEvents(1), initial = serialize(events);
  await writeFile(path, initial, { mode: 0o600 });
  await assert.rejects(appendMemoryEvent(path, { action: "touch", memoryId: events[0]!.memoryId, sourceRef: "history-recall:test", timestamp: "2026-01-01T00:00:03.000Z", turn: 1 }, {
    maxReadBytes: 256 * 1024,
    validateAppendEvent() { throw new Error("history-promotion-unavailable"); },
  }), /history-promotion-unavailable/);
  assert.equal(await readFile(path, "utf8"), initial);
});
