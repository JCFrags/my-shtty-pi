import { createHash, createHmac, randomBytes } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { extractArchiveItems } from "../feed/index.js";
import {
  HISTORY_PAGE_SIZE,
  MAX_BODY_CHUNK_UTF8_BYTES,
  MAX_HISTORY_CURSOR_BYTES,
  MAX_HISTORY_PREVIEW_BYTES,
  type ArchiveInput,
  type ArchiveResult,
  type BodyInput,
  type BodyResult,
  type CaptureInput,
  type CaptureResult,
  type CountsResult,
  type DurableGlanceRepository,
  type HistoryView,
  type ImportResult,
  type ImportSelectedInput,
  type ImportStatus,
  type ItemPreview,
  type PageInput,
  type PageResult,
  type SourceCheckpoint,
} from "./contracts.js";
import { newBranchId, opaqueItemId } from "./branch-resolver.js";
import { defaultHistoryDatabasePath, enforcePrivateSqliteFiles, openHistoryDatabase } from "./schema.js";

type Row = Record<string, unknown>;
interface ParsedEntry { id: string; parentId: string | null; timestamp: string; value: unknown; ordinal: number; }
interface CursorV1 { v: 1; view: HistoryView; branchId: string; snapshotSeq: number; ordinal: number; itemPk: number; move: "next" | "previous"; }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown, maximum = 4096): string | undefined {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maximum && !/\p{Cc}|[\uD800-\uDFFF]/u.test(value) ? value : undefined;
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function integer(value: unknown): number { const n = Number(value); if (!Number.isSafeInteger(n)) throw new Error("GLANCE_HISTORY_INVALID_INTEGER"); return n; }
function row(value: unknown): Row | undefined { return value as Row | undefined; }
function sleep(milliseconds: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }
function sqliteBusy(error: unknown): boolean { return error instanceof Error && /SQLITE_BUSY|database is locked/iu.test(error.message); }
const BODY_CHUNK_STRIDE_BYTES = MAX_BODY_CHUNK_UTF8_BYTES - 4;
function clipUtf8(value: string, maximum: number): string {
  const body = Buffer.from(value);
  if (body.length <= maximum) return value;
  let end = Math.max(0, maximum - Buffer.byteLength("…"));
  while (end > 0 && (body[end]! & 0xc0) === 0x80) end -= 1;
  return `${body.subarray(0, end).toString("utf8")}…`;
}

export class SqliteGlanceRepository implements DurableGlanceRepository {
  readonly #database: DatabaseSync;
  readonly #path: string;
  readonly #cursorKey: Buffer;

