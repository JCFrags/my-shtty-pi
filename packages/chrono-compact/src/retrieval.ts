import type { ParsedSession, SessionEntryLike, SourceRecord } from "./types.js";
import { exactBlockContent } from "./blocks.js";
import { readSessionJsonl } from "./jsonl.js";
import { getRecord, getString, stableStringify } from "./utils.js";
import { readSourceLedgerEntries, resolveSourceLedgerBranch } from "./ledger-branch.js";
import type { SourceLedger, SourceLedgerEntry } from "./source-ledger.js";

// These character limits remain below Pi's 50 KB tool-output limit even when
// each JavaScript character needs four UTF-8 bytes. Retrieval stays exact, but
// large values require explicit pagination.
const MAX_EXACT_CHARACTERS = 12_000;
const MAX_SEARCH_RESULTS = 20;
const MAX_SEARCH_CONTEXT_CHARACTERS = 200;
const MAX_RANGE_CHARACTERS = 12_000;
const MAX_RANGE_ENTRIES = 200;

export interface HistoryGetOptions {
  readonly blockIndex?: number;
  readonly contextBefore?: number;
  readonly contextAfter?: number;
  readonly startChar?: number;
  readonly maxChars?: number;
}

function entrySummary(entry: SessionEntryLike): string {
  if (entry.type !== "message") return `${entry.type}`;
  const message = getRecord(entry.message);
  return `message/${getString(message?.role) ?? "unknown"}`;
}

function sliceExact(text: string, startChar = 0, maxChars = MAX_EXACT_CHARACTERS): { text: string; nextStart?: number } {
  const start = Math.min(text.length, Math.max(0, Math.floor(startChar)));
  const safeMax = Math.min(MAX_EXACT_CHARACTERS, Math.max(1, Math.floor(maxChars)));
  const end = Math.min(text.length, start + safeMax);
  const slice = text.slice(start, end);
  if (start === 0 && end === text.length) return { text: slice };
  return {
    text: `[exact character slice ${start}–${Math.max(start, end - 1)} of ${text.length}]\n${slice}`,
    ...(end < text.length ? { nextStart: end } : {}),
  };
}

function getContinuation(entryId: string, blockIndex: number | undefined, nextStart: number): string {
  const block = blockIndex === undefined ? "" : `, blockIndex=${blockIndex}`;
  return `Continue exact retrieval: history_get("${entryId}"${block}, startChar=${nextStart}, maxChars=${MAX_EXACT_CHARACTERS})`;
}

function entryRecords(session: ParsedSession): SourceRecord[] {
  return session.records.filter((record) => record.data.type !== "session");
}

export function historyGet(session: ParsedSession, entryId: string, options: HistoryGetOptions = {}): string {
  const record = session.recordById.get(entryId);
  const entry = session.entryById.get(entryId);
  if (!record || !entry) throw new Error(`Unknown history entry: ${entryId}`);

  const records = entryRecords(session);
  const index = records.findIndex((candidate) => candidate.data.id === entryId);
  const before = Math.max(0, options.contextBefore ?? 1);
  const after = Math.max(0, options.contextAfter ?? 1);
  const neighbors = records.slice(Math.max(0, index - before), Math.min(records.length, index + after + 1));
  const sections: string[] = [`Entry ${entryId} (${entrySummary(entry)}), JSONL line ${record.lineNumber}`];

  const maxChars = Math.min(MAX_EXACT_CHARACTERS, Math.max(1, options.maxChars ?? MAX_EXACT_CHARACTERS));
  if (options.blockIndex !== undefined) {
    const block = exactBlockContent(entry, options.blockIndex);
    if (block === undefined) throw new Error(`Entry ${entryId} has no block at index ${options.blockIndex}`);
    const exact = sliceExact(block, options.startChar, maxChars);
    sections.push(`Exact block ${options.blockIndex}:\n${exact.text}`);
    if (exact.nextStart !== undefined) sections.push(getContinuation(entryId, options.blockIndex, exact.nextStart));
    if (record.rawLine.length <= 4_000) {
      sections.push(`Exact containing JSONL record:\n${record.rawLine}`);
    } else {
      sections.push(`Containing JSONL record has ${record.rawLine.length} characters. Use history_get("${entryId}") for exact record slices.`);
    }
  } else {
    const exact = sliceExact(record.rawLine, options.startChar, maxChars);
    sections.push(`Exact JSONL record:\n${exact.text}`);
    if (exact.nextStart !== undefined) sections.push(getContinuation(entryId, undefined, exact.nextStart));
  }

  if (neighbors.length > 1) {
    sections.push(
      `Neighboring chronological file records:\n${neighbors
        .map((neighbor) => {
          const id = typeof neighbor.data.id === "string" ? neighbor.data.id : "header";
          const marker = id === entryId ? "*" : " ";
          return `${marker} [line ${neighbor.lineNumber}] ${id} ${neighbor.data.type}`;
        })
        .join("\n")}`,
    );
  }
  return sections.join("\n\n");
}

