import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { SessionEntryLike } from "./types.js";
import type { SourceLedger, SourceLedgerEntry } from "./source-ledger.js";

export type LedgerBranchFailureCode = "branch-not-persisted" | "branch-parent-missing" | "branch-cycle" | "branch-source-order" | "invalid-cut" | "source-changed";

export class LedgerBranchError extends Error {
  constructor(readonly code: LedgerBranchFailureCode, message: string) { super(message); this.name = "LedgerBranchError"; }
}

export interface LedgerBranchReadOptions {
  readonly maximumGapBytes?: number;
  readonly maximumRangeBytes?: number;
  readonly maximumEntriesPerRange?: number;
}

export interface LedgerSourceRange {
  readonly startByte: number;
  readonly endByte: number;
  readonly entries: readonly SourceLedgerEntry[];
}

export interface LedgerBranchResolution {
  readonly entries: readonly SourceLedgerEntry[];
  readonly resolveMs: number;
}

export interface LedgerBranchReadMetrics {
  readonly selectedEntryCount: number;
  readonly selectedSourceBytes: number;
  readonly sourceRangeCount: number;
  readonly totalSourceBytesRead: number;
  readonly coalescingGapBytesRead: number;
  readonly unrelatedEntryBytesRead: number;
  readonly maximumRangeBytes: number;
  readonly maximumEntryBytes: number;
  readonly sourceFileBytes: number;
  readonly sourceByteAvoidanceRate: number;
  readonly exactVerificationFailures: number;
  readonly elapsedLoadMs: number;
}

export interface LoadedLedgerBranch {
  readonly ledgerEntries: readonly SourceLedgerEntry[];
  readonly entries: readonly SessionEntryLike[];
  readonly rawTexts: readonly string[];
  readonly metrics: LedgerBranchReadMetrics;
}

const DEFAULT_MAXIMUM_GAP_BYTES = 64 * 1024;
const DEFAULT_MAXIMUM_RANGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAXIMUM_ENTRIES_PER_RANGE = 2_048;
function hash(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function noFollowFlags(): number { return fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0); }

async function verifyOpenedLedgerSource(handle: FileHandle, ledger: SourceLedger): Promise<number> {
  const checkpoint = ledger.checkpoint;
  if (!Number.isSafeInteger(checkpoint.sourceFileSize) || checkpoint.sourceFileSize < 0
    || !Number.isSafeInteger(checkpoint.sourceBytePosition) || checkpoint.sourceBytePosition < 0
    || checkpoint.sourceBytePosition > checkpoint.sourceFileSize
    || !Number.isSafeInteger(checkpoint.anchorSourceOffset) || checkpoint.anchorSourceOffset < 0
    || !Number.isSafeInteger(checkpoint.anchorByteLength) || checkpoint.anchorByteLength < 0
    || checkpoint.anchorSourceOffset + checkpoint.anchorByteLength !== checkpoint.sourceBytePosition
    || typeof checkpoint.anchorContentHash !== "string" || !/^[a-f0-9]{64}$/.test(checkpoint.anchorContentHash)) {
    throw new LedgerBranchError("source-changed", "The source ledger checkpoint anchor is invalid.");
  }
  const metadata = await handle.stat({ bigint: true });
  if (!metadata.isFile()) throw new LedgerBranchError("source-changed", "The selected source is not a regular file.");
  if (String(metadata.dev) !== ledger.sourceIdentity.deviceId || String(metadata.ino) !== ledger.sourceIdentity.inodeId) {
    throw new LedgerBranchError("source-changed", "The selected source identity changed.");
  }
  const sourceFileBytes = Number(metadata.size);
  if (!Number.isSafeInteger(sourceFileBytes) || sourceFileBytes < checkpoint.sourceFileSize) {
    throw new LedgerBranchError("source-changed", "The selected source was truncated before its ledger checkpoint.");
  }
  const anchor = Buffer.alloc(checkpoint.anchorByteLength);
  const read = await handle.read(anchor, 0, anchor.length, checkpoint.anchorSourceOffset);
  if (read.bytesRead !== anchor.length || hash(anchor) !== checkpoint.anchorContentHash) {
    throw new LedgerBranchError("source-changed", "The selected source checkpoint anchor failed verification.");
  }
  return sourceFileBytes;
}

