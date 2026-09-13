import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import type { ObjectLocation, ObjectOptions, ObjectRef, ObjectStoreOptions, StateProviderId } from "./types.ts";
import { canonicalJson, checkSignal, exact, fail, hashText, integer, isErrno, isStoreId,
  objectRef, providerId, STATE_STORE_LIMITS, StateStoreError } from "./validation.ts";

export function defaultStoreRoot(provider: StateProviderId): string {
  providerId(provider);
  const configured = process.env.XDG_STATE_HOME;
  if (configured && !isAbsolute(configured)) fail("state-store-unsafe-path");
  return join(configured || join(homedir(), ".local", "state"), "pi-context-kit", provider);
}
function absolutePath(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4096 || path.includes("\0")) fail("state-store-unsafe-path");
}
function uid(): number {
  if (!process.getuid) fail("state-store-unsafe-path");
  return process.getuid();
}
/** Observed no-follow path checks. Same-UID path replacement is not a sandbox boundary. */
export async function checkDirectory(path: string, create = false, privateLeaf = true): Promise<void> {
  absolutePath(path);
  const owner = uid();
  let part = parse(path).root;
  for (const component of path.slice(part.length).split("/").filter(Boolean)) {
    part = join(part, component);
    let info, created = false;
    try { info = await lstat(part); }
    catch (error) {
      if (!create || !isErrno(error, "ENOENT")) fail("state-store-unsafe-path");
      try { await mkdir(part, { mode: 0o700 }); created = true; }
      catch (creationError) { if (!isErrno(creationError, "EEXIST")) throw creationError; }
      info = await lstat(part);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || (info.uid !== owner && info.uid !== 0)
      || ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000) !== 0))) fail("state-store-unsafe-path");
    if (part === path && privateLeaf && (info.uid !== owner || (info.mode & 0o777) !== 0o700)) fail("state-store-unsafe-path");
    if (created) await syncDirectory(dirname(part));
  }
}
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
export function validatePrivateFile(info: Stats): void {
  if (!info.isFile() || info.uid !== uid() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) fail("state-store-unsafe-path");
}
export async function openPrivateFile(path: string): Promise<FileHandle> {
  absolutePath(path);
  await checkDirectory(dirname(path), false, false);
  let handle: FileHandle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (isErrno(error, "ENOENT")) fail("state-store-missing");
    if (isErrno(error, "ELOOP")) fail("state-store-unsafe-path");
    throw error;
  }
  try { validatePrivateFile(await handle.stat()); return handle; }
  catch (error) { await handle.close(); throw error; }
}
export async function readPrivateBytes(path: string, maxBytes: number): Promise<Buffer> {
  integer(maxBytes, 1, STATE_STORE_LIMITS.objectBytes);
  const handle = await openPrivateFile(path);
  try {
    const before = await handle.stat();
    if (before.size < 1 || before.size > maxBytes) fail(before.size ? "state-store-budget" : "state-store-corrupt");
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    validatePrivateFile(after);
    if (offset !== before.size || before.size !== after.size || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) fail("state-store-corrupt");
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}
export async function readPrivateRecord<T>(path: string, maxBytes = STATE_STORE_LIMITS.recordBytes): Promise<T | undefined> {
  try { return JSON.parse((await readPrivateBytes(path, maxBytes)).toString("utf8")) as T; }
  catch (error) {
    if (error instanceof StateStoreError && error.code === "state-store-missing") return undefined;
    if (error instanceof SyntaxError) fail("state-store-corrupt");
    throw error;
  }
}
/** The temporary file belongs to this call. Existing immutable targets are never overwritten. */
export async function publishPrivateBytes(path: string, bytes: Buffer, compareExisting = true): Promise<void> {
  await checkDirectory(dirname(path));
  const temporary = join(dirname(path), `.publish-${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  try {
    try { await link(temporary, path); }
    catch (error) { if (!isErrno(error, "EEXIST")) throw error; }
    await unlink(temporary);
    const actual = await readPrivateBytes(path, Math.max(bytes.length, STATE_STORE_LIMITS.recordBytes));
    if (compareExisting && !actual.equals(bytes)) fail("state-store-corrupt");
    await syncDirectory(dirname(path));
  } finally {
    await unlink(temporary).catch(error => { if (!isErrno(error, "ENOENT")) throw error; });
  }
}
/** Replace a bounded derived index, never an immutable object or a Pi source. */
export async function writePrivateRecord(path: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(canonicalJson(value, STATE_STORE_LIMITS.recordBytes));
  await checkDirectory(dirname(path));
  try {
    const previous = await openPrivateFile(path);
    await previous.close();
  } catch (error) { if (!(error instanceof StateStoreError) || error.code !== "state-store-missing") throw error; }
  const temporary = join(dirname(path), `.index-${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path); await syncDirectory(dirname(path)); }
  finally { await unlink(temporary).catch(error => { if (!isErrno(error, "ENOENT")) throw error; }); }
}
export async function openObjectLocation(options: ObjectStoreOptions): Promise<ObjectLocation> {
  providerId(options.providerId);
  const root = options.storeRoot ?? defaultStoreRoot(options.providerId);
  absolutePath(root);
  await checkDirectory(root, true);
  const metadataPath = join(root, "store.json");
  let metadata = await readPrivateRecord<unknown>(metadataPath);
  if (metadata === undefined) {
    const directory = await opendir(root);
    let first;
    try { first = await directory.read(); } finally { await directory.close(); }
    if (first) fail("state-store-corrupt");
    const value = { version: 1, providerId: options.providerId, storeId: randomUUID() };
    await publishPrivateBytes(metadataPath, Buffer.from(canonicalJson(value, STATE_STORE_LIMITS.recordBytes)), false);
    metadata = await readPrivateRecord(metadataPath);
  }
  exact(metadata, ["version", "providerId", "storeId"]);
  if (metadata.version !== 1 || metadata.providerId !== options.providerId || !isStoreId(metadata.storeId)) fail("state-store-corrupt");
  for (const name of ["objects", "bindings", "resolutions", "commits", "imports", "locks"]) await checkDirectory(join(root, name), true);
  await syncDirectory(root);
  return Object.freeze({ root, providerId: options.providerId, storeId: metadata.storeId });
}
function belongs(location: ObjectLocation, ref: ObjectRef): void {
  objectRef(ref);
  if (ref.providerId !== location.providerId || ref.storeId !== location.storeId) fail("state-store-corrupt");
}
export async function publishObject<T>(location: ObjectLocation, value: T, options: ObjectOptions<T> = {}): Promise<ObjectRef> {
  checkSignal(options.signal);
  const maxBytes = options.maxBytes ?? STATE_STORE_LIMITS.objectBytes;
  integer(maxBytes, 1, STATE_STORE_LIMITS.objectBytes);
  // Detach before the provider validator, so an accessor or mutation cannot alter published bytes.
  const detached = JSON.parse(canonicalJson(value, maxBytes)) as T;
  options.validate?.(detached);
  const bytes = Buffer.from(canonicalJson({ version: 1, providerId: location.providerId, storeId: location.storeId, value: detached }, maxBytes));
  const ref: ObjectRef = { version: 1, providerId: location.providerId, storeId: location.storeId, hash: hashText(bytes), bytes: bytes.length };
  checkSignal(options.signal);
  await publishPrivateBytes(join(location.root, "objects", `${ref.hash}.json`), bytes);
  checkSignal(options.signal);
  return Object.freeze(ref);
}
export async function readObject<T>(location: ObjectLocation, ref: ObjectRef, options: ObjectOptions<T> = {}): Promise<T> {
  checkSignal(options.signal);
  belongs(location, ref);
  const maximum = options.maxBytes ?? STATE_STORE_LIMITS.objectBytes;
  integer(maximum, 1, STATE_STORE_LIMITS.objectBytes);
  if (ref.bytes > maximum) fail("state-store-budget");
  const bytes = await readPrivateBytes(join(location.root, "objects", `${ref.hash}.json`), ref.bytes);
  if (bytes.length !== ref.bytes || hashText(bytes) !== ref.hash) fail("state-store-corrupt");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { fail("state-store-corrupt"); }
  exact(value, ["version", "providerId", "storeId", "value"]);
  if (value.version !== 1 || value.providerId !== location.providerId || value.storeId !== location.storeId) fail("state-store-corrupt");
  canonicalJson(value, maximum);
  options.validate?.(value.value as T);
  checkSignal(options.signal);
  return value.value as T;
}
export class OwnedObjectStore {
  readonly options: ObjectStoreOptions;
  private opening?: Promise<ObjectLocation>;
  constructor(options: ObjectStoreOptions) {
    providerId(options.providerId);
    if (options.objectMaxBytes !== undefined) integer(options.objectMaxBytes, 1, STATE_STORE_LIMITS.objectBytes);
    this.options = { ...options };
  }
  location(): Promise<ObjectLocation> {
    return this.opening ??= openObjectLocation(this.options);
  }
  async publish<T>(value: T, options: ObjectOptions<T> = {}): Promise<ObjectRef> {
    return publishObject(await this.location(), value, { maxBytes: this.options.objectMaxBytes, ...options });
  }
  async read<T>(ref: ObjectRef, options: ObjectOptions<T> = {}): Promise<T> {
    return readObject(await this.location(), ref, { maxBytes: this.options.objectMaxBytes, ...options });
  }
}