export interface HistorySearchOptions {
  readonly limit?: number;
  readonly startMatch?: number;
  readonly caseSensitive?: boolean;
  readonly regex?: boolean;
  readonly contextChars?: number;
}

export function historySearch(session: ParsedSession, query: string, options: HistorySearchOptions = {}): string {
  if (query.length === 0) throw new Error("history_search query must not be empty");
  const limit = Math.min(MAX_SEARCH_RESULTS, Math.max(1, options.limit ?? 20));
  const startMatch = Math.max(0, Math.floor(options.startMatch ?? 0));
  const contextChars = Math.min(MAX_SEARCH_CONTEXT_CHARACTERS, Math.max(40, options.contextChars ?? 180));
  const flags = options.caseSensitive ? "g" : "gi";
  let pattern: RegExp;
  try {
    pattern = options.regex ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  } catch (error) {
    throw new Error(`Invalid history_search pattern: ${error instanceof Error ? error.message : String(error)}`);
  }

  const matches: string[] = [];
  let total = 0;
  for (const record of entryRecords(session)) {
    pattern.lastIndex = 0;
    const first = pattern.exec(record.rawLine);
    if (!first) continue;
    total += 1;
    if (total <= startMatch || matches.length >= limit) continue;
    const at = first.index;
    const start = Math.max(0, at - contextChars);
    const end = Math.min(record.rawLine.length, at + first[0].length + contextChars);
    const entry = record.data as SessionEntryLike;
    const id = typeof entry.id === "string" ? entry.id : `line-${record.lineNumber}`;
    matches.push(
      `[${id} | line ${record.lineNumber} | ${entrySummary(entry)}]\n${start > 0 ? "…" : ""}${record.rawLine.slice(start, end)}${
        end < record.rawLine.length ? "…" : ""
      }`,
    );
  }
  const nextMatch = startMatch + matches.length;
  const continuation = nextMatch < total ? `Continue search: history_search with startMatch=${nextMatch}` : undefined;
  return [
    `Query: ${query}`,
    `Matching entries: ${total}`,
    `Returned matches ${matches.length === 0 ? "none" : `${startMatch + 1}–${nextMatch}`}`,
    ...matches,
    ...(continuation === undefined ? [] : [continuation]),
  ].join("\n\n");
}

export interface HistoryRangeOptions {
  readonly maxEntries?: number;
}