export function resolveSourceLedgerBranch(ledger: SourceLedger, leafId: string): LedgerBranchResolution {
  const started = performance.now();
  if (typeof leafId !== "string" || leafId.length === 0) throw new LedgerBranchError("branch-not-persisted", "The requested branch leaf is empty.");
  const position = new Map<string, number>();
  for (let index = 0; index < ledger.sourceOrder.length; index++) {
    const entry = ledger.sourceOrder[index]!;
    if (position.has(entry.entryId)) throw new LedgerBranchError("branch-cycle", `Duplicate ledger entry ${entry.entryId}.`);
    position.set(entry.entryId, index);
  }
  if (!ledger.entryById.has(leafId)) throw new LedgerBranchError("branch-not-persisted", `Unknown ledger leaf ${leafId}.`);
  const reverse: SourceLedgerEntry[] = [];
  const visited = new Set<string>();
  let cursor: string | null = leafId;
  while (cursor !== null) {
    if (visited.has(cursor)) throw new LedgerBranchError("branch-cycle", `Parent cycle at ${cursor}.`);
    visited.add(cursor);
    const entry = ledger.entryById.get(cursor);
    if (!entry) throw new LedgerBranchError("branch-parent-missing", `Missing ledger parent ${cursor}.`);
    reverse.push(entry);
    if (entry.parentId !== null && typeof entry.parentId !== "string") throw new LedgerBranchError("branch-parent-missing", `Invalid parent for ${cursor}.`);
    if (entry.parentId !== null && !position.has(entry.parentId)) throw new LedgerBranchError("branch-parent-missing", `Missing ledger parent ${entry.parentId}.`);
    cursor = entry.parentId;
  }
  const entries = reverse.reverse();
  for (let index = 1; index < entries.length; index++) {
    const parentPosition = position.get(entries[index - 1]!.entryId);
    const childPosition = position.get(entries[index]!.entryId);
    if (parentPosition === undefined || childPosition === undefined || parentPosition >= childPosition) throw new LedgerBranchError("branch-source-order", `A branch parent occurs after its child.`);
  }
  if (entries.at(-1)?.entryId !== leafId) throw new LedgerBranchError("branch-not-persisted", "The selected ledger branch did not end at the requested leaf.");
  return { entries, resolveMs: performance.now() - started };
}

export function splitLedgerBranchAtEntry(branch: readonly SourceLedgerEntry[], firstKeptEntryId: string): { source: readonly SourceLedgerEntry[]; future: readonly SourceLedgerEntry[]; cutIndex: number } {
  const cutIndex = branch.findIndex((entry) => entry.entryId === firstKeptEntryId);
  if (cutIndex < 0) throw new LedgerBranchError("invalid-cut", `Cut entry ${firstKeptEntryId} is not on the selected branch.`);
  return { source: branch.slice(0, cutIndex), future: branch.slice(cutIndex), cutIndex };
}

export function coalesceSourceLedgerRanges(entries: readonly SourceLedgerEntry[], options: LedgerBranchReadOptions = {}): readonly LedgerSourceRange[] {
  const maximumGapBytes = Math.max(0, Math.floor(options.maximumGapBytes ?? DEFAULT_MAXIMUM_GAP_BYTES));
  const maximumRangeBytes = Math.max(1, Math.floor(options.maximumRangeBytes ?? DEFAULT_MAXIMUM_RANGE_BYTES));
  const maximumEntries = Math.max(1, Math.floor(options.maximumEntriesPerRange ?? DEFAULT_MAXIMUM_ENTRIES_PER_RANGE));
  const ranges: LedgerSourceRange[] = [];
  let current: SourceLedgerEntry[] = [];
  let start = 0;
  let end = 0;
  const close = (): void => { if (current.length > 0) ranges.push({ startByte: start, endByte: end, entries: current }); current = []; };
  for (const entry of entries) {
    const entryEnd = entry.sourceByteOffset + entry.sourceByteLength;
    if (current.length === 0) { current = [entry]; start = entry.sourceByteOffset; end = entryEnd; continue; }
    const gap = entry.sourceByteOffset - end;
    const resultingBytes = entryEnd - start;
    if (gap < 0 || gap > maximumGapBytes || resultingBytes > maximumRangeBytes || current.length >= maximumEntries) {
      close(); current = [entry]; start = entry.sourceByteOffset; end = entryEnd;
    } else { current.push(entry); end = entryEnd; }
  }
  close();
  return ranges;
}

function normalizedParent(value: Record<string, unknown>): string | null {
  if (value.parentId === undefined || value.parentId === null) return null;
  if (typeof value.parentId !== "string" || value.parentId.length === 0) throw new LedgerBranchError("source-changed", "Selected source has an invalid parent value.");
  return value.parentId;
}

