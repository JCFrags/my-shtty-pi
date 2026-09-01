import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  SESSION_PROVIDER_PROTOCOL_VERSION,
  SessionServiceError,
  type SessionBackendHandle,
  type SessionBackendStatus,
  type SessionCommandResult,
  type SessionOpenRequest,
  type SessionOutputChunk,
  type SessionProvider,
  type SessionStream,
} from "./session-contract.ts";
import { SessionFrameDecoder, type SessionCompleteFrame } from "./session-framing.ts";
import { SessionLog } from "./session-logs.ts";

const MAX_MEMORY_OUTPUT_BYTES = 2 * 1024 * 1024;
const FENCE_PREFIX = Buffer.from([0x1e]);
const FENCE_SUFFIX = Buffer.from([0x1f]);

const FRAME_WRITER = [
  "const fs=require(\"node:fs\");",
  "const [action,requestId,generation,sequence,cwd,status,fence]=process.argv.slice(1);",
  "const frame=action===\"ready\"",
  "?{version:1,requestId,generation:Number(generation),action,sequence:Number(sequence),cwd}",
  ":{version:1,requestId,generation:Number(generation),action,sequence:Number(sequence),cwd,exitCode:Number(status),signal:null,fence};",
  "const body=Buffer.from(JSON.stringify(frame),\"utf8\");",
  "const header=Buffer.allocUnsafe(4);header.writeUInt32BE(body.length,0);",
  "fs.writeSync(3,header);fs.writeSync(3,body);",
].join("");

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

class StreamFence {
  private buffer = Buffer.alloc(0);
  private found = false;
  private readonly marker: Buffer;

  constructor(fence: string) {
    this.marker = Buffer.concat([FENCE_PREFIX, Buffer.from(fence, "ascii"), FENCE_SUFFIX]);
  }

  push(chunk: Buffer): { data: Buffer[]; found: boolean; unexpected?: Buffer } {
    if (this.found) return { data: [], found: false, unexpected: chunk };
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const index = this.buffer.indexOf(this.marker);
    if (index >= 0) {
      const before = this.buffer.subarray(0, index);
      const after = this.buffer.subarray(index + this.marker.length);
      this.buffer = Buffer.alloc(0);
      this.found = true;
      return {
        data: before.length > 0 ? [before] : [],
        found: true,
        ...(after.length > 0 ? { unexpected: after } : {}),
      };
    }
    const safeBytes = Math.max(0, this.buffer.length - this.marker.length + 1);
    if (safeBytes === 0) return { data: [], found: false };
    const safe = this.buffer.subarray(0, safeBytes);
    this.buffer = this.buffer.subarray(safeBytes);
    return { data: [safe], found: false };
  }
}

interface ActiveCommand {
  requestId: string;
  fence: string;
  stdoutFence: StreamFence;
  stderrFence: StreamFence;
  terminalFence: StreamFence;
  stdoutDone: boolean;
  stderrDone: boolean;
  terminalDone: boolean;
  control?: SessionCompleteFrame;
  chunks: SessionOutputChunk[];
  retainedBytes: number;
  stdoutBytes: number;
  stderrBytes: number;
  terminalBytes: number;
  nextChunkSequence: number;
  truncated: boolean;
  cancelled: boolean;
  timedOut: boolean;
  resolve: (result: SessionCommandResult) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
  terminateTimer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  signal?: AbortSignal;
  abortListener?: () => void;
  finishing: boolean;
}

export class LocalSessionHandle implements SessionBackendHandle {
  readonly providerId = "grounded-local-v1";
  readonly backend = "local" as const;
  readonly pty: boolean;

  private state: SessionBackendStatus["state"] = "opening";
  private cwd: string;
  private readonly child: ChildProcess;
  private readonly control: Readable;
  private readonly commandInput: Writable;
  private readonly decoder = new SessionFrameDecoder();
  private readonly log: SessionLog;
  private readonly generation: number;
  private readonly defaultCommandTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly openedAt = Date.now();
  private lastActivityAt = this.openedAt;
  private taintReason: string | undefined;
  private active: ActiveCommand | undefined;
  private controlSequence = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private closePromise: Promise<void> | undefined;
  private resolveClosed: () => void = () => {};
  private readonly closed = new Promise<void>((resolve) => { this.resolveClosed = resolve; });
  private openRequestId: string;
  private resolveOpen: () => void = () => {};
  private rejectOpen: (error: Error) => void = () => {};
  private readonly opened: Promise<void>;

