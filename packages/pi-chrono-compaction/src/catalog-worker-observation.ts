import { openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
/** Observations, not enforcement or proof that all memory is SQLite memory. */
export interface CatalogWorkerObservation {
  processPeakRssBytes: number;
  userCpuMicros: number;
  systemCpuMicros: number;
  processIo?: { readChars: number; writtenChars: number; storageReadBytes: number; storageWrittenBytes: number };
  cgroupMemoryPeakBytes?: number;
  cgroupMemoryLimitBytes?: number;
}
function kernelText(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(4097);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    return length <= 4096 ? buffer.subarray(0, length).toString("utf8") : undefined;
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function counter(text: string | undefined): number | undefined {
  if (!text || !/^\d+\s*$/.test(text)) return undefined;
  const value = Number(text.trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
/** Worker-only, bounded kernel reads. Process I/O includes native SQLite, JS,
 * trusted startup, and these measurement reads; it is NOT SQLite-only I/O.
 * Storage counters exclude cache hits. Source bytes remain a separate counter.
 */
export function observeCatalogWorker(): CatalogWorkerObservation {
  const usage = process.resourceUsage();
  const result: CatalogWorkerObservation = { processPeakRssBytes: usage.maxRSS * 1024, userCpuMicros: usage.userCPUTime, systemCpuMicros: usage.systemCPUTime };
  if (process.platform !== "linux") return result;
  const io = kernelText("/proc/self/io");
  const values = ["rchar", "wchar", "read_bytes", "write_bytes"].map(key => counter(io?.match(new RegExp(`^${key}: (\\d+)$`, "m"))?.[1]));
  if (values.every(value => value !== undefined)) result.processIo = { readChars: values[0]!, writtenChars: values[1]!, storageReadBytes: values[2]!, storageWrittenBytes: values[3]! };
  const path = kernelText("/proc/self/cgroup")?.split("\n").find(line => line.startsWith("0::/"))?.slice(3);
  if (path && !path.includes("\0") && !path.split("/").some(part => part === "." || part === "..")) {
    const peak = counter(kernelText(join("/sys/fs/cgroup", path, "memory.peak")));
    const limit = counter(kernelText(join("/sys/fs/cgroup", path, "memory.max")));
    if (peak !== undefined) result.cgroupMemoryPeakBytes = peak;
    if (limit !== undefined) result.cgroupMemoryLimitBytes = limit;
  }
  return result;
}
