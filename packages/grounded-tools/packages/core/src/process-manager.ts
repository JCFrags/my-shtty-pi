import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

export interface ProcessSnapshot {
  id: string;
  command: string;
  cwd: string;
  pid?: number;
  running: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  startedAt: number;
  endedAt?: number;
  pty: boolean;
  logPath: string;
  unreadDroppedBytes: number;
  logError?: string;
}

interface ManagedProcess extends ProcessSnapshot {
  child: ChildProcessWithoutNullStreams;
  log: WriteStream;
  unread: Buffer[];
  unreadBytes: number;
  done: Promise<void>;
  resolveDone: () => void;
  timeout?: NodeJS.Timeout;
  timeoutKill?: NodeJS.Timeout;
}

const MAX_UNREAD_BYTES = 2 * 1024 * 1024;

export class ProcessManager {
  private readonly sessions = new Map<string, ManagedProcess>();
  private nextId = 1;
  private onChange: (() => void) | undefined;
  readonly logRoot = join(tmpdir(), "pi-grounded-process");

  constructor(onChange?: () => void) {
    this.onChange = onChange;
  }

  setOnChange(onChange?: () => void): void {
    this.onChange = onChange;
  }

  async cleanupOldLogs(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
    await mkdir(this.logRoot, { recursive: true });
    const now = Date.now();
    for (const entry of await readdir(this.logRoot).catch(() => [] as string[])) {
      const path = join(this.logRoot, entry);
      const info = await stat(path).catch(() => undefined);
      if (info && now - info.mtimeMs > maxAgeMs) await rm(path, { force: true }).catch(() => undefined);
    }
  }

