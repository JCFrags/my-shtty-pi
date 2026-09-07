import { createHash } from "node:crypto";
import { createServer, createConnection, type Socket } from "node:net";
import { chmod, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { withRuntimeMutex } from "./worker-runtime-mutex.js";
import { WORKER_LIMITS } from "./worker-runtime-limits.js";

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0) throw new Error("unsafe-scheduler-directory");
}
export async function rendezvousDirectory(namespace: string): Promise<string> {
  const root = `/run/user/${process.getuid?.()}/chrono-rendezvous`;
  await privateDirectory(root);
  const directory = join(root, createHash("sha256").update(namespace).digest("hex").slice(0, 24));
  await privateDirectory(directory); return directory;
}
/** Local callers allow at most 250ms for a cancellation acknowledgement.
 * `confirmed` means the last waiter's execute promise completed its cleanup
 * contract (resolved or rejected with worker-aborted/worker-timeout) after abort;
 * `detached` means other waiters survive (or this caller never joined);
 * `unconfirmed` makes no claim about remote cleanup. Capacity is never evicted. */
export const WAITER_CANCELLATION_ALLOWANCE_MS = 250;
export class WaiterCancellationError extends Error {
  constructor(code: "worker-aborted" | "worker-timeout", readonly cancellationStatus: "confirmed" | "detached" | "unconfirmed") { super(code); }
}
type LocalWaiter = { check: () => void; sockets: Set<Socket>; joined: boolean };
async function connect(path: string, local: LocalWaiter): Promise<Socket | undefined> {
  return new Promise((resolve, reject) => {
    local.check();
    const socket = createConnection(path);
    local.sockets.add(socket);
    socket.on("close", () => { local.sockets.delete(socket); resolve(undefined); });
    socket.on("error", () => {});
    socket.once("connect", () => { resolve(socket); });
    socket.once("error", (error: NodeJS.ErrnoException) => { socket.destroy(); if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(undefined); else reject(new Error("worker-rendezvous-unavailable")); });
  });
}
/** Bounded in-flight cross-process coalescing. No payload/result is written to
 * shared storage. A dead leader has no cached result; followers retry admission,
 * while its still-running cgroup continues to own its fixed host slot. */
