import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";
import { setPriority } from "node:os";
import { createCandidateSegmentStore, loadCandidateRecordsForBranch, loadCandidateSegmentManifest, updateCandidateSegmentStore } from "./candidate-segment-store.js";
import { validateWorkerRequest, validateWorkerResponse, MAX_WORKER_RESPONSE_BYTES } from "./compaction-worker-protocol.js";
import { compactEntries, computeGenerationHash, resolveCompactorConfig } from "./compactor.js";
import { loadSourceLedgerBranch, splitLedgerBranchAtEntry } from "./ledger-branch.js";
import { updateSourceLedger } from "./source-ledger.js";
import { buildDeterministicSummaryRebase } from "./summary-rebase.js";
import { renderHybridCompaction } from "./pi-hybrid.js";
import { parseHistoricalBlocks } from "./blocks.js";
import { estimateTokensFromText, hashText, stableStringify } from "./utils.js";
import { appendRollupShadowFailureRecord, appendRollupShadowRecord, runRollupShadowEvaluation } from "./history-rollup-shadow.js";
import { loadStoredAdvice, readValueAdviceManifest, valueAdviceStorePath } from "./value-advice-store.js";
import { classifyRollupShadowFailure, safeFailureContext } from "./rollup-shadow-failure.js";
const EMPTY_LOAD_METRICS = { sourceLedgerTransition: "none", ledgerColdLoadMs: 0, branchResolveMs: 0,
    branchReadMs: 0, branchEntryCount: 0, branchSourceBytes: 0, sourceRangeCount: 0, sourceBytesRead: 0,
    sourceByteAvoidanceRate: 0, completeSessionReadAvoided: false, candidateLedgerReused: false };