  private constructor(request: SessionOpenRequest, generation: number, log: SessionLog) {
    this.cwd = request.cwd;
    this.pty = request.pty;
    this.generation = generation;
    this.defaultCommandTimeoutMs = request.commandTimeoutMs;
    this.idleTimeoutMs = request.idleTimeoutMs;
    this.closeTimeoutMs = request.closeTimeoutMs;
    this.log = log;
    this.openRequestId = randomBytes(16).toString("hex");
    this.opened = new Promise<void>((resolve, reject) => {
      this.resolveOpen = resolve;
      this.rejectOpen = reject;
    });

    const shell = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/bash";
    if (process.platform === "win32") {
      throw new SessionServiceError("SESSION_LOCAL_UNSUPPORTED", "Local persistent sessions are not available on Windows");
    }
    const bridge = fileURLToPath(new URL("./session_pty_bridge.py", import.meta.url));
    this.child = spawn(request.pty ? "python3" : shell, request.pty ? [bridge, shell] : ["--noprofile", "--norc"], {
      cwd: request.cwd,
      env: request.env,
      detached: true,
      stdio: request.pty ? ["pipe", "pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", "pipe"],
    });
    this.control = this.child.stdio[3] as Readable;
    this.commandInput = (request.pty ? this.child.stdio[4] : this.child.stdin) as Writable;

    if (request.pty) {
      this.child.stdout?.on("data", (chunk: Buffer) => this.receiveOutput("terminal", chunk));
      this.child.stderr?.on("data", (chunk: Buffer) => {
        const message = chunk.subarray(0, 2048).toString("utf8").trim();
        this.markTainted(`PTY bridge error${message ? `: ${message}` : ""}`);
      });
    } else {
      this.child.stdout?.on("data", (chunk: Buffer) => this.receiveOutput("stdout", chunk));
      this.child.stderr?.on("data", (chunk: Buffer) => this.receiveOutput("stderr", chunk));
    }
    this.control.on("data", (chunk: Buffer) => this.receiveControl(chunk));
    this.control.on("error", (error) => this.markTainted(`Control channel error: ${error.message}`));
    this.child.stdin?.on("error", (error) => this.markTainted(`Session input channel error: ${error.message}`));
    if (this.commandInput !== this.child.stdin) {
      this.commandInput.on("error", (error) => this.markTainted(`Session command channel error: ${error.message}`));
    }
    this.control.on("end", () => {
      try {
        this.decoder.finish();
      } catch (error) {
        this.markTainted((error as Error).message);
      }
    });
    this.child.on("error", (error) => this.markTainted(`Local session process error: ${error.message}`));
    this.child.on("close", () => {
      if (this.state !== "closing" && this.state !== "closed" && this.state !== "tainted") {
        this.markTainted("Local session shell exited before close");
      }
      if (this.state === "closing") this.state = "closed";
      this.rejectOpen(new SessionServiceError("SESSION_OPEN_FAILED", "Local session shell exited during open"));
      this.rejectActive(new SessionServiceError("SESSION_CLOSED", "Local session shell exited"));
      this.resolveClosed();
      void this.log.close();
    });

    const openTimer = setTimeout(() => {
      if (this.state === "opening") this.markTainted("Local session open handshake timed out");
    }, request.openTimeoutMs);
    openTimer.unref();
    this.opened.finally(() => clearTimeout(openTimer)).catch(() => undefined);

    const script = `${shellQuote(process.execPath)} -e ${shellQuote(FRAME_WRITER)} ready ${this.openRequestId} ${generation} 0 \"$PWD\" \"\" \"\" >&3\n`;
    this.writeCommandScript(script);
  }

