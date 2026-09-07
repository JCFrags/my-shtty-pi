import { defaultRuntimeDirectory, prepareRuntimeNamespace } from "./worker-runtime-namespace.js";
import { verifyLegacyAdmissionGate, withVerifiedLegacyAdmission } from "./worker-runtime-legacy-gate.js";
import { publishRuntimeStage, runtimeCategory, runtimeStage } from "./worker-runtime-status.js";
export { runtimeHostStatus } from "./worker-runtime-status.js";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { acquireHostWorkerSlot, type WorkerPriority } from "./host-worker-scheduler.js";
import { MAX_WORKER_REQUEST_BYTES, MAX_WORKER_RESPONSE_BYTES, MAX_WORKER_STDERR_BYTES } from "./compaction-worker-protocol.js";
import { WORKER_LIMITS, inRange } from "./worker-runtime-limits.js";
import { coalesceHostJob } from "./worker-runtime-rendezvous.js";
import { startContainedWorker, type ContainedWorker } from "./worker-runtime-systemd.js";

export interface BoundedWorkerCaps {
  readonly deadlineMs: number;
  /** Cumulative admitted filesystem data reads in the trusted worker. */
  readonly sourceBytes: number;
  readonly responseBytes: number;
  /** Optional lower per-job cgroup cap; cannot exceed the fixed host share. */
  readonly memoryBytes?: number;
  readonly heapMiB?: number;
}
export interface BoundedWorkerOptions<Request, Response> {
  readonly entryPath: string;
  readonly entryTransport?: "ipc" | "stdio";
  readonly request: unknown;
  readonly identity: { readonly schemaVersion: 1; readonly kind: string; readonly sessionKey: string };
  readonly caps: BoundedWorkerCaps;
  readonly slots?: number;
  readonly priority?: WorkerPriority;
  /** Synthetic namespace only until the parent installs a verified legacy gate. */
  readonly schedulerDirectory?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (stage: string) => void;
  readonly validateRequest: (value: unknown) => Request;
  /** Return undefined only for a strictly validated progress frame. */
  readonly validateResponse: (value: unknown) => Response | undefined;
}
export interface BoundedWorkerMetrics { readonly queueWaitMs: number; readonly queuePosition: number; readonly slots: number; readonly wallMs: number; readonly responseBytes: number; readonly stderrBytes: number; }
export interface BoundedWorkerResult<T> { readonly value: T; readonly metrics: BoundedWorkerMetrics; }
export class WorkerRuntimeError extends Error {
  constructor(readonly code: string) { super(code); this.name = "WorkerRuntimeError"; }
}
/** JSON identity rejects cycles, accessors, prototypes, nonfinite numbers and
 * ambiguous omitted values. Caller schema validation still owns field meaning. */
export function canonicalWorkerJson(value: unknown): string {
  const ancestors = new Set<object>();
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (typeof input !== "object" || ancestors.has(input)) throw new WorkerRuntimeError("worker-protocol-error");
    ancestors.add(input);
    try {
      if (Array.isArray(input)) return input.map(normalize);
      if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) throw new WorkerRuntimeError("worker-protocol-error");
      const result: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(input).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
        if (!('value' in descriptor)) throw new WorkerRuntimeError("worker-protocol-error");
        if (descriptor.value !== undefined) result[key] = normalize(descriptor.value);
      }
      return result;
    } finally { ancestors.delete(input); }
  };
  const text = JSON.stringify(normalize(value));
  if (Buffer.byteLength(text) > MAX_WORKER_REQUEST_BYTES) throw new WorkerRuntimeError("worker-protocol-error");
  return text;
}

/** Reusable, provider-free IPC job transport. Compaction and history callers use
 * the same fixed unit names, queue policy, memory budget, and rendezvous. */
