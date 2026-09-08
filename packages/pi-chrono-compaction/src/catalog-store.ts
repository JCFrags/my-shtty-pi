import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants as F, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { executeCatalogRequest } from "./catalog-engine.js";
import type { CatalogRequest, CatalogResponse } from "./catalog-contract.js";
import { isCatalogStoreRequest, isStoreKey, type CatalogStoreRequest } from "./catalog-store-contract.js";
import { withRuntimeMutex } from "./worker-runtime-mutex.js";

const hash = (s: string): string => createHash("sha256").update(s).digest("hex");
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === "ENOENT";
const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.nlink === b.nlink && a.uid === b.uid;
const key = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(x);
interface Active { v: 1; sessionKey: string; storeKey: string }
interface Stage { v: 1; sessionKey: string; folder: string; rebuildKey: string; expectedActiveStoreKey: string | null }
interface Ref extends Active { folder: string; recovery?: { rebuildKey: string; generation: number; expectedActiveStoreKey: string | null } }
const activeValid = (x: any): x is Active => x?.v === 1 && key(x.sessionKey) && isStoreKey(x.storeKey);
const folderValid = (x: unknown): x is string => typeof x === "string" && /^(initial|recovery)-[0-9a-f]{64}$/.test(x);
const stageValid = (x: any): x is Stage => x?.v === 1 && key(x.sessionKey) && folderValid(x.folder) && key(x.rebuildKey) && (x.expectedActiveStoreKey === null || isStoreKey(x.expectedActiveStoreKey));
const refValid = (x: any): x is Ref => !!x && folderValid(x.folder) && (x.recovery === undefined || (key(x.recovery.rebuildKey) && Number.isSafeInteger(x.recovery.generation) && x.recovery.generation > 0 && (x.recovery.expectedActiveStoreKey === null || isStoreKey(x.recovery.expectedActiveStoreKey)))) && activeValid(x);
function privateDirectory(path: string): Stats {
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid!() || (s.mode & 0o7777) !== 0o700) fail("catalog-storage-unsafe");
  return s;
}
function syncDirectory(path: string): void {
  const fd = openSync(path, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** No recursive walk/scan. At most 64 ancestors and eight new directories. */
function prepare(path: string, create: boolean): void {
  if (resolve(path) !== path || path === "/" || Buffer.from(path).toString() !== path) fail("catalog-storage-unsafe");
  const parts = path.split("/").filter(Boolean);
  if (parts.length > 64) fail("catalog-storage-unsafe");
  let at = "", made = 0;
  for (const part of parts) {
    at += `/${part}`;
    let s: Stats;
    try { s = lstatSync(at); }
    catch (e) {
      if (!missing(e) || !create) throw e;
      if (++made > 8) fail("catalog-storage-unsafe");
      try { mkdirSync(at, { mode: 0o700 }); syncDirectory(dirname(at)); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      s = lstatSync(at);
    }
    if (!s.isDirectory() || s.isSymbolicLink() || (s.uid !== 0 && s.uid !== process.getuid!()) || ((s.mode & 0o022) !== 0 && !(s.uid === 0 && (s.mode & 0o1000) !== 0))) fail("catalog-storage-unsafe");
  }
  privateDirectory(path);
}
function record<T>(path: string, valid: (x: any) => x is T): T | undefined {
  const parent = privateDirectory(dirname(path));
  let before: Stats;
  try { before = lstatSync(path); } catch (e) { if (missing(e)) return undefined; throw e; }
  const safe = (s: Stats): void => {
    if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid!() || (s.mode & 0o7777) !== 0o600 || s.nlink !== 1 || s.size < 2 || s.size > 4096) fail("catalog-pointer-unsafe");
  };
  safe(before);
  const fd = openSync(path, F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
  try {
    const opened = fstatSync(fd); safe(opened);
    if (!same(before, opened)) fail("catalog-pointer-changed");
    const bytes = Buffer.alloc(4097); let size = 0;
    while (size < bytes.length) { const n = readSync(fd, bytes, size, bytes.length - size, size); if (!n) break; size += n; }
    if (size !== opened.size || !same(opened, fstatSync(fd)) || !same(opened, lstatSync(path)) || !same(parent, privateDirectory(dirname(path)))) fail("catalog-pointer-changed");
    let result: unknown;
    try { result = JSON.parse(bytes.subarray(0, size).toString("utf8")); } catch { fail("catalog-pointer-invalid"); }
    if (!valid(result)) fail("catalog-pointer-invalid");
    return result;
  } finally { closeSync(fd); }
}
export type CatalogStoreFaultPoint = "before-metadata-write" | "before-metadata-sync" | "before-metadata-rename" | "after-metadata-rename" | "after-store-commit" | "after-ref-commit" | "before-active-publish" | "after-active-publish";
/** Internal deterministic synthetic seams. Not supplied through worker IPC or environment. */
export interface CatalogStoreHooks { fault?: (point: CatalogStoreFaultPoint, recordName?: string) => void }
/** Caller holds the kernel mutex. Immutable records are never overwritten. */
function atomic(path: string, value: unknown, hooks: CatalogStoreHooks): void {
  const parent = privateDirectory(dirname(path));
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 4096) fail("catalog-pointer-limit");
  const tmp = join(dirname(path), `.pending-${randomUUID()}`);
  let fd: number | undefined;
  try {
    hooks.fault?.("before-metadata-write", path.endsWith("active.json") ? "active" : "immutable");
    fd = openSync(tmp, F.O_WRONLY | F.O_CREAT | F.O_EXCL | F.O_NOFOLLOW, 0o600);
    let offset = 0;
    while (offset < bytes.length) { const n = writeSync(fd, bytes, offset, bytes.length - offset); if (!n) fail("catalog-storage-io"); offset += n; }
    hooks.fault?.("before-metadata-sync"); fsyncSync(fd);
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid!() || (st.mode & 0o7777) !== 0o600 || !same(st, lstatSync(tmp))) fail("catalog-pointer-unsafe");
    // Directory mtime changes for our own temporary. Compare identity and mode, not timestamps.
    const now = privateDirectory(dirname(path));
    if (now.dev !== parent.dev || now.ino !== parent.ino) fail("catalog-pointer-changed");
    hooks.fault?.("before-metadata-rename"); renameSync(tmp, path);
    hooks.fault?.("after-metadata-rename"); syncDirectory(dirname(path));
  } finally {
    if (fd !== undefined) closeSync(fd);
    // Only this request's exact random temporary; no orphan sweep or DB cleanup.
    if (fd !== undefined) { try { unlinkSync(tmp); } catch (e) { if (!missing(e)) throw e; } }
  }
}

/** Factory permits synthetic engine/fault tests; production uses the native engine below. */
export function createCatalogStoreExecutor(engine: (request: unknown) => CatalogResponse, hooks: CatalogStoreHooks = {}): (request: unknown) => Promise<CatalogResponse> {
  return async (value: unknown): Promise<CatalogResponse> => {
    if (!isCatalogStoreRequest(value)) return { v: 1, ok: false, code: "catalog-request-invalid", sourceBytes: 0 };
    const r: CatalogStoreRequest = value;
    let sourceBytes = 0;
    try {
      const root = r.catalogDirectory;
      const create = r.op === "ingestStep" || r.op === "recoverStart";
      prepare(root, create);
      for (const child of ["stores", "refs", "stages"]) prepare(join(root, child), create);
      const activePath = join(root, "active.json");
      const lock = <T>(fn: () => T): Promise<T> => withRuntimeMutex(join(root, "publication.lock"), async () => { prepare(root, false); return fn(); });
      const active = (): Active | undefined => {
        const a = record(activePath, activeValid);
        if (a && a.sessionKey !== r.sessionKey) fail("catalog-session-mismatch");
        return a;
      };
      const call = (req: CatalogRequest): Record<string, unknown> => {
        const response = engine(req); sourceBytes += response.sourceBytes;
        if (!response.ok) fail(response.code);
        return response.result;
      };
      const refPath = (storeKey: string): string => join(root, "refs", `${storeKey}.json`);
      const readRef = (storeKey: string): Ref => {
        const ref = record(refPath(storeKey), refValid) ?? fail("catalog-store-missing");
        if (ref.storeKey !== storeKey || ref.sessionKey !== r.sessionKey || ref.folder !== (ref.recovery ? `recovery-${hash(`${r.sessionKey}\0${ref.recovery.rebuildKey}`)}` : `initial-${hash(r.sessionKey)}`)) fail("catalog-store-mismatch");
        return ref;
      };
      const commitRef = (ref: Ref): void => {
        const old = record(refPath(ref.storeKey), refValid);
        if (old) {
          if (JSON.stringify(old) !== JSON.stringify(ref)) fail("catalog-store-mismatch");
          syncDirectory(join(root, "refs")); // Retry may follow rename before parent fsync.
        }
        else atomic(refPath(ref.storeKey), ref, hooks);
        hooks.fault?.("after-ref-commit");
      };
      const status = (folder: string): Record<string, unknown> => {
        prepare(join(root, "stores", folder), false);
        return call({ v: 1, op: "status", sessionKey: r.sessionKey, catalogDirectory: join(root, "stores", folder) });
      };
      if (r.op === "recoverStart") {
        const folder = `recovery-${hash(`${r.sessionKey}\0${r.rebuildKey}`)}`;
        const stagePath = join(root, "stages", `${folder}.json`);
        const stage = await lock(() => {
          const prior = record(stagePath, stageValid);
          if (prior) {
            if (prior.sessionKey !== r.sessionKey || prior.folder !== folder || prior.rebuildKey !== r.rebuildKey) fail("catalog-store-mismatch");
            syncDirectory(join(root, "stages"));
            return prior;
          }
          const s: Stage = { v: 1, sessionKey: r.sessionKey, folder, rebuildKey: r.rebuildKey, expectedActiveStoreKey: active()?.storeKey ?? null };
          atomic(stagePath, s, hooks); return s;
        });
        prepare(join(root, "stores", folder), true);
        const result = call({ v: 1, op: "rebuildStep", action: "start", catalogDirectory: join(root, "stores", folder), sessionKey: r.sessionKey, rebuildKey: r.rebuildKey });
        hooks.fault?.("after-store-commit");
        const s = status(folder);
        syncDirectory(join(root, "stores", folder));
        if (!isStoreKey(s.storeKey) || !Number.isSafeInteger(result.generation) || Number(result.generation) < 1) fail("catalog-store-mismatch");
        const ref: Ref = { v: 1, sessionKey: r.sessionKey, storeKey: s.storeKey, folder, recovery: { rebuildKey: r.rebuildKey, generation: Number(result.generation), expectedActiveStoreKey: stage.expectedActiveStoreKey } };
        await lock(() => commitRef(ref));
        return { v: 1, ok: true, sourceBytes, result: { targetStoreKey: ref.storeKey, generation: result.generation, expectedActiveStoreKey: stage.expectedActiveStoreKey, rebuildKey: r.rebuildKey } };
      }
      if (r.op === "recoverPublish") {
        const ref = readRef(r.targetStoreKey);
        if (!ref.recovery || ref.recovery.generation !== r.generation || ref.recovery.expectedActiveStoreKey !== r.expectedActiveStoreKey) fail("catalog-recovery-mismatch");
        if (status(ref.folder).storeKey !== ref.storeKey) fail("catalog-store-mismatch");
        // Bounded SQLite/source work stays outside the pointer mutex. A CAS loser
        // leaves its complete physical store intact but cannot replace the winner.
        call({ v: 1, op: "rebuildStep", action: "publish", sessionKey: r.sessionKey, catalogDirectory: join(root, "stores", ref.folder), generation: r.generation, expectedShards: r.expectedShards });
        hooks.fault?.("after-store-commit");
        await lock(() => {
          const current = active()?.storeKey ?? null;
          syncDirectory(join(root, "refs"));
          if (current === ref.storeKey) { syncDirectory(root); return; } // Finish durability on retry.
          if (current !== r.expectedActiveStoreKey) fail("catalog-publication-conflict");
          hooks.fault?.("before-active-publish");
          atomic(activePath, { v: 1, sessionKey: r.sessionKey, storeKey: ref.storeKey }, hooks);
          hooks.fault?.("after-active-publish");
        });
        return { v: 1, ok: true, sourceBytes, result: { published: true, targetStoreKey: ref.storeKey, generation: r.generation } };
      }
      let storeKey = "view" in r ? r.view.storeKey : r.targetStoreKey;
      if (!storeKey) {
        let a = active();
        if (!a) {
          if (r.op !== "ingestStep") fail("catalog-store-missing");
          // Deterministic initial location: interrupted or competing initializers
          // resume one DB, never choose and overwrite another initializer's DB.
          const folder = `initial-${hash(r.sessionKey)}`;
          prepare(join(root, "stores", folder), true);
          const s = status(folder); hooks.fault?.("after-store-commit");
          syncDirectory(join(root, "stores", folder));
          if (!isStoreKey(s.storeKey)) fail("catalog-store-mismatch");
          const ref: Ref = { v: 1, sessionKey: r.sessionKey, storeKey: s.storeKey, folder };
          a = await lock(() => {
            const current = active(); if (current) return current;
            commitRef(ref); hooks.fault?.("before-active-publish");
            const next: Active = { v: 1, sessionKey: r.sessionKey, storeKey: ref.storeKey };
            atomic(activePath, next, hooks); hooks.fault?.("after-active-publish"); return next;
          });
        }
        storeKey = a.storeKey;
      }
      const ref = readRef(storeKey);
      if (r.op === "ingestStep") {
        // An initializer may have died after rename but before directory fsync.
        // Sync does not change a pointer and needs no writer lock or source work.
        syncDirectory(join(root, "refs"));
        if (r.targetStoreKey === undefined) syncDirectory(root);
      }
      if (status(ref.folder).storeKey !== ref.storeKey) fail("catalog-store-mismatch");
      const result = call({ ...r, catalogDirectory: join(root, "stores", ref.folder) });
      return { v: 1, ok: true, sourceBytes, result };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      return { v: 1, ok: false, sourceBytes, code: code && /^catalog-[a-z-]+$/.test(code) ? code : code === "ENOSPC" ? "catalog-storage-full" : code === "ENOENT" ? "catalog-store-missing" : "catalog-storage-io" };
    }
  };
}
/** Contained-process only: do not import this module in the Pi main process. */
export const executeCatalogStoreRequest = createCatalogStoreExecutor(executeCatalogRequest);
