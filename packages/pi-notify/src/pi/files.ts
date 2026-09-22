import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
export function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).filter(([, child]) => child !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sort(child)]));
    return item;
  };
  return JSON.stringify(sort(value));
}
export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function fail(code: string): never { throw new Error(code); }

export function privateDirectory(path: string, create = false): void {
  if (!isAbsolute(path) || resolve(path) !== path) fail("notify_storage_path_invalid");
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  let current = "/";
  for (const part of path.split("/").filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, process.getuid?.()].includes(stat.uid)
      || ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000)))) fail("notify_storage_unsafe");
  }
  const stat = lstatSync(path);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) fail("notify_storage_unsafe");
}

/** Read only an owned regular file, never a link. Tokens use this same admission. */
export function readPrivate(path: string, maxBytes = 1024 * 1024): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) fail("notify_private_file_unsafe");
    const text = readFileSync(fd, "utf8");
    if (Buffer.byteLength(text) > maxBytes) fail("notify_private_file_too_large");
    return text;
  } finally { closeSync(fd); }
}

export function writePrivate(path: string, value: unknown): void {
  privateDirectory(dirname(path), true);
  const temporary = join(dirname(path), `.notify-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  try {
    renameSync(temporary, path);
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}

export function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readPrivate(path)) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export function listJson(directory: string, max = 256): string[] {
  try { privateDirectory(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const files = readdirSync(directory).filter(name => name.endsWith(".json"));
  if (files.length > max) fail("notify_binding_limit");
  return files.map(name => join(directory, name));
}

/** Verify an exact Pi anchor on disk before acknowledging delivery. message_end
 * occurs before persistence in Pi 0.85.1. This reader retains only one bounded
 * JSONL line and has no whole-session size limit. It never writes a Pi session. */
export function syncSessionAnchor(path: string, sessionId: string, expected: Record<string, unknown>): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1) fail("notify_session_file_unsafe");
    const chunk = Buffer.alloc(64 * 1024);
    const maxLine = 2 * 1024 * 1024;
    let line = Buffer.alloc(0), oversized = false, header = false, found = false, offset = 0;
    const consume = (): void => {
      if (oversized) { oversized = false; line = Buffer.alloc(0); return; }
      let value: unknown;
      try { value = JSON.parse(line.toString("utf8")); } catch { fail("notify_session_record_invalid"); }
      line = Buffer.alloc(0);
      if (!header) {
        if (!object(value) || value.type !== "session" || value.id !== sessionId) fail("notify_session_identity_mismatch");
        header = true;
      } else if (object(value) && value.id === expected.id) {
        if (canonical(value) !== canonical(expected)) fail("notify_session_anchor_mismatch");
        found = true;
      }
    };
    while (offset < stat.size) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
      if (!count) fail("notify_session_read_incomplete");
      offset += count;
      let from = 0;
      for (let index = 0; index < count; index++) {
        if (chunk[index] !== 10) continue;
        if (!oversized) {
          if (line.length + index - from > maxLine) oversized = true;
          else line = Buffer.concat([line, chunk.subarray(from, index)]);
        }
        consume(); from = index + 1;
      }
      if (!oversized) {
        if (line.length + count - from > maxLine) { oversized = true; line = Buffer.alloc(0); }
        else line = Buffer.concat([line, chunk.subarray(from, count)]);
      }
    }
    if (!header || !found || line.length || oversized) fail("notify_session_anchor_not_durable");
    fsyncSync(fd);
    const current = lstatSync(path);
    if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino) fail("notify_session_file_replaced");
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { closeSync(fd); }
}