  static async open(request: SessionOpenRequest, generation: number): Promise<LocalSessionHandle> {
    const cwdInfo = await stat(request.cwd).catch((error) => {
      throw new SessionServiceError("SESSION_CWD_INVALID", `Session working directory is not accessible: ${request.cwd}`, { cause: error });
    });
    if (!cwdInfo.isDirectory()) {
      throw new SessionServiceError("SESSION_CWD_INVALID", `Session working directory is not a directory: ${request.cwd}`);
    }
    const log = await SessionLog.create();
    const handle = new LocalSessionHandle(request, generation, log);
    try {
      await handle.opened;
      handle.scheduleIdleClose(request.idleTimeoutMs);
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  status(): SessionBackendStatus {
    return {
      state: this.state,
      cwd: this.cwd,
      ...(this.child.pid !== undefined ? { pid: this.child.pid } : {}),
      generation: this.generation,
      openedAt: this.openedAt,
      lastActivityAt: this.lastActivityAt,
      ...(this.taintReason !== undefined ? { taintReason: this.taintReason } : {}),
    };
  }

  async execute(command: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<SessionCommandResult> {
    if (command.includes("\0")) throw new SessionServiceError("SESSION_COMMAND_INVALID", "Session command cannot contain a NUL byte");
    if (this.state !== "idle") throw new SessionServiceError("SESSION_NOT_IDLE", `Session is not idle: ${this.state}`);
    if (options.signal?.aborted) throw new SessionServiceError("SESSION_CANCELLED", "Session command was cancelled before start");
    this.clearIdleClose();
    this.state = "running";
    this.lastActivityAt = Date.now();
    const requestId = randomBytes(16).toString("hex");
    const fence = randomBytes(32).toString("hex");
    const timeoutMs = options.timeoutMs ?? this.defaultCommandTimeoutMs;

    const result = new Promise<SessionCommandResult>((resolve, reject) => {
      const active: ActiveCommand = {
        requestId,
        fence,
        stdoutFence: new StreamFence(fence),
        stderrFence: new StreamFence(fence),
        terminalFence: new StreamFence(fence),
        stdoutDone: false,
        stderrDone: false,
        terminalDone: false,
        chunks: [],
        retainedBytes: 0,
        stdoutBytes: 0,
        stderrBytes: 0,
        terminalBytes: 0,
        nextChunkSequence: 0,
        truncated: false,
        cancelled: false,
        timedOut: false,
        finishing: false,
        resolve,
        reject,
        ...(options.signal ? { signal: options.signal } : {}),
      };
      this.active = active;
      if (timeoutMs > 0) {
        active.timeout = setTimeout(() => this.requestCancellation(true), timeoutMs);
        active.timeout.unref();
      }
      if (options.signal) {
        active.abortListener = () => this.requestCancellation(false);
        options.signal.addEventListener("abort", active.abortListener, { once: true });
      }
    });

    const encoded = Buffer.from(command, "utf8").toString("base64");
    const sequence = ++this.controlSequence;
    const marker = `\\036${fence}\\037`;
    const wrapper = [
      `__grounded_command=$(printf %s ${shellQuote(encoded)} | base64 -d)`,
      `trap ':' INT`,
      `eval \"$__grounded_command\"`,
      `__grounded_status=$?`,
      `trap - INT`,
      `__grounded_cwd=$PWD`,
      `printf ${shellQuote(marker)} >&1`,
      ...(!this.pty ? [`printf ${shellQuote(marker)} >&2`] : []),
      `${shellQuote(process.execPath)} -e ${shellQuote(FRAME_WRITER)} complete ${requestId} ${this.generation} ${sequence} \"$__grounded_cwd\" \"$__grounded_status\" ${fence} >&3`,
      `unset __grounded_command __grounded_status __grounded_cwd`,
      "",
    ].join("\n");
    this.writeCommandScript(wrapper);
    return result;
  }

  input(data: Buffer): void {
    if (!this.pty) throw new SessionServiceError("SESSION_INPUT_REQUIRES_PTY", "Session input requires a PTY session");
    if (this.state !== "running") {
      throw new SessionServiceError("SESSION_INPUT_NOT_RUNNING", `PTY input requires a running command: ${this.state}`);
    }
    if (this.child.stdin?.destroyed) throw new SessionServiceError("SESSION_INPUT_CLOSED", "PTY input is closed");
    this.child.stdin?.write(data);
    this.lastActivityAt = Date.now();
  }

  interrupt(): void {
    if (this.state !== "running") return;
    this.requestCancellation(false);
  }

  whenClosed(): Promise<void> {
    return this.closed;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.clearIdleClose();
      if (this.state === "closed") return;
      this.state = "closing";
      this.rejectOpen(new SessionServiceError("SESSION_CLOSED", "Session closed during open"));
      this.rejectActive(new SessionServiceError("SESSION_CLOSED", "Session closed"));
      signalProcessGroup(this.child, "SIGTERM");
      await Promise.race([this.closed, new Promise<void>((resolve) => setTimeout(resolve, this.closeTimeoutMs))]);
      if (this.child.exitCode === null && this.child.signalCode === null) signalProcessGroup(this.child, "SIGKILL");
      await Promise.race([this.closed, new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
      this.state = "closed";
      await this.log.close();
    })();
    return this.closePromise;
  }

  private writeCommandScript(script: string): void {
    this.commandInput.write(this.pty ? `${Buffer.from(script, "utf8").toString("base64")}\n` : script);
  }

  private receiveControl(chunk: Buffer): void {
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      this.markTainted((error as Error).message);
      return;
    }
    for (const frame of frames) {
      if (frame.generation !== this.generation) {
        this.markTainted("Session control generation mismatch");
        return;
      }
      if (frame.action === "ready") {
        if (this.state !== "opening" || frame.requestId !== this.openRequestId || frame.sequence !== 0) {
          this.markTainted("Unexpected session ready frame");
          return;
        }
        this.cwd = frame.cwd;
        this.state = "idle";
        this.lastActivityAt = Date.now();
        this.resolveOpen();
        continue;
      }
      const active = this.active;
      if (!active || frame.requestId !== active.requestId || frame.sequence !== this.controlSequence || frame.fence !== active.fence) {
        this.markTainted("Unexpected session completion frame");
        return;
      }
      active.control = frame;
      this.maybeComplete();
    }
  }

  private receiveOutput(stream: SessionStream, chunk: Buffer): void {
    const active = this.active;
    if (!active) {
      if (chunk.length > 0) this.markTainted(`Unexpected ${stream} bytes while no command is active`);
      return;
    }
    const parser = stream === "stdout" ? active.stdoutFence : stream === "stderr" ? active.stderrFence : active.terminalFence;
    const parsed = parser.push(chunk);
    for (const bytes of parsed.data) this.appendOutput(active, stream, bytes);
    if (parsed.found) {
      if (stream === "stdout") active.stdoutDone = true;
      else if (stream === "stderr") active.stderrDone = true;
      else active.terminalDone = true;
    }
    if (parsed.unexpected?.length) {
      this.markTainted(`Unexpected ${stream} bytes after the command fence`);
      return;
    }
    this.maybeComplete();
  }

  private appendOutput(active: ActiveCommand, stream: SessionStream, bytes: Buffer): void {
    if (bytes.length === 0) return;
    const chunk: SessionOutputChunk = {
      sequence: active.nextChunkSequence++,
      stream,
      dataBase64: bytes.toString("base64"),
      bytes: bytes.length,
    };
    if (stream === "stdout") active.stdoutBytes += bytes.length;
    else if (stream === "stderr") active.stderrBytes += bytes.length;
    else active.terminalBytes += bytes.length;
    active.chunks.push(chunk);
    active.retainedBytes += bytes.length;
    this.log.append(active.requestId, chunk.sequence, stream, bytes);
    while (active.retainedBytes > MAX_MEMORY_OUTPUT_BYTES && active.chunks.length > 1) {
      const dropped = active.chunks.shift()!;
      active.retainedBytes -= dropped.bytes;
      active.truncated = true;
    }
  }

  private maybeComplete(): void {
    const active = this.active;
    if (!active?.control || active.finishing) return;
    if (this.pty ? !active.terminalDone : !active.stdoutDone || !active.stderrDone) return;
    active.finishing = true;
    void this.completeActive(active);
  }

  private async completeActive(active: ActiveCommand): Promise<void> {
    try {
      await this.log.flush();
    } catch (error) {
      this.markTainted(`Session log flush failed: ${(error as Error).message}`);
      return;
    }
    if (this.active !== active) return;
    this.clearActiveTimers(active);
    this.active = undefined;
    if (this.state === "tainted" || this.state === "closing" || this.state === "closed") {
      active.reject(new SessionServiceError("SESSION_TAINTED", "Session became unavailable before command completion"));
      return;
    }
    this.cwd = active.control!.cwd;
    this.state = "idle";
    this.lastActivityAt = Date.now();
    this.scheduleIdleClose(this.idleTimeoutMs);
    active.resolve({
      requestId: active.requestId,
      exitCode: active.control!.exitCode,
      signal: active.control!.signal as NodeJS.Signals | null,
      cwd: this.cwd,
      cancelled: active.cancelled,
      timedOut: active.timedOut,
      stdoutBytes: active.stdoutBytes,
      stderrBytes: active.stderrBytes,
      terminalBytes: active.terminalBytes,
      truncated: active.truncated,
      chunks: active.chunks,
      logPath: this.log.path,
    });
  }

  private requestCancellation(timedOut: boolean): void {
    const active = this.active;
    if (!active || this.state !== "running") return;
    active.cancelled = true;
    active.timedOut ||= timedOut;
    if (this.pty) this.child.stdin?.write(Buffer.from([3]));
    else signalProcessGroup(this.child, "SIGINT");
    if (!active.terminateTimer) {
      active.terminateTimer = setTimeout(() => {
        if (this.active === active) signalProcessGroup(this.child, "SIGTERM");
      }, 2000);
      active.terminateTimer.unref();
      active.killTimer = setTimeout(() => {
        if (this.active === active) signalProcessGroup(this.child, "SIGKILL");
      }, 3000);
      active.killTimer.unref();
    }
  }

  private rejectActive(error: Error): void {
    const active = this.active;
    if (!active) return;
    this.clearActiveTimers(active);
    this.active = undefined;
    active.reject(error);
  }

  private clearActiveTimers(active: ActiveCommand): void {
    if (active.timeout) clearTimeout(active.timeout);
    if (active.terminateTimer) clearTimeout(active.terminateTimer);
    if (active.killTimer) clearTimeout(active.killTimer);
    if (active.signal && active.abortListener) active.signal.removeEventListener("abort", active.abortListener);
  }

  private markTainted(reason: string): void {
    if (this.state === "closed" || this.state === "closing") return;
    this.taintReason = reason;
    this.state = "tainted";
    const error = new SessionServiceError("SESSION_TAINTED", reason);
    this.rejectOpen(error);
    this.rejectActive(error);
    try {
      signalProcessGroup(this.child, "SIGTERM");
    } catch {
      // The close event owns final cleanup.
    }
  }

  private scheduleIdleClose(milliseconds: number): void {
    this.clearIdleClose();
    if (milliseconds <= 0) return;
    this.idleTimer = setTimeout(() => void this.close(), milliseconds);
    this.idleTimer.unref();
  }

  private clearIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}

export class LocalSessionProvider implements SessionProvider {
  readonly id = "grounded-local-v1";
  readonly backend = "local" as const;
  readonly protocolVersion = SESSION_PROVIDER_PROTOCOL_VERSION;
  private nextGeneration = 1;

  capabilities() {
    return {
      backend: this.backend,
      providerId: this.id,
      protocolVersion: this.protocolVersion,
      pty: process.platform !== "win32",
      input: process.platform !== "win32",
    };
  }

  async open(request: SessionOpenRequest): Promise<SessionBackendHandle> {
    return LocalSessionHandle.open(request, this.nextGeneration++);
  }
}
