import { constants } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { add, type TelemetryRecord } from "./model.ts";

export const STORAGE_LIMITS = Object.freeze({ slots: 256, slotBytes: 64 * 1024, queueRecords: 128, recordBytes: 2048, shutdownMs: 150 });
type State = "idle" | "opening" | "recording" | "full" | "failed" | "closed";
type ErrorCode = "none" | "unsafe_directory" | "storage_unavailable" | "write_failed" | "global_cap";
type Options = { directory?: string; slots?: number; slotBytes?: number };
function below(value: number | undefined, ceiling: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? Math.min(value, ceiling) : ceiling;
}

/** Exclusive fixed slots bound total managed files, including abandoned and partial slots. */
export class LocalWriter {
  private directory: string;
  private slots: number;
  private slotBytes: number;
  private queue: string[] = [];
  private file?: FileHandle;
  private bytes = 0;
  private nextSlot = 0;
  private prepared = false;
  private worker?: Promise<void>;
  private scheduled?: ReturnType<typeof setImmediate>;
  private accepting = true;
  private halt = false;
  private state: State = "idle";
  private error: ErrorCode = "none";
  private written = 0;
  private dropped = 0;
  private writtenBytes = 0;
  private claimedSlots = 0;
  private shutdownUnconfirmed = 0;

  constructor(options: Options = {}) {
    this.directory = options.directory ?? join(homedir(), ".local", "state", "pi-context-kit", "telemetry", "v1");
    this.slots = below(options.slots, STORAGE_LIMITS.slots);
    this.slotBytes = below(options.slotBytes, STORAGE_LIMITS.slotBytes);
  }
  enqueue(record: TelemetryRecord): void {
    if (!this.accepting || this.halt || this.state === "full" || this.state === "failed" || this.queue.length >= STORAGE_LIMITS.queueRecords) {
      this.dropped = add(this.dropped); return;
    }
    try {
      const line = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(line) > Math.min(STORAGE_LIMITS.recordBytes, this.slotBytes)) {
        this.dropped = add(this.dropped); return;
      }
      this.queue.push(line);
      this.kick();
    } catch { this.dropped = add(this.dropped); }
  }
  private kick(): void {
    if (this.worker || this.scheduled || this.halt) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      this.worker = this.drain().catch(() => this.fail("write_failed")).finally(() => {
        this.worker = undefined;
        if (this.queue.length && !this.halt) this.kick();
      });
    });
    this.scheduled.unref();
  }
  private fail(error: ErrorCode): void {
    this.error = error;
    this.state = error === "global_cap" ? "full" : "failed";
    this.halt = true;
    this.dropped = add(this.dropped, this.queue.length);
    this.queue = [];
  }
  private async prepare(): Promise<boolean> {
    this.state = "opening";
    try {
      // The three owned directories must be private, real directories. Never chmod an existing path.
      const paths = [dirname(dirname(this.directory)), dirname(this.directory), this.directory];
      for (const path of paths) {
        await mkdir(path, { recursive: true, mode: 0o700 });
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
          this.fail("unsafe_directory"); return false;
        }
      }
      this.prepared = true;
      return true;
    } catch { this.fail("storage_unavailable"); return false; }
  }
  private async claim(): Promise<boolean> {
    if (this.file) { await this.file.close(); this.file = undefined; }
    while (this.nextSlot < this.slots && !this.halt) {
      const slot = this.nextSlot++;
      try {
        this.file = await open(join(this.directory, `slot-${String(slot).padStart(3, "0")}.jsonl`),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        this.bytes = 0;
        this.claimedSlots = add(this.claimedSlots);
        if (!this.halt) this.state = "recording";
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") { this.fail("storage_unavailable"); return false; }
      }
    }
    if (!this.halt) this.fail("global_cap");
    return false;
  }
  private async drain(): Promise<void> {
    try {
      if (!this.prepared && !await this.prepare()) return;
      while (this.queue.length && !this.halt) {
        const line = this.queue[0], size = Buffer.byteLength(line);
        if ((!this.file || this.bytes + size > this.slotBytes) && !await this.claim()) return;
        if (this.halt) return;
        // Reserve bytes before writing. A partial failure retires this slot without a retry.
        this.bytes += size;
        await this.file!.writeFile(line, "utf8");
        this.queue.shift();
        this.written = add(this.written);
        this.writtenBytes = add(this.writtenBytes, size);
      }
    } catch { this.fail("write_failed"); }
    finally {
      if (this.halt || !this.accepting) {
        const file = this.file;
        this.file = undefined;
        try { await file?.close(); } catch { this.fail("write_failed"); }
      }
    }
  }
  async stop(): Promise<void> {
    this.accepting = false;
    if (this.scheduled) { clearImmediate(this.scheduled); this.scheduled = undefined; }
    if (!this.worker && !this.halt) this.worker = this.drain();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.worker,
      new Promise<void>(resolve => { timeout = setTimeout(resolve, STORAGE_LIMITS.shutdownMs); }),
    ]);
    if (timeout) clearTimeout(timeout);
    this.halt = true;
    // An in-flight write can finish after the deadline. Do not call all pending records lost.
    this.shutdownUnconfirmed = add(this.shutdownUnconfirmed, this.queue.length);
    this.queue = [];
    if (this.state !== "failed" && this.state !== "full") this.state = "closed";
    // A blocked filesystem operation may finish later. drain then closes its owned handle.
  }
  snapshot() {
    return { state: this.state, error: this.error, queued: this.queue.length, written: this.written,
      dropped: this.dropped, shutdownUnconfirmed: this.shutdownUnconfirmed,
      writtenBytes: this.writtenBytes, claimedSlots: this.claimedSlots,
      limits: { ...STORAGE_LIMITS, slots: this.slots, slotBytes: this.slotBytes, totalBytes: this.slots * this.slotBytes } };
  }
}
