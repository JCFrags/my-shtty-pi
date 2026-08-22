import { constants as fsConstants } from "node:fs";
import { open, rename, rm, stat } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { stableStringify } from "./utils.js";

export const SOURCE_LEDGER_SUFFIX = ".chrono-source-ledger-v1.jsonl";
const SCHEMA_VERSION = 1;
const ZERO_HASH = "0".repeat(64);
const READ_CHUNK = 64 * 1024;

export type SourceLedgerTransition = "new" | "exact-hit" | "append" | "rebuild-truncation" | "rebuild-replacement" | "rebuild-tail-rewrite" | "recover-incomplete-ledger-tail";

export interface SourceLedgerEntry {
  readonly recordType: "entry";
  readonly entryId: string;
  readonly parentId: string | null;
  readonly entryType: string;
  readonly lineNumber: number;
  readonly sourceByteOffset: number;
  readonly sourceByteLength: number;
  readonly nextSourceByteOffset: number;
  readonly sourceContentHash: string;
  readonly previousLedgerRecordHash: string;
  readonly ledgerRecordHash: string;
}

interface LedgerHeader {
  readonly recordType: "header";
  readonly schemaVersion: 1;
  readonly sourceFileIdentity: { readonly deviceId: string; readonly inodeId: string };
  readonly sourceSessionIdentity: string | null;
  readonly createdAt: string;
  readonly firstIntegrityChainValue: string;
  readonly previousLedgerRecordHash: string;
  readonly ledgerRecordHash: string;
}

export interface SourceLedgerCheckpoint {
  readonly recordType: "checkpoint";
  readonly sourceBytePosition: number;
  readonly sourceFileSize: number;
  readonly indexedEntryCount: number;
  readonly lastIndexedEntryId: string | null;
  readonly lastIndexedSourceContentHash: string | null;
  readonly integrityChainState: string;
  readonly transition: SourceLedgerTransition;
  readonly previousLedgerRecordHash: string;
  readonly ledgerRecordHash: string;
}

type LedgerRecord = LedgerHeader | SourceLedgerEntry | SourceLedgerCheckpoint;

export interface SourceLedgerMetrics {
  readonly transition: SourceLedgerTransition;
  readonly sourceFileSize: number;
  readonly sourceBytesRead: number;
  readonly sourceCompleteLinesParsed: number;
  readonly entriesIndexed: number;
  readonly entriesAppended: number;
  readonly ledgerBytesRead: number;
  readonly ledgerBytesWritten: number;
  readonly ledgerRecordsReplayed: number;
  readonly exactRetrievalBytesRead: number;
}

export interface SourceLedger {
  readonly sourceIdentity: { readonly deviceId: string; readonly inodeId: string };
  readonly sourceSessionIdentity: string | null;
  readonly entryById: Map<string, SourceLedgerEntry>;
  readonly sourceOrder: SourceLedgerEntry[];
  readonly checkpoint: SourceLedgerCheckpoint;
  readonly integrityChainState: string;
  readonly sidecarCommittedBytes: number;
  readonly incompleteSidecarTail: boolean;
  readonly metrics: SourceLedgerMetrics;
}

export interface SourceLedgerUpdateOptions {
  readonly sidecarPath?: string;
  readonly lockAcquired?: () => void | Promise<void>;
}

export class SourceLedgerError extends Error {
  readonly lineNumber?: number;
  constructor(message: string, lineNumber?: number) {
    super(lineNumber === undefined ? message : `${message} (line ${lineNumber})`);
    this.name = "SourceLedgerError";
    this.lineNumber = lineNumber;
  }
}

export function sourceLedgerPath(sessionPath: string): string { return `${sessionPath}${SOURCE_LEDGER_SUFFIX}`; }
function hashBytes(value: Uint8Array | string): string { return createHash("sha256").update(value).digest("hex"); }
function identity(metadata: { dev: number | bigint; ino: number | bigint }): { deviceId: string; inodeId: string } {
  return { deviceId: String(metadata.dev), inodeId: String(metadata.ino) };
}
function sameIdentity(a: SourceLedger["sourceIdentity"], b: SourceLedger["sourceIdentity"]): boolean {
  return a.deviceId === b.deviceId && a.inodeId === b.inodeId;
}
function withHash<T extends object>(record: T, previousLedgerRecordHash: string): T & { previousLedgerRecordHash: string; ledgerRecordHash: string } {
  const base = { ...record, previousLedgerRecordHash };
  return { ...base, ledgerRecordHash: hashBytes(stableStringify(base)) };
}
function verifyRecord(record: LedgerRecord, expectedPrevious: string): boolean {
  if (record.previousLedgerRecordHash !== expectedPrevious || !/^[a-f0-9]{64}$/.test(record.ledgerRecordHash)) return false;
  const { ledgerRecordHash, ...base } = record;
  return hashBytes(stableStringify(base)) === ledgerRecordHash;
}
function noFollowFlags(): number { return fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0); }

