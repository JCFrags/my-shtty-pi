import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { deriveSessionKey } from "../runtime/paths.js";
import type { ImportGap, ImportProgress, ImportResult } from "./contracts.js";
import { SqliteGlanceRepository } from "./store.js";

const READ_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const BATCH_ENTRIES = 128;
interface Input { databasePath: string; selectedPath: string; expectedSessionId?: string; abortBuffer: SharedArrayBuffer; }
interface ImportRow { committed_offset: number; next_ordinal: number; device: number; inode: number; prefix_digest: string; inserted_items: number; discovered_branches: number; imported_dismissals: number; conflicts: number; gaps_json: string; }

const input = workerData as Input;
const abortState = new Int32Array(input.abortBuffer);
function isAborted(): boolean { return Atomics.load(abortState, 0) === 1; }
function post(value: unknown): void { parentPort?.postMessage(value); }
function sourceDigest(buffer: Buffer): string { return createHash("sha256").update(buffer).digest("hex"); }
function safeGaps(value: unknown): ImportGap[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => item && typeof item === "object" && typeof (item as ImportGap).code === "string" ? [item as ImportGap] : []).slice(0, 256);
}
function addGap(gaps: ImportGap[], gap: ImportGap): void {
  const aggregate = gaps.find((item) => item.code === gap.code && item.ordinal === undefined && gap.ordinal === undefined);
  if (aggregate) aggregate.count = (aggregate.count ?? 1) + (gap.count ?? 1);
  else if (gaps.length < 256) gaps.push(gap);
}

