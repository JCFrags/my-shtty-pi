import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

interface Envelope {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message?: string; details?: unknown };
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  abort?: () => void;
}

export class PortalHelperError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "PortalHelperError";
    this.code = code;
    this.details = details;
  }
}

export class PortalHelperClient {
  private child?: ChildProcessWithoutNullStreams;
  private lines?: ReadlineInterface;
  private ready = false;
  private pending = new Map<string, Pending>();
  private serial: Promise<unknown> = Promise.resolve();
  private stderrTail: string[] = [];

  async ensureStarted(helperPath: string): Promise<void> {
    if (this.child && this.ready) return;
    await this.spawn(helperPath);
  }

  private spawn(helperPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/python3", [helperPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      });
      this.child = child;
      this.lines = createInterface({ input: child.stdout });
      const timer = setTimeout(() => {
        reject(new Error("Pixel CUA portal helper did not become ready"));
        void this.shutdown();
      }, 10_000);
      this.lines.on("line", (line) => {
        let envelope: Envelope;
        try {
          envelope = JSON.parse(line) as Envelope;
        } catch {
          this.stderrTail.push(`malformed stdout: ${line.slice(0, 500)}`);
          return;
        }
        if (envelope.id === "ready" || envelope.id === "startup") {
          clearTimeout(timer);
          if (envelope.ok) {
            this.ready = true;
            resolve();
          } else {
            reject(this.toError(envelope));
          }
          return;
        }
        const pending = this.pending.get(envelope.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        if (pending.abort) pending.abort();
        this.pending.delete(envelope.id);
        if (envelope.ok) pending.resolve(envelope.result);
        else pending.reject(this.toError(envelope));
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
          this.stderrTail.push(line.slice(0, 1000));
          if (this.stderrTail.length > 20) this.stderrTail.shift();
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
        this.failAll(error);
        this.reset();
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        const error = new Error(`Pixel CUA portal helper exited (${signal ?? code}). ${this.stderrTail.slice(-3).join(" | ")}`);
        if (!this.ready) reject(error);
        this.failAll(error);
        this.reset();
      });
    });
  }

  request<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> {
    const run = () => this.send<T>(method, params, signal, timeoutMs);
    const result = this.serial.then(run, run);
    this.serial = result.catch(() => undefined);
    return result;
  }

  priority<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 8_000): Promise<T> {
    return this.send(method, params, undefined, timeoutMs);
  }

  private send<T>(method: string, params: Record<string, unknown>, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
    if (!this.child || !this.ready) return Promise.reject(new Error("Pixel CUA portal helper is not ready"));
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("cancelled"));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      let abort: (() => void) | undefined;
      if (signal) {
        const listener = () => {
          const pending = this.pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          void this.priority("stop").catch(() => undefined);
          reject(signal.reason ?? new Error("cancelled"));
        };
        signal.addEventListener("abort", listener, { once: true });
        abort = () => signal.removeEventListener("abort", listener);
      }
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, abort });
      this.child!.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  private toError(envelope: Envelope): Error {
    return new PortalHelperError(
      envelope.error?.code ?? "HELPER_ERROR",
      envelope.error?.message ?? "Pixel CUA portal helper failed",
      envelope.error?.details,
    );
  }

  async stop(): Promise<unknown> {
    if (!this.child || !this.ready) return { stopped: true };
    return this.priority("stop", {}, 10_000);
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      if (this.ready) await this.priority("shutdown", {}, 10_000);
    } catch {
      // The process termination below is the final cleanup boundary.
    }
    try { child.stdin.end(); } catch {}
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(resolve, 1500);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    this.failAll(new Error("Pixel CUA portal helper shut down"));
    this.reset();
  }

  status() {
    return { running: Boolean(this.child), ready: this.ready, pid: this.child?.pid, stderrTail: [...this.stderrTail] };
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.abort?.();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private reset(): void {
    this.lines?.close();
    this.lines = undefined;
    this.child = undefined;
    this.ready = false;
  }
}