export async function coalesceHostJob<T>(namespace: string, identity: string, signal: AbortSignal | undefined, execute: (signal: AbortSignal, progress: (stage: string) => void) => Promise<T>, maxResultBytes: number, waiter: { deadlineMs?: number; onProgress?: (stage: string) => void } = {}): Promise<T> {
  const deadlineMs = waiter.deadlineMs ?? Date.now() + WORKER_LIMITS.timeoutSeconds.max * 1000;
  let reason: "worker-aborted" | "worker-timeout" | undefined;
  let allowance: ReturnType<typeof setTimeout> | undefined;
  let rejectBound!: (error: Error) => void;
  const local: LocalWaiter = { sockets: new Set(), joined: false, check: () => {
    if (reason) throw new WaiterCancellationError(reason, local.joined ? "unconfirmed" : "detached");
  } };
  const bound = new Promise<never>((_, reject) => { rejectBound = reject; });
  const cancel = (code: "worker-aborted" | "worker-timeout") => {
    if (reason) return;
    reason = code;
    allowance = setTimeout(() => rejectBound(new WaiterCancellationError(code, local.joined ? "unconfirmed" : "detached")), WAITER_CANCELLATION_ALLOWANCE_MS);
  };
  const abort = () => cancel("worker-aborted");
  const deadline = setTimeout(() => cancel("worker-timeout"), Math.max(0, deadlineMs - Date.now()));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  if (Date.now() >= deadlineMs) cancel("worker-timeout");
  try {
    return await Promise.race([bound, coalesceHostJobInner(namespace, identity, signal, execute, maxResultBytes, { ...waiter, deadlineMs }, local)]);
  } finally {
    clearTimeout(deadline); if (allowance) clearTimeout(allowance);
    signal?.removeEventListener("abort", abort);
    // Fence queued election callbacks even after a non-cancellation failure.
    reason ??= "worker-aborted";
    for (const socket of local.sockets) socket.destroy();
  }
}
async function coalesceHostJobInner<T>(namespace: string, identity: string, signal: AbortSignal | undefined, execute: (signal: AbortSignal, progress: (stage: string) => void) => Promise<T>, maxResultBytes: number, waiter: { deadlineMs: number; onProgress?: (stage: string) => void }, local: LocalWaiter): Promise<T> {
  if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error("worker-protocol-error");
  const deadlineMs = waiter.deadlineMs ?? Date.now() + WORKER_LIMITS.timeoutSeconds.max * 1000;
  local.check();
  const directory = await rendezvousDirectory(namespace);
  local.check();
  const path = join(directory, identity.slice(0, 48));
  for (;;) {
    local.check();
    if (signal?.aborted) throw new WaiterCancellationError("worker-aborted", "detached");
    if (Date.now() >= deadlineMs) throw new WaiterCancellationError("worker-timeout", "detached");
    const socket = await withRuntimeMutex(join(directory, "lock"), async () => {
      const existing = await connect(path, local);
      local.check();
      if (existing) return existing;
      // ECONNREFUSED under the election lock proves no listener. Never use a
      // PID, age, mtime, or a missing response to evict a live job.
      try { const metadata = await lstat(path); if (!metadata.isSocket() || metadata.uid !== process.getuid?.()) throw new Error("unsafe-rendezvous-artifact"); await rm(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      // Reclaim only refused sockets, so crashes do not consume the bounded table.
      const names = (await readdir(directory)).filter(name => /^[a-f0-9]{48}$/.test(name));
      for (const name of names) {
        const candidate = join(directory, name); const metadata = await lstat(candidate).catch(() => undefined);
        if (!metadata?.isSocket() || metadata.uid !== process.getuid?.()) continue;
        const live = await connect(candidate, local); local.check(); if (live) live.destroy(); else await rm(candidate, { force: true });
      }
      if ((await readdir(directory)).filter(name => /^[a-f0-9]{48}$/.test(name)).length >= WORKER_LIMITS.coalescedJobs) throw new Error("scheduler-queue-full");
      local.check();
      const controller = new AbortController();
      const peers = new Set<Socket>();
      let task: Promise<T> | undefined;
      let finished = false;
      let inode: number | undefined;
      let shutdownPromise: Promise<void> | undefined;
      const server = createServer(peer => {
        peer.on("error", () => {});
        let bytes = 0, buffer = "", joined = false, cancelled = false;
        let expiration: ReturnType<typeof setTimeout> | undefined;
        const leave = () => { if (expiration) clearTimeout(expiration); peers.delete(peer); if (joined && !finished && peers.size === 0) controller.abort(); };
        const cancel = (code: string) => {
          if (cancelled) return; cancelled = true;
          leave(); joined = false;
          const cancellationStatus = peers.size === 0 && task ? "confirmed" : "detached";
          const acknowledge = (status: "confirmed" | "detached" | "unconfirmed" = cancellationStatus) => peer.end(JSON.stringify({ kind: "error", code, cancellationStatus: status }) + "\n");
          if (peers.size === 0 && task) void task.then(() => acknowledge(), error => {
            // A cleanup/containment failure must not become a confirmed stop.
            acknowledge(["worker-aborted", "worker-timeout"].includes((error as Error)?.message) ? "confirmed" : "unconfirmed");
          }); else acknowledge();
        };
        peer.on("close", leave);
        peer.on("data", (chunk: Buffer) => {
          if (cancelled) return;
          bytes += chunk.length;
          if (bytes > 512) { peer.destroy(); return; }
          buffer += chunk.toString("utf8");
          for (;;) {
          if (cancelled) return;
          const end = buffer.indexOf("\n"); if (end < 0) return;
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const value = JSON.parse(line);
            if (!joined) {
              if (!value || Object.keys(value).sort().join(",") !== "deadlineMs,identity,schemaVersion" || value.schemaVersion !== 1 || value.identity !== identity || !Number.isSafeInteger(value.deadlineMs) || value.deadlineMs > Date.now() + WORKER_LIMITS.timeoutSeconds.max * 1000 || finished || controller.signal.aborted) { peer.end('{"kind":"retry"}\n'); return; }
              if (peers.size >= WORKER_LIMITS.waitersPerJob) { peer.end('{"kind":"error","code":"scheduler-queue-full"}\n'); return; }
              if (value.deadlineMs <= Date.now()) { peer.end('{"kind":"error","code":"worker-timeout"}\n'); return; }
              joined = true; peers.add(peer);
              expiration = setTimeout(() => cancel("worker-timeout"), value.deadlineMs - Date.now());
              const first = task === undefined;
              task ??= execute(controller.signal, progress);
              if (first) void task.then(result => publish({ kind: "result", value: result }), error => publish({ kind: "error", code: (error as Error).message })).finally(shutdown).catch(() => {});
            } else {
              if (!value || Object.keys(value).sort().join(",") !== "cancel,reason" || value.cancel !== true || !["worker-aborted", "worker-timeout"].includes(value.reason)) { peer.destroy(); return; }
              cancel(value.reason);
            }
          } catch { peer.destroy(); return; }
          }
        });
        // A connected but silent peer cannot hold the rendezvous forever.
        peer.setTimeout(10_000, () => { if (!joined) peer.destroy(); });
      });
      const shutdown = (): Promise<void> => shutdownPromise ??= withRuntimeMutex(join(directory, "lock"), async () => {
        finished = true;
        await new Promise<void>(resolve => server.close(() => resolve()));
        const current = await lstat(path).catch(() => undefined);
        if (current?.ino === inode) await rm(path, { force: true });
      }).catch(() => { server.close(); });
      let progressCount = 0;
      const progress = (stage: string) => {
        if (finished || progressCount >= 128 || !/^[a-z][a-z0-9-]{0,63}$/.test(stage)) return;
        progressCount++;
        const line = JSON.stringify({ kind: "progress", stage }) + "\n";
        for (const peer of peers) peer.write(line);
      };
      const publish = (value: unknown) => {
        finished = true;
        let line: Buffer;
        try { line = Buffer.from(JSON.stringify(value) + "\n"); if (line.length > maxResultBytes + 1024) throw new Error(); }
        catch { line = Buffer.from('{"kind":"error","code":"worker-response-too-large"}\n'); }
        for (const peer of peers) { peer.end(line); peer.setTimeout(1000, () => peer.destroy()); }
        peers.clear();
      };
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
      await chmod(path, 0o600); inode = (await lstat(path)).ino;
      // An elected owner can disappear before sending its first frame.
      const idle = setTimeout(() => { if (!task) void shutdown(); }, 10_000); idle.unref();
      try {
        const socket = await connect(path, local); if (!socket) throw new Error("worker-rendezvous-unavailable");
        return socket;
      } catch (error) { void shutdown(); throw error; }
    });
    const result = await new Promise<{ retry: true } | { value: T }>((resolve, reject) => {
      let bytes = 0, buffer = Buffer.alloc(0), settled = false;
      let expiration: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error, value?: T, retry = false) => {
        if (settled) return; settled = true; if (expiration) clearTimeout(expiration); signal?.removeEventListener("abort", abort); socket.destroy();
        if (error) reject(error); else if (retry) resolve({ retry: true }); else resolve({ value: value as T });
      };
      const abort = () => { socket.write('{"cancel":true,"reason":"worker-aborted"}\n'); };
      socket.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxResultBytes + 65536) { finish(new Error("worker-response-too-large")); return; }
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
        const end = buffer.indexOf(10); if (end < 0) return;
        try {
          const value = JSON.parse(buffer.subarray(0, end).toString("utf8"));
          buffer = buffer.subarray(end + 1);
          if (value.kind === "progress") { if (Object.keys(value).sort().join(",") !== "kind,stage" || typeof value.stage !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value.stage)) throw new Error(); try { waiter.onProgress?.(value.stage); } catch {} continue; }
          if (signal?.aborted || Date.now() >= deadlineMs) {
            const code = signal?.aborted ? "worker-aborted" : "worker-timeout";
            if (value.kind === "error" && value.code === code && ["confirmed", "detached", "unconfirmed"].includes(value.cancellationStatus)) finish(new WaiterCancellationError(code, value.cancellationStatus));
            // A result/retry is not a cancellation acknowledgement. Keep the
            // local bound active rather than claiming process-tree cleanup.
            return;
          }
          if (value.kind === "retry") finish(undefined, undefined, true);
          else if (value.kind === "error") finish(new Error(["worker-aborted", "scheduler-queue-full", "worker-response-too-large", "worker-containment-unavailable", "worker-source-limit", "worker-resource-limit", "worker-timeout", "scheduler-timeout", "scheduler-policy-mismatch", "worker-protocol-error", "worker-crashed"].includes(value.code) ? value.code : "worker-crashed"));
          else if (value.kind === "result") finish(undefined, value.value);
          else finish(new Error("worker-protocol-error"));
        } catch { finish(new Error("worker-protocol-error")); }
        return;
        }
      });
      socket.on("error", () => finish(undefined, undefined, true));
      socket.on("close", () => finish(undefined, undefined, true));
      local.check(); local.joined = true;
      socket.write(JSON.stringify({ schemaVersion: 1, identity, deadlineMs }) + "\n");
      expiration = setTimeout(() => socket.write('{"cancel":true,"reason":"worker-timeout"}\n'), Math.max(1, deadlineMs - Date.now()));
      signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    });
    if ("value" in result) return result.value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
