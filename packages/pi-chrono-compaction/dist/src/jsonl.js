import { readFile } from "node:fs/promises";
import { stableStringify } from "./utils.js";
export class SessionFormatError extends Error {
    lineNumber;
    constructor(message, lineNumber) {
        super(lineNumber === undefined ? message : `${message} (line ${lineNumber})`);
        this.name = "SessionFormatError";
        this.lineNumber = lineNumber;
    }
}
function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseLine(rawLine, lineNumber) {
    let value;
    try {
        value = JSON.parse(rawLine);
    }
    catch (error) {
        throw new SessionFormatError(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, lineNumber);
    }
    if (!isObject(value) || typeof value.type !== "string") {
        throw new SessionFormatError("Every JSONL record must be an object with a string type", lineNumber);
    }
    return value;
}
export function parseSessionJsonl(text, sessionPath) {
    const nonEmptyLines = text
        .split(/\n/)
        .map((rawLine, index) => ({ rawLine: rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine, lineNumber: index + 1 }))
        .filter(({ rawLine }) => rawLine.trim().length > 0);
    if (nonEmptyLines.length === 0)
        throw new SessionFormatError("Session JSONL is empty");
    const records = nonEmptyLines.map(({ rawLine, lineNumber }) => ({
        lineNumber,
        rawLine,
        data: parseLine(rawLine, lineNumber),
    }));
    const first = records[0];
    if (!first || first.data.type !== "session") {
        throw new SessionFormatError("The first record must be a session header", first?.lineNumber);
    }
    const header = first.data;
    const entries = records.slice(1).map((record) => record.data);
    return assembleParsedSession(header, records, entries, sessionPath);
}
export async function readSessionJsonl(sessionPath) {
    return parseSessionJsonl(await readFile(sessionPath, "utf8"), sessionPath);
}
export function parseBranchEntries(entries, header) {
    const effectiveHeader = header ?? { type: "session", version: 3 };
    const records = [
        { lineNumber: 1, rawLine: stableStringify(effectiveHeader), data: effectiveHeader },
        ...entries.map((entry, index) => ({
            lineNumber: index + 2,
            rawLine: stableStringify(entry),
            data: entry,
        })),
    ];
    return assembleParsedSession(effectiveHeader, records, [...entries]);
}
function assembleParsedSession(header, records, entries, sessionPath) {
    const entryById = new Map();
    const recordById = new Map();
    const childrenMutable = new Map();
    const entryRecords = records.slice(1);
    entries.forEach((entry, index) => {
        const id = entry.id;
        if (typeof id !== "string" || id.length === 0) {
            throw new SessionFormatError(`Entry of type ${entry.type} is missing an id`, entryRecords[index]?.lineNumber);
        }
        if (entryById.has(id))
            throw new SessionFormatError(`Duplicate entry id ${id}`, entryRecords[index]?.lineNumber);
        entryById.set(id, entry);
        const record = entryRecords[index];
        if (record)
            recordById.set(id, record);
    });
    for (const entry of entries) {
        const id = entry.id;
        const parentId = entry.parentId ?? null;
        if (parentId !== null && !entryById.has(parentId)) {
            throw new SessionFormatError(`Entry ${id} references missing parent ${parentId}`);
        }
        const children = childrenMutable.get(parentId) ?? [];
        children.push(id);
        childrenMutable.set(parentId, children);
    }
    const cycleChecked = new Set();
    for (const id of entryById.keys()) {
        if (cycleChecked.has(id))
            continue;
        const path = [];
        const pathPositions = new Set();
        let cursor = id;
        while (cursor !== null && !cycleChecked.has(cursor)) {
            if (pathPositions.has(cursor))
                throw new SessionFormatError(`Cycle detected at entry ${cursor}`);
            pathPositions.add(cursor);
            path.push(cursor);
            const entry = entryById.get(cursor);
            cursor = entry ? (entry.parentId ?? null) : null;
        }
        for (const checkedId of path)
            cycleChecked.add(checkedId);
    }
    const childrenByParent = new Map();
    for (const [parentId, children] of childrenMutable)
        childrenByParent.set(parentId, Object.freeze([...children]));
    const lastEntry = entries[entries.length - 1];
    const inferredLeafId = typeof lastEntry?.id === "string" ? lastEntry.id : null;
    const base = {
        header,
        records: Object.freeze([...records]),
        entries: Object.freeze([...entries]),
        entryById,
        recordById,
        childrenByParent,
        inferredLeafId,
    };
    return sessionPath === undefined ? base : { ...base, sessionPath };
}
export function getActiveBranch(session, leafId = session.inferredLeafId) {
    if (leafId === null)
        return [];
    if (!session.entryById.has(leafId))
        throw new SessionFormatError(`Unknown leaf entry ${leafId}`);
    const reversed = [];
    let cursor = leafId;
    while (cursor !== null) {
        const entry = session.entryById.get(cursor);
        if (!entry)
            throw new SessionFormatError(`Broken parent chain at ${cursor}`);
        reversed.push(entry);
        cursor = entry.parentId ?? null;
    }
    return reversed.reverse();
}
export function getSourceEntriesBefore(branchEntries, firstKeptEntryId) {
    const cutIndex = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
    if (cutIndex < 0)
        throw new SessionFormatError(`firstKeptEntryId ${firstKeptEntryId} is not on the active branch`);
    return branchEntries.slice(0, cutIndex);
}
export function rawRecordForEntry(session, entryId) {
    return session.recordById.get(entryId)?.rawLine;
}
//# sourceMappingURL=jsonl.js.map