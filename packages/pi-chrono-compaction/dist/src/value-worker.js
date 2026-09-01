import { createHash, randomBytes } from "node:crypto";
import { loadCandidateSegmentRecords } from "./candidate-segment-store.js";
import { acquireValueModelSlot } from "./value-worker-scheduler.js";
import { actualCostMicroUsd, assistantText, classifyProviderFailure, createPiValueModelCall, resolveValueWorkerModel, upperBoundCostMicroUsd } from "./value-worker-model.js";
import { boundedValueWorkerBatch, VALUE_WORKER_PROMPT_SCHEMA_HASH } from "./value-worker-prompt.js";
import { parseValueAdviceResponse, valueAdviceRepairPrompt } from "./value-worker-response.js";
import { acquireAdviceRun, claimHalfOpenCircuit, commitAdviceState, loadStoredAdvice, readValueAdviceManifest, valueAdviceStorePath } from "./value-advice-store.js";
import { stableStringify } from "./utils.js";
import { emptyValueWorkerUsage } from "./value-worker-types.js";
const sha = (value) => createHash("sha256").update(value).digest("hex");
export const VALUE_ADVICE_SCHEMA_HASH = sha("chrono-value-advice-v1");
export function valueWorkerConfigurationHash(settings) { return sha(stableStringify({ model: settings.model, thinking: settings.thinking, maxInputTokensPerJob: settings.maxInputTokensPerJob, maxOutputTokensPerJob: settings.maxOutputTokensPerJob, maxItemsPerJob: settings.maxItemsPerJob })); }
const cloneUsage = (usage) => usage ? { ...usage } : emptyValueWorkerUsage();
const defaultSleep = (milliseconds, signal) => new Promise((resolve, reject) => { const timer = setTimeout(resolve, milliseconds); const abort = () => { clearTimeout(timer); reject(new Error("cancelled")); }; signal?.addEventListener("abort", abort, { once: true }); });
function budgetStatus(settings, usage, inputAllowance, outputAllowance, costAllowance) { if (usage.calls + 1 > settings.maxCallsPerSession || usage.inputTokens + inputAllowance > settings.maxInputTokensPerSession || usage.outputTokens + outputAllowance > settings.maxOutputTokensPerSession)
    return "budget-exhausted"; if (settings.maxEstimatedCostMicroUsd !== undefined) {
    if (costAllowance === undefined)
        return "cost-limit-unenforceable";
    if (usage.costMicroUsd + costAllowance > settings.maxEstimatedCostMicroUsd)
        return "budget-exhausted";
} return undefined; }
function addResponseUsage(usage, resolved, response, repair) { const priorCalls = usage.calls; usage.calls++; if (repair)
    usage.repairCalls++; usage.inputTokens += response.usage.input; usage.outputTokens += response.usage.output; usage.cacheReadTokens += response.usage.cacheRead; usage.cacheWriteTokens += response.usage.cacheWrite; const cost = actualCostMicroUsd(resolved.model, response.usage); if (cost === undefined)
    usage.costAvailable = false;
else {
    usage.costAvailable = priorCalls === 0 || usage.costAvailable;
    usage.costMicroUsd += cost;
} }
function reserveFailedAttempt(usage, inputTokens, outputTokens, costMicroUsd, repair) { const priorCalls = usage.calls; usage.calls++; if (repair)
    usage.repairCalls++; usage.inputTokens += inputTokens; usage.outputTokens += outputTokens; if (costMicroUsd === undefined)
    usage.costAvailable = false;
else {
    usage.costAvailable = priorCalls === 0 || usage.costAvailable;
    usage.costMicroUsd += costMicroUsd;
} }
function contextFor(input, resolved, configurationHash) { const manifest = input.store.manifest; return { sourceSessionIdentity: manifest.sourceSessionIdentity, candidateManifestIdentity: manifest.manifestIntegrityHash, modelSpecification: input.settings.model, resolvedModelIdentity: resolved.identity, thinkingLevel: resolved.thinking, promptSchemaHash: VALUE_WORKER_PROMPT_SCHEMA_HASH, adviceSchemaHash: VALUE_ADVICE_SCHEMA_HASH, configurationHash }; }
function isCompatible(manifest, context) { return Boolean(manifest && manifest.configurationHash === context.configurationHash && manifest.candidateManifestIdentity === context.candidateManifestIdentity && manifest.resolvedModelIdentity === context.resolvedModelIdentity && manifest.thinkingLevel === context.thinkingLevel && manifest.promptSchemaHash === context.promptSchemaHash && manifest.adviceSchemaHash === context.adviceSchemaHash); }
async function recordFailure(path, context, manifest, usage, settings, status, now) { const failures = (manifest?.consecutiveFailures ?? 0) + 1; const open = failures >= settings.circuitFailureLimit; return commitAdviceState(path, context, { status: open ? "circuit-open" : status, usage, consecutiveFailures: failures, circuitState: open ? "open" : "closed", ...(open ? { circuitOpenedAt: new Date(now).toISOString(), circuitReopenTime: new Date(now + settings.circuitCooldownSeconds * 1000).toISOString() } : {}), lastFailureCode: status }); }
export async function runValueWorker(input) {
    let usage = emptyValueWorkerUsage();
    const result = (status, processedSegments = 0, adviceRecords = 0, resolvedModel, providerAttempts = 0, rejectedAdvice = 0) => ({ status, processedSegments, adviceRecords, usage, ...(resolvedModel ? { resolvedModel } : {}), providerAttempts, rejectedAdvice });
    if (input.settings.mode === "off")
        return result("off");
    if (!input.store.manifest)
        return result("candidate-store-not-ready");
    const resolved = await resolveValueWorkerModel(input.ctx, input.settings);
    if (resolved.status !== "ready")
        return result(resolved.status);
    if (input.settings.maxEstimatedCostMicroUsd !== undefined && !resolved.costAvailable)
        return result("cost-limit-unenforceable");
    const path = valueAdviceStorePath(input.store.sessionPath);
    const configurationHash = valueWorkerConfigurationHash(input.settings);
    const context = contextFor(input, resolved, configurationHash);
    let adviceManifest = await readValueAdviceManifest(path);
    usage = cloneUsage(adviceManifest?.usage);
    if (!isCompatible(adviceManifest, context))
        adviceManifest = await commitAdviceState(path, context, { status: "scheduled", usage, consecutiveFailures: 0, circuitState: "closed" });
    const pending = input.store.manifest.segments.filter((segment) => !adviceManifest?.processedSegmentIdentities.includes(segment.segmentContentHash));
    if (!pending.length)
        return result("no-pending-segments", 0, 0, resolved.identity);
    let releaseRun;
    try {
        releaseRun = await acquireAdviceRun(path);
    }
    catch {
        return result("advice-store-busy", 0, 0, resolved.identity);
    }
    try {
        adviceManifest = await readValueAdviceManifest(path);
        if (!isCompatible(adviceManifest, context))
            adviceManifest = undefined;
        usage = cloneUsage(adviceManifest?.usage);
        const now = input.now ?? Date.now;
        const deadline = now() + input.settings.timeoutSeconds * 1000;
        const circuitOwner = randomBytes(12).toString("hex");
        if (adviceManifest?.circuitState === "open" || adviceManifest?.circuitState === "half-open") {
            const claim = await claimHalfOpenCircuit(path, context, circuitOwner, now());
            if (claim.blocked)
                return result("circuit-open", 0, 0, resolved.identity);
            adviceManifest = claim.manifest;
        }
        const lockedPending = input.store.manifest.segments.filter((segment) => !adviceManifest?.processedSegmentIdentities.includes(segment.segmentContentHash));
        if (!lockedPending.length)
            return result("no-pending-segments", 0, 0, resolved.identity);
        const modelCall = input.modelCall ?? createPiValueModelCall(input.ctx);
        const sleep = input.sleep ?? defaultSleep;
        let processed = 0, adviceCount = 0, attempts = 0, rejected = 0;
        for (const segment of lockedPending) {
            if (input.signal?.aborted)
                return result("cancelled", processed, adviceCount, resolved.identity, attempts, rejected);
            const records = await loadCandidateSegmentRecords(input.store, segment);
            if (!records)
                continue;
            let cursor = 0;
            const stored = [];
            let eligible = false;
            while (cursor < records.length) {
                const batch = boundedValueWorkerBatch(records.slice(cursor), input.settings.maxItemsPerJob, input.settings.maxInputTokensPerJob, input.settings.maxOutputTokensPerJob);
                if (!batch.consumed)
                    break;
                const batchRecords = records.slice(cursor, cursor + batch.consumed);
                cursor += batch.consumed;
                if (batch.items.every((item) => !item.excerpt))
                    continue;
                eligible = true;
                let response;
                let failureStatus = "unknown-value-worker-failure";
                for (let retry = 0; retry <= input.settings.retries; retry++) {
                    if (input.signal?.aborted)
                        return result("cancelled", processed, adviceCount, resolved.identity, attempts, rejected);
                    if (now() >= deadline) {
                        failureStatus = "provider-timeout";
                        break;
                    }
                    const costAllowance = upperBoundCostMicroUsd(resolved.model, batch.inputTokens, input.settings.maxOutputTokensPerJob);
                    const blocked = budgetStatus(input.settings, usage, batch.inputTokens, input.settings.maxOutputTokensPerJob, costAllowance);
                    if (blocked)
                        return result(blocked, processed, adviceCount, resolved.identity, attempts, rejected);
                    let slot;
                    try {
                        slot = await acquireValueModelSlot({ slots: input.settings.hostSlots, timeoutMs: Math.max(1, deadline - now()), signal: input.signal, directory: input.schedulerDirectory });
                        response = await modelCall.call(resolved.model, batch.prompt, { maxTokens: input.settings.maxOutputTokensPerJob, thinking: resolved.thinking, signal: input.signal });
                        attempts++;
                        addResponseUsage(usage, resolved, response, false);
                        await commitAdviceState(path, context, { status: "running", usage, consecutiveFailures: adviceManifest?.consecutiveFailures ?? 0, circuitState: adviceManifest?.circuitState ?? "closed", halfOpenOwner: adviceManifest?.halfOpenOwner });
                        break;
                    }
                    catch (error) {
                        attempts++;
                        reserveFailedAttempt(usage, batch.inputTokens, input.settings.maxOutputTokensPerJob, costAllowance, false);
                        const classified = classifyProviderFailure(error, input.signal);
                        failureStatus = classified.status;
                        await commitAdviceState(path, context, { status: failureStatus, usage, consecutiveFailures: adviceManifest?.consecutiveFailures ?? 0, circuitState: adviceManifest?.circuitState ?? "closed", halfOpenOwner: adviceManifest?.halfOpenOwner });
                        if (!classified.transient || retry >= input.settings.retries)
                            break;
                        const delay = retry === 0 ? 250 : 1000;
                        if (now() + delay >= deadline) {
                            failureStatus = "provider-timeout";
                            break;
                        }
                        try {
                            await sleep(delay, input.signal);
                        }
                        catch {
                            return result("cancelled", processed, adviceCount, resolved.identity, attempts, rejected);
                        }
                    }
                    finally {
                        await slot?.release();
                    }
                }
                if (!response) {
                    if (failureStatus === "cancelled" || failureStatus === "model-auth-unavailable" || failureStatus === "unknown-value-worker-failure")
                        return result(failureStatus, processed, adviceCount, resolved.identity, attempts, rejected);
                    adviceManifest = await recordFailure(path, context, adviceManifest, usage, input.settings, failureStatus, now());
                    return result(adviceManifest.circuitState === "open" ? "circuit-open" : failureStatus, processed, adviceCount, resolved.identity, attempts, rejected);
                }
                let parsed = parseValueAdviceResponse(assistantText(response), new Set(batch.items.map((item) => item.itemId)), input.settings.maxOutputTokensPerJob);
                if (parsed.needsRepair) {
                    if (input.signal?.aborted)
                        return result("cancelled", processed, adviceCount, resolved.identity, attempts, rejected);
                    if (now() >= deadline) {
                        adviceManifest = await recordFailure(path, context, adviceManifest, usage, input.settings, "repair-failed", now());
                        return result(adviceManifest.circuitState === "open" ? "circuit-open" : "repair-failed", processed, adviceCount, resolved.identity, attempts, rejected);
                    }
                    const repairPrompt = valueAdviceRepairPrompt(assistantText(response));
                    const repairInput = Math.ceil(repairPrompt.length / 4);
                    const costAllowance = upperBoundCostMicroUsd(resolved.model, repairInput, input.settings.maxOutputTokensPerJob);
                    const blocked = budgetStatus(input.settings, usage, repairInput, input.settings.maxOutputTokensPerJob, costAllowance);
                    if (blocked)
                        return result(blocked, processed, adviceCount, resolved.identity, attempts, rejected);
                    let repairFailure;
                    try {
                        const slot = await acquireValueModelSlot({ slots: input.settings.hostSlots, timeoutMs: Math.max(1, deadline - now()), signal: input.signal, directory: input.schedulerDirectory });
                        try {
                            const fixed = await modelCall.call(resolved.model, repairPrompt, { maxTokens: input.settings.maxOutputTokensPerJob, thinking: resolved.thinking, signal: input.signal });
                            attempts++;
                            addResponseUsage(usage, resolved, fixed, true);
                            parsed = parseValueAdviceResponse(assistantText(fixed), new Set(batch.items.map((item) => item.itemId)), input.settings.maxOutputTokensPerJob);
                        }
                        finally {
                            await slot.release();
                        }
                    }
                    catch (error) {
                        attempts++;
                        reserveFailedAttempt(usage, repairInput, input.settings.maxOutputTokensPerJob, costAllowance, true);
                        repairFailure = classifyProviderFailure(error, input.signal).status;
                        parsed = { advice: [], rejected: 0, unknown: 0, duplicates: 0, needsRepair: true, status: "invalid-top-level" };
                    }
                    if (repairFailure === "cancelled" || repairFailure === "model-auth-unavailable")
                        return result(repairFailure, processed, adviceCount, resolved.identity, attempts, rejected);
                    if (parsed.needsRepair) {
                        adviceManifest = await recordFailure(path, context, adviceManifest, usage, input.settings, "repair-failed", now());
                        return result(adviceManifest.circuitState === "open" ? "circuit-open" : "repair-failed", processed, adviceCount, resolved.identity, attempts, rejected);
                    }
                }
                rejected += parsed.rejected;
                for (const advice of parsed.advice) {
                    const blockId = batch.privateIds.get(advice.itemId);
                    const record = batchRecords.find((item) => item.blockId === blockId);
                    if (blockId && record) {
                        const { itemId: _opaqueItemId, ...normalized } = advice;
                        stored.push({ ...normalized, blockId, candidateIntegrityHash: record.integrityHash });
                    }
                }
            }
            if (input.signal?.aborted)
                return result("cancelled", processed, adviceCount, resolved.identity, attempts, rejected);
            adviceManifest = await commitAdviceState(path, context, { status: input.settings.mode === "shadow" ? "shadow-complete" : "advisory-complete", usage, consecutiveFailures: 0, circuitState: "closed", lastSuccessTime: new Date(now()).toISOString(), segment: { identity: segment.segmentContentHash, advice: stored, usage } });
            processed++;
            adviceCount += stored.length;
            if (!eligible && records.length === 0)
                continue;
        }
        return result(input.settings.mode === "shadow" ? "shadow-complete" : "advisory-complete", processed, adviceCount, resolved.identity, attempts, rejected);
    }
    finally {
        await releaseRun();
    }
}
export async function loadCompatibleAdviceByHash(sessionPath, configurationHash, validRecordHashes) { const manifest = await readValueAdviceManifest(valueAdviceStorePath(sessionPath)); if (!manifest || manifest.configurationHash !== configurationHash)
    return new Map(); return loadStoredAdvice(valueAdviceStorePath(sessionPath), manifest, validRecordHashes); }
export async function loadCompatibleAdvice(sessionPath, settings, validRecordHashes) { if (settings.mode !== "advisory" || !validRecordHashes)
    return new Map(); return loadCompatibleAdviceByHash(sessionPath, valueWorkerConfigurationHash(settings), validRecordHashes); }
//# sourceMappingURL=value-worker.js.map