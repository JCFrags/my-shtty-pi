import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { basename, join } from "node:path";
import type { LspClientOptions, LspServerConfig } from "@grounded/pi-core/lsp-client";

export class RustLaunchError extends Error {
  readonly reason: "busy" | "launcher-unavailable";
  constructor(reason: "busy" | "launcher-unavailable", message: string) {
    super(message);
    this.reason = reason;
  }
}

export function isRustServer(server: LspServerConfig): boolean {
  return server.id === "rust-analyzer" || basename(server.command) === "rust-analyzer"
    || server.extensions.some((extension) => extension.toLowerCase() === ".rs")
    || [server.languageId, ...Object.values(server.languageIds ?? {})].some((language) => language.toLowerCase() === "rust");
}

export function rustLauncherAvailability(): { available: boolean; reason?: string } {
  if (process.platform !== "linux" || !Number.isInteger(process.getuid?.())) {
    return { available: false, reason: "Rust requires Linux uid-scoped flock admission" };
  }
  try {
    accessSync("/usr/bin/flock", constants.X_OK);
    return { available: true };
  } catch { return { available: false, reason: "executable /usr/bin/flock is required for Rust" }; }
}

// These arguments are internal fixture seams. No environment or user config can
// replace the production namespace, platform requirement, or admission command.
export function createRustLauncher(fixture: {
  directory?: string;
  flockCommand?: string;
  utilityTimeoutMs?: number;
  killWaitMs?: number;
} = {}): NonNullable<LspClientOptions["launch"]> {
  return async (config, root) => {
    const availability = rustLauncherAvailability();
    if (!availability.available) throw new RustLaunchError("launcher-unavailable", availability.reason!);
    const uid = process.getuid!();
    const directory = fixture.directory ?? `/tmp/pi-grounded-lsp-${uid}`;
    const path = join(directory, "rust.lock");
    let fd: number;
    try {
      try { mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const before = lstatSync(directory);
      if (!before.isDirectory() || before.uid !== uid || (before.mode & 0o077) !== 0) throw new Error("unsafe lock directory");
      fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try {
        const file = fstatSync(fd);
        const named = lstatSync(path);
        const after = lstatSync(directory);
        if (!file.isFile() || file.uid !== uid || (file.mode & 0o077) !== 0 || file.nlink !== 1
          || named.dev !== file.dev || named.ino !== file.ino || named.isSymbolicLink()
          || before.dev !== after.dev || before.ino !== after.ino || !after.isDirectory()
          || after.uid !== uid || (after.mode & 0o077) !== 0) throw new Error("unsafe lock file or changed directory");
      } catch (error) { closeSync(fd); throw error; }
    } catch (error) { throw new RustLaunchError("launcher-unavailable", `Rust safe launcher unavailable: ${String(error)}`); }

    let released = false;
    const release = () => { if (!released) { released = true; closeSync(fd); } };
    await new Promise<void>((resolve, reject) => {
      // flock(2) attaches to the shared open file description. After this short
      // utility exits, our descriptor still owns the lock. No unlock or unlink.
      let utility;
      try {
        utility = spawn(fixture.flockCommand ?? "/usr/bin/flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "75", "3"], {
          stdio: ["ignore", "ignore", "ignore", fd],
        });
      } catch (error) { release(); reject(new RustLaunchError("launcher-unavailable", String(error))); return; }
      let timedOut = false;
      let failure: Error | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        utility.kill("SIGKILL");
        killTimer = setTimeout(() => reject(new RustLaunchError("launcher-unavailable", "Rust admission utility close is unconfirmed")), fixture.killWaitMs ?? 500);
      }, fixture.utilityTimeoutMs ?? 1000);
      utility.once("error", (error) => { failure = error; });
      utility.once("close", (code) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (code === 0 && !timedOut && !failure) { resolve(); return; }
        release();
        reject(new RustLaunchError(code === 75 && !timedOut && !failure ? "busy" : "launcher-unavailable",
          code === 75 && !timedOut && !failure ? "Rust slot is busy in another participating process" : `Rust admission failed: ${failure?.message ?? (timedOut ? "utility timeout" : `exit ${code}`)}`));
      });
      // If close stays uncertain, its listener retains this descriptor. Never
      // launch a server or free admission merely because the wait timed out.
    });
    try {
      const child = spawn(config.command, config.args, {
        cwd: root, env: process.env, stdio: ["pipe", "pipe", "pipe", fd],
      }) as ChildProcessWithoutNullStreams;
      child.once("close", release);
      return { child, release };
    } catch (error) { release(); throw error; }
  };
}
