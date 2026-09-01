import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStream } from "./session-contract.ts";

export const SESSION_LOG_ROOT = join(tmpdir(), "pi-grounded-process");

export async function cleanupOldSessionLogs(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
  await mkdir(SESSION_LOG_ROOT, { recursive: true, mode: 0o700 });
  const now = Date.now();
  for (const entry of await readdir(SESSION_LOG_ROOT).catch(() => [] as string[])) {
    if (!entry.startsWith("session-")) continue;
    const path = join(SESSION_LOG_ROOT, entry);
    const info = await stat(path).catch(() => undefined);
    if (info && now - info.mtimeMs > maxAgeMs) await rm(path, { force: true }).catch(() => undefined);
  }
}

export class SessionLog {
  readonly path: string;
  private pending = Promise.resolve();
  private closed = false;

  private constructor(path: string) {
    this.path = path;
  }

  static async create(): Promise<SessionLog> {
    await mkdir(SESSION_LOG_ROOT, { recursive: true, mode: 0o700 });
    const path = join(SESSION_LOG_ROOT, `session-${Date.now()}-${randomBytes(8).toString("hex")}.jsonl`);
    const handle = await open(path, "wx", 0o600);
    await handle.close();
    return new SessionLog(path);
  }

  append(requestId: string, sequence: number, stream: SessionStream, bytes: Buffer): void {
    if (this.closed) return;
    const line = `${JSON.stringify({ requestId, sequence, stream, bytes: bytes.length, dataBase64: bytes.toString("base64") })}\n`;
    this.pending = this.pending.then(async () => {
      const handle = await open(this.path, "a", 0o600);
      try {
        await handle.writeFile(line, "utf8");
      } finally {
        await handle.close();
      }
    });
  }

  async flush(): Promise<void> {
    await this.pending;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }
}
