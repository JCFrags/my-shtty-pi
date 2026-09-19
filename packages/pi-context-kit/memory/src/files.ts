import { constants, closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, linkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ANCHOR_TYPE, canonical, fail, LIMITS, sha } from "./contracts.ts";

export function privateDirectory(path: string, create = false): void {
  if (!isAbsolute(path) || resolve(path) !== path || path === "/" || typeof process.getuid !== "function") fail("storage-unsafe");
  const parts = path.split("/").filter(Boolean);
  if (parts.length > 64) fail("storage-unsafe");
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    let st;
    try { st = lstatSync(current); }
    catch (error) {
      if (!create || (error as any).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 }); syncDirectory(dirname(current)); st = lstatSync(current);
    }
    if (!st.isDirectory() || st.isSymbolicLink() || ![0, process.getuid()].includes(st.uid)
      || (st.mode & 0o022) !== 0 && !(st.uid === 0 && (st.mode & 0o1000))) fail("storage-unsafe");
  }
  const final = lstatSync(path);
  if (final.uid !== process.getuid() || (final.mode & 0o7777) !== 0o700) fail("storage-unsafe");
}
export function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function privateFile(path: string, missing = false): boolean {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o7777) !== 0o600) fail("storage-unsafe");
    return true;
  } catch (error) { if (missing && (error as any).code === "ENOENT") return false; throw error; }
}
export function readPrivateJson(path: string): any | undefined {
  if (!privateFile(path, true)) return undefined;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (st.size > 8192) fail("binding-invalid");
    const bytes = Buffer.alloc(st.size + 1), size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size !== st.size) fail("binding-invalid");
    try { return JSON.parse(bytes.subarray(0, size).toString("utf8")); } catch { return fail("binding-invalid"); }
  } finally { closeSync(fd); }
}
export function atomicJson(path: string, value: unknown): void {
  privateDirectory(dirname(path)); privateFile(path, true);
  const temp = join(dirname(path), `.prepared-${randomUUID()}.json`);
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(temp, path); } finally { unlinkSync(temp); }
  const dir = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
export interface SourceTicket { path: string; dev: string; ino: string; offset: number; prefixOffset: number; prefixHash: string }
export interface Anchor { version: 1; namespaceId: string; storeId: string; operationId: string; storeRevision: number; payloadHash: string }
export function sourceTicket(path: string): SourceTicket {
  if (resolve(path) !== path) fail("session-unpersisted");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || !Number.isSafeInteger(st.size)) fail("session-unsafe");
    const offset = st.size, prefixOffset = Math.max(0, offset - 256), bytes = Buffer.alloc(offset - prefixOffset);
    if (readSync(fd, bytes, 0, bytes.length, prefixOffset) !== bytes.length || bytes.at(-1) !== 10) fail("session-unpersisted");
    return { path, dev: String(st.dev), ino: String(st.ino), offset, prefixOffset, prefixHash: sha(bytes) };
  } finally { closeSync(fd); }
}
/** Verify a small append range, never walk the session or accept in-memory message_end as persistence. */
export function verifyAnchor(ticket: SourceTicket, anchor: Anchor): { entryId: string; digest: string } | undefined {
  const fd = openSync(ticket.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || String(st.dev) !== ticket.dev || String(st.ino) !== ticket.ino || st.size < ticket.offset) fail("anchor-source-changed");
    const prefix = Buffer.alloc(ticket.offset - ticket.prefixOffset);
    if (prefix.length > 256 || readSync(fd, prefix, 0, prefix.length, ticket.prefixOffset) !== prefix.length || sha(prefix) !== ticket.prefixHash) fail("anchor-source-changed");
    const bytes = Buffer.alloc(Math.min(LIMITS.anchorBytes, st.size - ticket.offset));
    const size = readSync(fd, bytes, 0, bytes.length, ticket.offset);
    const lines = bytes.subarray(0, size).toString("utf8").split("\n");
    for (const line of lines.slice(0, -1)) {
      let entry: any; try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type === "custom" && entry.customType === ANCHOR_TYPE && entry.data?.operationId === anchor.operationId) {
        if (typeof entry.id !== "string" || canonical(entry.data) !== canonical(anchor)) fail("anchor-invalid");
        fsyncSync(fd);
        return { entryId: entry.id, digest: sha(line) };
      }
    }
    if (st.size - ticket.offset > LIMITS.anchorBytes) fail("anchor-scan-limit");
    return undefined;
  } finally { closeSync(fd); }
}
export function processIdentity(pid = process.pid): string | undefined {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(")").slice(1).join(")").trim().split(/\s+/)[19]; }
  catch (error) { if (["ENOENT", "ESRCH"].includes((error as any).code)) return undefined; return fail("owner-unverifiable"); }
}
