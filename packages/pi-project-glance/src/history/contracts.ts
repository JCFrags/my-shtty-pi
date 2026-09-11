export const HISTORY_PAGE_SIZE = 25 as const;
export const MAX_HISTORY_CURSOR_BYTES = 512;
export const MAX_HISTORY_PREVIEW_BYTES = 1024;
export const MAX_BODY_CHUNK_UTF8_BYTES = 24 * 1024;

export type DurableItemType =
  | "assistant_update"
  | "checkpoint"
  | "milestone_completed"
  | "plan_completed";

export type HistoryView = "inbox" | "history";
export type CaptureMode = "initial" | "append" | "tree";

export interface SourceCheckpoint {
  sessionKey: string;
  nextOrdinal: number;
  lastEntryId?: string;
  commitSeq: number;
}

export interface CaptureInput {
  sessionKey: string;
  sourceSessionId: string;
  mode: CaptureMode;
  /** Entries beginning exactly at startOrdinal. Initial reconciliation may supply all entries. */
  startOrdinal: number;
  entries: readonly unknown[];
  activeLeafId: string | null;
  /** Required for initial/tree reconciliation; omitted for ordinary append capture. */
  activePathIds?: readonly string[];
  currentBranchId?: string;
}

export interface CaptureResult {
  branchId: string;
  checkpoint: SourceCheckpoint;
  insertedItems: number;
  linkedItems: number;
  importedDismissals: number;
  conflicts: number;
}

export interface ArchiveInput {
  branchId: string;
  itemId: string;
  actionId: string;
  archivedAt: string;
  source: "action" | "legacy";
}

export interface ArchiveResult {
  accepted: boolean;
  changed: boolean;
  archiveSeq: number;
}

export interface PageInput {
  branchId: string;
  view: HistoryView;
  /** Opaque cursor includes its own next/previous direction. */
  cursor?: string;
}

export interface ItemPreview {
  itemId: string;
  type: DurableItemType;
  preview: string;
  createdAt: string;
  bodyBytes: number;
  archivedAt?: string;
}

export interface PageResult {
  branchId: string;
  view: HistoryView;
  snapshotSeq: number;
  items: ItemPreview[];
  previousCursor?: string;
  nextCursor?: string;
}

export interface CountsResult {
  inbox: number;
  history: number;
  commitSeq: number;
}

export interface BodyInput {
  branchId: string;
  itemId: string;
  offset: number;
}

export interface BodyResult {
  itemId: string;
  offset: number;
  text: string;
  previousOffset?: number;
  nextOffset?: number;
  totalBytes: number;
  bodyDigest: string;
}

export type ImportGapCode =
  | "invalid_header"
  | "invalid_entry"
  | "oversized_line"
  | "missing_parent"
  | "source_changed"
  | "source_conflict";

export interface ImportGap {
  code: ImportGapCode;
  ordinal?: number;
  count?: number;
}

export interface ImportProgress {
  importId: string;
  committedBytes: number;
  totalBytes: number;
  insertedItems: number;
  discoveredBranches: number;
  importedDismissals: number;
  gaps: readonly ImportGap[];
}

export interface ImportSelectedInput {
  selectedPath: string;
  expectedSessionId?: string;
  signal?: AbortSignal;
  onProgress?(progress: ImportProgress): void;
}

export interface ImportStatus extends ImportProgress {
  state: "running" | "complete" | "paused";
  conflicts: number;
}

export interface ImportResult extends ImportStatus {
  state: "complete" | "paused";
}

export interface DurableGlanceRepository {
  checkpoint(sessionKey: string): SourceCheckpoint | undefined;
  capture(input: CaptureInput): CaptureResult;
  archive(input: ArchiveInput): ArchiveResult;
  page(input: PageInput): PageResult;
  counts(branchId: string): CountsResult;
  body(input: BodyInput): BodyResult;
  importSelected(input: ImportSelectedInput): Promise<ImportResult>;
  importStatus(importId: string): ImportStatus | undefined;
  close(): void;
}
