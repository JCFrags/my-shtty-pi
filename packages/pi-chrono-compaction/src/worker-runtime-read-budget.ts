import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

/** Trusted worker read admission. Reserve requested bytes before a read or
 * allocation, rather than checking metrics after an unbounded read. This is a
 * conservative cumulative cap (short reads are still charged in full). */
export function installWorkerReadBudget(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("worker-source-limit");
  let remaining = maxBytes;
  const charge = (bytes: number) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > remaining) throw Object.assign(new Error("worker-source-limit"), { code: "worker-source-limit" });
    remaining -= bytes;
  };
  const originalRead = fs.read.bind(fs);
  const originalReadSync = fs.readSync.bind(fs);
  const length = (args: unknown[]): number => {
    const buffer = args[1];
    if (ArrayBuffer.isView(buffer)) {
      if (typeof args[3] === "number") return args[3];
      const options = args[2] as { length?: number; offset?: number } | undefined;
      return options?.length ?? (buffer.byteLength - (options?.offset ?? 0));
    }
    const options = buffer as { buffer?: NodeJS.ArrayBufferView; length?: number; offset?: number } | undefined;
    return options?.length ?? ((options?.buffer?.byteLength ?? 16384) - (options?.offset ?? 0));
  };
  fs.read = ((...args: Parameters<typeof fs.read>) => { charge(length(args)); return Reflect.apply(originalRead, fs, args); }) as typeof fs.read;
  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => { charge(length(args)); return Reflect.apply(originalReadSync, fs, args); }) as typeof fs.readSync;
  // readFile implementations use internal bindings, so replace them with bounded
  // explicit reads. All metadata and source files count, not only one pathname.
  const boundedReadFileSync = (path: fs.PathOrFileDescriptor, options?: unknown): Buffer | string => {
    const owned = typeof path !== "number";
    const fd = owned ? fs.openSync(path, "r") : path;
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      const size = fs.fstatSync(fd).size;
      // Bound regular-file reads to the descriptor snapshot. Do not follow a
      // growing file and do not charge an extra 64KiB EOF probe per small file.
      let unread = size > 0 ? size : undefined;
      while (unread === undefined || unread > 0) {
        if (remaining === 0) charge(1);
        const requested = Math.min(unread ?? 4096, 65536, remaining);
        charge(requested);
        const chunk = Buffer.alloc(requested);
        const count = originalReadSync(fd, chunk, 0, requested, null);
        if (!count) break;
        chunks.push(chunk.subarray(0, count)); bytes += count;
        if (unread !== undefined) unread -= count;
      }
      const result = Buffer.concat(chunks, bytes);
      const encoding = typeof options === "string" ? options : (options as { encoding?: BufferEncoding } | undefined)?.encoding;
      return encoding ? result.toString(encoding as BufferEncoding) : result;
    } finally { if (owned) fs.closeSync(fd); }
  };
  fs.readFileSync = boundedReadFileSync as typeof fs.readFileSync;
  fsp.readFile = (async (path: Parameters<typeof fsp.readFile>[0], options?: unknown) => {
    if (typeof path === "object" && path !== null && "fd" in path) return boundedReadFileSync(path.fd, options);
    return boundedReadFileSync(path as fs.PathOrFileDescriptor, options);
  }) as typeof fsp.readFile;
  fs.readFile = ((path: fs.PathOrFileDescriptor, options: unknown, callback?: (error: NodeJS.ErrnoException | null, data?: Buffer | string) => void) => {
    const done = typeof options === "function" ? options as typeof callback : callback;
    queueMicrotask(() => { try { done?.(null, boundedReadFileSync(path, typeof options === "function" ? undefined : options)); } catch (error) { done?.(error as NodeJS.ErrnoException); } });
  }) as typeof fs.readFile;
  const originalOpen = fsp.open.bind(fsp);
  fsp.open = (async (...args: Parameters<typeof fsp.open>) => {
    const handle = await originalOpen(...args);
    const read = handle.read.bind(handle);
    handle.read = ((...readArgs: Parameters<typeof handle.read>) => { charge(length([handle.fd, ...readArgs])); return Reflect.apply(read, handle, readArgs); }) as typeof handle.read;
    handle.readFile = (async (options?: unknown) => boundedReadFileSync(handle.fd, options)) as typeof handle.readFile;
    const readv = handle.readv.bind(handle);
    handle.readv = ((buffers: NodeJS.ArrayBufferView[], position?: number) => { charge(buffers.reduce((n, b) => n + b.byteLength, 0)); return readv(buffers, position); }) as typeof handle.readv;
    return handle;
  }) as typeof fsp.open;
  const readv = fs.readv.bind(fs), readvSync = fs.readvSync.bind(fs);
  fs.readv = ((...args: Parameters<typeof fs.readv>) => { charge(args[1].reduce((n, b) => n + b.byteLength, 0)); return Reflect.apply(readv, fs, args); }) as typeof fs.readv;
  fs.readvSync = ((...args: Parameters<typeof fs.readvSync>) => { charge(args[1].reduce((n, b) => n + b.byteLength, 0)); return Reflect.apply(readvSync, fs, args); }) as typeof fs.readvSync;
  syncBuiltinESMExports();
}
