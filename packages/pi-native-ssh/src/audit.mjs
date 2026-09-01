import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname } from "node:path";

export class PrivateAudit {
  constructor(config) {
    this.config = config;
    this.queue = Promise.resolve();
  }
  record(event) {
    if (!this.config.enabled) return;
    const safe = {
      at: Date.now(),
      event: String(event.event ?? "operation").slice(0, 32),
      operation: String(event.operation ?? "controller").slice(0, 16),
      target: String(event.target ?? "").slice(0, 128),
      code: String(event.code ?? "OK").slice(0, 40),
      durationMs: Math.max(0, Math.min(3_600_000, Number(event.durationMs) || 0)),
      stdoutBytes: Math.max(0, Math.min(100_000, Number(event.stdoutBytes) || 0)),
      stderrBytes: Math.max(0, Math.min(10_000, Number(event.stderrBytes) || 0)),
    };
    this.queue = this.queue.then(() => this.#append(`${JSON.stringify(safe)}\n`)).catch(() => {});
  }
  async flush() { await this.queue; }
  async #append(line) {
    const file = this.config.path;
    const parentPath = dirname(file);
    const parent = await lstat(parentPath);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0 || await realpath(parentPath) !== parentPath) return;
    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
    const handle = await open(file, flags, 0o600);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) return;
      const bytes = Buffer.byteLength(line);
      if (info.size + bytes > this.config.maxBytes) return;
      await handle.write(line);
    } finally { await handle.close(); }
  }
}
