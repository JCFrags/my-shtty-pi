import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, createWriteStream, fchmodSync, openSync, type WriteStream } from "node:fs";
import { access, chmod, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import type { ExecutionRequest, ExecutionResult } from "./check-types.ts";
import { acquireAdmission, boundedWait, ownProcess, ResourceLaunchError, type AdmissionLease } from "./resource-launch.ts";

const OUTPUT_CEILING = 8 * 1024 * 1024;
const TIMEOUT_CEILING = 300_000;
const bounded = (value: number | undefined, fallback: number, ceiling: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(ceiling, Math.floor(value))) : fallback;

type Owner = ReturnType<typeof ownProcess>;
interface ActiveCheck {
  id: string;
  request: ExecutionRequest;
  startedAt: number;
  controller: AbortController;
  outcome?: ExecutionResult["outcome"];
  message?: string;
  owner?: Owner;
  child?: ChildProcessWithoutNullStreams;
  done?: Promise<ExecutionResult>;
  finalized?: Promise<void>;
  state: "preparing" | "running" | "stopping" | "close-unconfirmed" | "log-flush-unconfirmed";
}
interface StreamLog {
  path: string;
  stream: WriteStream;
  closed: Promise<void>;
  isClosed: boolean;
  error?: Error;
}

async function executablePath(command: string, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string | undefined> {
  if (!command || command.includes("\0")) return undefined;
  const direct = isAbsolute(command) || command.includes("/") || (process.platform === "win32" && command.includes("\\"));
  const directories = direct ? [""] : (env.PATH ?? (process.platform === "win32" ? "" : "/usr/bin:/bin")).split(delimiter);
  const suffixes = process.platform === "win32" && !/\.[^/\\]+$/.test(command) ? ["", ...(env.PATHEXT ?? ".EXE;.COM").split(";")] : [""];
  for (const directory of directories) {
    for (const suffix of suffixes) {
      if (signal?.aborted) return undefined;
      const path = resolve(cwd, directory, `${command}${suffix}`);
      try {
        await access(path, constants.X_OK);
        if ((await stat(path)).isFile()) return path;
      } catch { /* Continue only through the caller's exact PATH candidates. */ }
    }
  }
  return undefined;
}

function openLog(path: string, onError: (error: Error) => void): StreamLog {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  let stream: WriteStream;
  try { fchmodSync(fd, 0o600); stream = createWriteStream(path, { fd, autoClose: true }); }
  catch (error) { closeSync(fd); throw error; }
  let resolveClosed!: () => void;
  const log: StreamLog = { path, stream, isClosed: false, closed: new Promise<void>((resolve) => { resolveClosed = resolve; }) };
  stream.once("close", () => { log.isClosed = true; resolveClosed(); });
  stream.on("error", (error) => { log.error = error; onError(error); });
  return log;
}

export interface CheckRuntimeOptions { concurrency?: number }

// Construction and availability probing do not create processes, timers, locks,
// or log directories. One instance owns only the executions it starts.
export class CheckRuntime {
  private readonly concurrency: number;
  private readonly active = new Map<string, ActiveCheck>();
  private directory?: Promise<string>;
  private directoryPath?: string;
  private closing = false;
  private shutdownPromise?: Promise<void>;

  constructor(options: CheckRuntimeOptions = {}) {
    this.concurrency = bounded(options.concurrency, 2, 2);
  }

  async available(command: string, cwd = process.cwd()): Promise<{ available: boolean; path?: string }> {
    const path = await executablePath(command, resolve(cwd), { ...process.env });
    return path ? { available: true, path } : { available: false };
  }

  status(): unknown {
    return {
      shutdown: this.closing, concurrency: this.concurrency, active: this.active.size,
      timeoutCeilingMs: TIMEOUT_CEILING, capturedOutputCeilingBytes: OUTPUT_CEILING,
      ...(this.directoryPath ? { logDirectory: this.directoryPath } : {}),
      checks: [...this.active.values()].map((entry) => ({
        id: entry.id, command: entry.request.command, cwd: entry.request.cwd,
        startedAt: entry.startedAt, state: entry.state, ...(entry.child?.pid ? { pid: entry.child.pid } : {}),
      })),
      resourceNotes: ["Session concurrency, output, and time budgets are not RSS containment.", "Status describes this owner, not a fleet census. Retained logs have no disk quota."],
    };
  }

  execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const immediate = (outcome: ExecutionResult["outcome"], message: string): Promise<ExecutionResult> => Promise.resolve({
      outcome, command: request.command, args: [...request.args], cwd: request.cwd,
      exitCode: null, signal: null, stdout: "", stderr: "", startedAt, durationMs: 0, message,
      resourceNotes: ["No process was started."],
    });
    if (this.closing) return immediate("cancelled", "Check runtime is shut down");
    if (request.signal?.aborted) return immediate("cancelled", "Check execution cancelled before startup");
    if (this.active.size >= this.concurrency) return immediate("busy", `All ${this.concurrency} session check slots are busy; no check was queued`);
    const entry: ActiveCheck = {
      id: randomUUID(), request: { ...request, args: [...request.args], cwd: resolve(request.cwd), env: { ...(request.env ?? process.env) } },
      startedAt, controller: new AbortController(), state: "preparing",
    };
    this.active.set(entry.id, entry);
    entry.done = this.run(entry);
    return entry.done;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    const entries = [...this.active.values()];
    for (const entry of entries) this.cancel(entry, "cancelled", "Check execution cancelled by runtime shutdown");
    this.shutdownPromise = (async () => {
      await Promise.all(entries.map((entry) => entry.done));
      for (const entry of this.active.values()) {
        if (entry.owner) await entry.owner.stop();
        if (entry.finalized && !await boundedWait(entry.finalized, 2000)) throw new Error("Owned check log flush is unconfirmed during shutdown");
      }
      if (this.active.size) throw new Error("Owned check cleanup is unconfirmed during shutdown");
    })();
    return this.shutdownPromise;
  }

  private cancel(entry: ActiveCheck, outcome: ExecutionResult["outcome"], message: string): void {
    // I/O or ownership failure takes precedence over a check-level interruption.
    if (!entry.outcome || outcome === "failed") { entry.outcome = outcome; entry.message = message; }
    entry.state = "stopping";
    entry.controller.abort();
  }

  private logDirectory(): Promise<string> {
    return this.directory ??= (async () => {
      const directory = await mkdtemp(join(tmpdir(), "pi-grounded-checks-"));
      await chmod(directory, 0o700);
      this.directoryPath = directory;
      return directory;
    })();
  }

  private async run(entry: ActiveCheck): Promise<ExecutionResult> {
    const { request } = entry;
    const timeoutMs = bounded(request.timeoutMs, 60_000, TIMEOUT_CEILING);
    const maximumBytes = bounded(request.maxOutputBytes, OUTPUT_CEILING, OUTPUT_CEILING);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const logs: StreamLog[] = [];
    let capturedBytes = 0;
    let lease: AdmissionLease | undefined;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let removeStop: (() => void) | undefined;
    const resourceNotes = [
      `Session check admission: ${this.concurrency} slots. Captured stdout and stderr share a ${maximumBytes}-byte budget.`,
      `Execution timeout: ${timeoutMs} ms, then bounded owned TERM/KILL and log-close waits.`,
      "Logs retain exact separate stream bytes until close. They are private files, not a disk quota.",
      "These limits do not contain RSS, native allocations, daemonized descendants, or nonparticipating processes.",
    ];
    const onAbort = () => this.cancel(entry, "cancelled", "Check execution cancelled");
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => this.cancel(entry, "timeout", `Check execution exceeded ${timeoutMs} ms`), timeoutMs);
    if (request.signal?.aborted) onAbort();
    try {
      const env = request.env ?? process.env;
      const cwd = resolve(request.cwd);
      const command = await executablePath(request.command, cwd, env, entry.controller.signal);
      if (entry.controller.signal.aborted) return this.result(entry, stdout, stderr, logs, exitCode, exitSignal, resourceNotes);
      if (!command) {
        entry.outcome = "unavailable"; entry.message = "The requested executable is not available in this environment";
        return this.result(entry, stdout, stderr, logs, exitCode, exitSignal, resourceNotes);
      }
      if (request.resourceClass === "expensive" && process.platform === "linux") {
        lease = await acquireAdmission("checks");
        resourceNotes.push("Linux UID-scoped shared expensive-check admission: at most 2 participating checks. The foreground child inherits descriptor 3.");
      } else if (request.resourceClass === "expensive") {
        resourceNotes.push("UID-scoped shared expensive-check admission is unavailable on this platform; only the session bound applies.");
      }
      if (entry.controller.signal.aborted) return this.result(entry, stdout, stderr, logs, exitCode, exitSignal, resourceNotes);
      const directory = await this.logDirectory();
      if (entry.controller.signal.aborted) return this.result(entry, stdout, stderr, logs, exitCode, exitSignal, resourceNotes);
      const logError = (error: Error) => this.cancel(entry, "failed", `Exact output log failed: ${error.message}`);
      logs.push(openLog(join(directory, `${entry.id}.stdout.log`), logError));
      logs.push(openLog(join(directory, `${entry.id}.stderr.log`), logError));
      const child = spawn(command, [...request.args], {
        cwd, env, detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe", ...(lease ? [lease.fd] : [])],
      }) as ChildProcessWithoutNullStreams;
      entry.child = child;
      const owner = ownProcess(child);
      entry.owner = owner;
      entry.state = "running";
      child.once("close", (code, signal) => { clearTimeout(timer); exitCode = code; exitSignal = signal; });
      child.once("error", (error: NodeJS.ErrnoException) => this.cancel(entry,
        error.code === "ENOENT" || error.code === "EACCES" ? "unavailable" : "failed", `Check spawn failed: ${error.message}`));
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") this.cancel(entry, "failed", `Check stdin failed: ${error.message}`);
      });
      const collect = (source: Readable, log: StreamLog, target: Buffer[], chunk: Buffer) => {
        if (!log.error && !log.stream.write(chunk)) {
          source.pause();
          log.stream.once("drain", () => source.resume());
        }
        const remaining = maximumBytes - capturedBytes;
        if (remaining > 0) { const saved = Buffer.from(chunk.subarray(0, remaining)); target.push(saved); capturedBytes += saved.length; }
        if (chunk.length > remaining) this.cancel(entry, "output-limit", `Check captured output exceeded ${maximumBytes} bytes`);
      };
      child.stdout.on("data", (chunk: Buffer) => collect(child.stdout, logs[0], stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(child.stderr, logs[1], stderr, chunk));
      for (const source of [child.stdout, child.stderr]) source.on("error", (error) => this.cancel(entry, "failed", `Check output stream failed: ${error.message}`));
      for (const log of logs) log.stream.on("error", () => { child.stdout.resume(); child.stderr.resume(); });
      let resolveStopped!: () => void;
      const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
      const stop = () => { void owner.stop().catch((error) => {
        entry.outcome = "failed"; entry.message = String(error); entry.state = "close-unconfirmed";
      }).finally(resolveStopped); };
      child.once("exit", stop);
      entry.controller.signal.addEventListener("abort", stop, { once: true });
      removeStop = () => entry.controller.signal.removeEventListener("abort", stop);
      entry.finalized = owner.closed.then(async () => {
        for (const log of logs) if (!log.stream.destroyed) log.stream.end();
        await Promise.all(logs.map((log) => log.closed));
        await owner.stop();
        lease?.release();
        this.active.delete(entry.id);
      });
      // Keep exact ownership after an unconfirmed close, without an unhandled rejection.
      void entry.finalized.catch(() => undefined);
      if (entry.controller.signal.aborted) stop();
      else child.stdin.end(request.stdin);
      await Promise.race([owner.closed, stopped]);
      if (!owner.isClosed()) {
        entry.outcome = "failed"; entry.message = "Owned check close is unconfirmed after TERM/KILL"; entry.state = "close-unconfirmed";
      } else {
        try {
          if (!await boundedWait(entry.finalized, 2500)) {
            entry.outcome = "failed"; entry.message = "Owned check log flush is unconfirmed"; entry.state = "log-flush-unconfirmed";
          }
        } catch (error) { entry.outcome = "failed"; entry.message = String(error); }
      }
    } catch (error) {
      if (!entry.outcome || !(error instanceof ResourceLaunchError)) {
        entry.outcome = error instanceof ResourceLaunchError ? (error.reason === "busy" ? "busy" : "unavailable") : "failed";
        entry.message = error instanceof Error ? error.message : String(error);
      }
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      removeStop?.();
      if (!entry.owner) {
        lease?.release();
        for (const log of logs) if (!log.stream.destroyed) log.stream.end();
        const finalized = Promise.all(logs.map((log) => log.closed)).then(() => { this.active.delete(entry.id); });
        entry.finalized = finalized;
        if (!await boundedWait(finalized, 2000)) {
          entry.outcome = "failed"; entry.message = "Check log close is unconfirmed before spawn"; entry.state = "log-flush-unconfirmed";
        }
      }
    }
    return this.result(entry, stdout, stderr, logs, exitCode, exitSignal, resourceNotes);
  }

  private result(entry: ActiveCheck, stdout: Buffer[], stderr: Buffer[], logs: StreamLog[], exitCode: number | null, signal: string | null, resourceNotes: string[]): ExecutionResult {
    return {
      outcome: entry.outcome ?? (signal ? "failed" : "completed"), command: entry.request.command,
      args: [...entry.request.args], cwd: entry.request.cwd, exitCode, signal,
      stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"),
      ...(logs[0] ? { stdoutLog: logs[0].path } : {}), ...(logs[1] ? { stderrLog: logs[1].path } : {}),
      startedAt: entry.startedAt, durationMs: Date.now() - entry.startedAt,
      ...(entry.child?.pid ? { pid: entry.child.pid } : {}), ...(entry.message ? { message: entry.message } : {}), resourceNotes,
    };
  }
}