export async function runBoundedWorker<Request, Response>(options: BoundedWorkerOptions<Request, Response>): Promise<BoundedWorkerResult<Response>> {
  const request = options.validateRequest(JSON.parse(canonicalWorkerJson(options.validateRequest(options.request))));
  const identity = options.identity, caps = options.caps, slots = options.slots ?? 1;
  if (!identity || Object.keys(identity).sort().join(",") !== "kind,schemaVersion,sessionKey" || identity.schemaVersion !== 1 || !/^[a-z][a-z0-9-]{0,63}$/.test(identity.kind) || !/^[a-f0-9]{64}$/.test(identity.sessionKey) || !inRange(slots, WORKER_LIMITS.slots) || !caps || Object.keys(caps).some(key => !["deadlineMs", "sourceBytes", "responseBytes", "memoryBytes", "heapMiB"].includes(key)) || !inRange(caps.deadlineMs, { min: Date.now() + 1, max: Date.now() + WORKER_LIMITS.timeoutSeconds.max * 1000 }) || !inRange(caps.sourceBytes, { min: 1, max: WORKER_LIMITS.sourceBytes }) || !inRange(caps.responseBytes, { min: 1, max: MAX_WORKER_RESPONSE_BYTES }) || (caps.memoryBytes !== undefined && !inRange(caps.memoryBytes, { min: 64 * 1024 * 1024, max: Math.floor(WORKER_LIMITS.hostMemoryBytes / slots) })) || (options.priority !== undefined && options.priority !== "high" && options.priority !== "low")) throw new WorkerRuntimeError("worker-protocol-error");
  if (options.entryTransport !== undefined && options.entryTransport !== "stdio" && options.entryTransport !== "ipc") throw new WorkerRuntimeError("worker-protocol-error");
  if (caps.heapMiB !== undefined && !inRange(caps.heapMiB, { min: 16, max: Math.floor((caps.memoryBytes ?? WORKER_LIMITS.hostMemoryBytes / slots) / (1024 * 1024)) })) throw new WorkerRuntimeError("worker-protocol-error");
  const production = options.schedulerDirectory === undefined;
  if (production && !await verifyLegacyAdmissionGate()) throw new WorkerRuntimeError("worker-legacy-transition-required");
  const entryPath = await realpath(options.entryPath);
  const entryBytes = await readFile(entryPath);
  if (entryBytes.length > 1024 * 1024) throw new WorkerRuntimeError("worker-entrypoint-unavailable");
  const namespace = await prepareRuntimeNamespace(options.schedulerDirectory ?? defaultRuntimeDirectory());
  const { deadlineMs: _waiterDeadline, ...sharedCaps } = caps;
  const hash = createHash("sha256").update(canonicalWorkerJson({ identity, request, caps: sharedCaps, slots, priority: options.priority ?? "low", entryPath, entryTransport: options.entryTransport ?? "ipc", entryHash: createHash("sha256").update(entryBytes).digest("hex") })).digest("hex");
  const result = await coalesceHostJob(namespace, hash, options.signal, async (signal, progress) => {
    const hardDeadlineMs = Date.now() + WORKER_LIMITS.timeoutSeconds.max * 1000;
    const started = performance.now();
    const lease = await acquireHostWorkerSlot({ directory: namespace, slots, priority: options.priority ?? "low", jobType: identity.kind === "replay-compaction" ? "replay-compaction" : "candidate-store-update", sessionKey: identity.sessionKey, signal, timeoutMs: hardDeadlineMs - Date.now(), enforcePolicy: true });
    let worker: ContainedWorker | undefined;
    let abort = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stageWrites = Promise.resolve();
    const stage = (label: string) => { stageWrites = stageWrites.then(() => publishRuntimeStage(namespace, lease.slot, runtimeCategory(identity.kind), label)).catch(() => {}); progress(label); };
    try {
      while (!worker) {
        if (signal.aborted) throw new WorkerRuntimeError("worker-aborted");
        if (Date.now() >= hardDeadlineMs) throw new WorkerRuntimeError("worker-timeout");
        try {
          const start = () => startContainedWorker(namespace, lease.slot, slots, hardDeadlineMs - Date.now(), caps.memoryBytes, caps.responseBytes, caps.heapMiB, signal);
          worker = production ? await withVerifiedLegacyAdmission(namespace, start) : await start();
        }
        catch (error) { if ((error as Error).message !== "runtime-slot-busy") throw error; await new Promise(resolve => setTimeout(resolve, 50)); }
      }
      const running = worker;
      stage("child-running");
      let responseBytes = 0, stderrBytes = 0;
      const value = await new Promise<Response>((resolve, reject) => {
        abort = () => reject(new WorkerRuntimeError("worker-aborted"));
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(new WorkerRuntimeError("worker-timeout")), Math.max(1, hardDeadlineMs - Date.now()));
        running.on("message", frame => {
          responseBytes += Buffer.byteLength(JSON.stringify(frame));
          if (responseBytes > caps.responseBytes) { reject(new WorkerRuntimeError("worker-response-too-large")); return; }
          try { const checked = options.validateResponse(frame); if (checked !== undefined) resolve(checked); else { const label = runtimeStage(frame); if (!label) throw new Error(); stage(label); } }
          catch { reject(new WorkerRuntimeError("worker-protocol-error")); }
        });
        running.stderr.on("data", (bytes: Buffer) => { stderrBytes += bytes.length; if (stderrBytes > MAX_WORKER_STDERR_BYTES) reject(new WorkerRuntimeError("worker-response-too-large")); });
        running.on("limit", code => reject(new WorkerRuntimeError(code)));
        running.on("exit", () => { void running.result().then(result => reject(new WorkerRuntimeError(result === "oom-kill" ? "worker-resource-limit" : result === "timeout" ? "worker-timeout" : "worker-crashed"))); });
        if (signal.aborted) abort();
        else running.send(request, entryPath, error => { if (error) reject(new WorkerRuntimeError("worker-crashed")); }, caps.sourceBytes, options.entryTransport);
      });
      await running.stop();
      return { value, metrics: { queueWaitMs: lease.queueWaitMs, queuePosition: lease.queuePosition, slots, wallMs: performance.now() - started, responseBytes, stderrBytes } };
    } finally {
      signal.removeEventListener("abort", abort); if (timer) clearTimeout(timer);
      if (worker) await worker.stop();
      await stageWrites;
      await lease.release();
    }
  }, caps.responseBytes + 4096, { deadlineMs: caps.deadlineMs, onProgress: options.onProgress });
  // Followers never trust an unvalidated final frame from a peer process.
  const checked = options.validateResponse(result.value);
  if (checked === undefined) throw new WorkerRuntimeError("worker-protocol-error");
  return { ...result, value: checked };
}
