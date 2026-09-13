import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";
import { at, canonical, fail, integer, LIMITS, object, plain, sealRecord, sha, text, type MemoryRecord, type Origin } from "./contracts.ts";
import { sourceTicket, type Anchor } from "./files.ts";
import type { MemoryStore } from "./store.ts";

const hash20 = (value: string): string => sha(value).slice(0, 20);
const protectedAuthorities = ["system", "user", "project", "skill"];
export interface LegacyImport { id: string; identity: string; digest: string; bytes: Buffer; records: MemoryRecord[]; receipt: Record<string, unknown> }
const same = (a: any, b: any) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
/** Explicit bounded import only. No session enumeration, reserialization, or source writes. */
export async function readLegacySource(path: string): Promise<{ bytes: Buffer; identity: string }> {
  if (resolve(path) !== path) fail("import-path-invalid");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o022n) !== 0n) fail("import-source-unsafe");
    if (before.size > BigInt(LIMITS.importBytes)) fail("import-limit");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await file.read(buffer, offset, Math.min(65536, buffer.length - offset), offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await file.stat({ bigint: true }), current = await lstat(path, { bigint: true });
    if (!same(before, after) || !same(after, current) || !current.isFile() || current.isSymbolicLink() || offset !== Number(before.size)) fail("import-source-changed");
    return { bytes: buffer.subarray(0, offset), identity: sha(`${path}\n${before.dev}\n${before.ino}`) };
  } finally { await file.close(); }
}
/** The old hash is 20 hex characters. Only the chain's initial previous hash is 64 zeroes. */
export function parseLegacyImport(bytes: Buffer, identity: string, sourceSessionId: string | null = null): LegacyImport {
  text(identity, 128); if (sourceSessionId !== null) text(sourceSessionId);
  if (bytes.length > LIMITS.importBytes) fail("import-limit");
  let decoded: string;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail("import-utf8"); }
  const digest = sha(bytes), id = sha(`${identity}\n${digest}`), heads = new Map<string, MemoryRecord>(), records: MemoryRecord[] = [];
  let previousEventHash = "0".repeat(64), offset = 0, eventCount = 0, lastRecordedAt = "1970-01-01T00:00:00.000Z";
  const eventIds = new Set<string>(), eventHashes: string[] = [];
  for (const line of decoded.split("\n")) {
    const length = Buffer.byteLength(line), raw = { offset, length, hash: sha(line) };
    offset += length + 1;
    if (!line) continue;
    if (++eventCount > LIMITS.importEvents || length > LIMITS.record) fail("import-limit");
    let event: any;
    try { event = object(plain(JSON.parse(line), LIMITS.record), ["schemaVersion", "eventId", "memoryId", "action", "timestamp", "turn", "previousEventHash", "eventHash", "sourceRef", "scope", "authority", "confidence", "text", "reason", "supersedesMemoryId", "authoritativeSourceHash", "authoritativeSourceIdentity", "authoritativeVerifier"]); }
    catch { fail("import-event-invalid"); }
    const { eventHash, ...payload } = event;
    if (event.schemaVersion !== 2 || event.previousEventHash !== previousEventHash || !/^[a-f0-9]{20}$/.test(eventHash) || hash20(canonical(payload)) !== eventHash) fail("import-integrity");
    if (!/^[a-f0-9]{20}$/.test(event.eventId) || eventIds.has(event.eventId)) fail("import-event-identity");
    eventIds.add(event.eventId); eventHashes.push(eventHash); previousEventHash = eventHash;
    text(event.memoryId); text(event.sourceRef, 2048); text(event.scope, 256); at(event.timestamp); integer(event.turn, 0);
    if (!Number.isFinite(event.confidence) || event.confidence < 0 || event.confidence > 1 || !["ordinary", ...protectedAuthorities].includes(event.authority)) fail("import-event-invalid");
    if (!["remember", "update", "promote", "touch", "demote", "forget"].includes(event.action)) fail("import-action-invalid");
    if (event.reason !== undefined) text(event.reason, 1024);
    if (event.supersedesMemoryId !== undefined) text(event.supersedesMemoryId);
    if (event.action === "remember" || event.action === "update") text(event.text, LIMITS.text);
    if (event.timestamp > lastRecordedAt) lastRecordedAt = event.timestamp;
    const prior = heads.get(event.memoryId), protectedValue = protectedAuthorities.includes(event.authority);
    if (event.action === "remember" && prior || event.action !== "remember" && (!prior || prior.protected)) fail("import-transition-invalid");
    if (event.action === "remember" && protectedValue) {
      const sourceHash = sha(event.text), sourceIdentity = hash20(`${event.authority}\n${event.sourceRef}\n${sourceHash}\nconfigured-file-v1`);
      if (!["project", "skill"].includes(event.authority) || !event.sourceRef.startsWith(`${event.authority}:`) || event.authoritativeVerifier !== "configured-file-v1"
        || event.authoritativeSourceHash !== sourceHash || event.authoritativeSourceIdentity !== sourceIdentity) fail("import-protected-integrity");
    }
    const origin: Origin = { sessionId: sourceSessionId, leafId: null, toolCallId: null };
    const legacy: Record<string, unknown> = { importId: id, eventId: event.eventId, eventHash, previousEventHash: event.previousEventHash,
      action: event.action, timestamp: event.timestamp, turn: event.turn, sourceRef: event.sourceRef, raw,
      createdTurn: prior?.legacy?.createdTurn ?? event.turn,
      lastUsedTurn: ["remember", "promote", "touch"].includes(event.action) ? event.turn : prior?.legacy?.lastUsedTurn,
      ...(prior?.legacy?.promotedUntilTurn === undefined ? {} : { promotedUntilTurn: prior.legacy.promotedUntilTurn }),
      ...(event.action === "promote" ? { promotedUntilTurn: event.turn + 8 } : {}),
      ...(event.authoritativeSourceHash === undefined ? {} : { authoritativeSourceHash: event.authoritativeSourceHash, authoritativeSourceIdentity: event.authoritativeSourceIdentity, authoritativeVerifier: event.authoritativeVerifier }) };
    const changingText = event.action === "remember" || event.action === "update";
    const state = ["remember", "update", "promote"].includes(event.action) ? "current" : ["forget", "demote"].includes(event.action) ? "demoted" : prior!.state;
    const record = sealRecord({ schemaVersion: 1, memoryId: event.memoryId, revision: (prior?.revision ?? 0) + 1, kind: "knowledge", state,
      text: changingText ? event.text : prior!.text, scope: changingText ? event.scope : prior!.scope,
      confidence: changingText ? event.confidence : prior!.confidence, authority: prior?.authority ?? event.authority, protected: prior?.protected ?? protectedValue,
      createdAt: prior?.createdAt ?? event.timestamp, recordedAt: event.timestamp, recordedSequence: eventCount,
      eventTime: { kind: "unknown" }, validity: { kind: "unknown" }, origin, originalOrigin: prior?.originalOrigin ?? origin,
      sources: [{ identity: `legacy-memory:${identity}:${event.eventId}`, kind: "legacy", reference: event.sourceRef, role: "legacy_operation", derivation: "unknown", verification: "legacy_integrity" }],
      sourceRef: changingText ? event.sourceRef : prior!.sourceRef, operation: `legacy:${event.action}`, previousHash: prior?.revisionHash ?? null,
      useCount: (prior?.useCount ?? 0) + (["touch", "promote"].includes(event.action) ? 1 : 0), legacy,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
      ...(event.action === "remember" && event.supersedesMemoryId ? { supersedesMemoryId: event.supersedesMemoryId } : prior?.supersedesMemoryId ? { supersedesMemoryId: prior.supersedesMemoryId } : {}) });
    records.push(record); heads.set(record.memoryId, record);
    if (event.action === "remember" && event.supersedesMemoryId) {
      const superseded = heads.get(event.supersedesMemoryId);
      if (superseded?.protected && !protectedValue) fail("import-transition-invalid");
      if (superseded) {
        const { revisionHash, ...body } = superseded;
        const transition = sealRecord({ ...body, state: "superseded", revision: superseded.revision + 1, recordedAt: event.timestamp,
          recordedSequence: eventCount, operation: "legacy:superseded", previousHash: revisionHash,
          legacy: { ...superseded.legacy, supersededByEventId: event.eventId } });
        records.push(transition); heads.set(transition.memoryId, transition);
      }
    }
  }
  return { id, identity, digest, bytes, records, receipt: { schemaVersion: 1, importId: id, sourceIdentity: identity, sourceDigest: digest,
    sourceBytes: bytes.length, eventCount, revisionCount: records.length, memoryCount: heads.size, sourceSessionId,
    sourceLeafId: null, sourceOriginVerification: sourceSessionId === null ? "unknown" : "operator_declared", generationHash: hash20(canonical(eventHashes)),
    lastEventHash: previousEventHash, lastRecordedAt, recordedSequence: eventCount, importedAt: new Date().toISOString(), exactSourceRetained: true } };
}
export async function importLegacyV2(store: MemoryStore, input: LegacyImport, sessionPath: string, bind: (anchor: Anchor) => void, check = () => {}): Promise<Record<string, unknown>> {
  const prior = store.imported(input.id);
  if (prior) return { ...prior, noOp: true };
  check(); const stagedReceipt = await store.stageImport(input); check();
  const receipt = store.execute(`import:${input.id}`, sha(`import:${input.id}`), sourceTicket(sessionPath), () => ({ importDataset: input.id, importReceipt: stagedReceipt }), bind);
  return { ...receipt.importReceipt, storeId: receipt.storeId, storeRevision: receipt.storeRevision, noOp: false };
}