async function acquireLock(sidecar: string): Promise<() => Promise<void>> {
  const lockPath = `${sidecar}.lock`;
  let handle;
  try { handle = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SourceLedgerError("Source ledger is busy; another writer holds the sidecar lock.");
    throw error;
  }
  return async () => { await handle.close(); await rm(lockPath, { force: true }); };
}

interface ParsedSource {
  header: Record<string, unknown>;
  entries: Omit<SourceLedgerEntry, "previousLedgerRecordHash" | "ledgerRecordHash">[];
  completePosition: number;
  lines: number;
  bytesRead: number;
}

async function parseSourceRange(path: string, start: number, end: number, firstLine: number, requireHeader: boolean): Promise<ParsedSource> {
  const handle = await open(path, noFollowFlags());
  let bytesRead = 0;
  let pending = Buffer.alloc(0);
  let pendingOffset = start;
  let position = start;
  let lineNumber = firstLine;
  let header: Record<string, unknown> | undefined;
  const entries: ParsedSource["entries"] = [];
  const parseComplete = (raw: Buffer, offset: number, nextOffset: number): void => {
    let content = raw;
    if (content.at(-1) === 13) content = content.subarray(0, -1);
    let value: unknown;
    try { value = JSON.parse(content.toString("utf8")); }
    catch (error) { throw new SourceLedgerError(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, lineNumber); }
    if (value === null || typeof value !== "object" || Array.isArray(value) || typeof (value as Record<string, unknown>).type !== "string") {
      throw new SourceLedgerError("Every JSONL record must be an object with a string type", lineNumber);
    }
    const object = value as Record<string, unknown>;
    if (requireHeader && lineNumber === 1) {
      if (object.type !== "session") throw new SourceLedgerError("The first complete record must be a session header", 1);
      header = object;
    } else {
      if (typeof object.id !== "string" || object.id.length === 0) throw new SourceLedgerError(`Entry of type ${String(object.type)} is missing an id`, lineNumber);
      entries.push({ recordType: "entry", entryId: object.id, parentId: typeof object.parentId === "string" ? object.parentId : null,
        entryType: object.type as string, lineNumber, sourceByteOffset: offset, sourceByteLength: content.length,
        nextSourceByteOffset: nextOffset, sourceContentHash: hashBytes(content) });
    }
    lineNumber += 1;
  };
  try {
    while (position < end) {
      const requested = Math.min(READ_CHUNK, end - position);
      const buffer = Buffer.allocUnsafe(requested);
      const read = await handle.read(buffer, 0, requested, position);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead; position += read.bytesRead;
      pending = Buffer.concat([pending, buffer.subarray(0, read.bytesRead)]);
      let cut;
      while ((cut = pending.indexOf(10)) >= 0) {
        parseComplete(pending.subarray(0, cut), pendingOffset, pendingOffset + cut + 1);
        pending = pending.subarray(cut + 1); pendingOffset += cut + 1;
      }
    }
    if (position === end && pending.length > 0) {
      try { parseComplete(pending, pendingOffset, end); pending = Buffer.alloc(0); pendingOffset = end; }
      catch (error) {
        if (!(error instanceof SourceLedgerError) || !/^Invalid JSON:/.test(error.message)) throw error;
      }
    }
  } finally { await handle.close(); }
  if (requireHeader && !header) throw new SourceLedgerError("The source has no complete session header.");
  return { header: header ?? {}, entries, completePosition: pendingOffset, lines: lineNumber - firstLine, bytesRead };
}