export function historyRange(
  session: ParsedSession,
  startEntryId: string,
  endEntryId: string,
  options: HistoryRangeOptions = {},
): string {
  if (!session.entryById.has(startEntryId)) throw new Error(`Unknown start entry: ${startEntryId}`);
  if (!session.entryById.has(endEntryId)) throw new Error(`Unknown end entry: ${endEntryId}`);
  const maxEntries = Math.min(MAX_RANGE_ENTRIES, Math.max(1, options.maxEntries ?? 200));

  const reversePath: SourceRecord[] = [];
  let cursor: string | null = endEntryId;
  let foundAncestor = false;
  while (cursor !== null) {
    const record = session.recordById.get(cursor);
    const entry = session.entryById.get(cursor);
    if (!record || !entry) break;
    reversePath.push(record);
    if (cursor === startEntryId) {
      foundAncestor = true;
      break;
    }
    cursor = entry.parentId ?? null;
  }

  let range: SourceRecord[];
  let rangeKind: string;
  if (foundAncestor) {
    range = reversePath.reverse();
    rangeKind = "parent-chain chronological path";
  } else {
    const records = entryRecords(session);
    const start = records.findIndex((record) => record.data.id === startEntryId);
    const end = records.findIndex((record) => record.data.id === endEntryId);
    if (end < start) throw new Error(`End entry ${endEntryId} occurs before start entry ${startEntryId} in JSONL file order`);
    range = records.slice(start, end + 1);
    rangeKind = "JSONL file order (start is not an ancestor of end; unrelated branch records may appear)";
  }

  const selected: SourceRecord[] = [];
  const renderedRecords: string[] = [];
  let usedCharacters = 0;
  for (const record of range.slice(0, maxEntries)) {
    const id = typeof record.data.id === "string" ? record.data.id : `line-${record.lineNumber}`;
    const rendered =
      record.rawLine.length > MAX_RANGE_CHARACTERS
        ? `[${id} | JSONL line ${record.lineNumber} has ${record.rawLine.length} characters and is omitted from this range. Use history_get("${id}") for exact slices.]`
        : record.rawLine;
    if (renderedRecords.length > 0 && usedCharacters + rendered.length + 1 > MAX_RANGE_CHARACTERS) break;
    selected.push(record);
    renderedRecords.push(rendered);
    usedCharacters += rendered.length + 1;
  }
  const header = [
    `Bounded JSONL range ${startEntryId}–${endEntryId}`,
    `Traversal: ${rangeKind}`,
    `Requested entries: ${range.length}`,
    `Returned entries: ${selected.length}`,
  ];
  if (selected.length < range.length) {
    const next = range[selected.length]?.data.id;
    header.push(
      next
        ? `Range output reached a safety limit. Continue with history_range("${String(next)}", "${endEntryId}").`
        : "Range output reached a safety limit.",
    );
  }
  return [...header, "", ...renderedRecords].join("\n");
}

export async function historyGetFromLedger(sessionPath: string, ledger: SourceLedger, entryId: string, options: HistoryGetOptions = {}): Promise<string> {
  const indexed = ledger.entryById.get(entryId);
  if (!indexed) throw new Error(`Unknown history entry: ${entryId}`);
  const loaded = await readSourceLedgerEntries(sessionPath, ledger, [indexed]);
  const entry = loaded.entries[0]!;
  const rawLine = loaded.rawTexts[0]!;
  const position = ledger.sourceOrder.findIndex((candidate) => candidate.entryId === entryId);
  const before = Math.max(0, options.contextBefore ?? 1);
  const after = Math.max(0, options.contextAfter ?? 1);
  const neighbors = ledger.sourceOrder.slice(Math.max(0, position - before), Math.min(ledger.sourceOrder.length, position + after + 1));
  const sections: string[] = [`Entry ${entryId} (${entrySummary(entry)}), JSONL line ${indexed.lineNumber}`];
  const maxChars = Math.min(MAX_EXACT_CHARACTERS, Math.max(1, options.maxChars ?? MAX_EXACT_CHARACTERS));
  if (options.blockIndex !== undefined) {
    const block = exactBlockContent(entry, options.blockIndex);
    if (block === undefined) throw new Error(`Entry ${entryId} has no block at index ${options.blockIndex}`);
    const exact = sliceExact(block, options.startChar, maxChars);
    sections.push(`Exact block ${options.blockIndex}:\n${exact.text}`);
    if (exact.nextStart !== undefined) sections.push(getContinuation(entryId, options.blockIndex, exact.nextStart));
    if (rawLine.length <= 4_000) sections.push(`Exact containing JSONL record:\n${rawLine}`);
    else sections.push(`Containing JSONL record has ${rawLine.length} characters. Use history_get("${entryId}") for exact record slices.`);
  } else {
    const exact = sliceExact(rawLine, options.startChar, maxChars);
    sections.push(`Exact JSONL record:\n${exact.text}`);
    if (exact.nextStart !== undefined) sections.push(getContinuation(entryId, undefined, exact.nextStart));
  }
  if (neighbors.length > 1) sections.push(`Neighboring chronological file records:\n${neighbors.map((neighbor) => `${neighbor.entryId === entryId ? "*" : " "} [line ${neighbor.lineNumber}] ${neighbor.entryId} ${neighbor.entryType}`).join("\n")}`);
  return sections.join("\n\n");
}