async function main(): Promise<void> {
  const fd = openSync(input.selectedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let repository: SqliteGlanceRepository | undefined;
  let stateDb: DatabaseSync | undefined;
  try {
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid)) throw new Error("GLANCE_HISTORY_IMPORT_UNSAFE_SOURCE");
    const prefix = Buffer.alloc(Math.min(4096, stat.size));
    if (prefix.length) readSync(fd, prefix, 0, prefix.length, 0);
    const prefixDigest = sourceDigest(prefix);

    let headerBuffer = Buffer.alloc(0);
    let headerEnd = -1;
    let headerPosition = 0;
    while (headerEnd < 0 && headerBuffer.length <= MAX_LINE_BYTES) {
      const chunk = Buffer.alloc(Math.min(READ_BYTES, Math.max(0, stat.size - headerPosition)));
      if (!chunk.length) break;
      const count = readSync(fd, chunk, 0, chunk.length, headerPosition);
      if (!count) break;
      headerPosition += count;
      headerBuffer = Buffer.concat([headerBuffer, chunk.subarray(0, count)]);
      const newline = headerBuffer.indexOf(0x0a);
      if (newline >= 0) headerEnd = newline + 1;
    }
    if (headerEnd < 0 || headerEnd > MAX_LINE_BYTES) throw new Error("GLANCE_HISTORY_IMPORT_INVALID_HEADER");
    let header: Record<string, unknown>;
    try { header = JSON.parse(headerBuffer.subarray(0, headerEnd - 1).toString("utf8")) as Record<string, unknown>; }
    catch { throw new Error("GLANCE_HISTORY_IMPORT_INVALID_HEADER"); }
    if (header.type !== "session" || typeof header.id !== "string" || !header.id) throw new Error("GLANCE_HISTORY_IMPORT_INVALID_HEADER");
    if (input.expectedSessionId !== undefined && input.expectedSessionId !== header.id) throw new Error("GLANCE_HISTORY_IMPORT_SESSION_MISMATCH");
    const sessionKey = deriveSessionKey(header.id);
    const sessionHash = sourceDigest(Buffer.from(header.id));
    const importId = `import-${sessionHash}`;

    stateDb = new DatabaseSync(input.databasePath);
    stateDb.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
    const prior = stateDb.prepare("SELECT committed_offset,next_ordinal,device,inode,prefix_digest,inserted_items,discovered_branches,imported_dismissals,conflicts,gaps_json FROM imports WHERE import_id=?").get(importId) as unknown as ImportRow | undefined;
    let offset = headerEnd;
    let ordinal = 0;
    let insertedItems = 0;
    let discoveredBranches = 0;
    let importedDismissals = 0;
    let conflicts = 0;
    const gaps = safeGaps(prior ? JSON.parse(prior.gaps_json) : []);
    if (prior && prior.device === stat.dev && prior.inode === stat.ino && prior.prefix_digest === prefixDigest && prior.committed_offset >= headerEnd && prior.committed_offset <= stat.size) {
      offset = prior.committed_offset; ordinal = prior.next_ordinal; insertedItems = prior.inserted_items; discoveredBranches = prior.discovered_branches; importedDismissals = prior.imported_dismissals; conflicts = prior.conflicts;
    } else if (prior) addGap(gaps, { code: "source_changed", count: 1 });

    const save = (nextOffset: number, nextOrdinal: number, state: "running" | "paused" | "complete"): void => {
      stateDb!.prepare(`INSERT INTO imports(import_id,session_key,source_session_hash,device,inode,committed_offset,committed_size,next_ordinal,prefix_digest,state,updated_at,inserted_items,discovered_branches,imported_dismissals,conflicts,gaps_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(import_id) DO UPDATE SET device=excluded.device,inode=excluded.inode,committed_offset=excluded.committed_offset,committed_size=excluded.committed_size,next_ordinal=excluded.next_ordinal,prefix_digest=excluded.prefix_digest,state=excluded.state,updated_at=excluded.updated_at,inserted_items=excluded.inserted_items,discovered_branches=excluded.discovered_branches,imported_dismissals=excluded.imported_dismissals,conflicts=excluded.conflicts,gaps_json=excluded.gaps_json`).run(importId, sessionKey, sessionHash, stat.dev, stat.ino, nextOffset, stat.size, nextOrdinal, prefixDigest, state, new Date().toISOString(), insertedItems, discoveredBranches, importedDismissals, conflicts, JSON.stringify(gaps));
    };
    const progress = (): ImportProgress => ({ importId, committedBytes: offset, totalBytes: stat.size, insertedItems, discoveredBranches, importedDismissals, gaps });
    save(offset, ordinal, "running");
    repository = new SqliteGlanceRepository(input.databasePath);

    let pending = Buffer.alloc(0);
    let position = offset;
    let batch: unknown[] = [];
    let batchStart = ordinal;
    const flush = (committedOffset: number): void => {
      if (batch.length) {
        try {
          const result = repository!.ingestImportBatch(sessionKey, header.id as string, batchStart, batch);
          insertedItems += result.insertedItems;
          conflicts += result.conflicts;
          batch = [];
        } catch (error) {
          if (error instanceof Error && error.message === "GLANCE_HISTORY_SOURCE_CONFLICT") {
            conflicts += 1;
            addGap(gaps, { code: "source_conflict", ordinal: batchStart });
            save(offset, batchStart, "paused");
          }
          throw error;
        }
      }
      offset = committedOffset;
      save(offset, ordinal, isAborted() ? "paused" : "running");
      post({ type: "progress", progress: progress() });
      // Give the owner a bounded opportunity to set the shared cancellation
      // flag without making synchronous SQLite depend on worker message turns.
      Atomics.wait(abortState, 0, 0, 5);
    };

    while (position < stat.size && !isAborted()) {
      const chunk = Buffer.alloc(Math.min(READ_BYTES, stat.size - position));
      const count = readSync(fd, chunk, 0, chunk.length, position);
      if (!count) break;
      position += count;
      pending = Buffer.concat([pending, chunk.subarray(0, count)]);
      let newline: number;
      while ((newline = pending.indexOf(0x0a)) >= 0) {
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        const lineEnd = position - pending.length;
        if (line.length > MAX_LINE_BYTES) {
          flush(lineEnd); addGap(gaps, { code: "oversized_line", ordinal }); ordinal += 1; batchStart = ordinal; continue;
        }
        try {
          const entry = JSON.parse(line.toString("utf8")) as unknown;
          if (!entry || typeof entry !== "object") throw new Error();
          if (!batch.length) batchStart = ordinal;
          batch.push(entry);
        } catch {
          flush(lineEnd); addGap(gaps, { code: "invalid_entry", ordinal });
        }
        ordinal += 1;
        if (batch.length >= BATCH_ENTRIES) flush(lineEnd);
        if (isAborted()) break;
      }
      if (pending.length > MAX_LINE_BYTES && pending.indexOf(0x0a) < 0) throw new Error("GLANCE_HISTORY_IMPORT_OVERSIZED_LINE");
    }
    if (batch.length) flush(position - pending.length);
    if (pending.length && !isAborted()) addGap(gaps, { code: "invalid_entry", ordinal });
    if (isAborted()) {
      save(offset, ordinal, "paused");
      const result: ImportResult = { ...progress(), state: "paused", conflicts };
      post({ type: "result", result });
      parentPort?.close();
      return;
    }

    const missing = Number((stateDb.prepare("SELECT COUNT(*) AS count FROM source_entries e WHERE e.session_key=? AND e.parent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM source_entries p WHERE p.session_key=e.session_key AND p.entry_id=e.parent_id)").get(sessionKey) as { count: number }).count);
    if (missing) addGap(gaps, { code: "missing_parent", count: missing });
    const finalized = repository.finalizeImportedSession(sessionKey);
    discoveredBranches = finalized.discoveredBranches;
    importedDismissals += finalized.importedDismissals;
    offset = stat.size;
    save(offset, ordinal, "complete");
    const result: ImportResult = { importId, committedBytes: offset, totalBytes: stat.size, insertedItems, discoveredBranches: finalized.discoveredBranches, importedDismissals, gaps, state: "complete", conflicts };
    post({ type: "result", result });
    parentPort?.close();
  } finally {
    repository?.close();
    stateDb?.close();
    closeSync(fd);
  }
}

void main().catch((error: unknown) => {
  const code = error instanceof Error && /^GLANCE_HISTORY_[A-Z_]+$/u.test(error.message) ? error.message : "GLANCE_HISTORY_IMPORT_FAILED";
  post({ type: "error", code });
  parentPort?.close();
});