function sessionIdentity(header: Record<string, unknown>): string | null {
  for (const key of ["id", "sessionId", "session_id"]) if (typeof header[key] === "string" && (header[key] as string).length > 0) return header[key] as string;
  return null;
}
function sourceAnchor(ledger: SourceLedger): SourceLedgerEntry | undefined { return ledger.sourceOrder.at(-1); }
async function anchorMatches(path: string, ledger: SourceLedger): Promise<{ matches: boolean; bytesRead: number }> {
  const anchor = sourceAnchor(ledger);
  if (!anchor) return { matches: true, bytesRead: 0 };
  const handle = await open(path, noFollowFlags());
  try {
    const bytes = Buffer.alloc(anchor.sourceByteLength);
    const read = await handle.read(bytes, 0, bytes.length, anchor.sourceByteOffset);
    return { matches: read.bytesRead === bytes.length && hashBytes(bytes) === anchor.sourceContentHash, bytesRead: read.bytesRead };
  } finally { await handle.close(); }
}
function metric(transition: SourceLedgerTransition, size: number, patch: Partial<SourceLedgerMetrics> = {}): SourceLedgerMetrics {
  return { transition, sourceFileSize: size, sourceBytesRead: 0, sourceCompleteLinesParsed: 0, entriesIndexed: 0,
    entriesAppended: 0, ledgerBytesRead: 0, ledgerBytesWritten: 0, ledgerRecordsReplayed: 0, exactRetrievalBytesRead: 0, ...patch };
}
function checkpointRecord(previous: string, sourcePosition: number, sourceSize: number, entries: SourceLedgerEntry[], transition: SourceLedgerTransition): SourceLedgerCheckpoint {
  const last = entries.at(-1);
  return withHash({ recordType: "checkpoint" as const, sourceBytePosition: sourcePosition, sourceFileSize: sourceSize,
    indexedEntryCount: entries.length, lastIndexedEntryId: last?.entryId ?? null, lastIndexedSourceContentHash: last?.sourceContentHash ?? null,
    integrityChainState: previous, transition }, previous);
}
function encode(records: readonly LedgerRecord[]): Buffer { return Buffer.from(`${records.map((record) => stableStringify(record)).join("\n")}\n`); }

