import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import type { ParsedSession, SessionEntryLike, SessionHeaderLike, SourceRecord } from "./types.js";
import { stableStringify } from "./utils.js";

export class SessionFormatError extends Error {
  readonly lineNumber?: number;

  constructor(message: string, lineNumber?: number) {
    super(lineNumber === undefined ? message : `${message} (line ${lineNumber})`);
    this.name = "SessionFormatError";
    this.lineNumber = lineNumber;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseLine(rawLine: string, lineNumber: number): SessionHeaderLike | SessionEntryLike {
  let value: unknown;
  try {
    value = JSON.parse(rawLine);
  } catch (error) {
    throw new SessionFormatError(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, lineNumber);
  }
  if (!isObject(value) || typeof value.type !== "string") {
    throw new SessionFormatError("Every JSONL record must be an object with a string type", lineNumber);
  }
  return value as SessionHeaderLike | SessionEntryLike;
}

export function parseSessionJsonl(text: string, sessionPath?: string): ParsedSession {
  const nonEmptyLines = text
    .split(/\n/)
    .map((rawLine, index) => ({ rawLine: rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine, lineNumber: index + 1 }))
    .filter(({ rawLine }) => rawLine.trim().length > 0);

  if (nonEmptyLines.length === 0) throw new SessionFormatError("Session JSONL is empty");

  const records: SourceRecord[] = nonEmptyLines.map(({ rawLine, lineNumber }) => ({
    lineNumber,
    rawLine,
    data: parseLine(rawLine, lineNumber),
  }));

  const first = records[0];
  if (!first || first.data.type !== "session") {
    throw new SessionFormatError("The first record must be a session header", first?.lineNumber);
  }

  const header = first.data as SessionHeaderLike;
  const entries = records.slice(1).map((record) => record.data as SessionEntryLike);
  return assembleParsedSession(header, records, entries, sessionPath);
}

export async function readSessionJsonl(sessionPath: string): Promise<ParsedSession> {
  return parseSessionJsonl(await readFile(sessionPath, "utf8"), sessionPath);
}

export interface BoundedSessionSourceState {
  readonly deviceId: string;
  readonly inodeId: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface BoundedSessionReadHooks {
  readonly afterOpened?: (state: BoundedSessionSourceState) => void | Promise<void>;
  readonly onRead?: (requestedBytes: number, bytesRead: number, position: number) => void;
}

export interface BoundedSessionReadResult {
  readonly session: ParsedSession;
  readonly source: BoundedSessionSourceState;
  readonly bytesRead: number;
}

function boundedSourceState(value: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>): BoundedSessionSourceState {
  if (!value.isFile()) throw new Error("history-source-unsafe-type");
  return { deviceId: String(value.dev), inodeId: String(value.ino), size: Number(value.size), mtimeMs: Number(value.mtimeMs) };
}

function sameBoundedSource(left: BoundedSessionSourceState, right: BoundedSessionSourceState): boolean {
  return left.deviceId === right.deviceId && left.inodeId === right.inodeId && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

export async function readBoundedSessionJsonl(
  sessionPath: string,
  maximumBytes: number,
  hooks: BoundedSessionReadHooks = {},
): Promise<BoundedSessionReadResult> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error("history-source-limit-invalid");
  const handle = await open(sessionPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const source = boundedSourceState(await handle.stat());
    if (source.size > maximumBytes) throw new Error("history-source-too-large");
    await hooks.afterOpened?.(source);
    const content = Buffer.allocUnsafe(source.size);
    let bytesRead = 0;
    while (bytesRead < source.size) {
      const requestedBytes = Math.min(1024 * 1024, source.size - bytesRead);
      const result = await handle.read(content, bytesRead, requestedBytes, bytesRead);
      hooks.onRead?.(requestedBytes, result.bytesRead, bytesRead);
      if (result.bytesRead <= 0) throw new Error("history-source-changed");
      bytesRead += result.bytesRead;
    }
    const afterHandle = boundedSourceState(await handle.stat());
    let afterPath: BoundedSessionSourceState;
    try {
      const pathHandle = await open(sessionPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { afterPath = boundedSourceState(await pathHandle.stat()); }
      finally { await pathHandle.close(); }
    } catch {
      throw new Error("history-source-changed");
    }
    if (!sameBoundedSource(source, afterHandle) || !sameBoundedSource(source, afterPath)) throw new Error("history-source-changed");
    return { session: parseSessionJsonl(content.toString("utf8"), sessionPath), source, bytesRead };
  } finally {
    await handle.close();
  }
}

export function parseBranchEntries(entries: readonly SessionEntryLike[], header?: SessionHeaderLike): ParsedSession {
  const effectiveHeader: SessionHeaderLike = header ?? { type: "session", version: 3 };
  const records: SourceRecord[] = [
    { lineNumber: 1, rawLine: stableStringify(effectiveHeader), data: effectiveHeader },
    ...entries.map((entry, index) => ({
      lineNumber: index + 2,
      rawLine: stableStringify(entry),
      data: entry,
    })),
  ];
  return assembleParsedSession(effectiveHeader, records, [...entries]);
}

function assembleParsedSession(
  header: SessionHeaderLike,
  records: readonly SourceRecord[],
  entries: readonly SessionEntryLike[],
  sessionPath?: string,
): ParsedSession {
  const entryById = new Map<string, SessionEntryLike>();
  const recordById = new Map<string, SourceRecord>();
  const childrenMutable = new Map<string | null, string[]>();
  const entryRecords = records.slice(1);

  entries.forEach((entry, index) => {
    const id = entry.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new SessionFormatError(`Entry of type ${entry.type} is missing an id`, entryRecords[index]?.lineNumber);
    }
    if (entryById.has(id)) throw new SessionFormatError(`Duplicate entry id ${id}`, entryRecords[index]?.lineNumber);
    entryById.set(id, entry);
    const record = entryRecords[index];
    if (record) recordById.set(id, record);
  });

  for (const entry of entries) {
    const id = entry.id as string;
    const parentId = entry.parentId ?? null;
    if (parentId !== null && !entryById.has(parentId)) {
      throw new SessionFormatError(`Entry ${id} references missing parent ${parentId}`);
    }
    const children = childrenMutable.get(parentId) ?? [];
    children.push(id);
    childrenMutable.set(parentId, children);
  }

  const cycleChecked = new Set<string>();
  for (const id of entryById.keys()) {
    if (cycleChecked.has(id)) continue;
    const path: string[] = [];
    const pathPositions = new Set<string>();
    let cursor: string | null = id;
    while (cursor !== null && !cycleChecked.has(cursor)) {
      if (pathPositions.has(cursor)) throw new SessionFormatError(`Cycle detected at entry ${cursor}`);
      pathPositions.add(cursor);
      path.push(cursor);
      const entry = entryById.get(cursor);
      cursor = entry ? (entry.parentId ?? null) : null;
    }
    for (const checkedId of path) cycleChecked.add(checkedId);
  }

  const childrenByParent = new Map<string | null, readonly string[]>();
  for (const [parentId, children] of childrenMutable) childrenByParent.set(parentId, Object.freeze([...children]));

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

export function getActiveBranch(session: ParsedSession, leafId = session.inferredLeafId): SessionEntryLike[] {
  if (leafId === null) return [];
  if (!session.entryById.has(leafId)) throw new SessionFormatError(`Unknown leaf entry ${leafId}`);
  const reversed: SessionEntryLike[] = [];
  let cursor: string | null = leafId;
  while (cursor !== null) {
    const entry = session.entryById.get(cursor);
    if (!entry) throw new SessionFormatError(`Broken parent chain at ${cursor}`);
    reversed.push(entry);
    cursor = entry.parentId ?? null;
  }
  return reversed.reverse();
}

export function getSourceEntriesBefore(
  branchEntries: readonly SessionEntryLike[],
  firstKeptEntryId: string,
): SessionEntryLike[] {
  const cutIndex = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
  if (cutIndex < 0) throw new SessionFormatError(`firstKeptEntryId ${firstKeptEntryId} is not on the active branch`);
  return branchEntries.slice(0, cutIndex);
}

export function rawRecordForEntry(session: ParsedSession, entryId: string): string | undefined {
  return session.recordById.get(entryId)?.rawLine;
}
