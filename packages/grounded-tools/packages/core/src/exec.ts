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
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    });
    const maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill("SIGKILL");
        reject(new Error(`Command output exceeded ${maxBytes} bytes`));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code,
        signal,
      });
    });
  });
}