function ledgerRangeEntries(ledger: SourceLedger, startEntryId: string, endEntryId: string): { range: readonly SourceLedgerEntry[]; rangeKind: string } {
  const startEntry = ledger.entryById.get(startEntryId); const endEntry = ledger.entryById.get(endEntryId);
  if (!startEntry) throw new Error(`Unknown start entry: ${startEntryId}`);
  if (!endEntry) throw new Error(`Unknown end entry: ${endEntryId}`);
  const endBranch = resolveSourceLedgerBranch(ledger, endEntryId).entries;
  const ancestorIndex = endBranch.findIndex((entry) => entry.entryId === startEntryId);
  if (ancestorIndex >= 0) return { range: endBranch.slice(ancestorIndex), rangeKind: "parent-chain chronological path" };
  const start = ledger.sourceOrder.findIndex((entry) => entry.entryId === startEntryId);
  const end = ledger.sourceOrder.findIndex((entry) => entry.entryId === endEntryId);
  if (end < start) throw new Error(`End entry ${endEntryId} occurs before start entry ${startEntryId} in JSONL file order`);
  return { range: ledger.sourceOrder.slice(start, end + 1), rangeKind: "JSONL file order (start is not an ancestor of end; unrelated branch records may appear)" };
}

export async function historyRangeFromLedger(sessionPath: string, ledger: SourceLedger, startEntryId: string, endEntryId: string, options: HistoryRangeOptions = {}): Promise<string> {
  const { range, rangeKind } = ledgerRangeEntries(ledger, startEntryId, endEntryId);
  const maxEntries = Math.min(MAX_RANGE_ENTRIES, Math.max(1, options.maxEntries ?? 200));
  const candidates = range.slice(0, maxEntries);
  const readable = candidates.filter((entry) => entry.sourceByteLength <= MAX_RANGE_CHARACTERS);
  const loaded = await readSourceLedgerEntries(sessionPath, ledger, readable);
  const textById = new Map(loaded.ledgerEntries.map((entry, index) => [entry.entryId, loaded.rawTexts[index]!]));
  const selected: SourceLedgerEntry[] = []; const renderedRecords: string[] = []; let usedCharacters = 0;
  for (const entry of candidates) {
    const raw = textById.get(entry.entryId);
    const rendered = raw === undefined
      ? `[${entry.entryId} | JSONL line ${entry.lineNumber} has ${entry.sourceByteLength} characters and is omitted from this range. Use history_get("${entry.entryId}") for exact slices.]`
      : raw;
    if (renderedRecords.length > 0 && usedCharacters + rendered.length + 1 > MAX_RANGE_CHARACTERS) break;
    selected.push(entry); renderedRecords.push(rendered); usedCharacters += rendered.length + 1;
  }
  const header = [`Bounded JSONL range ${startEntryId}–${endEntryId}`, `Traversal: ${rangeKind}`, `Requested entries: ${range.length}`, `Returned entries: ${selected.length}`];
  if (selected.length < range.length) {
    const next = range[selected.length]?.entryId;
    header.push(next ? `Range output reached a safety limit. Continue with history_range("${String(next)}", "${endEntryId}").` : "Range output reached a safety limit.");
  }
  return [...header, "", ...renderedRecords].join("\n");
}

export async function historyGetFromPath(sessionPath: string, entryId: string, options: HistoryGetOptions = {}): Promise<string> {
  return historyGet(await readSessionJsonl(sessionPath), entryId, options);
}

export async function historySearchFromPath(
  sessionPath: string,
  query: string,
  options: HistorySearchOptions = {},
): Promise<string> {
  return historySearch(await readSessionJsonl(sessionPath), query, options);
}

export async function historyRangeFromPath(
  sessionPath: string,
  startEntryId: string,
  endEntryId: string,
  options: HistoryRangeOptions = {},
): Promise<string> {
  return historyRange(await readSessionJsonl(sessionPath), startEntryId, endEntryId, options);
}

export function inMemorySessionJsonl(header: Record<string, unknown>, entries: readonly SessionEntryLike[]): string {
  return [stableStringify({ type: "session", version: 3, ...header }), ...entries.map((entry) => stableStringify(entry))].join("\n");
}
