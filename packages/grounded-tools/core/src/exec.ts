import { spawn } from "node:child_process";

export interface CaptureResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function capture(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; maxBytes?: number } = {},
): Promise<CaptureResult> {
  const abortReason = () => options.signal?.reason instanceof Error
    ? options.signal.reason
    : new Error("Operation aborted");
  if (options.signal?.aborted) return Promise.reject(abortReason());

  return new Promise((resolve, reject) => {
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: useProcessGroup,
    });
    const maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let terminalError: Error | undefined;
    let settled = false;

    const killChildTree = () => {
      if (child.pid && useProcessGroup) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // Fall through to the direct child when the process group is already gone.
        }
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // The close or error event will settle the capture.
      }
    };
    const failAndKill = (error: Error) => {
      if (terminalError) return;
      terminalError = error;
      killChildTree();
    };
    const onAbort = () => failAndKill(abortReason());
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const collect = (target: Buffer[], chunk: Buffer) => {
      if (terminalError) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        failAndKill(new Error(`Command output exceeded ${maxBytes} bytes`));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => {
      if (!terminalError) terminalError = error;
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      if (terminalError) {
        reject(terminalError);
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code,
        signal,
      });
    });
  });
}