  constructor(path = defaultHistoryDatabasePath()) {
    this.#path = path;
    this.#database = openHistoryDatabase(path);
    const existing = row(this.#database.prepare("SELECT value FROM history_meta WHERE key='cursor_key'").get())?.value;
    if (typeof existing === "string" && /^[a-f0-9]{64}$/u.test(existing)) this.#cursorKey = Buffer.from(existing, "hex");
    else {
      this.#cursorKey = randomBytes(32);
      this.#database.prepare("INSERT INTO history_meta(key,value) VALUES('cursor_key',?)").run(this.#cursorKey.toString("hex"));
    }
    enforcePrivateSqliteFiles(this.#path);
  }

  checkpoint(sessionKey: string): SourceCheckpoint | undefined {
    const found = row(this.#database.prepare("SELECT next_ordinal,last_entry_id,commit_seq FROM source_checkpoints WHERE session_key=?").get(sessionKey));
    return found ? {
      sessionKey,
      nextOrdinal: integer(found.next_ordinal),
      ...(typeof found.last_entry_id === "string" ? { lastEntryId: found.last_entry_id } : {}),
      commitSeq: integer(found.commit_seq),
    } : undefined;
  }

  capture(input: CaptureInput): CaptureResult {
    if (!text(input.sessionKey, 64) || !text(input.sourceSessionId) || !Number.isSafeInteger(input.startOrdinal) || input.startOrdinal < 0) throw new Error("GLANCE_HISTORY_INVALID_CAPTURE");
    const parsed = input.entries.map((value, index) => this.#parseEntry(value, input.startOrdinal + index));
    if (input.mode === "append" && parsed.length === 0 && input.currentBranchId) {
      const checkpoint = this.checkpoint(input.sessionKey);
      if (!checkpoint || checkpoint.nextOrdinal !== input.startOrdinal || !row(this.#database.prepare("SELECT 1 FROM branches WHERE branch_id=? AND session_key=?").get(input.currentBranchId, input.sessionKey))) throw new Error("GLANCE_HISTORY_CHECKPOINT_MISMATCH");
      return { branchId: input.currentBranchId, checkpoint, insertedItems: 0, linkedItems: 0, importedDismissals: 0, conflicts: 0 };
    }
    return this.#transaction(() => {
      const prior = this.checkpoint(input.sessionKey);
      if (input.mode === "append" && (prior?.nextOrdinal ?? 0) !== input.startOrdinal) throw new Error("GLANCE_HISTORY_CHECKPOINT_MISMATCH");
      const commitSeq = this.#newCommit();
      const sessionHash = digest(input.sourceSessionId);
      const session = row(this.#database.prepare("SELECT source_session_hash FROM sessions WHERE session_key=?").get(input.sessionKey));
      if (session && session.source_session_hash !== sessionHash) throw new Error("GLANCE_HISTORY_SESSION_CONFLICT");
      this.#database.prepare("INSERT OR IGNORE INTO sessions(session_key,source_session_hash,created_at) VALUES(?,?,?)").run(input.sessionKey, sessionHash, new Date().toISOString());

      let insertedItems = 0;
      let linkedItems = 0;
      for (const entry of parsed) {
        const existing = row(this.#database.prepare("SELECT parent_id,source_ordinal,source_at FROM source_entries WHERE session_key=? AND entry_id=?").get(input.sessionKey, entry.id));
        const atOrdinal = row(this.#database.prepare("SELECT entry_id FROM source_entries WHERE session_key=? AND source_ordinal=?").get(input.sessionKey, entry.ordinal));
        if ((atOrdinal && atOrdinal.entry_id !== entry.id) || (existing && (existing.parent_id !== entry.parentId || integer(existing.source_ordinal) !== entry.ordinal || existing.source_at !== entry.timestamp))) throw new Error("GLANCE_HISTORY_SOURCE_CONFLICT");
        this.#database.prepare("INSERT OR IGNORE INTO source_entries(session_key,entry_id,parent_id,source_ordinal,source_at) VALUES(?,?,?,?,?)").run(input.sessionKey, entry.id, entry.parentId, entry.ordinal, entry.timestamp);
        // Extract every newly checkpointed entry once. Branch membership remains
        // restricted below to the selected ancestry, so later tree selection can
        // recover an off-path update without rescanning the source session.
        const raw = record(entry.value);
        const ui = record(raw?.data);
        if (raw?.type === "custom" && raw.customType === "pi-project-glance/ui-state-v1" && ui?.version === 1 && ui.action === "dismiss" && typeof ui.itemId === "string" && text(ui.itemId, 128)) {
          this.#database.prepare("INSERT OR IGNORE INTO legacy_dismissals(session_key,entry_id,projection_id,archived_at) VALUES(?,?,?,?)").run(input.sessionKey, entry.id, ui.itemId, entry.timestamp);
        }
        for (const item of extractArchiveItems(entry.value)) {
          const itemId = opaqueItemId(input.sessionKey, item.sourceEntryId, item.sourceKind);
          const bodyDigest = digest(item.sanitizedBody);
          const accepted = row(this.#database.prepare("SELECT body_digest FROM items WHERE session_key=? AND source_entry_id=? AND source_kind=?").get(input.sessionKey, item.sourceEntryId, item.sourceKind));
          if (accepted && accepted.body_digest !== bodyDigest) throw new Error("GLANCE_HISTORY_SOURCE_CONFLICT");
          const result = this.#database.prepare("INSERT OR IGNORE INTO items(item_id,session_key,source_entry_id,source_kind,projection_id,type,source_at,source_ordinal,preview,body,body_bytes,body_digest,committed_seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(itemId, input.sessionKey, item.sourceEntryId, item.sourceKind, item.projectionId, item.type, item.createdAt, entry.ordinal, clipUtf8(item.sanitizedBody, MAX_HISTORY_PREVIEW_BYTES), item.sanitizedBody, Buffer.byteLength(item.sanitizedBody), bodyDigest, commitSeq);
          insertedItems += Number(result.changes);
        }
      }

      const branchId = this.#resolveBranch(input, commitSeq);
      const pathIds = input.activePathIds ?? parsed.map((entry) => entry.id);
      const insertBranchEntry = this.#database.prepare("INSERT OR IGNORE INTO branch_entries(branch_id,entry_id) VALUES(?,?)");
      for (const id of pathIds) {
        if (!text(id, 128)) throw new Error("GLANCE_HISTORY_INVALID_PATH");
        insertBranchEntry.run(branchId, id);
      }
      const link = this.#database.prepare("INSERT OR IGNORE INTO branch_items(branch_id,item_pk,visible_seq) SELECT ?,item_pk,? FROM items WHERE session_key=? AND source_entry_id=?");
      for (const id of pathIds) linkedItems += Number(link.run(branchId, commitSeq, input.sessionKey, id).changes);

      let importedDismissals = 0;
      // Reconciliation replays stored ancestry so an empty tree capture can
      // recover dismissals. Ordinary append/import batches inspect only their
      // new entries, keeping incremental capture independent of archive size.
      const legacy = input.activePathIds
        ? this.#database.prepare("SELECT l.entry_id,l.projection_id,l.archived_at FROM legacy_dismissals l JOIN branch_entries be ON be.entry_id=l.entry_id AND be.branch_id=? WHERE l.session_key=? ORDER BY l.rowid").all(branchId, input.sessionKey) as Row[]
        : parsed.flatMap((entry): Row[] => {
          const source = record(entry.value);
          const data = record(source?.data);
          return source?.type === "custom" && source.customType === "pi-project-glance/ui-state-v1" && data?.version === 1 && data.action === "dismiss" && typeof data.itemId === "string"
            ? [{ entry_id: entry.id, projection_id: data.itemId, archived_at: entry.timestamp }]
            : [];
        });
      for (const dismissal of legacy) {
        const item = row(this.#database.prepare("SELECT i.item_pk FROM items i JOIN branch_items bi ON bi.item_pk=i.item_pk WHERE bi.branch_id=? AND i.projection_id=? ORDER BY i.item_pk DESC LIMIT 1").get(branchId, String(dismissal.projection_id)));
        if (!item) continue;
        const actionId = `legacy:${input.sessionKey}:${String(dismissal.entry_id)}`;
        const result = this.#archiveNow({ branchId, itemId: this.#itemId(integer(item.item_pk)), actionId, archivedAt: String(dismissal.archived_at), source: "legacy" }, commitSeq);
        if (result.changed) importedDismissals += 1;
      }

      const nextOrdinal = Math.max(prior?.nextOrdinal ?? 0, input.startOrdinal + parsed.length);
      const lastEntryId = parsed.at(-1)?.id ?? prior?.lastEntryId;
      this.#database.prepare("INSERT INTO source_checkpoints(session_key,next_ordinal,last_entry_id,commit_seq) VALUES(?,?,?,?) ON CONFLICT(session_key) DO UPDATE SET next_ordinal=excluded.next_ordinal,last_entry_id=excluded.last_entry_id,commit_seq=excluded.commit_seq").run(input.sessionKey, nextOrdinal, lastEntryId ?? null, commitSeq);
      return { branchId, checkpoint: { sessionKey: input.sessionKey, nextOrdinal, ...(lastEntryId ? { lastEntryId } : {}), commitSeq }, insertedItems, linkedItems, importedDismissals, conflicts: 0 };
    });
  }

  archive(input: ArchiveInput): ArchiveResult {
    return this.#transaction(() => this.#archiveNow(input, this.#newCommit()));
  }

  #archiveNow(input: ArchiveInput, commitSeq: number): ArchiveResult {
    if (!text(input.branchId, 128) || !text(input.itemId, 128) || !text(input.actionId, 128) || !Number.isFinite(Date.parse(input.archivedAt))) throw new Error("GLANCE_HISTORY_INVALID_ARCHIVE");
    const item = row(this.#database.prepare("SELECT i.item_pk FROM items i JOIN branch_items bi ON bi.item_pk=i.item_pk WHERE i.item_id=? AND bi.branch_id=?").get(input.itemId, input.branchId));
    if (!item) return { accepted: false, changed: false, archiveSeq: commitSeq };
    const itemPk = integer(item.item_pk);
    const receipt = row(this.#database.prepare("SELECT item_pk,archive_seq FROM archive_receipts WHERE branch_id=? AND action_id=?").get(input.branchId, input.actionId));
    if (receipt) {
      if (integer(receipt.item_pk) !== itemPk) throw new Error("GLANCE_HISTORY_ACTION_CONFLICT");
      return { accepted: true, changed: false, archiveSeq: integer(receipt.archive_seq) };
    }
    const changed = Number(this.#database.prepare("INSERT OR IGNORE INTO archives(branch_id,item_pk,action_id,archive_seq,archived_at,source) VALUES(?,?,?,?,?,?)").run(input.branchId, itemPk, input.actionId, commitSeq, input.archivedAt, input.source).changes) === 1;
    const archive = row(this.#database.prepare("SELECT archive_seq FROM archives WHERE branch_id=? AND item_pk=?").get(input.branchId, itemPk));
    const archiveSeq = integer(archive?.archive_seq ?? commitSeq);
    this.#database.prepare("INSERT INTO archive_receipts(branch_id,action_id,item_pk,archive_seq) VALUES(?,?,?,?)").run(input.branchId, input.actionId, itemPk, archiveSeq);
    return { accepted: true, changed, archiveSeq };
  }

  page(input: PageInput): PageResult {
    if (!text(input.branchId, 128) || (input.view !== "inbox" && input.view !== "history")) throw new Error("GLANCE_HISTORY_INVALID_PAGE");
    const cursor = input.cursor ? this.#decodeCursor(input.cursor) : undefined;
    if (cursor && (cursor.branchId !== input.branchId || cursor.view !== input.view)) throw new Error("GLANCE_HISTORY_CURSOR_MISMATCH");
    const snapshotSeq = cursor?.snapshotSeq ?? this.#maxCommit();
    const move = cursor?.move ?? "next";
    const ascending = input.view === "inbox";
    const displayOperator = ascending ? ">" : "<";
    const reverseOperator = ascending ? "<" : ">";
    const operator = move === "next" ? displayOperator : reverseOperator;
    const order = (ascending === (move === "next")) ? "ASC" : "DESC";
    const archivedPredicate = input.view === "inbox" ? "a.item_pk IS NULL" : "a.item_pk IS NOT NULL";
    const params: SQLInputValue[] = [snapshotSeq, input.branchId, snapshotSeq];
    let boundary = "";
    if (cursor) {
      boundary = `AND (i.source_ordinal ${operator} ? OR (i.source_ordinal=? AND i.item_pk ${operator} ?))`;
      params.push(cursor.ordinal, cursor.ordinal, cursor.itemPk);
    }
    const sql = `SELECT i.item_pk,i.item_id,i.type,i.preview,i.source_at,i.source_ordinal,i.body_bytes,a.archived_at
      FROM branch_items bi JOIN items i ON i.item_pk=bi.item_pk
      LEFT JOIN archives a ON a.branch_id=bi.branch_id AND a.item_pk=bi.item_pk AND a.archive_seq<=?
      WHERE bi.branch_id=? AND bi.visible_seq<=? AND ${archivedPredicate} ${boundary}
      ORDER BY i.source_ordinal ${order},i.item_pk ${order} LIMIT ${HISTORY_PAGE_SIZE}`;
    let rows = this.#database.prepare(sql).all(...params) as Row[];
    if (move === "previous") rows = rows.reverse();
    const items = rows.map((value) => this.#preview(value));
    const first = rows[0];
    const last = rows.at(-1);
    const previousCursor = first && this.#hasBeyond(input.branchId, input.view, snapshotSeq, integer(first.source_ordinal), integer(first.item_pk), "previous")
      ? this.#encodeCursor({ v: 1, view: input.view, branchId: input.branchId, snapshotSeq, ordinal: integer(first.source_ordinal), itemPk: integer(first.item_pk), move: "previous" }) : undefined;
    const nextCursor = last && this.#hasBeyond(input.branchId, input.view, snapshotSeq, integer(last.source_ordinal), integer(last.item_pk), "next")
      ? this.#encodeCursor({ v: 1, view: input.view, branchId: input.branchId, snapshotSeq, ordinal: integer(last.source_ordinal), itemPk: integer(last.item_pk), move: "next" }) : undefined;
    return { branchId: input.branchId, view: input.view, snapshotSeq, items, ...(previousCursor ? { previousCursor } : {}), ...(nextCursor ? { nextCursor } : {}) };
  }

  counts(branchId: string): CountsResult {
    if (!text(branchId, 128)) throw new Error("GLANCE_HISTORY_INVALID_BRANCH");
    const values = row(this.#database.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN a.item_pk IS NULL THEN 1 ELSE 0 END) AS inbox,SUM(CASE WHEN a.item_pk IS NOT NULL THEN 1 ELSE 0 END) AS history FROM branch_items bi LEFT JOIN archives a ON a.branch_id=bi.branch_id AND a.item_pk=bi.item_pk WHERE bi.branch_id=?").get(branchId));
    return { inbox: Number(values?.inbox ?? 0), history: Number(values?.history ?? 0), commitSeq: this.#maxCommit() };
  }

  body(input: BodyInput): BodyResult {
    if (!text(input.branchId, 128) || !text(input.itemId, 128) || !Number.isSafeInteger(input.offset) || input.offset < 0) throw new Error("GLANCE_HISTORY_INVALID_BODY_REQUEST");
    const metadata = row(this.#database.prepare("SELECT i.body_bytes,i.body_digest FROM items i JOIN branch_items bi ON bi.item_pk=i.item_pk WHERE bi.branch_id=? AND i.item_id=?").get(input.branchId, input.itemId));
    if (!metadata) throw new Error("GLANCE_HISTORY_ITEM_NOT_FOUND");
    const totalBytes = integer(metadata.body_bytes);
    if (input.offset < 0 || input.offset > totalBytes) throw new Error("GLANCE_HISTORY_BODY_OFFSET");
    const chunkIndex = input.offset === 0 ? 0 : Math.floor(input.offset / BODY_CHUNK_STRIDE_BYTES);
    const canonicalOffset = this.#canonicalBodyOffset(input.branchId, input.itemId, chunkIndex * BODY_CHUNK_STRIDE_BYTES, totalBytes);
    if (input.offset !== canonicalOffset) throw new Error("GLANCE_HISTORY_BODY_OFFSET");
    const nextBoundary = this.#canonicalBodyOffset(input.branchId, input.itemId, (chunkIndex + 1) * BODY_CHUNK_STRIDE_BYTES, totalBytes);
    const nextOffset = nextBoundary > input.offset && nextBoundary < totalBytes ? nextBoundary : undefined;
    const end = nextOffset ?? totalBytes;
    const chunk = row(this.#database.prepare("SELECT CAST(substr(CAST(i.body AS BLOB),?,?) AS BLOB) AS chunk FROM items i JOIN branch_items bi ON bi.item_pk=i.item_pk WHERE bi.branch_id=? AND i.item_id=?").get(input.offset + 1, end - input.offset, input.branchId, input.itemId))?.chunk;
    if (!(chunk instanceof Uint8Array) || chunk.byteLength > MAX_BODY_CHUNK_UTF8_BYTES) throw new Error("GLANCE_HISTORY_BODY_CHUNK_INVALID");
    const previousOffset = chunkIndex > 0 ? this.#canonicalBodyOffset(input.branchId, input.itemId, (chunkIndex - 1) * BODY_CHUNK_STRIDE_BYTES, totalBytes) : undefined;
    return { itemId: input.itemId, offset: input.offset, text: Buffer.from(chunk).toString("utf8"), ...(previousOffset !== undefined ? { previousOffset } : {}), ...(nextOffset !== undefined ? { nextOffset } : {}), totalBytes, bodyDigest: String(metadata.body_digest) };
  }

  async importSelected(input: ImportSelectedInput): Promise<ImportResult> {
    const { importSelectedSession } = await import("./import.js");
    return importSelectedSession(this.#path, input);
  }

  importStatus(importId: string): ImportStatus | undefined {
    if (!text(importId, 128)) throw new Error("GLANCE_HISTORY_INVALID_IMPORT_ID");
    const value = row(this.#database.prepare("SELECT import_id,committed_offset,committed_size,inserted_items,discovered_branches,imported_dismissals,conflicts,gaps_json,state FROM imports WHERE import_id=?").get(importId));
    if (!value) return undefined;
    let gaps: ImportStatus["gaps"];
    try { gaps = JSON.parse(String(value.gaps_json)) as ImportStatus["gaps"]; }
    catch { throw new Error("GLANCE_HISTORY_IMPORT_STATE_INVALID"); }
    if (value.state !== "running" && value.state !== "paused" && value.state !== "complete") throw new Error("GLANCE_HISTORY_IMPORT_STATE_INVALID");
    return { importId, committedBytes: integer(value.committed_offset), totalBytes: integer(value.committed_size), insertedItems: integer(value.inserted_items), discoveredBranches: integer(value.discovered_branches), importedDismissals: integer(value.imported_dismissals), conflicts: integer(value.conflicts), gaps, state: value.state };
  }

  close(): void { this.#database.close(); }

  /** Import-worker entry point. It stores only sanitized projections and structural metadata. */
  ingestImportBatch(sessionKey: string, sourceSessionId: string, startOrdinal: number, entries: readonly unknown[]): { insertedItems: number; conflicts: number } {
    const stagingBranch = `branch-import-${digest(sourceSessionId).slice(0, 32)}`;
    const result = this.capture({ sessionKey, sourceSessionId, mode: "initial", startOrdinal, entries, activeLeafId: entries.length ? String(record(entries.at(-1))?.id ?? "") : null, currentBranchId: stagingBranch });
    return { insertedItems: result.insertedItems, conflicts: result.conflicts };
  }

  /** Replace import staging membership with complete branch-isolated leaf ancestry. */
  finalizeImportedSession(sessionKey: string): { discoveredBranches: number; importedDismissals: number } {
    return this.#transaction(() => {
      const commitSeq = this.#newCommit();
      const staging = this.#database.prepare("SELECT branch_id FROM branches WHERE session_key=? AND branch_id LIKE 'branch-import-%'").all(sessionKey) as Row[];
      for (const value of staging) {
        const id = String(value.branch_id);
        this.#database.prepare("DELETE FROM archive_receipts WHERE branch_id=?").run(id);
        this.#database.prepare("DELETE FROM archives WHERE branch_id=?").run(id);
        this.#database.prepare("DELETE FROM branch_items WHERE branch_id=?").run(id);
        this.#database.prepare("DELETE FROM branch_entries WHERE branch_id=?").run(id);
        this.#database.prepare("DELETE FROM branch_heads WHERE branch_id=?").run(id);
        this.#database.prepare("DELETE FROM branches WHERE branch_id=?").run(id);
      }
      const leaves = this.#database.prepare("SELECT e.entry_id FROM source_entries e WHERE e.session_key=? AND NOT EXISTS(SELECT 1 FROM source_entries c WHERE c.session_key=e.session_key AND c.parent_id=e.entry_id) ORDER BY e.source_ordinal").all(sessionKey) as Row[];
      let importedDismissals = 0;
      for (const leaf of leaves) {
        const leafId = String(leaf.entry_id);
        let branchId = row(this.#database.prepare("SELECT branch_id FROM branch_heads WHERE session_key=? AND entry_id=? ORDER BY rowid LIMIT 1").get(sessionKey, leafId))?.branch_id as string | undefined;
        branchId ??= newBranchId();
        this.#database.prepare("INSERT OR IGNORE INTO branches(branch_id,session_key,base_entry_id,head_entry_id,created_seq) VALUES(?,?,NULL,?,?)").run(branchId, sessionKey, leafId, commitSeq);
        this.#database.prepare("INSERT OR IGNORE INTO branch_heads(session_key,entry_id,branch_id) VALUES(?,?,?)").run(sessionKey, leafId, branchId);
        this.#database.prepare(`WITH RECURSIVE path(id,parent_id) AS (
          SELECT entry_id,parent_id FROM source_entries WHERE session_key=? AND entry_id=?
          UNION ALL SELECT e.entry_id,e.parent_id FROM source_entries e JOIN path p ON e.entry_id=p.parent_id WHERE e.session_key=?
        ) INSERT OR IGNORE INTO branch_entries(branch_id,entry_id) SELECT ?,id FROM path`).run(sessionKey, leafId, sessionKey, branchId);
        this.#database.prepare("INSERT OR IGNORE INTO branch_items(branch_id,item_pk,visible_seq) SELECT ?,i.item_pk,? FROM items i JOIN branch_entries be ON be.entry_id=i.source_entry_id WHERE be.branch_id=? AND i.session_key=?").run(branchId, commitSeq, branchId, sessionKey);
        const legacy = this.#database.prepare("SELECT l.entry_id,l.projection_id,l.archived_at,i.item_id FROM legacy_dismissals l JOIN branch_entries de ON de.entry_id=l.entry_id AND de.branch_id=? JOIN items i ON i.session_key=l.session_key AND i.projection_id=l.projection_id JOIN branch_items bi ON bi.item_pk=i.item_pk AND bi.branch_id=? WHERE l.session_key=?").all(branchId, branchId, sessionKey) as Row[];
        for (const value of legacy) {
          const result = this.#archiveNow({ branchId, itemId: String(value.item_id), actionId: `legacy:${sessionKey}:${String(value.entry_id)}`, archivedAt: String(value.archived_at), source: "legacy" }, commitSeq);
          if (result.changed) importedDismissals += 1;
        }
      }
      return { discoveredBranches: leaves.length, importedDismissals };
    });
  }

  #resolveBranch(input: CaptureInput, commitSeq: number): string {
    let branchId: string | undefined;
    if (input.mode === "append" && input.currentBranchId) {
      const current = row(this.#database.prepare("SELECT head_entry_id FROM branches WHERE branch_id=? AND session_key=?").get(input.currentBranchId, input.sessionKey));
      if (!current) {
        // Import staging supplies its stable branch ID before the first batch.
        if (!input.currentBranchId.startsWith("branch-import-")) throw new Error("GLANCE_HISTORY_BRANCH_MISMATCH");
        branchId = input.currentBranchId;
      } else {
        const first = record(input.entries[0]);
        if (first && current.head_entry_id !== null && first.parentId !== current.head_entry_id && first.id !== current.head_entry_id) throw new Error("GLANCE_HISTORY_BRANCH_MISMATCH");
        branchId = input.currentBranchId;
      }
    }
    if (!branchId && input.activeLeafId) {
      // Tree checkout reuses only an exact current head. A historical intermediate
      // head gets a new branch so later descendants cannot leak into its view.
      branchId = row(this.#database.prepare("SELECT branch_id FROM branches WHERE session_key=? AND head_entry_id=? ORDER BY created_seq LIMIT 1").get(input.sessionKey, input.activeLeafId))?.branch_id as string | undefined;
    }
    if (!branchId && input.mode === "initial" && input.activePathIds) {
      // A restart can discover persisted linear appends after the last archive
      // checkpoint. Reuse the deepest prior head on the selected ancestry.
      for (let index = input.activePathIds.length - 1; index >= 0 && !branchId; index -= 1) {
        branchId = row(this.#database.prepare("SELECT branch_id FROM branches WHERE session_key=? AND head_entry_id=? ORDER BY created_seq LIMIT 1").get(input.sessionKey, input.activePathIds[index]!))?.branch_id as string | undefined;
      }
    }
    branchId ??= input.currentBranchId?.startsWith("branch-import-") ? input.currentBranchId : newBranchId();
    this.#database.prepare("INSERT OR IGNORE INTO branches(branch_id,session_key,base_entry_id,head_entry_id,created_seq) VALUES(?,?,?,?,?)").run(branchId, input.sessionKey, input.activePathIds?.[0] ?? input.activeLeafId, input.activeLeafId, commitSeq);
    this.#database.prepare("UPDATE branches SET head_entry_id=? WHERE branch_id=?").run(input.activeLeafId, branchId);
    if (input.activeLeafId) this.#database.prepare("INSERT OR IGNORE INTO branch_heads(session_key,entry_id,branch_id) VALUES(?,?,?)").run(input.sessionKey, input.activeLeafId, branchId);
    return branchId;
  }

  #parseEntry(value: unknown, ordinal: number): ParsedEntry {
    const source = record(value);
    const id = text(source?.id, 128);
    let parentId: string | null;
    if (source?.parentId === null) parentId = null;
    else {
      const checked = text(source?.parentId, 128);
      if (!checked) throw new Error("GLANCE_HISTORY_INVALID_SOURCE_ENTRY");
      parentId = checked;
    }
    const timestamp = text(source?.timestamp, 64);
    if (!id || !timestamp || !Number.isFinite(Date.parse(timestamp))) throw new Error("GLANCE_HISTORY_INVALID_SOURCE_ENTRY");
    return { id, parentId, timestamp: new Date(timestamp).toISOString(), value, ordinal };
  }

  #newCommit(): number {
    return Number(this.#database.prepare("INSERT INTO commits(committed_at) VALUES(?)").run(new Date().toISOString()).lastInsertRowid);
  }
  #maxCommit(): number { return Number(row(this.#database.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM commits").get())?.seq ?? 0); }
  #itemId(itemPk: number): string { return String(row(this.#database.prepare("SELECT item_id FROM items WHERE item_pk=?").get(itemPk))?.item_id ?? ""); }
  #canonicalBodyOffset(branchId: string, itemId: string, rawOffset: number, totalBytes: number): number {
    if (rawOffset <= 0) return 0;
    if (rawOffset >= totalBytes) return totalBytes;
    const sample = row(this.#database.prepare("SELECT CAST(substr(CAST(i.body AS BLOB),?,4) AS BLOB) AS sample FROM items i JOIN branch_items bi ON bi.item_pk=i.item_pk WHERE bi.branch_id=? AND i.item_id=?").get(rawOffset + 1, branchId, itemId))?.sample;
    if (!(sample instanceof Uint8Array)) throw new Error("GLANCE_HISTORY_ITEM_NOT_FOUND");
    let advance = 0;
    while (advance < sample.byteLength && (sample[advance]! & 0xc0) === 0x80) advance += 1;
    if (advance >= sample.byteLength) throw new Error("GLANCE_HISTORY_BODY_OFFSET");
    return rawOffset + advance;
  }

  #preview(value: Row): ItemPreview {
    return { itemId: String(value.item_id), type: value.type as ItemPreview["type"], preview: String(value.preview), createdAt: String(value.source_at), bodyBytes: integer(value.body_bytes), ...(typeof value.archived_at === "string" ? { archivedAt: value.archived_at } : {}) };
  }

  #hasBeyond(branchId: string, view: HistoryView, snapshotSeq: number, ordinal: number, itemPk: number, move: "next" | "previous"): boolean {
    const ascending = view === "inbox";
    const operator = move === "next" ? (ascending ? ">" : "<") : (ascending ? "<" : ">");
    const archive = view === "inbox" ? "a.item_pk IS NULL" : "a.item_pk IS NOT NULL";
    const statement = this.#database.prepare(`SELECT 1 FROM branch_items bi JOIN items i ON i.item_pk=bi.item_pk LEFT JOIN archives a ON a.branch_id=bi.branch_id AND a.item_pk=bi.item_pk AND a.archive_seq<=? WHERE bi.branch_id=? AND bi.visible_seq<=? AND ${archive} AND (i.source_ordinal ${operator} ? OR (i.source_ordinal=? AND i.item_pk ${operator} ?)) LIMIT 1`);
    const params: SQLInputValue[] = [snapshotSeq, branchId, snapshotSeq];
    params.push(ordinal, ordinal, itemPk);
    return Boolean(statement.get(...params));
  }

  #encodeCursor(value: CursorV1): string {
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    const signature = createHmac("sha256", this.#cursorKey).update(payload).digest("base64url");
    const encoded = `${payload}.${signature}`;
    if (Buffer.byteLength(encoded) > MAX_HISTORY_CURSOR_BYTES) throw new Error("GLANCE_HISTORY_CURSOR_TOO_LARGE");
    return encoded;
  }
  #decodeCursor(value: string): CursorV1 {
    if (Buffer.byteLength(value) > MAX_HISTORY_CURSOR_BYTES) throw new Error("GLANCE_HISTORY_INVALID_CURSOR");
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra || createHmac("sha256", this.#cursorKey).update(payload).digest("base64url") !== signature) throw new Error("GLANCE_HISTORY_INVALID_CURSOR");
    const parsed = record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    if (!parsed || parsed.v !== 1 || (parsed.view !== "inbox" && parsed.view !== "history") || !text(parsed.branchId, 128) || !Number.isSafeInteger(parsed.snapshotSeq) || !Number.isSafeInteger(parsed.ordinal) || !Number.isSafeInteger(parsed.itemPk) || (parsed.move !== "next" && parsed.move !== "previous")) throw new Error("GLANCE_HISTORY_INVALID_CURSOR");
    return parsed as unknown as CursorV1;
  }

  #transaction<T>(operation: () => T): T {
    for (let attempt = 0; ; attempt += 1) {
      try {
        this.#database.exec("BEGIN IMMEDIATE");
        try { const value = operation(); this.#database.exec("COMMIT"); enforcePrivateSqliteFiles(this.#path); return value; }
        catch (error) { try { this.#database.exec("ROLLBACK"); } catch { /* Preserve the operation error. */ } throw error; }
      } catch (error) {
        if (!sqliteBusy(error) || attempt >= 4) throw error;
        sleep(10 * (attempt + 1));
      }
    }
  }
}

export function createDurableGlanceRepository(path?: string): DurableGlanceRepository {
  return path === undefined ? new SqliteGlanceRepository() : new SqliteGlanceRepository(path);
}
