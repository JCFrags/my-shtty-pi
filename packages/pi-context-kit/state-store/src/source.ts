import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ObjectLocation, SessionEntryView, SourceIdentity, SourcePrefixProof, StateScope, StateSessionManager } from "./types.ts";
import { durableIdentity } from "./identity.ts";
import { currentScope } from "./ancestry.ts";
import { checkDirectory, syncDirectory } from "./objects.ts";
import { canonicalJson, checkSignal, exact, fail, hashText, identifier, integer, isErrno, isHash, sameScope,
  STATE_ANCHOR_TYPE, STATE_STORE_LIMITS, StateStoreError } from "./validation.ts";

export type { SourceIdentity } from "./types.ts";
export interface AnchorProof {
  entry: SessionEntryView;
  lineHash: string;
  offset: number;
  bytes: number;
}
export async function readAtMost(handle: FileHandle, position: number, maximum: number): Promise<Buffer> {
  const buffer = Buffer.alloc(maximum);
  let count = 0;
  while (count < maximum) {
    const value = await handle.read(buffer, count, maximum - count, position + count);
    if (!value.bytesRead) break;
    count += value.bytesRead;
  }
  return buffer.subarray(0, count);
}
function validateSourceFile(info: Stats): void {
  if (!process.getuid || !info.isFile() || info.uid !== process.getuid() || info.nlink !== 1
    || (info.mode & 0o022) !== 0) fail("state-store-unsafe-path");
}
async function openSourceFile(path: string): Promise<FileHandle> {
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4096 || path.includes("\0")) fail("state-store-unsafe-path");
  await checkDirectory(dirname(path), false, false);
  let handle: FileHandle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (isErrno(error, "ENOENT")) fail("state-store-missing");
    if (isErrno(error, "ELOOP")) fail("state-store-unsafe-path");
    throw error;
  }
  try {
    const info = await handle.stat();
    validateSourceFile(info);
    await sourcePathMatches(path, info);
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function sourcePathMatches(path: string, info: Stats): Promise<void> {
  let named: Stats;
  try { named = await lstat(path); }
  catch (error) { if (isErrno(error, "ENOENT")) fail("state-store-scope-changed"); throw error; }
  validateSourceFile(named);
  if (named.dev !== info.dev || named.ino !== info.ino || named.size !== info.size
    || named.mtimeMs !== info.mtimeMs || named.ctimeMs !== info.ctimeMs) fail("state-store-scope-changed");
}
async function unchangedSourceFile(path: string, handle: FileHandle, before: Stats): Promise<void> {
  const after = await handle.stat();
  validateSourceFile(after);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail("state-store-scope-changed");
  await sourcePathMatches(path, after);
}
async function captureFile(file: string, sessionId: string): Promise<SourceIdentity> {
  let handle: FileHandle;
  try { handle = await openSourceFile(file); }
  catch (error) {
    if (error instanceof StateStoreError && error.code === "state-store-missing") return { durability: "deferred", sessionId, file };
    throw error;
  }
  try {
    const info = await handle.stat();
    integer(info.size, 1, Number.MAX_SAFE_INTEGER);
    const identity = await durableIdentity(handle);
    const headerBytes = await readAtMost(handle, 0, Math.min(STATE_STORE_LIMITS.headerBytes, info.size));
    const end = headerBytes.indexOf(10);
    if (end < 0) fail("state-store-corrupt");
    let header: unknown;
    try { header = JSON.parse(headerBytes.subarray(0, end).toString("utf8")); } catch { fail("state-store-corrupt"); }
    if (!header || typeof header !== "object" || (header as Record<string, unknown>).type !== "session"
      || (header as Record<string, unknown>).version !== 3 || (header as Record<string, unknown>).id !== sessionId) fail("state-store-corrupt");
    const last = await readAtMost(handle, info.size - 1, 1);
    if (last[0] !== 10) fail("state-store-corrupt");
    await unchangedSourceFile(file, handle, info);
    return { durability: "disk", sessionId, file, device: String(info.dev), inode: String(info.ino),
      size: info.size, headerHash: hashText(headerBytes.subarray(0, end + 1)), ...(identity ? { identity } : {}) };
  } finally { await handle.close(); }
}
export async function captureSource(manager: StateSessionManager): Promise<SourceIdentity> {
  const view = currentScope(manager);
  const file = manager.getSessionFile();
  const result = file ? await captureFile(file, view.sessionId) : { durability: "ephemeral" as const, sessionId: view.sessionId };
  if (!sameScope(view, currentScope(manager)) || manager.getSessionFile() !== file) fail("state-store-scope-changed");
  return result;
}
export function validateSource(value: unknown): asserts value is SourceIdentity {
  if (!value || typeof value !== "object") fail("state-store-corrupt");
  const item = value as Record<string, unknown>;
  if (item.durability === "ephemeral") exact(value, ["durability", "sessionId"]);
  else if (item.durability === "deferred") exact(value, ["durability", "sessionId", "file"]);
  else if (item.durability === "disk") {
    exact(value, ["durability", "sessionId", "file", "device", "inode", "size", "headerHash"], ["identity"]);
    if (item.identity !== undefined) {
      exact(item.identity, ["scheme", "filesystemId", "birthtimeNs"]);
      if (item.identity.scheme !== "linux-btrfs-statfs-v1" || typeof item.identity.filesystemId !== "string"
        || !/^[a-f0-9]{1,16}$/.test(item.identity.filesystemId) || /^0+$/.test(item.identity.filesystemId)
        || typeof item.identity.birthtimeNs !== "string" || !/^[1-9][0-9]{0,29}$/.test(item.identity.birthtimeNs)) fail("state-store-corrupt");
    }
    if (typeof item.device !== "string" || !/^\d+$/.test(item.device) || typeof item.inode !== "string" || !/^\d+$/.test(item.inode)
      || !isHash(item.headerHash)) fail("state-store-corrupt");
    integer(item.size, 1, Number.MAX_SAFE_INTEGER);
  } else fail("state-store-corrupt");
  identifier(item.sessionId);
  if (item.durability !== "ephemeral" && (typeof item.file !== "string" || !item.file.startsWith("/")
    || item.file.length > 4096 || item.file.includes("\0"))) fail("state-store-corrupt");
}
export function sameSource(left: SourceIdentity, right: SourceIdentity, exactSize = false): boolean {
  if (left.durability !== right.durability || left.sessionId !== right.sessionId) return false;
  if (left.durability === "ephemeral" || right.durability === "ephemeral") return true;
  if (left.file !== right.file) return false;
  return left.durability !== "disk" || right.durability !== "disk" || (left.device === right.device
    && sameSourceFields(left, right) && (!left.identity && !right.identity || sameDurableSource(left, right))
    && (!exactSize || left.size === right.size));
}
/** Durable comparison is separate from same-open checks, which always retain st_dev. */
export function sameSourceFields(left: SourceIdentity, right: SourceIdentity): boolean {
  return left.durability === "disk" && right.durability === "disk" && left.sessionId === right.sessionId
    && left.file === right.file && left.inode === right.inode && left.headerHash === right.headerHash;
}
export function sameDurableSource(left: SourceIdentity, right: SourceIdentity): boolean {
  return sameSourceFields(left, right) && left.durability === "disk" && right.durability === "disk"
    && !!left.identity && !!right.identity && left.identity.scheme === right.identity.scheme
    && left.identity.filesystemId === right.identity.filesystemId && left.identity.birthtimeNs === right.identity.birthtimeNs;
}
export function sourceKey(source: SourceIdentity): string {
  // Keep historical keys for unsupported sources. Btrfs derived indexes survive a device-only restart.
  const value = source.durability === "disk" ? { ...source, size: 0, ...(source.identity ? { device: "0" } : {}) } : source;
  return hashText(canonicalJson(value, STATE_STORE_LIMITS.recordBytes));
}
export function anchorDataMatches(entry: SessionEntryView, data: unknown): boolean {
  return entry.type === "custom" && entry.customType === STATE_ANCHOR_TYPE
    && canonicalJson(entry.data, STATE_STORE_LIMITS.anchorBytes) === canonicalJson(data, STATE_STORE_LIMITS.anchorBytes);
}
/** Read only the one bounded append at the captured byte cut, then sync the existing Pi file. */
export async function verifyDiskAnchor(source: SourceIdentity, origin: StateScope, data: unknown,
  live?: SessionEntryView): Promise<AnchorProof> {
  if (source.durability !== "disk") fail("state-store-unpersisted", source.durability);
  const handle = await openSourceFile(source.file);
  try {
    const info = await handle.stat();
    if (String(info.dev) !== source.device || String(info.ino) !== source.inode || info.size <= source.size) fail("state-store-uncertain");
    const header = await readAtMost(handle, 0, Math.min(info.size, STATE_STORE_LIMITS.headerBytes));
    const headerEnd = header.indexOf(10);
    if (headerEnd < 0 || hashText(header.subarray(0, headerEnd + 1)) !== source.headerHash) fail("state-store-uncertain");
    const bytes = await readAtMost(handle, source.size, Math.min(info.size - source.size, STATE_STORE_LIMITS.anchorBytes));
    const end = bytes.indexOf(10);
    if (end < 0) fail("state-store-uncertain");
    let entry: SessionEntryView;
    try { entry = JSON.parse(bytes.subarray(0, end).toString("utf8")) as SessionEntryView; }
    catch { fail("state-store-uncertain"); }
    identifier(entry.id);
    if (entry.parentId !== origin.leafId || !anchorDataMatches(entry, data)
      || live && canonicalJson(entry, STATE_STORE_LIMITS.anchorBytes) !== canonicalJson(live, STATE_STORE_LIMITS.anchorBytes)) fail("state-store-uncertain");
    await handle.sync();
    // Pi does not sync newly created source directories. Preserve their names as well as the append.
    for (let directory = dirname(source.file);; directory = dirname(directory)) {
      await syncDirectory(directory);
      if (directory === dirname(directory)) break;
    }
    await unchangedSourceFile(source.file, handle, info);
    return { entry, lineHash: hashText(bytes.subarray(0, end + 1)), offset: source.size, bytes: end + 1 };
  } finally { await handle.close(); }
}
/** Verify a retained immutable receipt against the exact bounded source line. No writes or sync. */
export async function verifyStoredAnchor(source: SourceIdentity, proof: Omit<AnchorProof, "entry">,
  expected: SessionEntryView, live: SessionEntryView): Promise<void> {
  if (source.durability !== "disk") fail("state-store-source-changed");
  integer(proof.offset, 1, Number.MAX_SAFE_INTEGER);
  integer(proof.bytes, 1, STATE_STORE_LIMITS.anchorBytes);
  if (!isHash(proof.lineHash) || !Number.isSafeInteger(proof.offset + proof.bytes)
    || proof.offset + proof.bytes > source.size) fail("state-store-source-changed");
  const handle = await openSourceFile(source.file);
  try {
    const before = await handle.stat();
    if (String(before.dev) !== source.device || String(before.ino) !== source.inode || before.size !== source.size) fail("state-store-scope-changed");
    const bytes = await readAtMost(handle, proof.offset, proof.bytes);
    const boundary = await readAtMost(handle, proof.offset - 1, 1);
    if (boundary[0] !== 10 || bytes.length !== proof.bytes || bytes.indexOf(10) !== bytes.length - 1
      || hashText(bytes) !== proof.lineHash) fail("state-store-corrupt");
    let entry: unknown;
    try { entry = JSON.parse(bytes.toString("utf8")); } catch { fail("state-store-corrupt"); }
    const encoded = canonicalJson(entry, STATE_STORE_LIMITS.anchorBytes);
    if (encoded !== canonicalJson(expected, STATE_STORE_LIMITS.anchorBytes)
      || encoded !== canonicalJson(live, STATE_STORE_LIMITS.anchorBytes)) fail("state-store-corrupt");
    await unchangedSourceFile(source.file, handle, before);
  } finally { await handle.close(); }
}
/** One explicit recovery reads at most recoveryPrefixBytes, in bounded streaming chunks. */
export async function verifySourcePrefix(source: SourceIdentity, proof: SourcePrefixProof, signal?: AbortSignal): Promise<void> {
  exact(proof, ["bytes", "sha256"]);
  integer(proof.bytes, 1, STATE_STORE_LIMITS.recoveryPrefixBytes);
  if (!isHash(proof.sha256)) fail("state-store-invalid");
  if (source.durability !== "disk" || proof.bytes > source.size) fail("state-store-source-changed");
  checkSignal(signal);
  const handle = await openSourceFile(source.file);
  try {
    const before = await handle.stat();
    if (String(before.dev) !== source.device || String(before.ino) !== source.inode || before.size !== source.size) fail("state-store-scope-changed");
    const digest = createHash("sha256");
    for (let offset = 0; offset < proof.bytes;) {
      checkSignal(signal);
      const bytes = await readAtMost(handle, offset, Math.min(64 * 1024, proof.bytes - offset));
      if (!bytes.length) fail("state-store-source-changed");
      digest.update(bytes); offset += bytes.length;
    }
    const boundary = await readAtMost(handle, proof.bytes - 1, 1);
    if (boundary[0] !== 10 || digest.digest("hex") !== proof.sha256) fail("state-store-source-changed");
    await unchangedSourceFile(source.file, handle, before);
    checkSignal(signal);
  } finally { await handle.close(); }
}
export async function acquireSourceLock(location: ObjectLocation, source: SourceIdentity, operationId: string): Promise<() => Promise<void>> {
  const directory = join(location.root, "locks");
  await checkDirectory(directory);
  const name = hashText(source.durability === "ephemeral" ? source.sessionId : source.file);
  const path = join(directory, `${name}.lock`);
  let handle: FileHandle;
  try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (isErrno(error, "EEXIST")) fail("state-store-busy"); throw error; }
  const identity = await handle.stat();
  try { await handle.writeFile(canonicalJson({ version: 1, pid: process.pid, operationId }, STATE_STORE_LIMITS.recordBytes)); await handle.sync(); }
  finally { await handle.close(); }
  return async () => {
    const current = await lstat(path);
    if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) fail("state-store-unsafe-path");
    await unlink(path);
  };
}
