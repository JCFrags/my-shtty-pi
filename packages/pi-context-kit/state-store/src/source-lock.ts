import { spawn } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, open, readFile, readlink, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { checkDirectory, syncDirectory, validatePrivateFile } from "./objects.ts";
import type { ObjectLocation, SourceIdentity } from "./types.ts";
import { canonicalJson, checkSignal, fail, hashText, isErrno, STATE_STORE_LIMITS } from "./validation.ts";

type ProcessIdentity = { hostId: string; bootId: string; pidNamespace: string; startTime: string };
type LockOwner = { version: 1 | 2; pid: number; operationId: string } & Partial<ProcessIdentity>;
const WAIT_MS = 2000;

async function processStart(pid: number): Promise<string> {
  const text = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  const start = fields[19]; // Field 22, after pid and the parenthesized process name.
  if (!start || !/^\d+$/.test(start)) fail("state-store-identity-unavailable");
  return start;
}
async function localIdentity(): Promise<ProcessIdentity | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const host = (await readFile("/etc/machine-id", "utf8")).trim();
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const pidNamespace = await readlink("/proc/self/ns/pid");
    if (!/^[a-f0-9]{32}$/.test(host) || !/^[a-f0-9-]{36}$/.test(bootId)) return undefined;
    return { hostId: hashText(host), bootId, pidNamespace, startTime: await processStart(process.pid) };
  } catch { return undefined; }
}
function ownerRecord(bytes: Buffer): LockOwner | undefined {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    const fields = ["version", "pid", "operationId", ...(value.version === 2 ? ["hostId", "bootId", "pidNamespace", "startTime"] : [])];
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length
      || fields.some(field => !Object.hasOwn(value, field)) || ![1, 2].includes(value.version)
      || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.operationId !== "string" || !value.operationId || value.operationId.length > 128) return undefined;
    if (value.version === 2 && (typeof value.hostId !== "string" || !/^[a-f0-9]{64}$/.test(value.hostId)
      || typeof value.bootId !== "string" || !/^[a-f0-9-]{36}$/.test(value.bootId)
      || typeof value.pidNamespace !== "string" || !/^pid:\[\d+\]$/.test(value.pidNamespace)
      || typeof value.startTime !== "string" || !/^\d+$/.test(value.startTime))) return undefined;
    return value;
  } catch { return undefined; }
}
async function deadOwner(owner: LockOwner, local: ProcessIdentity): Promise<boolean> {
  if (owner.version === 2) {
    if (owner.hostId !== local.hostId) return false;
    if (owner.bootId !== local.bootId) return true;
    if (owner.pidNamespace !== local.pidNamespace) return false;
  }
  try {
    const start = await processStart(owner.pid);
    // A live PID in a v1 record is ambiguous. Only v2 can prove PID reuse.
    return owner.version === 2 && start !== owner.startTime;
  } catch (error) {
    if (!isErrno(error, "ENOENT")) return false;
    // v1 admission assumes this private store belongs to this host/PID namespace.
    try { process.kill(owner.pid, 0); return false; }
    catch (probe) { return isErrno(probe, "ESRCH"); }
  }
}
function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
async function namedFile(path: string, handle: FileHandle): Promise<Stats> {
  const info = await handle.stat(), named = await lstat(path);
  validatePrivateFile(info); validatePrivateFile(named);
  if (!sameFile(info, named)) fail("state-store-unsafe-path");
  return info;
}
async function lockBytes(handle: FileHandle): Promise<Buffer> {
  const before = await handle.stat(); validatePrivateFile(before);
  if (before.size < 1 || before.size > STATE_STORE_LIMITS.recordBytes) fail("state-store-busy");
  const bytes = Buffer.alloc(before.size + 1);
  let count = 0;
  while (count < bytes.length) {
    const part = await handle.read(bytes, count, bytes.length - count, count);
    if (!part.bytesRead) break;
    count += part.bytesRead;
  }
  if (count !== before.size || !sameFile(before, await handle.stat())) fail("state-store-busy");
  return bytes.subarray(0, count);
}
async function kernelLock(handle: FileHandle, deadline: number, signal?: AbortSignal): Promise<void> {
  checkSignal(signal);
  const seconds = Math.max(0.001, (deadline - Date.now()) / 1000);
  await new Promise<void>((resolve, reject) => {
    // FD 3 shares the parent's open-file description. The parent retains flock after child exit.
    const child = spawn("flock", ["--exclusive", "--timeout", String(seconds), "3"], { stdio: ["ignore", "ignore", "ignore", handle.fd] });
    const abort = () => { child.kill("SIGKILL"); };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
    child.once("error", () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new Error("flock unavailable")); });
    child.once("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (signal?.aborted) { try { checkSignal(signal); } catch (error) { reject(error); } }
      else if (code === 0) resolve();
      else { try { fail(code === 1 || code === null ? "state-store-busy" : "state-store-identity-unavailable"); } catch (error) { reject(error); } }
    });
    if (signal?.aborted) abort();
  }).catch(error => { if (error.message === "flock unavailable") fail("state-store-identity-unavailable"); throw error; });
}
async function retireDeadLock(path: string, local: ProcessIdentity, signal?: AbortSignal): Promise<boolean> {
  let handle: FileHandle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (isErrno(error, "ENOENT")) return true; if (isErrno(error, "ELOOP")) fail("state-store-unsafe-path"); throw error; }
  try {
    const identity = await namedFile(path, handle);
    let bytes: Buffer;
    try { bytes = await lockBytes(handle); } catch (error) { if (isErrno(error, "state-store-busy")) return false; throw error; }
    const owner = ownerRecord(bytes);
    if (!owner || !await deadOwner(owner, local)) return false;
    checkSignal(signal);
    // The stable guard serializes new cleaners. An old dead owner cannot release this inode.
    if (!sameFile(identity, await namedFile(path, handle)) || !(await lockBytes(handle)).equals(bytes)) fail("state-store-busy");
    await unlink(path);
    await syncDirectory(dirname(path));
    return true;
  } finally { await handle.close(); }
}

