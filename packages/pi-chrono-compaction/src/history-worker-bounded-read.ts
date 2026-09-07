import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

interface SourceState { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
function same(a: SourceState, b: SourceState) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }

/** Optional strict sidecar read used by contained recall promotion. The caller
 * retains its existing lock/transaction. This helper never grows its allocation. */
export async function readBoundedHistorySidecar(path: string, maxBytes: number, hooks: {
  afterOpened?: () => void | Promise<void>;
  onRead?: (requested: number, actual: number) => void;
} = {}): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("history-promotion-limit-invalid");
  const expected = await lstat(path);
  if (!expected.isFile() || expected.nlink !== 1 || (expected.mode & 0o077) !== 0) throw new Error("history-promotion-source-unsafe");
  if (expected.size > maxBytes) throw new Error("history-promotion-source-too-large");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || !same(before, expected)) throw new Error("history-promotion-source-changed");
    if (before.size > maxBytes) throw new Error("history-promotion-source-too-large");
    await hooks.afterOpened?.();
    // Detect changes after open and before allocation/read as well as afterward.
    if (!same(before, await handle.stat()) || !same(before, await lstat(path))) throw new Error("history-promotion-source-changed");
    const buffer = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const requested = Math.min(64 * 1024, buffer.length - offset);
      const { bytesRead } = await handle.read(buffer, offset, requested, offset);
      hooks.onRead?.(requested, bytesRead);
      if (bytesRead === 0) throw new Error("history-promotion-source-changed");
      offset += bytesRead;
    }
    if (!same(before, await handle.stat()) || !same(before, await lstat(path))) throw new Error("history-promotion-source-changed");
    return buffer.toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("history-promotion-source-changed");
    throw error;
  } finally { await handle?.close(); }
}