export async function readSourceLedgerEntries(sessionPath: string, ledger: SourceLedger, selected: readonly SourceLedgerEntry[], options: LedgerBranchReadOptions = {}): Promise<LoadedLedgerBranch> {
  const started = performance.now();
  const ranges = coalesceSourceLedgerRanges(selected, options);
  const output: SessionEntryLike[] = [];
  const rawTexts: string[] = [];
  let bytesRead = 0;
  let failures = 0;
  let maximumRangeBytes = 0;
  const selectedIds = new Set(selected.map((entry) => entry.entryId));
  let unrelatedEntryBytesRead = 0;
  const handle = await open(sessionPath, noFollowFlags());
  let sourceFileBytes = 0;
  try {
    sourceFileBytes = await verifyOpenedLedgerSource(handle, ledger);
    for (const range of ranges) {
      const length = range.endByte - range.startByte;
      maximumRangeBytes = Math.max(maximumRangeBytes, length);
      const bytes = Buffer.alloc(length);
      const read = await handle.read(bytes, 0, length, range.startByte);
      bytesRead += read.bytesRead;
      if (read.bytesRead !== length) { failures++; throw new LedgerBranchError("source-changed", "A selected source range ended early."); }
      for (const entry of range.entries) {
        const relative = entry.sourceByteOffset - range.startByte;
        const content = bytes.subarray(relative, relative + entry.sourceByteLength);
        if (content.length !== entry.sourceByteLength || hash(content) !== entry.sourceContentHash) { failures++; throw new LedgerBranchError("source-changed", "Selected source bytes failed exact verification."); }
        let value: unknown;
        try { value = JSON.parse(content.toString("utf8")); } catch { failures++; throw new LedgerBranchError("source-changed", "Selected source JSON is invalid."); }
        if (value === null || typeof value !== "object" || Array.isArray(value)) { failures++; throw new LedgerBranchError("source-changed", "Selected source entry is invalid."); }
        const object = value as Record<string, unknown>;
        if (object.id !== entry.entryId || normalizedParent(object) !== entry.parentId || object.type !== entry.entryType) { failures++; throw new LedgerBranchError("source-changed", "Selected source metadata failed exact verification."); }
        output.push(object as SessionEntryLike);
        rawTexts.push(content.toString("utf8"));
      }
    }
    await verifyOpenedLedgerSource(handle, ledger);
  } finally { await handle.close(); }
  let ledgerCursor = 0;
  for (const range of ranges) {
    while (ledgerCursor < ledger.sourceOrder.length && ledger.sourceOrder[ledgerCursor]!.sourceByteOffset + ledger.sourceOrder[ledgerCursor]!.sourceByteLength <= range.startByte) ledgerCursor++;
    for (let index = ledgerCursor; index < ledger.sourceOrder.length; index++) {
      const indexed = ledger.sourceOrder[index]!;
      if (indexed.sourceByteOffset >= range.endByte) break;
      if (selectedIds.has(indexed.entryId)) continue;
      unrelatedEntryBytesRead += Math.max(0, Math.min(indexed.sourceByteOffset + indexed.sourceByteLength, range.endByte) - Math.max(indexed.sourceByteOffset, range.startByte));
    }
  }
  const selectedSourceBytes = selected.reduce((sum, entry) => sum + entry.sourceByteLength, 0);
  const gapBytes = Math.max(0, bytesRead - selectedSourceBytes);
  return { ledgerEntries: selected, entries: output, rawTexts, metrics: { selectedEntryCount: selected.length, selectedSourceBytes,
    sourceRangeCount: ranges.length, totalSourceBytesRead: bytesRead, coalescingGapBytesRead: gapBytes,
    unrelatedEntryBytesRead, maximumRangeBytes, maximumEntryBytes: selected.reduce((max, entry) => Math.max(max, entry.sourceByteLength), 0),
    sourceFileBytes, sourceByteAvoidanceRate: sourceFileBytes === 0 ? 0 : Math.max(0, Math.min(1, 1 - bytesRead / sourceFileBytes)),
    exactVerificationFailures: failures, elapsedLoadMs: performance.now() - started } };
}

export async function loadSourceLedgerBranch(sessionPath: string, ledger: SourceLedger, leafId: string, options: LedgerBranchReadOptions = {}): Promise<LoadedLedgerBranch & { resolveMs: number }> {
  const resolved = resolveSourceLedgerBranch(ledger, leafId);
  return { ...(await readSourceLedgerEntries(sessionPath, ledger, resolved.entries, options)), resolveMs: resolved.resolveMs };
}
