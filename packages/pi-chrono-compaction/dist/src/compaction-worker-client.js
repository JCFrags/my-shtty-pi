import { fork } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { acquireHostWorkerSlot } from "./host-worker-scheduler.js";
import { MAX_WORKER_REQUEST_BYTES, MAX_WORKER_RESPONSE_BYTES, MAX_WORKER_STDERR_BYTES, validateWorkerRequest, validateWorkerResponse } from "./compaction-worker-protocol.js";
import { ROLLUP_SHADOW_FAILURE_STAGES, safeFailureContext } from "./rollup-shadow-failure.js";
function safeFailure(request, code, stage, context) {
    const shadowCode = code === "worker-response-too-large" ? "shadow-response-too-large"
        : code === "worker-protocol-error" ? "shadow-protocol-error"
            : code === "scheduler-timeout" ? "worker-timeout"
                : code;
    return { schemaVersion: 1, jobId: request.jobId, status: "failed", jobType: request.jobType,
        failureCode: request.jobType === "rollup-shadow" ? shadowCode : code,
        ...(request.jobType === "rollup-shadow" ? { failureStage: stage ?? "unknown-stage", ...(safeFailureContext(context) ? { failureContext: safeFailureContext(context) } : {}) } : {}),
        metrics: { workerPid: 0, totalWallMs: 0, compactionMs: 0, cpuUserMicros: 0, cpuSystemMicros: 0, peakRssKiB: 0, priorityApplied: false, cacheState: "disabled", modelCalls: 0, networkCalls: 0, secretSentinelPresent: false, sourceLedgerTransition: "none", ledgerColdLoadMs: 0, branchResolveMs: 0, branchReadMs: 0,
            branchEntryCount: 0, branchSourceBytes: 0, sourceRangeCount: 0, sourceBytesRead: 0, sourceByteAvoidanceRate: 0,
            completeSessionReadAvoided: false, candidateLedgerReused: false } };
}
function allowedEnvironment() { const output = {}; for (const name of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ"]) {
    const value = process.env[name];
    if (value !== undefined)
        output[name] = value;
} return output; }
function stop(child) { try {
    child.disconnect();
}
catch { } if (child.exitCode === null && !child.killed)
    child.kill("SIGKILL"); }