  async start(options: {
    command: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    pty?: boolean;
    timeoutMs?: number;
    onData?: (text: string) => void;
  }): Promise<ProcessSnapshot> {
    await mkdir(this.logRoot, { recursive: true });
    const id = `p${this.nextId++}`;
    const logPath = join(this.logRoot, `${id}-${randomBytes(5).toString("hex")}.log`);
    const log = createWriteStream(logPath, { flags: "wx", mode: 0o600 });
    const shell = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : process.env.SHELL ?? "/bin/bash";
    const usePty = options.pty === true && process.platform !== "win32";
    const bridge = fileURLToPath(new URL("./pty_bridge.py", import.meta.url));
    const command = usePty ? "python3" : shell;
    const args = usePty
      ? [bridge, shell, Buffer.from(options.command).toString("base64")]
      : process.platform === "win32"
        ? ["/d", "/s", "/c", options.command]
        : ["-lc", options.command];
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const session: ManagedProcess = {
      id,
      command: options.command,
      cwd: options.cwd,
      ...(child.pid !== undefined ? { pid: child.pid } : {}),
      running: true,
      startedAt: Date.now(),
      pty: usePty,
      logPath,
      unread: [],
      unreadBytes: 0,
      unreadDroppedBytes: 0,
      child,
      log,
      done,
      resolveDone,
    };
    this.sessions.set(id, session);

    const decoder = new StringDecoder("utf8");
    const appendUnread = (chunk: Buffer) => {
      session.unread.push(chunk);
      session.unreadBytes += chunk.length;
      while (session.unreadBytes > MAX_UNREAD_BYTES && session.unread.length > 1) {
        const dropped = session.unread.shift()!;
        session.unreadBytes -= dropped.length;
        session.unreadDroppedBytes += dropped.length;
      }
    };
    log.once("close", () => session.resolveDone());
    log.on("error", (error) => {
      session.logError = error.message;
      const marker = Buffer.from(`\n[process log error: ${error.message}]\n`);
      appendUnread(marker);
      const decoded = decoder.write(marker);
      if (decoded) options.onData?.(decoded);
      if (session.running) this.signal(session, "SIGTERM");
    });
    const receive = (chunk: Buffer) => {
      if (!session.logError) log.write(chunk);
      appendUnread(chunk);
      const decoded = decoder.write(chunk);
      if (decoded) options.onData?.(decoded);
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.on("error", (error) => receive(Buffer.from(`\n[spawn error: ${error.message}]\n`)));
    child.on("close", (code, signal) => {
      session.running = false;
      session.exitCode = code;
      session.signal = signal;
      session.endedAt = Date.now();
      if (session.timeout) clearTimeout(session.timeout);
      if (session.timeoutKill) clearTimeout(session.timeoutKill);
      const finalText = decoder.end();
      if (finalText) options.onData?.(finalText);
      if (session.logError) session.resolveDone();
      else log.end(() => session.resolveDone());
      this.onChange?.();
    });

    if (options.timeoutMs && options.timeoutMs > 0) {
      session.timeout = setTimeout(() => {
        this.kill(id, "SIGTERM");
        session.timeoutKill = setTimeout(() => {
          if (session.running) this.kill(id, "SIGKILL");
        }, 1000);
        session.timeoutKill.unref();
      }, options.timeoutMs);
      session.timeout.unref();
    }
    this.onChange?.();
    return this.snapshot(session);
  }

  get(id: string): ProcessSnapshot | undefined {
    const session = this.sessions.get(id);
    return session ? this.snapshot(session) : undefined;
  }

  list(): ProcessSnapshot[] {
    return [...this.sessions.values()].map((session) => this.snapshot(session));
  }

  runningCount(): number {
    return [...this.sessions.values()].filter((session) => session.running).length;
  }

  async wait(id: string, milliseconds?: number): Promise<ProcessSnapshot> {
    const session = this.require(id);
    if (!session.running) return this.snapshot(session);
    if (milliseconds === undefined) {
      await session.done;
    } else {
      await Promise.race([
        session.done,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(0, milliseconds));
          timer.unref();
        }),
      ]);
    }
    return this.snapshot(session);
  }

  drain(id: string): { output: string; droppedBytes: number } {
    const session = this.require(id);
    const output = Buffer.concat(session.unread).toString("utf8");
    const droppedBytes = session.unreadDroppedBytes;
    session.unread = [];
    session.unreadBytes = 0;
    session.unreadDroppedBytes = 0;
    return { output, droppedBytes };
  }

  input(id: string, data: Buffer): void {
    const session = this.require(id);
    if (!session.running || session.child.stdin.destroyed) throw new Error(`Process ${id} is not accepting input`);
    session.child.stdin.write(data);
  }

  interrupt(id: string): void {
    const session = this.require(id);
    if (session.pty) session.child.stdin.write(Buffer.from([3]));
    else this.signal(session, "SIGINT");
  }

  kill(id: string, signal: NodeJS.Signals = "SIGTERM"): void {
    const session = this.require(id);
    if (!session.running) return;
    this.signal(session, signal);
  }

  async shutdown(): Promise<void> {
    const running = [...this.sessions.values()].filter((session) => session.running);
    for (const session of running) this.signal(session, "SIGTERM");
    await Promise.race([
      Promise.all(running.map((session) => session.done)),
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]);
    const survivors = running.filter((entry) => entry.running);
    for (const session of survivors) this.signal(session, "SIGKILL");
    await Promise.race([
      Promise.all(survivors.map((session) => session.done)),
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]);
  }

  private require(id: string): ManagedProcess {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown process id: ${id}`);
    return session;
  }

  private signal(session: ManagedProcess, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32" && session.child.pid) process.kill(-session.child.pid, signal);
      else session.child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  private snapshot(session: ManagedProcess): ProcessSnapshot {
    return {
      id: session.id,
      command: session.command,
      cwd: session.cwd,
      ...(session.pid !== undefined ? { pid: session.pid } : {}),
      running: session.running,
      ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
      ...(session.signal !== undefined ? { signal: session.signal } : {}),
      startedAt: session.startedAt,
      ...(session.endedAt !== undefined ? { endedAt: session.endedAt } : {}),
      pty: session.pty,
      logPath: session.logPath,
      unreadDroppedBytes: session.unreadDroppedBytes,
      ...(session.logError !== undefined ? { logError: session.logError } : {}),
    };
  }
}