function sourceState(value) { return { deviceId: String(value.dev), inodeId: String(value.ino), size: Number(value.size), mtimeMs: Number(value.mtimeMs) }; }
function same(a, b) { return a.deviceId === b.deviceId && a.inodeId === b.inodeId && a.size === b.size && a.mtimeMs === b.mtimeMs; }
async function hashSourcePrefixAnchor(path, sourceSize, bytes) {
    const hash = createHash("sha256");
    if (bytes === 0)
        return hash.digest("hex");
    await new Promise((resolve, reject) => {
        const stream = createReadStream(path, { start: sourceSize - bytes, end: sourceSize - 1 });
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("error", reject);
        stream.on("end", resolve);
    });
    return hash.digest("hex");
}
async function expectedState(request) {
    let current;
    try {
        current = sourceState(await stat(request.sessionPath));
    }
    catch {
        throw Object.assign(new Error(), { code: "no-session-file" });
    }
    const expected = { deviceId: request.expectedSource.deviceId, inodeId: request.expectedSource.inodeId, size: request.expectedSource.size, mtimeMs: request.expectedSource.mtimeMs };
    if (request.expectedSource.prefixHash === undefined) {
        if (!same(current, expected))
            throw Object.assign(new Error(), { code: "source-changed" });
    }
    else if (current.deviceId !== expected.deviceId || current.inodeId !== expected.inodeId || current.size < expected.size || await hashSourcePrefixAnchor(request.sessionPath, expected.size, request.expectedSource.prefixBytes ?? 0) !== request.expectedSource.prefixHash) {
        throw Object.assign(new Error(), { code: "source-changed" });
    }
    return expected;
}
function cachePath(sessionPath) { return `${sessionPath}.chrono-worker-replay-v1.json`; }
async function readReplayCache(path, key) {
    try {
        const value = JSON.parse(await readFile(path, "utf8"));
        const payload = value.result === undefined ? undefined : JSON.stringify(value.result);
        return value.schemaVersion === 1 && value.key === key && payload !== undefined && value.payloadHash === hashText(payload) ? value.result : undefined;
    }
    catch {
        return undefined;
    }
}
async function writeReplayCache(path, key, result) {
    const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, key, payloadHash: hashText(JSON.stringify(result)), result })}\n`, { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
}
function baseMetrics(start, compactionMs, priorityApplied, cacheState, load = EMPTY_LOAD_METRICS) {
    const cpu = process.cpuUsage();
    return { workerPid: process.pid, totalWallMs: performance.now() - start, compactionMs, cpuUserMicros: cpu.user,
        cpuSystemMicros: cpu.system, peakRssKiB: process.resourceUsage().maxRSS, priorityApplied, cacheState,
        modelCalls: 0, networkCalls: 0, secretSentinelPresent: false, ...load };
}
function failureCode(error) {
    const code = error?.code;
    const allowed = ["no-session-file", "branch-not-persisted", "branch-parent-missing", "branch-cycle",
        "branch-source-order", "invalid-cut", "source-changed", "candidate-store-unavailable", "replay-validation-rejected",
        "worker-timeout", "worker-aborted"];
    return typeof code === "string" && allowed.includes(code) ? code : "worker-internal-error";
}
function loadMetrics(transition, ledgerLoadMs, resolveMs, read, candidateLedgerReused) {
    return { sourceLedgerTransition: transition, ledgerColdLoadMs: ledgerLoadMs, branchResolveMs: resolveMs,
        branchReadMs: read.elapsedLoadMs, branchEntryCount: read.selectedEntryCount, branchSourceBytes: read.selectedSourceBytes,
        sourceRangeCount: read.sourceRangeCount, sourceBytesRead: read.totalSourceBytesRead,
        sourceByteAvoidanceRate: read.sourceByteAvoidanceRate, completeSessionReadAvoided: true, candidateLedgerReused };
}
async function replay(request, signal) {
    await expectedState(request);
    const ledgerAt = performance.now();
    const ledger = await updateSourceLedger(request.sessionPath);
    const ledgerLoadMs = performance.now() - ledgerAt;
    await expectedState(request);
    const loaded = await loadSourceLedgerBranch(request.sessionPath, ledger, request.branchLeafId);
    await expectedState(request);
    const split = splitLedgerBranchAtEntry(loaded.ledgerEntries, request.firstKeptEntryId);
    const source = loaded.entries.slice(0, split.cutIndex);
    const future = loaded.entries.slice(split.cutIndex);
    let candidates;
    let candidateLedgerReused = false;
    if (request.candidateStoreEnabled) {
        try {
            const store = createCandidateSegmentStore(request.sessionPath);
            store.ledger = ledger;
            candidateLedgerReused = true;
            await loadCandidateSegmentManifest(store);
            if (store.manifest)
                candidates = await loadCandidateRecordsForBranch(store, source.flatMap((entry) => typeof entry.id === "string" ? [entry.id] : []));
        }
        catch {
            candidates = undefined;
        }
    }
    let valueAdvice;
    let adviceSnapshotHash;
    if (request.valueWorkerMode === "advisory" && request.valueWorkerConfigurationHash && candidates?.size) {
        const manifest = await readValueAdviceManifest(valueAdviceStorePath(request.sessionPath));
        if (manifest?.configurationHash === request.valueWorkerConfigurationHash) {
            const validHashes = new Map([...candidates].map(([blockId, record]) => [blockId, record.integrityHash]));
            valueAdvice = await loadStoredAdvice(valueAdviceStorePath(request.sessionPath), manifest, validHashes);
            adviceSnapshotHash = manifest.integrityHash;
        }
    }
    let rebase;
    let hardOutputTokens = request.hardOutputTokens;
    let config = resolveCompactorConfig(request.config);
    if (request.deterministicRebase) {
        rebase = buildDeterministicSummaryRebase(parseHistoricalBlocks(source, { includeHistoricalCompactions: false, includeMetadata: false }), undefined, request.deterministicRebase.targetTokens);
        const rebaseTokens = estimateTokensFromText(rebase);
        const wrapperTokens = Math.max(0, estimateTokensFromText(renderHybridCompaction(rebase, "")) - rebaseTokens);
        hardOutputTokens = Math.max(128, request.deterministicRebase.historicalCeilingTokens - rebaseTokens - wrapperTokens);
        const replayTarget = Math.min(hardOutputTokens, Math.max(256, request.deterministicRebase.combinedTargetTokens - rebaseTokens - wrapperTokens));
        config = resolveCompactorConfig({ ...request.config, targetTokens: replayTarget });
    }
    const generationHash = computeGenerationHash(source, config, request.retentionHints, future, request.pinnedMemoryText, request.retrievalFeedback);
    const key = hashText(stableStringify({ generationHash, hardOutputTokens, ...(adviceSnapshotHash ? { adviceSnapshotHash } : {}) }));
    let result;
    let cacheState = request.cacheEnabled ? "miss" : "disabled";
    if (request.cacheEnabled) {
        result = await readReplayCache(cachePath(request.sessionPath), key);
        if (result)
            cacheState = "hit";
    }
    let compactionMs = 0;
    if (!result) {
        const at = performance.now();
        try {
            result = await compactEntries(source, { config, hardOutputTokens, retentionHints: request.retentionHints, futureEntries: future,
                pinnedMemoryText: request.pinnedMemoryText, retrievalFeedback: request.retrievalFeedback, signal,
                ...(candidates && candidates.size ? { precomputedCandidates: candidates } : {}), ...(valueAdvice?.size ? { valueAdvice, valueWorkerMode: "advisory" } : {}) });
        }
        catch (error) {
            if (error.report)
                throw Object.assign(new Error(), { code: "replay-validation-rejected" });
            throw error;
        }
        compactionMs = performance.now() - at;
        if (request.cacheEnabled) {
            try {
                await writeReplayCache(cachePath(request.sessionPath), key, result);
            }
            catch {
                cacheState = "write-failed";
            }
        }
    }
    await expectedState(request);
    return { result, rebase, compactionMs, cacheState, sourceCount: source.length,
        load: loadMetrics(ledger.metrics.transition, ledgerLoadMs, loaded.resolveMs, loaded.metrics, candidateLedgerReused) };
}
async function run(requestValue, signal) {
    let request;
    try {
        request = validateWorkerRequest(requestValue);
    }
    catch {
        const shadow = requestValue?.jobType === "rollup-shadow";
        return { schemaVersion: 1, jobId: typeof requestValue?.jobId === "string" ? requestValue.jobId : "invalid",
            status: "failed", jobType: shadow ? "rollup-shadow" : "replay-compaction",
            failureCode: shadow ? "shadow-protocol-error" : "worker-protocol-error",
            ...(shadow ? { failureStage: "request-validation" } : {}),
            metrics: baseMetrics(performance.now(), 0, false, "disabled") };
    }
    const started = performance.now();
    let priorityApplied = false;
    let shadowStage = "source-bind";
    let shadowContext;
    const reportShadowStage = (stage, context) => {
        shadowStage = stage;
        shadowContext = safeFailureContext(context);
        if (process.connected && process.send)
            process.send({ kind: "shadow-stage", stage, ...(shadowContext ? { context: shadowContext } : {}) });
    };
    try {
        try {
            setPriority(0, request.niceLevel);
            priorityApplied = true;
        }
        catch { }
        if (Date.now() > request.deadlineMs)
            throw Object.assign(new Error(), { code: "worker-timeout" });
        if (request.jobType === "rollup-shadow") {
            reportShadowStage("source-bind", { sourceFileBytes: request.expectedSource.size, currentMemoryBytes: process.memoryUsage().rss });
            await expectedState(request);
            const shadow = await runRollupShadowEvaluation({
                sessionPath: request.sessionPath,
                branchLeafId: request.branchLeafId,
                firstKeptEntryId: request.firstKeptEntryId,
                currentReplayText: request.currentReplayText,
                hardTokenBound: request.hardTokenBound,
                targetTokenBound: request.targetTokenBound,
                retentionHints: request.retentionHints,
                dynamicContext: request.dynamicContext,
                signal,
                persist: false,
                onStage: reportShadowStage,
            });
            await expectedState(request);
            if (shadow.safeStatus === "validation-failed") {
                reportShadowStage("rollup-validation", shadowContext);
                throw Object.assign(new Error("history-rollup-validation-failed"), { code: "history-rollup-validation-failed" });
            }
            reportShadowStage("shadow-sidecar-write", shadowContext);
            let shadowWarning;
            try {
                await appendRollupShadowRecord(request.sessionPath, shadow);
            }
            catch {
                shadowWarning = { stage: "shadow-sidecar-write", code: "shadow-sidecar-write-failed" };
            }
            return {
                schemaVersion: 1,
                jobId: request.jobId,
                status: "ok",
                jobType: request.jobType,
                shadow,
                ...(shadowWarning ? { shadowWarning } : {}),
                metrics: baseMetrics(started, 0, priorityApplied, "disabled"),
            };
        }
        if (request.jobType === "candidate-store-update") {
            await expectedState(request);
            const store = createCandidateSegmentStore(request.sessionPath);
            const metrics = await updateCandidateSegmentStore(store, resolveCompactorConfig(request.config), { ...(request.storeSettings ?? {}), signal });
            await expectedState(request);
            return { schemaVersion: 1, jobId: request.jobId, status: "ok", jobType: request.jobType, candidateUpdate: metrics,
                metrics: baseMetrics(started, 0, priorityApplied, "disabled") };
        }
        const value = await replay(request, signal);
        return { schemaVersion: 1, jobId: request.jobId, status: "ok", jobType: request.jobType,
            replay: { summary: value.result.summary, ...(value.rebase === undefined ? {} : { deterministicRebaseText: value.rebase }),
                rawTokens: value.result.rawTokens, renderedTokens: value.result.renderedTokens, targetTokens: value.result.targetTokens,
                validation: value.result.validation, details: value.result.details, generationHash: value.result.details.generationHash,
                planSources: value.result.plan.units.map((unit) => ({ unitId: unit.id, sourceRefs: unit.sourceRefs })), sourceEntryCount: value.sourceCount },
            metrics: baseMetrics(started, value.compactionMs, priorityApplied, value.cacheState, value.load) };
    }
    catch (error) {
        if (request.jobType === "rollup-shadow") {
            const classified = classifyRollupShadowFailure(shadowStage, error, safeFailureContext({ ...shadowContext, ...error?.context }));
            if (classified.stage !== "shadow-sidecar-write") {
                try {
                    await appendRollupShadowFailureRecord(request.sessionPath, {
                        schemaVersion: 2,
                        recordType: "failure",
                        generation: 1,
                        timestampMs: Date.now(),
                        safeStatus: "failed",
                        failureStage: classified.stage,
                        failureCode: classified.code,
                        ...(classified.context ? { context: classified.context } : {}),
                    });
                }
                catch {
                    // Failure diagnostics never replace the classified worker result.
                }
            }
            return { schemaVersion: 1, jobId: request.jobId, status: "failed", jobType: request.jobType,
                failureStage: classified.stage, failureCode: classified.code,
                ...(classified.context ? { failureContext: classified.context } : {}),
                metrics: baseMetrics(started, 0, priorityApplied, "disabled") };
        }
        return { schemaVersion: 1, jobId: request.jobId, status: "failed", jobType: request.jobType,
            failureCode: failureCode(error), metrics: baseMetrics(started, 0, priorityApplied, "disabled") };
    }
}
let handled = false;
const workAbort = new AbortController();
let forcedExit;
const abortWork = () => { workAbort.abort(Object.assign(new Error("worker-aborted"), { code: "worker-aborted" })); forcedExit ??= setTimeout(() => process.exit(1), 1_000); forcedExit.unref(); };
process.on("disconnect", abortWork);
process.on("SIGTERM", abortWork);
process.on("message", (value) => {
    if (handled)
        return;
    handled = true;
    void run(value, workAbort.signal).then((response) => {
        let checked;
        try {
            checked = validateWorkerResponse(response);
            if (Buffer.byteLength(JSON.stringify(checked)) > MAX_WORKER_RESPONSE_BYTES)
                throw new Error("worker-response-too-large");
        }
        catch (error) {
            const jobType = value?.jobType ?? "replay-compaction";
            const tooLarge = String(error?.message).includes("response-too-large");
            checked = { schemaVersion: 1, jobId: value?.jobId ?? "invalid", status: "failed",
                jobType,
                failureCode: jobType === "rollup-shadow" ? (tooLarge ? "shadow-response-too-large" : "shadow-protocol-error") : (tooLarge ? "worker-response-too-large" : "worker-protocol-error"),
                ...(jobType === "rollup-shadow" ? { failureStage: "response-validation" } : {}),
                metrics: baseMetrics(performance.now(), 0, false, "disabled") };
        }
        if (process.connected && process.send)
            process.send(checked, () => process.exit(0));
        else
            process.exit(1);
    }).catch(() => process.exit(1));
});
//# sourceMappingURL=compaction-worker-entry.js.map