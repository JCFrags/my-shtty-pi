import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import memoryExtension from "../src/index.ts";
import { captureMemoryBinding, openBoundMemory, restoreMemoryBinding } from "../src/bindings.ts";
import { importLegacyV2, parseLegacyImport, readLegacySource } from "../src/legacy-import.ts";
import { buildOperation } from "../src/operations.ts";
import { ANCHOR_TYPE, canonical, sha } from "../src/contracts.ts";
import { sourceTicket } from "../src/files.ts";
import { readMemoryContext } from "../src/connector.ts";
import { captureStateTransfer, OWNER_BINDING_ENTRY } from "@context-kit/protocol/transfer";
import { createMemoryEvent, materializeMemoryEvents } from "../../../pi-chrono-compaction/dist/src/memory-store.js";

class Bus {
  handlers = new Map<string, Set<(data: any) => void>>();
  on(name: string, fn: (data: any) => void) { const set = this.handlers.get(name) ?? new Set(); set.add(fn); this.handlers.set(name, set); return () => { set.delete(fn); }; }
  emit(name: string, data: any) { for (const fn of this.handlers.get(name) ?? []) fn(data); }
}
function fixture(directory: string, sessionId: string, parentSession?: string) {
  const sourcePath = join(directory, `${sessionId}.jsonl`), entries = new Map<string, any>();
  const header = { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: "/workspace", ...(parentSession ? { parentSession } : {}) };
  writeFileSync(sourcePath, `${JSON.stringify(header)}\n`, { mode: 0o600 });
  let leafId: string | null = null, sequence = 0;
  function append(raw: any) {
    const entry = { ...raw, id: `entry-${++sequence}`, parentId: leafId, timestamp: new Date().toISOString() };
    appendFileSync(sourcePath, `${JSON.stringify(entry)}\n`); entries.set(entry.id, entry); leafId = entry.id; return entry.id;
  }
  const notifications: string[] = [], commands = new Map<string, any>(), tools = new Map<string, any>(), handlers = new Map<string, any[]>(), events = new Bus();
  const ctx = { sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sourcePath, getLeafId: () => leafId,
    getLeafEntry: () => entries.get(leafId!), getEntry: (id: string) => entries.get(id), getHeader: () => header,
    getBranch: () => { throw new Error("Unbounded branch access is forbidden in this scenario"); }, getEntries: () => { throw new Error("Unbounded history access is forbidden"); } },
    ui: { notify: (message: string) => notifications.push(message) }, isIdle: () => true } as unknown as ExtensionContext;
  const pi = { events, registerTool: (tool: any) => { assert.equal(tools.has(tool.name), false); tools.set(tool.name, tool); }, registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, callback: any) => handlers.set(name, [...(handlers.get(name) ?? []), callback]),
    appendEntry: (customType: string, data: unknown) => { append({ type: "custom", customType, data }); } } as unknown as ExtensionAPI;
  async function event(name: string, data: any = {}) { for (const handler of handlers.get(name) ?? []) await handler(data, ctx); }
  async function call(name: string, args: any, id = `call-${sequence + 1}`) {
    append({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name, id, arguments: args }] } });
    await event("tool_call", { toolName: name, toolCallId: id, input: args });
    try { return JSON.parse((await tools.get(name).execute(id, args, undefined, undefined, ctx)).content[0].text); }
    finally { await event("tool_execution_end", { toolCallId: id }); }
  }
  return { sourcePath, ctx, pi, tools, events, commands, notifications, append, event, call, tree: (id: string | null) => { leafId = id; } };
}

