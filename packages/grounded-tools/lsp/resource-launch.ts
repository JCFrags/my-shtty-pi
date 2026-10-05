import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";

export class ResourceLaunchError extends Error {
  constructor(readonly reason: "busy" | "launcher-unavailable", message: string) { super(message); }
}

export interface AdmissionLease {
  readonly fd: number;
  release(): void;
}

export function resourceLauncherAvailability(): { available: boolean; reason?: string } {
  if (process.platform !== "linux" || !Number.isInteger(process.getuid?.())) {
    return { available: false, reason: "Shared admission requires Linux uid-scoped flock" };
  }
  try { accessSync("/usr/bin/flock", constants.X_OK); return { available: true }; }
  catch { return { available: false, reason: "Shared admission requires executable /usr/bin/flock" }; }
}

export function boundedWait(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), milliseconds);
    promise.then(() => { clearTimeout(timer); resolve(true); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

// The caller must create a fresh detached process group on POSIX. No PID search,
// unrelated process, or shared lock owner is used for cleanup.
export function ownProcess(child: ChildProcess): {
  readonly closed: Promise<void>;
  isClosed(): boolean;
  signal(signal: NodeJS.Signals): void;
  stop(): Promise<void>;
} {
  let closed = false;
  let resolveClosed!: () => void;
  let stopping: Promise<void> | undefined;
  let retired = false;
  const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
  child.once("close", () => { closed = true; resolveClosed(); });
  const groupExists = () => {
    if (process.platform === "win32" || !child.pid) return !closed;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  };
  const signal = (value: NodeJS.Signals) => {
    if (retired) return;
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, value);
      else if (!closed) child.kill(value);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  const stop = (): Promise<void> => {
    if (retired) return Promise.resolve();
    if (stopping) return stopping;
    const attempt = (async () => {
      if (closed && !groupExists()) return;
      const started = Date.now();
      signal("SIGTERM");
      await boundedWait(closedPromise, 500);
      // The leader can close before its foreground descendants. Finish cleanup
      // within this ownership epoch, never through a replacement launcher.
      if (groupExists()) {
        const remaining = 500 - (Date.now() - started);
        if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
        signal("SIGKILL");
      }
      if (!await boundedWait(closedPromise, 1000)) throw new Error("Owned process close is unconfirmed after TERM/KILL");
    })();
    stopping = attempt;
    void attempt.then(() => { retired = true; }, () => { if (stopping === attempt) stopping = undefined; });
    return attempt;
  };
  // A leader exit can otherwise leave inherited pipes open until a long timeout.
  child.once("exit", () => { void stop().catch(() => undefined); });
  return { closed: closedPromise, isClosed: () => closed, signal, stop };
}

function openSlot(path: string, directory: string, uid: number): AdmissionLease {
  let fd: number | undefined;
  try {
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const before = lstatSync(directory);
    if (!before.isDirectory() || before.uid !== uid || (before.mode & 0o077) !== 0) throw new Error("unsafe admission directory");
    fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    const file = fstatSync(fd);
    const named = lstatSync(path);
    const after = lstatSync(directory);
    if (!file.isFile() || file.uid !== uid || (file.mode & 0o077) !== 0 || file.nlink !== 1
      || named.dev !== file.dev || named.ino !== file.ino || named.isSymbolicLink()
      || before.dev !== after.dev || before.ino !== after.ino || !after.isDirectory()
      || after.uid !== uid || (after.mode & 0o077) !== 0) throw new Error("unsafe admission file or changed directory");
    const descriptor = fd;
    let released = false;
    return { fd: descriptor, release: () => { if (!released) { released = true; closeSync(descriptor); } } };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    throw new ResourceLaunchError("launcher-unavailable", `Safe shared admission unavailable: ${String(error)}`);
  }
}

async function lockSlot(lease: AdmissionLease): Promise<boolean> {
  let utility: ChildProcess;
  try {
    // flock locks the shared open file description. Parent and foreground child
    // retain it through inherited descriptors. Never unlock or unlink the file.
    utility = spawn("/usr/bin/flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "75", "3"], {
      detached: true, stdio: ["ignore", "ignore", "ignore", lease.fd],
    });
  } catch (error) { lease.release(); throw new ResourceLaunchError("launcher-unavailable", String(error)); }
  const owner = ownProcess(utility);
  let failure: Error | undefined;
  utility.once("error", (error) => { failure = error; });
  if (!await boundedWait(owner.closed, 1000)) {
    try { await owner.stop(); }
    catch {
      // An uncertain utility retains this exact descriptor until its real close.
      void owner.closed.then(() => lease.release());
      throw new ResourceLaunchError("launcher-unavailable", "Admission utility close is unconfirmed");
    }
    lease.release();
    throw new ResourceLaunchError("launcher-unavailable", "Admission utility timed out");
  }
  if (!failure && utility.exitCode === 0) return true;
  lease.release();
  if (!failure && utility.exitCode === 75) return false;
  throw new ResourceLaunchError("launcher-unavailable", `Admission utility failed: ${failure?.message ?? utility.signalCode ?? utility.exitCode}`);
}

// Fixed namespaces are independent of HOME, TMPDIR, XDG, and repository paths.
// A smaller participant can use fewer slots, but cannot increase the fleet bound.
export async function acquireAdmission(pool: "checks" | "servers" | "expensive-servers", requestedSlots?: number): Promise<AdmissionLease> {
  const availability = resourceLauncherAvailability();
  if (!availability.available) throw new ResourceLaunchError("launcher-unavailable", availability.reason!);
  const maximum = pool === "servers" ? 4 : 2;
  const slots = Number.isInteger(requestedSlots) ? Math.max(1, Math.min(maximum, requestedSlots!)) : maximum;
  const uid = process.getuid!();
  const directory = `/tmp/pi-grounded-admission-${uid}`;
  for (let index = 0; index < slots; index++) {
    const lease = openSlot(join(directory, `${pool}-${index}.lock`), directory, uid);
    if (await lockSlot(lease)) return lease;
  }
  throw new ResourceLaunchError("busy", `All ${slots} participating ${pool} slots are busy`);
}

export interface ResourceServerConfig {
  id: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  resourceClass?: "normal" | "expensive";
  nodeHeapMb?: number;
  jvmHeapMb?: number;
}

export interface ResourceLaunch {
  child: ChildProcessWithoutNullStreams;
  release(): void;
  signal(signal: NodeJS.Signals): void;
  stop(): Promise<void>;
  resourceNotes: string[];
}

export interface ResourceLauncher {
  (config: ResourceServerConfig, root: string): Promise<ResourceLaunch>;
  status(): unknown;
}

export interface ResourceLauncherOptions {
  slots?: number;
  expensiveSlots?: number;
  nodeHeapMb?: number;
  jvmHeapMb?: number;
  isExpensive?: (config: ResourceServerConfig) => boolean;
}

function heapEnvironment(config: ResourceServerConfig, options: ResourceLauncherOptions): NodeJS.ProcessEnv {
  const env = { ...(config.env ?? process.env) };
  const apply = (key: string, prefix: string, value: number | undefined) => {
    if (value === undefined) return;
    if (!Number.isInteger(value) || value < 64 || value > 8192) throw new ResourceLaunchError("launcher-unavailable", "Heap budgets must be integer MiB values from 64 to 8192");
    env[key] = `${env[key] ? `${env[key]} ` : ""}${prefix}${value}${key === "JAVA_TOOL_OPTIONS" ? "m" : ""}`;
  };
  apply("NODE_OPTIONS", "--max-old-space-size=", config.nodeHeapMb ?? options.nodeHeapMb);
  apply("JAVA_TOOL_OPTIONS", "-Xmx", config.jvmHeapMb ?? options.jvmHeapMb);
  return env;
}

// Construction has no resource effects. Use only for non-Rust foreground stdio
// servers. The existing Rust classifier and single-slot launcher remain owners.
export function createResourceLauncher(options: ResourceLauncherOptions = {}): ResourceLauncher {
  const active = new Map<ChildProcessWithoutNullStreams, { id: string; root: string }>();
  let pending = 0;
  const launch = async (config: ResourceServerConfig, root: string): Promise<ResourceLaunch> => {
    const env = heapEnvironment(config, options);
    const command = config.command;
    const args = [...config.args];
    const cwd = resolve(root);
    const leases: AdmissionLease[] = [];
    pending++;
    try {
      leases.push(await acquireAdmission("servers", options.slots));
      if (config.resourceClass === "expensive" || options.isExpensive?.(config)) leases.push(await acquireAdmission("expensive-servers", options.expensiveSlots));
      const child = spawn(command, args, {
        cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe", ...leases.map((lease) => lease.fd)],
      }) as ChildProcessWithoutNullStreams;
      const owner = ownProcess(child);
      // Guard asynchronous spawn errors even if the caller has not attached yet.
      child.on("error", () => undefined);
      let released = false;
      const release = () => {
        if (released || !owner.isClosed()) return;
        released = true;
        for (const lease of leases) lease.release();
      };
      active.set(child, { id: config.id, root: cwd });
      child.once("close", () => { release(); active.delete(child); });
      return {
        child, release, signal: owner.signal, stop: owner.stop,
        resourceNotes: [
          "UID-scoped participating non-Rust server admission: at most 4 slots, with at most 2 expensive-server slots.",
          "Foreground stdio and inherited admission descriptors are required. Daemonized or nonparticipating processes are not contained.",
          "Optional Node/JVM heap budgets limit selected managed heaps, not RSS or native allocations. Admission is not a hard memory cap.",
        ],
      };
    } catch (error) { for (const lease of leases) lease.release(); throw error; }
    finally { pending--; }
  };
  return Object.assign(launch, { status: () => ({
    availability: resourceLauncherAvailability(), pending, active: active.size,
    slots: Number.isInteger(options.slots) ? Math.max(1, Math.min(4, options.slots!)) : 4,
    expensiveSlots: Number.isInteger(options.expensiveSlots) ? Math.max(1, Math.min(2, options.expensiveSlots!)) : 2,
    sharedServerCeiling: 4, sharedExpensiveServerCeiling: 2,
    servers: [...active.entries()].map(([child, info]) => ({ ...info, pid: child.pid })),
    resourceNotes: ["Local owner status is not a fleet census or an RSS memory cap. The caller owns client concurrency and idle retirement."],
  }) });
}
