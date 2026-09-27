import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { canonical, fail, integer, LIMITS, object, sha, text, type MemoryRecord } from "./contracts.ts";
import { privateDirectory, privateFile, syncDirectory } from "./files.ts";
import type { ExportSnapshot, MemoryStore } from "./store.ts";
import { V2Replay, v2Stringify, type V2Action, type V2Event, type V2Head } from "./v2-codec.ts";

export const V2_EXPORT_LIMITS = Object.freeze({ rows: 4096, events: 4096, pageRows: 64, bodyBytes: 8 * 1024 * 1024, totalBodyBytes: 16 * 1024 * 1024, receiptBytes: 8192 });
export const TARGET_TURN_MEANING = "Target continuation's V2 turn coordinate for converted events. Original prefix turns are unchanged.";
export interface MemoryV2ExportInput {
  expectedStoreId: string;
  expectedStoreRevision: number;
  /** Explicit operator input. Never inferred from recordedSequence or conversation history. */
  targetTurn: number;
  sidecarPath: string;
  companionPath: string;
  receiptPath: string;
  signal?: AbortSignal;
}
export interface ExportArtifact { path: string; bytes: number; sha256: string; device: string; inode: string }
export interface MemoryV2ExportReceipt {
  schemaVersion: 1;
  kind: "context-memory-v2-export";
  exportId: string;
  exportedAt: string;
  namespaceId: string;
  storeId: string;
  storeRevision: number;
  recordedSequence: number;
  targetTurn: number;
  targetTurnMeaning: typeof TARGET_TURN_MEANING;
  sidecar: ExportArtifact;
  companion: ExportArtifact;
  receiptPath: string;
  prefix: { importId: string | null; bytes: number; sha256: string; events: number; exact: true };
  counts: { revisions: number; knowledgeHeads: number; proposalHeads: number; v2Events: number; convertedEvents: number; provenanceSyncEvents: number };
  acceptedHeadSemanticHash: string;
  semanticParity: "exact";
  retention: { policy: "no-touch-no-reset-no-rebase"; defaultV2PinnedDemotionsAtTarget: number; notice: string };
  activation: { performed: false; required: string };
}
interface EventLink { eventId: string; eventHash: string; action: V2Action; role: "native-operation" | "provenance-sync" | "superseded-effect" | "original-prefix" }
interface Mapping { events: EventLink[]; companionOnly?: "proposal-state" }
const recordKey = (record: MemoryRecord): string => record.revisionHash;
const semanticKeys = ["memoryId", "text", "sourceRef", "scope", "authority", "protected", "confidence", "state", "createdAt", "useCount", "supersedesMemoryId"] as const;
function semantics(record: MemoryRecord | V2Head): Record<string, unknown> {
  return { ...Object.fromEntries(semanticKeys.map(key => [key, record[key]])), updatedAt: "recordedAt" in record ? record.recordedAt : record.updatedAt };
}
function compareHead(record: MemoryRecord, head?: V2Head): void {
  if (!head || canonical(semantics(record)) !== canonical(semantics(head))) fail("export-accepted-head-semantic-mismatch");
}
class Body {
  private chunks: Buffer[] = [];
  bytes = 0;
  constructor(private readonly label: "sidecar" | "companion") {}
  add(value: string | Buffer): void {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    if (bytes.length > V2_EXPORT_LIMITS.bodyBytes - this.bytes) fail(`export-${this.label}-limit`);
    this.chunks.push(bytes); this.bytes += bytes.length;
  }
  json(value: unknown): void { this.add(`${canonical(value)}\n`); }
  finish(): Buffer { return Buffer.concat(this.chunks, this.bytes); }
}
function convert(snapshot: ExportSnapshot, targetTurn: number, exportId: string, check: () => void) {
  const replay = new V2Replay(), sidecar = new Body("sidecar"), companion = new Body("companion"), mappings = new Map<string, Mapping>();
  const prefix = snapshot.imported?.bytes ?? Buffer.alloc(0), nativeHeads = new Map<string, MemoryRecord>();
  let prefixText: string;
  try { prefixText = new TextDecoder("utf-8", { fatal: true }).decode(prefix); } catch { return fail("export-prefix-utf8"); }
  sidecar.add(prefix);
  for (const line of prefixText.split("\n")) {
    if (!line) continue;
    check(); if (replay.events.length >= V2_EXPORT_LIMITS.events || Buffer.byteLength(line) > LIMITS.record) fail("export-event-limit");
    let event: V2Event; try { event = JSON.parse(line); } catch { return fail("export-prefix-invalid"); }
    replay.load(event);
  }
  const prefixEvents = replay.events.length, prefixById = new Map(replay.events.map(event => [event.eventId, event]));
  const ordered = [...snapshot.records].sort((a, b) => a.recordedSequence - b.recordedSequence || a.revision - b.revision || a.memoryId.localeCompare(b.memoryId));
  const legacy = ordered.filter(record => record.operation.startsWith("legacy:"));
  if (legacy.length && !snapshot.imported || snapshot.imported && (snapshot.imported.receipt.eventCount !== prefixEvents || snapshot.imported.receipt.revisionCount !== legacy.length)) fail("export-prefix-revisions");
  for (const record of legacy) {
    if (record.legacy?.importId !== snapshot.imported?.id || record.recordedSequence > prefixEvents) fail("export-prefix-revisions");
    const event = prefixById.get(String(record.operation === "legacy:superseded" ? record.legacy?.supersededByEventId : record.legacy?.eventId));
    if (!event) fail("export-prefix-revisions");
    mappings.set(recordKey(record), { events: [{ eventId: event.eventId, eventHash: event.eventHash, action: event.action, role: "original-prefix" }] });
    nativeHeads.set(record.memoryId, record);
  }
  if (nativeHeads.size !== replay.heads.size) fail("export-prefix-heads");
  for (const record of nativeHeads.values()) compareHead(record, replay.heads.get(record.memoryId));
  let provenanceSyncEvents = 0;
  function link(record: MemoryRecord, event: V2Event, role: EventLink["role"]) {
    const mapping = mappings.get(recordKey(record)) ?? { events: [] };
    mapping.events.push({ eventId: event.eventId, eventHash: event.eventHash, action: event.action, role }); mappings.set(recordKey(record), mapping);
  }
  function emit(record: MemoryRecord, action: "remember" | "update" | "forget" | "promote", role: EventLink["role"] = "native-operation"): V2Event {
    check(); if (replay.events.length >= V2_EXPORT_LIMITS.events) fail("export-event-limit");
    if (record.protected || record.authority !== "ordinary") fail("export-protected-mutation");
    if (action === "promote" && targetTurn > Number.MAX_SAFE_INTEGER - 8) fail("export-target-turn-promotion-overflow");
    const event = replay.append({ action, memoryId: record.memoryId, timestamp: record.recordedAt, turn: targetTurn,
      text: action === "remember" || action === "update" ? record.text : undefined, scope: record.scope, confidence: record.confidence,
      authority: "ordinary", sourceRef: record.sourceRef, ...(record.reason === undefined ? {} : { reason: record.reason }),
      ...(action === "remember" && record.supersedesMemoryId !== undefined ? { supersedesMemoryId: record.supersedesMemoryId } : {}) });
    if (replay.events.length === prefixEvents + 1 && prefix.length && prefix.at(-1) !== 10) sidecar.add("\n");
    sidecar.add(`${v2Stringify(event)}\n`); link(record, event, role); return event;
  }
  function syncProvenance(record: MemoryRecord): void {
    const prior = replay.heads.get(record.memoryId);
    if (!prior) fail("export-operation-shape");
    if (prior.sourceRef !== record.sourceRef) { emit(record, "update", "provenance-sync"); provenanceSyncEvents++; }
  }
  const native = ordered.filter(record => !record.operation.startsWith("legacy:"));
  for (let index = 0; index < native.length;) {
    check(); const first = native[index]!, group: MemoryRecord[] = [];
    while (index < native.length && native[index]!.recordedSequence === first.recordedSequence) group.push(native[index++]!);
    if (group.length > 3 || first.recordedSequence <= prefixEvents
      || group.some(record => record.operation !== first.operation || record.recordedAt !== first.recordedAt || canonical(record.origin) !== canonical(first.origin))) fail("export-operation-shape");
    for (const record of group) {
      const previous = nativeHeads.get(record.memoryId);
      if (record.revision !== (previous?.revision ?? 0) + 1 || record.previousHash !== (previous?.revisionHash ?? null)) fail("export-operation-order");
    }
    const knowledge = group.filter(record => record.kind === "knowledge"), proposals = group.filter(record => record.kind === "proposal");
    if (first.operation === "remember") {
      const created = knowledge.filter(record => record.revision === 1 && record.state === "current");
      if (proposals.length || created.length !== 1 || group.length > 2) fail("export-operation-shape");
      const record = created[0]!, target = knowledge.find(value => value !== record);
      if (record.supersedesMemoryId === undefined ? target !== undefined : !target || target.memoryId !== record.supersedesMemoryId || target.state !== "superseded") fail("export-operation-shape");
      if (target) syncProvenance(target);
      const event = emit(record, "remember"); if (target) link(target, event, "superseded-effect");
    } else if (["update", "forget", "promote"].includes(first.operation)) {
      if (group.length !== 1 || knowledge.length !== 1 || first.revision === 1) fail("export-operation-shape");
      if (first.operation !== "update") syncProvenance(first);
      emit(first, first.operation as "update" | "forget" | "promote");
    } else if (first.operation === "accept") {
      if (group.length !== 2 || knowledge.length !== 1 || proposals.length !== 1) fail("export-operation-shape");
      const accepted = knowledge[0]!, proposal = proposals[0]!;
      if (proposal.state !== "accepted" || nativeHeads.get(proposal.memoryId)?.state !== "pending" || proposal.acceptedMemoryId !== accepted.memoryId
        || proposal.acceptedRevision !== accepted.revision || accepted.derivedFromMemoryId !== proposal.memoryId) fail("export-proposal-link");
      emit(accepted, accepted.revision === 1 ? "remember" : "update");
      mappings.set(recordKey(proposal), { events: [], companionOnly: "proposal-state" });
    } else if (first.operation === "propose" || first.operation === "reject") {
      if (group.length !== 1 || proposals.length !== 1 || (first.operation === "propose" ? first.revision !== 1 || first.state !== "pending"
        : first.state !== "rejected" || nativeHeads.get(first.memoryId)?.state !== "pending")) fail("export-operation-shape");
      mappings.set(recordKey(first), { events: [], companionOnly: "proposal-state" });
    } else fail("export-operation-unsupported");
    for (const record of group) { nativeHeads.set(record.memoryId, record); if (record.kind === "knowledge") compareHead(record, replay.heads.get(record.memoryId)); }
  }
  const knowledgeHeads = [...nativeHeads.values()].filter(record => record.kind === "knowledge").sort((a, b) => a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0);
  if (knowledgeHeads.length !== replay.heads.size || mappings.size !== snapshot.records.length) fail("export-completeness");
  for (const record of knowledgeHeads) compareHead(record, replay.heads.get(record.memoryId));
  const semanticHash = sha(canonical(knowledgeHeads.map(semantics))), proposalHeads = nativeHeads.size - knowledgeHeads.length;
  companion.json({ schemaVersion: 1, type: "header", format: "context-memory-v2-companion", exportId, nativeMeta: snapshot.meta,
    targetTurn, targetTurnMeaning: TARGET_TURN_MEANING, notice: "Recovery data, not executable instructions. Complete committed logical-session revisions. The original independent store remains a recovery asset.",
    originalImport: snapshot.imported ? { id: snapshot.imported.id, identity: snapshot.imported.identity, digest: snapshot.imported.digest,
      bytes: prefix.length, receipt: snapshot.imported.receipt } : null });
  let defaultV2PinnedDemotionsAtTarget = 0;
  for (const record of snapshot.records) {
    check(); const isHead = nativeHeads.get(record.memoryId)?.revisionHash === record.revisionHash;
    const head = isHead && record.kind === "knowledge" ? replay.heads.get(record.memoryId) : undefined;
    const defaultPinnedDemoted = head ? !head.protected && head.state === "current" && (head.promotedUntilTurn ?? -1) < targetTurn
      && targetTurn - head.lastUsedTurn > 48 + Math.min(48 * 4, head.useCount * 8) : false;
    if (defaultPinnedDemoted) defaultV2PinnedDemotionsAtTarget++;
    companion.json({ schemaVersion: 1, type: "revision", head: isHead, record, v2: mappings.get(recordKey(record)),
      ...(head ? { v2Retention: { createdTurn: head.createdTurn, lastUsedTurn: head.lastUsedTurn, useCount: head.useCount,
        ...(head.promotedUntilTurn === undefined ? {} : { promotedUntilTurn: head.promotedUntilTurn }), defaultPinnedDemotedAtTarget: defaultPinnedDemoted } } : {}) });
  }
  companion.json({ schemaVersion: 1, type: "integrity", revisionCount: snapshot.records.length, knowledgeHeads: knowledgeHeads.length, proposalHeads,
    acceptedHeadSemanticHash: semanticHash, precedingBytes: companion.bytes, precedingSha256: sha(companion.finish()),
    sidecarSha256: sha(sidecar.finish()), exactNativeCountersTimesRelations: true });
  if (sidecar.bytes + companion.bytes > V2_EXPORT_LIMITS.totalBodyBytes) fail("export-total-limit");
  return { sidecar: sidecar.finish(), companion: companion.finish(), semanticHash, prefix,
    counts: { revisions: snapshot.records.length, knowledgeHeads: knowledgeHeads.length, proposalHeads,
      v2Events: replay.events.length, convertedEvents: replay.events.length - prefixEvents, provenanceSyncEvents },
    prefixEvents, defaultV2PinnedDemotionsAtTarget };
}
function targetPath(value: unknown): string {
  const path = text(value, 4096);
  if (!isAbsolute(path) || resolve(path) !== path) fail("export-path-invalid");
  privateDirectory(dirname(path));
  if (privateFile(path, true)) fail("export-target-exists");
  return path;
}
/** New exclusive private file. A failure can leave a partial artifact, never an activation receipt. */
function publish(path: string, bytes: Buffer, check: () => void): ExportArtifact {
  check(); privateDirectory(dirname(path));
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    for (let offset = 0; offset < bytes.length;) {
      check(); const written = writeSync(fd, bytes, offset, Math.min(65536, bytes.length - offset), offset);
      if (!written) fail("export-output-write"); offset += written;
    }
    fsyncSync(fd); const before = fstatSync(fd), reread = Buffer.alloc(Math.min(65536, bytes.length));
    for (let offset = 0; offset < bytes.length;) {
      check(); const length = Math.min(reread.length, bytes.length - offset), actual = readSync(fd, reread, 0, length, offset);
      if (actual !== length || !reread.subarray(0, length).equals(bytes.subarray(offset, offset + length))) fail("export-output-integrity");
      offset += length;
    }
    const after = fstatSync(fd), current = lstatSync(path);
    if (!before.isFile() || before.size !== bytes.length || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || after.dev !== current.dev || after.ino !== current.ino || !current.isFile() || current.isSymbolicLink()) fail("export-output-changed");
    privateDirectory(dirname(path)); privateFile(path); syncDirectory(dirname(path));
    return { path, bytes: bytes.length, sha256: sha(bytes), device: String(after.dev), inode: String(after.ino) };
  } finally { closeSync(fd); }
}
/** Operator-only bounded export. Does not register/select a writer, restore a session, or activate a sidecar.
 * Publication is synchronous inside a reserved SQLite transaction. Other writers cannot advance the cut.
 * Parent integration must verify this sidecar as memorySidecarPath(actualFreshTargetSessionFile).
 */
