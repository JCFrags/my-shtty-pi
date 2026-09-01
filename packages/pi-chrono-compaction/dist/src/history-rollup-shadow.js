import { createHash, randomBytes } from "node:crypto";
import { chmod, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveSourceLedgerBranch } from "./ledger-branch.js";
import { createHistoryRollupRuntime, loadHistoryBranchManifest, loadHistoryRollupManifest, updateHistoryRollupStore, } from "./history-rollup-store.js";
import { renderHistoryRollupPrototype } from "./history-rollup-renderer.js";
import { updateSourceLedger } from "./source-ledger.js";
import { estimateTokensFromText } from "./utils.js";
import { ROLLUP_SHADOW_FAILURE_CODES, ROLLUP_SHADOW_FAILURE_STAGES, } from "./rollup-shadow-failure.js";
export const ROLLUP_SHADOW_SCHEMA_VERSION = 2;
export const ROLLUP_SHADOW_SUFFIX = ".chrono-rollup-shadow-v2.jsonl";
export const MAX_ROLLUP_SHADOW_RECORDS = 1000;
export const MAX_ROLLUP_SHADOW_BYTES = 4 * 1024 * 1024;
function fullHash(text) {
    return createHash("sha256").update(text).digest("hex");
}
function currentReplayQuality(text, result) {
    const records = [...new Map((result?.plan ?? [])
            .filter(line => line.included && line.record)
            .map(line => [line.record.id, line.record])).values()];
    const coverage = (select) => {
        const selected = records.filter(select);
        if (!selected.length)
            return 1;
        const visible = selected.filter(record => record.sourceRefs.some(ref => text.includes(ref.entryId))).length;
        return visible / selected.length;
    };
    return {
        restrictionCueCoverage: coverage(record => record.category === "restriction" && ["current", "conflict"].includes(record.lifecycle)),
        blockerCoverage: coverage(record => record.category === "blocker" && record.lifecycle !== "resolved"),
        unresolvedFailureCoverage: coverage(record => record.category === "failure" && record.lifecycle === "unresolved"),
        currentResourceCoverage: coverage(record => record.category === "resource-state" && ["current", "unknown"].includes(record.lifecycle)),
        invalidReferences: 0,
        invalidRanges: 0,
        cutLines: 0,
        falseCompletions: 0,
        unsupportedIdentifiers: 0,
        unsupportedQuotations: 0,
        unsupportedNumbers: 0,
        missingRecoveryRoutes: 0,
    };
}
function rollupQuality(result) {
    return {
        restrictionCueCoverage: result.quality.restrictionCueCoverage,
        blockerCoverage: result.quality.blockerCoverage,
        unresolvedFailureCoverage: result.quality.unresolvedFailureCoverage,
        currentResourceCoverage: result.quality.currentResourceCoverage,
        invalidReferences: result.quality.invalidSourceReferences,
        invalidRanges: result.quality.invalidSourceRanges,
        cutLines: result.quality.cutLines,
        falseCompletions: result.quality.falseCompletions,
        unsupportedIdentifiers: result.quality.unsupportedIdentifiers,
        unsupportedQuotations: result.quality.unsupportedQuotations,
        unsupportedNumbers: result.quality.unsupportedNumbers,
        missingRecoveryRoutes: result.quality.missingRecoveryRoutes,
    };
}
function issueCounts(issues) {
    const counts = {};
    for (const issue of issues)
        counts[issue] = (counts[issue] ?? 0) + 1;
    return counts;
}
function sidecarPath(sessionPath) {
    return `${sessionPath}${ROLLUP_SHADOW_SUFFIX}`;
}
async function atomicWrite(path, text) {
    const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
    await writeFile(temporary, text, { mode: 0o600 });
    const handle = await open(temporary, "r");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    await chmod(path, 0o600);
    try {
        const directory = await open(dirname(path), "r");
        await directory.sync();
        await directory.close();
    }
    catch {
        // Directory sync is not supported on every platform.
    }
}
const PAYLOAD_KEYS = [
    "schemaVersion", "generation", "sourceTokenCount", "currentReplayTokenCount", "rollupTokenCount",
    "currentQuality", "rollupQuality", "updateTimeMs", "renderTimeMs", "sourceBytesRead", "nodeBytesRead",
    "queryNodes", "workerTimerDelayMs", "validationIssueCounts", "currentReplayHash", "rollupOutputHash",
    "safeStatus", "modelCalls", "networkCalls",
];
const QUALITY_KEYS = [
    "restrictionCueCoverage", "blockerCoverage", "unresolvedFailureCoverage", "currentResourceCoverage",
    "invalidReferences", "invalidRanges", "cutLines", "falseCompletions", "unsupportedIdentifiers",
    "unsupportedQuotations", "unsupportedNumbers", "missingRecoveryRoutes",
];
function exactKeys(value, keys) {
    const actual = Object.keys(value);
    return actual.length === keys.length && actual.every(key => keys.includes(key));
}
function safeQuality(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const record = value;
    return exactKeys(record, QUALITY_KEYS) && QUALITY_KEYS.every(key => typeof record[key] === "number" && Number.isFinite(record[key]) && record[key] >= 0);
}
function safeFailureRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const record = value;
    const context = record.context;
    return exactKeys(record, ["schemaVersion", "recordType", "generation", "timestampMs", "safeStatus", "failureStage", "failureCode", "context"]) &&
        record.schemaVersion === 2 && record.recordType === "failure" && record.safeStatus === "failed" &&
        Number.isSafeInteger(record.generation) && record.generation >= 0 &&
        Number.isSafeInteger(record.timestampMs) && record.timestampMs >= 0 &&
        ROLLUP_SHADOW_FAILURE_STAGES.includes(record.failureStage) &&
        ROLLUP_SHADOW_FAILURE_CODES.includes(record.failureCode) &&
        (context === undefined || (!!context && typeof context === "object" && !Array.isArray(context) &&
            Object.entries(context).every(([key, item]) => ["sourceFileBytes", "sourceLedgerEntries", "branchEntries", "treeLevels", "leafCount", "rollupCount", "reachableNodeBytes", "currentMemoryBytes", "sourceBytesRead", "nodeBytesRead", "nodeBytes", "nodeTypeCode", "responseBytes"].includes(key) && Number.isSafeInteger(item) && item >= 0)));
}
function safePayload(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const record = value;
    const integers = ["generation", "sourceTokenCount", "currentReplayTokenCount", "rollupTokenCount", "sourceBytesRead", "nodeBytesRead", "queryNodes"];
    const times = ["updateTimeMs", "renderTimeMs", "workerTimerDelayMs"];
    const issueCounts = record.validationIssueCounts;
    return exactKeys(record, PAYLOAD_KEYS) && record.schemaVersion === 2 &&
        integers.every(key => Number.isSafeInteger(record[key]) && record[key] >= 0) &&
        times.every(key => typeof record[key] === "number" && Number.isFinite(record[key]) && record[key] >= 0) &&
        safeQuality(record.currentQuality) && safeQuality(record.rollupQuality) &&
        !!issueCounts && typeof issueCounts === "object" && !Array.isArray(issueCounts) &&
        Object.entries(issueCounts).every(([key, count]) => /^[a-z0-9-]{1,64}$/.test(key) && Number.isSafeInteger(count) && count >= 0) &&
        typeof record.currentReplayHash === "string" && /^[a-f0-9]{64}$/.test(record.currentReplayHash) &&
        typeof record.rollupOutputHash === "string" && /^[a-f0-9]{64}$/.test(record.rollupOutputHash) &&
        ["ok", "validation-failed", "store-busy-snapshot", "empty-prefix"].includes(String(record.safeStatus)) &&
        record.modelCalls === 0 && record.networkCalls === 0;
}
async function readSidecarRecords(sessionPath) {
    try {
        const text = await readFile(sidecarPath(sessionPath), "utf8");
        return text.split("\n").filter(Boolean).flatMap(line => {
            try {
                const value = JSON.parse(line);
                return safePayload(value) || safeFailureRecord(value) ? [value] : [];
            }
            catch {
                return [];
            }
        });
    }
    catch {
        return [];
    }
}
export async function readRollupShadowRecords(sessionPath) {
    return (await readSidecarRecords(sessionPath)).filter((record) => safePayload(record));
}
export async function appendRollupShadowFailureRecord(sessionPath, record) {
    if (!safeFailureRecord(record))
        throw new Error("rollup-shadow-failure-record-invalid");
    const path = sidecarPath(sessionPath);
    const records = await readSidecarRecords(sessionPath);
    const retained = [...records, record].slice(-MAX_ROLLUP_SHADOW_RECORDS);
    while (retained.length > 1 && Buffer.byteLength(`${retained.map(item => JSON.stringify(item)).join("\n")}\n`) > MAX_ROLLUP_SHADOW_BYTES)
        retained.shift();
    await atomicWrite(path, `${retained.map(item => JSON.stringify(item)).join("\n")}\n`);
}
export async function appendRollupShadowRecord(sessionPath, payload) {
    const path = sidecarPath(sessionPath);
    const line = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(line) > MAX_ROLLUP_SHADOW_BYTES)
        throw new Error("rollup-shadow-record-too-large");
    let raw = "";
    try {
        raw = await readFile(path, "utf8");
    }
    catch {
        // A missing sidecar starts a new append-only metric log.
    }
    const rawLines = raw.split("\n").filter(Boolean);
    const records = await readRollupShadowRecords(sessionPath);
    const existingIsSafe = rawLines.length === records.length;
    if (existingIsSafe &&
        records.length < MAX_ROLLUP_SHADOW_RECORDS &&
        Buffer.byteLength(raw) + Buffer.byteLength(line) <= MAX_ROLLUP_SHADOW_BYTES) {
        const handle = await open(path, "a", 0o600);
        try {
            await handle.writeFile(line);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await chmod(path, 0o600);
        return;
    }
    const retained = [...records, payload].slice(-MAX_ROLLUP_SHADOW_RECORDS);
    while (retained.length > 1) {
        const text = `${retained.map(record => JSON.stringify(record)).join("\n")}\n`;
        if (Buffer.byteLength(text) <= MAX_ROLLUP_SHADOW_BYTES) {
            await atomicWrite(path, text);
            return;
        }
        retained.shift();
    }
    await atomicWrite(path, `${JSON.stringify(retained[0])}\n`);
}
export const DEFAULT_ROLLUP_SHADOW_MEMORY_LIMIT_BYTES = 1536 * 1024 * 1024;
export function projectedRollupMemoryBytes(currentMemoryBytes, largestEntryBytes) {
    return currentMemoryBytes + largestEntryBytes * 28;
}
export async function runRollupShadowEvaluation(input) {
    if (input.signal?.aborted)
        throw Object.assign(new Error("worker-aborted"), { code: "worker-aborted" });
    const runtime = createHistoryRollupRuntime(input.sessionPath);
    input.onStage?.("source-ledger-update");
    const ledger = runtime.ledger = await updateSourceLedger(input.sessionPath);
    const currentMemoryBytes = process.memoryUsage().rss;
    const largestEntryBytes = ledger.sourceOrder.reduce((maximum, entry) => Math.max(maximum, entry.sourceByteLength), 0);
    let context = {
        sourceFileBytes: ledger.metrics.sourceFileSize,
        sourceLedgerEntries: ledger.sourceOrder.length,
        currentMemoryBytes,
    };
    input.onStage?.("prefix-validation", context);
    const firstKept = ledger.entryById.get(input.firstKeptEntryId);
    if (!firstKept || firstKept.parentId !== input.branchLeafId) {
        throw Object.assign(new Error("invalid-cut"), { code: "invalid-cut" });
    }
    const branch = resolveSourceLedgerBranch(ledger, input.branchLeafId);
    context = { ...context, branchEntries: branch.entries.length };
    const memoryLimit = input.memoryLimitBytes ?? DEFAULT_ROLLUP_SHADOW_MEMORY_LIMIT_BYTES;
    if (largestEntryBytes >= 32 * 1024 * 1024 && projectedRollupMemoryBytes(currentMemoryBytes, largestEntryBytes) > memoryLimit) {
        throw Object.assign(new Error("shadow-memory-gate"), { code: "shadow-memory-gate", context });
    }
    if (branch.entries.length === 0) {
        const empty = {
            schemaVersion: 2,
            generation: 1,
            sourceTokenCount: 0,
            currentReplayTokenCount: estimateTokensFromText(input.currentReplayText),
            rollupTokenCount: 0,
            currentQuality: currentReplayQuality(input.currentReplayText),
            rollupQuality: currentReplayQuality(""),
            updateTimeMs: 0,
            renderTimeMs: 0,
            sourceBytesRead: 0,
            nodeBytesRead: 0,
            queryNodes: 0,
            workerTimerDelayMs: 0,
            validationIssueCounts: {},
            currentReplayHash: fullHash(input.currentReplayText),
            rollupOutputHash: fullHash(""),
            safeStatus: "empty-prefix",
            modelCalls: 0,
            networkCalls: 0,
        };
        if (input.persist !== false)
            await appendRollupShadowRecord(input.sessionPath, empty);
        return empty;
    }
    let updateTimeMs = 0;
    let sourceBytesRead = 0;
    let safeStatus = "ok";
    try {
        input.onStage?.("rollup-update", context);
        const updated = await updateHistoryRollupStore(runtime, input.branchLeafId, { signal: input.signal });
        updateTimeMs = updated.updateElapsedMs;
        sourceBytesRead = updated.sourceBytesRead;
    }
    catch (error) {
        if (!String(error.message).includes("busy"))
            throw error;
        input.onStage?.("rollup-manifest-load", context);
        const manifest = await loadHistoryRollupManifest(runtime);
        const branchManifest = manifest ? await loadHistoryBranchManifest(runtime) : undefined;
        if (!manifest || !branchManifest || branchManifest.branchLeafId !== input.branchLeafId)
            throw error;
        safeStatus = "store-busy-snapshot";
    }
    input.onStage?.("rollup-render", context);
    const result = await renderHistoryRollupPrototype(runtime, ledger, {
        targetTokens: input.targetTokenBound,
        hardTokens: input.hardTokenBound,
        dynamicContext: {
            retentionHints: input.retentionHints,
            ...input.dynamicContext,
        },
    });
    input.onStage?.("rollup-validation", context);
    if (!result.validation.ok)
        safeStatus = "validation-failed";
    input.onStage?.("shadow-sidecar-read", context);
    const generation = (await readRollupShadowRecords(input.sessionPath)).length + 1;
    const payload = {
        schemaVersion: 2,
        generation,
        sourceTokenCount: runtime.branchManifest?.sourceEntryCount
            ? Math.ceil((runtime.branchManifest.sourceByteCoverage ?? 0) / 4)
            : 0,
        currentReplayTokenCount: estimateTokensFromText(input.currentReplayText),
        rollupTokenCount: result.quality.outputTokens,
        currentQuality: currentReplayQuality(input.currentReplayText, result),
        rollupQuality: rollupQuality(result),
        updateTimeMs,
        renderTimeMs: result.quality.renderMs,
        sourceBytesRead: sourceBytesRead + result.quality.sourceBytesReadDuringRender,
        nodeBytesRead: result.quality.nodeBytesReadDuringRender,
        queryNodes: result.quality.queryNodesVisited,
        workerTimerDelayMs: Math.max(result.quality.timerDelayMs, runtime.branchManifest ? 0 : 0),
        validationIssueCounts: issueCounts(result.validation.issues),
        currentReplayHash: fullHash(input.currentReplayText),
        rollupOutputHash: fullHash(result.text),
        safeStatus,
        modelCalls: 0,
        networkCalls: 0,
    };
    if (input.persist !== false) {
        input.onStage?.("shadow-sidecar-write", context);
        await appendRollupShadowRecord(input.sessionPath, payload);
    }
    return payload;
}
function distribution(values) {
    if (!values.length)
        return { p50: 0, maximum: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    return { p50: sorted[Math.ceil(sorted.length * 0.5) - 1], maximum: sorted.at(-1) };
}
function latest(records, select) {
    return records.length ? select(records.at(-1)) : 0;
}
export async function getRollupShadowStatus(sessionPath) {
    const sidecarRecords = await readSidecarRecords(sessionPath);
    const records = sidecarRecords.filter((record) => safePayload(record));
    const failures = sidecarRecords.filter((record) => safeFailureRecord(record));
    const count = (select) => {
        const output = {};
        for (const failure of failures) {
            const key = select(failure);
            output[key] = (output[key] ?? 0) + 1;
        }
        return output;
    };
    return {
        records: sidecarRecords.length,
        failureStageCounts: count(record => record.failureStage),
        failureCodeCounts: count(record => record.failureCode),
        lastSafeStatus: records.at(-1)?.safeStatus ?? "none",
        currentReplayTokens: distribution(records.map(record => record.currentReplayTokenCount)),
        rollupTokens: distribution(records.map(record => record.rollupTokenCount)),
        currentRestrictionCueCoverage: latest(records, record => record.currentQuality.restrictionCueCoverage),
        rollupRestrictionCueCoverage: latest(records, record => record.rollupQuality.restrictionCueCoverage),
        currentBlockerCoverage: latest(records, record => record.currentQuality.blockerCoverage),
        rollupBlockerCoverage: latest(records, record => record.rollupQuality.blockerCoverage),
        currentUnresolvedFailureCoverage: latest(records, record => record.currentQuality.unresolvedFailureCoverage),
        rollupUnresolvedFailureCoverage: latest(records, record => record.rollupQuality.unresolvedFailureCoverage),
        currentResourceCoverage: latest(records, record => record.currentQuality.currentResourceCoverage),
        rollupResourceCoverage: latest(records, record => record.rollupQuality.currentResourceCoverage),
        invalidReferenceCount: records.reduce((sum, record) => sum + record.rollupQuality.invalidReferences, 0),
        cutLineCount: records.reduce((sum, record) => sum + record.rollupQuality.cutLines, 0),
        falseCompletionCount: records.reduce((sum, record) => sum + record.rollupQuality.falseCompletions, 0),
        unsupportedFactCount: records.reduce((sum, record) => sum + record.rollupQuality.unsupportedIdentifiers + record.rollupQuality.unsupportedQuotations + record.rollupQuality.unsupportedNumbers, 0),
        updateTimeMs: distribution(records.map(record => record.updateTimeMs)),
        renderTimeMs: distribution(records.map(record => record.renderTimeMs)),
        workerTimerDelayMs: distribution(records.map(record => record.workerTimerDelayMs)),
    };
}
export function rollupShadowSidecarPath(sessionPath) {
    return sidecarPath(sessionPath);
}
//# sourceMappingURL=history-rollup-shadow.js.map