test("standalone Memory: exact legacy bytes, proposals, revisions, tree sharing, transfer, bounded reads, and failed anchors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-memory-component-")); chmodSync(directory, 0o700);
  const root = join(directory, "owned"), previousRoot = process.env.PI_CONTEXT_MEMORY_ROOT;
  process.env.PI_CONTEXT_MEMORY_ROOT = root;
  const first = fixture(directory, "source-session"), reopened: ReturnType<typeof fixture>[] = [];
  try {
    memoryExtension(first.pi); await first.event("session_start");
    assert.equal(first.tools.size, 8);
    await first.commands.get("memory-init").handler("", first.ctx);
    assert.equal(first.notifications.at(-1), "Memory logical-session binding is ready.");
    const events: any[] = [];
    for (const input of [
      { action: "remember", memoryId: "color", text: "blue" }, { action: "update", memoryId: "color", text: "green" },
      { action: "remember", memoryId: "retired", text: "old rule" }, { action: "forget", memoryId: "retired" },
      { action: "remember", memoryId: "boosted", text: "keep temporary" }, { action: "touch", memoryId: "boosted" }, { action: "promote", memoryId: "boosted" },
    ]) events.push(createMemoryEvent(events, { ...input, timestamp: `2026-09-01T00:00:0${events.length}.000Z`, turn: events.length, sourceRef: `fixture:${events.length}` } as any));
    const raw = Buffer.from(`${events.map(event => canonical(event)).join("\r\n")}\r\n`), legacyPath = join(directory, "legacy.jsonl");
    writeFileSync(legacyPath, raw, { mode: 0o600 });
    const source = await readLegacySource(legacyPath), parsed = parseLegacyImport(source.bytes, source.identity, "legacy-session");
    const legacy = materializeMemoryEvents(events); assert.equal(legacy.status, "ready");
    assert.equal(events[0].previousEventHash.length, 64); assert.equal(events[1].previousEventHash.length, 20); assert.equal(events[0].eventId.length, 20);
    const owned = openBoundMemory(root, "source-session");
    try {
      const receipt = await importLegacyV2(owned, parsed, first.sourcePath, anchor => first.pi.appendEntry(ANCHOR_TYPE, anchor));
      assert.equal(receipt.eventCount, events.length); assert.equal(receipt.noOp, false);
      const repeated = await importLegacyV2(owned, parseLegacyImport(raw, source.identity, "legacy-session"), first.sourcePath, () => assert.fail("Repeated import wrote an anchor"));
      assert.deepEqual({ ...receipt, noOp: true }, repeated);
      assert.deepEqual(owned.importBytes(parsed.id).bytes, raw); assert.deepEqual(readFileSync(legacyPath), raw);
      for (const old of legacy.memories) {
        const actual = owned.get(old.memoryId)!;
        for (const key of ["memoryId", "text", "scope", "authority", "protected", "confidence", "state", "createdAt", "sourceRef", "useCount"] as const) assert.equal(actual[key], old[key]);
        assert.equal(actual.legacy?.eventHash, old.lastEventHash);
        assert.equal(actual.legacy?.promotedUntilTurn, old.promotedUntilTurn);
      }
      assert.equal(owned.get("color", { revision: 1 })!.text, "blue");
      assert.equal(owned.get("color", { recordedBefore: "2026-09-01T00:00:00.000Z" })!.text, "blue");
    } finally { owned.close(); }
    const beforeProposalLeaf = first.ctx.sessionManager.getLeafId();
    const proposal = await first.call("memory_proposal", { action: "propose", text: "gold", eventTime: { kind: "instant", at: "2025-01-01T00:00:00.000Z" },
      validity: { kind: "interval", from: "2025-01-01T00:00:00.000Z", until: "2025-12-31T00:00:00.000Z" },
      sources: [{ identity: "fixture:correction", kind: "external", role: "supports", reference: "fixture://gold", derivation: "original" }] });
    const proposalId = proposal.memoryId;
    assert.equal((await first.call("memory_search", { query: "gold" })).count, 0);
    assert.equal((await first.call("memory_get", { memoryId: proposalId })).memory.state, "pending");
    await assert.rejects(first.call("memory_proposal", { action: "accept", memoryId: proposalId, expectedRevision: 2 }), /memory-revision-conflict/);
    const accepted = await first.call("memory_proposal", { action: "accept", memoryId: proposalId, expectedRevision: 1, targetMemoryId: "color", expectedTargetRevision: 2 });
    assert.equal(accepted.memoryId, "color");
    const current = (await first.call("memory_get", { memoryId: "color" })).memory;
    assert.equal(current.text, "gold"); assert.equal(current.revision, 3); assert.equal(current.originalOrigin.sessionId, "legacy-session");
    assert.equal(current.origin.sessionId, "source-session"); assert.equal(current.eventTime.at, "2025-01-01T00:00:00.000Z");
    assert.equal((await first.call("memory_get", { memoryId: "color", revision: "2" })).memory.text, "green");
    assert.equal((await first.call("memory_get", { memoryId: "color", recordedBefore: "2026-09-01T00:00:01.000Z" })).memory.text, "green");
    await first.call("memory_promote", { memoryId: "retired", expectedRevision: 2 });
    assert.equal((await first.call("memory_list", {})).memories[0].memoryId, "retired");
    await first.call("memory_forget", { memoryId: "retired", expectedRevision: 3 });
    first.tree(beforeProposalLeaf); await first.event("session_tree");
    assert.equal((await first.call("memory_get", { memoryId: "color" })).memory.text, "gold");
    const pageStore = openBoundMemory(root, "source-session");
    try {
      const request = { version: 2 as const, providerId: "memory" as const, requestId: "context-test", scope: { sessionId: "source-session", leafId: first.ctx.sessionManager.getLeafId() }, query: "", categories: [], limits: { records: 6, scan: 16, bytes: 8192 }, deadlineMs: Date.now() + 1000 };
      const page = readMemoryContext(request, pageStore);
      assert.equal(page.cards.some(card => card.category === "proposal"), false);
      assert.ok(page.cards.every(card => card.visibility?.branchBehavior === "shared" && card.recovery.tool === "memory_get" && card.recovery.args.revision === card.revision));
      assert.equal(readMemoryContext({ ...request, categories: ["proposal"] }, pageStore).cards[0]!.id, proposalId);
      const bounded = pageStore.page({ scan: 1, limit: 1, includeDemoted: true });
      assert.equal(bounded.coverage.scanned, 1); assert.equal(bounded.coverage.scanComplete, false); assert.ok(bounded.nextCursor);
      await first.call("memory_remember", { text: "another explicit fact" });
      assert.throws(() => pageStore.page({ scan: 1, limit: 1, includeDemoted: true, cursor: bounded.nextCursor }), /memory-cursor-stale/);
    } finally { pageStore.close(); }
    const checkpoint = await captureStateTransfer(first.events, () => ({ sessionId: "source-session", leafId: first.ctx.sessionManager.getLeafId() }), { providers: ["memory"] });
    assert.equal(checkpoint.length, 1); assert.equal(checkpoint[0]!.customType, OWNER_BINDING_ENTRY);
    const child = fixture(directory, "replacement-session", first.sourcePath); reopened.push(child);
    for (const entry of checkpoint) child.append({ type: "custom", ...entry });
    memoryExtension(child.pi); await child.event("session_start");
    const childValue = await child.call("memory_get", { memoryId: "color" });
    assert.equal(childValue.memory.text, "gold"); assert.equal(childValue.visibility.namespaceId, captureMemoryBinding(root, { sessionId: "source-session", leafId: null }).namespaceId);
    const pending = openBoundMemory(root, "source-session");
    try {
      const before = pending.meta().revision, operationId = "failed-anchor";
      assert.throws(() => pending.execute(operationId, "synthetic-fingerprint", sourceTicket(first.sourcePath), meta => buildOperation(pending, meta, "remember", { text: "must stay invisible" }, { operationId, origin: { sessionId: "source-session", leafId: "synthetic-call", toolCallId: "synthetic" } }), () => {}), /memory-anchor-unpersisted/);
      assert.equal(pending.meta().revision, before); assert.throws(() => pending.page(), /memory-pending/);
      assert.throws(() => captureMemoryBinding(root, { sessionId: "source-session", leafId: null }), /memory-pending/);
      pending.recover(); assert.equal(pending.page({ query: "must stay invisible" }).records.length, 0);
      const binding = captureMemoryBinding(root, { sessionId: "source-session", leafId: null });
      await child.call("memory_update", { memoryId: "color", text: "platinum", expectedRevision: 3 });
      assert.throws(() => restoreMemoryBinding(root, binding, { sessionId: "replacement-session", sourcePath: child.sourcePath }), /memory-binding-revision-mismatch/);
    } finally { pending.close(); }
    assert.deepEqual(readFileSync(legacyPath), raw);
    const malformed = Buffer.from(raw); malformed[malformed.indexOf(Buffer.from("blue"))] = 120;
    assert.throws(() => parseLegacyImport(malformed, source.identity), /memory-import-integrity/);
    console.log(JSON.stringify({ evidenceDirectory: directory, legacyDigest: sha(raw), events: events.length, standaloneTools: first.tools.size, modelCalls: 0, boundedBranchWalk: true, immutableImport: true }));
  } finally {
    await first.event("session_shutdown"); for (const value of reopened) await value.event("session_shutdown");
    if (previousRoot === undefined) delete process.env.PI_CONTEXT_MEMORY_ROOT; else process.env.PI_CONTEXT_MEMORY_ROOT = previousRoot;
  }
});
