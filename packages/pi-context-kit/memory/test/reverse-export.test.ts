import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { MemoryStore } from "../src/store.ts";
import { ANCHOR_TYPE, canonical, sha, type MemoryRecord } from "../src/contracts.ts";
import { importLegacyV2, parseLegacyImport, readLegacySource } from "../src/legacy-import.ts";
import { buildOperation, type Action } from "../src/operations.ts";
import { sourceTicket, type Anchor } from "../src/files.ts";
import { exportMemoryV2, TARGET_TURN_MEANING, V2_EXPORT_LIMITS } from "../src/reverse-export.ts";
import { createMemoryEvent, materializeMemoryEvents, memorySidecarPath, readMemoryEvents } from "../../../pi-chrono-compaction/dist/src/memory-store.js";

const fields = ["memoryId", "text", "sourceRef", "scope", "authority", "protected", "confidence", "state", "createdAt", "useCount", "supersedesMemoryId"] as const;
test("reverse V2 export preserves the exact prefix, accepted heads, proposals, metadata, and operator turn coordinate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-memory-reverse-")); chmodSync(directory, 0o700);
  const root = join(directory, "owned"), sessionPath = join(directory, "source.jsonl");
  writeFileSync(sessionPath, `${JSON.stringify({ type: "session", version: 3, id: "reverse-source", timestamp: "2026-09-13T00:00:00.000Z", cwd: "/workspace" })}\n`, { mode: 0o600 });
  const store = new MemoryStore(root, "3".repeat(32), true);
  let sequence = 0, anchorNumber = 0;
  function bind(anchor: Anchor) {
    appendFileSync(sessionPath, `${JSON.stringify({ type: "custom", customType: ANCHOR_TYPE, id: `anchor-${++anchorNumber}`, parentId: null, timestamp: new Date().toISOString(), data: anchor })}\n`);
  }
  function mutate(action: Action, input: Record<string, unknown>): MemoryRecord {
    const operationId = `native-${++sequence}`, origin = { sessionId: "reverse-source", leafId: `assistant-${sequence}`, toolCallId: `tool-${sequence}` };
    const receipt = store.execute(operationId, sha(canonical({ action, input })), sourceTicket(sessionPath), meta =>
      buildOperation(store, meta, action, input, { operationId, origin, now: `2026-09-13T00:00:${String(sequence).padStart(2, "0")}.000Z` }), bind);
    return store.get(receipt.records[0]!.memoryId)!;
  }
  try {
    const events: any[] = [];
    for (const input of [
      { action: "remember", memoryId: "color", text: "red", turn: 5 },
      { action: "touch", memoryId: "color", turn: 8 },
      { action: "remember", memoryId: "retired", text: "retained archived fact", turn: 8 },
      { action: "forget", memoryId: "retired", turn: 9 },
      { action: "remember", memoryId: "predecessor", text: "prior accepted statement", turn: 10 },
    ]) events.push(createMemoryEvent(events, { ...input, timestamp: `2026-09-01T00:00:0${events.length}.000Z`, sourceRef: `legacy:${events.length}` } as any));
    // Original CRLF separators and absent final newline must remain an exact prefix.
    const original = Buffer.from(events.map(event => canonical(event)).join("\r\n")), originalPath = join(directory, "original-v2.jsonl");
    writeFileSync(originalPath, original, { mode: 0o600 });
    const source = await readLegacySource(originalPath), imported = parseLegacyImport(source.bytes, source.identity, "legacy-source");
    await importLegacyV2(store, imported, sessionPath, bind);
    mutate("update", { memoryId: "color", text: "blue corrected from source", expectedRevision: 2,
      eventTime: { kind: "instant", at: "2025-01-01T00:00:00.000Z" }, validity: { kind: "interval", from: "2025-01-01T00:00:00.000Z", until: "2025-12-31T00:00:00.000Z" },
      sources: [{ identity: "fixture:source", kind: "external", role: "supports", reference: "fixture://source", derivation: "original" }] });
    const proposal = mutate("propose", { text: "accepted gold fact", eventTime: { kind: "instant", at: "2024-01-01T00:00:00.000Z" }, reason: "operator proposal" });
    const accepted = mutate("accept", { memoryId: proposal.memoryId, expectedRevision: 1 });
    const pending = mutate("propose", { text: "unaccepted proposal remains separate" });
    mutate("promote", { memoryId: "retired", expectedRevision: 2 });
    mutate("forget", { memoryId: "retired", expectedRevision: 3 });
    mutate("remember", { text: "replacement accepted statement", supersedesMemoryId: "predecessor", expectedSupersededRevision: 1 });
    const meta = store.ready(), databaseBefore = sha(readFileSync(store.path)), sessionBefore = sha(readFileSync(sessionPath));
    const input = { expectedStoreId: meta.storeId, expectedStoreRevision: meta.revision, targetTurn: 1000,
      sidecarPath: memorySidecarPath(join(directory, "fresh-target.jsonl")), companionPath: join(directory, "companion.jsonl"), receiptPath: join(directory, "receipt.json") };
    assert.notEqual(input.targetTurn, meta.recordedSequence);
    await assert.rejects(exportMemoryV2(store, { ...input, targetTurn: -1 }), /memory-integer-invalid/);
    await assert.rejects(exportMemoryV2(store, { ...input, expectedStoreRevision: meta.revision - 1 }), /memory-export-cut-conflict/);
    assert.equal(existsSync(input.sidecarPath), false);
    const receipt = await exportMemoryV2(store, input);
    assert.deepEqual(store.ready(), meta);
    assert.equal(sha(readFileSync(store.path)), databaseBefore); assert.equal(sha(readFileSync(sessionPath)), sessionBefore);
    assert.deepEqual(readFileSync(originalPath), original); assert.deepEqual(store.importBytes(imported.id).bytes, original);
    const sidecar = readFileSync(input.sidecarPath), companion = readFileSync(input.companionPath), receiptBytes = readFileSync(input.receiptPath);
    assert.deepEqual(sidecar.subarray(0, original.length), original);
    assert.deepEqual(JSON.parse(receiptBytes.toString("utf8")), receipt);
    for (const artifact of [receipt.sidecar, receipt.companion]) {
      const bytes = readFileSync(artifact.path), st = statSync(artifact.path);
      assert.equal(artifact.sha256, sha(bytes)); assert.equal(artifact.bytes, bytes.length);
      assert.equal(artifact.inode, String(st.ino)); assert.equal(st.mode & 0o777, 0o600); assert.equal(st.nlink, 1);
    }
    assert.equal(receipt.targetTurnMeaning, TARGET_TURN_MEANING); assert.equal(receipt.targetTurn, 1000);
    assert.equal(receipt.retention.policy, "no-touch-no-reset-no-rebase"); assert.ok(receipt.retention.defaultV2PinnedDemotionsAtTarget >= 1);
    assert.equal(receipt.activation.performed, false); assert.match(receipt.activation.required, /memorySidecarPath/);
    assert.ok(sidecar.length <= V2_EXPORT_LIMITS.bodyBytes && companion.length <= V2_EXPORT_LIMITS.bodyBytes && receiptBytes.length <= V2_EXPORT_LIMITS.receiptBytes);
    const allEvents = sidecar.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.deepEqual(allEvents.slice(0, events.length), events);
    for (const event of allEvents.slice(events.length)) {
      assert.equal(event.turn, 1000); assert.notEqual(event.action, "touch");
      assert.equal(event.previousEventHash.length, 20); assert.equal(event.eventHash.length, 20); assert.equal(event.eventId.length, 20);
    }
    assert.equal(allEvents[0].previousEventHash.length, 64);
    const old = materializeMemoryEvents(allEvents), oldFile = await readMemoryEvents(input.sidecarPath);
    assert.equal(old.status, "ready"); assert.deepEqual(oldFile, old);
    const native = store.page({ includeDemoted: true, scan: 100, limit: 100 }).records;
    assert.equal(old.memories.length, native.length);
    for (const actual of native) {
      const counterpart = old.memories.find((item: any) => item.memoryId === actual.memoryId)!;
      assert.ok(counterpart); for (const field of fields) assert.equal(counterpart[field], actual[field], `${actual.memoryId}:${field}`);
      assert.equal(counterpart.updatedAt, actual.recordedAt);
    }
    assert.equal(old.memories.find((item: any) => item.memoryId === accepted.memoryId)?.text, "accepted gold fact");
    assert.equal(old.memories.some((item: any) => item.memoryId === pending.memoryId), false);
    assert.equal(old.memories.find((item: any) => item.memoryId === "color")?.lastUsedTurn, 8);
    assert.equal(receipt.counts.provenanceSyncEvents, 3);
    const lines = companion.toString("utf8").trimEnd().split("\n"), rows = lines.map(line => JSON.parse(line));
    const header = rows[0]!, footer = rows.at(-1)!, revisions = rows.filter(row => row.type === "revision");
    assert.deepEqual(header.nativeMeta, meta); assert.equal(header.originalImport.digest, sha(original));
    assert.equal(footer.precedingSha256, sha(companion.subarray(0, footer.precedingBytes)));
    assert.equal(footer.sidecarSha256, sha(sidecar)); assert.equal(footer.acceptedHeadSemanticHash, receipt.acceptedHeadSemanticHash);
    assert.equal(revisions.length, receipt.counts.revisions);
    for (const row of revisions) assert.deepEqual(row.record, store.get(row.record.memoryId, { revision: row.record.revision }));
    const acceptedProposal = revisions.find(row => row.head && row.record.memoryId === proposal.memoryId)!.record;
    assert.equal(acceptedProposal.acceptedMemoryId, accepted.memoryId); assert.equal(acceptedProposal.acceptedRevision, accepted.revision);
    assert.equal(revisions.find(row => row.head && row.record.memoryId === pending.memoryId)!.v2.companionOnly, "proposal-state");
    const corrected = revisions.find(row => row.head && row.record.memoryId === "color")!.record;
    assert.equal(corrected.eventTime.at, "2025-01-01T00:00:00.000Z"); assert.equal(corrected.originalOrigin.sessionId, "legacy-source");
    assert.equal(corrected.origin.sessionId, "reverse-source"); assert.equal(corrected.useCount, 1);
    await assert.rejects(exportMemoryV2(store, input), /memory-export-target-exists/);
    // Native scope preserves spaces, but the old V2 builder trims them. Refuse instead of changing accepted semantics.
    mutate("update", { memoryId: "color", text: "blue corrected from source", scope: " session ", expectedRevision: 3 });
    const refused = { ...input, expectedStoreRevision: store.meta().revision, sidecarPath: join(directory, "refused-v2.jsonl"), companionPath: join(directory, "refused-companion.jsonl"), receiptPath: join(directory, "refused-receipt.json") };
    await assert.rejects(exportMemoryV2(store, refused), /memory-export-accepted-head-semantic-mismatch/);
    assert.equal(existsSync(refused.sidecarPath), false); assert.equal(existsSync(refused.receiptPath), false);
    assert.deepEqual(readFileSync(originalPath), original);
    console.log(JSON.stringify({ evidenceDirectory: directory, node: process.version, modelCalls: 0, targetTurn: input.targetTurn,
      exportedStoreRevision: receipt.storeRevision, currentStoreRevision: store.meta().revision, counts: receipt.counts, sourceDigest: sha(original),
      sidecarDigest: receipt.sidecar.sha256, companionDigest: receipt.companion.sha256, semanticParity: receipt.semanticParity,
      originalPrefixUnchanged: true, nativeStoreUnchangedByExport: true, semanticMismatchRefused: true, activationPerformed: false }));
  } finally { store.close(); }
});