function emptyMetrics(request, slots, codeResponse) { return { response: codeResponse, clientMetrics: { jobType: request.jobType, schedulerSlotLimit: slots, schedulerQueueWaitMs: 0, schedulerQueuePosition: 0, workerStartMs: 0, workerTotalWallMs: 0, mainProcessMaximumTimerDelayMs: 0, responseBytes: 0, stderrBytes: 0 } }; }
function writePrivateDiagnostic(path, response, elapsedMs, exitCode, signal) {
    if (!path || response.status !== "failed" || response.jobType !== "rollup-shadow")
        return;
    const record = { schemaVersion: 1, failureStage: response.failureStage, failureCode: response.failureCode,
        elapsedMs: Math.max(0, elapsedMs), peakRssKiB: response.metrics.peakRssKiB,
        ...(exitCode === undefined ? {} : { exitCode }), ...(signal ? { signal } : {}),
        ...(response.failureContext ? { context: response.failureContext } : {}) };
    const descriptor = openSync(path, "a", 0o600);
    try {
        writeSync(descriptor, `${JSON.stringify(record)}\n`);
    }
    finally {
        closeSync(descriptor);
    }
}
export async function runCompactionWorker(requestValue, options = {}) {
    const request = validateWorkerRequest(requestValue);
    if (Buffer.byteLength(JSON.stringify(request)) > MAX_WORKER_REQUEST_BYTES)
        throw new Error("worker-protocol-error");
    let lease;
    try {
        lease = await acquireHostWorkerSlot({ slots: options.slots, timeoutMs: options.schedulerTimeoutMs, priority: options.priority ?? (request.jobType === "replay-compaction" ? "high" : "low"), jobType: request.jobType, signal: options.signal, directory: options.schedulerDirectory });
    }
    catch (error) {
        const code = options.signal?.aborted || String(error?.message).includes("aborted") ? "worker-aborted" : "scheduler-timeout";
        return emptyMetrics(request, options.slots ?? 1, safeFailure(request, code, "scheduler-wait"));
    }
    const wallStart = performance.now();
    let maxDelay = 0;
    let expected = performance.now() + 10;
    const probe = setInterval(() => { const now = performance.now(); maxDelay = Math.max(maxDelay, now - expected); expected = now + 10; }, 10);
    const entry = options.entryPath ?? fileURLToPath(new URL("./compaction-worker-entry.js", import.meta.url));
    let child;
    let stderrBytes = 0;
    let startedAt = 0;
    try {
        return await new Promise((resolve) => {
            let settled = false;
            let timeout;
            let termination;
            let terminationTimer;
            let latestStage = "child-start";
            let latestContext;
            let childExitCode;
            let childSignal;
            const finish = (input) => {
                if (settled)
                    return;
                settled = true;
                if (timeout)
                    clearTimeout(timeout);
                if (terminationTimer)
                    clearTimeout(terminationTimer);
                clearInterval(probe);
                if (child)
                    stop(child);
                const responseBytes = Buffer.byteLength(JSON.stringify(input));
                const response = responseBytes > MAX_WORKER_RESPONSE_BYTES ? safeFailure(request, "worker-response-too-large", "response-validation", { responseBytes }) : input;
                const elapsedMs = performance.now() - wallStart;
                try {
                    writePrivateDiagnostic(options.privateDiagnosticPath, response, elapsedMs, childExitCode, childSignal);
                }
                catch { }
                resolve({ response, clientMetrics: { jobType: request.jobType, schedulerSlotLimit: lease.slots, schedulerQueueWaitMs: lease.queueWaitMs, schedulerQueuePosition: lease.queuePosition, workerStartMs: startedAt, workerTotalWallMs: elapsedMs, mainProcessMaximumTimerDelayMs: maxDelay, responseBytes, stderrBytes } });
            };
            const terminate = (response) => { if (settled || termination)
                return; termination = response; try {
                child?.kill("SIGTERM");
            }
            catch { } terminationTimer = setTimeout(() => finish(response), 1_100); };
            try {
                child = fork(entry, [], { stdio: ["ignore", "ignore", "pipe", "ipc"], env: allowedEnvironment(), serialization: "json", execArgv: [] });
                startedAt = performance.now() - wallStart;
            }
            catch {
                finish(safeFailure(request, "worker-crashed", "child-start"));
                return;
            }
            const running = child;
            running.stderr?.on("data", (chunk) => { stderrBytes = Math.min(MAX_WORKER_STDERR_BYTES, stderrBytes + chunk.length); });
            timeout = setTimeout(() => terminate(safeFailure(request, "worker-timeout", latestStage, latestContext)), Math.max(1, options.workerTimeoutMs ?? 900_000));
            const abort = () => terminate(safeFailure(request, "worker-aborted", latestStage, latestContext));
            options.signal?.addEventListener("abort", abort, { once: true });
            running.on("message", (value) => {
                if (termination)
                    return;
                if (request.jobType === "rollup-shadow" && value && typeof value === "object" && value.kind === "shadow-stage") {
                    const stage = value.stage;
                    if (!ROLLUP_SHADOW_FAILURE_STAGES.includes(stage)) {
                        finish(safeFailure(request, "worker-protocol-error", "response-validation"));
                        return;
                    }
                    latestStage = stage;
                    latestContext = safeFailureContext(value.context);
                    return;
                }
                options.signal?.removeEventListener("abort", abort);
                try {
                    finish(validateWorkerResponse(value, request.jobId));
                }
                catch (error) {
                    finish(safeFailure(request, String(error.message).includes("response-too-large") ? "worker-response-too-large" : "worker-protocol-error", "response-validation"));
                }
            });
            running.on("error", () => finish(termination ?? safeFailure(request, "worker-crashed", latestStage, latestContext)));
            running.on("exit", (code, signal) => { childExitCode = code; childSignal = signal; if (!settled)
                finish(termination ?? safeFailure(request, "worker-crashed", latestStage, latestContext)); });
            running.send(request, (error) => { if (error)
                finish(safeFailure(request, "worker-crashed", "child-start")); });
        });
    }
    finally {
        clearInterval(probe);
        if (child)
            stop(child);
        await lease.release();
    }
}
//# sourceMappingURL=compaction-worker-client.js.map