async function atomicWrite(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function rebuild(sessionPath: string, sidecar: string, transition: SourceLedgerTransition): Promise<SourceLedger> {
  const metadata = await stat(sessionPath, { bigint: true });
  if (!metadata.isFile()) throw new SourceLedgerError("Source session must be a regular file.");
  const parsed = await parseSourceRange(sessionPath, 0, Number(metadata.size), 1, true);
  const seen = new Set<string>(); let previous = ZERO_HASH;
  const header = withHash({ recordType: "header" as const, schemaVersion: SCHEMA_VERSION as 1, sourceFileIdentity: identity(metadata),
    sourceSessionIdentity: sessionIdentity(parsed.header), createdAt: new Date().toISOString(), firstIntegrityChainValue: ZERO_HASH }, previous);
  previous = header.ledgerRecordHash;
  const entries: SourceLedgerEntry[] = parsed.entries.map((item) => {
    if (seen.has(item.entryId)) throw new SourceLedgerError(`Duplicate entry id ${item.entryId}`, item.lineNumber);
    seen.add(item.entryId); const record = withHash(item, previous); previous = record.ledgerRecordHash; return record;
  });
  const checkpoint = checkpointRecord(previous, parsed.completePosition, Number(metadata.size), entries, transition);
  const bytes = encode([header, ...entries, checkpoint]);
  await atomicWrite(sidecar, bytes);
  return { sourceIdentity: header.sourceFileIdentity, sourceSessionIdentity: header.sourceSessionIdentity,
    entryById: new Map(entries.map((entry) => [entry.entryId, entry])), sourceOrder: entries, checkpoint,
    integrityChainState: checkpoint.ledgerRecordHash, sidecarCommittedBytes: bytes.length, incompleteSidecarTail: false,
    metrics: metric(transition, Number(metadata.size), { sourceBytesRead: parsed.bytesRead, sourceCompleteLinesParsed: parsed.lines,
      entriesIndexed: entries.length, entriesAppended: entries.length, ledgerBytesWritten: bytes.length }) };
}

export async function loadSourceLedger(sessionPath: string, explicitSidecar = sourceLedgerPath(sessionPath)): Promise<SourceLedger> {
  let handle;
  try { handle = await open(explicitSidecar, noFollowFlags()); }
  catch (error) { throw new SourceLedgerError(`Cannot load source ledger: ${(error as NodeJS.ErrnoException).code ?? String(error)}`); }
  let text: string; let bytesRead: number;
  try { const buffer = await handle.readFile(); text = buffer.toString("utf8"); bytesRead = buffer.length; } finally { await handle.close(); }
  const lines = text.split("\n");
  let previous = ZERO_HASH; let header: LedgerHeader | undefined; let committed: { index: number; checkpoint: SourceLedgerCheckpoint; hash: string } | undefined;
  const entries: SourceLedgerEntry[] = []; let records = 0; let stoppedAt = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]; if (!line) continue;
    let record: LedgerRecord;
    try { record = JSON.parse(line) as LedgerRecord; } catch { stoppedAt = index; break; }
    if (!verifyRecord(record, previous)) {
      if (committed) { stoppedAt = index; break; }
      throw new SourceLedgerError("Source ledger hash chain is broken before the first valid checkpoint.");
    }
    if (records === 0 && record.recordType !== "header") throw new SourceLedgerError("Source ledger does not start with a header.");
    if (record.recordType === "header") header = record;
    else if (record.recordType === "entry") entries.push(record);
    else if (record.recordType === "checkpoint") committed = { index: entries.length, checkpoint: record, hash: record.ledgerRecordHash };
    else break;
    previous = record.ledgerRecordHash; records += 1;
  }
  if (!header || !committed) throw new SourceLedgerError("Source ledger has no valid committed checkpoint.");
  if (lines.slice(stoppedAt).some((line) => {
    try { return (JSON.parse(line) as { recordType?: string }).recordType === "checkpoint"; } catch { return false; }
  })) throw new SourceLedgerError("Source ledger committed hash chain is broken.");
  const committedEntries = entries.slice(0, committed.index);
  if (committed.checkpoint.indexedEntryCount !== committedEntries.length) throw new SourceLedgerError("Source ledger checkpoint entry count is invalid.");
  if (committed.checkpoint.integrityChainState !== committed.checkpoint.previousLedgerRecordHash) throw new SourceLedgerError("Source ledger checkpoint integrity state is invalid.");
  const committedText = text.split("\n").slice(0, records).join("\n");
  // Determine the committed byte boundary by locating the committed checkpoint line.
  const checkpointLine = stableStringify(committed.checkpoint);
  const checkpointEnd = Buffer.byteLength(text.slice(0, text.lastIndexOf(checkpointLine)) + checkpointLine + "\n");
  return { sourceIdentity: header.sourceFileIdentity, sourceSessionIdentity: header.sourceSessionIdentity,
    entryById: new Map(committedEntries.map((entry) => [entry.entryId, entry])), sourceOrder: committedEntries,
    checkpoint: committed.checkpoint, integrityChainState: committed.hash, sidecarCommittedBytes: checkpointEnd,
    incompleteSidecarTail: checkpointEnd < bytesRead, metrics: metric("exact-hit", committed.checkpoint.sourceFileSize,
      { entriesIndexed: committedEntries.length, ledgerBytesRead: bytesRead, ledgerRecordsReplayed: records }) };
}

