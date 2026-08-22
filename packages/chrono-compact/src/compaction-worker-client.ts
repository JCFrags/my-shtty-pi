import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquireHostWorkerSlot, type WorkerPriority } from "./host-worker-scheduler.js";
import { MAX_WORKER_REQUEST_BYTES, MAX_WORKER_RESPONSE_BYTES, MAX_WORKER_STDERR_BYTES, validateWorkerRequest, validateWorkerResponse, type CompactionWorkerRequest, type CompactionWorkerResponse, type WorkerFailureCode } from "./compaction-worker-protocol.js";

export interface WorkerClientOptions { readonly slots?: number; readonly schedulerTimeoutMs?: number; readonly workerTimeoutMs?: number; readonly signal?: AbortSignal; readonly priority?: WorkerPriority; readonly schedulerDirectory?: string; readonly entryPath?: string; }
export interface WorkerClientMetrics { readonly jobType: string; readonly schedulerSlotLimit: number; readonly schedulerQueueWaitMs: number; readonly schedulerQueuePosition: number; readonly workerStartMs: number; readonly workerTotalWallMs: number; readonly mainProcessMaximumTimerDelayMs: number; readonly responseBytes: number; readonly stderrBytes: number; }
export interface WorkerClientResult { readonly response: CompactionWorkerResponse; readonly clientMetrics: WorkerClientMetrics; }
function safeFailure(request: CompactionWorkerRequest, code: WorkerFailureCode): CompactionWorkerResponse { return { schemaVersion: 1, jobId: request.jobId, status: "failed", jobType: request.jobType, failureCode: code, metrics: { workerPid: 0, totalWallMs: 0, compactionMs: 0, cpuUserMicros: 0, cpuSystemMicros: 0, peakRssKiB: 0, priorityApplied: false, cacheState: "disabled", modelCalls: 0, networkCalls: 0, secretSentinelPresent: false, sourceLedgerTransition: "none", ledgerColdLoadMs: 0, branchResolveMs: 0, branchReadMs: 0,
    branchEntryCount: 0, branchSourceBytes: 0, sourceRangeCount: 0, sourceBytesRead: 0, sourceByteAvoidanceRate: 0,
    completeSessionReadAvoided: false, candidateLedgerReused: false } }; }
function allowedEnvironment(): NodeJS.ProcessEnv { const output: NodeJS.ProcessEnv = {}; for (const name of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ"]) { const value = process.env[name]; if (value !== undefined) output[name] = value; } return output; }
function stop(child: ChildProcess): void { try { child.disconnect(); } catch {} if (child.exitCode === null && !child.killed) child.kill("SIGKILL"); }
function emptyMetrics(request: CompactionWorkerRequest, slots: number, codeResponse: CompactionWorkerResponse): WorkerClientResult { return { response: codeResponse, clientMetrics: { jobType: request.jobType, schedulerSlotLimit: slots, schedulerQueueWaitMs: 0, schedulerQueuePosition: 0, workerStartMs: 0, workerTotalWallMs: 0, mainProcessMaximumTimerDelayMs: 0, responseBytes: 0, stderrBytes: 0 } }; }
export async function runCompactionWorker(requestValue: unknown, options: WorkerClientOptions = {}): Promise<WorkerClientResult> {
  const request = validateWorkerRequest(requestValue); if (Buffer.byteLength(JSON.stringify(request)) > MAX_WORKER_REQUEST_BYTES) throw new Error("worker-protocol-error");
  let lease; try { lease = await acquireHostWorkerSlot({ slots: options.slots, timeoutMs: options.schedulerTimeoutMs, priority: options.priority ?? (request.jobType === "replay-compaction" ? "high" : "low"), jobType: request.jobType, signal: options.signal, directory: options.schedulerDirectory }); }
  catch (error) { const code: WorkerFailureCode = options.signal?.aborted || String((error as Error)?.message).includes("aborted") ? "worker-aborted" : "scheduler-timeout"; return emptyMetrics(request, options.slots ?? 1, safeFailure(request, code)); }
  const wallStart = performance.now(); let maxDelay = 0; let expected = performance.now() + 10; const probe = setInterval(() => { const now = performance.now(); maxDelay = Math.max(maxDelay, now - expected); expected = now + 10; }, 10);
  const entry = options.entryPath ?? fileURLToPath(new URL("./compaction-worker-entry.js", import.meta.url)); let child: ChildProcess | undefined; let stderrBytes = 0; let startedAt = 0;
  try {
    return await new Promise<WorkerClientResult>((resolve) => {
      let settled = false; let timeout: ReturnType<typeof setTimeout> | undefined; let termination: CompactionWorkerResponse | undefined; let terminationTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (input: CompactionWorkerResponse): void => {
        if (settled) return; settled = true; if (timeout) clearTimeout(timeout); if(terminationTimer)clearTimeout(terminationTimer); clearInterval(probe); if (child) stop(child);
        const responseBytes = Buffer.byteLength(JSON.stringify(input)); const response = responseBytes > MAX_WORKER_RESPONSE_BYTES ? safeFailure(request, "worker-response-too-large") : input;
        resolve({ response, clientMetrics: { jobType: request.jobType, schedulerSlotLimit: lease.slots, schedulerQueueWaitMs: lease.queueWaitMs, schedulerQueuePosition: lease.queuePosition, workerStartMs: startedAt, workerTotalWallMs: performance.now() - wallStart, mainProcessMaximumTimerDelayMs: maxDelay, responseBytes, stderrBytes } });
      };
      const terminate = (response: CompactionWorkerResponse): void => { if(settled||termination)return;termination=response;try{child?.kill("SIGTERM");}catch{}terminationTimer=setTimeout(()=>finish(response),1_100); };
      try { child = fork(entry, [], { stdio: ["ignore", "ignore", "pipe", "ipc"], env: allowedEnvironment(), serialization: "json", execArgv: [] }); startedAt = performance.now() - wallStart; }
      catch { finish(safeFailure(request, "worker-crashed")); return; }
      const running = child; running.stderr?.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > MAX_WORKER_STDERR_BYTES) finish(safeFailure(request, "worker-protocol-error")); });
      timeout = setTimeout(() => terminate(safeFailure(request, "worker-timeout")), Math.max(1, options.workerTimeoutMs ?? 900_000));
      const abort = () => terminate(safeFailure(request, "worker-aborted")); options.signal?.addEventListener("abort", abort, { once: true });
      running.on("message", (value) => { if(termination)return;options.signal?.removeEventListener("abort", abort); try { finish(validateWorkerResponse(value, request.jobId)); } catch (error) { finish(safeFailure(request, String((error as Error).message).includes("response-too-large") ? "worker-response-too-large" : "worker-protocol-error")); } });
      running.on("error", () => finish(termination??safeFailure(request, "worker-crashed"))); running.on("exit", () => { if (!settled) finish(termination??safeFailure(request, "worker-crashed")); }); running.send(request, (error) => { if (error) finish(safeFailure(request, "worker-crashed")); });
    });
  } finally { clearInterval(probe); if (child) stop(child); await lease.release(); }
}
