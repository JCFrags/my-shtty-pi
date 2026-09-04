import { constants as fsConstants } from "node:fs";
import { open, rename, rm, stat } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { stableStringify } from "./utils.js";
import { acquireDerivedStoreLock } from "./derived-store-lock.js";
export const SOURCE_LEDGER_SUFFIX = ".chrono-source-ledger-v1.jsonl";
const SCHEMA_VERSION = 1;
const ZERO_HASH = "0".repeat(64);
const READ_CHUNK = 64 * 1024;
export const SOURCE_LEDGER_TAIL_ANCHOR_BYTES = 1024;
export class SourceLedgerError extends Error {
    lineNumber;
    code;
    constructor(message, lineNumber, code) {
        super(lineNumber === undefined ? message : `${message} (line ${lineNumber})`);
        this.name = "SourceLedgerError";
        this.lineNumber = lineNumber;
        this.code = code;
    }
}
export function sourceLedgerPath(sessionPath) { return `${sessionPath}${SOURCE_LEDGER_SUFFIX}`; }
function hashBytes(value) { return createHash("sha256").update(value).digest("hex"); }
function identity(metadata) {
    return { deviceId: String(metadata.dev), inodeId: String(metadata.ino) };
}
function sameIdentity(a, b) {
    return a.deviceId === b.deviceId && a.inodeId === b.inodeId;
}
function withHash(record, previousLedgerRecordHash) {
    const base = { ...record, previousLedgerRecordHash };
    return { ...base, ledgerRecordHash: hashBytes(stableStringify(base)) };
}
function verifyRecord(record, expectedPrevious) {
    if (record.previousLedgerRecordHash !== expectedPrevious || !/^[a-f0-9]{64}$/.test(record.ledgerRecordHash))
        return false;
    const { ledgerRecordHash, ...base } = record;
    return hashBytes(stableStringify(base)) === ledgerRecordHash;
}
function noFollowFlags() { return fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0); }
function appendNoFollowFlags() { return fsConstants.O_WRONLY | fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW ?? 0); }
async function acquireLock(sidecar) {
    return acquireDerivedStoreLock(`${sidecar}.lock`);
}
function nextAnchor(previous, raw, newline) {
    const neededFromRaw = Math.min(raw.length, SOURCE_LEDGER_TAIL_ANCHOR_BYTES - newline.length);
    const neededFromPrevious = Math.min(previous.length, SOURCE_LEDGER_TAIL_ANCHOR_BYTES - newline.length - neededFromRaw);
    return Buffer.concat([previous.subarray(previous.length - neededFromPrevious), raw.subarray(raw.length - neededFromRaw), newline]);
}
async function parseSourceRange(path, start, end, firstLine, requireHeader, initialAnchor = Buffer.alloc(0), entryParsed) {
    const handle = await open(path, noFollowFlags());
    let bytesRead = 0;
    let position = start;
    let lineNumber = firstLine;
    let pendingOffset = start;
    let pendingLength = 0;
    let maximumSourceLineBytes = 0;
    let sourceLineAssemblyBytes = 0;
    let committedAnchor = Buffer.from(initialAnchor);
    let header;
    let parts = [];
    const entries = [];
    const parseComplete = (raw, offset, nextOffset, newline) => {
        maximumSourceLineBytes = Math.max(maximumSourceLineBytes, raw.length - (raw.at(-1) === 13 ? 1 : 0));
        let content = raw;
        if (content.at(-1) === 13)
            content = content.subarray(0, -1);
        let value;
        try {
            value = JSON.parse(content.toString("utf8"));
        }
        catch (error) {
            throw new SourceLedgerError(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, lineNumber);
        }
        if (value === null || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string") {
            throw new SourceLedgerError("Every JSONL record must be an object with a string type", lineNumber);
        }
        const object = value;
        if (requireHeader && lineNumber === 1) {
            if (object.type !== "session")
                throw new SourceLedgerError("The first complete record must be a session header", 1);
            header = object;
        }
        else {
            if (typeof object.id !== "string" || object.id.length === 0)
                throw new SourceLedgerError(`Entry of type ${String(object.type)} is missing an id`, lineNumber);
            if (object.parentId !== undefined && object.parentId !== null && (typeof object.parentId !== "string" || object.parentId.length === 0))
                throw new SourceLedgerError(`Entry ${object.id} has an invalid parent id`, lineNumber, "branch-parent-missing");
            entries.push({ recordType: "entry", entryId: object.id, parentId: typeof object.parentId === "string" ? object.parentId : null,
                entryType: object.type, lineNumber, sourceByteOffset: offset, sourceByteLength: content.length,
                nextSourceByteOffset: nextOffset, sourceContentHash: hashBytes(content) });
            entryParsed?.({ entryId: object.id, lineNumber, text: content.toString("utf8") });
        }
        committedAnchor = nextAnchor(committedAnchor, raw, newline);
        lineNumber += 1;
    };
    const assemble = () => {
        if (parts.length === 1)
            return parts[0];
        sourceLineAssemblyBytes += pendingLength;
        return Buffer.concat(parts, pendingLength);
    };
    try {
        while (position < end) {
            const requested = Math.min(READ_CHUNK, end - position);
            const buffer = Buffer.allocUnsafe(requested);
            const read = await handle.read(buffer, 0, requested, position);
            if (read.bytesRead === 0)
                break;
            const chunk = buffer.subarray(0, read.bytesRead);
            bytesRead += read.bytesRead;
            position += read.bytesRead;
            let cursor = 0;
            let cut;
            while ((cut = chunk.indexOf(10, cursor)) >= 0) {
                const part = chunk.subarray(cursor, cut);
                parts.push(part);
                pendingLength += part.length;
                const raw = assemble();
                parseComplete(raw, pendingOffset, pendingOffset + pendingLength + 1, Buffer.from([10]));
                pendingOffset += pendingLength + 1;
                parts = [];
                pendingLength = 0;
                cursor = cut + 1;
            }
            if (cursor < chunk.length) {
                const part = chunk.subarray(cursor);
                parts.push(part);
                pendingLength += part.length;
            }
        }
        if (position === end && pendingLength > 0) {
            const raw = assemble();
            try {
                parseComplete(raw, pendingOffset, end, Buffer.alloc(0));
                parts = [];
                pendingLength = 0;
                pendingOffset = end;
            }
            catch (error) {
                if (!(error instanceof SourceLedgerError) || !/^Invalid JSON:/.test(error.message))
                    throw error;
            }
        }
    }
    finally {
        await handle.close();
    }
    if (requireHeader && !header)
        throw new SourceLedgerError("The source has no complete session header.");
    return { header: header ?? {}, entries, completePosition: pendingOffset, lines: lineNumber - firstLine, bytesRead,
        maximumSourceLineBytes, sourceLineAssemblyBytes, committedAnchor };
}
function sessionIdentity(header) {
    for (const key of ["id", "sessionId", "session_id"])
        if (typeof header[key] === "string" && header[key].length > 0)
            return header[key];
    return null;
}
async function openedSourceMatches(handle, ledger) {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || !sameIdentity(ledger.sourceIdentity, identity(metadata)) || Number(metadata.size) < ledger.checkpoint.sourceFileSize) {
        return { matches: false, bytesRead: 0, bytes: Buffer.alloc(0) };
    }
    const checkpoint = ledger.checkpoint;
    const bytes = Buffer.alloc(checkpoint.anchorByteLength);
    const read = await handle.read(bytes, 0, bytes.length, checkpoint.anchorSourceOffset);
    return { matches: read.bytesRead === bytes.length && hashBytes(bytes) === checkpoint.anchorContentHash,
        bytesRead: read.bytesRead, bytes: bytes.subarray(0, read.bytesRead) };
}
async function anchorMatches(path, ledger) {
    const handle = await open(path, noFollowFlags());
    try {
        return await openedSourceMatches(handle, ledger);
    }
    finally {
        await handle.close();
    }
}
function metric(transition, size, patch = {}) {
    return { transition, sourceFileSize: size, sourceBytesRead: 0, sourceCompleteLinesParsed: 0, entriesIndexed: 0,
        entriesAppended: 0, ledgerBytesRead: 0, ledgerBytesWritten: 0, ledgerRecordsReplayed: 0, exactRetrievalBytesRead: 0,
        maximumSourceLineBytes: 0, sourceLineAssemblyBytes: 0, tailAnchorBytesRead: 0, appendedSourceBytesRead: 0, ...patch };
}
function checkpointRecord(previous, sourcePosition, sourceSize, entries, transition, anchor) {
    const last = entries.at(-1);
    return withHash({ recordType: "checkpoint", sourceBytePosition: sourcePosition, sourceFileSize: sourceSize,
        indexedEntryCount: entries.length, lastIndexedEntryId: last?.entryId ?? null, lastIndexedSourceContentHash: last?.sourceContentHash ?? null,
        integrityChainState: previous, anchorSourceOffset: sourcePosition - anchor.length, anchorByteLength: anchor.length,
        anchorContentHash: hashBytes(anchor), transition }, previous);
}
function encode(records) { return Buffer.from(`${records.map((record) => stableStringify(record)).join("\n")}\n`); }
async function atomicWrite(path, bytes) {
    const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
    const handle = await open(temporary, "wx", 0o600);
    try {
        await handle.writeFile(bytes);
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await rename(temporary, path);
    }
    finally {
        await rm(temporary, { force: true });
    }
    const directory = await open(dirname(path), "r");
    try {
        await directory.sync();
    }
    finally {
        await directory.close();
    }
}
async function rebuild(sessionPath, sidecar, transition, entryParsed) {
    const metadata = await stat(sessionPath, { bigint: true });
    if (!metadata.isFile())
        throw new SourceLedgerError("Source session must be a regular file.");
    const parsed = await parseSourceRange(sessionPath, 0, Number(metadata.size), 1, true, Buffer.alloc(0), entryParsed);
    const seen = new Set();
    let previous = ZERO_HASH;
    const header = withHash({ recordType: "header", schemaVersion: SCHEMA_VERSION, sourceFileIdentity: identity(metadata),
        sourceSessionIdentity: sessionIdentity(parsed.header), createdAt: new Date().toISOString(), firstIntegrityChainValue: ZERO_HASH }, previous);
    previous = header.ledgerRecordHash;
    const entries = parsed.entries.map((item) => {
        if (seen.has(item.entryId))
            throw new SourceLedgerError(`Duplicate entry id ${item.entryId}`, item.lineNumber, "branch-cycle");
        seen.add(item.entryId);
        const record = withHash(item, previous);
        previous = record.ledgerRecordHash;
        return record;
    });
    const checkpoint = checkpointRecord(previous, parsed.completePosition, Number(metadata.size), entries, transition, Buffer.from(parsed.committedAnchor));
    const bytes = encode([header, ...entries, checkpoint]);
    await atomicWrite(sidecar, bytes);
    return { sourceIdentity: header.sourceFileIdentity, sourceSessionIdentity: header.sourceSessionIdentity,
        entryById: new Map(entries.map((entry) => [entry.entryId, entry])), sourceOrder: entries, checkpoint,
        integrityChainState: checkpoint.ledgerRecordHash, sidecarCommittedBytes: bytes.length, incompleteSidecarTail: false,
        metrics: metric(transition, Number(metadata.size), { sourceBytesRead: parsed.bytesRead, sourceCompleteLinesParsed: parsed.lines,
            entriesIndexed: entries.length, entriesAppended: entries.length, ledgerBytesWritten: bytes.length,
            maximumSourceLineBytes: parsed.maximumSourceLineBytes, sourceLineAssemblyBytes: parsed.sourceLineAssemblyBytes,
            appendedSourceBytesRead: parsed.bytesRead }) };
}
export async function loadSourceLedger(sessionPath, explicitSidecar = sourceLedgerPath(sessionPath)) {
    let handle;
    try {
        handle = await open(explicitSidecar, noFollowFlags());
    }
    catch (error) {
        throw new SourceLedgerError(`Cannot load source ledger: ${error.code ?? String(error)}`);
    }
    let text;
    let bytesRead;
    try {
        const buffer = await handle.readFile();
        text = buffer.toString("utf8");
        bytesRead = buffer.length;
    }
    finally {
        await handle.close();
    }
    const lines = text.split("\n");
    let previous = ZERO_HASH;
    let header;
    let committed;
    const entries = [];
    let records = 0;
    let stoppedAt = lines.length;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line)
            continue;
        let record;
        try {
            record = JSON.parse(line);
        }
        catch {
            stoppedAt = index;
            break;
        }
        if (!verifyRecord(record, previous)) {
            if (committed) {
                stoppedAt = index;
                break;
            }
            throw new SourceLedgerError("Source ledger hash chain is broken before the first valid checkpoint.");
        }
        if (records === 0 && record.recordType !== "header")
            throw new SourceLedgerError("Source ledger does not start with a header.");
        if (record.recordType === "header")
            header = record;
        else if (record.recordType === "entry")
            entries.push(record);
        else if (record.recordType === "checkpoint")
            committed = { index: entries.length, checkpoint: record, hash: record.ledgerRecordHash };
        else
            break;
        previous = record.ledgerRecordHash;
        records += 1;
    }
    if (!header || !committed)
        throw new SourceLedgerError("Source ledger has no valid committed checkpoint.");
    if (lines.slice(stoppedAt).some((line) => {
        try {
            return JSON.parse(line).recordType === "checkpoint";
        }
        catch {
            return false;
        }
    }))
        throw new SourceLedgerError("Source ledger committed hash chain is broken.");
    const committedEntries = entries.slice(0, committed.index);
    if (committed.checkpoint.indexedEntryCount !== committedEntries.length)
        throw new SourceLedgerError("Source ledger checkpoint entry count is invalid.");
    if (committed.checkpoint.integrityChainState !== committed.checkpoint.previousLedgerRecordHash)
        throw new SourceLedgerError("Source ledger checkpoint integrity state is invalid.");
    if (!Number.isSafeInteger(committed.checkpoint.anchorSourceOffset) || committed.checkpoint.anchorSourceOffset < 0
        || !Number.isSafeInteger(committed.checkpoint.anchorByteLength) || committed.checkpoint.anchorByteLength < 0
        || committed.checkpoint.anchorByteLength > SOURCE_LEDGER_TAIL_ANCHOR_BYTES
        || committed.checkpoint.anchorSourceOffset + committed.checkpoint.anchorByteLength !== committed.checkpoint.sourceBytePosition
        || typeof committed.checkpoint.anchorContentHash !== "string" || !/^[a-f0-9]{64}$/.test(committed.checkpoint.anchorContentHash)) {
        throw new SourceLedgerError("Source ledger checkpoint has no valid fixed tail anchor.");
    }
    const committedText = text.split("\n").slice(0, records).join("\n");
    // Determine the committed byte boundary by locating the committed checkpoint line.
    const checkpointLine = stableStringify(committed.checkpoint);
    const checkpointEnd = Buffer.byteLength(text.slice(0, text.lastIndexOf(checkpointLine)) + checkpointLine + "\n");
    return { sourceIdentity: header.sourceFileIdentity, sourceSessionIdentity: header.sourceSessionIdentity,
        entryById: new Map(committedEntries.map((entry) => [entry.entryId, entry])), sourceOrder: committedEntries,
        checkpoint: committed.checkpoint, integrityChainState: committed.hash, sidecarCommittedBytes: checkpointEnd,
        incompleteSidecarTail: checkpointEnd < bytesRead, metrics: metric("exact-hit", committed.checkpoint.sourceFileSize, { entriesIndexed: committedEntries.length, ledgerBytesRead: bytesRead, ledgerRecordsReplayed: records }) };
}
async function appendUpdate(sessionPath, sidecar, ledger, sourceSize, transition, anchorBytes, entryParsed) {
    const parsed = await parseSourceRange(sessionPath, ledger.checkpoint.sourceBytePosition, sourceSize, ledger.checkpoint.sourceBytePosition === 0 ? 1 : ledger.sourceOrder.length + 2, ledger.checkpoint.sourceBytePosition === 0, anchorBytes, entryParsed);
    let previous = ledger.integrityChainState;
    const appended = [];
    for (const item of parsed.entries) {
        if (ledger.entryById.has(item.entryId) || appended.some((entry) => entry.entryId === item.entryId))
            throw new SourceLedgerError(`Duplicate entry id ${item.entryId}`, item.lineNumber, "branch-cycle");
        const record = withHash(item, previous);
        previous = record.ledgerRecordHash;
        appended.push(record);
    }
    if (parsed.completePosition === ledger.checkpoint.sourceBytePosition && appended.length === 0) {
        return { ...ledger, metrics: metric("exact-hit", sourceSize, { sourceBytesRead: parsed.bytesRead + anchorBytes.length,
                sourceCompleteLinesParsed: 0, entriesIndexed: ledger.sourceOrder.length, maximumSourceLineBytes: parsed.maximumSourceLineBytes,
                sourceLineAssemblyBytes: parsed.sourceLineAssemblyBytes, tailAnchorBytesRead: anchorBytes.length,
                appendedSourceBytesRead: parsed.bytesRead }) };
    }
    const all = [...ledger.sourceOrder, ...appended];
    const checkpoint = checkpointRecord(previous, parsed.completePosition, sourceSize, all, transition, Buffer.from(parsed.committedAnchor));
    const bytes = encode([...appended, checkpoint]);
    const handle = await open(sidecar, appendNoFollowFlags(), 0o600);
    try {
        await handle.writeFile(bytes);
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    const map = ledger.entryById;
    for (const entry of appended)
        map.set(entry.entryId, entry);
    ledger.sourceOrder.push(...appended);
    return { ...ledger, entryById: map, sourceOrder: ledger.sourceOrder, checkpoint, integrityChainState: checkpoint.ledgerRecordHash,
        sidecarCommittedBytes: ledger.sidecarCommittedBytes + bytes.length, incompleteSidecarTail: false,
        metrics: metric(transition, sourceSize, { sourceBytesRead: parsed.bytesRead + anchorBytes.length, sourceCompleteLinesParsed: parsed.lines,
            entriesIndexed: all.length, entriesAppended: appended.length, ledgerBytesWritten: bytes.length,
            maximumSourceLineBytes: parsed.maximumSourceLineBytes, sourceLineAssemblyBytes: parsed.sourceLineAssemblyBytes,
            tailAnchorBytesRead: anchorBytes.length, appendedSourceBytesRead: parsed.bytesRead }) };
}
export async function updateSourceLedger(sessionPath, prior, options = {}) {
    const sidecar = options.sidecarPath ?? sourceLedgerPath(sessionPath);
    const release = await acquireLock(sidecar);
    try {
        await options.lockAcquired?.();
        let ledger = prior;
        let recovery = false;
        if (!ledger) {
            try {
                ledger = await loadSourceLedger(sessionPath, sidecar);
                recovery = ledger.incompleteSidecarTail;
            }
            catch (error) {
                if (error.code === "ENOENT" || /Cannot load source ledger: ENOENT/.test(String(error)))
                    return await rebuild(sessionPath, sidecar, "new", options.entryParsed);
                return await rebuild(sessionPath, sidecar, "rebuild-replacement", options.entryParsed);
            }
        }
        if (ledger.incompleteSidecarTail) {
            const handle = await open(sidecar, "r+");
            try {
                await handle.truncate(ledger.sidecarCommittedBytes);
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            ledger = { ...ledger, incompleteSidecarTail: false };
            recovery = true;
        }
        const metadata = await stat(sessionPath, { bigint: true });
        const sourceSize = Number(metadata.size);
        if (!sameIdentity(ledger.sourceIdentity, identity(metadata)))
            return await rebuild(sessionPath, sidecar, "rebuild-replacement", options.entryParsed);
        if (sourceSize < ledger.checkpoint.sourceBytePosition)
            return await rebuild(sessionPath, sidecar, "rebuild-truncation", options.entryParsed);
        const anchor = await anchorMatches(sessionPath, ledger);
        if (!anchor.matches)
            return await rebuild(sessionPath, sidecar, "rebuild-tail-rewrite", options.entryParsed);
        if (sourceSize === ledger.checkpoint.sourceBytePosition) {
            return { ...ledger, metrics: metric(recovery ? "recover-incomplete-ledger-tail" : "exact-hit", sourceSize, { sourceBytesRead: anchor.bytesRead, entriesIndexed: ledger.sourceOrder.length, ledgerBytesRead: ledger.metrics.ledgerBytesRead,
                    ledgerRecordsReplayed: ledger.metrics.ledgerRecordsReplayed, tailAnchorBytesRead: anchor.bytesRead }) };
        }
        return await appendUpdate(sessionPath, sidecar, ledger, sourceSize, recovery ? "recover-incomplete-ledger-tail" : "append", anchor.bytes, options.entryParsed);
    }
    finally {
        await release();
    }
}
export async function readSourceEntryRange(sessionPath, ledger, startIndex, endIndex) {
    const start = Math.max(0, Math.floor(startIndex));
    const end = Math.min(ledger.sourceOrder.length, Math.max(start, Math.floor(endIndex)));
    if (start === end)
        return { entries: [], bytesRead: 0 };
    const selected = ledger.sourceOrder.slice(start, end);
    const first = selected[0];
    const last = selected.at(-1);
    const rangeEnd = last.sourceByteOffset + last.sourceByteLength;
    const bytes = Buffer.alloc(rangeEnd - first.sourceByteOffset);
    const handle = await open(sessionPath, noFollowFlags());
    try {
        if (!(await openedSourceMatches(handle, ledger)).matches)
            throw new SourceLedgerError("Stale source ledger; source checkpoint failed verification.");
        const read = await handle.read(bytes, 0, bytes.length, first.sourceByteOffset);
        if (read.bytesRead !== bytes.length)
            throw new SourceLedgerError("Source range ended before the indexed byte boundary.");
        const output = selected.map((entry) => {
            const relative = entry.sourceByteOffset - first.sourceByteOffset;
            const content = bytes.subarray(relative, relative + entry.sourceByteLength);
            if (hashBytes(content) !== entry.sourceContentHash)
                throw new SourceLedgerError(`Stale source ledger entry ${entry.entryId}; source bytes failed verification.`);
            let value;
            try {
                value = JSON.parse(content.toString("utf8"));
            }
            catch {
                throw new SourceLedgerError(`Stale source ledger entry ${entry.entryId}; source JSON is invalid.`);
            }
            if (value === null || typeof value !== "object" || value.id !== entry.entryId)
                throw new SourceLedgerError(`Stale source ledger entry ${entry.entryId}; source identity failed verification.`);
            return { ledger: entry, text: content.toString("utf8") };
        });
        if (!(await openedSourceMatches(handle, ledger)).matches)
            throw new SourceLedgerError("Stale source ledger; source checkpoint failed verification.");
        return { entries: output, bytesRead: read.bytesRead };
    }
    finally {
        await handle.close();
    }
}
export async function readExactSourceEntry(sessionPath, ledger, entryId) {
    const entry = ledger.entryById.get(entryId);
    if (!entry)
        throw new SourceLedgerError(`Unknown source entry ${entryId}.`);
    const handle = await open(sessionPath, noFollowFlags());
    try {
        if (!(await openedSourceMatches(handle, ledger)).matches)
            throw new SourceLedgerError(`Stale source ledger entry ${entryId}; source checkpoint failed verification.`);
        const bytes = Buffer.alloc(entry.sourceByteLength);
        const read = await handle.read(bytes, 0, bytes.length, entry.sourceByteOffset);
        if (read.bytesRead !== bytes.length || hashBytes(bytes) !== entry.sourceContentHash)
            throw new SourceLedgerError(`Stale source ledger entry ${entryId}; source bytes failed verification.`);
        let value;
        try {
            value = JSON.parse(bytes.toString("utf8"));
        }
        catch {
            throw new SourceLedgerError(`Stale source ledger entry ${entryId}; source JSON is invalid.`);
        }
        if (value === null || typeof value !== "object" || value.id !== entryId)
            throw new SourceLedgerError(`Stale source ledger entry ${entryId}; source identity failed verification.`);
        if (!(await openedSourceMatches(handle, ledger)).matches)
            throw new SourceLedgerError(`Stale source ledger entry ${entryId}; source checkpoint failed verification.`);
        return { text: bytes.toString("utf8"), bytesRead: read.bytesRead };
    }
    finally {
        await handle.close();
    }
}
export async function sourceLedgerIsBusy(sidecar) {
    try {
        return (await stat(`${sidecar}.lock`)).isFile();
    }
    catch {
        return false;
    }
}
export async function sourceLedgerMatchesSource(sessionPath, ledger) {
    try {
        return (await anchorMatches(sessionPath, ledger)).matches;
    }
    catch {
        return false;
    }
}
export function getSourceLedgerMetrics(ledger) { return ledger.metrics; }
//# sourceMappingURL=source-ledger.js.map