async function appendUpdate(sessionPath: string, sidecar: string, ledger: SourceLedger, sourceSize: number, transition: SourceLedgerTransition, anchorBytesRead: number): Promise<SourceLedger> {
  const parsed = await parseSourceRange(sessionPath, ledger.checkpoint.sourceBytePosition, sourceSize, ledger.checkpoint.sourceBytePosition === 0 ? 1 : ledger.sourceOrder.length + 2, ledger.checkpoint.sourceBytePosition === 0);
  let previous = ledger.integrityChainState;
  const appended: SourceLedgerEntry[] = [];
  for (const item of parsed.entries) {
    if (ledger.entryById.has(item.entryId) || appended.some((entry) => entry.entryId === item.entryId)) throw new SourceLedgerError(`Duplicate entry id ${item.entryId}`, item.lineNumber);
    const record = withHash(item, previous); previous = record.ledgerRecordHash; appended.push(record);
  }
  if (parsed.completePosition === ledger.checkpoint.sourceBytePosition && appended.length === 0) {
    return { ...ledger, metrics: metric("exact-hit", sourceSize, { sourceBytesRead: parsed.bytesRead + anchorBytesRead,
      sourceCompleteLinesParsed: 0, entriesIndexed: ledger.sourceOrder.length }) };
  }
  const all = [...ledger.sourceOrder, ...appended];
  const checkpoint = checkpointRecord(previous, parsed.completePosition, sourceSize, all, transition);
  const bytes = encode([...appended, checkpoint]);
  const handle = await open(sidecar, "a", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  const map = ledger.entryById;
  for (const entry of appended) map.set(entry.entryId, entry);
  ledger.sourceOrder.push(...appended);
  return { ...ledger, entryById: map, sourceOrder: ledger.sourceOrder, checkpoint, integrityChainState: checkpoint.ledgerRecordHash,
    sidecarCommittedBytes: ledger.sidecarCommittedBytes + bytes.length, incompleteSidecarTail: false,
    metrics: metric(transition, sourceSize, { sourceBytesRead: parsed.bytesRead + anchorBytesRead, sourceCompleteLinesParsed: parsed.lines,
      entriesIndexed: all.length, entriesAppended: appended.length, ledgerBytesWritten: bytes.length }) };
}

export async function updateSourceLedger(sessionPath: string, prior?: SourceLedger, options: SourceLedgerUpdateOptions = {}): Promise<SourceLedger> {
  const sidecar = options.sidecarPath ?? sourceLedgerPath(sessionPath);
  const release = await acquireLock(sidecar);
  try {
    await options.lockAcquired?.();
    let ledger = prior;
    let recovery = false;
    if (!ledger) {
      try { ledger = await loadSourceLedger(sessionPath, sidecar); recovery = ledger.incompleteSidecarTail; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || /Cannot load source ledger: ENOENT/.test(String(error))) return await rebuild(sessionPath, sidecar, "new");
        return await rebuild(sessionPath, sidecar, "rebuild-replacement");
      }
    }
    if (ledger.incompleteSidecarTail) {
      const handle = await open(sidecar, "r+");
      try { await handle.truncate(ledger.sidecarCommittedBytes); await handle.sync(); } finally { await handle.close(); }
      ledger = { ...ledger, incompleteSidecarTail: false };
      recovery = true;
    }
    const metadata = await stat(sessionPath, { bigint: true });
    const sourceSize = Number(metadata.size);
    if (!sameIdentity(ledger.sourceIdentity, identity(metadata))) return await rebuild(sessionPath, sidecar, "rebuild-replacement");
    if (sourceSize < ledger.checkpoint.sourceBytePosition) return await rebuild(sessionPath, sidecar, "rebuild-truncation");
    const anchor = await anchorMatches(sessionPath, ledger);
    if (!anchor.matches) return await rebuild(sessionPath, sidecar, "rebuild-tail-rewrite");
    if (sourceSize === ledger.checkpoint.sourceBytePosition) {
      return { ...ledger, metrics: metric(recovery ? "recover-incomplete-ledger-tail" : "exact-hit", sourceSize,
        { sourceBytesRead: anchor.bytesRead, entriesIndexed: ledger.sourceOrder.length, ledgerBytesRead: ledger.metrics.ledgerBytesRead,
          ledgerRecordsReplayed: ledger.metrics.ledgerRecordsReplayed }) };
    }
    return await appendUpdate(sessionPath, sidecar, ledger, sourceSize, recovery ? "recover-incomplete-ledger-tail" : "append", anchor.bytesRead);
  } finally { await release(); }
}

export async function readExactSourceEntry(sessionPath: string, ledger: SourceLedger, entryId: string): Promise<{ text: string; bytesRead: number }> {
  const entry = ledger.entryById.get(entryId);
  if (!entry) throw new SourceLedgerError(`Unknown source entry ${entryId}.`);
  const handle = await open(sessionPath, noFollowFlags());
  try {
    const bytes = Buffer.alloc(entry.sourceByteLength);
    const read = await handle.read(bytes, 0, bytes.length, entry.sourceByteOffset);
    if (read.bytesRead !== bytes.length || hashBytes(bytes) !== entry.sourceContentHash) throw new SourceLedgerError(`Stale source ledger entry ${entryId}; source bytes failed verification.`);
    let value: unknown;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new SourceLedgerError(`Stale source ledger entry ${entryId}; source JSON is invalid.`); }
    if (value === null || typeof value !== "object" || (value as Record<string, unknown>).id !== entryId) throw new SourceLedgerError(`Stale source ledger entry ${entryId}; source identity failed verification.`);
    return { text: bytes.toString("utf8"), bytesRead: read.bytesRead };
  } finally { await handle.close(); }
}

export function getSourceLedgerMetrics(ledger: SourceLedger): SourceLedgerMetrics { return ledger.metrics; }
