import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** A kernel lock, never a timestamp/PID lock. The anonymous control pipe releases
 * it after client death. Only short metadata transactions run under this lock. */
export async function withRuntimeMutex<T>(path: string, action: () => Promise<T>): Promise<T> {
  if (process.platform !== "linux") throw new Error("worker-containment-unavailable");
  const handle = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("unsafe-scheduler-artifact");
    const child = spawn("/usr/bin/flock", ["--exclusive", "--timeout", "15", "/proc/self/fd/3", process.execPath, "-e", "process.stdout.write('ready');process.stdin.resume()"], { stdio: ["pipe", "pipe", "ignore", handle.fd], env: { PATH: "/usr/bin:/bin" } });
    const closed = new Promise<void>(resolve => child.on("close", () => resolve()));
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once("data", () => resolve());
      child.once("error", () => reject(new Error("worker-containment-unavailable")));
      child.once("exit", () => reject(new Error("scheduler-timeout")));
    });
    try { return await action(); }
    finally { child.stdin!.end(); await closed; }
  } finally { await handle.close(); }
}
