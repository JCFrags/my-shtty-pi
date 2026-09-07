import { prepareRuntimeNamespace } from "./worker-runtime-namespace.js";
import { verifyLegacyAdmissionGate, withVerifiedLegacyAdmission } from "./worker-runtime-legacy-gate.js";
import { publishRuntimeStage, runtimeCategory } from "./worker-runtime-status.js";
import { coalesceHostJob } from "./worker-runtime-rendezvous.js";
import { startContainedWorker } from "./worker-runtime-systemd.js";
import { WORKER_LIMITS } from "./worker-runtime-limits.js";
import { canonicalWorkerJson } from "./worker-runtime.js";
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fchmodSync, fstatSync, ftruncateSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireHostWorkerSlot, defaultSchedulerDirectory } from "./host-worker-scheduler.js";
import { MAX_WORKER_REQUEST_BYTES, MAX_WORKER_RESPONSE_BYTES, MAX_WORKER_STDERR_BYTES, validateWorkerRequest, validateWorkerResponse, validateWorkerProgress } from "./compaction-worker-protocol.js";
import { ROLLUP_SHADOW_FAILURE_CODES, ROLLUP_SHADOW_FAILURE_STAGES, safeFailureContext } from "./rollup-shadow-failure.js";
const MAX_WORKER_DIAGNOSTIC_BYTES = 1024 * 1024;
export function replayWorkerDiagnosticPath(sessionPath) { return `${sessionPath}.chrono-worker-diagnostics-v1.jsonl`; }
function safeFailure(request, code, stage, context) {
    const mappedShadowCode = code === "worker-response-too-large" ? "shadow-response-too-large"
        : code === "worker-protocol-error" ? "shadow-protocol-error"
            : code === "scheduler-timeout" ? "worker-timeout" : code;
    const shadowCode = ROLLUP_SHADOW_FAILURE_CODES.includes(mappedShadowCode) ? mappedShadowCode : "worker-crashed";
    return { schemaVersion: 1, jobId: request.jobId, status: "failed", jobType: request.jobType,
        failureCode: request.jobType === "rollup-shadow" ? shadowCode : code,
        ...(request.jobType === "rollup-shadow" ? { failureStage: stage ?? "unknown-stage", ...(safeFailureContext(context) ? { failureContext: safeFailureContext(context) } : {}) } : {}),
        metrics: { workerPid: 0, totalWallMs: 0, compactionMs: 0, cpuUserMicros: 0, cpuSystemMicros: 0, peakRssKiB: 0, priorityApplied: false, cacheState: "disabled", modelCalls: 0, networkCalls: 0, secretSentinelPresent: false, sourceLedgerTransition: "none", ledgerColdLoadMs: 0, branchResolveMs: 0, branchReadMs: 0,
            branchEntryCount: 0, branchSourceBytes: 0, sourceRangeCount: 0, sourceBytesRead: 0, sourceByteAvoidanceRate: 0,
            completeSessionReadAvoided: false, candidateLedgerReused: false } };
}
function emptyMetrics(request, slots, codeResponse) { return { response: codeResponse, clientMetrics: { jobType: request.jobType, schedulerSlotLimit: slots, schedulerQueueWaitMs: 0, schedulerQueuePosition: 0, workerStartMs: 0, workerTotalWallMs: 0, mainProcessMaximumTimerDelayMs: 0, responseBytes: 0, stderrBytes: 0 } }; }
function diagnosticEntrypointIdentity(path) {
    const name = basename(path).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "worker-entrypoint";
    try {
        const bytes = statSync(path).size;
        if (bytes > 1024 * 1024)
            return { name, bytes };
        return { name, bytes, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
    }
    catch {
        return { name };
    }
}
function safeStderrTail(bytes) {
    return `sha256:${createHash("sha256").update(bytes).digest("hex")};bytes:${bytes.length}`;
}
function writePrivateDiagnostic(path, response, elapsedMs, stage, entry, requestBytes, responseBytes, stderrTail, stderrBytes, exitCode, signal) {
    if (!path || response.status !== "failed")
        return;
    const record = { schemaVersion: 1, failureStage: response.failureStage ?? stage.slice(0, 64), failureCode: response.failureCode,
        elapsedMs: Math.max(0, elapsedMs), peakRssKiB: response.metrics.peakRssKiB, requestBytes, responseBytes, stderrBytes,
        stderrTail: safeStderrTail(stderrTail), entrypoint: diagnosticEntrypointIdentity(entry),
        ...(exitCode === undefined ? {} : { exitCode }), ...(signal ? { signal } : {}),
        ...(response.failureContext ? { context: response.failureContext } : {}) };
    const line = `${JSON.stringify(record)}\n`;
    const descriptor = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    try {
        const metadata = fstatSync(descriptor);
        const uid = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
        if (!metadata.isFile() || metadata.uid !== uid || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0)
            throw new Error("unsafe-worker-diagnostic");
        fchmodSync(descriptor, 0o600);
        if (metadata.size + Buffer.byteLength(line) > MAX_WORKER_DIAGNOSTIC_BYTES)
            ftruncateSync(descriptor, 0);
        writeSync(descriptor, line);
    }
    finally {
        closeSync(descriptor);
    }
}
async function runSingle(request, options, progress = () => { }) {
    const requestBytes = Buffer.byteLength(JSON.stringify(request));
    const entry = options.entryPath ?? fileURLToPath(new URL("./compaction-worker-entry.js", import.meta.url));
    const diagnosticPath = options.privateDiagnosticPath ?? replayWorkerDiagnosticPath(request.sessionPath);
    const started = performance.now();
    const directory = await prepareRuntimeNamespace(options.schedulerDirectory ?? defaultSchedulerDirectory());
    const failure = (code) => {
        const result = emptyMetrics(request, options.slots ?? 1, safeFailure(request, code, "scheduler-wait"));
        try {
            writePrivateDiagnostic(diagnosticPath, result.response, performance.now() - started, "scheduler-wait", entry, requestBytes, 0, Buffer.alloc(0), 0);
        }
        catch { }
        return result;
    };
    if (request.expectedSource.size > WORKER_LIMITS.sourceBytes)
        return failure("worker-source-limit");
    let lease;
    let child;
    let stageWrites = Promise.resolve();
    const stage = (label) => { if (!lease)
        return; const slot = lease.slot; stageWrites = stageWrites.then(() => publishRuntimeStage(directory, slot, runtimeCategory(request.jobType), label)).catch(() => { }); progress(label); };
    try {
        lease = await acquireHostWorkerSlot({ slots: options.slots, timeoutMs: Math.min(options.schedulerTimeoutMs ?? 900_000, request.deadlineMs - Date.now()), priority: options.priority ?? (request.jobType === "replay-compaction" ? "high" : "low"), jobType: request.jobType, signal: options.signal, directory, sessionKey: createHash("sha256").update(request.sessionPath).digest("hex"), enforcePolicy: true });
        if (!statSync(entry).isFile())
            return failure("worker-entrypoint-unavailable");
        for (;;) {
            if (options.signal?.aborted)
                return failure("worker-aborted");
            const remaining = Math.min(options.workerTimeoutMs ?? 900_000, request.deadlineMs - Date.now());
            if (remaining <= 0)
                return failure("worker-timeout");
            try {
                const start = () => startContainedWorker(directory, lease.slot, lease.slots, remaining, undefined, MAX_WORKER_RESPONSE_BYTES, undefined, options.signal);
                child = options.schedulerDirectory === undefined ? await withVerifiedLegacyAdmission(directory, start) : await start();
                break;
            }
            catch (error) {
                if (error.message !== "runtime-slot-busy")
                    throw error;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
        const running = child;
        stage("child-running");
        const wallStart = performance.now();
        let maxDelay = 0, expected = performance.now() + 10, stderrBytes = 0;
        let stderrTail = Buffer.alloc(0);
        let latestStage = "child-start";
        let latestContext;
        let childExitCode, childSignal;
        const probe = setInterval(() => { const now = performance.now(); maxDelay = Math.max(maxDelay, now - expected); expected = now + 10; }, 10);
        let abort = () => { };
        let timer;
        try {
            const response = await new Promise(resolve => {
                let settled = false;
                const finish = (value) => { if (!settled) {
                    settled = true;
                    resolve(value);
                } };
                abort = () => finish(safeFailure(request, "worker-aborted", latestStage, latestContext));
                options.signal?.addEventListener("abort", abort, { once: true });
                timer = setTimeout(() => finish(safeFailure(request, "worker-timeout", latestStage, latestContext)), Math.max(1, Math.min(options.workerTimeoutMs ?? 900_000, request.deadlineMs - Date.now())));
                running.stderr.on("data", (bytes) => {
                    stderrBytes += bytes.length;
                    stderrTail = Buffer.concat([stderrTail, bytes]).subarray(-MAX_WORKER_STDERR_BYTES);
                    if (stderrBytes > MAX_WORKER_STDERR_BYTES)
                        finish(safeFailure(request, "worker-response-too-large", latestStage));
                });
                running.on("limit", (code) => finish(safeFailure(request, code, "response-validation")));
                running.on("message", value => {
                    if (value && typeof value === "object" && value.kind === "worker-stage") {
                        try {
                            stage(validateWorkerProgress(value, request));
                        }
                        catch {
                            finish(safeFailure(request, "worker-protocol-error", "response-validation"));
                        }
                        return;
                    }
                    if (value && typeof value === "object" && value.kind === "shadow-stage") {
                        if (Object.keys(value).some(key => !["kind", "stage", "context"].includes(key)) || !ROLLUP_SHADOW_FAILURE_STAGES.includes(value.stage)) {
                            finish(safeFailure(request, "worker-protocol-error", "response-validation"));
                            return;
                        }
                        latestStage = value.stage;
                        latestContext = safeFailureContext(value.context);
                        stage(value.stage);
                        return;
                    }
                    try {
                        const response = validateWorkerResponse(value, request.jobId);
                        if (response.jobType !== request.jobType)
                            throw new Error();
                        finish(response);
                    }
                    catch {
                        finish(safeFailure(request, "worker-protocol-error", "response-validation"));
                    }
                });
                running.on("worker-exit", (code, signal) => {
                    childExitCode = code;
                    childSignal = signal;
                    // SIGKILL alone is not evidence of OOM. Inspect the controller result
                    // only when systemd-run closes after the whole cgroup has stopped.
                });
                running.on("exit", () => {
                    void running.result().then(result => finish(safeFailure(request, result === "oom-kill" ? "worker-resource-limit" : result === "timeout" ? "worker-timeout" : "worker-crashed", latestStage, latestContext)));
                });
                if (options.signal?.aborted)
                    abort();
                else
                    running.send(request, entry, error => { if (error)
                        finish(safeFailure(request, "worker-crashed", "child-start")); });
            });
            // A successful response does not grant permission to reuse capacity yet.
            await running.stop();
            const responseBytes = Buffer.byteLength(JSON.stringify(response));
            const elapsedMs = performance.now() - wallStart;
            try {
                writePrivateDiagnostic(diagnosticPath, response, elapsedMs, latestStage, entry, requestBytes, responseBytes, stderrTail, stderrBytes, childExitCode, childSignal);
            }
            catch { }
            return { response, clientMetrics: { jobType: request.jobType, schedulerSlotLimit: lease.slots, schedulerQueueWaitMs: lease.queueWaitMs, schedulerQueuePosition: lease.queuePosition, workerStartMs: wallStart - started, workerTotalWallMs: elapsedMs, mainProcessMaximumTimerDelayMs: maxDelay, responseBytes, stderrBytes } };
        }
        finally {
            clearInterval(probe);
            if (timer)
                clearTimeout(timer);
            options.signal?.removeEventListener("abort", abort);
        }
    }
    catch (error) {
        const message = error.message;
        return failure(options.signal?.aborted ? "worker-aborted" : message === "scheduler-timeout" ? "scheduler-timeout" : message === "scheduler-queue-full" ? "scheduler-queue-full" : message === "scheduler-policy-mismatch" ? "scheduler-policy-mismatch" : error.code === "ENOENT" ? "worker-entrypoint-unavailable" : "worker-containment-unavailable");
    }
    finally {
        // If stop cannot be confirmed, leave the advisory lease in place. The fixed
        // service identity remains the authoritative capacity boundary after death.
        if (child)
            await child.stop();
        await stageWrites;
        await lease?.release();
    }
}
/** Full bounded identity, not a session-only cache. No completed payloads persist. */
export function workerJobIdentity(request, options = {}) {
    const { jobId: _jobId, deadlineMs: _deadline, ...body } = request;
    const { signal: _signal, workerTimeoutMs: _workerTimeout, schedulerTimeoutMs: _schedulerTimeout, onProgress: _onProgress, privateDiagnosticPath: _diagnostic, ...settings } = options;
    const entry = options.entryPath ?? fileURLToPath(new URL("./compaction-worker-entry.js", import.meta.url));
    const entryIdentity = diagnosticEntrypointIdentity(entry);
    return createHash("sha256").update(canonicalWorkerJson({ body, settings, entry, entryIdentity })).digest("hex");
}
export async function runCompactionWorker(requestValue, options = {}) {
    const request = validateWorkerRequest(JSON.parse(canonicalWorkerJson(validateWorkerRequest(requestValue))));
    if (Buffer.byteLength(JSON.stringify(request)) > MAX_WORKER_REQUEST_BYTES)
        throw new Error("worker-protocol-error");
    const fail = (code) => emptyMetrics(request, options.slots ?? 1, safeFailure(request, code, "scheduler-wait"));
    if (options.signal?.aborted)
        return fail("worker-aborted");
    if (!options.schedulerDirectory && !await verifyLegacyAdmissionGate())
        return fail("worker-legacy-transition-required");
    const directory = await prepareRuntimeNamespace(options.schedulerDirectory ?? defaultSchedulerDirectory());
    const key = workerJobIdentity(request, options);
    try {
        const deadlineMs = Math.min(request.deadlineMs, Date.now() + (options.workerTimeoutMs ?? 900_000));
        const result = await coalesceHostJob(directory, key, options.signal, (signal, progress) => {
            const hardMs = WORKER_LIMITS.timeoutSeconds.max * 1000;
            return runSingle({ ...request, deadlineMs: Date.now() + hardMs }, { ...options, signal, workerTimeoutMs: hardMs, schedulerTimeoutMs: hardMs }, progress);
        }, MAX_WORKER_RESPONSE_BYTES + 4096, { deadlineMs, onProgress: options.onProgress });
        return { ...result, response: validateWorkerResponse({ ...result.response, jobId: request.jobId }, request.jobId) };
    }
    catch (error) {
        const message = error.message;
        const result = fail(message === "worker-aborted" ? "worker-aborted" : message === "worker-timeout" ? "worker-timeout" : message === "scheduler-queue-full" ? "scheduler-queue-full" : message === "worker-response-too-large" ? "worker-response-too-large" : "worker-containment-unavailable");
        const status = error.cancellationStatus;
        return status === "confirmed" || status === "detached" || status === "unconfirmed" ? { ...result, cancellationStatus: status } : result;
    }
}
//# sourceMappingURL=compaction-worker-client.js.map