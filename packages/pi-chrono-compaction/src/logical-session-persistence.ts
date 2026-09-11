import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { LOGICAL_SESSION_LIMITS } from "./logical-session-contract.js";

const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const MAX_BOOTSTRAP_ENTRIES = 8;
const MAX_BOOTSTRAP_BYTES = LOGICAL_SESSION_LIMITS.continuationBytes * 2;

export interface PiBootstrapSessionManager {
  isPersisted(): boolean;
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getSessionDir(): string;
  getCwd(): string;
  getHeader(): unknown;
  getEntries(): unknown[];
  setSessionFile(path: string): void;
}

async function verifyExistingSource(path: string, expected: Buffer): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => fail("logical-session-source-persistence-invalid"));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600
      || info.size !== expected.length) fail("logical-session-source-persistence-invalid");
    const actual = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(actual, 0, actual.length, 0);
    if (bytesRead !== info.size || !actual.subarray(0, bytesRead).equals(expected)) fail("logical-session-source-persistence-invalid");
  } finally { await file.close(); }
}

/** Persist only a fresh Pi replacement's exact header and continuation-only bootstrap entries. */
export async function persistNewShardBootstrap(manager: PiBootstrapSessionManager, expectedParentSession: string,
  continuationEntryId: string): Promise<void> {
  const sourcePath = manager.getSessionFile(), sessionDirectory = manager.getSessionDir();
  if (!manager.isPersisted() || !sourcePath || !isAbsolute(sourcePath) || resolve(sourcePath) !== sourcePath
    || !isAbsolute(sessionDirectory) || resolve(sessionDirectory) !== sessionDirectory || dirname(sourcePath) !== sessionDirectory
    || !sourcePath.endsWith(".jsonl") || !isAbsolute(expectedParentSession) || resolve(expectedParentSession) !== expectedParentSession
    || !continuationEntryId) {
    return fail("logical-session-source-persistence-invalid");
  }
  const directory = await lstat(sessionDirectory).catch(() => fail("logical-session-source-persistence-invalid"));
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.()
    || (directory.mode & 0o022) !== 0 || await realpath(sessionDirectory) !== sessionDirectory) {
    return fail("logical-session-source-persistence-invalid");
  }
  const header = manager.getHeader(), entries = manager.getEntries();
  if (!object(header) || header.type !== "session" || header.version !== 3 || header.id !== manager.getSessionId()
    || header.cwd !== manager.getCwd() || header.parentSession !== expectedParentSession
    || entries.length < 1 || entries.length > MAX_BOOTSTRAP_ENTRIES) {
    return fail("logical-session-source-persistence-invalid");
  }
  const seen = new Set<string>();
  let parentId: string | null = null, continuationCount = 0;
  for (const value of entries) {
    if (!object(value) || typeof value.id !== "string" || value.id.length < 1 || value.id.length > 128 || seen.has(value.id)
      || value.parentId !== parentId) return fail("logical-session-source-persistence-invalid");
    seen.add(value.id);
    parentId = value.id;
    if (value.type === "custom_message" && value.customType === "chrono-logical-continuation") {
      continuationCount += 1;
      if (value.id !== continuationEntryId) return fail("logical-session-source-persistence-invalid");
    } else if (!["model_change", "thinking_level_change", "session_info"].includes(String(value.type))) {
      return fail("logical-session-source-persistence-invalid");
    }
  }
  if (continuationCount !== 1 || parentId !== continuationEntryId) return fail("logical-session-source-persistence-invalid");
  const continuation = entries.at(-1) as Record<string, unknown>;
  if (typeof continuation.content !== "string" || Buffer.byteLength(continuation.content) > LOGICAL_SESSION_LIMITS.continuationBytes) {
    return fail("logical-session-source-persistence-invalid");
  }
  let lines: string[], serializedBytes = 0;
  try {
    lines = [header, ...entries].map(value => JSON.stringify(value));
    for (const line of lines) {
      serializedBytes += Buffer.byteLength(line) + 1;
      if (serializedBytes > MAX_BOOTSTRAP_BYTES) return fail("logical-session-source-persistence-invalid");
    }
  } catch { return fail("logical-session-source-persistence-invalid"); }
  const serialized = Buffer.from(`${lines.join("\n")}\n`);

  const temporary = join(sessionDirectory, `.chrono-logical-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    .catch(() => fail("logical-session-source-persistence-invalid"));
  try {
    await file.writeFile(serialized);
    await file.sync();
  } finally { await file.close(); }
  try {
    try { await link(temporary, sourcePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return fail("logical-session-source-persistence-invalid");
      await verifyExistingSource(sourcePath, serialized);
    }
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    await verifyExistingSource(sourcePath, serialized);
    const parent = await open(sessionDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
    manager.setSessionFile(sourcePath);
    const reloadedHeader = manager.getHeader(), reloadedEntries = manager.getEntries();
    let reloaded: Buffer;
    try { reloaded = Buffer.from([reloadedHeader, ...reloadedEntries].map(value => JSON.stringify(value)).join("\n") + "\n"); }
    catch { return fail("logical-session-source-persistence-invalid"); }
    if (manager.getSessionId() !== header.id || !reloaded.equals(serialized)) return fail("logical-session-source-persistence-invalid");
  } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
}
