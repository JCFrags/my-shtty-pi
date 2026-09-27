import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants as F, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { CatalogRequest, CatalogSourceIdentityRequest } from "./catalog-contract.js";
import { isCatalogFileIdentity, sameCatalogFileIdentity, type CatalogFileIdentity } from "./catalog-file-identity.js";
import { CatalogSource, type CatalogSourceIdentityReceipt, type CatalogSourceObservation, type CatalogSourceSnapshot } from "./catalog-source.js";
import type { SqlRow, SqlValue } from "./catalog-sqlite.js";

const MAX_PROGRESS_BYTES = 16 * 1024;
const MAX_LEGACY_SNAPSHOT_BYTES = 4096;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
interface Progress {
  version: 1;
  storeKey: string; sessionKey: string; generation: number; shardKey: string; recoveryKey: string;
  previousSnapshot: string; previousSnapshotHash: string; checkpointHash: string; bindingHash: string;
  fileIdentity: CatalogFileIdentity; observation: CatalogSourceObservation;
  after: number; lastOffset: number; spans: number; spanChainHash: string;
}
/** Engine supplies its counted SQL access and holds the SQLite writer transaction.
 * No caller cursor or claimed proof is accepted by this interface.
 */
export interface CatalogSourceRecoveryAccess {
  shard: SqlRow;
  rows(sql: string, limit: number, ...values: SqlValue[]): SqlRow[];
  publish(snapshot: string): void;
  charge(bytes: number): void;
}
const bindingHash = (shard: SqlRow): string => hash(JSON.stringify([
  shard.g, shard.shard, shard.branch, shard.ordinal, shard.path, shard.parent,
  shard.checkpointHash, shard.observed, shard.committed, shard.count, shard.caught,
]));
function privateDirectory(path: string): Stats {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== 0o700) fail("catalog-storage-unsafe");
  return stat;
}
function syncDirectory(path: string): void {
  const fd = openSync(path, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
const sameStat = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.uid === b.uid && a.mode === b.mode && a.nlink === b.nlink;
function readProgress(directory: string, path: string): Progress | undefined {
  try { privateDirectory(directory); } catch (error) { if (missing(error)) return undefined; throw error; }
  let before: Stats;
  try { before = lstatSync(path); } catch (error) { if (missing(error)) return undefined; throw error; }
  const safe = (stat: Stats): void => {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== 0o600
      || stat.nlink !== 1 || stat.size < 2 || stat.size > MAX_PROGRESS_BYTES) fail("catalog-source-identity-progress-invalid");
  };
  safe(before);
  const fd = openSync(path, F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
  try {
    const opened = fstatSync(fd); safe(opened);
    if (!sameStat(before, opened)) fail("catalog-source-identity-progress-invalid");
    const bytes = Buffer.alloc(MAX_PROGRESS_BYTES + 1); let size = 0;
    while (size < bytes.length) { const count = readSync(fd, bytes, size, bytes.length - size, size); if (!count) break; size += count; }
    if (size !== opened.size || !sameStat(opened, fstatSync(fd)) || !sameStat(opened, lstatSync(path))) fail("catalog-source-identity-progress-invalid");
    try { return JSON.parse(bytes.subarray(0, size).toString("utf8")) as Progress; }
    catch { return fail("catalog-source-identity-progress-invalid"); }
  } finally { closeSync(fd); }
}
/** Prepared progress is not acceptance. A crash after its rename can leave a
 * valid advanced proof page even when the enclosing no-op DB transaction fails.
 * Every later step rechecks the frozen source and database binding.
 */
function writeProgress(root: string, directory: string, path: string, progress: Progress): void {
  privateDirectory(root);
  try { privateDirectory(directory); }
  catch (error) {
    if (!missing(error)) throw error;
    mkdirSync(directory, { mode: 0o700 }); privateDirectory(directory); syncDirectory(root);
  }
  const parent = privateDirectory(directory);
  const bytes = Buffer.from(JSON.stringify(progress));
  if (bytes.length > MAX_PROGRESS_BYTES) fail("catalog-source-identity-progress-invalid");
  const temporary = join(directory, `.pending-${randomUUID()}`);
  const fd = openSync(temporary, F.O_WRONLY | F.O_CREAT | F.O_EXCL | F.O_NOFOLLOW, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) { const count = writeSync(fd, bytes, offset, bytes.length - offset); if (!count) fail("catalog-storage-io"); offset += count; }
    fsyncSync(fd);
    const after = privateDirectory(directory);
    if (parent.dev !== after.dev || parent.ino !== after.ino) fail("catalog-storage-unsafe");
    renameSync(temporary, path); syncDirectory(directory);
  } finally {
    closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (!missing(error)) throw error; }
  }
}
function legacySnapshot(text: string): CatalogSourceSnapshot & { schemaVersion: 1 } {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_LEGACY_SNAPSHOT_BYTES) return fail("catalog-source-identity-incompatible");
  let snapshot: CatalogSourceSnapshot;
  try { snapshot = JSON.parse(text) as CatalogSourceSnapshot; } catch { return fail("catalog-source-identity-incompatible"); }
  if (!snapshot || snapshot.schemaVersion !== 1 || !integer(snapshot.size) || !snapshot.identity
    || typeof snapshot.identity.device !== "string" || !/^\d+$/.test(snapshot.identity.device)
    || typeof snapshot.identity.inode !== "string" || !/^\d+$/.test(snapshot.identity.inode)) return fail("catalog-source-identity-incompatible");
  return snapshot;
}
function validateProgress(value: Progress, request: CatalogRequest & CatalogSourceIdentityRequest): void {
  if (!value || value.version !== 1 || value.storeKey !== request.targetStoreKey || value.sessionKey !== request.sessionKey
    || value.generation !== request.generation || value.shardKey !== request.shardKey || value.recoveryKey !== request.recoveryKey
    || value.previousSnapshotHash !== request.expectedSnapshotHash || value.checkpointHash !== request.expectedCheckpointHash
    || !isHash(value.bindingHash) || !isHash(value.spanChainHash) || !isCatalogFileIdentity(value.fileIdentity)
    || value.fileIdentity.kind !== "linux-btrfs-statfs" || !integer(value.after) || !integer(value.spans)
    || !Number.isSafeInteger(value.lastOffset) || value.lastOffset < -1
    || !value.observation || !integer(value.observation.size)
    || ![value.observation.device, value.observation.inode].every(x => typeof x === "string" && /^\d+$/.test(x))
    || ![value.observation.mtimeNs, value.observation.ctimeNs].every(x => typeof x === "string" && /^-?\d{1,40}$/.test(x))) fail("catalog-source-identity-progress-invalid");
  const snapshot = legacySnapshot(value.previousSnapshot);
  if (hash(value.previousSnapshot) !== value.previousSnapshotHash || value.after > snapshot.size
    || snapshot.size > value.observation.size || snapshot.identity.inode !== value.observation.inode
    || value.fileIdentity.inode !== value.observation.inode
    || (value.spans === 0 ? value.after !== 0 || value.lastOffset !== -1 : value.after === 0 || value.lastOffset < 0 || value.lastOffset >= value.after)) fail("catalog-source-identity-progress-invalid");
}
function receipt(progress: Progress): CatalogSourceIdentityReceipt {
  return { version: 1, recoveryKey: progress.recoveryKey, storeKey: progress.storeKey, sessionKey: progress.sessionKey,
    generation: progress.generation, shardKey: progress.shardKey, previousSnapshot: progress.previousSnapshot,
    previousSnapshotHash: progress.previousSnapshotHash, checkpointHash: progress.checkpointHash, bindingHash: progress.bindingHash,
    fileIdentity: { ...progress.fileIdentity }, observation: { ...progress.observation }, prefixBytes: progress.after,
    spans: progress.spans, spanChainHash: progress.spanChainHash };
}
export function recoverCatalogSourceIdentity(request: CatalogRequest & CatalogSourceIdentityRequest, access: CatalogSourceRecoveryAccess): Record<string, unknown> {
  const shard = access.shard;
  const directory = join(request.catalogDirectory, "source-identities");
  const path = join(directory, `${hash(JSON.stringify([request.sessionKey, request.targetStoreKey, request.generation, request.shardKey, request.recoveryKey]))}.json`);
  let progress = readProgress(directory, path);
  if (progress) validateProgress(progress, request);
  const currentText = String(shard.snapshot);
  let current: CatalogSourceSnapshot;
  try { current = JSON.parse(currentText) as CatalogSourceSnapshot; } catch { return fail("catalog-source-identity-incompatible"); }
  const published = !!progress && progress.after === legacySnapshot(progress.previousSnapshot).size && current?.schemaVersion === 2
    && JSON.stringify(current.identityReceipt) === JSON.stringify(receipt(progress))
    && sameCatalogFileIdentity(current.fileIdentity, progress.fileIdentity);
  const result = (value: Progress, applied = false): Record<string, unknown> => ({ generation: request.generation, recoveryKey: request.recoveryKey,
    after: value.after, prefixBytes: legacySnapshot(value.previousSnapshot).size, spans: value.spans,
    complete: value.after === legacySnapshot(value.previousSnapshot).size, published: applied });
  if (published) return result(progress!, true);
  if (request.action === "status") {
    if (!progress) return fail("catalog-source-identity-missing");
    return result(progress);
  }
  if (!progress && request.action !== "start") return fail("catalog-source-identity-missing");
  if (hash(currentText) !== request.expectedSnapshotHash || String(shard.checkpointHash) !== request.expectedCheckpointHash
    || hash(String(shard.checkpoint)) !== request.expectedCheckpointHash) return fail("catalog-source-identity-binding-changed");
  const snapshot = legacySnapshot(currentText);
  const checkpoint = JSON.parse(String(shard.checkpoint)) as { byteOffset?: unknown };
  if (checkpoint.byteOffset !== snapshot.size || !integer(Number(shard.committed)) || !integer(Number(shard.observed))
    || Number(shard.committed) > snapshot.size || snapshot.size > Number(shard.observed)) return fail("catalog-source-identity-incompatible");
  const frozenBinding = bindingHash(shard);
  if (progress && progress.bindingHash !== frozenBinding) return fail("catalog-source-identity-binding-changed");
  const source = new CatalogSource(String(shard.path));
  try {
    if (source.size < Number(shard.observed) || source.fileIdentity.kind !== "linux-btrfs-statfs") return fail("catalog-source-identity-incompatible");
    source.verifyLegacyForRecovery(snapshot);
    if (!progress) {
      progress = { version: 1, storeKey: request.targetStoreKey, sessionKey: request.sessionKey, generation: request.generation,
        shardKey: request.shardKey, recoveryKey: request.recoveryKey, previousSnapshot: currentText,
        previousSnapshotHash: request.expectedSnapshotHash, checkpointHash: request.expectedCheckpointHash, bindingHash: frozenBinding,
        fileIdentity: { ...source.fileIdentity }, observation: { ...source.observation }, after: 0, lastOffset: -1, spans: 0,
        spanChainHash: hash(`chrono-catalog-source-identity-spans-v1\0${frozenBinding}\0${request.expectedSnapshotHash}`) };
      source.assertUnchanged(progress.observation);
      writeProgress(request.catalogDirectory, directory, path, progress);
      return result(progress);
    }
    if (!sameCatalogFileIdentity(progress.fileIdentity, source.fileIdentity)) return fail("catalog-source-changed");
    source.assertUnchanged(progress.observation);
    const nextSpans = (limit: number): SqlRow[] => progress!.lastOffset === -1
      ? access.rows("SELECT offset,length,hash FROM spans WHERE g=? AND shard=? ORDER BY offset LIMIT ?", limit, request.generation, request.shardKey, limit)
      : access.rows("SELECT offset,length,hash FROM spans WHERE g=? AND shard=? AND offset>? ORDER BY offset LIMIT ?", limit, request.generation, request.shardKey, progress!.lastOffset, limit);
    if (request.action === "start") return result(progress);
    if (request.action === "step") {
      const rows = nextSpans(96);
      for (const row of rows) {
        const offset = Number(row.offset), length = Number(row.length), sha256 = String(row.hash);
        if (!integer(offset) || offset !== progress.after || !integer(length) || length < 1 || length > 65536
          || length > snapshot.size - offset || !isHash(sha256)) return fail("catalog-source-identity-span-invalid");
        source.verifyRange({ offset, length, sha256 });
        progress.spanChainHash = hash(`${progress.spanChainHash}\0${offset}\0${length}\0${sha256}`);
        progress.after += length; progress.lastOffset = offset; progress.spans++;
      }
      if ((!rows.length && progress.after !== snapshot.size) || (progress.after === snapshot.size && nextSpans(1).length)) return fail("catalog-source-identity-span-invalid");
      source.assertUnchanged(progress.observation);
      writeProgress(request.catalogDirectory, directory, path, progress);
      return result(progress);
    }
    if (progress.after !== snapshot.size) return fail("catalog-source-identity-incomplete");
    if (nextSpans(1).length) return fail("catalog-source-identity-span-invalid");
    // Derive the new anchors from the verified old evidence, not fresh samples.
    const promoted: CatalogSourceSnapshot = { ...source.snapshot(snapshot.size), schemaVersion: 2,
      fileIdentity: { ...source.fileIdentity }, identityReceipt: receipt(progress) };
    source.assertUnchanged(progress.observation);
    access.publish(JSON.stringify(promoted));
    source.assertUnchanged(progress.observation);
    return result(progress, true);
  } finally { access.charge(source.bytesRead); source.close(); }
}