export async function exportMemoryV2(store: MemoryStore, input: MemoryV2ExportInput): Promise<MemoryV2ExportReceipt> {
  object(input, ["expectedStoreId", "expectedStoreRevision", "targetTurn", "sidecarPath", "companionPath", "receiptPath", "signal"]);
  const expectedStoreId = text(input.expectedStoreId), expectedStoreRevision = integer(input.expectedStoreRevision, 0);
  const targetTurn = integer(input.targetTurn, 0), check = () => { if (input.signal?.aborted) fail("cancelled"); };
  check(); const paths = [input.sidecarPath, input.companionPath, input.receiptPath].map(targetPath);
  if (new Set(paths).size !== 3) fail("export-path-conflict");
  const [sidecarPath, companionPath, receiptPath] = paths as [string, string, string], exportId = randomUUID();
  return store.withExportSnapshot(expectedStoreId, expectedStoreRevision, snapshot => {
    const bodies = convert(snapshot, targetTurn, exportId, check);
    const sidecar = publish(sidecarPath, bodies.sidecar, check), companion = publish(companionPath, bodies.companion, check);
    const receipt: MemoryV2ExportReceipt = {
      schemaVersion: 1, kind: "context-memory-v2-export", exportId, exportedAt: new Date().toISOString(), namespaceId: snapshot.meta.namespaceId,
      storeId: snapshot.meta.storeId, storeRevision: snapshot.meta.revision, recordedSequence: snapshot.meta.recordedSequence,
      targetTurn, targetTurnMeaning: TARGET_TURN_MEANING, sidecar, companion, receiptPath,
      prefix: { importId: snapshot.imported?.id ?? null, bytes: bodies.prefix.length, sha256: sha(bodies.prefix), events: bodies.prefixEvents, exact: true },
      counts: bodies.counts, acceptedHeadSemanticHash: bodies.semanticHash, semanticParity: "exact",
      retention: { policy: "no-touch-no-reset-no-rebase", defaultV2PinnedDemotionsAtTarget: bodies.defaultV2PinnedDemotionsAtTarget,
        notice: "V2 uses conversation-turn retention and can hide current ordinary knowledge from pinned rendering. Independent Memory does not auto-demote and uses an eight-commit promotion boost. Default V2 decay at targetTurn is reported in the companion. Native counters, times, validity, sources, and relations are preserved exactly there." },
      activation: { performed: false, required: "Before selecting the old writer, verify this exact sidecar as memorySidecarPath(actualFreshTargetSessionFile), verify native source-known reads, and recheck this independent cut has no pending or later writes. Select only one writer." },
    };
    const bytes = Buffer.from(`${canonical(receipt)}\n`);
    if (bytes.length > V2_EXPORT_LIMITS.receiptBytes) fail("export-receipt-limit");
    check(); publish(receiptPath, bytes, check); return receipt;
  }, input.signal);
}