/** Kernel coordination for new Linux clients, O_EXCL admission for compatible old writers. */
export async function acquireSourceLock(location: ObjectLocation, source: SourceIdentity, operationId: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  checkSignal(signal);
  const directory = join(location.root, "locks");
  await checkDirectory(directory);
  const name = hashText(source.durability === "ephemeral" ? source.sessionId : source.file);
  const path = join(directory, `${name}.lock`), guardPath = join(directory, `${name}.guard`);
  const deadline = Date.now() + WAIT_MS;
  let guard: FileHandle | undefined, handle: FileHandle | undefined;
  try {
    const local = await localIdentity();
    if (process.platform === "linux") {
      guard = await open(guardPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      const identity = await namedFile(guardPath, guard);
      await kernelLock(guard, deadline, signal);
      if (!sameFile(identity, await namedFile(guardPath, guard))) fail("state-store-unsafe-path");
    }
    while (!handle) {
      checkSignal(signal);
      try { handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        if (Date.now() >= deadline) fail("state-store-busy");
        if (guard && local && await retireDeadLock(path, local, signal)) continue;
        await delay(25, undefined, { signal }).catch(() => { checkSignal(signal); });
      }
    }
    const identity = await namedFile(path, handle);
    const bytes = Buffer.from(canonicalJson({ version: local && guard ? 2 : 1, pid: process.pid, operationId, ...(local && guard ? local : {}) }, STATE_STORE_LIMITS.recordBytes));
    await handle.writeFile(bytes); await handle.sync(); await syncDirectory(directory);
    const held = handle, heldGuard = guard;
    handle = undefined; guard = undefined;
    return async () => {
      try {
        const current = await namedFile(path, held);
        if (current.dev !== identity.dev || current.ino !== identity.ino || !(await lockBytes(held)).equals(bytes)) fail("state-store-unsafe-path");
        await unlink(path); await syncDirectory(directory);
      } finally { try { await held.close(); } finally { await heldGuard?.close(); } }
    };
  } catch (error) {
    // A failed acquisition is not permission to remove an unknown or partially written lock.
    throw error;
  } finally { try { await handle?.close(); } finally { await guard?.close(); } }
}
