import {
  execFile,
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";

export const DEFAULT_WAIT_MS = 30_000;
export const MAX_WAIT_MS = 600_000;
export const POLL_WORK_MS = 5_000;

export class WaitStopped extends Error {
  constructor(readonly kind: "deadline" | "abort") {
    super(kind === "deadline" ? "WAIT_DEADLINE_EXCEEDED" : "Wait aborted");
  }
}

/** One admission budget. Started I/O and delivery bookkeeping must still settle. */
export class WaitScope {
  readonly deadline: number;
  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  private readonly abort = () => this.stop("abort");

  constructor(
    startedAt: number,
    timeoutMs: number,
    private readonly hostSignal?: AbortSignal,
  ) {
    this.deadline = startedAt + (timeoutMs === 0 ? POLL_WORK_MS : timeoutMs);
    this.timer = setTimeout(() => this.stop("deadline"), this.remainingMs());
    this.timer.unref?.();
    hostSignal?.addEventListener("abort", this.abort, { once: true });
    if (hostSignal?.aborted) this.stop("abort");
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  remainingMs(): number {
    return Math.max(0, this.deadline - performance.now());
  }

  stop(reason: WaitStopped["kind"] | Error = "abort"): void {
    if (!this.signal.aborted)
      this.controller.abort(typeof reason === "string" ? new WaitStopped(reason) : reason);
  }

  check(): void {
    if (this.remainingMs() <= 0) this.stop("deadline");
    if (this.signal.aborted) throw this.signal.reason;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.hostSignal?.removeEventListener("abort", this.abort);
  }

  async delay(ms: number): Promise<void> {
    this.check();
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.signal.removeEventListener("abort", finish);
        try {
          this.check();
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      const timer = setTimeout(finish, Math.min(ms, this.remainingMs()));
      this.signal.addEventListener("abort", finish, { once: true });
      if (this.signal.aborted) finish();
    });
  }
}

/** Only for wait-owned read commands. An abort callback alone is not a close receipt. */
export async function runWaitCommand(
  scope: WaitScope,
  binary: string,
  args: string[],
  options: Omit<ExecFileOptionsWithStringEncoding, "signal" | "timeout" | "killSignal">,
): Promise<{ stdout: string; stderr: string }> {
  scope.check();
  let failure: ExecFileException | null = null;
  let output = { stdout: "", stderr: "" };
  let callbackDone = (): void => undefined;
  const callback = new Promise<void>((resolve) => { callbackDone = resolve; });
  const child = execFile(binary, args, { ...options, killSignal: "SIGKILL" },
    (error, stdout, stderr) => {
      // Match promisified execFile errors, including Herdr's JSON stderr code.
      failure = error ? Object.assign(error, { stdout, stderr }) : null;
      output = { stdout, stderr };
      callbackDone();
    });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const abort = () => { child.kill("SIGKILL"); };
  scope.signal.addEventListener("abort", abort, { once: true });
  if (scope.signal.aborted) abort();
  try {
    // Neither promise rejects early. Join callback and process/stdio closure.
    await Promise.all([callback, closed]);
  } finally {
    scope.signal.removeEventListener("abort", abort);
  }
  scope.check();
  if (failure) throw failure;
  return output;
}
