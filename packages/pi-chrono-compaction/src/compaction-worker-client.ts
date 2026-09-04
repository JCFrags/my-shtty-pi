import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fchmodSync, fstatSync, ftruncateSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireHostWorkerSlot, type WorkerPriority } from "./host-worker-scheduler.js";
import { MAX_WORKER_REQUEST_BYTES, MAX_WORKER_RESPONSE_BYTES, MAX_WORKER_STDERR_BYTES, validateWorkerRequest, validateWorkerResponse, type CompactionWorkerRequest, type CompactionWorkerResponse, type WorkerFailureCode } from "./compaction-worker-protocol.js";
import { ROLLUP_SHADOW_FAILURE_CODES, ROLLUP_SHADOW_FAILURE_STAGES, safeFailureContext, type RollupShadowFailureCode, type RollupShadowFailureContext, type RollupShadowFailureStage } from "./rollup-shadow-failure.js";

const MAX_WORKER_DIAGNOSTIC_BYTES = 1024 * 1024;
export interface WorkerClientOptions {
  readonly slots?: number;
  readonly schedulerTimeoutMs?: number;
  readonly workerTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly priority?: WorkerPriority;
  readonly schedulerDirectory?: string;
  readonly entryPath?: string;
  readonly privateDiagnosticPath?: string;
}
export function replayWorkerDiagnosticPath(sessionPath: string): string { return `${sessionPath}.chrono-worker-diagnostics-v1.jsonl`; }
export interface WorkerClientMetrics { readonly jobType: string; readonly schedulerSlotLimit: number; readonly schedulerQueueWaitMs: number; readonly schedulerQueuePosition: number; readonly workerStartMs: number; readonly workerTotalWallMs: number; readonly mainProcessMaximumTimerDelayMs: number; readonly responseBytes: number; readonly stderrBytes: number; }
export interface WorkerClientResult { readonly response: CompactionWorkerResponse; readonly clientMetrics: WorkerClientMetrics; }
function safeFailure(
  request: CompactionWorkerRequest,
  code: WorkerFailureCode,
  stage?: RollupShadowFailureStage,
  context?: RollupShadowFailureContext,
): CompactionWorkerResponse {
  const mappedShadowCode = code === "worker-response-too-large" ? "shadow-response-too-large"
    : code === "worker-protocol-error" ? "shadow-protocol-error"
      : code === "scheduler-timeout" ? "worker-timeout" : code;
  const shadowCode: RollupShadowFailureCode = ROLLUP_SHADOW_FAILURE_CODES.includes(mappedShadowCode as RollupShadowFailureCode) ? mappedShadowCode as RollupShadowFailureCode : "worker-crashed";
  return { schemaVersion: 1, jobId: request.jobId, status: "failed", jobType: request.jobType,
    failureCode: request.jobType === "rollup-shadow" ? shadowCode : code,
    ...(request.jobType === "rollup-shadow" ? { failureStage: stage ?? "unknown-stage", ...(safeFailureContext(context) ? { failureContext: safeFailureContext(context) } : {}) } : {}),
    metrics: { workerPid: 0, totalWallMs: 0, compactionMs: 0, cpuUserMicros: 0, cpuSystemMicros: 0, peakRssKiB: 0, priorityApplied: false, cacheState: "disabled", modelCalls: 0, networkCalls: 0, secretSentinelPresent: false, sourceLedgerTransition: "none", ledgerColdLoadMs: 0, branchResolveMs: 0, branchReadMs: 0,
      branchEntryCount: 0, branchSourceBytes: 0, sourceRangeCount: 0, sourceBytesRead: 0, sourceByteAvoidanceRate: 0,
      completeSessionReadAvoided: false, candidateLedgerReused: false } };
}
function allowedEnvironment(): NodeJS.ProcessEnv { const output: NodeJS.ProcessEnv = {}; for (const name of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ"]) { const value = process.env[name]; if (value !== undefined) output[name] = value; } return output; }
function stop(child: ChildProcess): void { try { child.disconnect(); } catch {} if (child.exitCode === null && !child.killed) child.kill("SIGKILL"); }
function emptyMetrics(request: CompactionWorkerRequest, slots: number, codeResponse: CompactionWorkerResponse): WorkerClientResult { return { response: codeResponse, clientMetrics: { jobType: request.jobType, schedulerSlotLimit: slots, schedulerQueueWaitMs: 0, schedulerQueuePosition: 0, workerStartMs: 0, workerTotalWallMs: 0, mainProcessMaximumTimerDelayMs: 0, responseBytes: 0, stderrBytes: 0 } }; }
function diagnosticEntrypointIdentity(path: string): { name: string; bytes?: number; sha256?: string } {
  const name = basename(path).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "worker-entrypoint";
  try { const bytes=statSync(path).size;if(bytes>1024*1024)return{name,bytes};return { name, bytes, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") }; }
  catch { return { name }; }
}
function safeStderrTail(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")};bytes:${bytes.length}`;
}
function writePrivateDiagnostic(path: string | undefined, response: CompactionWorkerResponse, elapsedMs: number, stage: string, entry: string, requestBytes: number, responseBytes: number, stderrTail: Buffer, stderrBytes: number, exitCode?: number | null, signal?: NodeJS.Signals | null): void {
  if (!path || response.status !== "failed") return;
  const record = { schemaVersion: 1, failureStage: response.failureStage ?? stage.slice(0, 64), failureCode: response.failureCode,
    elapsedMs: Math.max(0, elapsedMs), peakRssKiB: response.metrics.peakRssKiB, requestBytes, responseBytes, stderrBytes,
    stderrTail: safeStderrTail(stderrTail), entrypoint: diagnosticEntrypointIdentity(entry),
    ...(exitCode === undefined ? {} : { exitCode }), ...(signal ? { signal } : {}),
    ...(response.failureContext ? { context: response.failureContext } : {}) };
  const line = `${JSON.stringify(record)}\n`;
  const descriptor = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try { const metadata=fstatSync(descriptor);const uid=typeof process.getuid==="function"?process.getuid():metadata.uid;if(!metadata.isFile()||metadata.uid!==uid||metadata.nlink!==1||(metadata.mode&0o077)!==0)throw new Error("unsafe-worker-diagnostic");fchmodSync(descriptor, 0o600); if (metadata.size + Buffer.byteLength(line) > MAX_WORKER_DIAGNOSTIC_BYTES) ftruncateSync(descriptor, 0); writeSync(descriptor, line); } finally { closeSync(descriptor); }
}
export async function runCompactionWorker(requestValue: unknown, options: WorkerClientOptions = {}): Promise<WorkerClientResult> {
  const request = validateWorkerRequest(requestValue); const requestBytes = Buffer.byteLength(JSON.stringify(request)); if (requestBytes > MAX_WORKER_REQUEST_BYTES) throw new Error("worker-protocol-error");
  const entry = options.entryPath ?? fileURLToPath(new URL("./compaction-worker-entry.js", import.meta.url));
  const diagnosticPath = options.privateDiagnosticPath ?? replayWorkerDiagnosticPath(request.sessionPath);
  let lease; try { lease = await acquireHostWorkerSlot({ slots: options.slots, timeoutMs: options.schedulerTimeoutMs, priority: options.priority ?? (request.jobType === "replay-compaction" ? "high" : "low"), jobType: request.jobType, signal: options.signal, directory: options.schedulerDirectory }); }
  catch (error) { const code: WorkerFailureCode = options.signal?.aborted || String((error as Error)?.message).includes("aborted") ? "worker-aborted" : "scheduler-timeout"; const result=emptyMetrics(request, options.slots ?? 1, safeFailure(request, code, "scheduler-wait"));try{writePrivateDiagnostic(diagnosticPath,result.response,0,"scheduler-wait",entry,requestBytes,0,Buffer.alloc(0),0);}catch{}return result; }
  const wallStart = performance.now(); let maxDelay = 0; let expected = performance.now() + 10; const probe = setInterval(() => { const now = performance.now(); maxDelay = Math.max(maxDelay, now - expected); expected = now + 10; }, 10);
  let child: ChildProcess | undefined; let stderrBytes = 0; let stderrTail=Buffer.alloc(0); let startedAt = 0;
  try {
    return await new Promise<WorkerClientResult>((resolve) => {
      let settled = false; let timeout: ReturnType<typeof setTimeout> | undefined; let termination: CompactionWorkerResponse | undefined; let terminationTimer: ReturnType<typeof setTimeout> | undefined;
      let latestStage: RollupShadowFailureStage = "child-start";
      let diagnosticStage = "child-start";
      let latestContext: RollupShadowFailureContext | undefined;
      let childExitCode: number | null | undefined;
      let childSignal: NodeJS.Signals | null | undefined;
      const finish = (input: CompactionWorkerResponse): void => {
        if (settled) return; settled = true; if (timeout) clearTimeout(timeout); if(terminationTimer)clearTimeout(terminationTimer); clearInterval(probe); if (child) stop(child);
        const responseBytes = Buffer.byteLength(JSON.stringify(input)); const response = responseBytes > MAX_WORKER_RESPONSE_BYTES ? safeFailure(request, "worker-response-too-large", "response-validation", { responseBytes }) : input;
        const elapsedMs = performance.now() - wallStart;
        try { writePrivateDiagnostic(diagnosticPath, response, elapsedMs, diagnosticStage, entry, requestBytes, responseBytes, stderrTail, stderrBytes, childExitCode, childSignal); } catch {}
        resolve({ response, clientMetrics: { jobType: request.jobType, schedulerSlotLimit: lease.slots, schedulerQueueWaitMs: lease.queueWaitMs, schedulerQueuePosition: lease.queuePosition, workerStartMs: startedAt, workerTotalWallMs: elapsedMs, mainProcessMaximumTimerDelayMs: maxDelay, responseBytes, stderrBytes } });
      };
      const terminate = (response: CompactionWorkerResponse): void => { if(settled||termination)return;termination=response;try{child?.kill("SIGTERM");}catch{}terminationTimer=setTimeout(()=>finish(response),1_100); };
      try { if(!statSync(entry).isFile()){finish(safeFailure(request,"worker-entrypoint-unavailable","child-start"));return;} child = fork(entry, [], { stdio: ["ignore", "ignore", "pipe", "ipc"], env: allowedEnvironment(), serialization: "json", execArgv: [] }); startedAt = performance.now() - wallStart; diagnosticStage="child-running"; }
      catch { finish(safeFailure(request, "worker-entrypoint-unavailable", "child-start")); return; }
      const running = child; running.stderr?.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; stderrTail=Buffer.concat([stderrTail,chunk]).subarray(-MAX_WORKER_STDERR_BYTES); });
      timeout = setTimeout(() => terminate(safeFailure(request, "worker-timeout", latestStage, latestContext)), Math.max(1, options.workerTimeoutMs ?? 900_000));
      const abort = () => terminate(safeFailure(request, "worker-aborted", latestStage, latestContext)); options.signal?.addEventListener("abort", abort, { once: true });
      running.on("message", (value) => {
        if (termination) return;
        if (request.jobType === "rollup-shadow" && value && typeof value === "object" && (value as { kind?: unknown }).kind === "shadow-stage") {
          const stage = (value as { stage?: unknown }).stage;
          if (!ROLLUP_SHADOW_FAILURE_STAGES.includes(stage as RollupShadowFailureStage)) {
            finish(safeFailure(request, "worker-protocol-error", "response-validation"));
            return;
          }
          latestStage = stage as RollupShadowFailureStage;
          diagnosticStage = latestStage;
          latestContext = safeFailureContext((value as { context?: RollupShadowFailureContext }).context);
          return;
        }
        options.signal?.removeEventListener("abort", abort);
        diagnosticStage="response-validation";
        try { finish(validateWorkerResponse(value, request.jobId)); }
        catch (error) { finish(safeFailure(request, String((error as Error).message).includes("response-too-large") ? "worker-response-too-large" : "worker-protocol-error", "response-validation")); }
      });
      running.on("error", () => finish(termination ?? safeFailure(request, "worker-crashed", latestStage, latestContext)));
      running.on("exit", (code, signal) => { childExitCode = code; childSignal = signal; diagnosticStage="child-exit"; if (!settled) finish(termination ?? safeFailure(request, signal === "SIGKILL" ? "worker-resource-limit" : "worker-crashed", latestStage, latestContext)); });
      running.send(request, (error) => { if (error) finish(safeFailure(request, "worker-crashed", "child-start")); });
    });
  } finally { clearInterval(probe); if (child) stop(child); await lease.release(); }
}
